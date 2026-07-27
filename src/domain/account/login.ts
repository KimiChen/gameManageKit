import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { LoginResponse } from "@gono/game-manage-kit-contract";
import type { GameContext } from "../game/registry.js";
import { Database } from "../../infra/mysql/database.js";
import type { MetricsRegistry, WechatOutcome } from "../../infra/observability/metrics.js";
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

async function findByOpenId(
  connection: PoolConnection,
  gameId: string,
  openid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE game_id = ? AND openid = ?",
    [gameId, openid],
  );
  return rows[0];
}

async function findByOpenIdCurrent(
  connection: PoolConnection,
  gameId: string,
  openid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    `SELECT user_id, status, unionid
       FROM accounts
      WHERE game_id = ? AND openid = ?
      FOR SHARE`,
    [gameId, openid],
  );
  return rows[0];
}

async function findByUnionId(
  connection: PoolConnection,
  gameId: string,
  unionid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    "SELECT user_id, status, unionid FROM accounts WHERE game_id = ? AND unionid = ?",
    [gameId, unionid],
  );
  return rows[0];
}

async function findByUnionIdCurrent(
  connection: PoolConnection,
  gameId: string,
  unionid: string,
): Promise<AccountRow | undefined> {
  const [rows] = await connection.query<AccountRow[]>(
    `SELECT user_id, status, unionid
       FROM accounts
      WHERE game_id = ? AND unionid = ?
      FOR SHARE`,
    [gameId, unionid],
  );
  return rows[0];
}

async function nextUserId(connection: PoolConnection, gameId: string): Promise<string> {
  const [result] = await connection.execute<ResultSetHeader>(
    "UPDATE seq SET val = LAST_INSERT_ID(val + 1) WHERE game_id = ? AND name = 'user_id'",
    [gameId],
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
    private readonly metrics?: MetricsRegistry,
  ) {}

  async loginWechat(
    game: GameContext,
    code: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    if (!game.loginLimiter.allow(`${game.gameId}:${attempt.rateKey}`)) {
      this.metrics?.recordRateLimit(game.gameId, "login");
      this.metrics?.recordLogin(game.gameId, "rate_limited");
      return { ok: false, reason: "rate_limited" };
    }
    const identity = await game.wechat.exchange(code);
    const wechatOutcome: WechatOutcome = identity.ok
      ? "success"
      : identity.reason === "wx_invalid"
        ? "invalid"
        : identity.reason === "wx_rate_limited"
          ? "rate_limited"
          : "unavailable";
    this.metrics?.recordWechat(game.gameId, wechatOutcome);
    if (!identity.ok) {
      this.metrics?.recordLogin(game.gameId, identity.reason);
      await insertAudit(this.database.pool, {
        gameId: game.gameId,
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
      game.gameId,
      identity.openid,
      identity.unionid,
      "wx_login",
      attempt,
    );
  }

  async loginDev(
    game: GameContext,
    devKey: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    if (!game.loginLimiter.allow(`${game.gameId}:${attempt.rateKey}`)) {
      this.metrics?.recordRateLimit(game.gameId, "login");
      this.metrics?.recordLogin(game.gameId, "rate_limited");
      return { ok: false, reason: "rate_limited" };
    }
    return this.loginByIdentity(game.gameId, `dev_${devKey}`, null, "dev_login", attempt);
  }

  private async loginByIdentity(
    gameId: string,
    openid: string,
    rawUnionid: string | null,
    auditEvent: "wx_login" | "dev_login",
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    const unionid = usableUnionId(rawUnionid) ? rawUnionid : null;
    const execute = (): Promise<LoginResult> => this.database.transaction<LoginResult>(
      async (connection) => {
      let account = await findByOpenId(connection, gameId, openid);
      let isNewAccount = false;

      if (account && account.unionid === null && unionid !== null) {
        await this.backfillUnionId(connection, gameId, account.user_id, unionid);
      }
      if (!account && unionid !== null) {
        account = await findByUnionId(connection, gameId, unionid);
      }
      if (!account) {
        const created = await this.createAccount(connection, gameId, openid, unionid);
        account = created.account;
        isNewAccount = created.created;
      }

      if (Number(account.status) !== 0) {
        this.metrics?.recordLogin(gameId, "banned");
        await insertAudit(connection, {
          gameId,
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
        gameId,
        account.user_id,
        attempt.serverId,
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE accounts SET last_login_at = NOW(3) WHERE game_id = ? AND user_id = ?",
        [gameId, account.user_id],
      );
      await insertAudit(connection, {
        gameId,
        userId: account.user_id,
        event: auditEvent,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      this.metrics?.recordLogin(gameId, "success");
      return {
        ok: true,
        response: {
          userId: account.user_id,
          accessToken: issued.accessToken,
          isNewAccount,
        },
      };
      },
    );
    return this.metrics
      ? this.metrics.measureDatabase(gameId, "login", execute)
      : execute();
  }

  private async createAccount(
    connection: PoolConnection,
    gameId: string,
    openid: string,
    unionid: string | null,
  ): Promise<{ account: AccountRow; created: boolean }> {
    const userId = await nextUserId(connection, gameId);
    try {
      await connection.execute<ResultSetHeader>(
        "INSERT INTO accounts (game_id, user_id, openid, unionid) VALUES (?, ?, ?, ?)",
        [gameId, userId, openid, unionid],
      );
    } catch (error) {
      if (isDuplicate(error)) {
        // A competing transaction may have won after our initial identity
        // lookup. Use a locking/current read rather than a stale RR snapshot.
        const byOpenId = await findByOpenIdCurrent(connection, gameId, openid);
        if (byOpenId) {
          return { account: byOpenId, created: false };
        }
        if (unionid !== null) {
          const byUnionId = await findByUnionIdCurrent(connection, gameId, unionid);
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
    gameId: string,
    userId: string,
    unionid: string,
  ): Promise<void> {
    try {
      await connection.execute<ResultSetHeader>(
        `UPDATE accounts
            SET unionid = ?
          WHERE game_id = ? AND user_id = ? AND unionid IS NULL`,
        [unionid, gameId, userId],
      );
    } catch (error) {
      const errno = Number((error as { errno?: unknown } | null)?.errno ?? 0);
      console.warn("[login] unionid 回填失败", { gameId, errno, userId });
      if (errno === 1062) {
        await insertAudit(connection, {
          gameId,
          userId,
          event: "login_dual_account",
          reason: "unionid 回填冲突",
          caller: "public",
        });
      }
    }
  }
}
