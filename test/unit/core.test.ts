import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { Pool } from "mysql2/promise";
import { loadConfig } from "../../src/config.js";
import { GameManageKitError } from "../../src/errors.js";
import {
  DirectoryService,
  validateAreaDirectory,
} from "../../src/domain/directory/service.js";
import { GameRegistry } from "../../src/domain/game/registry.js";
import { parseAccessToken } from "../../src/domain/session/service.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import {
  matchesAnySecret,
  normalizeIp,
  safeSecretEqual,
  TokenBucketLimiter,
} from "../../src/infra/security/security.js";

const BASE_ENV = {
  NODE_ENV: "development",
  GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_test",
  GAME_MANAGE_KIT_GAMES_CONFIG: "config/games.json",
  AUTH_DEV_ENABLED: "1",
  GAME_MANAGE_KIT_LOG_ENABLED: "0",
} as const;

const REGISTRY_ENV = {
  GAME_A_WX_APPID: "wx-app-a",
  GAME_A_WX_SECRET: "wx-secret-a-value",
  GAME_B_WX_APPID: "wx-app-b",
  GAME_B_WX_SECRET: "wx-secret-b-value",
  GAME_A_SERVICE_SECRET: "service-secret-a",
  GAME_B_SERVICE_SECRET: "service-secret-b",
  GAME_A_ADMIN_SECRET: "admin-secret-a-value",
  GAME_B_ADMIN_SECRET: "admin-secret-b-value",
} as const;

type RegistryDocument = {
  games: Array<Record<string, unknown>>;
  serviceIdentities: Array<Record<string, unknown>>;
  adminIdentities: Array<Record<string, unknown>>;
};

async function registryDocument(): Promise<RegistryDocument> {
  const document = JSON.parse(
    await readFile("config/games.json", "utf8"),
  ) as RegistryDocument;
  for (const game of document.games) {
    game.directoryPath = resolve("config", String(game.directoryPath));
  }
  return document;
}

async function writeRegistryDocument(
  t: TestContext,
  document: RegistryDocument,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "game-registry-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "games.json");
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}

function assertGameError(
  error: unknown,
  statusCode: number,
  code: string,
): boolean {
  assert.equal(error instanceof GameManageKitError, true);
  assert.equal((error as GameManageKitError).statusCode, statusCode);
  assert.equal((error as GameManageKitError).code, code);
  return true;
}

test("全局配置只保留 GameRegistry 文件入口并拒绝危险启动配置", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.gamesConfigPath, "config/games.json");
  assert.equal(config.authDevEnabled, true);
  assert.equal("serviceSecrets" in config, false);
  assert.equal("wxSecret" in config, false);
  assert.equal(loadConfig({
    ...BASE_ENV,
    AUTH_DEV_ENABLED: undefined,
  }).authDevEnabled, false);

  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      MYSQL_URL: BASE_ENV.GAME_MANAGE_KIT_MYSQL_URL,
    }),
    /不得与游戏库/,
  );
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      AUTH_DEV_ENABLED: "1",
    }),
    /生产环境/,
  );
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      NODE_ENV: "prod",
      AUTH_DEV_ENABLED: undefined,
    }),
    /NODE_ENV 只允许/,
  );
});

test("密钥比较、IP 归一化与令牌桶行为稳定", () => {
  assert.equal(safeSecretEqual("same", "same"), true);
  assert.equal(safeSecretEqual("same", "different"), false);
  assert.equal(matchesAnySecret("previous", ["current", "previous"]), true);
  assert.equal(matchesAnySecret(null, ["current"]), false);

  assert.equal(normalizeIp("127.0.0.1:2570"), "127.0.0.1");
  assert.equal(normalizeIp("[2001:db8::1]:2570"), "2001:db8::1");
  assert.equal(normalizeIp("fe80::1%en0"), null);
  assert.equal(normalizeIp("not-an-ip"), null);

  let nowMs = 1_000;
  const limiter = new TokenBucketLimiter(2, 1, () => nowMs);
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);
  nowMs += 1_000;
  assert.equal(limiter.allow("client"), true);

  const bounded = new TokenBucketLimiter(1, 1, () => nowMs, 2);
  assert.equal(bounded.allow("first"), true);
  assert.equal(bounded.allow("second"), true);
  assert.equal(bounded.allow("third"), false);
  nowMs += 2_000;
  assert.equal(bounded.allow("third"), true);
});

