import assert from "node:assert/strict";
import test from "node:test";
import type { AreaListResponse, LoginResponse } from "@gono/game-manage-kit-contract";
import { buildApps, type GameManageKitServices } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { GameRuntimeRegistry } from "../../src/domain/game/resolver.js";
import {
  authorizeAdminGame,
  authorizeServiceGame,
  createHttpApp,
  listRegisteredRoutes,
  resolveGameContext,
} from "../../src/http/common.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import {
  createTestRuntimeRegistry,
  TEST_ADMIN_SECRET,
  TEST_SERVICE_SECRET,
} from "../runtime-registry.js";

const LOGIN: LoginResponse = {
  userId: "u_1",
  accessToken: "game-a.u_1.0123456789abcdef0123456789abcdef0123456789abcdef",
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
      gameHttpUrl: "https://game-a.example.invalid",
      gameWsUrl: "wss://game-a.example.invalid",
    },
  ],
  myServerIds: [],
};

function config(nodeEnv: "development" | "production" = "development") {
  return loadConfig({
    NODE_ENV: nodeEnv,
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://root@127.0.0.1:3306/game_manage_kit_test"
      + (nodeEnv === "production"
        ? "?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D"
        : ""),
    AUTH_DEV_ENABLED: nodeEnv === "development" ? "1" : "0",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
    ...(nodeEnv === "production"
      ? { GAME_MANAGE_KIT_ADMIN_ORIGIN: "https://admin.example.invalid" }
      : {}),
  });
}

function gameRegistry(_production = false): GameRuntimeRegistry {
  return createTestRuntimeRegistry();
}

function registryWithStatuses(): GameRuntimeRegistry {
  return createTestRuntimeRegistry([
    { gameId: "game-a", status: "maintenance" },
    { gameId: "game-b", status: "disabled" },
  ]);
}

