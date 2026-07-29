import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { loadConfig } from "../../src/config.js";
import {
  DirectoryService,
  validateAreaDirectory,
} from "../../src/domain/directory/service.js";
import { LoginService } from "../../src/domain/account/login.js";
import type { GameContext } from "../../src/domain/game/resolver.js";
import {
  parseAccessToken,
  SessionService,
} from "../../src/domain/session/service.js";
import type { Database } from "../../src/infra/mysql/database.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import {
  matchesAnySecret,
  normalizeIp,
  safeSecretEqual,
  TokenBucketLimiter,
} from "../../src/infra/security/security.js";
import { WechatClient } from "../../src/infra/wechat/client.js";

const BASE_ENV = {
  NODE_ENV: "development",
  GAME_MANAGE_KIT_MYSQL_URL:
    "mysql://root@127.0.0.1:3316/game_manage_kit_test",
  AUTH_DEV_ENABLED: "1",
  GAME_MANAGE_KIT_LOG_ENABLED: "0",
} as const;

const PRODUCTION_MYSQL_URL =
  "mysql://gmk@mysql.example.invalid/game_manage_kit"
  + "?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D";

test("全局配置不再包含游戏配置文件入口并拒绝危险启动配置", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal("gamesConfigPath" in config, false);
  assert.equal(config.authDevEnabled, true);
  assert.equal(config.adminOrigin, "http://127.0.0.1:2571");
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
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      AUTH_DEV_ENABLED: "0",
      GAME_MANAGE_KIT_MYSQL_URL: PRODUCTION_MYSQL_URL,
      GAME_MANAGE_KIT_ADMIN_ORIGIN: "http://admin.example.invalid",
    }),
    /必须使用 https/,
  );
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      AUTH_DEV_ENABLED: "0",
      GAME_MANAGE_KIT_ADMIN_ORIGIN: "https://admin.example.invalid",
    }),
    /ssl 参数/,
  );
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      AUTH_DEV_ENABLED: "0",
      GAME_MANAGE_KIT_MYSQL_URL:
        `${BASE_ENV.GAME_MANAGE_KIT_MYSQL_URL}?ssl=false`,
      GAME_MANAGE_KIT_ADMIN_ORIGIN: "https://admin.example.invalid",
    }),
    /ssl 参数/,
  );
  assert.throws(
    () => loadConfig({
      ...BASE_ENV,
      GAME_MANAGE_KIT_ADMIN_ORIGIN:
        "https://admin.example.invalid/path",
    }),
    /只能包含/,
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
    "game-b.u_123",
    `Game-a.u_123.${"ab".repeat(24)}`,
    `game-a.u_x.${"ab".repeat(24)}`,
    `game-a.u_123.${"ab".repeat(23)}`,
    `game-a.u_123.${"zz".repeat(24)}`,
    `game-a.u_123.${"ab".repeat(24)}.extra`,
  ]) {
    assert.equal(parseAccessToken(invalid), null, invalid);
  }
});

test("Session 校验返回权威过期时刻并在毫秒边界后拒绝", async () => {
  const accessToken = `game-a.u_123.${"ab".repeat(24)}`;
  const issuedAtMs = 1_700_000_000_000;
  const ttlSeconds = 300;
  let nowMs = issuedAtMs + ttlSeconds * 1_000;
  const pool = {
    async query() {
      return [[{
        token_hash: createHash("sha256").update(accessToken).digest("hex"),
        status: 0,
        issued_ms: issuedAtMs,
        now_ms: nowMs,
      }], []];
    },
  } as unknown as Pool;
  const sessions = new SessionService(pool);

  assert.deepEqual(
    await sessions.verify("game-a", ttlSeconds, accessToken, 13),
    {
      valid: true,
      userId: "u_123",
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlSeconds * 1_000,
    },
  );

  nowMs += 1;
  assert.deepEqual(
    await sessions.verify("game-a", ttlSeconds, accessToken, 13),
    { valid: false, reason: "EXPIRED" },
  );
});

