import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import {
  GameConfigResolver,
} from "../../src/domain/game/resolver.js";
import { GameManageKitError } from "../../src/errors.js";

const WECHAT_ENDPOINT =
  "https://api.weixin.qq.com/sns/jscode2session";
const DOUYIN_ENDPOINT =
  "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session";

const compact = (sql: string): string => sql.replace(/\s+/gu, " ").trim();

function configuredRow(overrides: Record<string, unknown> = {}) {
  return {
    game_id: "game-a",
    name: "游戏 A",
    status: "enabled",
    configuration_state: "configured",
    game_revision: 1,
    session_ttl_seconds: 259_200,
    login_rate_capacity: 5,
    login_rate_refill_per_second: "0.200000",
    admin_rate_capacity: 10,
    admin_rate_refill_per_second: "1.000000",
    integration_revision: 1,
    directory_revision: 1,
    ...overrides,
  };
}

function providerRow(
  provider: "wechat" | "douyin",
  overrides: Record<string, unknown> = {},
) {
  return {
    integration_revision: 1,
    provider,
    enabled: 1,
    app_id: provider === "wechat" ? "wx-app-a" : "tt-app-a",
    app_secret: `${provider}-secret-v1`,
    secret_version: 1,
    endpoint: provider === "wechat"
      ? WECHAT_ENDPOINT
      : DOUYIN_ENDPOINT,
    timeout_ms: 3_000,
    breaker_threshold: 5,
    breaker_open_ms: 10_000,
    validation_state: "unvalidated",
    ...overrides,
  };
}

function missingProviderRow(integrationRevision = 1) {
  return {
    integration_revision: integrationRevision,
    provider: null,
    enabled: null,
    app_id: null,
    app_secret: null,
    secret_version: null,
    endpoint: null,
    timeout_ms: null,
    breaker_threshold: null,
    breaker_open_ms: null,
    validation_state: null,
  };
}

test("GameConfigResolver 允许零游戏启动并就绪", async () => {
  const pool = {
    async query(rawSql: string) {
      const sql = compact(rawSql);
      assert.match(sql, /FROM games/u);
      return [[], []];
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
  });

  await resolver.initialize();

  assert.equal(resolver.ready(), true);
  assert.deepEqual(resolver.list(), []);
  await assert.rejects(
    resolver.resolve("missing-game"),
    (error: unknown) => (
      error instanceof GameManageKitError
      && error.statusCode === 404
      && error.code === "GAME_NOT_FOUND"
    ),
  );
});

test("Resolver 延迟读取两个 Provider Secret 并附加安全版本", async () => {
  const rows = {
    wechat: providerRow("wechat"),
    douyin: providerRow("douyin"),
  };
  let configurationReads = 0;
  const providerReads: string[] = [];
  const validationUpdates: string[] = [];
  const requestedSecrets: string[] = [];
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        assert.doesNotMatch(sql, /app_secret/u);
        configurationReads += 1;
        return [[configuredRow()], []];
      }
      if (sql.includes("game_identity_providers")) {
        const provider = String(values[0]) as keyof typeof rows;
        assert.equal(values[1], "game-a");
        providerReads.push(provider);
        return [[{ ...rows[provider] }], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
    async execute(rawSql: string, values: readonly unknown[]) {
      const sql = compact(rawSql);
      const provider = String(values[1]) as keyof typeof rows;
      assert.deepEqual(values, ["game-a", provider, 1]);
      assert.match(sql, /SET p\.validation_state = 'active'/u);
      rows[provider].validation_state = "active";
      validationUpdates.push(provider);
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requestedSecrets.push(url.searchParams.get("secret") ?? "");
      return url.hostname === "api.weixin.qq.com"
        ? new Response(JSON.stringify({
            openid: "wechat-openid",
            session_key: "wechat-session",
          }))
        : new Response(JSON.stringify({
            error: 0,
            openid: "douyin-openid",
            session_key: "douyin-session",
          }));
    },
  });

  await resolver.initialize();
  assert.equal(configurationReads, 1);
  assert.deepEqual(providerReads, []);

  const game = await resolver.resolve("game-a");
  assert.equal(game.wechat.provider, "wechat");
  assert.equal(game.douyin.provider, "douyin");
  const [wechat, douyin] = await Promise.all([
    game.wechat.exchange("wechat-code"),
    game.douyin.exchange("douyin-code"),
  ]);
  assert.equal(wechat.ok && wechat.providerVersion, 1);
  assert.equal(douyin.ok && douyin.providerVersion, 1);
  assert.deepEqual(providerReads.sort(), ["douyin", "wechat"]);
  assert.deepEqual(requestedSecrets.sort(), [
    "douyin-secret-v1",
    "wechat-secret-v1",
  ]);
  assert.deepEqual(validationUpdates.sort(), ["douyin", "wechat"]);

  await Promise.all([
    game.wechat.exchange("wechat-code-2"),
    game.douyin.exchange("douyin-code-2"),
  ]);
  assert.equal(providerReads.length, 2);
  assert.equal(validationUpdates.length, 2);
});