test("访问令牌严格绑定 gameId、userId 和 24 字节随机段", () => {
  const accessToken = `game-a.u_123.${"ab".repeat(24)}`;
  assert.deepEqual(parseAccessToken(accessToken), {
    gameId: "game-a",
    userId: "u_123",
    accessToken,
  });
  for (const invalid of [
    `game-b.u_123`,
    `Game-a.u_123.${"ab".repeat(24)}`,
    `game-a.u_x.${"ab".repeat(24)}`,
    `game-a.u_123.${"ab".repeat(23)}`,
    `game-a.u_123.${"zz".repeat(24)}`,
    `game-a.u_123.${"ab".repeat(24)}.extra`,
  ]) {
    assert.equal(parseAccessToken(invalid), null, invalid);
  }
});

test("指标只允许 Registry gameId 与有限标签并按身份范围过滤", () => {
  const metrics = new MetricsRegistry(["game-a", "game-b"]);
  metrics.recordLogin("game-a", "success");
  metrics.recordRateLimit("game-a", "admin");
  metrics.recordWechat("game-b", "unavailable");
  metrics.recordDatabaseDuration("game-a", "login", 0.125);

  const gameA = metrics.renderPrometheus(["game-a"]);
  assert.match(gameA, /game_id="game-a"/);
  assert.doesNotMatch(gameA, /game_id="game-b"/);
  assert.doesNotMatch(gameA, /user_id|token|operation_id|service_id|operator_id/);
  assert.throws(
    () => metrics.recordLogin("missing-game", "success"),
    /指标拒绝未知 gameId/,
  );
  assert.throws(
    () => metrics.recordLogin("game-a", "u_123" as never),
    /指标拒绝未定义 label 值/,
  );
});

test("GameRegistry 加载两游戏启动快照、身份范围与区服可用性", async () => {
  const registry = await GameRegistry.load("config/games.json", {
    production: true,
    env: REGISTRY_ENV,
  });

  assert.equal(registry.ready(), true);
  assert.deepEqual(registry.list().map((game) => game.gameId), ["game-a", "game-b"]);
  assert.equal(registry.resolve("game-a").sessionTtlSeconds, 259_200);
  assert.notEqual(
    registry.resolve("game-a").wechat,
    registry.resolve("game-b").wechat,
  );
  assert.notEqual(
    registry.resolve("game-a").loginLimiter,
    registry.resolve("game-b").loginLimiter,
  );

  const service = registry.authenticateService("game-a-service", "service-secret-a");
  assert.deepEqual(service, {
    serviceId: "game-a-service",
    gameIds: ["game-a"],
  });
  assert.equal(registry.authenticateService("game-a-service", "wrong"), null);
  assert.equal(service ? registry.canAccess(service, "game-a") : false, true);
  assert.equal(service ? registry.canAccess(service, "game-b") : true, false);

  const admin = registry.authenticateAdmin("game-b-admin", "admin-secret-b-value");
  assert.deepEqual(admin, {
    operatorId: "game-b-admin",
    gameIds: ["game-b"],
  });
  assert.equal(admin ? registry.canAccess(admin, "game-b") : false, true);

  const server = await registry.requireServer("game-a", 1);
  assert.equal(server.name, "A 一区");
  assert.equal(await registry.resolve("game-a").directory.isServerUsable(1), true);
  assert.equal(await registry.resolve("game-a").directory.isServerUsable(9), false);
  await assert.rejects(
    registry.requireServer("game-a", 9),
    (error) => assertGameError(error, 403, "SERVER_DISABLED"),
  );
  await assert.rejects(
    registry.requireServer("game-a", 65_535),
    (error) => assertGameError(error, 404, "SERVER_NOT_FOUND"),
  );
});