function services(
  games: GameRuntimeRegistry,
  overrides: Partial<GameManageKitServices> = {},
): GameManageKitServices {
  const metrics = new MetricsRegistry(games.list().map((game) => game.gameId));
  const gameAProject = {
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
  return {
    games,
    gameProjects: {
      async resolve(gameId) {
        return games.resolve(gameId);
      },
      async listForClient() {
        return [{
          gameId: gameAProject.gameId,
          name: gameAProject.name,
          description: gameAProject.description,
          status: gameAProject.status,
        }];
      },
      async list() {
        return [gameAProject];
      },
      async create() {
        return gameAProject;
      },
      async update() {
        return gameAProject;
      },
    },
    gameServers: {
      async getDirectorySettings() {
        return {
          gameId: "game-a",
          isOps: false,
          revision: 1,
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        };
      },
      async updateDirectorySettings() {
        throw new Error("测试未调用");
      },
      async list() {
        return { directoryRevision: 1, servers: [] };
      },
      async create() {
        throw new Error("测试未调用");
      },
      async update() {
        throw new Error("测试未调用");
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
    metrics,
    login: {
      async loginWechat() {
        return { ok: true, response: LOGIN };
      },
      async loginDouyin() {
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
        return {
          valid: true,
          userId: "u_1",
          issuedAtMs: 1_700_000_000_000,
          expiresAtMs: 1_700_259_200_000,
        };
      },
    },
    characters: {
      async register() {},
      async has() {
        return true;
      },
    },
    admin: {
      async find(input) {
        return {
          userId: input.userId,
          status: "active",
          lastLoginAt: null,
          activeSessionCount: 1,
        };
      },
      async auditDenied() {},
      async execute(input) {
        return {
          accountExists: true,
          status: input.action === "ban" ? "banned" : "revoked",
        };
      },
    },
    adminAuth: {
      async bootstrapRequired() {
        return false;
      },
      async bootstrap() {
        throw new Error("测试未调用");
      },
      async login() {
        return {
          sessionToken: Buffer.alloc(32, 1).toString("base64url"),
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
        };
      },
      async reauthenticate() {
        return {
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
          elevatedUntil: "2026-07-28T17:15:00.000Z",
        };
      },
      async authenticate() {
        return {
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
        };
      },
      async logout() {},
      async requireAccountOperation() {},
      async requireGameAccess() {},
      async requireGameManagement() {},
      async requireIntegrationManagement() {},
      async requireMachineIdentityManagement() {},
      async requireSecretRotation() {},
      async requireElevatedSession() {},
    },
    readiness: {
      async ready() {
        return true;
      },
    },
    ...overrides,
  };
}

test("public/internal 双监听只暴露各自多游戏业务路由", async (t) => {
  const games = await gameRegistry();
  const apps = buildApps(config(), services(games));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const publicLogin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/sessions/dev",
    payload: { devKey: "route-test", serverId: 1 },
  });
  assert.equal(publicLogin.statusCode, 200);
  assert.deepEqual(publicLogin.json(), LOGIN);

  const clientGames = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games",
  });
  assert.equal(clientGames.statusCode, 200);
  assert.deepEqual(clientGames.json(), {
    games: [{
      gameId: "game-a",
      name: "示例游戏 A",
      description: "",
      status: "enabled",
    }],
  });
  assert.equal(clientGames.headers["cache-control"], "no-store");

  const areas = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/game-a/areas",
    headers: { authorization: `Bearer ${LOGIN.accessToken}` },
  });
  assert.equal(areas.statusCode, 200);
  assert.equal(areas.headers["cache-control"], "private, no-store");
  assert.equal(areas.headers.vary, "Authorization");

  for (const oldPath of [
    "/v1/sessions/dev",
    "/v1/areas",
    "/v1/internal/sessions/verify",
    "/v1/admin/accounts/u_1/ban",
  ]) {
    const response = await apps.publicApp.inject({ method: "GET", url: oldPath });
    assert.equal(response.statusCode, 404, oldPath);
  }

  const hiddenInternal = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/internal/sessions/verify",
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(hiddenInternal.statusCode, 404);

  const hiddenAdmin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_1/ban",
    payload: { operationId: "op-1", reason: "test" },
  });
  assert.equal(hiddenAdmin.statusCode, 404);

  const hiddenPublic = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/sessions/dev",
    payload: { devKey: "route-test", serverId: 1 },
  });
  assert.equal(hiddenPublic.statusCode, 404);

  const unauthenticated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/internal/sessions/verify",
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().code, "SERVICE_AUTH_REQUIRED");

  const serviceHeaders = {
    "x-service-id": "game-a-service",
    "x-service-secret": TEST_SERVICE_SECRET,
  };
  const authenticated = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/internal/sessions/verify",
    headers: serviceHeaders,
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.json().valid, true);

  const crossGameService = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-b/internal/sessions/verify",
    headers: serviceHeaders,
    payload: { accessToken: LOGIN.accessToken, serverId: 1 },
  });
  assert.equal(crossGameService.statusCode, 403);
  assert.equal(crossGameService.json().code, "GAME_ACCESS_DENIED");

  const admin = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_1/revoke",
    headers: {
      "x-operator-id": "game-a-admin",
      "x-admin-secret": TEST_ADMIN_SECRET,
    },
    payload: { operationId: "op-2", reason: "test" },
  });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.json().status, "revoked");

  const crossGameAdmin = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-b/admin/accounts/u_1/revoke",
    headers: {
      "x-operator-id": "game-a-admin",
      "x-admin-secret": TEST_ADMIN_SECRET,
    },
    payload: { operationId: "op-3", reason: "test" },
  });
  assert.equal(crossGameAdmin.statusCode, 403);
  assert.equal(crossGameAdmin.json().code, "GAME_ACCESS_DENIED");

  const publicMetrics = await apps.publicApp.inject({ method: "GET", url: "/metrics" });
  assert.equal(publicMetrics.statusCode, 404);
  const metrics = await apps.internalApp.inject({
    method: "GET",
    url: "/metrics",
    headers: serviceHeaders,
  });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.headers["content-type"] ?? "", /^text\/plain/);

  for (const app of [apps.publicApp, apps.internalApp]) {
    const live = await app.inject({ method: "GET", url: "/livez" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { ok: true });

    const version = await app.inject({ method: "GET", url: "/version" });
    assert.equal(version.statusCode, 200);
    assert.equal(version.json().service, "game-manage-kit");
  }
});

