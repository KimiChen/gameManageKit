import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import {
  buildApps,
  type GameManageKitServices,
} from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import {
  createTestRuntimeRegistry,
  TEST_ADMIN_SECRET,
} from "../runtime-registry.js";

const ORIGIN = "http://127.0.0.1:2571";
const TOKEN = Buffer.alloc(32, 0x41).toString("base64url");
const COOKIE = `gmk_admin_session=${TOKEN}`;

interface Calls {
  bootstrapRequired: number;
  bootstrap: number;
  login: number;
  reauthenticate: number;
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
    GAME_MANAGE_KIT_ADMIN_ORIGIN: ORIGIN,
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const games = createTestRuntimeRegistry();
  const calls: Calls = {
    bootstrapRequired: 0,
    bootstrap: 0,
    login: 0,
    reauthenticate: 0,
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
    canManageGames: true,
    canManageIntegrations: true,
    canRotateSecrets: true,
    canManageMachineIdentities: true,
    games: [{
      gameId: "game-a",
      name: "示例游戏 A",
      status: "enabled",
      configurationState: "configured",
      canOperateAccounts: true,
    }],
    expiresAt: "2026-07-28T18:00:00.000Z",
    elevatedUntil: null,
  } as const;
  const gameProject = {
    gameId: "game-a",
    name: "示例游戏 A",
    description: "",
    status: "enabled" as const,
    configurationState: "configured" as const,
    clientVisible: true,
    sortOrder: 0,
    revision: 1,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
  const gameServer = {
    gameId: "game-a",
    serverId: 1,
    name: "A 一区",
    tag: "new" as const,
    status: "smooth" as const,
    openTime: 1_700_000_000,
    gameHttpUrl: "https://game-a.example.invalid",
    gameWsUrl: "wss://game-a.example.invalid",
    isOpen: true,
    sortOrder: 0,
    revision: 1,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
  const directorySettings = {
    gameId: "game-a",
    isOps: false,
    revision: 1,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
  const services: GameManageKitServices = {
    games,
    gameProjects: {
      async resolve(gameId) {
        return games.resolve(gameId);
      },
      async listForClient() {
        return [{
          gameId: gameProject.gameId,
          name: gameProject.name,
          description: gameProject.description,
          status: gameProject.status,
        }];
      },
      async list(authorization) {
        await authorization.authorize({} as PoolConnection);
        return [gameProject];
      },
      async create(input, authorization) {
        await authorization.authorize({} as PoolConnection);
        return {
          ...gameProject,
          gameId: input.gameId,
          name: input.name,
          description: input.description,
          status: "maintenance",
          configurationState: "draft",
          clientVisible: false,
          revision: 1,
        };
      },
      async update(gameId, input, authorization) {
        await authorization.authorize({} as PoolConnection);
        return {
          ...gameProject,
          gameId,
          name: input.name,
          description: input.description,
          status: input.status,
          clientVisible: input.clientVisible,
          sortOrder: input.sortOrder,
          revision: input.revision + 1,
        };
      },
    },
    gameServers: {
      async getDirectorySettings(_gameId, authorization) {
        await authorization.authorize({} as PoolConnection);
        return directorySettings;
      },
      async updateDirectorySettings(gameId, input, authorization) {
        await authorization.authorize({} as PoolConnection);
        return {
          ...directorySettings,
          gameId,
          isOps: input.isOps,
          revision: input.revision + 1,
        };
      },
      async list(_gameId, authorization) {
        await authorization.authorize({} as PoolConnection);
        return { directoryRevision: 1, servers: [gameServer] };
      },
      async create(gameId, input, authorization) {
        await authorization.authorize({} as PoolConnection);
        return {
          directoryRevision: input.directoryRevision + 1,
          server: {
            ...gameServer,
            ...input,
            gameId,
            revision: 1,
          },
        };
      },
      async update(gameId, serverId, input, authorization) {
        await authorization.authorize({} as PoolConnection);
        return {
          directoryRevision: input.directoryRevision + 1,
          server: {
            ...gameServer,
            ...input,
            gameId,
            serverId,
            revision: input.revision + 1,
          },
        };
      },
    },
    integrations: {
      async get() {
        throw new Error("测试未调用");
      },
      async updateShared() {
        throw new Error("测试未调用");
      },
      async updateProvider() {
        throw new Error("测试未调用");
      },
      async replaceProviderSecret() {
        throw new Error("测试未调用");
      },
      async clearProviderSecret() {
        throw new Error("测试未调用");
      },
    },
    machineIdentities: {
      async list() {
        throw new Error("测试未调用");
      },
      async create() {
        throw new Error("测试未调用");
      },
      async update() {
        throw new Error("测试未调用");
      },
      async rotate() {
        throw new Error("测试未调用");
      },
      async revoke() {
        throw new Error("测试未调用");
      },
      async rotationStatus() {
        throw new Error("测试未调用");
      },
      async listAudit() {
        throw new Error("测试未调用");
      },
    },
    metrics: new MetricsRegistry(games.list().map((game) => game.gameId)),
    login: {
      async loginWechat() {
        return {
          ok: true,
          response: { userId: "u_1", accessToken: "token", isNewAccount: true },
        };
      },
      async loginDouyin() {
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
      async bootstrapRequired() {
        calls.bootstrapRequired += 1;
        return true;
      },
      async bootstrap(input) {
        assert.deepEqual(input, {
          operatorId: "ops_bootstrap",
          displayName: "Bootstrap Admin",
          password: "correct horse battery",
          ip: "127.0.0.1",
        });
        calls.bootstrap += 1;
        return {
          ...identity,
          operatorId: input.operatorId,
          displayName: input.displayName,
          games: [],
          elevatedUntil: null,
          sessionToken: TOKEN,
        };
      },
      async login() {
        calls.login += 1;
        return { ...identity, sessionToken: TOKEN };
      },
      async authenticate(token) {
        assert.equal(token, TOKEN);
        calls.authenticate += 1;
        return identity;
      },
      async reauthenticate(token, password) {
        assert.equal(token, TOKEN);
        assert.equal(password, "correct horse battery");
        calls.reauthenticate += 1;
        return {
          ...identity,
          elevatedUntil: "2026-07-28T17:15:00.000Z",
        };
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
      async requireGameManagement(_connection, current) {
        assert.equal(current, identity);
      },
      async requireIntegrationManagement() {},
      async requireMachineIdentityManagement() {},
      async requireSecretRotation() {},
      async requireElevatedSession() {},
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

test("管理员引导端点检查空状态、校验 Origin 并签发普通会话", async (t) => {
  const { apps, calls } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const status = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/admin/bootstrap",
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json(), { required: true });
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(calls.bootstrapRequired, 1);

  const denied = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/bootstrap",
    headers: { origin: "https://evil.example.invalid" },
    payload: {
      operatorId: "ops_bootstrap",
      displayName: "Bootstrap Admin",
      password: "correct horse battery",
    },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, "ORIGIN_FORBIDDEN");
  assert.equal(calls.bootstrap, 0);

  const invalid = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/bootstrap",
    headers: { origin: ORIGIN },
    payload: {
      operatorId: "INVALID",
      displayName: "Bootstrap Admin",
      password: "short",
    },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json().code, "INVALID_REQUEST");
  assert.equal(calls.bootstrap, 0);

  const created = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/bootstrap",
    headers: { origin: ORIGIN },
    payload: {
      operatorId: "ops_bootstrap",
      displayName: "Bootstrap Admin",
      password: "correct horse battery",
    },
  });
  assert.equal(created.statusCode, 204, created.body);
  assert.equal(created.headers["cache-control"], "no-store");
  const cookies = created.headers["set-cookie"];
  assert.ok(Array.isArray(cookies));
  assert.equal(cookies.length, 3);
  assert.match(cookies[2] ?? "", /^gmk_admin_session=/u);
  assert.match(cookies[2] ?? "", /HttpOnly/u);
  assert.match(cookies[2] ?? "", /SameSite=Strict/u);
  assert.equal(calls.bootstrap, 1);
});

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
    canManageGames: true,
    canManageIntegrations: true,
    canRotateSecrets: true,
    canManageMachineIdentities: true,
    expiresAt: "2026-07-28T18:00:00.000Z",
    elevatedUntil: null,
  });
  assert.equal(session.headers["cache-control"], "no-store");

