import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import {
  buildApps,
  type GameManageKitServices,
} from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { GameRegistry } from "../../src/domain/game/registry.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";

const GAME_ENV = {
  GAME_A_WX_APPID: "game-a-app",
  GAME_A_WX_SECRET: "game-a-wx-secret",
  GAME_B_WX_APPID: "game-b-app",
  GAME_B_WX_SECRET: "game-b-wx-secret",
  GAME_A_SERVICE_SECRET: "game-a-service-secret",
  GAME_B_SERVICE_SECRET: "game-b-service-secret",
  GAME_A_ADMIN_SECRET: "game-a-admin-secret",
  GAME_B_ADMIN_SECRET: "game-b-admin-secret",
} as const;

const ORIGIN = "http://127.0.0.1:2571";
const TOKEN = Buffer.alloc(32, 0x41).toString("base64url");
const COOKIE = `gmk_admin_session=${TOKEN}`;

interface Calls {
  login: number;
  authenticate: number;
  logout: number;
  operationAuthorization: number;
  queryAuthorization: number;
  execute: Array<Record<string, unknown>>;
  denied: Array<Record<string, unknown>>;
}

async function fixture() {
  const config = loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://root@127.0.0.1:3316/game_manage_kit_admin_http",
    GAME_MANAGE_KIT_GAMES_CONFIG: "config/games.json",
    GAME_MANAGE_KIT_ADMIN_ORIGIN: ORIGIN,
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const games = await GameRegistry.load(config.gamesConfigPath, {
    production: false,
    env: GAME_ENV,
  });
  const calls: Calls = {
    login: 0,
    authenticate: 0,
    logout: 0,
    operationAuthorization: 0,
    queryAuthorization: 0,
    execute: [],
    denied: [],
  };
  const identity = {
    operatorId: "ops_kimi",
    displayName: "Kimi",
    authVersion: 1,
    games: [{ gameId: "game-a", canOperateAccounts: true }],
    expiresAt: "2026-07-28T18:00:00.000Z",
  } as const;
  const services: GameManageKitServices = {
    games,
    metrics: new MetricsRegistry(games.list().map((game) => game.gameId)),
    login: {
      async loginWechat() {
        return {
          ok: true,
          response: { userId: "u_1", accessToken: "token", isNewAccount: true },
        };
      },
      async loginDev() {
        return {
          ok: true,
          response: { userId: "u_1", accessToken: "token", isNewAccount: true },
        };
      },
    },
    directory: {
      async list() {
        return { isOps: false, hash: "hash", servers: [], myServerIds: [] };
      },
    },
    sessions: {
      async verify() {
        return { valid: false, reason: "MISMATCH" };
      },
    },
    characters: {
      async register() {},
      async has() {
        return false;
      },
    },
    adminAuth: {
      async login() {
        calls.login += 1;
        return { ...identity, sessionToken: TOKEN };
      },
      async authenticate(token) {
        assert.equal(token, TOKEN);
        calls.authenticate += 1;
        return identity;
      },
      async logout(token) {
        assert.equal(token, TOKEN);
        calls.logout += 1;
      },
      async requireAccountOperation(_connection, current, gameId) {
        assert.equal(current, identity);
        assert.equal(gameId, "game-a");
        calls.operationAuthorization += 1;
      },
      async requireGameAccess(_connection, current, gameId) {
        assert.equal(current, identity);
        assert.equal(gameId, "game-a");
        calls.queryAuthorization += 1;
      },
    },
    admin: {
      async find(input) {
        assert.equal(input.caller, "admin-web");
        await input.authorize?.({} as PoolConnection);
        return {
          userId: input.userId,
          status: "active",
          lastLoginAt: null,
          activeSessionCount: 2,
        };
      },
      async auditDenied(input) {
        calls.denied.push({ ...input });
      },
      async execute(input) {
        calls.execute.push({ ...input, authorize: undefined });
        await input.authorize?.({} as PoolConnection);
        return {
          accountExists: true,
          status: input.action === "ban" ? "banned" : "revoked",
        };
      },
    },
    readiness: {
      async ready() {
        return true;
      },
    },
  };
  const apps = buildApps(config, services);
  await Promise.all([apps.publicApp.ready(), apps.internalApp.ready()]);
  return { apps, calls };
}

