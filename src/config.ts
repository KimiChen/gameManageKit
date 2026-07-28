import { isIP } from "node:net";

export const CURRENT_SCHEMA_VERSION = 3;
export const TOKEN_BYTES = 24;

export interface GameManageKitConfig {
  readonly nodeEnv: string;
  readonly mysqlUrl: string;
  readonly mysqlPoolSize: number;
  readonly publicHost: string;
  readonly publicPort: number;
  readonly internalHost: string;
  readonly internalPort: number;
  readonly adminOrigin: string;
  readonly trustedProxyCidrs: readonly string[];
  readonly authDevEnabled: boolean;
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

function validateAdminOrigin(raw: string, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GAME_MANAGE_KIT_ADMIN_ORIGIN 不是合法 URL origin");
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin === "null"
  ) {
    throw new Error("GAME_MANAGE_KIT_ADMIN_ORIGIN 只能包含 scheme、host 和 port");
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error("生产环境 GAME_MANAGE_KIT_ADMIN_ORIGIN 必须使用 https://");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("GAME_MANAGE_KIT_ADMIN_ORIGIN 只允许 http:// 或 https://");
  }
  return parsed.origin;
}

export function loadConfig(env: Env = process.env): GameManageKitConfig {
  const nodeEnv = env.NODE_ENV?.trim() || "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV 只允许 development/test/production");
  }
  const authDevEnabled = boolean(env, "AUTH_DEV_ENABLED", false);
  if (nodeEnv === "production" && authDevEnabled) {
    throw new Error("AUTH_DEV_ENABLED=1 在生产环境被显式开启");
  }

  const mysqlUrl = validateMysqlUrl(required(env, "GAME_MANAGE_KIT_MYSQL_URL"), env.MYSQL_URL);

  const trustedProxyCidrs = (env.GAME_MANAGE_KIT_TRUST_PROXY_CIDRS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(validateProxy);
  const internalPort = integer(
    env,
    "GAME_MANAGE_KIT_INTERNAL_PORT",
    2571,
    1,
    65_535,
  );
  const adminOriginRaw = env.GAME_MANAGE_KIT_ADMIN_ORIGIN?.trim()
    || (nodeEnv === "production"
      ? required(env, "GAME_MANAGE_KIT_ADMIN_ORIGIN")
      : `http://127.0.0.1:${internalPort}`);

  return {
    nodeEnv,
    mysqlUrl,
    mysqlPoolSize: integer(env, "GAME_MANAGE_KIT_MYSQL_POOL_SIZE", 20, 1, 200),
    publicHost: env.GAME_MANAGE_KIT_PUBLIC_HOST?.trim() || "127.0.0.1",
    publicPort: integer(env, "GAME_MANAGE_KIT_PUBLIC_PORT", 2570, 1, 65_535),
    internalHost: env.GAME_MANAGE_KIT_INTERNAL_HOST?.trim() || "127.0.0.1",
    internalPort,
    adminOrigin: validateAdminOrigin(adminOriginRaw, nodeEnv === "production"),
    trustedProxyCidrs,
    authDevEnabled,
    bodyLimitBytes: integer(env, "GAME_MANAGE_KIT_BODY_LIMIT_BYTES", 65_536, 1_024, 1_048_576),
    requestTimeoutMs: integer(env, "GAME_MANAGE_KIT_REQUEST_TIMEOUT_MS", 10_000, 100, 120_000),
    shutdownTimeoutMs: integer(env, "GAME_MANAGE_KIT_SHUTDOWN_TIMEOUT_MS", 10_000, 100, 120_000),
    serviceVersion: env.SERVICE_VERSION?.trim() || "1.0.0",
    gitSha: env.GIT_SHA?.trim() || "unknown",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    logEnabled: boolean(env, "GAME_MANAGE_KIT_LOG_ENABLED", true),
  };
}