test("生产环境保留双游戏运行时目录且 dev-login 固定返回 404", async (t) => {
  const games = await gameRegistry(true);
  const apps = buildApps(config("production"), services(games));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  assert.deepEqual(games.list().map((game) => game.gameId), ["game-a", "game-b"]);
  assert.equal(
    listRegisteredRoutes(apps.publicApp).some((route) => (
      route.method === "POST"
      && route.path === "/v1/games/:gameId/sessions/dev"
    )),
    true,
  );
  const response = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/sessions/dev",
    payload: { devKey: "must-not-exist", serverId: 1 },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "NOT_FOUND");

  for (const request of [
    {
      url: "/v1/games/INVALID/sessions/dev",
      payload: {},
    },
    {
      url: "/v1/games/missing-game/sessions/dev",
      payload: { devKey: "must-not-exist", serverId: 1 },
    },
  ]) {
    const hidden = await apps.publicApp.inject({
      method: "POST",
      ...request,
    });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().code, "NOT_FOUND");
  }
});

test("HTTP 映射非法、未知、维护和停用游戏状态", async (t) => {
  const games = registryWithStatuses();
  const apps = buildApps(config(), services(games));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const invalid = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/INVALID/areas",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "INVALID_REQUEST");

  const unknown = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/missing-game/areas",
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "GAME_NOT_FOUND");

  const maintenance = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/game-a/areas",
  });
  assert.equal(maintenance.statusCode, 503);
  assert.equal(maintenance.json().code, "GAME_DISABLED");

  const disabled = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/game-b/areas",
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().code, "GAME_DISABLED");
});

test("区服准入拒绝发生在 Provider 请求前并记录规范化审计", async (t) => {
  const games = await gameRegistry();
  let providerCalls = 0;
  const audits: Array<Record<string, unknown>> = [];
  const apps = buildApps(config(), services(games, {
    login: {
      async loginWechat() {
        providerCalls += 1;
        return { ok: true, response: LOGIN };
      },
      async loginDouyin() {
        providerCalls += 1;
        return { ok: true, response: LOGIN };
      },
      async loginDev() {
        providerCalls += 1;
        return { ok: true, response: LOGIN };
      },
      async auditAdmissionDenied(gameId, provider, attempt, reason) {
        audits.push({
          gameId,
          provider,
          serverId: attempt.serverId,
          requestId: attempt.requestId,
          reason,
        });
      },
    },
  }));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const denied = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/sessions/douyin",
    payload: {
      code: "must-not-reach-provider",
      serverId: 99,
      deviceId: "admission-device",
    },
  });
  assert.equal(denied.statusCode, 404, denied.body);
  assert.equal(denied.json().code, "SERVER_NOT_FOUND");
  assert.equal(providerCalls, 0);
  assert.equal(audits.length, 1);
  assert.deepEqual({
    gameId: audits[0]?.gameId,
    provider: audits[0]?.provider,
    serverId: audits[0]?.serverId,
    reason: audits[0]?.reason,
    requestIdType: typeof audits[0]?.requestId,
  }, {
    gameId: "game-a",
    provider: "douyin",
    serverId: 99,
    reason: "SERVER_NOT_FOUND",
    requestIdType: "string",
  });
});

test("/readyz 将未就绪和检查异常都映射为 503", async (t) => {
  const games = await gameRegistry();
  let shouldThrow = false;
  const apps = buildApps(config(), services(games, {
    readiness: {
      async ready() {
        if (shouldThrow) {
          throw new Error("database unavailable");
        }
        return false;
      },
    },
  }));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const notReady = await apps.publicApp.inject({ method: "GET", url: "/readyz" });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), { ready: false });

  shouldThrow = true;
  const failed = await apps.publicApp.inject({ method: "GET", url: "/readyz" });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { ready: false });
});

