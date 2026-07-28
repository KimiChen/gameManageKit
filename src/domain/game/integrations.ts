import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import { GAME_ID_PATTERN } from "./resolver.js";

export type GameConfigurationState = "draft" | "configured";
export type ConfigurationAuthorizationKind = "read" | "write" | "secret";

export interface ConfigurationAuthorization {
  readonly operatorId: string;
  readonly ip: string | null;
  readonly requestId: string;
  authorize(
    connection: PoolConnection,
    kind: ConfigurationAuthorizationKind,
  ): Promise<void>;
}

export interface GameIntegrationDatabase {
  readonly pool: Pool;
  transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T>;
}

export interface GameIntegrationRuntime {
  invalidate(gameId: string): void;
  loadedRevision(
    gameId: string,
  ): Readonly<{ integration: number }> | null;
}

export interface WechatSecretMetadata {
  readonly configured: boolean;
  readonly version: number;
  readonly state: "active" | "missing" | "validation_failed";
  readonly updatedAt: string | null;
}

export interface GameIntegration {
  readonly gameId: string;
  readonly configurationState: GameConfigurationState;
  readonly wechatAppId: string | null;
  readonly wechatSecret: WechatSecretMetadata;
  readonly wechatEndpoint: string;
  readonly wechatTimeoutMs: number;
  readonly wechatBreakerThreshold: number;
  readonly wechatBreakerOpenMs: number;
  readonly sessionTtlSeconds: number;
  readonly loginRateCapacity: number;
  readonly loginRateRefillPerSecond: number;
  readonly adminRateCapacity: number;
  readonly adminRateRefillPerSecond: number;
  readonly revision: number;
  readonly loadedRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateGameIntegrationInput {
  readonly wechatAppId: string | null;
  readonly wechatEndpoint: string;
  readonly wechatTimeoutMs: number;
  readonly wechatBreakerThreshold: number;
  readonly wechatBreakerOpenMs: number;
  readonly sessionTtlSeconds: number;
  readonly loginRateCapacity: number;
  readonly loginRateRefillPerSecond: number;
  readonly adminRateCapacity: number;
  readonly adminRateRefillPerSecond: number;
  readonly revision: number;
}

export interface ReplaceWechatSecretInput {
  readonly wechatAppSecret: string;
  readonly revision: number;
  readonly operationId: string;
}

export interface WechatSecretWriteResult {
  readonly gameId: string;
  readonly configurationState: GameConfigurationState;
  readonly wechatSecret: WechatSecretMetadata;
  readonly revision: number;
  readonly loadedRevision: number | null;
  readonly replayed: boolean;
}

interface IntegrationRow extends RowDataPacket {
  readonly game_id: string;
  readonly configuration_state: string;
  readonly wechat_app_id: string | null;
  readonly wechat_secret_configured: number | boolean | string;
  readonly wechat_secret_version: number | string;
  readonly wechat_secret_updated_at: Date | string | null;
  readonly wechat_validation_failed_at: Date | string | null;
  readonly wechat_endpoint: string;
  readonly wechat_timeout_ms: number | string;
  readonly wechat_breaker_threshold: number | string;
  readonly wechat_breaker_open_ms: number | string;
  readonly session_ttl_seconds: number | string;
  readonly login_rate_capacity: number | string;
  readonly login_rate_refill_per_second: number | string;
  readonly admin_rate_capacity: number | string;
  readonly admin_rate_refill_per_second: number | string;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface GameStateRow extends RowDataPacket {
  readonly game_id: string;
  readonly configuration_state: string;
}

interface SecretOperationRow extends RowDataPacket {
  readonly operation_id: string;
  readonly operator_id: string;
  readonly game_id: string | null;
  readonly identity_id: string | null;
  readonly secret_kind: string;
  readonly action: string;
  readonly old_version: number | string | null;
  readonly new_version: number | string | null;
  readonly created_at: Date | string;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const CONFIGURATION_STATES = new Set<GameConfigurationState>([
  "draft",
  "configured",
]);

const SELECT_INTEGRATION = `
  SELECT g.game_id, g.configuration_state,
         i.wechat_app_id,
         (i.wechat_app_secret IS NOT NULL) AS wechat_secret_configured,
         i.wechat_secret_version, i.wechat_secret_updated_at,
         i.wechat_validation_failed_at,
         i.wechat_endpoint, i.wechat_timeout_ms,
         i.wechat_breaker_threshold, i.wechat_breaker_open_ms,
         i.session_ttl_seconds, i.login_rate_capacity,
         i.login_rate_refill_per_second, i.admin_rate_capacity,
         i.admin_rate_refill_per_second, i.revision,
         i.created_at, i.updated_at
    FROM games AS g
    JOIN game_integrations AS i ON i.game_id = g.game_id`;

function invalidPayload(): never {
  throw new GameManageKitError(400, "INVALID_PAYLOAD");
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

function isConflict(error: unknown): boolean {
  return error instanceof GameManageKitError && error.statusCode === 409;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("游戏接入配置时间数据无效");
  }
  return date.toISOString();
}

function optionalIsoDate(value: Date | string | null): string | null {
  return value === null ? null : isoDate(value);
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > maximum
  ) {
    return invalidPayload();
  }
  return number;
}

function positiveNumber(
  value: unknown,
  maximum = 1_000_000,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > maximum) {
    return invalidPayload();
  }
  return number;
}

function normalizedAppId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 1
    || value.length > 128
    || !/^[\x21-\x7e]+$/u.test(value)
  ) {
    return invalidPayload();
  }
  return value;
}

