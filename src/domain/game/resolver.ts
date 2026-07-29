import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { AreaServer } from "@gono/game-manage-kit-contract";
import { GameManageKitError } from "../../errors.js";
import type {
  AuthExchangeResult,
  ExternalAuthProvider,
  IdentityProviderClient,
  ProviderFailureReason,
} from "../account/auth-provider.js";
import {
  MysqlDirectoryProvider,
  type DirectoryProvider,
} from "../directory/service.js";
import {
  TokenBucketLimiter,
} from "../../infra/security/security.js";
import {
  DouyinClient,
  type DouyinIdentityClient,
} from "../../infra/douyin/client.js";
import {
  WechatClient,
  type WechatIdentityClient,
} from "../../infra/wechat/client.js";

export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type GameStatus = "enabled" | "maintenance" | "disabled";
export type GameConfigurationState = "draft" | "configured";

export interface RateLimitPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface LoadedGameRevision {
  readonly game: number;
  readonly integration: number;
  readonly directory: number;
}

export interface GameContext {
  readonly gameId: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly configurationState: GameConfigurationState;
  readonly directory: DirectoryProvider;
  readonly wechat: WechatIdentityClient;
  readonly douyin: DouyinIdentityClient;
  readonly sessionTtlSeconds: number;
  readonly loginRate: RateLimitPolicy;
  readonly adminRate: RateLimitPolicy;
  readonly loginLimiter: TokenBucketLimiter;
  readonly adminLimiter: TokenBucketLimiter;
  readonly revision: LoadedGameRevision;
}

export interface ServiceIdentity {
  readonly serviceId: string;
  readonly gameIds: readonly string[];
}

export interface AdminIdentity {
  readonly operatorId: string;
  readonly gameIds: readonly string[];
}

type MaybePromise<T> = T | Promise<T>;

/** Database-backed runtime boundary shared by the HTTP and domain layers. */
export interface GameRuntimeRegistry {
  initialize?(): Promise<void>;
  ready(): MaybePromise<boolean>;
  list(): readonly GameContext[];
  get(gameId: string): GameContext | undefined;
  resolve(gameId: string): MaybePromise<GameContext>;
  requireServer(
    game: GameContext | string,
    serverId: number,
  ): Promise<AreaServer>;
  authenticateService(
    serviceId: string,
    secret: string | null | undefined,
  ): MaybePromise<ServiceIdentity | null>;
  authenticateAdmin(
    operatorId: string,
    secret: string | null | undefined,
  ): MaybePromise<AdminIdentity | null>;
  canAccess(
    identity: ServiceIdentity | AdminIdentity,
    gameId: string,
  ): boolean;
  invalidate?(
    gameId: string,
    provider?: ExternalAuthProvider,
  ): void;
  loadedRevision?(gameId: string): LoadedGameRevision | null;
}

export interface GameConfigResolverOptions {
  readonly production: boolean;
  readonly cacheTtlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onGameLoaded?: (gameId: string) => void;
}

interface GameConfigurationRow extends RowDataPacket {
  readonly game_id: string;
  readonly name: string;
  readonly status: string;
  readonly configuration_state: string;
  readonly game_revision: number | string;
  readonly session_ttl_seconds: number | string | null;
  readonly login_rate_capacity: number | string | null;
  readonly login_rate_refill_per_second: number | string | null;
  readonly admin_rate_capacity: number | string | null;
  readonly admin_rate_refill_per_second: number | string | null;
  readonly integration_revision: number | string | null;
  readonly directory_revision: number | string | null;
}

interface ProviderConfigurationRow extends RowDataPacket {
  readonly integration_revision: number | string;
  readonly provider: string | null;
  readonly enabled: number | boolean | string | null;
  readonly app_id: string | null;
  readonly app_secret: string | null;
  readonly secret_version: number | string | null;
  readonly endpoint: string | null;
  readonly timeout_ms: number | string | null;
  readonly breaker_threshold: number | string | null;
  readonly breaker_open_ms: number | string | null;
  readonly validation_state: string | null;
}

interface MachineAuthenticationRow extends RowDataPacket {
  readonly identity_id: string;
  readonly game_id: string | null;
  readonly version: number | string;
  readonly secret_digest: Buffer | string;
  readonly usable: number | boolean | string;
}

