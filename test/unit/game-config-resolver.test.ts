import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import {
  GameConfigResolver,
} from "../../src/domain/game/resolver.js";
import { GameManageKitError } from "../../src/errors.js";

const compact = (sql: string): string => sql.replace(/\s+/gu, " ").trim();

function configuredRow(overrides: Record<string, unknown> = {}) {
  return {
    game_id: "game-a",
    name: "游戏 A",
    status: "enabled",
    configuration_state: "configured",
    game_revision: 1,
    wechat_app_id: "wx-app-a",
    wechat_endpoint: "https://api.weixin.qq.com/sns/jscode2session",
    wechat_timeout_ms: 3_000,
    wechat_breaker_threshold: 5,
    wechat_breaker_open_ms: 10_000,
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

test("Resolver 延迟读取微信 Secret，本地失效后按 revision 重建 Client", async () => {
  let row = configuredRow();
  let secret = "wechat-secret-v1";
  let secretVersion = 1;
  let configurationReads = 0;
  let secretReads = 0;
  const requestedSecrets: string[] = [];
  const pool = {
    async query(rawSql: string) {
      const sql = compact(rawSql);
      if (sql.startsWith("SELECT game_id FROM games")) {
        return [[{ game_id: "game-a" }], []];
      }
      if (sql.includes("FROM games g") && sql.includes("game_revision")) {
        configurationReads += 1;
        return [[row], []];
      }
      if (sql.includes("wechat_app_secret")) {
        secretReads += 1;
        return [[{
          wechat_app_id: "wx-app-a",
          wechat_app_secret: secret,
          wechat_endpoint:
            "https://api.weixin.qq.com/sns/jscode2session",
          wechat_timeout_ms: 3_000,
          wechat_breaker_threshold: 5,
          wechat_breaker_open_ms: 10_000,
          wechat_secret_version: secretVersion,
          revision: row.integration_revision,
        }], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const resolver = new GameConfigResolver(pool, {
    production: true,
    fetchImpl: async (input) => {
      requestedSecrets.push(
        new URL(String(input)).searchParams.get("secret") ?? "",
      );
      return new Response(JSON.stringify({
        openid: "openid-a",
        session_key: "session-a",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await resolver.initialize();
  assert.equal(configurationReads, 1);
  assert.equal(secretReads, 0);

  const first = await resolver.resolve("game-a");
  assert.equal(secretReads, 0);
  assert.equal((await first.wechat.exchange("code-v1")).ok, true);
  assert.equal(secretReads, 1);
  assert.deepEqual(requestedSecrets, ["wechat-secret-v1"]);

  row = configuredRow({
    game_revision: 2,
    integration_revision: 2,
  });
  secret = "wechat-secret-v2";
  secretVersion = 2;
  resolver.invalidate("game-a");
  const second = await resolver.resolve("game-a");
  assert.deepEqual(resolver.loadedRevision("game-a"), {
    game: 2,
    integration: 2,
    directory: 1,
  });
  assert.notEqual(second.wechat, first.wechat);
  assert.equal((await second.wechat.exchange("code-v2")).ok, true);
  assert.equal(secretReads, 2);
  assert.deepEqual(requestedSecrets, [
    "wechat-secret-v1",
    "wechat-secret-v2",
  ]);
});

test("Resolver 通过短 TTL 发现其他实例状态更新且并发只刷新一次", async () => {
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
        return [revoked
          ? []
          : [
              {
                identity_id: "service-a",
                game_id: "game-a",
                version: 2,
                secret_digest: digest,
              },
              {
                identity_id: "service-a",
                game_id: "game-b",
                version: 2,
                secret_digest: digest,
              },
            ], []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
    async execute(rawSql: string, values: readonly unknown[]) {
      assert.match(
        compact(rawSql),
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
});
