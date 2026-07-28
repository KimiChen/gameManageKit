import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { loadConfig } from "../../src/config.js";
import {
  registerAdminIntegrationRoutes,
  type AdminIntegrationRouteServices,
} from "../../src/http/admin/integration-routes.js";
import {
  registerAdminMachineIdentityRoutes,
  type AdminMachineIdentityRouteServices,
} from "../../src/http/admin/machine-identity-routes.js";
import { createHttpApp } from "../../src/http/common.js";

const ORIGIN = "http://127.0.0.1:2571";
const TOKEN = Buffer.alloc(32, 0x41).toString("base64url");
const COOKIE = `gmk_admin_session=${TOKEN}`;
const NOW = "2026-07-28T12:00:00.000Z";
const ONE_TIME_SECRET = Buffer.alloc(32, 0x42).toString("base64url");

const identity = {
  operatorId: "ops_config",
  displayName: "Config Operator",
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
  elevatedUntil: "2026-07-28T12:05:00.000Z",
} as const;

function config() {
  return loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://root@127.0.0.1:3316/game_manage_kit_admin_config_http",
    GAME_MANAGE_KIT_ADMIN_ORIGIN: ORIGIN,
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
}

test("接入配置 HTTP 只返回 Secret 元数据，并在事务授权后幂等替换", async (t) => {
  const authorizationKinds: string[] = [];
  let submittedSecret = "";
  const integration = {
    gameId: "game-a",
    configurationState: "configured",
    wechatAppId: "wx-example",
    wechatSecret: {
      configured: true,
      version: 3,
      state: "active",
      updatedAt: NOW,
    },
    wechatEndpoint: "https://api.weixin.qq.com/sns/jscode2session",
    wechatTimeoutMs: 3_000,
    wechatBreakerThreshold: 5,
    wechatBreakerOpenMs: 30_000,
    sessionTtlSeconds: 86_400,
    loginRateCapacity: 20,
    loginRateRefillPerSecond: 2,
    adminRateCapacity: 10,
    adminRateRefillPerSecond: 1,
    revision: 8,
    loadedRevision: 8,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
  const services: AdminIntegrationRouteServices = {
    adminAuth: {
      async authenticate(sessionToken) {
        assert.equal(sessionToken, TOKEN);
        return identity;
      },
      async requireIntegrationManagement() {
        authorizationKinds.push("integration");
      },
      async requireSecretRotation(
        _connection,
        _identity,
        sessionToken,
      ) {
        assert.equal(sessionToken, TOKEN);
        authorizationKinds.push("secret");
      },
    },
    integrations: {
      async get(gameId, authorization) {
        assert.equal(gameId, "game-a");
        await authorization.authorize(
          {} as PoolConnection,
          "read",
        );
        return integration;
      },
      async update(gameId, input, authorization) {
        assert.equal(gameId, "game-a");
        await authorization.authorize(
          {} as PoolConnection,
          "write",
        );
        return {
          ...integration,
          ...input,
          revision: input.revision + 1,
          loadedRevision: input.revision,
        };
      },
      async replaceWechatSecret(gameId, input, authorization) {
        assert.equal(gameId, "game-a");
        submittedSecret = input.wechatAppSecret;
        await authorization.authorize(
          {} as PoolConnection,
          "secret",
        );
        return {
          gameId,
          configurationState: "configured",
          wechatSecret: {
            configured: true,
            version: 4,
            state: "active",
            updatedAt: NOW,
          },
          revision: input.revision + 1,
          loadedRevision: input.revision,
          replayed: false,
        };
      },
    },
  };
  const app = createHttpApp(config());
  registerAdminIntegrationRoutes(app, config(), services);
  t.after(async () => {
    await app.close();
  });
  await app.ready();

  const fetched = await app.inject({
    method: "GET",
    url: "/v1/admin/games/game-a/integration",
    headers: { cookie: COOKIE },
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.headers["cache-control"], "no-store");
  assert.deepEqual(fetched.json(), integration);
  assert.equal(fetched.body.includes("wx-secret-value"), false);
  assert.equal(fetched.body.toLowerCase().includes("digest"), false);

  const denied = await app.inject({
    method: "PATCH",
    url: "/v1/admin/games/game-a/integration",
    headers: { cookie: COOKIE },
    payload: {
      wechatAppId: "wx-updated",
      wechatEndpoint: integration.wechatEndpoint,
      wechatTimeoutMs: integration.wechatTimeoutMs,
      wechatBreakerThreshold: integration.wechatBreakerThreshold,
      wechatBreakerOpenMs: integration.wechatBreakerOpenMs,
      sessionTtlSeconds: integration.sessionTtlSeconds,
      loginRateCapacity: integration.loginRateCapacity,
      loginRateRefillPerSecond: integration.loginRateRefillPerSecond,
      adminRateCapacity: integration.adminRateCapacity,
      adminRateRefillPerSecond: integration.adminRateRefillPerSecond,
      revision: integration.revision,
    },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "ORIGIN_FORBIDDEN");

  const updated = await app.inject({
    method: "PATCH",
    url: "/v1/admin/games/game-a/integration",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      wechatAppId: "wx-updated",
      wechatEndpoint: integration.wechatEndpoint,
      wechatTimeoutMs: integration.wechatTimeoutMs,
      wechatBreakerThreshold: integration.wechatBreakerThreshold,
      wechatBreakerOpenMs: integration.wechatBreakerOpenMs,
      sessionTtlSeconds: integration.sessionTtlSeconds,
      loginRateCapacity: integration.loginRateCapacity,
      loginRateRefillPerSecond: integration.loginRateRefillPerSecond,
      adminRateCapacity: integration.adminRateCapacity,
      adminRateRefillPerSecond: integration.adminRateRefillPerSecond,
      revision: integration.revision,
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().wechatAppId, "wx-updated");
  assert.equal(updated.json().revision, 9);

  const secretValue = "wx-secret-value";
  const replaced = await app.inject({
    method: "PUT",
    url: "/v1/admin/games/game-a/secrets/wechat-app-secret",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      wechatAppSecret: secretValue,
      revision: 8,
      operationId: "wechat-secret-op-1",
    },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.headers["cache-control"], "no-store");
  assert.equal(submittedSecret, secretValue);
  assert.equal(replaced.body.includes(secretValue), false);
  assert.equal(replaced.body.toLowerCase().includes("digest"), false);
  assert.deepEqual(authorizationKinds, [
    "integration",
    "integration",
    "integration",
    "secret",
  ]);
});

test("机器身份 HTTP 一次性返回 Secret，重放和状态查询均不恢复明文", async (t) => {
  const authorizationKinds: string[] = [];
  let rotateCalls = 0;
  const machineIdentity = {
    identityId: "game-a-service",
    identityType: "service",
    displayName: "Game A Service",
    status: "enabled",
    gameIds: ["game-a"],
    revision: 1,
    secretVersions: [{
      version: 1,
      state: "current",
      expiresAt: null,
      createdAt: NOW,
      activatedAt: NOW,
      lastUsedAt: null,
      revokedAt: null,
    }],
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
  const services: AdminMachineIdentityRouteServices = {
    adminAuth: {
      async authenticate(sessionToken) {
        assert.equal(sessionToken, TOKEN);
        return identity;
      },
      async requireIntegrationManagement() {
        authorizationKinds.push("integration");
      },
      async requireMachineIdentityManagement() {
        authorizationKinds.push("machine");
      },
      async requireSecretRotation(
        _connection,
        _identity,
        sessionToken,
      ) {
        assert.equal(sessionToken, TOKEN);
        authorizationKinds.push("secret");
      },
      async requireElevatedSession(
        _connection,
        _identity,
        sessionToken,
      ) {
        assert.equal(sessionToken, TOKEN);
        authorizationKinds.push("elevated");
      },
    },
    machineIdentities: {
      async list(authorization) {
        await authorization.authorize({} as PoolConnection, "read");
        return { identities: [machineIdentity] };
      },
      async create(input, authorization) {
        await authorization.authorize({} as PoolConnection, "secret");
        return {
          identity: {
            ...machineIdentity,
            identityId: input.identityId,
            identityType: input.identityType,
            displayName: input.displayName,
            gameIds: input.gameIds,
          },
          version: 1,
          secret: ONE_TIME_SECRET,
          previousExpiresAt: null,
          replayed: false,
        };
      },
      async update(identityId, input, authorization) {
        assert.equal(identityId, machineIdentity.identityId);
        await authorization.authorize({} as PoolConnection, "scope");
        return {
          ...machineIdentity,
          displayName: input.displayName,
          status: input.status,
          gameIds: input.gameIds,
          revision: input.revision + 1,
        };
      },
      async rotate(identityId, input, authorization) {
        assert.equal(identityId, machineIdentity.identityId);
        assert.equal(input.operationId, "rotate-op-1");
        await authorization.authorize({} as PoolConnection, "secret");
        rotateCalls += 1;
        return {
          identity: {
            ...machineIdentity,
            revision: 2,
            secretVersions: [{
              ...machineIdentity.secretVersions[0],
              version: 2,
            }],
          },
          version: 2,
          previousExpiresAt: "2026-07-28T13:00:00.000Z",
          replayed: rotateCalls > 1,
          ...(rotateCalls === 1 ? { secret: ONE_TIME_SECRET } : {}),
        };
      },
      async revoke(identityId, version, input, authorization) {
        assert.equal(identityId, machineIdentity.identityId);
        assert.equal(version, 1);
        await authorization.authorize({} as PoolConnection, "secret");
        return {
          identityId,
          version,
          state: "revoked",
          identityRevision: input.revision + 1,
          replayed: false,
        };
      },
      async rotationStatus(identityId, operationId, authorization) {
        assert.equal(identityId, machineIdentity.identityId);
        await authorization.authorize({} as PoolConnection, "read");
        return {
          operationId,
          identityId,
          action: "rotate",
          status: "succeeded",
          version: 2,
          deliveryLost: true,
          createdAt: NOW,
        };
      },
      async listAudit(gameId, limit, authorization) {
        assert.equal(gameId, "game-a");
        assert.equal(limit, 10);
        await authorization.authorize({} as PoolConnection, "read");
        return {
          records: [{
            id: "12",
            auditType: "secret",
            operatorId: identity.operatorId,
            gameId,
            identityId: machineIdentity.identityId,
            action: "rotate",
            result: "succeeded",
            oldVersion: 1,
            newVersion: 2,
            createdAt: NOW,
          }],
        };
      },
    },
  };
  const app = createHttpApp(config());
  registerAdminMachineIdentityRoutes(app, config(), services);
  t.after(async () => {
    await app.close();
  });
  await app.ready();

  const listed = await app.inject({
    method: "GET",
    url: "/v1/admin/machine-identities",
    headers: { cookie: COOKIE },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.equal(listed.body.toLowerCase().includes("digest"), false);
  assert.equal(listed.body.includes(ONE_TIME_SECRET), false);

  const created = await app.inject({
    method: "POST",
    url: "/v1/admin/machine-identities",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      identityId: "game-b-admin",
      identityType: "machine_admin",
      displayName: "Game B Admin",
      gameIds: ["game-a"],
      operationId: "create-op-1",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(created.json().secret, ONE_TIME_SECRET);

  const updated = await app.inject({
    method: "PATCH",
    url: "/v1/admin/machine-identities/game-a-service",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      displayName: "Updated Service",
      status: "enabled",
      gameIds: ["game-a", "game-b"],
      revision: 1,
    },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().gameIds, ["game-a", "game-b"]);

  const rotationRequest = {
    method: "POST" as const,
    url: "/v1/admin/machine-identities/game-a-service/secret-rotations",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      operationId: "rotate-op-1",
      revision: 1,
      previousValiditySeconds: 3_600,
    },
  };
  const rotated = await app.inject(rotationRequest);
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal(rotated.json().secret, ONE_TIME_SECRET);
  const replayed = await app.inject(rotationRequest);
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(Object.hasOwn(replayed.json(), "secret"), false);
  assert.equal(replayed.json().replayed, true);

  const status = await app.inject({
    method: "GET",
    url: "/v1/admin/machine-identities/game-a-service/secret-rotations/rotate-op-1",
    headers: { cookie: COOKIE },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().deliveryLost, true);
  assert.equal(status.body.includes(ONE_TIME_SECRET), false);

  const revoked = await app.inject({
    method: "POST",
    url: "/v1/admin/machine-identities/game-a-service/secret-versions/1/revoke",
    headers: { cookie: COOKIE, origin: ORIGIN },
    payload: {
      operationId: "revoke-op-1",
      revision: 2,
      reason: "rotation complete",
    },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().state, "revoked");

  const audit = await app.inject({
    method: "GET",
    url: "/v1/admin/config-audit?gameId=game-a&limit=10",
    headers: { cookie: COOKIE },
  });
  assert.equal(audit.statusCode, 200, audit.body);
  assert.equal(audit.body.toLowerCase().includes("digest"), false);
  assert.equal(audit.body.includes(ONE_TIME_SECRET), false);
  assert.equal(authorizationKinds.includes("elevated"), true);
  assert.equal(
    authorizationKinds.filter((kind) => kind === "secret").length,
    4,
  );
});
