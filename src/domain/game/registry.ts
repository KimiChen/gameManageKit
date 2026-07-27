import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { AreaServer } from "@gono/game-manage-kit-contract";
import { GameManageKitError } from "../../errors.js";
import { matchesAnySecret, TokenBucketLimiter } from "../../infra/security/security.js";
import { WechatClient } from "../../infra/wechat/client.js";
import {
  FileDirectoryProvider,
  MysqlDirectoryProvider,
  type DirectoryProvider,
} from "../directory/service.js";

export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type GameStatus = "enabled" | "maintenance" | "disabled";

export interface RateLimitPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface GameContext {
  readonly gameId: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly directory: DirectoryProvider;
  readonly wechat: WechatClient;
  readonly sessionTtlSeconds: number;
  readonly loginRate: RateLimitPolicy;
  readonly adminRate: RateLimitPolicy;
  readonly loginLimiter: TokenBucketLimiter;
  readonly adminLimiter: TokenBucketLimiter;
}

export interface ServiceIdentity {
  readonly serviceId: string;
  readonly gameIds: readonly string[];
}

export interface AdminIdentity {
  readonly operatorId: string;
  readonly gameIds: readonly string[];
}

export interface GameRegistryLoadOptions {
  readonly production: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface PrincipalRecord<T> {
  readonly identity: T;
  readonly secrets: readonly string[];
}

interface StoredGameRow extends RowDataPacket {
  readonly game_id: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly configuration_state: "draft" | "configured";
}

interface ParsedGame {
  readonly gameId: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly directoryPath: string;
  readonly sessionTtlSeconds: number;
  readonly wechat: {
    readonly appId: string;
    readonly secret: string;
    readonly endpoint: string;
    readonly timeoutMs: number;
    readonly breakerThreshold: number;
    readonly breakerOpenMs: number;
  };
  readonly loginRate: RateLimitPolicy;
  readonly adminRate: RateLimitPolicy;
}

type JsonObject = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;

const ROOT_KEYS = new Set(["games", "serviceIdentities", "adminIdentities"]);
const GAME_KEYS = new Set([
  "gameId",
  "name",
  "status",
  "directoryPath",
  "sessionTtlSeconds",
  "wechat",
  "loginRate",
  "adminRate",
]);
const WECHAT_KEYS = new Set([
  "appIdEnv",
  "secretEnv",
  "endpoint",
  "timeoutMs",
  "breakerThreshold",
  "breakerOpenMs",
]);
const RATE_KEYS = new Set(["capacity", "refillPerSecond"]);
const SERVICE_IDENTITY_KEYS = new Set([
  "serviceId",
  "secretEnv",
  "previousSecretEnv",
  "gameIds",
]);
const ADMIN_IDENTITY_KEYS = new Set([
  "operatorId",
  "secretEnv",
  "previousSecretEnv",
  "gameIds",
]);
const STATUSES = new Set<GameStatus>(["enabled", "maintenance", "disabled"]);
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const PRINCIPAL_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as JsonObject;
}

function assertOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} 含未知字段 ${key}`);
    }
  }
}

function asNonEmptyString(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} 必须是长度 1..${maximum} 的字符串`);
  }
  return value;
}

function asInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} 必须是 ${minimum}..${maximum} 的整数`);
  }
  return Number(value);
}

function asPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error(`${label} 必须是 0..1000000 范围内的正数`);
  }
  return value;
}

function asEnvName(value: unknown, label: string): string {
  const name = asNonEmptyString(value, label, 128);
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(`${label} 不是合法环境变量名`);
  }
  return name;
}

function requiredEnvironment(env: Environment, name: string, label: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${label} 引用的环境变量 ${name} 缺失`);
  }
  return value;
}

function requiredSecretEnvironment(
  env: Environment,
  name: string,
  label: string,
): string {
  const value = requiredEnvironment(env, name, label);
  if (value.length < 16 || value.length > 512) {
    throw new Error(`${label} 引用的密钥长度必须是 16..512`);
  }
  return value;
}