test("指标只允许已登记 gameId 与有限标签并按身份范围过滤", () => {
  const metrics = new MetricsRegistry(["game-a", "game-b"]);
  metrics.recordLogin("game-a", "success");
  metrics.recordRateLimit("game-a", "admin");
  metrics.recordIdentityProvider("game-b", "douyin", "provider_error");
  metrics.recordIdentityProviderDuration("game-b", "douyin", 0.25);
  metrics.recordDatabaseDuration("game-a", "login", 0.125);

  const gameA = metrics.renderPrometheus(["game-a"]);
  const gameB = metrics.renderPrometheus(["game-b"]);
  assert.match(gameA, /game_id="game-a"/);
  assert.doesNotMatch(gameA, /game_id="game-b"/);
  assert.match(
    gameB,
    /identity_provider_requests_total\{game_id="game-b",provider="douyin",outcome="provider_error"\} 1/u,
  );
  assert.match(
    gameB,
    /identity_provider_request_duration_seconds_count\{game_id="game-b",provider="douyin"\} 1/u,
  );
  assert.doesNotMatch(
    `${gameA}\n${gameB}`,
    /user_id|token|operation_id|service_id|operator_id|app_id|subject|code|secret/,
  );
  assert.throws(
    () => metrics.recordLogin("missing-game", "success"),
    /指标拒绝未知 gameId/,
  );
  assert.throws(
    () => metrics.recordLogin("game-a", "u_123" as never),
    /指标拒绝未定义 label 值/,
  );
  assert.throws(
    () => metrics.recordIdentityProvider(
      "game-a",
      "douyin",
      "subject-value" as never,
    ),
    /指标拒绝未定义 label 值/,
  );
});

