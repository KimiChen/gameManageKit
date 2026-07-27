import assert from "node:assert/strict";
import test from "node:test";
import type { AreaListResponse, LoginResponse } from "@gono/game-manage-kit-contract";
import { buildApps, type GameManageKitServices } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const LOGIN: LoginResponse = {
  userId: "u_1",
  accessToken: "u_1.0123456789abcdef",
  isNewAccount: true,
};

const AREAS: AreaListResponse = {
  isOps: false,
  hash: "hash",
  servers: [
    {
      serverId: 1,
      name: "一区",
      tag: "normal",
      status: "smooth",
      openTime: 1_700_000_000,
      gameHttpUrl: "http://127.0.0.1:2568",
      gameWsUrl: "ws://127.0.0.1:2568",
    },
  ],
  myServerIds: [],
};

function services(): GameManageKitServices {
  return {
    login: {
      async loginWechat() {
        return { ok: true, response: LOGIN };
      },
      async loginDev() {
        return { ok: true, response: LOGIN };
      },
    },
    directory: {
      async list() {
        return AREAS;
      },
    },
    sessions: {
      async verify() {
        return { valid: true, userId: "u_1", issuedAtMs: 1_700_000_000_000 };
      },
    },
    characters: {
      async register() {},
      async has() {
        return true;
      },
    },
    admin: {
      async execute(input) {
        return {
          accountExists: true,
          status: input.action === "ban" ? "banned" : "revoked",
        };
      },
    },
    adminLimiter: {
      allow() {
        return true;
      },
    },
    readiness: {
      async ready() {
        return true;
      },
    },
  };
}

test("public/internal 双监听只暴露各自业务路由", async (t) => {
  const config = loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_test",
    GAME_MANAGE_KIT_SERVICE_SECRET: "service-current",
    GAME_MANAGE_KIT_SERVICE_SECRET_PREVIOUS: "service-previous",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin-current",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const apps = buildApps(config, services());
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const publicLogin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/sessions/dev",
    payload: { devKey: "route-test", serverId: 1 },
  });
  assert.equal(publicLogin.statusCode, 200);
  assert.deepEqual(publicLogin.json(), LOGIN);

  const hiddenInternal = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/internal/sessions/verify",
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(hiddenInternal.statusCode, 404);

  const hiddenAdmin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/admin/accounts/u_1/ban",
    payload: { operationId: "op-1", reason: "test" },
  });
  assert.equal(hiddenAdmin.statusCode, 404);

  const hiddenPublic = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/sessions/dev",
    payload: { devKey: "route-test", serverId: 1 },
  });
  assert.equal(hiddenPublic.statusCode, 404);

  const unauthenticated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/internal/sessions/verify",
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().code, "SERVICE_AUTH_REQUIRED");

  const authenticated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/internal/sessions/verify",
    headers: {
      "x-service-id": "game-server",
      "x-service-secret": "service-previous",
    },
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.json().valid, true);

  const admin = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/accounts/u_1/revoke",
    headers: {
      "x-operator-id": "gm-test",
      "x-admin-secret": "admin-current",
    },
    payload: { operationId: "op-2", reason: "test" },
  });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.json().status, "revoked");

  for (const app of [apps.publicApp, apps.internalApp]) {
    const live = await app.inject({ method: "GET", url: "/livez" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { ok: true });

    const version = await app.inject({ method: "GET", url: "/version" });
    assert.equal(version.statusCode, 200);
    assert.equal(version.json().service, "game-manage-kit");
  }
});

test("生产环境不注册 dev-login 路由", async (t) => {
  const config = loadConfig({
    NODE_ENV: "production",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_test",
    GAME_MANAGE_KIT_SERVICE_SECRET: "service-current",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin-current",
    WX_APPID: "production-app",
    WX_SECRET: "production-secret",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const apps = buildApps(config, services());
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const response = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/sessions/dev",
    payload: { devKey: "must-not-exist", serverId: 1 },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "NOT_FOUND");
});

test("未映射异常只返回统一错误，不泄漏内部文本", async (t) => {
  const config = loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root:database-password@127.0.0.1:3316/game_manage_kit_test",
    GAME_MANAGE_KIT_SERVICE_SECRET: "service-current",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin-current",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const failingServices: GameManageKitServices = {
    ...services(),
    directory: {
      async list() {
        throw new Error(
          "mysql://root:database-password@127.0.0.1/private accessToken=secret-token",
        );
      },
    },
  };
  const apps = buildApps(config, failingServices);
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const response = await apps.publicApp.inject({ method: "GET", url: "/v1/areas" });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "INTERNAL");
  assert.equal(response.body.includes("database-password"), false);
  assert.equal(response.body.includes("secret-token"), false);
});

test("Admin 使用独立令牌桶，限流时不执行领域写入", async (t) => {
  const config = loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_test",
    GAME_MANAGE_KIT_SERVICE_SECRET: "service-current",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin-current",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  let executed = false;
  const limitedServices: GameManageKitServices = {
    ...services(),
    admin: {
      async execute() {
        executed = true;
        return { accountExists: true, status: "banned" };
      },
    },
    adminLimiter: {
      allow() {
        return false;
      },
    },
  };
  const apps = buildApps(config, limitedServices);
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const response = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/accounts/u_1/ban",
    headers: {
      "x-operator-id": "gm-test",
      "x-admin-secret": "admin-current",
    },
    payload: { operationId: "limited-op", reason: "test" },
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, "RATE_LIMITED");
  assert.equal(executed, false);

  const publicLogin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/sessions/dev",
    payload: { devKey: "still-independent", serverId: 1 },
  });
  assert.equal(publicLogin.statusCode, 200);
});