function asEndpoint(value: unknown, production: boolean, label: string): string {
  const raw = asNonEmptyString(value, label, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} 不允许包含凭证或 fragment`);
  }
  if (parsed.protocol === "https:") {
    return raw;
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  if (!production && parsed.protocol === "http:" && loopback) {
    return raw;
  }
  throw new Error(`${label} 必须使用 https://；开发环境仅允许 loopback http://`);
}

function asRateLimit(value: unknown, label: string): RateLimitPolicy {
  const input = asObject(value, label);
  assertOnlyKeys(input, RATE_KEYS, label);
  return Object.freeze({
    capacity: asPositiveNumber(input.capacity, `${label}.capacity`),
    refillPerSecond: asPositiveNumber(input.refillPerSecond, `${label}.refillPerSecond`),
  });
}

function resolveConfigPath(configDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(configDirectory, path);
}

function asGame(
  value: unknown,
  index: number,
  configDirectory: string,
  options: GameRegistryLoadOptions,
  env: Environment,
): ParsedGame {
  const label = `games[${index}]`;
  const input = asObject(value, label);
  assertOnlyKeys(input, GAME_KEYS, label);

  const gameId = asNonEmptyString(input.gameId, `${label}.gameId`, 32);
  if (!GAME_ID_PATTERN.test(gameId)) {
    throw new Error(`${label}.gameId 必须匹配 ${GAME_ID_PATTERN.source}`);
  }
  if (typeof input.status !== "string" || !STATUSES.has(input.status as GameStatus)) {
    throw new Error(`${label}.status 必须是 enabled/maintenance/disabled`);
  }

  const wechatLabel = `${label}.wechat`;
  const wechat = asObject(input.wechat, wechatLabel);
  assertOnlyKeys(wechat, WECHAT_KEYS, wechatLabel);
  const appIdEnv = asEnvName(wechat.appIdEnv, `${wechatLabel}.appIdEnv`);
  const secretEnv = asEnvName(wechat.secretEnv, `${wechatLabel}.secretEnv`);

  return {
    gameId,
    name: input.name === undefined
      ? gameId
      : asNonEmptyString(input.name, `${label}.name`, 128),
    status: input.status as GameStatus,
    directoryPath: resolveConfigPath(
      configDirectory,
      asNonEmptyString(input.directoryPath, `${label}.directoryPath`),
    ),
    sessionTtlSeconds: asInteger(
      input.sessionTtlSeconds,
      `${label}.sessionTtlSeconds`,
      60,
      31_536_000,
    ),
    wechat: {
      appId: requiredEnvironment(env, appIdEnv, `${wechatLabel}.appIdEnv`),
      secret: requiredSecretEnvironment(env, secretEnv, `${wechatLabel}.secretEnv`),
      endpoint: asEndpoint(wechat.endpoint, options.production, `${wechatLabel}.endpoint`),
      timeoutMs: asInteger(wechat.timeoutMs, `${wechatLabel}.timeoutMs`, 100, 30_000),
      breakerThreshold: asInteger(
        wechat.breakerThreshold,
        `${wechatLabel}.breakerThreshold`,
        1,
        1_000,
      ),
      breakerOpenMs: asInteger(
        wechat.breakerOpenMs,
        `${wechatLabel}.breakerOpenMs`,
        100,
        600_000,
      ),
    },
    loginRate: asRateLimit(input.loginRate, `${label}.loginRate`),
    adminRate: asRateLimit(input.adminRate, `${label}.adminRate`),
  };
}

