import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  matchesAnySecret,
  normalizeIp,
  safeSecretEqual,
  TokenBucketLimiter,
} from "../../src/infra/security/security.js";
import { WechatClient } from "../../src/infra/wechat/client.js";

const BASE_ENV = {
  NODE_ENV: "development",
  GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_test",
  GAME_MANAGE_KIT_SERVICE_SECRET: "service-current",
  GAME_MANAGE_KIT_SERVICE_SECRET_PREVIOUS: "service-previous",
  GAME_MANAGE_KIT_ADMIN_SECRET: "admin-current",
  GAME_MANAGE_KIT_ADMIN_SECRET_PREVIOUS: "admin-previous",
  AUTH_DEV_ENABLED: "1",
  GAME_MANAGE_KIT_LOG_ENABLED: "0",
} as const;

test("配置拒绝游戏库复用与生产 dev-login", () => {
  const config = loadConfig(BASE_ENV);
  assert.deepEqual(config.serviceSecrets, ["service-current", "service-previous"]);
  assert.deepEqual(config.adminSecrets, ["admin-current", "admin-previous"]);
  assert.equal(config.authDevEnabled, true);

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
      WX_APPID: "app",
      WX_SECRET: "secret",
    }),
    /生产环境/,
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
});

test("微信客户端映射错误并在连续上游故障后熔断", async () => {
  let calls = 0;
  let nowMs = 10_000;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("upstream down");
  };
  const client = new WechatClient({
    appId: "app",
    secret: "secret",
    endpoint: "https://api.example.test/code2session",
    timeoutMs: 500,
    breakerThreshold: 2,
    breakerOpenMs: 1_000,
    fetchImpl,
    now: () => nowMs,
  });

  assert.deepEqual(await client.exchange("first"), { ok: false, reason: "wx_unavailable" });
  assert.deepEqual(await client.exchange("second"), { ok: false, reason: "wx_unavailable" });
  assert.deepEqual(await client.exchange("short-circuit"), { ok: false, reason: "wx_unavailable" });
  assert.equal(calls, 2);

  nowMs += 1_001;
  assert.deepEqual(await client.exchange("half-open"), { ok: false, reason: "wx_unavailable" });
  assert.equal(calls, 3);
});