function normalizedEndpoint(raw: string, production: boolean): string {
  if (
    typeof raw !== "string"
    || raw !== raw.trim()
    || raw.length < 1
    || raw.length > 2_048
  ) {
    return invalidPayload();
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidPayload();
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return invalidPayload();
  }
  const officialWechatEndpoint = parsed.protocol === "https:"
    && parsed.hostname === "api.weixin.qq.com"
    && parsed.port === ""
    && parsed.pathname === "/sns/jscode2session"
    && parsed.search === "";
  if (officialWechatEndpoint) {
    return raw;
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  if (
    production
    || !loopback
    || (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    return invalidPayload();
  }
  return raw;
}

function secretMetadataFromRow(row: IntegrationRow): WechatSecretMetadata {
  const configured = Number(row.wechat_secret_configured) === 1;
  const version = Number(row.wechat_secret_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("微信 Secret 版本数据无效");
  }
  return Object.freeze({
    configured,
    version,
    state: !configured
      ? "missing"
      : row.wechat_validation_failed_at === null
        ? "active"
        : "validation_failed",
    updatedAt: optionalIsoDate(row.wechat_secret_updated_at),
  });
}

function integrationFromRow(
  row: IntegrationRow,
  loadedRevision: number | null,
): GameIntegration {
  const configurationState = String(row.configuration_state);
  if (!CONFIGURATION_STATES.has(configurationState as GameConfigurationState)) {
    throw new Error("游戏配置状态数据无效");
  }
  const revision = safeInteger(row.revision, 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    gameId: String(row.game_id),
    configurationState: configurationState as GameConfigurationState,
    wechatAppId: row.wechat_app_id === null
      ? null
      : String(row.wechat_app_id),
    wechatSecret: secretMetadataFromRow(row),
    wechatEndpoint: String(row.wechat_endpoint),
    wechatTimeoutMs: safeInteger(row.wechat_timeout_ms, 100, 30_000),
    wechatBreakerThreshold: safeInteger(
      row.wechat_breaker_threshold,
      1,
      1_000,
    ),
    wechatBreakerOpenMs: safeInteger(
      row.wechat_breaker_open_ms,
      100,
      600_000,
    ),
    sessionTtlSeconds: safeInteger(
      row.session_ttl_seconds,
      60,
      31_536_000,
    ),
    loginRateCapacity: positiveNumber(row.login_rate_capacity),
    loginRateRefillPerSecond: positiveNumber(
      row.login_rate_refill_per_second,
    ),
    adminRateCapacity: positiveNumber(row.admin_rate_capacity),
    adminRateRefillPerSecond: positiveNumber(
      row.admin_rate_refill_per_second,
    ),
    revision,
    loadedRevision,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  });
}

function normalizedUpdate(
  input: UpdateGameIntegrationInput,
  production: boolean,
): UpdateGameIntegrationInput {
  if (!input || typeof input !== "object") {
    return invalidPayload();
  }
  return Object.freeze({
    wechatAppId: normalizedAppId(input.wechatAppId),
    wechatEndpoint: normalizedEndpoint(input.wechatEndpoint, production),
    wechatTimeoutMs: safeInteger(input.wechatTimeoutMs, 100, 30_000),
    wechatBreakerThreshold: safeInteger(
      input.wechatBreakerThreshold,
      1,
      1_000,
    ),
    wechatBreakerOpenMs: safeInteger(
      input.wechatBreakerOpenMs,
      100,
      600_000,
    ),
    sessionTtlSeconds: safeInteger(
      input.sessionTtlSeconds,
      60,
      31_536_000,
    ),
    loginRateCapacity: positiveNumber(input.loginRateCapacity),
    loginRateRefillPerSecond: positiveNumber(
      input.loginRateRefillPerSecond,
    ),
    adminRateCapacity: positiveNumber(input.adminRateCapacity),
    adminRateRefillPerSecond: positiveNumber(
      input.adminRateRefillPerSecond,
    ),
    revision: safeInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
  });
}

export class GameIntegrationService {
  constructor(
    private readonly database: GameIntegrationDatabase,
    private readonly runtime: GameIntegrationRuntime,
    private readonly production: boolean,
  ) {}

  async get(
    gameId: string,
    authorization: ConfigurationAuthorization,
  ): Promise<GameIntegration> {
    this.validateGameId(gameId);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "read");
      return this.requireIntegration(connection, gameId, false);
    });
  }

  async update(
    gameId: string,
    input: UpdateGameIntegrationInput,
    authorization: ConfigurationAuthorization,
  ): Promise<GameIntegration> {
    this.validateGameId(gameId);
    const normalized = normalizedUpdate(input, this.production);
    const result = await this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "write");
      await this.requireGame(connection, gameId);
      const current = await this.requireIntegration(
        connection,
        gameId,
        true,
      );
      if (current.revision !== normalized.revision) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE game_integrations
            SET wechat_app_id = ?,
                wechat_endpoint = ?,
                wechat_timeout_ms = ?,
                wechat_breaker_threshold = ?,
                wechat_breaker_open_ms = ?,
                session_ttl_seconds = ?,
                login_rate_capacity = ?,
                login_rate_refill_per_second = ?,
                admin_rate_capacity = ?,
                admin_rate_refill_per_second = ?,
                wechat_validation_failed_at = NULL,
                revision = revision + 1
          WHERE game_id = ? AND revision = ?`,
        [
          normalized.wechatAppId,
          normalized.wechatEndpoint,
          normalized.wechatTimeoutMs,
          normalized.wechatBreakerThreshold,
          normalized.wechatBreakerOpenMs,
          normalized.sessionTtlSeconds,
          normalized.loginRateCapacity,
          normalized.loginRateRefillPerSecond,
          normalized.adminRateCapacity,
          normalized.adminRateRefillPerSecond,
          gameId,
          normalized.revision,
        ],
      );
      if (updated.affectedRows !== 1) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      await this.reconcileConfigurationState(connection, gameId);
      const integration = await this.requireIntegration(
        connection,
        gameId,
        true,
      );
      await connection.execute(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, action, before_data, after_data, ip)
         VALUES (?, ?, 'integration_update', ?, ?, INET6_ATON(?))`,
        [
          gameId,
          authorization.operatorId,
          JSON.stringify(current),
          JSON.stringify(integration),
          normalizeIp(authorization.ip),
        ],
      );
      return integration;
    });
    this.runtime.invalidate(gameId);
    return result;
  }

  async replaceWechatSecret(
    gameId: string,
    input: ReplaceWechatSecretInput,
    authorization: ConfigurationAuthorization,
  ): Promise<WechatSecretWriteResult> {
    this.validateGameId(gameId);
    const normalized = this.normalizeSecretInput(input);
    let replay: WechatSecretWriteResult | null;
    try {
      replay = await this.findReplay(
        gameId,
        normalized.operationId,
        authorization,
      );
    } catch (error) {
      await this.auditSecretFailure(gameId, authorization, error);
      throw error;
    }
    if (replay) {
      return replay;
    }
    try {
      const result = await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "secret");
        await this.requireGame(connection, gameId);
        const current = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        if (current.revision !== normalized.revision) {
          throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
        }
        const oldVersion = current.wechatSecret.version;
        const newVersion = oldVersion + 1;
        const [updatedSecret] = await connection.execute<ResultSetHeader>(
          `UPDATE game_integrations
              SET wechat_app_secret = ?,
                  wechat_secret_version = ?,
                  wechat_secret_updated_by = ?,
                  wechat_secret_updated_at = NOW(3),
                  wechat_validation_failed_at = NULL,
                  revision = revision + 1
            WHERE game_id = ? AND revision = ?`,
          [
            normalized.wechatAppSecret,
            newVersion,
            authorization.operatorId,
            gameId,
            normalized.revision,
          ],
        );
        if (updatedSecret.affectedRows !== 1) {
          throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
        }
        await connection.execute(
          `INSERT INTO admin_secret_operations
             (operation_id, operator_id, game_id, identity_id,
              secret_kind, action, old_version, new_version)
           VALUES (?, ?, ?, NULL, 'wechat_app_secret', 'set', ?, ?)`,
          [
            normalized.operationId,
            authorization.operatorId,
            gameId,
            oldVersion,
            newVersion,
          ],
        );
        await connection.execute(
          `INSERT INTO admin_secret_audit
             (operator_id, game_id, identity_id, secret_kind, action,
              old_version, new_version, result, reason, request_id, ip)
           VALUES (?, ?, NULL, 'wechat_app_secret', 'set',
                   ?, ?, 'succeeded', NULL, ?, INET6_ATON(?))`,
          [
            authorization.operatorId,
            gameId,
            oldVersion,
            newVersion,
            authorization.requestId,
            normalizeIp(authorization.ip),
          ],
        );
        await this.reconcileConfigurationState(connection, gameId);
        const updated = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        return this.secretWriteResult(updated, false);
      });
      this.runtime.invalidate(gameId);
      return result;
    } catch (error) {
      if (isDuplicate(error) || isConflict(error)) {
        try {
          const replayed = await this.findReplay(
            gameId,
            normalized.operationId,
            authorization,
          );
          if (replayed) {
            return replayed;
          }
        } catch (replayError) {
          await this.auditSecretFailure(
            gameId,
            authorization,
            replayError,
          );
          throw replayError;
        }
      }
      await this.auditSecretFailure(gameId, authorization, error);
      throw error;
    }
  }

  private validateGameId(gameId: string): void {
    if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) {
      invalidPayload();
    }
  }

  private normalizeSecretInput(
    input: ReplaceWechatSecretInput,
  ): ReplaceWechatSecretInput {
    if (
      !input
      || typeof input !== "object"
      || typeof input.wechatAppSecret !== "string"
      || input.wechatAppSecret.length < 1
      || input.wechatAppSecret.length > 512
      || !OPERATION_ID_PATTERN.test(input.operationId)
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      wechatAppSecret: input.wechatAppSecret,
      revision: safeInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
      operationId: input.operationId,
    });
  }

  private async requireGame(
    connection: PoolConnection,
    gameId: string,
  ): Promise<void> {
    const [rows] = await connection.query<GameStateRow[]>(
      `SELECT game_id, configuration_state
         FROM games
        WHERE game_id = ?
        FOR UPDATE`,
      [gameId],
    );
    if (!rows[0]) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
  }

  private async requireIntegration(
    connection: PoolConnection,
    gameId: string,
    lock: boolean,
  ): Promise<GameIntegration> {
    const [rows] = await connection.query<IntegrationRow[]>(
      `${SELECT_INTEGRATION}
        WHERE g.game_id = ?${lock ? " FOR UPDATE" : ""}`,
      [gameId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    return integrationFromRow(
      row,
      this.runtime.loadedRevision(gameId)?.integration ?? null,
    );
  }

  private async reconcileConfigurationState(
    connection: PoolConnection,
    gameId: string,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT g.configuration_state,
              i.wechat_app_id,
              (i.wechat_app_secret IS NOT NULL) AS secret_configured
         FROM games AS g
         JOIN game_integrations AS i ON i.game_id = g.game_id
        WHERE g.game_id = ?
        FOR UPDATE`,
      [gameId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    const configured = typeof row.wechat_app_id === "string"
      && row.wechat_app_id.length > 0
      && Number(row.secret_configured) === 1;
    const nextState: GameConfigurationState = configured
      ? "configured"
      : "draft";
    if (String(row.configuration_state) === nextState) {
      return;
    }
    if (nextState === "configured") {
      await connection.execute(
        `UPDATE games
            SET configuration_state = 'configured',
                revision = revision + 1
          WHERE game_id = ?`,
        [gameId],
      );
    } else {
      await connection.execute(
        `UPDATE games
            SET configuration_state = 'draft',
                status = CASE
                  WHEN status = 'disabled' THEN 'disabled'
                  ELSE 'maintenance'
                END,
                client_visible = 0,
                revision = revision + 1
          WHERE game_id = ?`,
        [gameId],
      );
    }
  }

  private secretWriteResult(
    integration: GameIntegration,
    replayed: boolean,
    version = integration.wechatSecret.version,
    updatedAt = integration.wechatSecret.updatedAt,
  ): WechatSecretWriteResult {
    return Object.freeze({
      gameId: integration.gameId,
      configurationState: integration.configurationState,
      wechatSecret: Object.freeze({
        configured: true,
        version,
        state: integration.wechatSecret.state,
        updatedAt,
      }),
      revision: integration.revision,
      loadedRevision: integration.loadedRevision,
      replayed,
    });
  }

  private async findReplay(
    gameId: string,
    operationId: string,
    authorization: ConfigurationAuthorization,
  ): Promise<WechatSecretWriteResult | null> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "secret");
      const [rows] = await connection.query<SecretOperationRow[]>(
        `SELECT operation_id, operator_id, game_id, identity_id,
                secret_kind, action, old_version, new_version, created_at
           FROM admin_secret_operations
          WHERE operation_id = ?
          FOR SHARE`,
        [operationId],
      );
      const operation = rows[0];
      if (!operation) {
        return null;
      }
      if (
        operation.operator_id !== authorization.operatorId
        || operation.game_id !== gameId
        || operation.identity_id !== null
        || operation.secret_kind !== "wechat_app_secret"
        || operation.action !== "set"
      ) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      const version = Number(operation.new_version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error("Secret 操作版本数据无效");
      }
      const integration = await this.requireIntegration(
        connection,
        gameId,
        false,
      );
      return this.secretWriteResult(
        integration,
        true,
        version,
        isoDate(operation.created_at),
      );
    });
  }

  private async auditSecretFailure(
    gameId: string,
    authorization: ConfigurationAuthorization,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof GameManageKitError
      ? error.code
      : "INTERNAL";
    await this.database.transaction(async (connection) => {
      const [games] = await connection.query<RowDataPacket[]>(
        "SELECT game_id FROM games WHERE game_id = ? FOR SHARE",
        [gameId],
      );
      if (!games[0]) {
        return;
      }
      await connection.execute(
        `INSERT INTO admin_secret_audit
           (operator_id, game_id, identity_id, secret_kind, action,
            old_version, new_version, result, reason, request_id, ip)
         VALUES (?, ?, NULL, 'wechat_app_secret', 'set',
                 NULL, NULL, 'failed', ?, ?, INET6_ATON(?))`,
        [
          authorization.operatorId,
          gameId,
          reason,
          authorization.requestId,
          normalizeIp(authorization.ip),
        ],
      );
    }).catch(() => undefined);
  }
}
