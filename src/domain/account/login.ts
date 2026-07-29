import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { LoginResponse } from "@gono/game-manage-kit-contract";
import type {
  AuthExchangeResult,
  AuthProvider,
  ExternalAuthProvider,
  IdentityProviderClient,
  ProviderFailureReason,
} from "./auth-provider.js";
import type { GameContext } from "../game/resolver.js";
import { Database } from "../../infra/mysql/database.js";
import {
  type LoginOutcome,
  type MetricsRegistry,
  providerMetricOutcome,
} from "../../infra/observability/metrics.js";
import { insertAudit, type AuditInput } from "./audit.js";
import { SessionService } from "../session/service.js";

export type LoginFailureReason =
  | "banned"
  | "rate_limited"
  | "identity_conflict"
  | ProviderFailureReason;

export type LoginResult =
  | { ok: true; response: LoginResponse }
  | { ok: false; reason: LoginFailureReason };

type SubjectType = "openid" | "unionid" | "dev_key";

interface AccountRow extends RowDataPacket {
  readonly user_id: string;
  readonly status: number | string;
}

interface ProviderNamespaceRow extends RowDataPacket {
  readonly enabled: number | string;
  readonly app_id: string | null;
}

interface IdentityNamespace {
  readonly provider: AuthProvider;
  readonly providerAppId: string;
  readonly providerVersion: number | null;
  readonly primaryType: "openid" | "dev_key";
  readonly primarySubject: string;
  readonly unionSubject: string | null;
}

class IdentityResolutionRaceError extends Error {
  constructor() {
    super("身份解析发生并发竞争");
    this.name = "IdentityResolutionRaceError";
  }
}

function isRetryableIdentityRace(error: unknown): boolean {
  if (error instanceof IdentityResolutionRaceError) {
    return true;
  }
  const errno = Number(
    (error as { errno?: unknown } | null)?.errno ?? 0,
  );
  return errno === 1062 || errno === 1205 || errno === 1213;
}

async function findIdentity(
  connection: PoolConnection,
  gameId: string,
  namespace: IdentityNamespace,
  subjectType: SubjectType,
  subject: string,
): Promise<AccountRow | undefined> {
  // The successful path updates identity timestamps later in this
  // transaction. Lock exclusively now so concurrent repeat logins serialize
  // instead of deadlocking while upgrading shared locks.
  const [rows] = await connection.query<AccountRow[]>(
    `SELECT a.user_id, a.status
       FROM account_identities AS i
       JOIN accounts AS a
         ON a.game_id = i.game_id AND a.user_id = i.user_id
      WHERE i.game_id = ?
        AND i.provider = ?
        AND i.provider_app_id = ?
        AND i.subject_type = ?
        AND i.subject = ?
      LIMIT 1
      FOR UPDATE`,
    [
      gameId,
      namespace.provider,
      namespace.providerAppId,
      subjectType,
      subject,
    ],
  );
  return rows[0];
}

async function nextUserId(
  connection: PoolConnection,
  gameId: string,
): Promise<string> {
  const [result] = await connection.execute<ResultSetHeader>(
    "UPDATE seq SET val = LAST_INSERT_ID(val + 1) WHERE game_id = ? AND name = 'user_id'",
    [gameId],
  );
  if (result.affectedRows === 0) {
    throw new Error("seq.user_id 预置行缺失");
  }
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT LAST_INSERT_ID() AS value",
  );
  return `u_${String(rows[0]?.value ?? "")}`;
}

async function lockCurrentProviderNamespace(
  connection: PoolConnection,
  gameId: string,
  namespace: IdentityNamespace,
): Promise<boolean> {
  if (namespace.provider === "dev") {
    return true;
  }
  const [rows] = await connection.query<ProviderNamespaceRow[]>(
    `SELECT enabled, app_id
       FROM game_identity_providers
      WHERE game_id = ? AND provider = ?
      LIMIT 1
      FOR SHARE`,
    [gameId, namespace.provider],
  );
  const row = rows[0];
  return row !== undefined
    && Number(row.enabled) === 1
    && row.app_id === namespace.providerAppId;
}

