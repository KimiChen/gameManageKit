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
import {
  MysqlDirectoryProvider,
  type DirectoryProvider,
} from "../directory/service.js";
import {
  TokenBucketLimiter,
} from "../../infra/security/security.js";
import {
  WechatClient,
  type WechatExchangeResult,
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
  invalidate?(gameId: string): void;
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
  readonly wechat_app_id: string | null;
  readonly wechat_secret_configured: number | boolean | string | null;
  readonly wechat_endpoint: string | null;
  readonly wechat_timeout_ms: number | string | null;
  readonly wechat_breaker_threshold: number | string | null;
  readonly wechat_breaker_open_ms: number | string | null;
  readonly session_ttl_seconds: number | string | null;
  readonly login_rate_capacity: number | string | null;
  readonly login_rate_refill_per_second: number | string | null;
  readonly admin_rate_capacity: number | string | null;
  readonly admin_rate_refill_per_second: number | string | null;
  readonly integration_revision: number | string | null;
  readonly directory_revision: number | string | null;
}

interface WechatConfigurationRow extends RowDataPacket {
  readonly wechat_app_id: string | null;
  readonly wechat_app_secret: string | null;
  readonly wechat_endpoint: string;
  readonly wechat_timeout_ms: number | string;
  readonly wechat_breaker_threshold: number | string;
  readonly wechat_breaker_open_ms: number | string;
  readonly wechat_secret_version: number | string;
  readonly revision: number | string;
}

interface MachineAuthenticationRow extends RowDataPacket {
  readonly identity_id: string;
  readonly game_id: string | null;
  readonly version: number | string;
  readonly secret_digest: Buffer | string;
}

interface CachedGame {
  readonly context: GameContext;
  expiresAtMs: number;
}