test("禁用、缺失或不完整 Provider 快速返回 unavailable", async () => {
  let fetchCalls = 0;
  const providerReads: string[] = [];
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        return [[configuredRow()], []];
      }
      if (sql.includes("game_identity_providers")) {
        const provider = String(values[0]);
        providerReads.push(provider);
        return provider === "wechat"
          ? [[providerRow("wechat", { enabled: 0 })], []]
          : [[missingProviderRow()], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("不应调用 Provider");
    },
  });
  await resolver.initialize();
  const game = await resolver.resolve("game-a");

  assert.deepEqual(await game.wechat.exchange("code"), {
    ok: false,
    reason: "unavailable",
    providerVersion: 1,
  });
  assert.deepEqual(await game.douyin.exchange("code"), {
    ok: false,
    reason: "unavailable",
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(providerReads.sort(), ["douyin", "wechat"]);
});

test("只有 invalid_credentials 标记失败，成功激活且 invalid_code 不污染", async () => {
  const rows = {
    wechat: providerRow("wechat"),
    douyin: providerRow("douyin"),
  };
  let wechatSuccess = false;
  let wechatCalls = 0;
  let douyinCalls = 0;
  const validationUpdates: Array<{
    provider: string;
    state: string;
  }> = [];
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        return [[configuredRow()], []];
      }
      if (sql.includes("game_identity_providers")) {
        const provider = String(values[0]) as keyof typeof rows;
        return [[{ ...rows[provider] }], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
    async execute(rawSql: string, values: readonly unknown[]) {
      const sql = compact(rawSql);
      const provider = String(values[1]) as keyof typeof rows;
      assert.deepEqual(values, ["game-a", provider, 1]);
      const state = sql.includes("'validation_failed'")
        ? "validation_failed"
        : "active";
      rows[provider].validation_state = state;
      validationUpdates.push({ provider, state });
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.weixin.qq.com") {
        wechatCalls += 1;
        return new Response(JSON.stringify(
          wechatSuccess
            ? {
                openid: "wechat-openid",
                session_key: "wechat-session",
              }
            : { errcode: 40_029, errmsg: "invalid code" },
        ));
      }
      douyinCalls += 1;
      return new Response(JSON.stringify({
        error: 40_017,
        message: "invalid secret",
      }));
    },
  });
  await resolver.initialize();
  const game = await resolver.resolve("game-a");

  assert.deepEqual(await game.wechat.exchange("invalid-code"), {
    ok: false,
    reason: "invalid_code",
    providerVersion: 1,
  });
  assert.deepEqual(validationUpdates, []);

  wechatSuccess = true;
  const wechat = await game.wechat.exchange("valid-code");
  assert.equal(wechat.ok && wechat.providerVersion, 1);
  assert.deepEqual(validationUpdates, [{
    provider: "wechat",
    state: "active",
  }]);

  assert.deepEqual(await game.douyin.exchange("bad-credentials"), {
    ok: false,
    reason: "invalid_credentials",
    providerVersion: 1,
  });
  assert.deepEqual(await game.douyin.exchange("fast-failure"), {
    ok: false,
    reason: "invalid_credentials",
    providerVersion: 1,
  });
  assert.equal(wechatCalls, 2);
  assert.equal(douyinCalls, 1);
  assert.deepEqual(validationUpdates, [
    { provider: "wechat", state: "active" },
    { provider: "douyin", state: "validation_failed" },
  ]);
});

test("数据库中的 validation_failed 快速阻断且不影响另一 Provider", async () => {
  let fetchCalls = 0;
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        return [[configuredRow()], []];
      }
      if (sql.includes("game_identity_providers")) {
        return String(values[0]) === "wechat"
          ? [[providerRow("wechat", {
              validation_state: "validation_failed",
            })], []]
          : [[providerRow("douyin", {
              validation_state: "active",
            })], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        error: 0,
        openid: "douyin-openid",
        session_key: "douyin-session",
      }));
    },
  });
  await resolver.initialize();
  const game = await resolver.resolve("game-a");

  assert.deepEqual(await game.wechat.exchange("code"), {
    ok: false,
    reason: "invalid_credentials",
    providerVersion: 1,
  });
  assert.equal((await game.douyin.exchange("code")).ok, true);
  assert.equal(fetchCalls, 1);
});