  const reauthenticated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/auth/reauthenticate",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: { password: "correct horse battery" },
  });
  assert.equal(reauthenticated.statusCode, 204, reauthenticated.body);
  assert.equal(reauthenticated.headers["cache-control"], "no-store");
  assert.equal(calls.reauthenticate, 1);

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

test("游戏项目列表、新增和编辑仅接受具备全局权限的 Cookie 管理员", async (t) => {
  const { apps } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const listed = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/admin/games",
    headers: { cookie: COOKIE },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().games[0].gameId, "game-a");

  const missingOrigin = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/games",
    headers: { cookie: COOKIE },
    payload: {
      gameId: "new-game",
      name: "新游戏",
      description: "等待接入",
    },
  });
  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(missingOrigin.json().code, "ORIGIN_FORBIDDEN");

  const created = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/games",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      gameId: "new-game",
      name: "新游戏",
      description: "等待接入",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual({
    gameId: created.json().gameId,
    status: created.json().status,
    configurationState: created.json().configurationState,
    clientVisible: created.json().clientVisible,
  }, {
    gameId: "new-game",
    status: "maintenance",
    configurationState: "draft",
    clientVisible: false,
  });

  const updated = await apps.internalApp.inject({
    method: "PATCH",
    url: "/v1/admin/games/game-a",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      name: "游戏 A 新名称",
      description: "客户端展示说明",
      status: "maintenance",
      clientVisible: true,
      sortOrder: 12,
      revision: 1,
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual({
    name: updated.json().name,
    status: updated.json().status,
    clientVisible: updated.json().clientVisible,
    sortOrder: updated.json().sortOrder,
    revision: updated.json().revision,
  }, {
    name: "游戏 A 新名称",
    status: "maintenance",
    clientVisible: true,
    sortOrder: 12,
    revision: 2,
  });
});