test("DirectoryService 使用当前游戏会话参数并过滤目录外角色足迹", async () => {
  const registry = await GameRegistry.load("config/games.json", {
    production: true,
    env: REGISTRY_ENV,
  });
  const game = registry.resolve("game-a");
  const directory = new DirectoryService(
    {
      async verifyAnyZone(gameId, ttlSeconds, accessToken) {
        assert.equal(gameId, "game-a");
        assert.equal(ttlSeconds, 259_200);
        assert.equal(accessToken, "game-a.u_1.token");
        return "u_1";
      },
    },
    {
      async zones(gameId, userId) {
        assert.equal(gameId, "game-a");
        assert.equal(userId, "u_1");
        return [2, 65_535, 1];
      },
    },
  );

  const result = await directory.list(game, "game-a.u_1.token");

  assert.deepEqual(result.myServerIds, [2, 1]);
  assert.deepEqual(result.servers.map((server) => server.serverId), [1, 2, 9]);
});

test("GameRegistry 区分未知、停用和维护中的游戏", async (t) => {
  const document = await registryDocument();
  document.games[0]!.status = "maintenance";
  document.games[1]!.status = "disabled";
  const path = await writeRegistryDocument(t, document);
  const registry = await GameRegistry.load(path, {
    production: true,
    env: REGISTRY_ENV,
  });

  assert.throws(
    () => registry.resolve("missing-game"),
    (error) => assertGameError(error, 404, "GAME_NOT_FOUND"),
  );
  assert.throws(
    () => registry.resolve("game-a"),
    (error) => assertGameError(error, 503, "GAME_DISABLED"),
  );
  assert.throws(
    () => registry.resolve("game-b"),
    (error) => assertGameError(error, 403, "GAME_DISABLED"),
  );
});

test("GameRegistry 拒绝重复 ID、非法 URL、未知权限范围和缺失密钥", async (t) => {
  await assert.rejects(
    GameRegistry.load("config/games.json", {
      production: true,
      env: {
        ...REGISTRY_ENV,
        GAME_B_WX_SECRET: "",
      },
    }),
    /GAME_B_WX_SECRET 缺失/,
  );
  await assert.rejects(
    GameRegistry.load("config/games.json", {
      production: true,
      env: {
        ...REGISTRY_ENV,
        GAME_A_SERVICE_SECRET: "short",
      },
    }),
    /密钥长度必须是 16\.\.512/,
  );

  const duplicate = await registryDocument();
  duplicate.games[1]!.gameId = "game-a";
  await assert.rejects(
    GameRegistry.load(await writeRegistryDocument(t, duplicate), {
      production: true,
      env: REGISTRY_ENV,
    }),
    /gameId 重复: game-a/,
  );

  const invalidUrl = await registryDocument();
  (invalidUrl.games[0]!.wechat as Record<string, unknown>).endpoint =
    "http://wechat.example.invalid/code2session";
  await assert.rejects(
    GameRegistry.load(await writeRegistryDocument(t, invalidUrl), {
      production: true,
      env: REGISTRY_ENV,
    }),
    /必须使用 https/,
  );

  const unknownScope = await registryDocument();
  unknownScope.serviceIdentities[0]!.gameIds = ["missing-game"];
  await assert.rejects(
    GameRegistry.load(await writeRegistryDocument(t, unknownScope), {
      production: true,
      env: REGISTRY_ENV,
    }),
    /引用了未知游戏 missing-game/,
  );
});

test("生产区服目录拒绝不安全协议和 URL 内嵌凭据", () => {
  const server = {
    serverId: 1,
    name: "一区",
    tag: "normal",
    status: "smooth",
    openTime: 1,
    gameHttpUrl: "https://user:password@game.example.invalid",
    gameWsUrl: "wss://game.example.invalid",
  };
  assert.throws(
    () => validateAreaDirectory({ isOps: false, servers: [server] }, true),
    /不允许包含凭证/,
  );
  assert.throws(
    () => validateAreaDirectory({
      isOps: false,
      servers: [{
        ...server,
        gameHttpUrl: "http://game.example.invalid",
      }],
    }, true),
    /必须使用 https/,
  );

  assert.doesNotThrow(() => validateAreaDirectory({
    isOps: false,
    servers: [{
      ...server,
      gameHttpUrl: "http://[::1]:8080",
      gameWsUrl: "ws://[::1]:8081",
    }],
  }, false));
});

test("开发环境允许 IPv6 loopback 微信端点", async (t) => {
  const document = await registryDocument();
  (document.games[0]!.wechat as Record<string, unknown>).endpoint =
    "http://[::1]:8082/code2session";

  await assert.doesNotReject(GameRegistry.load(
    await writeRegistryDocument(t, document),
    {
      production: false,
      env: REGISTRY_ENV,
    },
  ));
});