test("未映射异常只返回统一错误，不泄漏内部文本", async (t) => {
  const games = await gameRegistry();
  const failingServices = services(games, {
    directory: {
      async list() {
        throw new Error(
          "mysql://root:database-password@127.0.0.1/private accessToken=secret-token",
        );
      },
    },
  });
  const apps = buildApps(config(), failingServices);
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const response = await apps.publicApp.inject({
    method: "GET",
    url: "/v1/games/game-a/areas",
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "INTERNAL");
  assert.equal(response.body.includes("database-password"), false);
  assert.equal(response.body.includes("secret-token"), false);
});

test("Admin 按游戏使用独立令牌桶且不影响 Public 登录", async (t) => {
  const games = await gameRegistry();
  let executed = 0;
  const limitedServices = services(games, {
    admin: {
      async find() {
        return null;
      },
      async auditDenied() {},
      async execute() {
        executed += 1;
        return { accountExists: true, status: "banned" };
      },
    },
  });
  const apps = buildApps(config(), limitedServices);
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });

  const headers = {
    "x-operator-id": "game-a-admin",
    "x-admin-secret": TEST_ADMIN_SECRET,
  };
  for (let index = 0; index < 10; index += 1) {
    const response = await apps.internalApp.inject({
      method: "POST",
      url: "/v1/games/game-a/admin/accounts/u_1/ban",
      headers,
      payload: { operationId: `limited-op-${index}`, reason: "test" },
    });
    assert.equal(response.statusCode, 200);
  }
  const limited = await apps.internalApp.inject({
    method: "POST",
    url: "/v1/games/game-a/admin/accounts/u_1/ban",
    headers,
    payload: { operationId: "limited-op-final", reason: "test" },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "RATE_LIMITED");
  assert.equal(executed, 10);

  const publicLogin = await apps.publicApp.inject({
    method: "POST",
    url: "/v1/games/game-a/sessions/dev",
    payload: { devKey: "still-independent", serverId: 1 },
  });
  assert.equal(publicLogin.statusCode, 200);
});

test("结构化完成日志包含可信身份字段且异常文本、token 和 secret 不泄漏", async (t) => {
  const games = await gameRegistry();
  const projects = {
    async resolve(gameId: string) {
      return games.resolve(gameId);
    },
  };
  const records: Array<Record<string, unknown>> = [];
  const app = createHttpApp(loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://root:database-password@127.0.0.1:3306/game_manage_kit_log_test",
    GAME_MANAGE_KIT_LOG_ENABLED: "1",
  }), {
    write(message) {
      records.push(JSON.parse(message) as Record<string, unknown>);
    },
  });
  t.after(async () => {
    await app.close();
  });

  app.get<{ Params: { gameId: string } }>(
    "/public/:gameId",
    {
      preHandler: async (request) => {
        await resolveGameContext(request, projects);
      },
    },
    async () => {
      throw new Error(
        "mysql://root:database-password@127.0.0.1/private "
        + "accessToken=secret-token",
      );
    },
  );
  app.get<{ Params: { gameId: string } }>(
    "/service/:gameId",
    {
      preHandler: async (request) => {
        await authorizeServiceGame(request, games, projects);
      },
    },
    async () => ({ ok: true }),
  );
  app.get<{ Params: { gameId: string } }>(
    "/admin/:gameId",
    {
      preHandler: async (request) => {
        await authorizeAdminGame(request, games, projects);
      },
    },
    async () => ({ ok: true }),
  );

  const failure = await app.inject({ method: "GET", url: "/public/game-a" });
  assert.equal(failure.statusCode, 500);
  const service = await app.inject({
    method: "GET",
    url: "/service/game-a",
    headers: {
      "x-service-id": "game-a-service",
      "x-service-secret": TEST_SERVICE_SECRET,
    },
  });
  assert.equal(service.statusCode, 200);
  const admin = await app.inject({
    method: "GET",
    url: "/admin/game-a",
    headers: {
      "x-operator-id": "game-a-admin",
      "x-admin-secret": TEST_ADMIN_SECRET,
    },
  });
  assert.equal(admin.statusCode, 200);

  const serialized = JSON.stringify(records);
  for (const secret of [
    "database-password",
    "secret-token",
    TEST_SERVICE_SECRET,
    TEST_ADMIN_SECRET,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const completed = records.filter((record) => (
    record.msg === "[gameManageKit] request completed"
  ));
  assert.equal(completed.some((record) => (
    record.gameId === "game-a" && record.serviceId === "game-a-service"
  )), true);
  assert.equal(completed.some((record) => (
    record.gameId === "game-a" && record.operatorId === "game-a-admin"
  )), true);
  assert.equal(records.some((record) => (
    record.msg === "[gameManageKit] 未映射异常"
    && record.gameId === "game-a"
    && record.errorName === "Error"
  )), true);
});