test("Provider 缓存 TTL 发现其他实例写入的 validation_failed", async () => {
  let nowMs = 1_000;
  let validationState = "active";
  let providerReads = 0;
  let fetchCalls = 0;
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        return [[configuredRow()], []];
      }
      if (sql.includes("game_identity_providers")) {
        providerReads += 1;
        assert.equal(values[0], "wechat");
        return [[providerRow("wechat", {
          validation_state: validationState,
        })], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    cacheTtlMs: 100,
    now: () => nowMs,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        openid: "wechat-openid",
        session_key: "wechat-session",
      }));
    },
  });
  await resolver.initialize();
  const game = await resolver.resolve("game-a");
  assert.equal((await game.wechat.exchange("first")).ok, true);
  assert.equal(providerReads, 1);
  assert.equal(fetchCalls, 1);

  validationState = "validation_failed";
  nowMs += 101;
  assert.equal(await resolver.resolve("game-a"), game);
  assert.deepEqual(await game.wechat.exchange("second"), {
    ok: false,
    reason: "invalid_credentials",
    providerVersion: 1,
  });
  assert.equal(providerReads, 2);
  assert.equal(fetchCalls, 1);
});

test("本地仅失效变更 Provider，另一 Provider 的熔断状态保持隔离", async () => {
  let integrationRevision = 1;
  let douyinVersion = 1;
  let wechatCalls = 0;
  const douyinSecrets: string[] = [];
  const pool = {
    async query(rawSql: string, values: readonly unknown[] = []) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g")) {
        return [[configuredRow({
          game_revision: integrationRevision,
          integration_revision: integrationRevision,
        })], []];
      }
      if (sql.includes("game_identity_providers")) {
        const provider = String(values[0]);
        return provider === "wechat"
          ? [[providerRow("wechat", {
              integration_revision: integrationRevision,
              validation_state: "active",
              breaker_threshold: 1,
            })], []]
          : [[providerRow("douyin", {
              integration_revision: integrationRevision,
              app_id: `tt-app-v${douyinVersion}`,
              app_secret: `douyin-secret-v${douyinVersion}`,
              secret_version: douyinVersion,
              validation_state: "active",
            })], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.weixin.qq.com") {
        wechatCalls += 1;
        throw new Error("微信故障");
      }
      douyinSecrets.push(url.searchParams.get("secret") ?? "");
      return new Response(JSON.stringify({
        error: 0,
        openid: "douyin-openid",
        session_key: "douyin-session",
      }));
    },
  });
  await resolver.initialize();
  const first = await resolver.resolve("game-a");
  assert.deepEqual(await first.wechat.exchange("fault"), {
    ok: false,
    reason: "unavailable",
    providerVersion: 1,
  });
  assert.equal((await first.douyin.exchange("v1")).ok, true);

  integrationRevision = 2;
  douyinVersion = 2;
  resolver.invalidate("game-a", "douyin");
  const second = await resolver.resolve("game-a");
  assert.deepEqual(resolver.loadedRevision("game-a"), {
    game: 2,
    integration: 2,
    directory: 1,
  });
  assert.deepEqual(await second.wechat.exchange("still-open"), {
    ok: false,
    reason: "circuit_open",
    providerVersion: 1,
  });
  const douyin = await second.douyin.exchange("v2");
  assert.equal(douyin.ok && douyin.providerAppId, "tt-app-v2");
  assert.equal(douyin.ok && douyin.providerVersion, 2);
  assert.equal(wechatCalls, 1);
  assert.deepEqual(douyinSecrets, [
    "douyin-secret-v1",
    "douyin-secret-v2",
  ]);
  assert.deepEqual(await first.douyin.exchange("stale-context"), {
    ok: false,
    reason: "unavailable",
  });
});