test("管理员认证端点设置严格 Cookie、实时会话并完成退出", async (t) => {
  const { apps, calls } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const denied = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: {
      operatorId: "ops_kimi",
      password: "correct horse battery",
    },
    headers: { origin: "https://evil.example.invalid" },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "ORIGIN_FORBIDDEN");
  assert.equal(calls.login, 0);

  const login = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: {
      operatorId: "ops_kimi",
      password: "correct horse battery",
    },
    headers: { origin: ORIGIN },
  });
  assert.equal(login.statusCode, 204);
  const loginCookies = login.headers["set-cookie"];
  assert.ok(Array.isArray(loginCookies));
  assert.equal(loginCookies.length, 3);
  assert.match(loginCookies[0] ?? "", /^__Host-gmk_admin_session=;/u);
  assert.match(loginCookies[1] ?? "", /^gmk_admin_session=;/u);
  assert.match(loginCookies[2] ?? "", /^gmk_admin_session=/u);
  assert.match(loginCookies[2] ?? "", /HttpOnly/u);
  assert.match(loginCookies[2] ?? "", /SameSite=Strict/u);
  assert.equal(login.headers["cache-control"], "no-store");

  const session = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/admin/auth/session",
    headers: { cookie: COOKIE },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), {
    operator: { operatorId: "ops_kimi", displayName: "Kimi" },
    games: [{
      gameId: "game-a",
      name: "示例游戏 A",
      status: "enabled",
      canOperateAccounts: true,
    }],
    expiresAt: "2026-07-28T18:00:00.000Z",
  });
  assert.equal(session.headers["cache-control"], "no-store");

  const invalidSession = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/admin/auth/session",
    headers: { cookie: "gmk_admin_session=invalid" },
  });
  assert.equal(invalidSession.statusCode, 401);
  assert.match(
    String(invalidSession.headers["set-cookie"]),
    /Max-Age=0/u,
  );

  const logout = await apps.internalApp.inject({
    method: "DELETE",
    url: "/v1/admin/auth/session",
    headers: { cookie: COOKIE, origin: ORIGIN },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal(calls.logout, 1);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/u);
});

test("Cookie 管理员查询与写操作隔离身份、Origin 和游戏权限", async (t) => {
  const { apps, calls } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const account = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/games/game-a/admin/accounts/u_42",
    headers: { cookie: COOKIE },
  });
  assert.equal(account.statusCode, 200);
  assert.equal(account.json().activeSessionCount, 2);
  assert.equal(calls.queryAuthorization, 1);

  const missingOrigin = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_42/ban",
    headers: { cookie: COOKIE },
    payload: { operationId: "admin-http-1", reason: "测试处置" },
  });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(missingOrigin.json().code, "ORIGIN_FORBIDDEN");

  const mixedIdentity = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_42/ban",
    headers: {
      cookie: COOKIE,
      origin: ORIGIN,
      "x-operator-id": "game-a-admin",
      "x-admin-secret": GAME_ENV.GAME_A_ADMIN_SECRET,
    },
    payload: { operationId: "admin-http-2", reason: "测试处置" },
  });
  assert.equal(mixedIdentity.statusCode, 401);
  assert.equal(mixedIdentity.json().code, "ADMIN_AUTH_REQUIRED");
  assert.match(
    String(mixedIdentity.headers["set-cookie"]),
    /Max-Age=0/u,
  );

  const operated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_42/ban",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: { operationId: "admin-http-3", reason: "测试处置" },
  });
  assert.equal(operated.statusCode, 200);
  assert.equal(operated.json().status, "banned");
  assert.equal(calls.operationAuthorization, 1);
  assert.equal(calls.execute[0]?.caller, "admin-web");

  const crossGame = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/games/game-b/admin/accounts/u_42",
    headers: { cookie: COOKIE },
  });
  assert.equal(crossGame.statusCode, 403);
  assert.equal(crossGame.json().code, "GAME_ACCESS_DENIED");
  assert.equal(calls.denied.length, 1);
});

test("机器 Admin Secret 保持可用且 Public 面完全不暴露管理员资源", async (t) => {
  const { apps, calls } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const machine = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_42/revoke",
    headers: {
      "x-operator-id": "game-a-admin",
      "x-admin-secret": GAME_ENV.GAME_A_ADMIN_SECRET,
    },
    payload: { operationId: "admin-http-4", reason: "机器处置" },
  });
  assert.equal(machine.statusCode, 200);
  assert.equal(calls.execute[0]?.caller, "admin-secret");
  assert.equal(calls.operationAuthorization, 0);

  for (const url of [
    "/admin/",
    "/admin/app.js",
    "/v1/admin/auth/session",
    "/v1/games/game-a/admin/accounts/u_42",
  ]) {
    const response = await apps.publicApp.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, url);
  }
});
