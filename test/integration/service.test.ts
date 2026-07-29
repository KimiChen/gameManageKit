import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { createRuntime, type Runtime } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { hashAdminPassword } from "../../src/infra/security/admin-password.js";

const execFileAsync = promisify(execFile);

interface LoginBody {
  readonly userId: string;
  readonly accessToken: string;
  readonly isNewAccount: boolean;
}

type IdentityProvider = "wechat" | "douyin";

interface ProviderFetch {
  readonly provider: IdentityProvider;
  readonly gameId: string;
  readonly code: string;
  readonly appId: string;
  readonly secret: string;
}

function providerKey(
  gameId: string,
  provider: IdentityProvider,
): string {
  return `${gameId}:${provider}`;
}

function providerAppId(
  gameId: string,
  provider: IdentityProvider,
): string {
  return `${provider === "wechat" ? "wx" : "dy"}-${gameId}`;
}

function providerEndpoint(provider: IdentityProvider): string {
  return provider === "wechat"
    ? "https://api.weixin.qq.com/sns/jscode2session"
    : "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session";
}

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function randomValue(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

async function createLimitedTestAdministrator(
  runtime: Runtime,
  password: string,
): Promise<void> {
  const passwordHash = await hashAdminPassword(password);
  await runtime.database.pool.execute(
    `INSERT INTO admin_operators
       (operator_id, display_name, password_hash, status, auth_version,
        can_manage_games, can_manage_integrations, can_rotate_secrets,
        can_manage_machine_identities)
     VALUES ('ops_no_secret', 'Integration Only', ?, 'enabled', 1, 0, 1, 0, 0)`,
    [passwordHash],
  );
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
    const appSecrets = new Map<string, string>();
    const allProviderSecrets = new Set<string>();
    const storeProviderSecret = (
      gameId: string,
      provider: IdentityProvider,
      secret: string,
    ): void => {
      appSecrets.set(providerKey(gameId, provider), secret);
      allProviderSecrets.add(secret);
    };
    const providerFetches: ProviderFetch[] = [];
    const credentialMismatches: string[] = [];
    const validationFetch: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      const provider: IdentityProvider =
        url.hostname === "api.weixin.qq.com" ? "wechat" : "douyin";
      const appId = url.searchParams.get("appid") ?? "";
      const secret = url.searchParams.get("secret") ?? "";
      const code = url.searchParams.get(
        provider === "wechat" ? "js_code" : "code",
      ) ?? "";
      const prefix = provider === "wechat" ? "wx-" : "dy-";
      const gameId = appId.startsWith(prefix)
        ? appId.slice(prefix.length)
        : "";
      const expectedAppId = providerAppId(gameId, provider);
      const expectedSecret = appSecrets.get(providerKey(gameId, provider));
      if (appId !== expectedAppId || secret !== expectedSecret) {
        credentialMismatches.push(
          `${provider}:${gameId}:credential-mismatch`,
        );
      }
      providerFetches.push({ provider, gameId, code, appId, secret });

      const response = (body: object, status = 200): Response => (
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
      );
      if (code.endsWith("-unavailable")) {
        return response({ error: "unavailable" }, 503);
      }
      if (code.endsWith("-rate-limited")) {
        return response({ error: "rate limited" }, 429);
      }
      if (code.endsWith("-invalid-credentials")) {
        return provider === "wechat"
          ? response({ errcode: 40_013, errmsg: "invalid appid" })
          : response({ error: 40_015, message: "invalid appid" });
      }
      if (code.endsWith("-invalid-code")) {
        return provider === "wechat"
          ? response({ errcode: 40_029, errmsg: "invalid code" })
          : response({ error: 40_018, message: "invalid code" });
      }
      if (provider === "wechat") {
        if (code === "wechat-conflict") {
          return response({
            openid: "wechat-openid-a",
            unionid: "wechat-union-b",
            session_key: "wechat-session-conflict",
          });
        }
        const suffix = code === "wechat-success-b" ? "b" : "a";
        return response({
          openid: `wechat-openid-${suffix}`,
          unionid: `wechat-union-${suffix}`,
          session_key: `wechat-session-${suffix}`,
        });
      }
      return response({
        error: 0,
        openid: "douyin-openid-a",
        unionid: "douyin-union-a",
        session_key: "douyin-session-a",
      });
    };
    runtime = await createRuntime(config, {
      cacheTtlMs: 100,
      fetchImpl: validationFetch,
    });
    assert.deepEqual(runtime.games.list(), []);

    const { internalApp, publicApp } = runtime.apps;
    const administratorPassword = randomValue();
    const bootstrapStatus = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/bootstrap",
    });
    assert.equal(bootstrapStatus.statusCode, 200, bootstrapStatus.body);
    assert.equal(bootstrapStatus.headers["cache-control"], "no-store");
    assert.deepEqual(bootstrapStatus.json(), { required: true });

    const concurrentBootstrap = await Promise.all([
      internalApp.inject({
        method: "POST",
        url: "/v1/admin/bootstrap",
        headers: { origin: config.adminOrigin },
        payload: {
          operatorId: "ops_integration",
          displayName: "Integration Admin",
          password: administratorPassword,
        },
      }),
      internalApp.inject({
        method: "POST",
        url: "/v1/admin/bootstrap",
        headers: { origin: config.adminOrigin },
        payload: {
          operatorId: "ops_integration",
          displayName: "Integration Admin",
          password: administratorPassword,
        },
      }),
    ]);
    assert.deepEqual(
      concurrentBootstrap.map((response) => response.statusCode).sort(),
      [204, 409],
      concurrentBootstrap.map((response) => response.body).join("\n"),
    );
    const bootstrap = concurrentBootstrap.find(
      (response) => response.statusCode === 204,
    );
    assert.ok(bootstrap);
    assert.equal(bootstrap.headers["cache-control"], "no-store");
    const adminCookie = sessionCookie(bootstrap.headers["set-cookie"]);

    const bootstrapClosed = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/bootstrap",
    });
    assert.equal(bootstrapClosed.statusCode, 200, bootstrapClosed.body);
    assert.deepEqual(bootstrapClosed.json(), { required: false });
    const secondBootstrap = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/bootstrap",
      headers: { origin: config.adminOrigin },
      payload: {
        operatorId: "ops_second",
        displayName: "Second Bootstrap",
        password: randomValue(),
      },
    });
    assert.equal(secondBootstrap.statusCode, 409, secondBootstrap.body);

    const limitedPassword = randomValue();
    await createLimitedTestAdministrator(runtime, limitedPassword);
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
    const limitedCookie = await loginAdmin(
      "ops_no_secret",
      limitedPassword,
    );
    const mutate = async (
      method: "POST" | "PATCH" | "PUT" | "DELETE",
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
      assert.equal(integration.json().providers.length, 2);

      const appSecret = randomValue();
      storeProviderSecret(gameId, "wechat", appSecret);
      const providerConfiguration = await mutate(
        "PATCH",
        `/v1/admin/games/${gameId}/identity-providers/wechat`,
        {
          enabled: false,
          appId: providerAppId(gameId, "wechat"),
          endpoint: providerEndpoint("wechat"),
          timeoutMs: 2_000,
          breakerThreshold: 4,
          breakerOpenMs: 5_000,
          revision: 2,
        },
      );
      assert.equal(
        providerConfiguration.statusCode,
        200,
        providerConfiguration.body,
      );
      assert.equal(providerConfiguration.json().revision, 3);
      const secretWrite = await mutate(
        "PUT",
        `/v1/admin/games/${gameId}`
          + "/identity-providers/wechat/secret",
        {
          appSecret,
          revision: 3,
          operationId: `set-${gameId}-wechat`,
        },
      );
      assert.equal(secretWrite.statusCode, 200, secretWrite.body);
      assert.equal(secretWrite.body.includes(appSecret), false);
      assert.equal(secretWrite.json().configurationState, "draft");
      assert.equal(secretWrite.json().secretMetadata.version, 1);
      assert.equal(secretWrite.json().revision, 4);

      const enabledProvider = await mutate(
        "PATCH",
        `/v1/admin/games/${gameId}/identity-providers/wechat`,
        {
          enabled: true,
          appId: providerAppId(gameId, "wechat"),
          endpoint: providerEndpoint("wechat"),
          timeoutMs: 2_000,
          breakerThreshold: 4,
          breakerOpenMs: 5_000,
          revision: 4,
        },
      );
      assert.equal(
        enabledProvider.statusCode,
        200,
        enabledProvider.body,
      );
      assert.equal(enabledProvider.json().configurationState, "configured");
      assert.equal(enabledProvider.json().revision, 5);

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
    const gameAShared = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/integration",
      {
        sessionTtlSeconds: 7_200,
        loginRateCapacity: 100,
        loginRateRefillPerSecond: 100,
        adminRateCapacity: 100,
        adminRateRefillPerSecond: 100,
        revision: 1,
      },
    );
    assert.equal(gameAShared.statusCode, 200, gameAShared.body);
    assert.equal(gameAShared.json().revision, 2);

    const secretExfiltrationEndpoint = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/wechat",
      {
        enabled: false,
        appId: providerAppId("game-a", "wechat"),
        endpoint:
          "https://credential-collector.example.invalid/code2session",
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 2,
      },
    );
    assert.equal(
      secretExfiltrationEndpoint.statusCode,
      400,
      secretExfiltrationEndpoint.body,
    );
    const gameAWechatProvider = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/wechat",
      {
        enabled: false,
        appId: providerAppId("game-a", "wechat"),
        endpoint: providerEndpoint("wechat"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 2,
      },
    );
    assert.equal(
      gameAWechatProvider.statusCode,
      200,
      gameAWechatProvider.body,
    );
    assert.equal(gameAWechatProvider.json().revision, 3);

    const gameAWechatSecret = randomValue();
    storeProviderSecret("game-a", "wechat", gameAWechatSecret);
    const notElevated = await mutate(
      "PUT",
      "/v1/admin/games/game-a/identity-providers/wechat/secret",
      {
        appSecret: gameAWechatSecret,
        revision: 3,
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
      "/v1/admin/games/game-a/identity-providers/wechat/secret",
      {
        appSecret: randomValue(),
        revision: 3,
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
      "/v1/admin/games/game-a/identity-providers/wechat/secret",
      {
        appSecret: gameAWechatSecret,
        revision: 3,
        operationId: "set-game-a-wechat",
      },
    );
    assert.equal(gameASecret.statusCode, 200, gameASecret.body);
    assert.equal(gameASecret.body.includes(gameAWechatSecret), false);
    assert.deepEqual({
      provider: gameASecret.json().provider,
      configured: gameASecret.json().secretMetadata.configured,
      version: gameASecret.json().secretMetadata.version,
      revision: gameASecret.json().revision,
      replayed: gameASecret.json().replayed,
    }, {
      provider: "wechat",
      configured: true,
      version: 1,
      revision: 4,
      replayed: false,
    });
    const replay = await mutate(
      "PUT",
      "/v1/admin/games/game-a/identity-providers/wechat/secret",
      {
        appSecret: gameAWechatSecret,
        revision: 3,
        operationId: "set-game-a-wechat",
      },
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.body.includes(gameAWechatSecret), false);
    const conflictingReplay = await mutate(
      "PUT",
      "/v1/admin/games/game-a/identity-providers/wechat/secret",
      {
        appSecret: randomValue(),
        revision: 3,
        operationId: "set-game-a-wechat",
      },
    );
    assert.equal(conflictingReplay.statusCode, 409, conflictingReplay.body);

    const enabledWechat = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/wechat",
      {
        enabled: true,
        appId: providerAppId("game-a", "wechat"),
        endpoint: providerEndpoint("wechat"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 4,
      },
    );
    assert.equal(enabledWechat.statusCode, 200, enabledWechat.body);
    assert.equal(enabledWechat.json().configurationState, "configured");
    assert.equal(enabledWechat.json().revision, 5);

    const gameADouyinProvider = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/douyin",
      {
        enabled: false,
        appId: providerAppId("game-a", "douyin"),
        endpoint: providerEndpoint("douyin"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 5,
      },
    );
    assert.equal(
      gameADouyinProvider.statusCode,
      200,
      gameADouyinProvider.body,
    );
    assert.equal(gameADouyinProvider.json().revision, 6);
    const gameADouyinSecret = randomValue();
    storeProviderSecret("game-a", "douyin", gameADouyinSecret);
    const douyinSecretWrite = await mutate(
      "PUT",
      "/v1/admin/games/game-a/identity-providers/douyin/secret",
      {
        appSecret: gameADouyinSecret,
        revision: 6,
        operationId: "set-game-a-douyin",
      },
    );
    assert.equal(
      douyinSecretWrite.statusCode,
      200,
      douyinSecretWrite.body,
    );
    assert.equal(douyinSecretWrite.body.includes(gameADouyinSecret), false);
    assert.equal(douyinSecretWrite.json().revision, 7);
    const enabledDouyin = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/douyin",
      {
        enabled: true,
        appId: providerAppId("game-a", "douyin"),
        endpoint: providerEndpoint("douyin"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 7,
      },
    );
    assert.equal(enabledDouyin.statusCode, 200, enabledDouyin.body);
    assert.equal(enabledDouyin.json().revision, 8);

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

    const loginProvider = async (
      provider: IdentityProvider,
      code: string,
    ) => publicApp.inject({
      method: "POST",
      url: `/v1/games/game-a/sessions/${provider}`,
      payload: { code, serverId: 1 },
    });
    for (const provider of ["wechat", "douyin"] as const) {
      const invalidCode = await loginProvider(
        provider,
        `${provider}-invalid-code`,
      );
      assert.equal(invalidCode.statusCode, 401, invalidCode.body);
      assert.equal(invalidCode.json().code, "AUTH_CODE_INVALID");
    }
    const unavailable = await loginProvider(
      "wechat",
      "wechat-unavailable",
    );
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json().code, "PROVIDER_UNAVAILABLE");
    const upstreamRateLimited = await loginProvider(
      "douyin",
      "douyin-rate-limited",
    );
    assert.equal(
      upstreamRateLimited.statusCode,
      429,
      upstreamRateLimited.body,
    );
    assert.equal(upstreamRateLimited.json().code, "RATE_LIMITED");

    const validationAfterBusinessFailures = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    assert.equal(
      validationAfterBusinessFailures.statusCode,
      200,
      validationAfterBusinessFailures.body,
    );
    for (const provider of validationAfterBusinessFailures.json().providers) {
      assert.equal(provider.validationState, "unvalidated");
      assert.equal(provider.validationFailedAt, null);
      assert.equal(provider.validationErrorCode, null);
    }

    const wechatLoginA = await loginProvider(
      "wechat",
      "wechat-success-a",
    );
    const wechatLoginB = await loginProvider(
      "wechat",
      "wechat-success-b",
    );
    const douyinLogin = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    for (const response of [wechatLoginA, wechatLoginB, douyinLogin]) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().isNewAccount, true);
    }
    assert.notEqual(
      wechatLoginA.json().userId,
      douyinLogin.json().userId,
    );
    const repeatedWechat = await loginProvider(
      "wechat",
      "wechat-success-a",
    );
    const repeatedDouyin = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    assert.equal(repeatedWechat.statusCode, 200, repeatedWechat.body);
    assert.equal(repeatedWechat.json().isNewAccount, false);
    assert.equal(repeatedDouyin.statusCode, 200, repeatedDouyin.body);
    assert.equal(repeatedDouyin.json().isNewAccount, false);

    const identityConflict = await loginProvider(
      "wechat",
      "wechat-conflict",
    );
    assert.equal(identityConflict.statusCode, 409, identityConflict.body);
    assert.equal(identityConflict.json().code, "IDENTITY_CONFLICT");

    const activeValidation = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    for (const provider of activeValidation.json().providers) {
      assert.equal(provider.validationState, "active");
      assert.equal(provider.validationFailedAt, null);
    }

    const invalidCredentials = await loginProvider(
      "douyin",
      "douyin-invalid-credentials",
    );
    assert.equal(
      invalidCredentials.statusCode,
      503,
      invalidCredentials.body,
    );
    assert.equal(
      invalidCredentials.json().code,
      "PROVIDER_CONFIGURATION_INVALID",
    );
    const failedValidationMetadata = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    const failedDouyin = failedValidationMetadata
      .json()
      .providers
      .find((provider: { provider: string }) => (
        provider.provider === "douyin"
      ));
    const healthyWechat = failedValidationMetadata
      .json()
      .providers
      .find((provider: { provider: string }) => (
        provider.provider === "wechat"
      ));
    assert.ok(failedDouyin);
    assert.ok(healthyWechat);
    assert.equal(failedDouyin.validationState, "validation_failed");
    assert.ok(failedDouyin.validationFailedAt);
    assert.equal(
      failedDouyin.validationErrorCode,
      "invalid_credentials",
    );
    assert.equal(healthyWechat.validationState, "active");

    const fetchCountAfterCredentialFailure = providerFetches.length;
    const fastFailedDouyin = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    assert.equal(fastFailedDouyin.statusCode, 503, fastFailedDouyin.body);
    assert.equal(
      fastFailedDouyin.json().code,
      "PROVIDER_CONFIGURATION_INVALID",
    );
    assert.equal(providerFetches.length, fetchCountAfterCredentialFailure);

    const rotatedGameADouyinSecret = randomValue();
    storeProviderSecret(
      "game-a",
      "douyin",
      rotatedGameADouyinSecret,
    );
    const rotateDouyin = await mutate(
      "PUT",
      "/v1/admin/games/game-a/identity-providers/douyin/secret",
      {
        appSecret: rotatedGameADouyinSecret,
        revision: 8,
        operationId: "rotate-game-a-douyin",
      },
    );
    assert.equal(rotateDouyin.statusCode, 200, rotateDouyin.body);
    assert.equal(rotateDouyin.body.includes(rotatedGameADouyinSecret), false);
    assert.deepEqual({
      version: rotateDouyin.json().secretMetadata.version,
      revision: rotateDouyin.json().revision,
      loadedRevision: rotateDouyin.json().loadedRevision,
    }, {
      version: 2,
      revision: 9,
      loadedRevision: 8,
    });
    const afterDouyinRotation = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    const rotatedDouyinProvider = afterDouyinRotation
      .json()
      .providers
      .find((provider: { provider: string }) => (
        provider.provider === "douyin"
      ));
    assert.equal(afterDouyinRotation.json().revision, 9);
    assert.equal(afterDouyinRotation.json().loadedRevision, 8);
    assert.equal(rotatedDouyinProvider.validationState, "unvalidated");
    assert.equal(rotatedDouyinProvider.secretMetadata.version, 2);

    const recoveredDouyin = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    assert.equal(recoveredDouyin.statusCode, 200, recoveredDouyin.body);
    assert.equal(recoveredDouyin.json().isNewAccount, false);
    const loadedAfterRotation = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/integration",
      headers: { cookie: adminCookie },
    });
    assert.equal(loadedAfterRotation.json().loadedRevision, 9);
    assert.equal(
      loadedAfterRotation
        .json()
        .providers
        .find((provider: { provider: string }) => (
          provider.provider === "douyin"
        ))
        .validationState,
      "active",
    );
    const originalDouyinUserId = String(douyinLogin.json().userId);
    assert.equal(recoveredDouyin.json().userId, originalDouyinUserId);
    const [douyinIdentitiesBeforeDisable] =
      await runtime.database.pool.query<RowDataPacket[]>(
        `SELECT subject_type, subject, user_id
           FROM account_identities
          WHERE game_id = 'game-a'
            AND provider = 'douyin'
            AND provider_app_id = ?
          ORDER BY subject_type, subject`,
        [providerAppId("game-a", "douyin")],
      );
    const normalizedDouyinIdentities = (rows: RowDataPacket[]) => (
      rows.map((row) => ({
        subjectType: String(row.subject_type),
        subject: String(row.subject),
        userId: String(row.user_id),
      }))
    );
    assert.deepEqual(
      normalizedDouyinIdentities(douyinIdentitiesBeforeDisable),
      [
        {
          subjectType: "openid",
          subject: "douyin-openid-a",
          userId: originalDouyinUserId,
        },
        {
          subjectType: "unionid",
          subject: "douyin-union-a",
          userId: originalDouyinUserId,
        },
      ],
    );

    const disableDouyin = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/douyin",
      {
        enabled: false,
        appId: providerAppId("game-a", "douyin"),
        endpoint: providerEndpoint("douyin"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 9,
      },
      limitedCookie,
    );
    assert.equal(disableDouyin.statusCode, 200, disableDouyin.body);
    assert.equal(disableDouyin.json().revision, 10);
    assert.equal(disableDouyin.json().configurationState, "configured");
    const disabledDouyinProvider = disableDouyin
      .json()
      .providers
      .find((provider: { provider: string }) => (
        provider.provider === "douyin"
      ));
    assert.ok(disabledDouyinProvider);
    assert.equal(disabledDouyinProvider.enabled, false);
    assert.equal(disabledDouyinProvider.secretMetadata.version, 2);

    const [douyinIdentitiesAfterDisable] =
      await runtime.database.pool.query<RowDataPacket[]>(
        `SELECT subject_type, subject, user_id
           FROM account_identities
          WHERE game_id = 'game-a'
            AND provider = 'douyin'
            AND provider_app_id = ?
          ORDER BY subject_type, subject`,
        [providerAppId("game-a", "douyin")],
      );
    assert.deepEqual(
      normalizedDouyinIdentities(douyinIdentitiesAfterDisable),
      normalizedDouyinIdentities(douyinIdentitiesBeforeDisable),
    );
    const [disabledDouyinRows] =
      await runtime.database.pool.query<RowDataPacket[]>(
        `SELECT enabled, secret_version,
                app_secret = ? AS secret_preserved
           FROM game_identity_providers
          WHERE game_id = 'game-a' AND provider = 'douyin'`,
        [rotatedGameADouyinSecret],
      );
    assert.equal(disabledDouyinRows.length, 1);
    assert.deepEqual({
      enabled: Number(disabledDouyinRows[0]!.enabled) === 1,
      secretVersion: Number(disabledDouyinRows[0]!.secret_version),
      secretPreserved: Number(disabledDouyinRows[0]!.secret_preserved) === 1,
    }, {
      enabled: false,
      secretVersion: 2,
      secretPreserved: true,
    });
    const [disableDouyinAudits] =
      await runtime.database.pool.query<RowDataPacket[]>(
        `SELECT action, result, revision,
                request_id IS NOT NULL AS has_request_id,
                JSON_UNQUOTE(
                  JSON_EXTRACT(before_data, '$.enabled')
                ) AS before_enabled,
                JSON_UNQUOTE(
                  JSON_EXTRACT(after_data, '$.enabled')
                ) AS after_enabled
           FROM admin_game_audit
          WHERE game_id = 'game-a'
            AND provider = 'douyin'
            AND action = 'identity_provider_disable'
          ORDER BY id DESC`,
      );
    assert.equal(disableDouyinAudits.length, 1);
    assert.deepEqual({
      action: String(disableDouyinAudits[0]!.action),
      result: String(disableDouyinAudits[0]!.result),
      revision: Number(disableDouyinAudits[0]!.revision),
      hasRequestId:
        Number(disableDouyinAudits[0]!.has_request_id) === 1,
      beforeEnabled: String(disableDouyinAudits[0]!.before_enabled),
      afterEnabled: String(disableDouyinAudits[0]!.after_enabled),
    }, {
      action: "identity_provider_disable",
      result: "succeeded",
      revision: 10,
      hasRequestId: true,
      beforeEnabled: "true",
      afterEnabled: "false",
    });

    const wechatWhileDouyinDisabled = await loginProvider(
      "wechat",
      "wechat-success-a",
    );
    assert.equal(
      wechatWhileDouyinDisabled.statusCode,
      200,
      wechatWhileDouyinDisabled.body,
    );
    assert.equal(
      wechatWhileDouyinDisabled.json().userId,
      wechatLoginA.json().userId,
    );
    assert.equal(wechatWhileDouyinDisabled.json().isNewAccount, false);
    const fetchCountBeforeDisabledDouyin = providerFetches.length;
    const loginWhileDouyinDisabled = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    assert.equal(
      loginWhileDouyinDisabled.statusCode,
      503,
      loginWhileDouyinDisabled.body,
    );
    assert.equal(
      loginWhileDouyinDisabled.json().code,
      "PROVIDER_UNAVAILABLE",
    );
    assert.equal(providerFetches.length, fetchCountBeforeDisabledDouyin);

    const reenableDouyin = await mutate(
      "PATCH",
      "/v1/admin/games/game-a/identity-providers/douyin",
      {
        enabled: true,
        appId: providerAppId("game-a", "douyin"),
        endpoint: providerEndpoint("douyin"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 10,
      },
      limitedCookie,
    );
    assert.equal(reenableDouyin.statusCode, 200, reenableDouyin.body);
    assert.equal(reenableDouyin.json().revision, 11);
    assert.equal(reenableDouyin.json().configurationState, "configured");
    const reenabledDouyinProvider = reenableDouyin
      .json()
      .providers
      .find((provider: { provider: string }) => (
        provider.provider === "douyin"
      ));
    assert.ok(reenabledDouyinProvider);
    assert.equal(reenabledDouyinProvider.enabled, true);
    assert.equal(reenabledDouyinProvider.secretMetadata.version, 2);
    const douyinAfterReenable = await loginProvider(
      "douyin",
      "douyin-success-a",
    );
    assert.equal(
      douyinAfterReenable.statusCode,
      200,
      douyinAfterReenable.body,
    );
    assert.equal(douyinAfterReenable.json().userId, originalDouyinUserId);
    assert.equal(douyinAfterReenable.json().isNewAccount, false);
    assert.deepEqual(credentialMismatches, []);

    await configureGame("game-b", 20);
    const rotatedGameBAppSecret = randomValue();
    storeProviderSecret("game-b", "wechat", rotatedGameBAppSecret);
    const concurrentSecretWrites = await Promise.all([
      mutate(
        "PUT",
        "/v1/admin/games/game-b/identity-providers/wechat/secret",
        {
          appSecret: rotatedGameBAppSecret,
          revision: 5,
          operationId: "rotate-game-b-wechat-concurrent",
        },
      ),
      mutate(
        "PUT",
        "/v1/admin/games/game-b/identity-providers/wechat/secret",
        {
          appSecret: rotatedGameBAppSecret,
          revision: 5,
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
    assert.equal(concurrentSecretWrites[0]?.json().secretMetadata.version, 2);

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

    const revokedCurrent = await mutate(
      "POST",
      "/v1/admin/machine-identities/game-a-service"
        + "/secret-versions/2/revoke",
      {
        operationId: "revoke-game-a-service-v2",
        revision: 3,
        reason: "当前凭据疑似泄露",
      },
    );
    assert.equal(revokedCurrent.statusCode, 200, revokedCurrent.body);
    const revokedCurrentRejected = await internalApp.inject({
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
    assert.equal(
      revokedCurrentRejected.statusCode,
      401,
      revokedCurrentRejected.body,
    );
    const [revokedUse] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT last_used_at, revoked_at
         FROM machine_secret_versions
        WHERE identity_id = 'game-a-service' AND version = 2`,
    );
    assert.ok(revokedUse[0]?.last_used_at);
    assert.ok(revokedUse[0]?.revoked_at);
    assert.ok(
      new Date(String(revokedUse[0].last_used_at)).getTime()
      >= new Date(String(revokedUse[0].revoked_at)).getTime(),
    );
    const recoveredRotation = await mutate(
      "POST",
      "/v1/admin/machine-identities/game-a-service/secret-rotations",
      {
        operationId: "recover-game-a-service",
        revision: 4,
        previousValiditySeconds: 60,
      },
    );
    assert.equal(recoveredRotation.statusCode, 200, recoveredRotation.body);
    assert.equal(recoveredRotation.json().version, 3);
    assert.equal(recoveredRotation.json().previousExpiresAt, null);
    const recoveredServiceSecret = String(recoveredRotation.json().secret);
    assert.match(recoveredServiceSecret, /^[A-Za-z0-9_-]{43}$/);
    const recoveredAccepted = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-a/internal/sessions/verify",
      headers: {
        "x-service-id": "game-a-service",
        "x-service-secret": recoveredServiceSecret,
      },
      payload: {
        accessToken: loginBody.accessToken,
        serverId: 1,
      },
    });
    assert.equal(recoveredAccepted.statusCode, 200, recoveredAccepted.body);

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
        ...allProviderSecrets,
        serviceSecret,
        rotatedServiceSecret,
        recoveredServiceSecret,
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

    const [storedProviders] = await runtime.database.pool.query<
      RowDataPacket[]
    >(
      `SELECT game_id, provider, enabled, app_id, app_secret,
              secret_version, validation_state
         FROM game_identity_providers
        ORDER BY game_id, FIELD(provider, 'wechat', 'douyin')`,
    );
    assert.deepEqual(storedProviders.map((row) => ({
      gameId: String(row.game_id),
      provider: String(row.provider),
      enabled: Number(row.enabled) === 1,
      appId: row.app_id === null ? null : String(row.app_id),
      appSecret: row.app_secret === null ? null : String(row.app_secret),
      version: Number(row.secret_version),
      validationState: String(row.validation_state),
    })), [
      {
        gameId: "game-a",
        provider: "wechat",
        enabled: true,
        appId: providerAppId("game-a", "wechat"),
        appSecret: gameAWechatSecret,
        version: 1,
        validationState: "active",
      },
      {
        gameId: "game-a",
        provider: "douyin",
        enabled: true,
        appId: providerAppId("game-a", "douyin"),
        appSecret: rotatedGameADouyinSecret,
        version: 2,
        validationState: "active",
      },
      {
        gameId: "game-b",
        provider: "wechat",
        enabled: true,
        appId: providerAppId("game-b", "wechat"),
        appSecret: rotatedGameBAppSecret,
        version: 2,
        validationState: "unvalidated",
      },
      {
        gameId: "game-b",
        provider: "douyin",
        enabled: false,
        appId: null,
        appSecret: null,
        version: 0,
        validationState: "unvalidated",
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
        state: "revoked",
      },
      {
        identityId: "game-a-service",
        version: 3,
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
    const failedSecretReasons = failedSecretAudits.map((row) => {
      assert.equal(String(row.result), "failed");
      return String(row.reason);
    });
    assert.ok(
      failedSecretReasons.filter((reason) => reason === "GAME_ACCESS_DENIED")
        .length >= 2,
    );
    assert.ok(failedSecretReasons.includes("OPERATION_CONFLICT"));
    assert.ok(failedSecretReasons.every((reason) => (
      reason === "GAME_ACCESS_DENIED" || reason === "OPERATION_CONFLICT"
    )));
    const auditText = [...gameAudits, ...secretAudits]
      .map((row) => String(row.audit_text))
      .join("\n");
    for (const secret of [
      ...allProviderSecrets,
      serviceSecret,
      rotatedServiceSecret,
      recoveredServiceSecret,
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
    const clearedGameBSecret = await mutate(
      "DELETE",
      "/v1/admin/games/game-b/identity-providers/wechat/secret",
      {
        revision: 6,
        operationId: "clear-game-b-wechat",
      },
    );
    assert.equal(
      clearedGameBSecret.statusCode,
      200,
      clearedGameBSecret.body,
    );
    assert.deepEqual({
      configured: clearedGameBSecret.json().secretMetadata.configured,
      version: clearedGameBSecret.json().secretMetadata.version,
      revision: clearedGameBSecret.json().revision,
      configurationState: clearedGameBSecret.json().configurationState,
      replayed: clearedGameBSecret.json().replayed,
    }, {
      configured: false,
      version: 0,
      revision: 7,
      configurationState: "draft",
      replayed: false,
    });
    assert.equal(
      clearedGameBSecret.body.includes(rotatedGameBAppSecret),
      false,
    );
    const replayedClear = await mutate(
      "DELETE",
      "/v1/admin/games/game-b/identity-providers/wechat/secret",
      {
        revision: 6,
        operationId: "clear-game-b-wechat",
      },
    );
    assert.equal(replayedClear.statusCode, 200, replayedClear.body);
    assert.equal(replayedClear.json().replayed, true);

    const clearedGameBAppId = await mutate(
      "PATCH",
      "/v1/admin/games/game-b/identity-providers/wechat",
      {
        enabled: false,
        appId: null,
        endpoint: providerEndpoint("wechat"),
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        revision: 7,
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
