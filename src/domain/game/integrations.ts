import type {
  ClearIdentityProviderSecretRequest,
  GameConfigurationState,
  GameIntegration,
  IdentityProvider,
  IdentityProviderConfiguration,
  IdentityProviderSecretMetadata,
  IdentityProviderSecretWriteResponse,
  IdentityProviderValidationState,
  ReplaceIdentityProviderSecretRequest,
  UpdateGameIntegrationRequest,
  UpdateIdentityProviderRequest,
} from "@gono/game-manage-kit-contract";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { createHash, timingSafeEqual } from "node:crypto";
import { GameManageKitError } from "../../errors.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import { normalizeIp } from "../../infra/security/security.js";
import { GAME_ID_PATTERN } from "./resolver.js";

export type ConfigurationAuthorizationKind = "read" | "write" | "secret";
export type {
  ClearIdentityProviderSecretRequest,
  GameConfigurationState,
  GameIntegration,
  IdentityProvider,
  IdentityProviderConfiguration,
  IdentityProviderSecretMetadata,
  IdentityProviderSecretWriteResponse,
  ReplaceIdentityProviderSecretRequest,
  UpdateGameIntegrationRequest,
  UpdateIdentityProviderRequest,
};

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
  invalidate(
    gameId: string,
    provider?: IdentityProvider | null,
  ): void;
  loadedRevision(
    gameId: string,
  ): Readonly<{ integration: number }> | null;
}

interface IntegrationRow extends RowDataPacket {
  readonly game_id: string;
  readonly configuration_state: string;
  readonly session_ttl_seconds: number | string;
  readonly login_rate_capacity: number | string;
  readonly login_rate_refill_per_second: number | string;
  readonly admin_rate_capacity: number | string;
  readonly admin_rate_refill_per_second: number | string;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface ProviderRow extends RowDataPacket {
  readonly game_id: string;
  readonly provider: string;
  readonly enabled: number | boolean | string;
  readonly app_id: string | null;
  readonly secret_configured: number | boolean | string;
  readonly secret_version: number | string;
  readonly secret_updated_at: Date | string | null;
  readonly endpoint: string;
  readonly timeout_ms: number | string;
  readonly breaker_threshold: number | string;
  readonly breaker_open_ms: number | string;
  readonly validation_state: string;
  readonly validation_failed_at: Date | string | null;
  readonly validation_error_code: string | null;
  readonly updated_by: string | null;
  readonly updated_at: Date | string;
}

interface SecretOperationRow extends RowDataPacket {
  readonly operation_id: string;
  readonly operator_id: string;
  readonly game_id: string | null;
  readonly provider: string | null;
  readonly identity_id: string | null;
  readonly secret_kind: string;
  readonly action: string;
  readonly old_version: number | string | null;
  readonly new_version: number | string | null;
  readonly revision: number | string | null;
  readonly request_digest: Uint8Array | null;
  readonly result_configuration_state: string | null;
  readonly result_revision: number | string | null;
  readonly result_secret_updated_at: Date | string | null;
  readonly created_at: Date | string;
}

type ProviderSecretAction = "set" | "rotate" | "clear";
type ProviderConfigurationAction =
  | "identity_provider_update"
  | "identity_provider_enable"
  | "identity_provider_disable";
type SecretMutation =
  | Readonly<{
      kind: "replace";
      input: ReplaceIdentityProviderSecretRequest;
    }>
  | Readonly<{
      kind: "clear";
      input: ClearIdentityProviderSecretRequest;
    }>;

const IDENTITY_PROVIDERS = Object.freeze([
  "wechat",
  "douyin",
] as const satisfies readonly IdentityProvider[]);
const IDENTITY_PROVIDER_SET = new Set<IdentityProvider>(
  IDENTITY_PROVIDERS,
);
const VALIDATION_STATES = new Set<IdentityProviderValidationState>([
  "unvalidated",
  "active",
  "validation_failed",
]);
const CONFIGURATION_STATES = new Set<GameConfigurationState>([
  "draft",
  "configured",
]);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const OFFICIAL_ENDPOINTS: Readonly<Record<IdentityProvider, Readonly<{
  hostname: string;
  pathname: string;
}>>> = Object.freeze({
  wechat: Object.freeze({
    hostname: "api.weixin.qq.com",
    pathname: "/sns/jscode2session",
  }),
  douyin: Object.freeze({
    hostname: "minigame.zijieapi.com",
    pathname: "/mgplatform/api/apps/jscode2session",
  }),
});

const SELECT_INTEGRATION = `
  SELECT g.game_id, g.configuration_state,
         i.session_ttl_seconds, i.login_rate_capacity,
         i.login_rate_refill_per_second, i.admin_rate_capacity,
         i.admin_rate_refill_per_second, i.revision,
         i.created_at, i.updated_at
    FROM games AS g
    JOIN game_integrations AS i ON i.game_id = g.game_id`;

const SELECT_PROVIDERS = `
  SELECT game_id, provider, enabled, app_id,
         (app_secret IS NOT NULL) AS secret_configured,
         secret_version, secret_updated_at, endpoint, timeout_ms,
         breaker_threshold, breaker_open_ms, validation_state,
         validation_failed_at, validation_error_code,
         updated_by, updated_at
    FROM game_identity_providers`;

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

function inputInteger(
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

function rowInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > maximum
  ) {
    throw new Error(`${label} 数据无效`);
  }
  return number;
}

function inputPositiveNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) {
    return invalidPayload();
  }
  return number;
}

function rowPositiveNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) {
    throw new Error(`${label} 数据无效`);
  }
  return number;
}

function normalizedProvider(value: unknown): IdentityProvider {
  if (
    typeof value !== "string"
    || !IDENTITY_PROVIDER_SET.has(value as IdentityProvider)
  ) {
    return invalidPayload();
  }
  return value as IdentityProvider;
}

function normalizedAppId(value: unknown): string | null {
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

function normalizedEndpoint(
  raw: unknown,
  provider: IdentityProvider,
  production: boolean,
): string {
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
  if (
    parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
  ) {
    return invalidPayload();
  }
  const official = OFFICIAL_ENDPOINTS[provider];
  if (
    parsed.protocol === "https:"
    && parsed.hostname === official.hostname
    && parsed.port === ""
    && parsed.pathname === official.pathname
  ) {
    return `https://${official.hostname}${official.pathname}`;
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

function sharedInput(
  input: UpdateGameIntegrationRequest,
): UpdateGameIntegrationRequest {
  if (!input || typeof input !== "object") {
    return invalidPayload();
  }
  return Object.freeze({
    sessionTtlSeconds: inputInteger(
      input.sessionTtlSeconds,
      60,
      31_536_000,
    ),
    loginRateCapacity: inputPositiveNumber(input.loginRateCapacity),
    loginRateRefillPerSecond: inputPositiveNumber(
      input.loginRateRefillPerSecond,
    ),
    adminRateCapacity: inputPositiveNumber(input.adminRateCapacity),
    adminRateRefillPerSecond: inputPositiveNumber(
      input.adminRateRefillPerSecond,
    ),
    revision: inputInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
  });
}

function providerInput(
  input: UpdateIdentityProviderRequest,
  provider: IdentityProvider,
  production: boolean,
): UpdateIdentityProviderRequest {
  if (!input || typeof input !== "object" || typeof input.enabled !== "boolean") {
    return invalidPayload();
  }
  const appId = normalizedAppId(input.appId);
  if (appId === "local") {
    return invalidPayload();
  }
  return Object.freeze({
    enabled: input.enabled,
    appId,
    endpoint: normalizedEndpoint(input.endpoint, provider, production),
    timeoutMs: inputInteger(input.timeoutMs, 100, 30_000),
    breakerThreshold: inputInteger(input.breakerThreshold, 1, 1_000),
    breakerOpenMs: inputInteger(input.breakerOpenMs, 100, 600_000),
    revision: inputInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
  });
}

function secretInput(
  input: ReplaceIdentityProviderSecretRequest,
): ReplaceIdentityProviderSecretRequest {
  if (
    !input
    || typeof input !== "object"
    || typeof input.appSecret !== "string"
    || input.appSecret.length < 1
    || input.appSecret.length > 512
    || typeof input.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(input.operationId)
  ) {
    return invalidPayload();
  }
  return Object.freeze({
    appSecret: input.appSecret,
    revision: inputInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
    operationId: input.operationId,
  });
}

function clearInput(
  input: ClearIdentityProviderSecretRequest,
): ClearIdentityProviderSecretRequest {
  if (
    !input
    || typeof input !== "object"
    || typeof input.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(input.operationId)
  ) {
    return invalidPayload();
  }
  return Object.freeze({
    revision: inputInteger(input.revision, 1, Number.MAX_SAFE_INTEGER),
    operationId: input.operationId,
  });
}

function secretMetadataFromRow(
  row: ProviderRow,
): IdentityProviderSecretMetadata {
  const configured = Number(row.secret_configured) === 1;
  const version = rowInteger(
    row.secret_version,
    0,
    Number.MAX_SAFE_INTEGER,
    "Provider Secret 版本",
  );
  if (configured !== (version > 0)) {
    throw new Error("Provider Secret 配置状态数据无效");
  }
  if (configured !== (row.secret_updated_at !== null)) {
    throw new Error("Provider Secret 更新时间数据无效");
  }
  return Object.freeze({
    configured,
    version,
    updatedAt: row.secret_updated_at === null
      ? null
      : isoDate(row.secret_updated_at),
  });
}

function secretMutationDigest(
  gameId: string,
  provider: IdentityProvider,
  mutation: SecretMutation,
): Buffer {
  const digest = createHash("sha256");
  digest.update(mutation.kind, "ascii");
  digest.update("\0", "ascii");
  digest.update(gameId, "ascii");
  digest.update("\0", "ascii");
  digest.update(provider, "ascii");
  digest.update("\0", "ascii");
  digest.update(String(mutation.input.revision), "ascii");
  if (mutation.kind === "replace") {
    digest.update("\0", "ascii");
    digest.update(mutation.input.appSecret, "utf8");
  }
  return digest.digest();
}

function providerFromRow(row: ProviderRow): IdentityProviderConfiguration {
  const provider = String(row.provider);
  if (!IDENTITY_PROVIDER_SET.has(provider as IdentityProvider)) {
    throw new Error("身份 Provider 数据无效");
  }
  const validationState = String(row.validation_state);
  if (
    !VALIDATION_STATES.has(
      validationState as IdentityProviderValidationState,
    )
  ) {
    throw new Error("Provider 验证状态数据无效");
  }
  const validationFailedAt = optionalIsoDate(row.validation_failed_at);
  const validationErrorCode = row.validation_error_code === null
    ? null
    : String(row.validation_error_code);
  const validFailureMetadata = validationState === "validation_failed"
    ? validationFailedAt !== null && validationErrorCode !== null
    : validationFailedAt === null && validationErrorCode === null;
  if (!validFailureMetadata) {
    throw new Error("Provider 验证失败元数据不一致");
  }
  const enabledValue = Number(row.enabled);
  if (enabledValue !== 0 && enabledValue !== 1) {
    throw new Error("Provider 启用状态数据无效");
  }
  return Object.freeze({
    provider: provider as IdentityProvider,
    enabled: enabledValue === 1,
    appId: row.app_id === null ? null : String(row.app_id),
    secretMetadata: secretMetadataFromRow(row),
    endpoint: String(row.endpoint),
    timeoutMs: rowInteger(row.timeout_ms, 100, 30_000, "Provider 超时"),
    breakerThreshold: rowInteger(
      row.breaker_threshold,
      1,
      1_000,
      "Provider 熔断阈值",
    ),
    breakerOpenMs: rowInteger(
      row.breaker_open_ms,
      100,
      600_000,
      "Provider 熔断时长",
    ),
    validationState:
      validationState as IdentityProviderValidationState,
    validationFailedAt,
    validationErrorCode,
    updatedBy: row.updated_by === null ? null : String(row.updated_by),
    updatedAt: isoDate(row.updated_at),
  });
}

function integrationFromRows(
  row: IntegrationRow,
  providerRows: readonly ProviderRow[],
  loadedRevision: number | null,
): GameIntegration {
  const configurationState = String(row.configuration_state);
  if (!CONFIGURATION_STATES.has(configurationState as GameConfigurationState)) {
    throw new Error("游戏配置状态数据无效");
  }
  const providers = providerRows.map(providerFromRow);
  if (
    providers.length !== IDENTITY_PROVIDERS.length
    || providers.some(
      (provider, index) => provider.provider !== IDENTITY_PROVIDERS[index],
    )
  ) {
    throw new Error("游戏身份 Provider 白名单数据不完整");
  }
  return Object.freeze({
    gameId: String(row.game_id),
    configurationState: configurationState as GameConfigurationState,
    providers,
    sessionTtlSeconds: rowInteger(
      row.session_ttl_seconds,
      60,
      31_536_000,
      "Session TTL",
    ),
    loginRateCapacity: rowPositiveNumber(
      row.login_rate_capacity,
      "登录限流容量",
    ),
    loginRateRefillPerSecond: rowPositiveNumber(
      row.login_rate_refill_per_second,
      "登录限流补充速率",
    ),
    adminRateCapacity: rowPositiveNumber(
      row.admin_rate_capacity,
      "管理限流容量",
    ),
    adminRateRefillPerSecond: rowPositiveNumber(
      row.admin_rate_refill_per_second,
      "管理限流补充速率",
    ),
    revision: rowInteger(
      row.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "接入配置 revision",
    ),
    loadedRevision,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  });
}

function providerConfiguration(
  integration: GameIntegration,
  provider: IdentityProvider,
): IdentityProviderConfiguration {
  const configuration = integration.providers.find(
    (candidate) => candidate.provider === provider,
  );
  if (!configuration) {
    throw new Error("游戏身份 Provider 白名单数据不完整");
  }
  return configuration;
}

function providerConfigurationAction(
  currentEnabled: boolean,
  requestedEnabled: boolean,
): ProviderConfigurationAction {
  if (currentEnabled === requestedEnabled) {
    return "identity_provider_update";
  }
  return requestedEnabled
    ? "identity_provider_enable"
    : "identity_provider_disable";
}

export class GameIntegrationService {
  constructor(
    private readonly database: GameIntegrationDatabase,
    private readonly runtime: GameIntegrationRuntime,
    private readonly production: boolean,
    private readonly metrics?: MetricsRegistry,
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

  async updateShared(
    gameId: string,
    input: UpdateGameIntegrationRequest,
    authorization: ConfigurationAuthorization,
  ): Promise<GameIntegration> {
    this.validateGameId(gameId);
    const normalized = sharedInput(input);
    let result: GameIntegration;
    try {
      result = await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "write");
        const current = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        this.requireRevision(current, normalized.revision);
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE game_integrations
              SET session_ttl_seconds = ?,
                  login_rate_capacity = ?,
                  login_rate_refill_per_second = ?,
                  admin_rate_capacity = ?,
                  admin_rate_refill_per_second = ?,
                  revision = revision + 1
            WHERE game_id = ? AND revision = ?`,
          [
            normalized.sessionTtlSeconds,
            normalized.loginRateCapacity,
            normalized.loginRateRefillPerSecond,
            normalized.adminRateCapacity,
            normalized.adminRateRefillPerSecond,
            gameId,
            normalized.revision,
          ],
        );
        this.requireSingleUpdate(updated);
        const integration = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        await this.insertGameAudit(
          connection,
          gameId,
          null,
          "integration_update",
          current,
          integration,
          integration.revision,
          authorization,
        );
        return integration;
      });
    } catch (error) {
      await this.auditGameFailure(
        gameId,
        null,
        "integration_update",
        normalized.revision,
        authorization,
        error,
      );
      throw error;
    }
    this.runtime.invalidate(gameId, null);
    return result;
  }

  async updateProvider(
    gameId: string,
    providerValue: IdentityProvider,
    input: UpdateIdentityProviderRequest,
    authorization: ConfigurationAuthorization,
  ): Promise<GameIntegration> {
    this.validateGameId(gameId);
    const provider = normalizedProvider(providerValue);
    const normalized = providerInput(input, provider, this.production);
    let result: GameIntegration;
    try {
      result = await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "write");
        const current = await this.requireIntegration(connection, gameId, true);
        this.requireRevision(current, normalized.revision);
        const currentProvider = providerConfiguration(current, provider);
        const providerAction = providerConfigurationAction(
          currentProvider.enabled,
          normalized.enabled,
        );
        if (
          normalized.enabled
          && (
            normalized.appId === null
            || !currentProvider.secretMetadata.configured
          )
        ) {
          invalidPayload();
        }
        if (normalized.appId !== currentProvider.appId) {
          await this.requireAppIdMutable(connection, gameId, provider);
        }
        const [updatedProvider] = await connection.execute<ResultSetHeader>(
          `UPDATE game_identity_providers
              SET enabled = ?,
                  app_id = ?,
                  endpoint = ?,
                  timeout_ms = ?,
                  breaker_threshold = ?,
                  breaker_open_ms = ?,
                  validation_state = 'unvalidated',
                  validation_failed_at = NULL,
                  validation_error_code = NULL,
                  updated_by = ?,
                  updated_at = NOW(3)
            WHERE game_id = ? AND provider = ?`,
          [
            normalized.enabled ? 1 : 0,
            normalized.appId,
            normalized.endpoint,
            normalized.timeoutMs,
            normalized.breakerThreshold,
            normalized.breakerOpenMs,
            authorization.operatorId,
            gameId,
            provider,
          ],
        );
        if (updatedProvider.affectedRows > 1) {
          throw new Error("Provider 配置更新影响了异常数量的记录");
        }
        await this.bumpRevision(
          connection,
          gameId,
          normalized.revision,
        );
        await this.reconcileConfigurationState(connection, gameId);
        const integration = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        await this.insertGameAudit(
          connection,
          gameId,
          provider,
          providerAction,
          currentProvider,
          providerConfiguration(integration, provider),
          integration.revision,
          authorization,
        );
        return integration;
      });
    } catch (error) {
      await this.auditGameFailure(
        gameId,
        provider,
        "identity_provider_update",
        normalized.revision,
        authorization,
        error,
        normalized.enabled,
      );
      throw error;
    }
    this.runtime.invalidate(gameId, provider);
    return result;
  }

  async replaceProviderSecret(
    gameId: string,
    providerValue: IdentityProvider,
    input: ReplaceIdentityProviderSecretRequest,
    authorization: ConfigurationAuthorization,
  ): Promise<IdentityProviderSecretWriteResponse> {
    this.validateGameId(gameId);
    const provider = normalizedProvider(providerValue);
    const normalized = secretInput(input);
    return this.mutateSecret(
      gameId,
      provider,
      { kind: "replace", input: normalized },
      authorization,
    );
  }

  async clearProviderSecret(
    gameId: string,
    providerValue: IdentityProvider,
    input: ClearIdentityProviderSecretRequest,
    authorization: ConfigurationAuthorization,
  ): Promise<IdentityProviderSecretWriteResponse> {
    this.validateGameId(gameId);
    const provider = normalizedProvider(providerValue);
    const normalized = clearInput(input);
    return this.mutateSecret(
      gameId,
      provider,
      { kind: "clear", input: normalized },
      authorization,
    );
  }

  private async mutateSecret(
    gameId: string,
    provider: IdentityProvider,
    mutation: SecretMutation,
    authorization: ConfigurationAuthorization,
  ): Promise<IdentityProviderSecretWriteResponse> {
    const operationId = mutation.input.operationId;
    const requestDigest = secretMutationDigest(gameId, provider, mutation);
    let replay: IdentityProviderSecretWriteResponse | null;
    try {
      replay = await this.findReplay(
        gameId,
        provider,
        operationId,
        mutation,
        authorization,
      );
    } catch (error) {
      await this.auditSecretFailure(
        gameId,
        provider,
        mutation,
        authorization,
        error,
      );
      throw error;
    }
    if (replay) {
      return replay;
    }

    try {
      const result = await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "secret");
        const current = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        this.requireRevision(current, mutation.input.revision);
        const currentProvider = providerConfiguration(current, provider);
        const oldVersion = currentProvider.secretMetadata.version;
        let action: ProviderSecretAction;
        let newVersion: number | null;

        if (mutation.kind === "replace") {
          action = oldVersion === 0 ? "set" : "rotate";
          newVersion = oldVersion + 1;
          if (!Number.isSafeInteger(newVersion)) {
            throw new Error("Provider Secret 版本已超出安全整数范围");
          }
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE game_identity_providers
                SET app_secret = ?,
                    secret_version = ?,
                    secret_updated_at = NOW(3),
                    validation_state = 'unvalidated',
                    validation_failed_at = NULL,
                    validation_error_code = NULL,
                    updated_by = ?,
                    updated_at = NOW(3)
              WHERE game_id = ? AND provider = ?`,
            [
              mutation.input.appSecret,
              newVersion,
              authorization.operatorId,
              gameId,
              provider,
            ],
          );
          this.requireSingleUpdate(updated);
        } else {
          if (!currentProvider.secretMetadata.configured || oldVersion < 1) {
            throw new GameManageKitError(409, "OPERATION_CONFLICT");
          }
          action = "clear";
          newVersion = null;
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE game_identity_providers
                SET enabled = 0,
                    app_secret = NULL,
                    secret_version = 0,
                    secret_updated_at = NULL,
                    validation_state = 'unvalidated',
                    validation_failed_at = NULL,
                    validation_error_code = NULL,
                    updated_by = ?,
                    updated_at = NOW(3)
              WHERE game_id = ? AND provider = ?`,
            [authorization.operatorId, gameId, provider],
          );
          this.requireSingleUpdate(updated);
        }

        await this.bumpRevision(
          connection,
          gameId,
          mutation.input.revision,
        );
        await this.reconcileConfigurationState(connection, gameId);
        const integration = await this.requireIntegration(
          connection,
          gameId,
          true,
        );
        const metadata = mutation.kind === "clear"
          ? Object.freeze({
              configured: false,
              version: 0,
              updatedAt: null,
            })
          : providerConfiguration(
              integration,
              provider,
            ).secretMetadata;
        await connection.execute(
          `INSERT INTO admin_secret_operations
             (operation_id, operator_id, game_id, provider, identity_id,
              secret_kind, action, old_version, new_version, revision,
              request_digest, result_configuration_state, result_revision,
              result_secret_updated_at)
           VALUES (?, ?, ?, ?, NULL, 'identity_provider_secret',
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            authorization.operatorId,
            gameId,
            provider,
            action,
            oldVersion === 0 ? null : oldVersion,
            newVersion,
            mutation.input.revision,
            requestDigest,
            integration.configurationState,
            integration.revision,
            metadata.updatedAt === null ? null : new Date(metadata.updatedAt),
          ],
        );
        await this.insertSecretAudit(
          connection,
          gameId,
          provider,
          action,
          oldVersion === 0 ? null : oldVersion,
          newVersion,
          "succeeded",
          null,
          authorization,
          operationId,
          integration.revision,
        );
        return this.secretWriteResult(
          integration,
          provider,
          false,
          metadata,
        );
      });
      this.runtime.invalidate(gameId, provider);
      return result;
    } catch (error) {
      if (isDuplicate(error) || isConflict(error)) {
        try {
          const replayed = await this.findReplay(
            gameId,
            provider,
            operationId,
            mutation,
            authorization,
          );
          if (replayed) {
            return replayed;
          }
        } catch (replayError) {
          await this.auditSecretFailure(
            gameId,
            provider,
            mutation,
            authorization,
            replayError,
          );
          throw replayError;
        }
      }
      await this.auditSecretFailure(
        gameId,
        provider,
        mutation,
        authorization,
        error,
      );
      throw error;
    }
  }

  private validateGameId(gameId: string): void {
    if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) {
      invalidPayload();
    }
  }

  private requireRevision(
    current: GameIntegration,
    revision: number,
  ): void {
    if (current.revision !== revision) {
      throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
    }
  }

  private requireSingleUpdate(result: ResultSetHeader): void {
    if (result.affectedRows !== 1) {
      throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
    }
  }

  private async bumpRevision(
    connection: PoolConnection,
    gameId: string,
    revision: number,
  ): Promise<void> {
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE game_integrations
          SET revision = revision + 1
        WHERE game_id = ? AND revision = ?`,
      [gameId, revision],
    );
    this.requireSingleUpdate(updated);
  }

  private async requireIntegration(
    connection: PoolConnection,
    gameId: string,
    lock: boolean,
  ): Promise<GameIntegration> {
    const lockClause = lock ? " FOR UPDATE" : "";
    const [rows] = await connection.query<IntegrationRow[]>(
      `${SELECT_INTEGRATION}
        WHERE g.game_id = ?${lockClause}`,
      [gameId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    const [providerRows] = await connection.query<ProviderRow[]>(
      `${SELECT_PROVIDERS}
        WHERE game_id = ?
        ORDER BY FIELD(provider, 'wechat', 'douyin')${lockClause}`,
      [gameId],
    );
    return integrationFromRows(
      row,
      providerRows,
      this.runtime.loadedRevision(gameId)?.integration ?? null,
    );
  }

  private async requireAppIdMutable(
    connection: PoolConnection,
    gameId: string,
    provider: IdentityProvider,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT id
         FROM account_identities
        WHERE game_id = ? AND provider = ?
        LIMIT 1
        FOR SHARE`,
      [gameId, provider],
    );
    if (rows[0]) {
      throw new GameManageKitError(
        409,
        "IDENTITY_PROVIDER_CONFLICT",
      );
    }
  }

  private async reconcileConfigurationState(
    connection: PoolConnection,
    gameId: string,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT g.configuration_state,
              EXISTS (
                SELECT 1
                  FROM game_identity_providers AS provider
                 WHERE provider.game_id = g.game_id
                   AND provider.enabled = 1
                   AND provider.app_id IS NOT NULL
                   AND provider.app_secret IS NOT NULL
              ) AS provider_configured
         FROM games AS g
        WHERE g.game_id = ?
        FOR UPDATE`,
      [gameId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    const nextState: GameConfigurationState =
      Number(row.provider_configured) === 1 ? "configured" : "draft";
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
      return;
    }
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

  private async insertGameAudit(
    connection: PoolConnection,
    gameId: string,
    provider: IdentityProvider | null,
    action: "integration_update" | ProviderConfigurationAction,
    before: GameIntegration | IdentityProviderConfiguration,
    after: GameIntegration | IdentityProviderConfiguration,
    revision: number,
    authorization: ConfigurationAuthorization,
  ): Promise<void> {
    try {
      await connection.execute(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, provider, revision, request_id,
            action, result, before_data, after_data, ip)
         VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, INET6_ATON(?))`,
        [
          gameId,
          authorization.operatorId,
          provider,
          revision,
          authorization.requestId,
          action,
          JSON.stringify(before),
          JSON.stringify(after),
          normalizeIp(authorization.ip),
        ],
      );
    } catch (error) {
      this.metrics?.recordAuditWriteFailure(gameId, "admin");
      throw error;
    }
  }

  private async auditGameFailure(
    gameId: string,
    provider: IdentityProvider | null,
    action: "integration_update" | ProviderConfigurationAction,
    revision: number,
    authorization: ConfigurationAuthorization,
    error: unknown,
    requestedProviderEnabled: boolean | null = null,
  ): Promise<void> {
    const errorCode = error instanceof GameManageKitError
      ? error.code
      : "INTERNAL";
    await this.database.transaction(async (connection) => {
      let recordedAction = action;
      if (provider !== null && requestedProviderEnabled !== null) {
        const current = await this.requireIntegration(connection, gameId, false);
        recordedAction = providerConfigurationAction(
          providerConfiguration(current, provider).enabled,
          requestedProviderEnabled,
        );
      }
      await connection.execute(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, provider, revision, request_id,
            action, result, before_data, after_data, ip)
         VALUES (?, ?, ?, ?, ?, ?, 'failed', NULL, ?, INET6_ATON(?))`,
        [
          gameId,
          authorization.operatorId,
          provider,
          revision,
          authorization.requestId,
          recordedAction,
          JSON.stringify({ errorCode }),
          normalizeIp(authorization.ip),
        ],
      );
    }).catch(() => {
      this.metrics?.recordAuditWriteFailure(gameId, "admin");
    });
  }

  private async insertSecretAudit(
    connection: PoolConnection,
    gameId: string,
    provider: IdentityProvider,
    action: ProviderSecretAction,
    oldVersion: number | null,
    newVersion: number | null,
    result: "succeeded" | "failed",
    reason: string | null,
    authorization: ConfigurationAuthorization,
    operationId: string,
    revision: number,
  ): Promise<void> {
    try {
      await connection.execute(
        `INSERT INTO admin_secret_audit
           (operator_id, game_id, provider, identity_id,
            secret_kind, action, old_version, new_version,
            result, reason, request_id, operation_id, revision, ip)
         VALUES (?, ?, ?, NULL, 'identity_provider_secret', ?,
                 ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?))`,
        [
          authorization.operatorId,
          gameId,
          provider,
          action,
          oldVersion,
          newVersion,
          result,
          reason,
          authorization.requestId,
          operationId,
          revision,
          normalizeIp(authorization.ip),
        ],
      );
    } catch (error) {
      this.metrics?.recordAuditWriteFailure(gameId, "admin");
      throw error;
    }
  }

  private secretWriteResult(
    integration: GameIntegration,
    provider: IdentityProvider,
    replayed: boolean,
    metadata: IdentityProviderSecretMetadata,
  ): IdentityProviderSecretWriteResponse {
    return Object.freeze({
      gameId: integration.gameId,
      provider,
      configurationState: integration.configurationState,
      secretMetadata: metadata,
      revision: integration.revision,
      loadedRevision: integration.loadedRevision,
      replayed,
    });
  }

  private async findReplay(
    gameId: string,
    provider: IdentityProvider,
    operationId: string,
    mutation: SecretMutation,
    authorization: ConfigurationAuthorization,
  ): Promise<IdentityProviderSecretWriteResponse | null> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "secret");
      const [rows] = await connection.query<SecretOperationRow[]>(
        `SELECT operation_id, operator_id, game_id, provider,
                identity_id, secret_kind, action,
                old_version, new_version, revision, request_digest,
                result_configuration_state, result_revision,
                result_secret_updated_at, created_at
           FROM admin_secret_operations
          WHERE operation_id = ?
          FOR SHARE`,
        [operationId],
      );
      const operation = rows[0];
      if (!operation) {
        return null;
      }
      const actionMatches = mutation.kind === "replace"
        ? operation.action === "set" || operation.action === "rotate"
        : operation.action === "clear";
      if (
        operation.operator_id !== authorization.operatorId
        || operation.game_id !== gameId
        || operation.provider !== provider
        || operation.identity_id !== null
        || operation.secret_kind !== "identity_provider_secret"
        || !actionMatches
      ) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      if (
        operation.revision === null
        || rowInteger(
          operation.revision,
          1,
          Number.MAX_SAFE_INTEGER,
          "Provider Secret 操作 revision",
        ) !== mutation.input.revision
      ) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      const expectedDigest = secretMutationDigest(gameId, provider, mutation);
      if (
        !(operation.request_digest instanceof Uint8Array)
        || operation.request_digest.byteLength !== expectedDigest.byteLength
        || !timingSafeEqual(operation.request_digest, expectedDigest)
      ) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      const configurationState = operation.result_configuration_state;
      if (
        configurationState === null
        || !CONFIGURATION_STATES.has(
          configurationState as GameConfigurationState,
        )
        || operation.result_revision === null
      ) {
        throw new Error("Provider Secret 操作结果数据无效");
      }
      const resultRevision = rowInteger(
        operation.result_revision,
        1,
        Number.MAX_SAFE_INTEGER,
        "Provider Secret 结果 revision",
      );
      let metadata: IdentityProviderSecretMetadata;
      if (mutation.kind === "clear") {
        if (
          operation.old_version === null
          || operation.new_version !== null
          || operation.result_secret_updated_at !== null
        ) {
          throw new Error("清除 Provider Secret 操作版本数据无效");
        }
        rowInteger(
          operation.old_version,
          1,
          Number.MAX_SAFE_INTEGER,
          "Provider Secret 旧版本",
        );
        metadata = Object.freeze({
          configured: false,
          version: 0,
          updatedAt: null,
        });
      } else {
        if (
          operation.new_version === null
          || operation.result_secret_updated_at === null
        ) {
          throw new Error("替换 Provider Secret 操作版本数据无效");
        }
        metadata = Object.freeze({
          configured: true,
          version: rowInteger(
            operation.new_version,
            1,
            Number.MAX_SAFE_INTEGER,
            "Provider Secret 新版本",
          ),
          updatedAt: isoDate(operation.result_secret_updated_at),
        });
      }
      return Object.freeze({
        gameId,
        provider,
        configurationState:
          configurationState as GameConfigurationState,
        secretMetadata: metadata,
        revision: resultRevision,
        loadedRevision:
          this.runtime.loadedRevision(gameId)?.integration ?? null,
        replayed: true,
      });
    });
  }

  private async auditSecretFailure(
    gameId: string,
    provider: IdentityProvider,
    mutation: SecretMutation,
    authorization: ConfigurationAuthorization,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof GameManageKitError
      ? error.code
      : "INTERNAL";
    let auditAttempted = false;
    await this.database.transaction(async (connection) => {
      const [games] = await connection.query<RowDataPacket[]>(
        `SELECT g.game_id, p.secret_version,
                (p.app_secret IS NOT NULL) AS secret_configured
           FROM games AS g
           LEFT JOIN game_identity_providers AS p
             ON p.game_id = g.game_id AND p.provider = ?
          WHERE g.game_id = ?
          FOR SHARE`,
        [provider, gameId],
      );
      const current = games[0];
      if (!current) {
        return;
      }
      const rawVersion = Number(current.secret_version ?? 0);
      const oldVersion = Number.isSafeInteger(rawVersion) && rawVersion > 0
        ? rawVersion
        : null;
      const action: ProviderSecretAction = mutation.kind === "clear"
        ? "clear"
        : Number(current.secret_configured) === 1 && oldVersion !== null
          ? "rotate"
          : "set";
      auditAttempted = true;
      await this.insertSecretAudit(
        connection,
        gameId,
        provider,
        action,
        oldVersion,
        null,
        "failed",
        reason,
        authorization,
        mutation.input.operationId,
        mutation.input.revision,
      );
    }).catch(() => {
      if (!auditAttempted) {
        this.metrics?.recordAuditWriteFailure(gameId, "admin");
      }
    });
  }
}