test("principal 当前与 previous 密钥轮换且不向身份对象暴露 secret", async (t) => {
  const document = await registryDocument();
  document.serviceIdentities[0]!.previousSecretEnv = "GAME_A_SERVICE_SECRET_PREVIOUS";
  const registry = await GameRegistry.load(await writeRegistryDocument(t, document), {
    production: true,
    env: {
      ...REGISTRY_ENV,
      GAME_A_SERVICE_SECRET_PREVIOUS: "service-secret-a-previous",
    },
  });

  assert.deepEqual(
    registry.authenticateService("game-a-service", "service-secret-a-previous"),
    {
      serviceId: "game-a-service",
      gameIds: ["game-a"],
    },
  );
  assert.deepEqual(
    Object.keys(registry.authenticateService("game-a-service", "service-secret-a") ?? {}),
    ["serviceId", "gameIds"],
  );
});

test("两个游戏拥有独立微信熔断状态", async () => {
  let gameACalls = 0;
  let gameBCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("appid") === "wx-app-a") {
      gameACalls += 1;
      throw new Error("game-a upstream down");
    }
    gameBCalls += 1;
    return new Response(JSON.stringify({
      openid: "game-b-openid",
      session_key: "game-b-session",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const registry = await GameRegistry.load("config/games.json", {
    production: true,
    env: REGISTRY_ENV,
    fetchImpl,
  });
  const gameAWechat = registry.resolve("game-a").wechat;
  const gameBWechat = registry.resolve("game-b").wechat;

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(
      await gameAWechat.exchange(`failure-${index}`),
      { ok: false, reason: "wx_unavailable" },
    );
  }
  assert.deepEqual(
    await gameAWechat.exchange("short-circuit"),
    { ok: false, reason: "wx_unavailable" },
  );
  assert.equal(gameACalls, 5);

  assert.deepEqual(await gameBWechat.exchange("still-healthy"), {
    ok: true,
    openid: "game-b-openid",
    unionid: null,
    sessionKey: "game-b-session",
  });
  assert.equal(gameBCalls, 1);
});

test("GameRegistry sync 幂等写入 games 与每游戏序列", async () => {
  const registry = await GameRegistry.load("config/games.json", {
    production: true,
    env: REGISTRY_ENV,
  });
  const statements: Array<{ sql: string; params: unknown }> = [];
  let began = false;
  let committed = false;
  let released = false;
  const connection = {
    async beginTransaction() {
      began = true;
    },
    async query() {
      return [[], []];
    },
    async execute(sql: string, params: unknown) {
      statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    },
    async commit() {
      committed = true;
    },
    async rollback() {},
    release() {
      released = true;
    },
  };
  const pool = {
    async getConnection() {
      return connection;
    },
  } as unknown as Pool;

  await registry.sync(pool);

  assert.equal(began, true);
  assert.equal(committed, true);
  assert.equal(released, true);
  assert.equal(statements.length, 4);
  assert.deepEqual(statements.map(({ params }) => params), [
    ["game-a", "enabled"],
    ["game-a"],
    ["game-b", "enabled"],
    ["game-b"],
  ]);
  assert.equal(statements[0]?.sql.includes("INSERT INTO games"), true);
  assert.equal(statements[1]?.sql.includes("INSERT INTO seq"), true);
});

test("GameRegistry sync 拒绝遗漏历史游戏或重新启用 disabled gameId", async () => {
  const registry = await GameRegistry.load("config/games.json", {
    production: true,
    env: REGISTRY_ENV,
  });
  const poolWithRows = (rows: Array<{ game_id: string; status: string }>) => ({
    async getConnection() {
      return {
        async beginTransaction() {},
        async query() {
          return [rows, []];
        },
        async execute() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  }) as unknown as Pool;

  await assert.rejects(
    registry.sync(poolWithRows([
      { game_id: "game-a", status: "enabled" },
      { game_id: "retired-game", status: "disabled" },
    ])),
    /游戏配置缺少已登记 gameId retired-game/,
  );
  await assert.rejects(
    registry.sync(poolWithRows([
      { game_id: "game-a", status: "disabled" },
      { game_id: "game-b", status: "enabled" },
    ])),
    /已停用 gameId 不允许重新启用: game-a/,
  );
});