interface CachedGame {
  readonly context: GameContext;
  expiresAtMs: number;
}

type ProviderAvailability =
  | "ready"
  | "unavailable"
  | "invalid_credentials";

interface CachedProvider {
  integrationRevision: number;
  readonly secretVersion: number;
  readonly configurationKey: string;
  readonly client: IdentityProviderClient | null;
  availability: ProviderAvailability;
  validationState: "unvalidated" | "active" | "validation_failed";
  expiresAtMs: number;
}

const DEFAULT_CACHE_TTL_MS = 2_000;
const GAME_STATUSES = new Set<GameStatus>([
  "enabled",
  "maintenance",
  "disabled",
]);
const CONFIGURATION_STATES = new Set<GameConfigurationState>([
  "draft",
  "configured",
]);
const MACHINE_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
const PROVIDER_VALIDATION_STATES = new Set([
  "unvalidated",
  "active",
  "validation_failed",
]);
const OFFICIAL_PROVIDER_ENDPOINTS = Object.freeze({
  wechat: "https://api.weixin.qq.com/sns/jscode2session",
  douyin:
    "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
} satisfies Record<ExternalAuthProvider, string>);

const SELECT_GAME_CONFIGURATION = `
  SELECT g.game_id, g.name, g.status, g.configuration_state,
         g.revision AS game_revision,
         i.session_ttl_seconds, i.login_rate_capacity,
         i.login_rate_refill_per_second, i.admin_rate_capacity,
         i.admin_rate_refill_per_second,
         i.revision AS integration_revision,
         d.revision AS directory_revision
    FROM games g
    LEFT JOIN game_integrations i ON i.game_id = g.game_id
    LEFT JOIN game_directory_settings d ON d.game_id = g.game_id`;

function positiveInteger(
  value: number | string | null,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 数据无效`);
  }
  return parsed;
}

function positiveNumber(
  value: number | string | null,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000) {
    throw new Error(`${label} 数据无效`);
  }
  return parsed;
}

function revision(value: number | string | null, label: string): number {
  return positiveInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function endpoint(
  value: string | null,
  provider: ExternalAuthProvider,
  production: boolean,
  label: string,
): string {
  if (!value || value.length > 2_048 || value !== value.trim()) {
    throw new Error(`${label} 数据无效`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 数据无效`);
  }
  if (
    parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
  ) {
    throw new Error(`${label} 数据无效`);
  }
  const officialValue = OFFICIAL_PROVIDER_ENDPOINTS[provider];
  const official = new URL(officialValue);
  if (
    parsed.protocol === official.protocol
    && parsed.hostname === official.hostname
    && parsed.port === ""
    && parsed.pathname === official.pathname
  ) {
    return officialValue;
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  if (
    !production
    && loopback
    && (parsed.protocol === "http:" || parsed.protocol === "https:")
  ) {
    return value;
  }
  throw new Error(`${label} 数据无效`);
}

function asciiValue(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && /^[\x21-\x7e]+$/u.test(value);
}

function providerCacheKey(
  gameId: string,
  provider: ExternalAuthProvider,
): string {
  return `${gameId}\u0000${provider}`;
}

function providerConfigurationKey(
  row: ProviderConfigurationRow,
): string {
  return JSON.stringify([
    Number(row.enabled),
    row.app_id,
    Number(row.secret_version),
    row.endpoint,
    Number(row.timeout_ms),
    Number(row.breaker_threshold),
    Number(row.breaker_open_ms),
  ]);
}

function providerFailure<
  Provider extends ExternalAuthProvider,
>(
  reason: ProviderFailureReason,
  providerVersion?: number,
): AuthExchangeResult<Provider> {
  return providerVersion === undefined
      || !Number.isSafeInteger(providerVersion)
      || providerVersion < 1
    ? { ok: false, reason }
    : { ok: false, reason, providerVersion };
}

function sameRevision(
  left: LoadedGameRevision,
  right: LoadedGameRevision,
): boolean {
  return left.game === right.game
    && left.integration === right.integration
    && left.directory === right.directory;
}

function digestBuffer(value: Buffer | string): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value.length === 32 ? value : null;
  }
  if (/^[0-9a-f]{64}$/iu.test(value)) {
    return Buffer.from(value, "hex");
  }
  return null;
}