function loginOutcome(reason: ProviderFailureReason): LoginOutcome {
  switch (reason) {
    case "invalid_code":
    case "invalid_credentials":
    case "rate_limited":
    case "timeout":
    case "circuit_open":
      return reason;
    case "unavailable":
    case "invalid_response":
      return "provider_unavailable";
  }
}

export interface LoginAttempt {
  readonly rateKey: string;
  readonly ip: string | null;
  readonly deviceId: string | null;
  readonly requestId: string;
  readonly serverId: number;
}

export class LoginService {
  constructor(
    private readonly database: Database,
    private readonly sessions: SessionService,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async auditAdmissionDenied(
    gameId: string,
    provider: AuthProvider,
    attempt: LoginAttempt,
    reason: string,
  ): Promise<void> {
    this.metrics?.recordLogin(gameId, "admission_denied");
    await this.audit(this.database.pool, {
      gameId,
      userId: null,
      event: "login",
      reason: `admission:${reason}`,
      outcome: "admission_denied",
      provider,
      requestId: attempt.requestId,
      serverId: attempt.serverId,
      ip: attempt.ip,
      deviceId: attempt.deviceId,
      caller: "public",
    });
  }

  async loginWechat(
    game: GameContext,
    code: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    return this.loginExternal(
      game,
      "wechat",
      game.wechat,
      code,
      attempt,
    );
  }

  async loginDouyin(
    game: GameContext,
    code: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    return this.loginExternal(
      game,
      "douyin",
      game.douyin,
      code,
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
      await this.audit(this.database.pool, {
        gameId: game.gameId,
        userId: null,
        event: "login",
        reason: "local_rate_limit",
        outcome: "rate_limited",
        provider: "dev",
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: "rate_limited" };
    }
    return this.loginByIdentity(
      game.gameId,
      {
        provider: "dev",
        providerAppId: "local",
        providerVersion: null,
        primaryType: "dev_key",
        primarySubject: devKey,
        unionSubject: null,
      },
      attempt,
      0,
    );
  }

  private async loginExternal(
    game: GameContext,
    provider: ExternalAuthProvider,
    client: IdentityProviderClient,
    code: string,
    attempt: LoginAttempt,
  ): Promise<LoginResult> {
    if (!game.loginLimiter.allow(`${game.gameId}:${attempt.rateKey}`)) {
      this.metrics?.recordRateLimit(game.gameId, "login");
      this.metrics?.recordLogin(game.gameId, "rate_limited");
      await this.audit(this.database.pool, {
        gameId: game.gameId,
        userId: null,
        event: "login",
        reason: "local_rate_limit",
        outcome: "rate_limited",
        provider,
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: "rate_limited" };
    }

    const started = process.hrtime.bigint();
    let identity: AuthExchangeResult;
    try {
      identity = await client.exchange(code);
    } catch {
      identity = { ok: false, reason: "unavailable" };
    }
    const latencySeconds =
      Number(process.hrtime.bigint() - started) / 1_000_000_000;
    const latencyMs = Math.min(
      2_147_483_647,
      Math.max(0, Math.round(latencySeconds * 1_000)),
    );
    this.metrics?.recordIdentityProviderDuration(
      game.gameId,
      provider,
      latencySeconds,
    );
    this.metrics?.recordIdentityProvider(
      game.gameId,
      provider,
      identity.ok
        ? "success"
        : providerMetricOutcome(identity.reason),
    );

    if (!identity.ok) {
      const outcome = loginOutcome(identity.reason);
      this.metrics?.recordLogin(game.gameId, outcome);
      await this.audit(this.database.pool, {
        gameId: game.gameId,
        userId: null,
        event: "login",
        reason: `code2session:${identity.reason}`,
        outcome,
        provider,
        providerVersion: identity.providerVersion ?? null,
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        providerLatencyMs: latencyMs,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: identity.reason };
    }
    if (
      identity.provider !== provider
      || identity.providerAppId.length === 0
    ) {
      this.metrics?.recordLogin(game.gameId, "internal_error");
      await this.auditInternalFailure(
        game.gameId,
        provider,
        identity.providerVersion ?? null,
        attempt,
        latencyMs,
      );
      throw new Error("Provider 返回的身份命名空间不一致");
    }
    return this.loginByIdentity(
      game.gameId,
      {
        provider,
        providerAppId: identity.providerAppId,
        providerVersion: identity.providerVersion ?? null,
        primaryType: "openid",
        primarySubject: identity.subject,
        unionSubject: identity.unionSubject,
      },
      attempt,
      latencyMs,
    );
  }

  private async loginByIdentity(
    gameId: string,
    namespace: IdentityNamespace,
    attempt: LoginAttempt,
    providerLatencyMs: number,
  ): Promise<LoginResult> {
    const execute = async (): Promise<LoginResult> => {
      let lastError: unknown;
      for (let currentAttempt = 0; currentAttempt < 3; currentAttempt += 1) {
        try {
          return await this.database.transaction<LoginResult>(
            async (connection) => this.resolveAndIssue(
              connection,
              gameId,
              namespace,
              attempt,
              providerLatencyMs,
            ),
          );
        } catch (error) {
          lastError = error;
          if (!isRetryableIdentityRace(error) || currentAttempt === 2) {
            throw error;
          }
        }
      }
      throw lastError;
    };
    let result: LoginResult;
    try {
      result = await (
        this.metrics
          ? this.metrics.measureDatabase(gameId, "login", execute)
          : execute()
      );
    } catch (error) {
      this.metrics?.recordLogin(gameId, "internal_error");
      await this.auditInternalFailure(
        gameId,
        namespace.provider,
        namespace.providerVersion,
        attempt,
        providerLatencyMs,
      );
      throw error;
    }
    this.recordCommittedLogin(gameId, result);
    return result;
  }

  private async resolveAndIssue(
    connection: PoolConnection,
    gameId: string,
    namespace: IdentityNamespace,
    attempt: LoginAttempt,
    providerLatencyMs: number,
  ): Promise<LoginResult> {
    if (!await lockCurrentProviderNamespace(
      connection,
      gameId,
      namespace,
    )) {
      await this.audit(connection, {
        gameId,
        userId: null,
        event: "login",
        reason: "provider_configuration_changed",
        outcome: "provider_unavailable",
        provider: namespace.provider,
        providerVersion: namespace.providerVersion,
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        providerLatencyMs,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: "unavailable" };
    }

    let primary = await findIdentity(
      connection,
      gameId,
      namespace,
      namespace.primaryType,
      namespace.primarySubject,
    );
    let union = namespace.unionSubject === null
      ? undefined
      : await findIdentity(
          connection,
          gameId,
          namespace,
          "unionid",
          namespace.unionSubject,
        );

    if (primary && union && primary.user_id !== union.user_id) {
      await this.audit(connection, {
        gameId,
        userId: null,
        event: "login",
        reason: "identity_conflict",
        outcome: "identity_conflict",
        provider: namespace.provider,
        providerVersion: namespace.providerVersion,
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        providerLatencyMs,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: "identity_conflict" };
    }

    let account = primary ?? union;
    let isNewAccount = false;
    if (!account) {
      const userId = await nextUserId(connection, gameId);
      await connection.execute<ResultSetHeader>(
        "INSERT INTO accounts (game_id, user_id) VALUES (?, ?)",
        [gameId, userId],
      );
      account = { user_id: userId, status: 0 } as AccountRow;
      isNewAccount = true;
    }

    if (!primary) {
      await this.insertIdentity(
        connection,
        gameId,
        account.user_id,
        namespace,
        namespace.primaryType,
        namespace.primarySubject,
      );
      primary = account;
    }
    if (namespace.unionSubject !== null && !union) {
      await this.insertIdentity(
        connection,
        gameId,
        account.user_id,
        namespace,
        "unionid",
        namespace.unionSubject,
      );
      union = account;
    }

    if (Number(account.status) !== 0) {
      await this.audit(connection, {
        gameId,
        userId: account.user_id,
        event: "login",
        reason: "banned",
        outcome: "banned",
        provider: namespace.provider,
        providerVersion: namespace.providerVersion,
        requestId: attempt.requestId,
        serverId: attempt.serverId,
        providerLatencyMs,
        ip: attempt.ip,
        deviceId: attempt.deviceId,
        caller: "public",
      });
      return { ok: false, reason: "banned" };
    }

    let issued: Awaited<ReturnType<SessionService["issue"]>>;
    try {
      issued = await this.sessions.issue(
        connection,
        gameId,
        account.user_id,
        attempt.serverId,
      );
    } catch (error) {
      this.metrics?.recordSessionIssueFailure(gameId);
      throw error;
    }
    await connection.execute<ResultSetHeader>(
      `UPDATE accounts
          SET last_login_at = NOW(3)
        WHERE game_id = ? AND user_id = ?`,
      [gameId, account.user_id],
    );
    await connection.execute<ResultSetHeader>(
      `UPDATE account_identities
          SET last_login_at = NOW(3)
        WHERE game_id = ?
          AND user_id = ?
          AND provider = ?
          AND provider_app_id = ?
          AND (
            (subject_type = ? AND subject = ?)
            OR (subject_type = 'unionid' AND subject = ?)
          )`,
      [
        gameId,
        account.user_id,
        namespace.provider,
        namespace.providerAppId,
        namespace.primaryType,
        namespace.primarySubject,
        namespace.unionSubject,
      ],
    );
    await this.audit(connection, {
      gameId,
      userId: account.user_id,
      event: "login",
      outcome: "success",
      provider: namespace.provider,
      providerVersion: namespace.providerVersion,
      requestId: attempt.requestId,
      serverId: attempt.serverId,
      providerLatencyMs,
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
  }

  private recordCommittedLogin(
    gameId: string,
    result: LoginResult,
  ): void {
    if (result.ok) {
      this.metrics?.recordLogin(gameId, "success");
      return;
    }
    switch (result.reason) {
      case "banned":
      case "identity_conflict":
        this.metrics?.recordLogin(gameId, result.reason);
        return;
      case "unavailable":
        this.metrics?.recordLogin(gameId, "provider_unavailable");
        return;
      default:
        return;
    }
  }

  private async insertIdentity(
    connection: PoolConnection,
    gameId: string,
    userId: string,
    namespace: IdentityNamespace,
    subjectType: SubjectType,
    subject: string,
  ): Promise<void> {
    try {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO account_identities
           (game_id, user_id, provider, provider_app_id,
            subject_type, subject)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          gameId,
          userId,
          namespace.provider,
          namespace.providerAppId,
          subjectType,
          subject,
        ],
      );
    } catch (error) {
      if (Number((error as { errno?: unknown } | null)?.errno) === 1062) {
        throw new IdentityResolutionRaceError();
      }
      throw error;
    }
  }

  private async audit(
    executor: Parameters<typeof insertAudit>[0],
    input: AuditInput,
  ): Promise<void> {
    try {
      await insertAudit(executor, input);
    } catch (error) {
      this.metrics?.recordAuditWriteFailure(input.gameId, "login");
      throw error;
    }
  }

  private async auditInternalFailure(
    gameId: string,
    provider: AuthProvider,
    providerVersion: number | null,
    attempt: LoginAttempt,
    providerLatencyMs: number,
  ): Promise<void> {
    await this.audit(this.database.pool, {
      gameId,
      userId: null,
      event: "login",
      reason: "internal_error",
      outcome: "internal_error",
      provider,
      providerVersion,
      requestId: attempt.requestId,
      serverId: attempt.serverId,
      providerLatencyMs,
      ip: attempt.ip,
      deviceId: attempt.deviceId,
      caller: "public",
    }).catch(() => undefined);
  }
}
