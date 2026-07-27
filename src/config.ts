import { isIP } from "node:net";

export const CURRENT_SCHEMA_VERSION = 1;
export const TOKEN_BYTES = 24;
export const SESSION_TTL_SECONDS = 259_200;

export interface GameManageKitConfig {
  readonly nodeEnv: string;
  readonly mysqlUrl: string;
  readonly mysqlPoolSize: number;
  readonly publicHost: string;
  readonly publicPort: number;
  readonly internalHost: string;
  readonly internalPort: number;
  readonly serviceSecrets: readonly string[];
  readonly adminSecrets: readonly string[];
  readonly areaConfigPath: string;
  readonly trustedProxyCidrs: readonly string[];
  readonly authDevEnabled: boolean;
  readonly wxAppId: string;
  readonly wxSecret: string;
  readonly wxCode2SessionUrl: string;
  readonly wxTimeoutMs: number;
  readonly wxBreakerThreshold: number;
  readonly wxBreakerOpenMs: number;
  readonly loginRateCapacity: number;
  readonly loginRateRefillPerSecond: number;
  readonly adminRateCapacity: number;
  readonly adminRateRefillPerSecond: number;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly serviceVersion: string;
  readonly gitSha: string;
  readonly schemaVersion: number;
  readonly logEnabled: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function integer(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}..${maximum} 的整数`);
  }
  return value;
}

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数`);
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  throw new Error(`${name} 只允许 0/1/false/true`);
}

function validateMysqlUrl(raw: string, gameMysqlUrl: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 不是合法 URL");
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 必须使用 mysql://");
  }
  if (!parsed.pathname.replace(/^\/+/, "")) {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 必须包含独立账号数据库名");
  }
  if (gameMysqlUrl && raw === gameMysqlUrl) {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 不得与游戏库 MYSQL_URL 相同");
  }
  return raw;
}

function validateProxy(value: string): string {
  const slash = value.lastIndexOf("/");
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family === 0) {
    throw new Error(`GAME_MANAGE_KIT_TRUST_PROXY_CIDRS 含非法地址: ${value}`);
  }
  if (slash !== -1) {
    const prefix = value.slice(slash + 1);
    const maximum = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefix) || Number(prefix) > maximum) {
      throw new Error(`GAME_MANAGE_KIT_TRUST_PROXY_CIDRS 含非法前缀: ${value}`);
    }
  }
  return value;
}

function secrets(current: string, previous: string | undefined): readonly string[] {
  const values = [current, previous?.trim()].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

export function loadConfig(env: Env = process.env): GameManageKitConfig {
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  const authDevEnabled = boolean(env, "AUTH_DEV_ENABLED", nodeEnv !== "production");
  if (nodeEnv === "production" && authDevEnabled) {
    throw new Error("AUTH_DEV_ENABLED=1 在生产环境被显式开启");
  }

  const mysqlUrl = validateMysqlUrl(required(env, "GAME_MANAGE_KIT_MYSQL_URL"), env.MYSQL_URL);
  const serviceSecret = required(env, "GAME_MANAGE_KIT_SERVICE_SECRET");
  const adminSecret = required(env, "GAME_MANAGE_KIT_ADMIN_SECRET");
  const wxAppId = env.WX_APPID?.trim() ?? "";
  const wxSecret = env.WX_SECRET?.trim() ?? "";
  if (nodeEnv === "production" && (!wxAppId || !wxSecret)) {
    throw new Error("生产环境必须配置 WX_APPID 与 WX_SECRET");
  }

  const trustedProxyCidrs = (env.GAME_MANAGE_KIT_TRUST_PROXY_CIDRS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(validateProxy);

  return {
    nodeEnv,
    mysqlUrl,
    mysqlPoolSize: integer(env, "GAME_MANAGE_KIT_MYSQL_POOL_SIZE", 20, 1, 200),
    publicHost: env.GAME_MANAGE_KIT_PUBLIC_HOST?.trim() || "127.0.0.1",
    publicPort: integer(env, "GAME_MANAGE_KIT_PUBLIC_PORT", 2570, 1, 65_535),
    internalHost: env.GAME_MANAGE_KIT_INTERNAL_HOST?.trim() || "127.0.0.1",
    internalPort: integer(env, "GAME_MANAGE_KIT_INTERNAL_PORT", 2571, 1, 65_535),
    serviceSecrets: secrets(serviceSecret, env.GAME_MANAGE_KIT_SERVICE_SECRET_PREVIOUS),
    adminSecrets: secrets(adminSecret, env.GAME_MANAGE_KIT_ADMIN_SECRET_PREVIOUS),
    areaConfigPath: env.GAME_MANAGE_KIT_AREA_CONFIG?.trim() || "config/areas.json",
    trustedProxyCidrs,
    authDevEnabled,
    wxAppId,
    wxSecret,
    wxCode2SessionUrl: env.WX_CODE2SESSION_URL?.trim()
      || "https://api.weixin.qq.com/sns/jscode2session",
    wxTimeoutMs: integer(env, "WX_TIMEOUT_MS", 3_000, 100, 30_000),
    wxBreakerThreshold: integer(env, "WX_BREAKER_THRESHOLD", 5, 1, 1_000),
    wxBreakerOpenMs: integer(env, "WX_BREAKER_OPEN_MS", 10_000, 100, 600_000),
    loginRateCapacity: positiveNumber(env, "LOGIN_RATE_CAPACITY", 5),
    loginRateRefillPerSecond: positiveNumber(env, "LOGIN_RATE_REFILL_PER_S", 0.2),
    adminRateCapacity: positiveNumber(env, "ADMIN_RATE_CAPACITY", 10),
    adminRateRefillPerSecond: positiveNumber(env, "ADMIN_RATE_REFILL_PER_S", 1),
    bodyLimitBytes: integer(env, "GAME_MANAGE_KIT_BODY_LIMIT_BYTES", 65_536, 1_024, 1_048_576),
    requestTimeoutMs: integer(env, "GAME_MANAGE_KIT_REQUEST_TIMEOUT_MS", 10_000, 100, 120_000),
    shutdownTimeoutMs: integer(env, "GAME_MANAGE_KIT_SHUTDOWN_TIMEOUT_MS", 10_000, 100, 120_000),
    serviceVersion: env.SERVICE_VERSION?.trim() || "1.0.0",
    gitSha: env.GIT_SHA?.trim() || "unknown",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    logEnabled: boolean(env, "GAME_MANAGE_KIT_LOG_ENABLED", true),
  };
}