function requestSecretDigest(
  secret: string | null | undefined,
): Buffer | null {
  if (
    typeof secret !== "string"
    || secret.length < 16
    || secret.length > 512
  ) {
    return null;
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function assertPublicGame(context: GameContext): GameContext {
  if (context.configurationState !== "configured") {
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  }
  if (context.status === "disabled") {
    throw new GameManageKitError(403, "GAME_DISABLED");
  }
  if (context.status === "maintenance") {
    throw new GameManageKitError(503, "GAME_DISABLED");
  }
  return context;
}

class LazyProviderClient<
  Provider extends ExternalAuthProvider,
> implements IdentityProviderClient<Provider> {
  constructor(
    private readonly resolver: GameConfigResolver,
    private readonly gameId: string,
    private readonly integrationRevision: number,
    readonly provider: Provider,
  ) {}

  exchange(code: string): Promise<AuthExchangeResult<Provider>> {
    return this.resolver.exchangeProvider(
      this.gameId,
      this.provider,
      this.integrationRevision,
      code,
    );
  }
}

export class GameConfigResolver implements GameRuntimeRegistry {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly games = new Map<string, CachedGame>();
  private readonly refreshes = new Map<string, Promise<GameContext>>();
  private readonly providerClients = new Map<string, CachedProvider>();
  private readonly providerRefreshes = new Map<
    string,
    Promise<CachedProvider | null>
  >();
  private readonly generations = new Map<string, number>();
  private initialized = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: GameConfigResolverOptions,
  ) {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (
      !Number.isSafeInteger(cacheTtlMs)
      || cacheTtlMs < 100
      || cacheTtlMs > 60_000
    ) {
      throw new TypeError("游戏配置缓存 TTL 必须是 100..60000ms 的整数");
    }
    this.cacheTtlMs = cacheTtlMs;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT game_id
         FROM games
        WHERE configuration_state = 'configured'
        ORDER BY game_id`,
    );
    await Promise.all(rows.map(async (row) => {
      const gameId = String(row.game_id);
      if (!GAME_ID_PATTERN.test(gameId)) {
        throw new Error("数据库含非法 gameId");
      }
      await this.refresh(gameId, false);
    }));
    this.initialized = true;
  }

  ready(): boolean {
    return this.initialized;
  }

  list(): readonly GameContext[] {
    return [...this.games.values()].map(({ context }) => context);
  }

  get(gameId: string): GameContext | undefined {
    return this.games.get(gameId)?.context;
  }

  async resolve(gameId: string): Promise<GameContext> {
    if (!GAME_ID_PATTERN.test(gameId)) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    const cached = this.games.get(gameId);
    if (cached && this.now() < cached.expiresAtMs) {
      return assertPublicGame(cached.context);
    }
    return assertPublicGame(await this.refresh(gameId, true));
  }

  invalidate(
    gameId: string,
    provider?: ExternalAuthProvider | null,
  ): void {
    this.generations.set(
      gameId,
      (this.generations.get(gameId) ?? 0) + 1,
    );
    const cached = this.games.get(gameId);
    if (cached) {
      cached.expiresAtMs = 0;
    }
    if (provider === null) {
      return;
    }
    if (provider) {
      this.providerClients.delete(providerCacheKey(gameId, provider));
    } else {
      this.clearProviderClients(gameId);
    }
  }

  loadedRevision(gameId: string): LoadedGameRevision | null {
    const loaded = this.games.get(gameId)?.context.revision;
    return loaded ? { ...loaded } : null;
  }

  async requireServer(
    game: GameContext | string,
    serverId: number,
  ): Promise<AreaServer> {
    const context = typeof game === "string"
      ? await this.resolve(game)
      : assertPublicGame(game);
    const admission = await context.directory.serverAdmission(serverId);
    if (!admission.server) {
      throw new GameManageKitError(404, "SERVER_NOT_FOUND");
    }
    if (!admission.usable) {
      throw new GameManageKitError(403, "SERVER_DISABLED");
    }
    return admission.server;
  }

  async authenticateService(
    serviceId: string,
    secret: string | null | undefined,
  ): Promise<ServiceIdentity | null> {
    const authenticated = await this.authenticateMachine(
      "service",
      serviceId,
      secret,
    );
    return authenticated
      ? Object.freeze({
          serviceId: authenticated.identityId,
          gameIds: authenticated.gameIds,
        })
      : null;
  }

  async authenticateAdmin(
    operatorId: string,
    secret: string | null | undefined,
  ): Promise<AdminIdentity | null> {
    const authenticated = await this.authenticateMachine(
      "machine_admin",
      operatorId,
      secret,
    );
    return authenticated
      ? Object.freeze({
          operatorId: authenticated.identityId,
          gameIds: authenticated.gameIds,
        })
      : null;
  }

  canAccess(
    identity: ServiceIdentity | AdminIdentity,
    gameId: string,
  ): boolean {
    return identity.gameIds.includes(gameId);
  }

  async exchangeProvider<
    Provider extends ExternalAuthProvider,
  >(
    gameId: string,
    provider: Provider,
    expectedIntegrationRevision: number,
    code: string,
  ): Promise<AuthExchangeResult<Provider>> {
    const cached = await this.providerClient(
      gameId,
      provider,
      expectedIntegrationRevision,
    ).catch(() => null);
    if (!cached) {
      return providerFailure("unavailable");
    }
    if (cached.availability === "unavailable") {
      return providerFailure("unavailable", cached.secretVersion);
    }
    if (cached.availability === "invalid_credentials") {
      return providerFailure(
        "invalid_credentials",
        cached.secretVersion,
      );
    }
    if (!cached.client) {
      return providerFailure("unavailable", cached.secretVersion);
    }

    let result: AuthExchangeResult<Provider>;
    try {
      result = await (
        cached.client as IdentityProviderClient<Provider>
      ).exchange(code);
    } catch {
      result = providerFailure("unavailable");
    }
    if (result.ok && result.provider !== provider) {
      return providerFailure(
        "invalid_response",
        cached.secretVersion,
      );
    }
    const versionedResult: AuthExchangeResult<Provider> = Object.freeze({
      ...result,
      providerVersion: cached.secretVersion,
    });
    await this.recordProviderValidation(
      gameId,
      provider,
      expectedIntegrationRevision,
      cached,
      versionedResult,
    ).catch(() => undefined);
    return versionedResult;
  }

  private providerClient(
    gameId: string,
    provider: ExternalAuthProvider,
    expectedIntegrationRevision: number,
  ): Promise<CachedProvider | null> {
    const loadedIntegrationRevision =
      this.games.get(gameId)?.context.revision.integration;
    if (
      loadedIntegrationRevision !== undefined
      && loadedIntegrationRevision !== expectedIntegrationRevision
    ) {
      return Promise.resolve(null);
    }
    const key = providerCacheKey(gameId, provider);
    const cached = this.providerClients.get(key);
    if (
      cached
      && cached.integrationRevision === expectedIntegrationRevision
      && this.now() < cached.expiresAtMs
    ) {
      return Promise.resolve(cached);
    }
    const refreshKey = `${key}\u0000${expectedIntegrationRevision}`;
    const inFlight = this.providerRefreshes.get(refreshKey);
    if (inFlight) {
      return inFlight;
    }
    const refresh = this.loadProviderClient(
      gameId,
      provider,
      expectedIntegrationRevision,
      this.generations.get(gameId) ?? 0,
    ).finally(() => {
      if (this.providerRefreshes.get(refreshKey) === refresh) {
        this.providerRefreshes.delete(refreshKey);
      }
    });
    this.providerRefreshes.set(refreshKey, refresh);
    return refresh;
  }

  private async loadProviderClient(
    gameId: string,
    provider: ExternalAuthProvider,
    expectedIntegrationRevision: number,
    generation: number,
  ): Promise<CachedProvider | null> {
    const [rows] = await this.pool.query<ProviderConfigurationRow[]>(
      `SELECT i.revision AS integration_revision,
              p.provider, p.enabled, p.app_id, p.app_secret,
              p.secret_version, p.endpoint, p.timeout_ms,
              p.breaker_threshold, p.breaker_open_ms,
              p.validation_state
         FROM game_integrations AS i
         LEFT JOIN game_identity_providers AS p
           ON p.game_id = i.game_id AND p.provider = ?
        WHERE i.game_id = ?
        LIMIT 1`,
      [provider, gameId],
    );
    if ((this.generations.get(gameId) ?? 0) !== generation) {
      return this.loadProviderClient(
        gameId,
        provider,
        expectedIntegrationRevision,
        this.generations.get(gameId) ?? 0,
      );
    }
    const row = rows[0];
    if (!row) {
      return null;
    }
    const integrationRevision = revision(
      row.integration_revision,
      `${provider} 接入 revision`,
    );
    if (integrationRevision !== expectedIntegrationRevision) {
      this.expireGame(gameId);
      return null;
    }

    const key = providerCacheKey(gameId, provider);
    const existing = this.providerClients.get(key);
    const configurationKey = providerConfigurationKey(row);
    const rawSecretVersion = Number(row.secret_version ?? 0);
    const secretVersion = Number.isSafeInteger(rawSecretVersion)
      && rawSecretVersion >= 0
      ? rawSecretVersion
      : 0;
    const enabled = Number(row.enabled) === 1;
    const appId = row.app_id;
    const secret = row.app_secret;
    const validationState = String(
      row.validation_state ?? "unvalidated",
    );
    const reusableClient = existing?.configurationKey === configurationKey
      ? existing.client
      : null;

    let availability: ProviderAvailability = "unavailable";
    let client: IdentityProviderClient | null = reusableClient;
    let normalizedValidationState:
      CachedProvider["validationState"] = "unvalidated";
    if (
      row.provider === provider
      && PROVIDER_VALIDATION_STATES.has(validationState)
    ) {
      normalizedValidationState =
        validationState as CachedProvider["validationState"];
    }

    if (
      enabled
      && row.provider === provider
      && asciiValue(appId, 128)
      && typeof secret === "string"
      && secret.length > 0
      && secret.length <= 512
      && secretVersion > 0
      && PROVIDER_VALIDATION_STATES.has(validationState)
    ) {
      if (validationState === "validation_failed") {
        availability = "invalid_credentials";
      } else {
        try {
          if (!client) {
            const clientOptions = {
              appId,
              secret,
              endpoint: endpoint(
                row.endpoint,
                provider,
                this.options.production,
                `${provider} endpoint`,
              ),
              timeoutMs: positiveInteger(
                row.timeout_ms,
                `${provider} timeout`,
                100,
                30_000,
              ),
              breakerThreshold: positiveInteger(
                row.breaker_threshold,
                `${provider} breaker threshold`,
                1,
                1_000,
              ),
              breakerOpenMs: positiveInteger(
                row.breaker_open_ms,
                `${provider} breaker open`,
                100,
                600_000,
              ),
              ...(this.options.fetchImpl
                ? { fetchImpl: this.options.fetchImpl }
                : {}),
              now: this.now,
            };
            client = provider === "wechat"
              ? new WechatClient(clientOptions)
              : new DouyinClient(clientOptions);
          }
          availability = "ready";
        } catch {
          client = null;
          availability = "unavailable";
        }
      }
    }
    if (availability !== "ready") {
      client = null;
    }

    const cached: CachedProvider = {
      integrationRevision,
      secretVersion,
      configurationKey,
      client,
      availability,
      validationState: normalizedValidationState,
      expiresAtMs: this.now() + this.cacheTtlMs,
    };
    this.providerClients.set(key, cached);
    return cached;
  }

  private async recordProviderValidation<
    Provider extends ExternalAuthProvider,
  >(
    gameId: string,
    provider: Provider,
    expectedIntegrationRevision: number,
    cached: CachedProvider,
    result: AuthExchangeResult<Provider>,
  ): Promise<void> {
    const current = this.providerClients.get(
      providerCacheKey(gameId, provider),
    );
    if (
      current !== cached
      || cached.integrationRevision !== expectedIntegrationRevision
    ) {
      return;
    }

    if (result.ok) {
      if (cached.validationState === "active") {
        return;
      }
      cached.validationState = "active";
      cached.availability = "ready";
      await this.pool.execute<ResultSetHeader>(
        `UPDATE game_identity_providers AS p
           JOIN game_integrations AS i ON i.game_id = p.game_id
            SET p.validation_state = 'active',
                p.validation_failed_at = NULL,
                p.validation_error_code = NULL
          WHERE p.game_id = ?
            AND p.provider = ?
            AND i.revision = ?
            AND p.validation_state <> 'active'`,
        [gameId, provider, expectedIntegrationRevision],
      );
      return;
    }
    if (
      result.reason !== "invalid_credentials"
      || cached.validationState === "validation_failed"
    ) {
      return;
    }
    cached.validationState = "validation_failed";
    cached.availability = "invalid_credentials";
    await this.pool.execute<ResultSetHeader>(
      `UPDATE game_identity_providers AS p
         JOIN game_integrations AS i ON i.game_id = p.game_id
          SET p.validation_state = 'validation_failed',
              p.validation_failed_at = NOW(3),
              p.validation_error_code = 'invalid_credentials'
        WHERE p.game_id = ?
          AND p.provider = ?
          AND i.revision = ?
          AND p.validation_state <> 'validation_failed'`,
      [gameId, provider, expectedIntegrationRevision],
    );
  }

  private clearProviderClients(gameId: string): void {
    this.providerClients.delete(providerCacheKey(gameId, "wechat"));
    this.providerClients.delete(providerCacheKey(gameId, "douyin"));
  }

  private expireGame(gameId: string): void {
    const cached = this.games.get(gameId);
    if (cached) {
      cached.expiresAtMs = 0;
    }
  }

  private refresh(
    gameId: string,
    failIfMissing: boolean,
  ): Promise<GameContext> {
    const inFlight = this.refreshes.get(gameId);
    if (inFlight) {
      return inFlight;
    }
    const refresh = this.load(
      gameId,
      failIfMissing,
      this.generations.get(gameId) ?? 0,
    )
      .finally(() => {
        if (this.refreshes.get(gameId) === refresh) {
          this.refreshes.delete(gameId);
        }
      });
    this.refreshes.set(gameId, refresh);
    return refresh;
  }

  private async load(
    gameId: string,
    failIfMissing: boolean,
    generation: number,
  ): Promise<GameContext> {
    const [rows] = await this.pool.query<GameConfigurationRow[]>(
      `${SELECT_GAME_CONFIGURATION}
        WHERE g.game_id = ?
        LIMIT 1`,
      [gameId],
    );
    const row = rows[0];
    if ((this.generations.get(gameId) ?? 0) !== generation) {
      return this.load(
        gameId,
        failIfMissing,
        this.generations.get(gameId) ?? 0,
      );
    }
    if (!row) {
      this.games.delete(gameId);
      this.clearProviderClients(gameId);
      if (failIfMissing) {
        throw new GameManageKitError(404, "GAME_NOT_FOUND");
      }
      throw new Error(`游戏 ${gameId} 不存在`);
    }
    const status = String(row.status);
    const configurationState = String(row.configuration_state);
    if (
      !GAME_STATUSES.has(status as GameStatus)
      || !CONFIGURATION_STATES.has(
        configurationState as GameConfigurationState,
      )
    ) {
      throw new Error(`游戏 ${gameId} 状态数据无效`);
    }
    if (
      row.integration_revision === null
      || row.directory_revision === null
    ) {
      throw new Error(`游戏 ${gameId} 缺少运行时配置`);
    }
    const loadedRevision = Object.freeze({
      game: revision(row.game_revision, "游戏 revision"),
      integration: revision(
        row.integration_revision,
        "游戏接入 revision",
      ),
      directory: revision(row.directory_revision, "目录 revision"),
    });
    const previous = this.games.get(gameId)?.context;
    if (previous && sameRevision(previous.revision, loadedRevision)) {
      const cached = this.games.get(gameId);
      if (!cached) {
        throw new Error(`游戏 ${gameId} 缓存状态无效`);
      }
      cached.expiresAtMs = this.now() + this.cacheTtlMs;
      return previous;
    }

    const loginRate = Object.freeze({
      capacity: positiveNumber(
        row.login_rate_capacity,
        "登录限流 capacity",
      ),
      refillPerSecond: positiveNumber(
        row.login_rate_refill_per_second,
        "登录限流 refill",
      ),
    });
    const adminRate = Object.freeze({
      capacity: positiveNumber(
        row.admin_rate_capacity,
        "管理限流 capacity",
      ),
      refillPerSecond: positiveNumber(
        row.admin_rate_refill_per_second,
        "管理限流 refill",
      ),
    });
    const integrationUnchanged = previous
      && previous.revision.integration === loadedRevision.integration;
    const context: GameContext = Object.freeze({
      gameId,
      name: String(row.name),
      status: status as GameStatus,
      configurationState: configurationState as GameConfigurationState,
      directory: previous?.directory
        ?? new MysqlDirectoryProvider(
          this.pool,
          gameId,
          this.options.production,
        ),
      wechat: integrationUnchanged
        ? previous.wechat
        : new LazyProviderClient(
            this,
            gameId,
            loadedRevision.integration,
            "wechat",
          ),
      douyin: integrationUnchanged
        ? previous.douyin
        : new LazyProviderClient(
            this,
            gameId,
            loadedRevision.integration,
            "douyin",
          ),
      sessionTtlSeconds: positiveInteger(
        row.session_ttl_seconds,
        "会话 TTL",
        60,
        31_536_000,
      ),
      loginRate,
      adminRate,
      loginLimiter: integrationUnchanged
        ? previous.loginLimiter
        : new TokenBucketLimiter(
            loginRate.capacity,
            loginRate.refillPerSecond,
            this.now,
          ),
      adminLimiter: integrationUnchanged
        ? previous.adminLimiter
        : new TokenBucketLimiter(
            adminRate.capacity,
            adminRate.refillPerSecond,
            this.now,
          ),
      revision: loadedRevision,
    });
    this.games.set(gameId, {
      context,
      expiresAtMs: this.now() + this.cacheTtlMs,
    });
    this.options.onGameLoaded?.(gameId);
    return context;
  }

  private async authenticateMachine(
    identityType: "service" | "machine_admin",
    identityId: string,
    secret: string | null | undefined,
  ): Promise<{
    identityId: string;
    gameIds: readonly string[];
  } | null> {
    const actualDigest = requestSecretDigest(secret);
    if (!MACHINE_ID_PATTERN.test(identityId) || !actualDigest) {
      return null;
    }
    const [rows] = await this.pool.query<MachineAuthenticationRow[]>(
      `SELECT i.identity_id, g.game_id, s.version, s.secret_digest,
              (
                s.state = 'current'
                OR (
                  s.state = 'previous'
                  AND s.expires_at IS NOT NULL
                  AND s.expires_at > NOW(3)
                )
              ) AS usable
         FROM machine_identities i
         JOIN machine_secret_versions s
           ON s.identity_id = i.identity_id
         LEFT JOIN machine_identity_games g
           ON g.identity_id = i.identity_id
        WHERE i.identity_id = ?
          AND i.identity_type = ?
          AND i.status = 'enabled'
        ORDER BY s.version DESC, g.game_id`,
      [identityId, identityType],
    );
    let matchedVersion: number | null = null;
    let matchedUsable = false;
    for (const row of rows) {
      const expected = digestBuffer(row.secret_digest);
      const versionValue = Number(row.version);
      if (
        expected
        && Number.isSafeInteger(versionValue)
        && timingSafeEqual(actualDigest, expected)
      ) {
        matchedVersion = versionValue;
        matchedUsable = Number(row.usable) === 1;
      }
    }
    if (matchedVersion === null) {
      return null;
    }
    if (!matchedUsable) {
      await this.recordRejectedMachineSecretUse(
        identityId,
        matchedVersion,
      );
      return null;
    }
    const gameIds = Object.freeze([
      ...new Set(rows.flatMap((row) => (
        row.game_id && GAME_ID_PATTERN.test(String(row.game_id))
          ? [String(row.game_id)]
          : []
      ))),
    ]);
    const [updated] = await this.pool.execute<ResultSetHeader>(
      `UPDATE machine_secret_versions
          SET last_used_at = NOW(3)
        WHERE identity_id = ?
          AND version = ?
          AND (
            state = 'current'
            OR (
              state = 'previous'
              AND expires_at IS NOT NULL
              AND expires_at > NOW(3)
            )
          )`,
      [identityId, matchedVersion],
    );
    if (updated.affectedRows !== 1) {
      await this.recordRejectedMachineSecretUse(
        identityId,
        matchedVersion,
      );
      return null;
    }
    return {
      identityId,
      gameIds,
    };
  }

  private async recordRejectedMachineSecretUse(
    identityId: string,
    version: number,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE machine_secret_versions
          SET last_used_at = NOW(3)
        WHERE identity_id = ?
          AND version = ?`,
      [identityId, version],
    ).catch(() => undefined);
  }
}