test("DirectoryService 使用当前游戏 TTL 并过滤目录外角色足迹", async () => {
  const servers = [
    {
      serverId: 1,
      name: "一区",
      tag: "normal" as const,
      status: "smooth" as const,
      openTime: 1,
      gameHttpUrl: "https://game.example.invalid/1",
      gameWsUrl: "wss://game.example.invalid/1",
    },
    {
      serverId: 2,
      name: "二区",
      tag: "new" as const,
      status: "busy" as const,
      openTime: 2,
      gameHttpUrl: "https://game.example.invalid/2",
      gameWsUrl: "wss://game.example.invalid/2",
    },
  ];
  const directory = validateAreaDirectory({
    isOps: false,
    servers,
  }, true);
  const game = {
    gameId: "game-a",
    sessionTtlSeconds: 259_200,
    directory: {
      async listAreas() {
        return directory;
      },
    },
  } as unknown as GameContext;
  const service = new DirectoryService(
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

  const result = await service.list(game, "game-a.u_1.token");

  assert.deepEqual(result.myServerIds, [2, 1]);
  assert.deepEqual(
    result.servers.map(({ serverId }) => serverId),
    [1, 2],
  );
});

test("目录校验拒绝不安全 URL，开发仅放行 loopback", () => {
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

test("每个微信 Client 的熔断状态互相隔离", async () => {
  let gameACalls = 0;
  let gameBCalls = 0;
  const redirects: Array<RequestRedirect | undefined> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    redirects.push(init?.redirect);
    const appId = new URL(String(input)).searchParams.get("appid");
    if (appId === "wx-app-a") {
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
  const createClient = (appId: string) => new WechatClient({
    appId,
    secret: `${appId}-secret-value`,
    endpoint: "https://api.weixin.qq.com/sns/jscode2session",
    timeoutMs: 1_000,
    breakerThreshold: 2,
    breakerOpenMs: 10_000,
    fetchImpl,
  });
  const gameA = createClient("wx-app-a");
  const gameB = createClient("wx-app-b");

  assert.deepEqual(
    await gameA.exchange("failure-1"),
    { ok: false, reason: "unavailable" },
  );
  assert.deepEqual(
    await gameA.exchange("failure-2"),
    { ok: false, reason: "unavailable" },
  );
  assert.deepEqual(
    await gameA.exchange("short-circuit"),
    { ok: false, reason: "circuit_open" },
  );
  assert.equal(gameACalls, 2);
  assert.deepEqual(await gameB.exchange("healthy"), {
    ok: true,
    provider: "wechat",
    providerAppId: "wx-app-b",
    subject: "game-b-openid",
    unionSubject: null,
  });
  assert.equal(gameBCalls, 1);
  assert.deepEqual(redirects, ["error", "error", "error"]);
});

test("身份登录仅在事务提交后记录结果指标", async () => {
  const scenarios = [
    { kind: "success", outcome: "success" },
    { kind: "banned", outcome: "banned" },
    { kind: "conflict", outcome: "identity_conflict" },
    { kind: "provider_changed", outcome: "provider_unavailable" },
  ] as const;

  for (const scenario of scenarios) {
    const metrics = new MetricsRegistry(["game-a"]);
    const connection = {
      async query(sql: string, parameters?: readonly unknown[]) {
        if (sql.includes("FROM game_identity_providers")) {
          return scenario.kind === "provider_changed"
            ? [[], []]
            : [[{ enabled: 1, app_id: "wx-app-a" }], []];
        }
        assert.match(sql, /FROM account_identities/u);
        if (scenario.kind === "conflict") {
          return parameters?.[3] === "unionid"
            ? [[{ user_id: "u_2", status: 0 }], []]
            : [[{ user_id: "u_1", status: 0 }], []];
        }
        return [[{
          user_id: "u_1",
          status: scenario.kind === "banned" ? 1 : 0,
        }], []];
      },
      async execute() {
        return [{ affectedRows: 1 }, []];
      },
    };
    let transactionCallbackCompleted = false;
    const database = {
      pool: {
        async execute() {
          return [{ affectedRows: 1 }, []];
        },
      },
      async transaction(
        callback: (value: typeof connection) => Promise<unknown>,
      ) {
        await callback(connection);
        transactionCallbackCompleted = true;
        throw new Error("fixture commit failure");
      },
    } as unknown as Database;
    const sessions = {
      async issue() {
        return {
          accessToken: `game-a.u_1.${"ab".repeat(24)}`,
          issuedAtMs: Date.now(),
        };
      },
    } as unknown as SessionService;
    const login = new LoginService(database, sessions, metrics);
    const game = {
      gameId: "game-a",
      loginLimiter: { allow: () => true },
      wechat: {
        provider: "wechat",
        async exchange() {
          return {
            ok: true,
            provider: "wechat",
            providerAppId: "wx-app-a",
            subject: "fixture-openid",
            unionSubject: scenario.kind === "conflict"
              ? "fixture-unionid"
              : null,
          };
        },
      },
    } as unknown as GameContext;
    const currentAttempt = {
      rateKey: "fixture-rate-key",
      ip: "192.0.2.10",
      deviceId: "fixture-device",
      requestId: `fixture-${scenario.kind}`,
      serverId: 1,
    } as const;
    const operation = scenario.kind === "success"
      || scenario.kind === "banned"
      ? login.loginDev(game, "fixture-key", currentAttempt)
      : login.loginWechat(game, "fixture-code", currentAttempt);

    await assert.rejects(operation, /fixture commit failure/u);

    assert.equal(transactionCallbackCompleted, true, scenario.kind);
    const rendered = metrics.renderPrometheus(["game-a"]);
    assert.doesNotMatch(
      rendered,
      new RegExp(
        `game_manage_kit_login_attempts_total\\{game_id="game-a",outcome="${scenario.outcome}"\\}`,
        "u",
      ),
      scenario.kind,
    );
    assert.match(
      rendered,
      /game_manage_kit_login_attempts_total\{game_id="game-a",outcome="internal_error"\} 1/u,
      scenario.kind,
    );
  }
});
