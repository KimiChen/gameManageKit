import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { LoginResponse } from "@gono/game-manage-kit-contract";
import { Database } from "../../infra/mysql/database.js";
import { TokenBucketLimiter } from "../../infra/security/security.js";
import type { WechatIdentityClient } from "../../infra/wechat/client.js";
import { insertAudit } from "./audit.js";
import { SessionService } from "../session/service.js";

export type LoginFailureReason =
  | "banned"
  | "rate_limited"
  | "wx_invalid"
  | "wx_rate_limited"
  | "wx_unavailable";

export type LoginResult =
  | { ok: true; response: LoginResponse }
  | { ok: false; reason: LoginFailureReason };

interface AccountRow extends RowDataPacket {
  user_id: string;
  status: number;
  unionid: string | null;
}

function usableUnionId(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

async function findByOpenId(connection: PoolConnection, openid: string): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE openid = ?",
    [openid],
  );
  return rows[0];
}

async function findByOpenIdCurrent(
  connection: PoolConnection,
  openid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE openid = ? FOR SHARE",
    [openid],
  );
  return rows[0];
}

async function findByUnionId(connection: PoolConnection, unionid: string): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE unionid = ?",
    [unionid],
  );
  return rows[0];
}

async function findByUnionIdCurrent(
  connection: PoolConnection,
  unionid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE unionid = ? FOR SHARE",
    [unionid],
  );
  return rows[0];
}

async function nextUserId(connection: PoolConnection): Promise<string> {
  const [result] = await connection.execute<ResultSetHeader>(
    "UPDATE seq SET val = LAST_INSERT_ID(val + 1) WHERE name = 'user_id'",
  );
  if (result.affectedRows === 0) {
    throw new Error("seq.user_id 预置行缺失");
  }
  const [rows] = await connection.query<RowDataPacket[]>("SELECT LAST_INSERT_ID() AS value");
  return `u_${String(rows[0]?.value ?? "")}`;
}

export interface LoginAttempt {
  readonly rateKey: string;
  readonly ip: string | null;
  readonly deviceId: string | null;
  readonly serverId: number;
}

export class LoginService {
  constructor(
    private readonly database: Database,
    private readonly sessions: SessionService,
    private readonly wechat: WechatIdentityClient,
    private readonly limiter: TokenBucketLimiter,
  ) {}

  async loginWechat(
    code: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    if (!this.limiter.allow(attempt.rateKey)) {
      return { ok: false, reason: "rate_limited" };
    }
    const identity = await this.wechat.exchange(code);
    if (!identity.ok) {
      await insertAudit(this.database.pool, {
        userId: null,
        event: "fail",
        reason: `code2session:${identity.reason}`,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: identity.reason };
    }
    return this.loginByIdentity(
      identity.openid,
      identity.unionid,
      identity.sessionKey,
      "wx_login",
      attempt,
    );
  }

  async loginDev(devKey: string, attempt: LoginAttempt): Promise<LoginResult> {
    if (!this.limiter.allow(attempt.rateKey)) {
      return { ok: false, reason: "rate_limited" };
    }
    return this.loginByIdentity(`dev_${devKey}`, null, null, "dev_login", attempt);
  }

  private async loginByIdentity(
    openid: string,
    rawUnionid: string | null,
    sessionKey: string | null,
    auditEvent: "wx_login" | "dev_login",
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    const unionid = usableUnionId(rawUnionid) ? rawUnionid : null;
    return this.database.transaction(async (connection) => {
      let account = await findByOpenId(connection, openid);
      let isNewAccount = false;

      if (account && account.unionid === null && unionid !== null) {
        await this.backfillUnionId(connection, account.user_id, unionid);
      }
      if (!account && unionid !== null) {
        account = await findByUnionId(connection, unionid);
      }
      if (!account) {
        const created = await this.createAccount(connection, openid, unionid);
        account = created.account;
        isNewAccount = created.created;
      }

      if (Number(account.status) !== 0) {
        await insertAudit(connection, {
          userId: account.user_id,
          event: "fail",
          reason: "banned",
          ip: attempt.ip,
          deviceId: attempt.deviceId,
          caller: "public",
        });
        return { ok: false, reason: "banned" };
      }

      const issued = await this.sessions.issue(
        connection,
        account.user_id,
        attempt.serverId,
        sessionKey,
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE accounts SET last_login_at = NOW(3) WHERE user_id = ?",
        [account.user_id],
      );
      await insertAudit(connection, {
        userId: account.user_id,
        event: auditEvent,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return {
        ok: true,
        response: {
          userId: account.user_id,
          accessToken: issued.accessToken,
          isNewAccount,
        },
      };
    });
  }

  private async createAccount(
    connection: PoolConnection,
    openid: string,
    unionid: string | null,
  ): Promise<{ account: AccountRow; created: boolean }> {
    const userId = await nextUserId(connection);
    try {
      await connection.execute<ResultSetHeader>(
        "INSERT INTO accounts (user_id, openid, unionid) VALUES (?, ?, ?)",
        [userId, openid, unionid],
      );
    } catch (error) {
      if (isDuplicate(error)) {
        // A competing transaction may have won after our initial identity
        // lookup. Use a locking/current read rather than a stale RR snapshot.
        const byOpenId = await findByOpenIdCurrent(connection, openid);
        if (byOpenId) {
          return { account: byOpenId, created: false };
        }
        if (unionid !== null) {
          const byUnionId = await findByUnionIdCurrent(connection, unionid);
          if (byUnionId) {
            return { account: byUnionId, created: false };
          }
        }
      }
      throw error;
    }
    return {
      account: {
        user_id: userId,
        status: 0,
        unionid,
      } as AccountRow,
      created: true,
    };
  }

  private async backfillUnionId(
    connection: PoolConnection,
    userId: string,
    unionid: string,
  ): Promise<void> {
    try {
      await connection.execute<ResultSetHeader>(
        "UPDATE accounts SET unionid = ? WHERE user_id = ? AND unionid IS NULL",
        [unionid, userId],
      );
    } catch (error) {
      const errno = Number((error as { errno?: unknown } | null)?.errno ?? 0);
      console.warn(`[login] unionid 回填失败 errno=${errno} uid=${userId}`);
      if (errno === 1062) {
        await insertAudit(connection, {
          userId,
          event: "login_dual_account",
          reason: `unionid 回填撞 uk_unionid（前缀 ${unionid.slice(0, 8)}…）`,
          caller: "public",
        });
      }
    }
  }
}