interface CachedWechat {
  readonly integrationRevision: number;
  readonly secretVersion: number;
  readonly client: WechatClient;
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

const SELECT_GAME_CONFIGURATION = `
  SELECT g.game_id, g.name, g.status, g.configuration_state,
         g.revision AS game_revision,
         i.wechat_app_id,
         (i.wechat_app_secret IS NOT NULL) AS wechat_secret_configured,
         i.wechat_endpoint, i.wechat_timeout_ms,
         i.wechat_breaker_threshold, i.wechat_breaker_open_ms,
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
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} 数据无效`);
  }
  const officialWechatEndpoint = parsed.protocol === "https:"
    && parsed.hostname === "api.weixin.qq.com"
    && parsed.port === ""
    && parsed.pathname === "/sns/jscode2session"
    && parsed.search === "";
  if (officialWechatEndpoint) {
    return value;
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

class LazyWechatClient implements WechatIdentityClient {
  constructor(
    private readonly resolver: GameConfigResolver,
    private readonly gameId: string,
    private readonly integrationRevision: number,
  ) {}

  async exchange(code: string): Promise<WechatExchangeResult> {
    const client = await this.resolver.wechatClient(
      this.gameId,
      this.integrationRevision,
    ).catch(() => null);
    return client
      ? client.exchange(code)
      : { ok: false, reason: "wx_unavailable" };
  }
}

export class GameConfigResolver implements GameRuntimeRegistry {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly games = new Map<string, CachedGame>();
  private readonly refreshes = new Map<string, Promise<GameContext>>();
  private readonly wechatClients = new Map<string, CachedWechat>();
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

  invalidate(gameId: string): void {
    this.generations.set(
      gameId,
      (this.generations.get(gameId) ?? 0) + 1,
    );
    const cached = this.games.get(gameId);
    if (cached) {
      cached.expiresAtMs = 0;
    }
    this.wechatClients.delete(gameId);
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

  async wechatClient(
    gameId: string,
    expectedIntegrationRevision: number,
  ): Promise<WechatClient> {
    const generation = this.generations.get(gameId) ?? 0;
    const cached = this.wechatClients.get(gameId);
    if (
      cached
      && cached.integrationRevision === expectedIntegrationRevision
    ) {
      return cached.client;
    }
    const [rows] = await this.pool.query<WechatConfigurationRow[]>(
      `SELECT wechat_app_id, wechat_app_secret, wechat_endpoint,
              wechat_timeout_ms, wechat_breaker_threshold,
              wechat_breaker_open_ms, wechat_secret_version, revision
         FROM game_integrations
        WHERE game_id = ?
        LIMIT 1`,
      [gameId],
    );
    if ((this.generations.get(gameId) ?? 0) !== generation) {
      return this.wechatClient(gameId, expectedIntegrationRevision);
    }
    const row = rows[0];
    const appId = row?.wechat_app_id;
    const secret = row?.wechat_app_secret;
    if (
      !row
      || !appId
      || appId.length > 128
      || !secret
      || secret.length > 512
    ) {
      throw new Error("微信接入配置不完整");
    }
    const integrationRevision = revision(row.revision, "微信接入 revision");
    const secretVersion = positiveInteger(
      row.wechat_secret_version,
      "微信 Secret version",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      cached
      && cached.integrationRevision === integrationRevision
      && cached.secretVersion === secretVersion
    ) {
      return cached.client;
    }
    const client = new WechatClient({
      appId,
      secret,
      endpoint: endpoint(
        row.wechat_endpoint,
        this.options.production,
        "微信 endpoint",
      ),
      timeoutMs: positiveInteger(
        row.wechat_timeout_ms,
        "微信 timeout",
        100,
        30_000,
      ),
      breakerThreshold: positiveInteger(
        row.wechat_breaker_threshold,
        "微信 breaker threshold",
        1,
        1_000,
      ),
      breakerOpenMs: positiveInteger(
        row.wechat_breaker_open_ms,
        "微信 breaker open",
        100,
        600_000,
      ),
      ...(this.options.fetchImpl
        ? { fetchImpl: this.options.fetchImpl }
        : {}),
      now: this.now,
    });
    this.wechatClients.set(gameId, {
      integrationRevision,
      secretVersion,
      client,
    });
    return client;
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
      this.wechatClients.delete(gameId);
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
    if (
      configurationState === "configured"
      && (
        !row.wechat_app_id
        || row.wechat_app_id.length > 128
        || Number(row.wechat_secret_configured) !== 1
      )
    ) {
      throw new Error(`游戏 ${gameId} 微信接入配置不完整`);
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
    // Validate all non-secret WeChat settings when the context is loaded. The
    // AppSecret itself is intentionally absent from this query.
    endpoint(
      row.wechat_endpoint,
      this.options.production,
      "微信 endpoint",
    );
    positiveInteger(row.wechat_timeout_ms, "微信 timeout", 100, 30_000);
    positiveInteger(
      row.wechat_breaker_threshold,
      "微信 breaker threshold",
      1,
      1_000,
    );
    positiveInteger(
      row.wechat_breaker_open_ms,
      "微信 breaker open",
      100,
      600_000,
    );
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
        : new LazyWechatClient(
            this,
            gameId,
            loadedRevision.integration,
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
      `SELECT i.identity_id, g.game_id, s.version, s.secret_digest
         FROM machine_identities i
         JOIN machine_secret_versions s
           ON s.identity_id = i.identity_id
          AND (
            s.state = 'current'
            OR (
              s.state = 'previous'
              AND s.expires_at IS NOT NULL
              AND s.expires_at > NOW(3)
            )
          )
         LEFT JOIN machine_identity_games g
           ON g.identity_id = i.identity_id
        WHERE i.identity_id = ?
          AND i.identity_type = ?
          AND i.status = 'enabled'
        ORDER BY s.version DESC, g.game_id`,
      [identityId, identityType],
    );
    let matchedVersion: number | null = null;
    for (const row of rows) {
      const expected = digestBuffer(row.secret_digest);
      const versionValue = Number(row.version);
      if (
        expected
        && Number.isSafeInteger(versionValue)
        && timingSafeEqual(actualDigest, expected)
      ) {
        matchedVersion = versionValue;
      }
    }
    if (matchedVersion === null) {
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
      return null;
    }
    return {
      identityId,
      gameIds,
    };
  }
}