test("区服列表、新增和编辑复用游戏管理权限并校验写请求 Origin", async (t) => {
  const { apps } = await fixture();
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const listed = await apps.internalApp.inject({
    method: "GET",
    url: "/v1/admin/games/game-a/servers",
    headers: { cookie: COOKIE },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().directoryRevision, 1);
  assert.equal(listed.json().servers[0].serverId, 1);

  const payload = {
    directoryRevision: 1,
    serverId: 2,
    name: "A 二区",
    tag: "normal",
    status: "busy",
    openTime: 1_800_000_000,
    gameHttpUrl: "https://game-a.example.invalid",
    gameWsUrl: "wss://game-a.example.invalid",
    isOpen: false,
    sortOrder: 2,
  };
  const denied = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/games/game-a/servers",
    headers: { cookie: COOKIE },
    payload,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "ORIGIN_FORBIDDEN");

  const created = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/admin/games/game-a/servers",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().directoryRevision, 2);
  assert.equal(created.json().server.serverId, 2);
  assert.equal(created.json().server.revision, 1);

  const updated = await apps.internalApp.inject({
    method: "PATCH",
    url: "/v1/admin/games/game-a/servers/2",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      ...payload,
      serverId: undefined,
      name: "A 二区维护",
      status: "maintenance",
      directoryRevision: 1,
      revision: 1,
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().directoryRevision, 2);
  assert.equal(updated.json().server.status, "maintenance");
  assert.equal(updated.json().server.revision, 2);
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
      "x-admin-secret": TEST_ADMIN_SECRET,
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
      "x-admin-secret": TEST_ADMIN_SECRET,
    },
    payload: { operationId: "admin-http-4", reason: "机器处置" },
  });
  assert.equal(machine.statusCode, 200);
  assert.equal(calls.execute[0]?.caller, "admin-secret");
  assert.equal(calls.operationAuthorization, 0);

  for (const url of [
    "/admin/",
    "/admin/app.js",
    "/v1/admin/bootstrap",
    "/v1/admin/auth/session",
    "/v1/games/game-a/admin/accounts/u_42",
  ]) {
    const response = await apps.publicApp.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, url);
  }
});