function asPrincipalGameIds(
  value: unknown,
  label: string,
  knownGames: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空数组`);
  }
  const gameIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const gameId = asNonEmptyString(item, `${label}[${index}]`, 32);
    if (!GAME_ID_PATTERN.test(gameId) || !knownGames.has(gameId)) {
      throw new Error(`${label} 引用了未知游戏 ${gameId}`);
    }
    if (seen.has(gameId)) {
      throw new Error(`${label} 含重复游戏 ${gameId}`);
    }
    seen.add(gameId);
    gameIds.push(gameId);
  }
  return Object.freeze(gameIds);
}

function asPrincipalSecrets(
  input: JsonObject,
  label: string,
  env: Environment,
): readonly string[] {
  const secretEnv = asEnvName(input.secretEnv, `${label}.secretEnv`);
  const values = [requiredSecretEnvironment(env, secretEnv, `${label}.secretEnv`)];
  if (input.previousSecretEnv !== undefined) {
    const previousSecretEnv = asEnvName(
      input.previousSecretEnv,
      `${label}.previousSecretEnv`,
    );
    values.push(requiredSecretEnvironment(
      env,
      previousSecretEnv,
      `${label}.previousSecretEnv`,
    ));
  }
  return Object.freeze([...new Set(values)]);
}

function asPrincipalId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new Error(`${label} 必须是长度 1..64 的可打印 ASCII 且不含空白`);
  }
  return value;
}

function registerSecretOwners(
  owners: Map<string, string>,
  secrets: readonly string[],
  label: string,
): void {
  for (const secret of secrets) {
    const owner = owners.get(secret);
    if (owner && owner !== label) {
      throw new Error(`${label} 与 ${owner} 不能共享密钥`);
    }
    owners.set(secret, label);
  }
}

function parseServiceIdentities(
  value: unknown,
  knownGames: ReadonlySet<string>,
  env: Environment,
  secretOwners: Map<string, string>,
): Map<string, PrincipalRecord<ServiceIdentity>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("serviceIdentities 必须是非空数组");
  }
  const identities = new Map<string, PrincipalRecord<ServiceIdentity>>();
  for (const [index, item] of value.entries()) {
    const label = `serviceIdentities[${index}]`;
    const input = asObject(item, label);
    assertOnlyKeys(input, SERVICE_IDENTITY_KEYS, label);
    const serviceId = asPrincipalId(input.serviceId, `${label}.serviceId`);
    if (identities.has(serviceId)) {
      throw new Error(`serviceId 重复: ${serviceId}`);
    }
    const secrets = asPrincipalSecrets(input, label, env);
    registerSecretOwners(secretOwners, secrets, `Service ${serviceId}`);
    identities.set(serviceId, {
      identity: Object.freeze({
        serviceId,
        gameIds: asPrincipalGameIds(input.gameIds, `${label}.gameIds`, knownGames),
      }),
      secrets,
    });
  }
  return identities;
}

function parseAdminIdentities(
  value: unknown,
  knownGames: ReadonlySet<string>,
  env: Environment,
  secretOwners: Map<string, string>,
): Map<string, PrincipalRecord<AdminIdentity>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("adminIdentities 必须是非空数组");
  }
  const identities = new Map<string, PrincipalRecord<AdminIdentity>>();
  for (const [index, item] of value.entries()) {
    const label = `adminIdentities[${index}]`;
    const input = asObject(item, label);
    assertOnlyKeys(input, ADMIN_IDENTITY_KEYS, label);
    const operatorId = asPrincipalId(input.operatorId, `${label}.operatorId`);
    if (identities.has(operatorId)) {
      throw new Error(`operatorId 重复: ${operatorId}`);
    }
    const secrets = asPrincipalSecrets(input, label, env);
    registerSecretOwners(secretOwners, secrets, `Admin ${operatorId}`);
    identities.set(operatorId, {
      identity: Object.freeze({
        operatorId,
        gameIds: asPrincipalGameIds(input.gameIds, `${label}.gameIds`, knownGames),
      }),
      secrets,
    });
  }
  return identities;
}

export class GameRegistry {
  private constructor(
    private readonly games: Map<string, GameContext>,
    private readonly services: ReadonlyMap<string, PrincipalRecord<ServiceIdentity>>,
    private readonly admins: ReadonlyMap<string, PrincipalRecord<AdminIdentity>>,
    private readonly production: boolean,
  ) {}

  static async load(
    path: string,
    options: GameRegistryLoadOptions,
  ): Promise<GameRegistry> {
    const absolutePath = resolve(path);
    const configDirectory = dirname(absolutePath);
    const env = options.env ?? process.env;
    const source = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`游戏配置不是合法 JSON: ${path}`);
    }
    const document = asObject(parsed, "游戏配置");
    assertOnlyKeys(document, ROOT_KEYS, "游戏配置");
    if (!Array.isArray(document.games) || document.games.length === 0) {
      throw new Error("games 必须是非空数组");
    }

    const parsedGames: ParsedGame[] = [];
    const gameIds = new Set<string>();
    const directoryPaths = new Set<string>();
    for (const [index, value] of document.games.entries()) {
      const game = asGame(value, index, configDirectory, options, env);
      if (gameIds.has(game.gameId)) {
        throw new Error(`gameId 重复: ${game.gameId}`);
      }
      if (directoryPaths.has(game.directoryPath)) {
        throw new Error(`游戏目录文件重复: ${game.directoryPath}`);
      }
      gameIds.add(game.gameId);
      directoryPaths.add(game.directoryPath);
      parsedGames.push(game);
    }

    const secretOwners = new Map<string, string>();
    const services = parseServiceIdentities(
      document.serviceIdentities,
      gameIds,
      env,
      secretOwners,
    );
    const admins = parseAdminIdentities(
      document.adminIdentities,
      gameIds,
      env,
      secretOwners,
    );

    const contexts = await Promise.all(parsedGames.map(async (game): Promise<GameContext> => {
      const directory = await FileDirectoryProvider.load(game.directoryPath, options.production);
      const loginRate = Object.freeze({ ...game.loginRate });
      const adminRate = Object.freeze({ ...game.adminRate });
      return Object.freeze({
        gameId: game.gameId,
        name: game.name,
        status: game.status,
        directory,
        wechat: new WechatClient({
          ...game.wechat,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.now ? { now: options.now } : {}),
        }),
        sessionTtlSeconds: game.sessionTtlSeconds,
        loginRate,
        adminRate,
        loginLimiter: new TokenBucketLimiter(
          loginRate.capacity,
          loginRate.refillPerSecond,
          options.now,
        ),
        adminLimiter: new TokenBucketLimiter(
          adminRate.capacity,
          adminRate.refillPerSecond,
          options.now,
        ),
      });
    }));

    return new GameRegistry(
      new Map(contexts.map((context) => [context.gameId, context])),
      services,
      admins,
      options.production,
    );
  }

  ready(): boolean {
    return this.games.size > 0;
  }

  list(): readonly GameContext[] {
    return [...this.games.values()];
  }

  get(gameId: string): GameContext | undefined {
    return this.games.get(gameId);
  }

  applyProjectMetadata(
    gameId: string,
    metadata: Readonly<{ name: string; status: GameStatus }>,
  ): GameContext | undefined {
    const current = this.games.get(gameId);
    if (!current) {
      return undefined;
    }
    if (current.name === metadata.name && current.status === metadata.status) {
      return current;
    }
    const updated = Object.freeze({
      ...current,
      name: metadata.name,
      status: metadata.status,
    });
    this.games.set(gameId, updated);
    return updated;
  }

  resolve(gameId: string): GameContext {
    const game = this.games.get(gameId);
    if (!game) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
    if (game.status === "disabled") {
      throw new GameManageKitError(403, "GAME_DISABLED");
    }
    if (game.status === "maintenance") {
      throw new GameManageKitError(503, "GAME_DISABLED");
    }
    return game;
  }

  authenticateService(
    serviceId: string,
    secret: string | null | undefined,
  ): ServiceIdentity | null {
    const principal = this.services.get(serviceId);
    return principal && matchesAnySecret(secret, principal.secrets)
      ? principal.identity
      : null;
  }

  authenticateAdmin(
    operatorId: string,
    secret: string | null | undefined,
  ): AdminIdentity | null {
    const principal = this.admins.get(operatorId);
    return principal && matchesAnySecret(secret, principal.secrets)
      ? principal.identity
      : null;
  }

  canAccess(
    identity: ServiceIdentity | AdminIdentity,
    gameId: string,
  ): boolean {
    return identity.gameIds.includes(gameId);
  }

  async requireServer(
    game: GameContext | string,
    serverId: number,
  ): Promise<AreaServer> {
    const context = typeof game === "string" ? this.resolve(game) : game;
    const server = await context.directory.findServer(serverId);
    if (!server) {
      throw new GameManageKitError(404, "SERVER_NOT_FOUND");
    }
    if (!await context.directory.isServerUsable(serverId)) {
      throw new GameManageKitError(403, "SERVER_DISABLED");
    }
    return server;
  }

  async sync(pool: Pool): Promise<void> {
    const directorySeeds = new Map(
      await Promise.all([...this.games.values()].map(async (game) => (
        [game.gameId, await game.directory.listAreas()] as const
      ))),
    );
    const connection = await pool.getConnection();
    const metadata = new Map<string, { name: string; status: GameStatus }>();
    try {
      await connection.beginTransaction();
      try {
        const [storedGames] = await connection.query<StoredGameRow[]>(
          `SELECT game_id, name, status, configuration_state
             FROM games
            FOR UPDATE`,
        );
        const storedById = new Map(
          storedGames.map((stored) => [String(stored.game_id), stored]),
        );
        for (const stored of storedGames) {
          const configured = this.games.get(String(stored.game_id));
          if (!configured && stored.configuration_state === "configured") {
            throw new Error(
              `游戏配置缺少已登记 gameId ${String(stored.game_id)}；`
              + "退役游戏必须保留并设为 disabled",
            );
          }
          if (
            stored.configuration_state !== "draft"
            && stored.configuration_state !== "configured"
          ) {
            throw new Error(`gameId ${String(stored.game_id)} 配置状态无效`);
          }
        }
        for (const game of this.games.values()) {
          const stored = storedById.get(game.gameId);
          if (!stored) {
            await connection.execute(
              `INSERT INTO games
                 (game_id, name, description, status,
                  configuration_state, client_visible, sort_order, revision)
               VALUES (?, ?, '', ?, 'configured', ?, 0, 1)`,
              [
                game.gameId,
                game.name,
                game.status,
                game.status === "disabled" ? 0 : 1,
              ],
            );
            metadata.set(game.gameId, {
              name: game.name,
              status: game.status,
            });
          } else if (stored.configuration_state === "draft") {
            const status = stored.status === "disabled"
              ? "disabled"
              : game.status;
            await connection.execute(
              `UPDATE games
                  SET status = ?,
                      configuration_state = 'configured',
                      revision = revision + 1
                WHERE game_id = ?`,
              [status, game.gameId],
            );
            metadata.set(game.gameId, {
              name: String(stored.name),
              status,
            });
          } else {
            metadata.set(game.gameId, {
              name: String(stored.name),
              status: stored.status,
            });
          }
          await connection.execute(
            `INSERT INTO seq (game_id, name, val)
             VALUES (?, 'user_id', 0)
             ON DUPLICATE KEY UPDATE name = name`,
            [game.gameId],
          );
          const seed = directorySeeds.get(game.gameId);
          if (!seed) {
            throw new Error(`gameId ${game.gameId} 缺少目录启动快照`);
          }
          const [settingsResult] = await connection.execute<ResultSetHeader>(
            `INSERT IGNORE INTO game_directory_settings (game_id, is_ops)
             VALUES (?, ?)`,
            [game.gameId, seed.isOps ? 1 : 0],
          );
          if (settingsResult.affectedRows === 1) {
            for (const [sortOrder, server] of seed.servers.entries()) {
              await connection.execute(
                `INSERT INTO game_servers
                   (game_id, server_id, name, tag, status, open_time,
                    game_http_url, game_ws_url, is_open, sort_order, revision)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
                [
                  game.gameId,
                  server.serverId,
                  server.name,
                  server.tag,
                  server.status,
                  server.openTime,
                  server.gameHttpUrl,
                  server.gameWsUrl,
                  sortOrder,
                ],
              );
            }
          }
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      connection.release();
    }
    for (const [gameId, project] of metadata) {
      this.applyProjectMetadata(gameId, project);
      const current = this.games.get(gameId);
      if (!current) {
        throw new Error(`gameId ${gameId} 运行时上下文丢失`);
      }
      this.games.set(gameId, Object.freeze({
        ...current,
        directory: new MysqlDirectoryProvider(
          pool,
          gameId,
          this.production,
        ),
      }));
    }
  }
}
