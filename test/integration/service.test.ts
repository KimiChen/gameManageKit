import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  createAdminOperator,
  generateAdminPassword,
} from "../../src/admin-create.js";
import { createRuntime, type Runtime } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const execFileAsync = promisify(execFile);

interface LoginBody {
  readonly userId: string;
  readonly accessToken: string;
  readonly isNewAccount: boolean;
}

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function randomValue(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function sessionCookie(
  value: string | readonly string[] | undefined,
): string {
  const cookies = Array.isArray(value) ? value : [value];
  const cookie = cookies.find((candidate) => (
    typeof candidate === "string"
    && /(?:^|;\s*)(?:__Host-)?gmk_admin_session=/u.test(candidate)
    && !candidate.includes("Max-Age=0")
  ));
  assert.equal(typeof cookie, "string", "管理员登录未返回会话 Cookie");
  return cookie!.split(";", 1)[0]!;
}

async function closeRuntime(runtime: Runtime | undefined): Promise<void> {
  if (!runtime) {
    return;
  }
  await Promise.allSettled([
    runtime.apps.publicApp.close(),
    runtime.apps.internalApp.close(),
  ]);
  await runtime.database.close();
}

test("管理员从空库完成动态配置、热更新与机器 Secret 轮换", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3306/mysql";
  const databaseName = `game_manage_kit_service_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  let runtime: Runtime | undefined;
  let secondRuntime: Runtime | undefined;

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    const migrateEnv = {
      ...process.env,
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
    };
    await execFileAsync(process.execPath, ["dist/migrate.js"], {
      cwd: process.cwd(),
      env: migrateEnv,
    });
    await execFileAsync(process.execPath, ["dist/migrate.js"], {
      cwd: process.cwd(),
      env: migrateEnv,
    });

    const config = loadConfig({
      NODE_ENV: "test",
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
      GAME_MANAGE_KIT_ADMIN_ORIGIN: "http://127.0.0.1:2571",
      AUTH_DEV_ENABLED: "1",
      GAME_MANAGE_KIT_LOG_ENABLED: "0",
    });
    runtime = await createRuntime(config, { cacheTtlMs: 100 });
    assert.deepEqual(runtime.games.list(), []);

    const administratorPassword = generateAdminPassword();
    await createAdminOperator(runtime.database, {
      operatorId: "ops_integration",
      displayName: "Integration Admin",
      gameIds: [],
      canOperateAccounts: false,
      canManageGames: true,
      canManageIntegrations: true,
      canRotateSecrets: true,
      canManageMachineIdentities: true,
    }, administratorPassword);
    const limitedPassword = generateAdminPassword();
    await createAdminOperator(runtime.database, {
      operatorId: "ops_no_secret",
      displayName: "Integration Only",
      gameIds: [],
      canOperateAccounts: false,
      canManageIntegrations: true,
      canRotateSecrets: false,
    }, limitedPassword);

    const { internalApp, publicApp } = runtime.apps;
    const loginAdmin = async (
      operatorId: string,
      password: string,
    ): Promise<string> => {
      const response = await internalApp.inject({
        method: "POST",
        url: "/v1/admin/auth/login",
        headers: { origin: config.adminOrigin },
        payload: { operatorId, password },
      });
      assert.equal(response.statusCode, 204, response.body);
      return sessionCookie(response.headers["set-cookie"]);
    };
    const adminCookie = await loginAdmin(
      "ops_integration",
      administratorPassword,
    );
    const limitedCookie = await loginAdmin(
      "ops_no_secret",
      limitedPassword,
    );
    const mutate = async (
      method: "POST" | "PATCH" | "PUT",
      url: string,
      payload: Record<string, unknown>,
      cookie = adminCookie,
    ) => {
      return internalApp.inject({
        method,
        url,
        headers: {
          cookie,
          origin: config.adminOrigin,
        },
        payload,
      });
    };

    const session = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: adminCookie },
    });
    assert.equal(session.statusCode, 200, session.body);
    assert.deepEqual({
      games: session.json().games,
      canManageGames: session.json().canManageGames,
      canManageIntegrations: session.json().canManageIntegrations,
      canRotateSecrets: session.json().canRotateSecrets,
      canManageMachineIdentities:
        session.json().canManageMachineIdentities,
      elevatedUntil: session.json().elevatedUntil,
    }, {
      games: [],
      canManageGames: true,
      canManageIntegrations: true,
      canRotateSecrets: true,
      canManageMachineIdentities: true,
      elevatedUntil: null,
    });

    const appSecrets = new Map<string, string>();
    const configureGame = async (
      gameId: string,
      sortOrder: number,
    ): Promise<void> => {
      const created = await mutate("POST", "/v1/admin/games", {
        gameId,
        name: `测试游戏 ${gameId}`,
        description: "动态配置测试",
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().configurationState, "draft");

      const integration = await mutate(
        "PATCH",
        `/v1/admin/games/${gameId}/integration`,
        {
          wechatAppId: `wx-${gameId}`,
          wechatEndpoint:
            "https://api.weixin.qq.com/sns/jscode2session",
          wechatTimeoutMs: 2_000,
          wechatBreakerThreshold: 4,
          wechatBreakerOpenMs: 5_000,
          sessionTtlSeconds: 7_200,
          loginRateCapacity: 100,
          loginRateRefillPerSecond: 100,
          adminRateCapacity: 100,
          adminRateRefillPerSecond: 100,
          revision: 1,
        },
      );
      assert.equal(integration.statusCode, 200, integration.body);
      assert.equal(integration.json().revision, 2);
      assert.equal(integration.json().wechatSecret.configured, false);

      const appSecret = randomValue();
      appSecrets.set(gameId, appSecret);
      const secretWrite = await mutate(
        "PUT",
        `/v1/admin/games/${gameId}/secrets/wechat-app-secret`,
        {
          wechatAppSecret: appSecret,
          revision: 2,
          operationId: `set-${gameId}-wechat`,
        },
      );
      assert.equal(secretWrite.statusCode, 200, secretWrite.body);
      assert.equal(secretWrite.body.includes(appSecret), false);
      assert.equal(secretWrite.json().configurationState, "configured");
      assert.equal(secretWrite.json().wechatSecret.version, 1);

      const server = await mutate(
        "POST",
        `/v1/admin/games/${gameId}/servers`,
        {
          directoryRevision: 1,
          serverId: 1,
          name: `${gameId} 一区`,
          tag: "new",
          status: "smooth",
          openTime: 0,
          gameHttpUrl: `https://${gameId}.example.invalid`,
          gameWsUrl: `wss://${gameId}.example.invalid`,
          isOpen: true,
          sortOrder: 10,
        },
      );
      assert.equal(server.statusCode, 201, server.body);
      assert.equal(server.json().directoryRevision, 2);

      const enabled = await mutate(
        "PATCH",
        `/v1/admin/games/${gameId}`,
        {
          name: `测试游戏 ${gameId}`,
          description: "动态配置测试",
          status: "enabled",
          clientVisible: true,
          sortOrder,
          revision: 2,
        },
      );
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal(enabled.json().revision, 3);
    };

    const gameA = await mutate("POST", "/v1/admin/games", {
      gameId: "game-a",
      name: "测试游戏 game-a",
      description: "动态配置测试",
    });
    assert.equal(gameA.statusCode, 201, gameA.body);
    const secretExfiltrationEndpoint = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/integration",
      {
        wechatAppId: "wx-game-a",
        wechatEndpoint:
          "https://credential-collector.example.invalid/code2session",
        wechatTimeoutMs: 2_000,
        wechatBreakerThreshold: 4,
        wechatBreakerOpenMs: 5_000,
        sessionTtlSeconds: 7_200,
        loginRateCapacity: 100,
        loginRateRefillPerSecond: 100,
        adminRateCapacity: 100,
        adminRateRefillPerSecond: 100,
        revision: 1,
      },
    );
    assert.equal(
      secretExfiltrationEndpoint.statusCode,
      400,
      secretExfiltrationEndpoint.body,
    );
    const gameAIntegration = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/integration",
      {
        wechatAppId: "wx-game-a",
        wechatEndpoint:
          "https://api.weixin.qq.com/sns/jscode2session",
        wechatTimeoutMs: 2_000,
        wechatBreakerThreshold: 4,
        wechatBreakerOpenMs: 5_000,
        sessionTtlSeconds: 7_200,
        loginRateCapacity: 100,
        loginRateRefillPerSecond: 100,
        adminRateCapacity: 100,
        adminRateRefillPerSecond: 100,
        revision: 1,
      },
    );
    assert.equal(gameAIntegration.statusCode, 200, gameAIntegration.body);

    const gameAAppSecret = randomValue();
    appSecrets.set("game-a", gameAAppSecret);
    const notElevated = await mutate(
      "PUT",
      "/v1/admin/games/game-a/secrets/wechat-app-secret",
      {
        wechatAppSecret: gameAAppSecret,
        revision: 2,
        operationId: "set-game-a-before-reauth",
      },
    );
    assert.equal(notElevated.statusCode, 403, notElevated.body);

    const limitedReauth = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/auth/reauthenticate",
      headers: {
        cookie: limitedCookie,
        origin: config.adminOrigin,
      },
      payload: { password: limitedPassword },
    });
    assert.equal(limitedReauth.statusCode, 204, limitedReauth.body);
    const noSecretCapability = await mutate(
      "PUT",
      "/v1/admin/games/game-a/secrets/wechat-app-secret",
      {
        wechatAppSecret: randomValue(),
        revision: 2,
        operationId: "set-game-a-no-capability",
      },
      limitedCookie,
    );
    assert.equal(noSecretCapability.statusCode, 403, noSecretCapability.body);

    const reauthenticate = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/auth/reauthenticate",
      headers: {
        cookie: adminCookie,
        origin: config.adminOrigin,
      },
      payload: { password: administratorPassword },
    });
    assert.equal(reauthenticate.statusCode, 204, reauthenticate.body);

    const gameASecret = await mutate(
      "PUT",
      "/v1/admin/games/game-a/secrets/wechat-app-secret",
      {
        wechatAppSecret: gameAAppSecret,
        revision: 2,
        operationId: "set-game-a-wechat",
      },
    );
    assert.equal(gameASecret.statusCode, 200, gameASecret.body);
    assert.equal(gameASecret.body.includes(gameAAppSecret), false);
    assert.deepEqual({
      configured: gameASecret.json().wechatSecret.configured,
      version: gameASecret.json().wechatSecret.version,
      replayed: gameASecret.json().replayed,
    }, {
      configured: true,
      version: 1,
      replayed: false,
    });
    const replay = await mutate(
      "PUT",
      "/v1/admin/games/game-a/secrets/wechat-app-secret",
      {
        wechatAppSecret: randomValue(),
        revision: 2,
        operationId: "set-game-a-wechat",
      },
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.body.includes(gameAAppSecret), false);

    const gameAServer = await mutate(
      "POST",
      "/v1/admin/games/game-a/servers",
      {
        directoryRevision: 1,
        serverId: 1,
        name: "game-a 一区",
        tag: "new",
        status: "smooth",
        openTime: 0,
        gameHttpUrl: "https://game-a.example.invalid",
        gameWsUrl: "wss://game-a.example.invalid",
        isOpen: true,
        sortOrder: 10,
      },
    );
    assert.equal(gameAServer.statusCode, 201, gameAServer.body);
    const enableGameA = await mutate(
      "PATCH",
      "/v1/admin/games/game-a",
      {
        name: "测试游戏 game-a",
        description: "动态配置测试",
        status: "enabled",
        clientVisible: true,
        sortOrder: 10,
        revision: 2,
      },
    );
    assert.equal(enableGameA.statusCode, 200, enableGameA.body);
    await configureGame("game-b", 20);
    const rotatedGameBAppSecret = randomValue();
    const concurrentSecretWrites = await Promise.all([
      mutate(
        "PUT",
        "/v1/admin/games/game-b/secrets/wechat-app-secret",
        {
          wechatAppSecret: rotatedGameBAppSecret,
          revision: 3,
          operationId: "rotate-game-b-wechat-concurrent",
        },
      ),
      mutate(
        "PUT",
        "/v1/admin/games/game-b/secrets/wechat-app-secret",
        {
          wechatAppSecret: rotatedGameBAppSecret,
          revision: 3,
          operationId: "rotate-game-b-wechat-concurrent",
        },
      ),
    ]);
    for (const response of concurrentSecretWrites) {
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(
      concurrentSecretWrites
        .map((response) => Boolean(response.json().replayed))
        .sort(),
      [false, true],
    );
    appSecrets.set("game-b", rotatedGameBAppSecret);

    const clientGames = await publicApp.inject({
      method: "GET",
      url: "/v1/games",
    });
    assert.equal(clientGames.statusCode, 200, clientGames.body);
    assert.deepEqual(
      clientGames.json().games.map(
        (game: { gameId: string }) => game.gameId,
      ),
      ["game-a", "game-b"],
    );
    const areas = await publicApp.inject({
      method: "GET",
      url: "/v1/games/game-a/areas",
    });
    assert.equal(areas.statusCode, 200, areas.body);
    assert.equal(areas.headers["cache-control"], "private, no-store");
    assert.equal(areas.headers.vary, "Authorization");
    assert.deepEqual(
      areas.json().servers.map(
        (server: { serverId: number }) => server.serverId,
      ),
      [1],
    );

    const login = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "integration-user", serverId: 1 },
    });
    assert.equal(login.statusCode, 200, login.body);
    const loginBody = login.json<LoginBody>();
    assert.equal(loginBody.isNewAccount, true);

    const createService = await mutate(
      "POST",
      "/v1/admin/machine-identities",
      {
        identityId: "game-a-service",
        identityType: "service",
        displayName: "Game A Service",
        gameIds: ["game-a"],
        operationId: "create-game-a-service",
      },
    );
    assert.equal(createService.statusCode, 201, createService.body);
    assert.equal(createService.headers["cache-control"], "no-store");
    const serviceSecret = String(createService.json().secret);
    assert.match(serviceSecret, /^[A-Za-z0-9_-]{43}$/);

    const serviceHeaders = {
      "x-service-id": "game-a-service",
      "x-service-secret": serviceSecret,
    };
    const verify = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-a/internal/sessions/verify",
      headers: serviceHeaders,
      payload: {
        accessToken: loginBody.accessToken,
        serverId: 1,
      },
    });
    assert.equal(verify.statusCode, 200, verify.body);
    assert.equal(verify.json().valid, true);
    const crossGame = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-b/internal/sessions/verify",
      headers: serviceHeaders,
      payload: {
        accessToken: loginBody.accessToken,
        serverId: 1,
      },
    });
    assert.equal(crossGame.statusCode, 403, crossGame.body);

    const createMachineAdmin = await mutate(
      "POST",
      "/v1/admin/machine-identities",
      {
        identityId: "game-a-admin",
        identityType: "machine_admin",
        displayName: "Game A Machine Admin",
        gameIds: ["game-a"],
        operationId: "create-game-a-admin",
      },
    );
    assert.equal(
      createMachineAdmin.statusCode,
      201,
      createMachineAdmin.body,
    );
    const machineAdminSecret = String(createMachineAdmin.json().secret);
    const account = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-a/admin/accounts/${loginBody.userId}`,
      headers: {
        "x-operator-id": "game-a-admin",
        "x-admin-secret": machineAdminSecret,
      },
    });
    assert.equal(account.statusCode, 200, account.body);
    const crossGameAccount = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-b/admin/accounts/${loginBody.userId}`,
      headers: {
        "x-operator-id": "game-a-admin",
        "x-admin-secret": machineAdminSecret,
      },
    });
    assert.equal(crossGameAccount.statusCode, 403, crossGameAccount.body);

    const concurrentRotations = await Promise.all([
      mutate(
        "POST",
        "/v1/admin/machine-identities/game-a-service/secret-rotations",
        {
          operationId: "rotate-game-a-service",
          revision: 1,
          previousValiditySeconds: 60,
        },
      ),
      mutate(
        "POST",
        "/v1/admin/machine-identities/game-a-service/secret-rotations",
        {
          operationId: "rotate-game-a-service",
          revision: 1,
          previousValiditySeconds: 60,
        },
      ),
    ]);
    for (const response of concurrentRotations) {
      assert.equal(response.statusCode, 200, response.body);
    }
    const rotation = concurrentRotations.find(
      (response) => "secret" in response.json(),
    );
    const concurrentRotationReplay = concurrentRotations.find(
      (response) => !("secret" in response.json()),
    );
    assert.ok(rotation);
    assert.ok(concurrentRotationReplay);
    assert.equal(concurrentRotationReplay.json().replayed, true);
    const rotatedServiceSecret = String(rotation.json().secret);
    assert.match(rotatedServiceSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotatedServiceSecret, serviceSecret);
    assert.equal(rotation.json().identity.revision, 2);

    for (const secret of [serviceSecret, rotatedServiceSecret]) {
      const response = await internalApp.inject({
        method: "POST",
        url: "/v1/games/game-a/internal/sessions/verify",
        headers: {
          "x-service-id": "game-a-service",
          "x-service-secret": secret,
        },
        payload: {
          accessToken: loginBody.accessToken,
          serverId: 1,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const rotationReplay = await mutate(
      "POST",
      "/v1/admin/machine-identities/game-a-service/secret-rotations",
      {
        operationId: "rotate-game-a-service",
        revision: 1,
        previousValiditySeconds: 60,
      },
    );
    assert.equal(rotationReplay.statusCode, 200, rotationReplay.body);
    assert.equal(rotationReplay.json().replayed, true);
    assert.equal("secret" in rotationReplay.json(), false);
    const rotationStatus = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/machine-identities/game-a-service"
        + "/secret-rotations/rotate-game-a-service",
      headers: { cookie: adminCookie },
    });
    assert.equal(rotationStatus.statusCode, 200, rotationStatus.body);
    assert.deepEqual({
      status: rotationStatus.json().status,
      version: rotationStatus.json().version,
      deliveryLost: rotationStatus.json().deliveryLost,
    }, {
      status: "succeeded",
      version: 2,
      deliveryLost: true,
    });

    const revokedPrevious = await mutate(
      "POST",
      "/v1/admin/machine-identities/game-a-service"
        + "/secret-versions/1/revoke",
      {
        operationId: "revoke-game-a-service-v1",
        revision: 2,
        reason: "轮换窗口提前结束",
      },
    );
    assert.equal(revokedPrevious.statusCode, 200, revokedPrevious.body);
    const oldRejected = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-a/internal/sessions/verify",
      headers: serviceHeaders,
      payload: {
        accessToken: loginBody.accessToken,
        serverId: 1,
      },
    });
    assert.equal(oldRejected.statusCode, 401, oldRejected.body);
    const newAccepted = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-a/internal/sessions/verify",
      headers: {
        "x-service-id": "game-a-service",
        "x-service-secret": rotatedServiceSecret,
      },
      payload: {
        accessToken: loginBody.accessToken,
        serverId: 1,
      },
    });
    assert.equal(newAccepted.statusCode, 200, newAccepted.body);

    const integrationGet = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    const identitiesGet = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/machine-identities",
      headers: { cookie: adminCookie },
    });
    const auditGet = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/config-audit?limit=100",
      headers: { cookie: adminCookie },
    });
    for (const response of [integrationGet, identitiesGet, auditGet]) {
      assert.equal(response.statusCode, 200, response.body);
      for (const secret of [
        ...appSecrets.values(),
        serviceSecret,
        rotatedServiceSecret,
        machineAdminSecret,
      ]) {
        assert.equal(response.body.includes(secret), false);
      }
      assert.doesNotMatch(response.body, /secretDigest|secret_digest/u);
    }
    assert.deepEqual(
      [...new Set(
        auditGet
          .json()
          .records
          .map((record: { auditType: string }) => record.auditType),
      )].sort(),
      ["game_configuration", "machine_identity", "secret"],
    );

    const [storedIntegrations] = await runtime.database.pool.query<
      RowDataPacket[]
    >(
      `SELECT game_id, wechat_app_secret, wechat_secret_version
         FROM game_integrations
        ORDER BY game_id`,
    );
    assert.deepEqual(storedIntegrations.map((row) => ({
      gameId: String(row.game_id),
      appSecret: String(row.wechat_app_secret),
      version: Number(row.wechat_secret_version),
    })), [
      {
        gameId: "game-a",
        appSecret: appSecrets.get("game-a"),
        version: 1,
      },
      {
        gameId: "game-b",
        appSecret: appSecrets.get("game-b"),
        version: 2,
      },
    ]);
    const [machineSecrets] = await runtime.database.pool.query<
      RowDataPacket[]
    >(
      `SELECT identity_id, version, OCTET_LENGTH(secret_digest) AS bytes,
              state
         FROM machine_secret_versions
        ORDER BY identity_id, version`,
    );
    assert.deepEqual(machineSecrets.map((row) => ({
      identityId: String(row.identity_id),
      version: Number(row.version),
      bytes: Number(row.bytes),
      state: String(row.state),
    })), [
      {
        identityId: "game-a-admin",
        version: 1,
        bytes: 32,
        state: "current",
      },
      {
        identityId: "game-a-service",
        version: 1,
        bytes: 32,
        state: "revoked",
      },
      {
        identityId: "game-a-service",
        version: 2,
        bytes: 32,
        state: "current",
      },
    ]);
    const [gameAudits] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT
         CONCAT_WS(
           ' ',
           COALESCE(CAST(before_data AS CHAR), ''),
           COALESCE(CAST(after_data AS CHAR), '')
         ) AS audit_text
       FROM admin_game_audit`,
    );
    const [secretAudits] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT
         CONCAT_WS(
           ' ',
           action,
           result,
           COALESCE(reason, ''),
           request_id
         ) AS audit_text
       FROM admin_secret_audit`,
    );
    const [failedSecretAudits] = await runtime.database.pool.query<
      RowDataPacket[]
    >(
      `SELECT result, reason
         FROM admin_secret_audit
        WHERE result = 'failed'
        ORDER BY id`,
    );
    assert.ok(failedSecretAudits.length >= 2);
    assert.ok(failedSecretAudits.every((row) => (
      String(row.result) === "failed"
      && String(row.reason) === "GAME_ACCESS_DENIED"
    )));
    const auditText = [...gameAudits, ...secretAudits]
      .map((row) => String(row.audit_text))
      .join("\n");
    for (const secret of [
      ...appSecrets.values(),
      serviceSecret,
      rotatedServiceSecret,
      machineAdminSecret,
    ]) {
      assert.equal(auditText.includes(secret), false);
    }

    secondRuntime = await createRuntime(config, { cacheTtlMs: 100 });
    const beforeRemoteUpdate = await secondRuntime.apps.publicApp.inject({
      method: "GET",
      url: "/v1/games/game-a/areas",
    });
    assert.equal(beforeRemoteUpdate.statusCode, 200, beforeRemoteUpdate.body);
    const maintenance = await mutate(
      "PATCH",
      "/v1/admin/games/game-a",
      {
        name: "测试游戏 game-a",
        description: "动态配置测试",
        status: "maintenance",
        clientVisible: true,
        sortOrder: 10,
        revision: 3,
      },
    );
    assert.equal(maintenance.statusCode, 200, maintenance.body);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const afterRemoteUpdate = await secondRuntime.apps.publicApp.inject({
      method: "GET",
      url: "/v1/games/game-a/areas",
    });
    assert.equal(afterRemoteUpdate.statusCode, 503, afterRemoteUpdate.body);

    const disabledGameB = await mutate(
      "PATCH",
      "/v1/admin/games/game-b",
      {
        name: "测试游戏 game-b",
        description: "动态配置测试",
        status: "disabled",
        clientVisible: false,
        sortOrder: 20,
        revision: 3,
      },
    );
    assert.equal(disabledGameB.statusCode, 200, disabledGameB.body);
    const clearedGameBAppId = await mutate(
      "PATCH",
      "/v1/admin/games/game-b/integration",
      {
        wechatAppId: null,
        wechatEndpoint:
          "https://api.weixin.qq.com/sns/jscode2session",
        wechatTimeoutMs: 2_000,
        wechatBreakerThreshold: 4,
        wechatBreakerOpenMs: 5_000,
        sessionTtlSeconds: 7_200,
        loginRateCapacity: 100,
        loginRateRefillPerSecond: 100,
        adminRateCapacity: 100,
        adminRateRefillPerSecond: 100,
        revision: 4,
      },
    );
    assert.equal(clearedGameBAppId.statusCode, 200, clearedGameBAppId.body);
    assert.equal(clearedGameBAppId.json().configurationState, "draft");
    const gamesAfterClear = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games",
      headers: { cookie: adminCookie },
    });
    assert.equal(gamesAfterClear.statusCode, 200, gamesAfterClear.body);
    const gameBAfterClear = gamesAfterClear
      .json()
      .games
      .find((game: { gameId: string }) => game.gameId === "game-b");
    assert.ok(gameBAfterClear);
    assert.equal(gameBAfterClear.status, "disabled");
    assert.equal(gameBAfterClear.configurationState, "draft");
  } finally {
    await closeRuntime(secondRuntime);
    await closeRuntime(runtime);
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