test("生产仅允许对应官方 endpoint，开发额外允许 loopback", async () => {
  const createResolver = (
    production: boolean,
    endpoint: string,
    fetchCounter: { count: number },
  ) => {
    const pool = {
      async query(rawSql: string, values: readonly unknown[] = []) {
        const sql = compact(rawSql);
        if (sql.startsWith("SELECT game_id FROM games")) {
          return [[{ game_id: "game-a" }], []];
        }
        if (sql.includes("FROM games g")) {
          return [[configuredRow()], []];
        }
        if (sql.includes("game_identity_providers")) {
          assert.equal(values[0], "douyin");
          return [[providerRow("douyin", {
            endpoint,
            validation_state: "active",
          })], []];
        }
        throw new Error(`未实现 query: ${sql}`);
      },
    } as unknown as Pool;
    return new GameConfigResolver(pool, {
      production,
      fetchImpl: async () => {
        fetchCounter.count += 1;
        return new Response(JSON.stringify({
          error: 0,
          openid: "douyin-openid",
          session_key: "douyin-session",
        }));
      },
    });
  };

  const productionFetch = { count: 0 };
  const production = createResolver(
    true,
    "http://127.0.0.1:8787/mock",
    productionFetch,
  );
  await production.initialize();
  assert.deepEqual(
    await (await production.resolve("game-a")).douyin.exchange("code"),
    { ok: false, reason: "unavailable", providerVersion: 1 },
  );
  assert.equal(productionFetch.count, 0);

  for (const officialVariant of [
    "https://%6Diniga%6De.zijieapi.com/mgplatform/api/apps/jscode2session",
    "https://minigame.zijieapi.com:443/mgplatform/api/apps/jscode2session",
  ]) {
    const variantFetch = { count: 0 };
    const variant = createResolver(
      true,
      officialVariant,
      variantFetch,
    );
    await variant.initialize();
    assert.equal(
      (
        await (await variant.resolve("game-a"))
          .douyin.exchange("code")
      ).ok,
      true,
    );
    assert.equal(variantFetch.count, 1);
  }

  const developmentFetch = { count: 0 };
  const development = createResolver(
    false,
    "http://127.0.0.1:8787/mock",
    developmentFetch,
  );
  await development.initialize();
  assert.equal(
    (
      await (await development.resolve("game-a"))
        .douyin.exchange("code")
    ).ok,
    true,
  );
  assert.equal(developmentFetch.count, 1);
});

test("Resolver 通过短 TTL 发现游戏状态更新且并发只刷新一次", async () => {
  let nowMs = 1_000;
  let row = configuredRow();
  let reads = 0;
  const pool = {
    async query(rawSql: string) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[], []];
      }
      if (sql.includes("FROM games g")) {
        reads += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return [[row], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    cacheTtlMs: 100,
    now: () => nowMs,
  });
  await resolver.initialize();

  await Promise.all([
    resolver.resolve("game-a"),
    resolver.resolve("game-a"),
    resolver.resolve("game-a"),
  ]);
  assert.equal(reads, 1);

  row = configuredRow({
    status: "maintenance",
    game_revision: 2,
  });
  nowMs += 101;
  const results = await Promise.allSettled([
    resolver.resolve("game-a"),
    resolver.resolve("game-a"),
  ]);
  assert.equal(reads, 2);
  assert.equal(results.every((result) => (
    result.status === "rejected"
    && result.reason instanceof GameManageKitError
    && result.reason.statusCode === 503
  )), true);
});

test("机器鉴权只比较摘要，按类型隔离并返回数据库授权范围", async () => {
  const currentSecret = "machine-secret-current";
  const digest = createHash("sha256")
    .update(currentSecret, "utf8")
    .digest();
  let revoked = false;
  let lastUsedUpdates = 0;
  const pool = {
    async query(rawSql: string, values: readonly unknown[]) {
      const sql = compact(rawSql);
      if (sql.includes("FROM machine_identities")) {
        assert.match(sql, /i\.identity_type = \?/u);
        assert.match(sql, /s\.state = 'current'/u);
        assert.match(sql, /s\.state = 'previous'/u);
        assert.match(sql, /s\.expires_at > NOW\(3\)/u);
        assert.equal(values[0], "service-a");
        if (values[1] !== "service") {
          return [[], []];
        }
        return [[
          {
            identity_id: "service-a",
            game_id: "game-a",
            version: 2,
            secret_digest: digest,
            usable: revoked ? 0 : 1,
          },
          {
            identity_id: "service-a",
            game_id: "game-b",
            version: 2,
            secret_digest: digest,
            usable: revoked ? 0 : 1,
          },
        ], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
    async execute(rawSql: string, values: readonly unknown[]) {
      const sql = compact(rawSql);
      assert.match(
        sql,
        /UPDATE machine_secret_versions SET last_used_at/u,
      );
      assert.deepEqual(values, ["service-a", 2]);
      lastUsedUpdates += 1;
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
  });

  assert.deepEqual(
    await resolver.authenticateService("service-a", currentSecret),
    {
      serviceId: "service-a",
      gameIds: ["game-a", "game-b"],
    },
  );
  assert.equal(lastUsedUpdates, 1);
  assert.equal(
    await resolver.authenticateService("service-a", "wrong-secret-value"),
    null,
  );
  assert.equal(
    await resolver.authenticateAdmin("service-a", currentSecret),
    null,
  );

  revoked = true;
  assert.equal(
    await resolver.authenticateService("service-a", currentSecret),
    null,
  );
  assert.equal(lastUsedUpdates, 2);
});
