import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  createAdminOperator,
  generateAdminPassword,
} from "../../src/admin-create.js";
import { createRuntime } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { GameRegistry } from "../../src/domain/game/registry.js";

const execFileAsync = promisify(execFile);

const TENANT_ENV = {
  GAME_A_WX_APPID: "game-a-app",
  GAME_A_WX_SECRET: "game-a-wx-secret",
  GAME_B_WX_APPID: "game-b-app",
  GAME_B_WX_SECRET: "game-b-wx-secret",
  GAME_A_SERVICE_SECRET: "integration-game-a-service",
  GAME_B_SERVICE_SECRET: "integration-game-b-service",
  GAME_A_ADMIN_SECRET: "integration-game-a-admin",
  GAME_B_ADMIN_SECRET: "integration-game-b-admin",
} as const;

interface LoginBody {
  userId: string;
  accessToken: string;
  isNewAccount: boolean;
}

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createIntegrationGamesConfig(directory: string): Promise<string> {
  const document = JSON.parse(await readFile("config/games.json", "utf8")) as {
    games: Array<{
      directoryPath: string;
      loginRate: { capacity: number; refillPerSecond: number };
      adminRate: { capacity: number; refillPerSecond: number };
    }>;
  };
  for (const game of document.games) {
    game.directoryPath = resolve("config", game.directoryPath);
    game.loginRate = { capacity: 1_000, refillPerSecond: 1_000 };
    game.adminRate = { capacity: 1_000, refillPerSecond: 1_000 };
  }
  const path = join(directory, "games.integration.json");
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

test("多游戏迁移、认证、数据与运行态完整隔离", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3306/mysql";
  const databaseName = `game_manage_kit_test_${process.pid}_${Date.now()}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "game-manage-kit-int-"));
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("测试数据库名非法");
  }
  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;

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

    const check = await mysql.createConnection(mysqlUrl);
    try {
      const [versions] = await check.query<RowDataPacket[]>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        versions.map((row) => [Number(row.version), String(row.name)]),
        [
          [1, "0001_initial.sql"],
          [2, "0002_game_servers.sql"],
        ],
      );
      const [tables] = await check.query<RowDataPacket[]>("SHOW TABLES");
      assert.equal(tables.length, 14);
      const [sessionKeyColumns] = await check.query<RowDataPacket[]>(
        "SHOW COLUMNS FROM accounts LIKE 'session_key'",
      );
      assert.equal(sessionKeyColumns.length, 0);
    } finally {
      await check.end();
    }

    const gamesConfigPath = await createIntegrationGamesConfig(temporaryDirectory);
    const config = loadConfig({
      NODE_ENV: "development",
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
      GAME_MANAGE_KIT_GAMES_CONFIG: gamesConfigPath,
      AUTH_DEV_ENABLED: "1",
      GAME_MANAGE_KIT_LOG_ENABLED: "0",
    });
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      openid: "shared-wx-openid",
      unionid: "shared-wx-unionid",
      session_key: "must-not-be-persisted",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const games = await GameRegistry.load(gamesConfigPath, {
      production: false,
      env: TENANT_ENV,
      fetchImpl,
    });
    runtime = await createRuntime(config, { games });
    const { publicApp, internalApp } = runtime.apps;
    const [seededDirectories] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT d.game_id, d.is_ops, COUNT(s.server_id) AS server_count
         FROM game_directory_settings d
         LEFT JOIN game_servers s ON s.game_id = d.game_id
        GROUP BY d.game_id, d.is_ops
        ORDER BY d.game_id`,
    );
    assert.deepEqual(seededDirectories.map((row) => ({
      gameId: String(row.game_id),
      isOps: Number(row.is_ops),
      serverCount: Number(row.server_count),
    })), [
      { gameId: "game-a", isOps: 0, serverCount: 3 },
      { gameId: "game-b", isOps: 1, serverCount: 2 },
    ]);
    const webAdminPassword = generateAdminPassword(
      () => Buffer.alloc(12, 0x42),
    );
    await createAdminOperator(runtime.database, {
      operatorId: "ops_integration",
      displayName: "Integration Admin",
      gameIds: ["game-a"],
      canOperateAccounts: true,
      canManageGames: true,
    }, webAdminPassword);
    const webLogin = async (password = webAdminPassword): Promise<string> => {
      const response = await internalApp.inject({
        method: "POST",
        url: "/v1/admin/auth/login",
        headers: { origin: config.adminOrigin },
        payload: { operatorId: "ops_integration", password },
      });
      assert.equal(response.statusCode, 204, response.body);
      const setCookie = response.headers["set-cookie"];
      const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
        .find((cookie) => (
          cookie?.startsWith("gmk_admin_session=")
          && !cookie.includes("Max-Age=0")
        ));
      assert.equal(typeof sessionCookie, "string");
      if (sessionCookie === undefined) {
        throw new Error("管理员登录未返回 Cookie");
      }
      return sessionCookie.split(";", 1)[0]!;
    };
    const serviceA = {
      "x-service-id": "game-a-service",
      "x-service-secret": TENANT_ENV.GAME_A_SERVICE_SECRET,
    };
    const serviceB = {
      "x-service-id": "game-b-service",
      "x-service-secret": TENANT_ENV.GAME_B_SERVICE_SECRET,
    };
    const adminA = {
      "x-operator-id": "game-a-admin",
      "x-admin-secret": TENANT_ENV.GAME_A_ADMIN_SECRET,
    };
    const adminB = {
      "x-operator-id": "game-b-admin",
      "x-admin-secret": TENANT_ENV.GAME_B_ADMIN_SECRET,
    };
    const loginDev = async (
      gameId: "game-a" | "game-b",
      devKey: string,
      serverId = 1,
    ): Promise<LoginBody> => {
      const response = await publicApp.inject({
        method: "POST",
        url: `/v1/games/${gameId}/sessions/dev`,
        payload: { devKey, serverId },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<LoginBody>();
    };
    const verify = async (
      gameId: "game-a" | "game-b",
      accessToken: string,
      serverId = 1,
    ) => internalApp.inject({
      method: "POST",
      url: `/v1/games/${gameId}/internal/sessions/verify`,
      headers: gameId === "game-a" ? serviceA : serviceB,
      payload: { accessToken, serverId },
    });

    const wrongAdminLogin = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: { origin: config.adminOrigin },
      payload: {
        operatorId: "ops_integration",
        password: "wrong admin password",
      },
    });
    assert.equal(wrongAdminLogin.statusCode, 401);
    assert.equal(wrongAdminLogin.json().code, "ADMIN_AUTH_REQUIRED");
    const adminCookie = await webLogin();
    const webSession = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: adminCookie },
    });
    assert.equal(webSession.statusCode, 200);
    assert.deepEqual(
      webSession.json().games.map((game: { gameId: string }) => game.gameId),
      ["game-a"],
    );
    assert.equal(webSession.json().canManageGames, true);
    const initialClientGames = await publicApp.inject({
      method: "GET",
      url: "/v1/games",
    });
    assert.equal(initialClientGames.statusCode, 200);
    assert.deepEqual(
      initialClientGames.json().games.map(
        (game: { gameId: string }) => game.gameId,
      ),
      ["game-a", "game-b"],
    );
    const managedGames = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games",
      headers: { cookie: adminCookie },
    });
    assert.equal(managedGames.statusCode, 200, managedGames.body);
    const gameAProject = managedGames.json().games.find(
      (game: { gameId: string }) => game.gameId === "game-a",
    );
    assert.equal(gameAProject.configurationState, "configured");
    assert.equal(gameAProject.clientVisible, true);

    const createdProject = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/games",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        gameId: "game-c",
        name: "游戏 C",
        description: "等待技术配置",
      },
    });
    assert.equal(createdProject.statusCode, 201, createdProject.body);
    assert.deepEqual({
      status: createdProject.json().status,
      configurationState: createdProject.json().configurationState,
      clientVisible: createdProject.json().clientVisible,
      revision: createdProject.json().revision,
    }, {
      status: "maintenance",
      configurationState: "draft",
      clientVisible: false,
      revision: 1,
    });

    const updatedDraft = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-c",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        name: "游戏 C（筹备中）",
        description: "尚未写入部署配置",
        status: "maintenance",
        clientVisible: false,
        sortOrder: 30,
        revision: 1,
      },
    });
    assert.equal(updatedDraft.statusCode, 200, updatedDraft.body);
    assert.equal(updatedDraft.json().revision, 2);
    const staleDraftUpdate = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-c",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        name: "旧版本覆盖",
        description: "",
        status: "maintenance",
        clientVisible: false,
        sortOrder: 0,
        revision: 1,
      },
    });
    assert.equal(staleDraftUpdate.statusCode, 409);
    assert.equal(
      staleDraftUpdate.json().code,
      "GAME_PROJECT_CONFLICT",
    );
    const clientGamesAfterDraft = await publicApp.inject({
      method: "GET",
      url: "/v1/games",
    });
    assert.equal(
      clientGamesAfterDraft.json().games.some(
        (game: { gameId: string }) => game.gameId === "game-c",
      ),
      false,
    );

    const maintenanceGameA = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-a",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        name: gameAProject.name,
        description: "维护公告",
        status: "maintenance",
        clientVisible: true,
        sortOrder: 0,
        revision: gameAProject.revision,
      },
    });
    assert.equal(maintenanceGameA.statusCode, 200, maintenanceGameA.body);
    const maintainedClientGames = await publicApp.inject({
      method: "GET",
      url: "/v1/games",
    });
    assert.equal(
      maintainedClientGames.json().games.find(
        (game: { gameId: string }) => game.gameId === "game-a",
      ).status,
      "maintenance",
    );
    const maintenanceLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "maintenance-game", serverId: 1 },
    });
    assert.equal(maintenanceLogin.statusCode, 503);
    assert.equal(maintenanceLogin.json().code, "GAME_DISABLED");
    const restoredGameA = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-a",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        name: gameAProject.name,
        description: "",
        status: "enabled",
        clientVisible: true,
        sortOrder: 0,
        revision: maintenanceGameA.json().revision,
      },
    });
    assert.equal(restoredGameA.statusCode, 200, restoredGameA.body);

    const initialManagedServers = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-a/servers",
      headers: { cookie: adminCookie },
    });
    assert.equal(
      initialManagedServers.statusCode,
      200,
      initialManagedServers.body,
    );
    assert.deepEqual(
      initialManagedServers.json().servers.map(
        (server: { serverId: number }) => server.serverId,
      ),
      [1, 2, 9],
    );
    const gameAServer2 = initialManagedServers.json().servers.find(
      (server: { serverId: number }) => server.serverId === 2,
    );

    const draftServer = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/games/game-c/servers",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        serverId: 7,
        name: "C 预备服",
        tag: "new",
        status: "smooth",
        openTime: 1_800_000_000,
        gameHttpUrl: "http://127.0.0.1:28080",
        gameWsUrl: "ws://127.0.0.1:28081",
        isOpen: false,
        sortOrder: 7,
      },
    });
    assert.equal(draftServer.statusCode, 201, draftServer.body);
    assert.deepEqual({
      gameId: draftServer.json().gameId,
      serverId: draftServer.json().serverId,
      isOpen: draftServer.json().isOpen,
      revision: draftServer.json().revision,
    }, {
      gameId: "game-c",
      serverId: 7,
      isOpen: false,
      revision: 1,
    });
    const duplicateDraftServer = await internalApp.inject({
      method: "POST",
      url: "/v1/admin/games/game-c/servers",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        serverId: 7,
        name: "重复区服",
        tag: "normal",
        status: "smooth",
        openTime: 1_800_000_001,
        gameHttpUrl: "https://game-c.example.invalid",
        gameWsUrl: "wss://game-c.example.invalid",
        isOpen: false,
        sortOrder: 8,
      },
    });
    assert.equal(duplicateDraftServer.statusCode, 409);
    assert.equal(
      duplicateDraftServer.json().code,
      "GAME_SERVER_CONFLICT",
    );
    const listedDraftServers = await internalApp.inject({
      method: "GET",
      url: "/v1/admin/games/game-c/servers",
      headers: { cookie: adminCookie },
    });
    assert.equal(listedDraftServers.statusCode, 200);
    assert.equal(listedDraftServers.json().servers.length, 1);

    const closeServer2Payload = {
      name: gameAServer2.name,
      tag: gameAServer2.tag,
      status: gameAServer2.status,
      openTime: gameAServer2.openTime,
      gameHttpUrl: gameAServer2.gameHttpUrl,
      gameWsUrl: gameAServer2.gameWsUrl,
      isOpen: false,
      sortOrder: gameAServer2.sortOrder,
      revision: gameAServer2.revision,
    };
    const closedServer2 = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-a/servers/2",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: closeServer2Payload,
    });
    assert.equal(closedServer2.statusCode, 200, closedServer2.body);
    assert.equal(closedServer2.json().isOpen, false);
    assert.equal(closedServer2.json().revision, 2);
    const staleServerUpdate = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-a/servers/2",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: closeServer2Payload,
    });
    assert.equal(staleServerUpdate.statusCode, 409);
    assert.equal(staleServerUpdate.json().code, "GAME_SERVER_CONFLICT");
    const areasWithClosedServer = await publicApp.inject({
      method: "GET",
      url: "/v1/games/game-a/areas",
    });
    assert.deepEqual(
      areasWithClosedServer.json().servers.map(
        (server: { serverId: number }) => server.serverId,
      ),
      [1, 9],
    );
    const closedServerLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "closed-server", serverId: 2 },
    });
    assert.equal(closedServerLogin.statusCode, 403);
    assert.equal(closedServerLogin.json().code, "SERVER_DISABLED");

    await games.sync(runtime.database.pool);
    const [preservedServerRows] =
      await runtime.database.pool.query<RowDataPacket[]>(
        `SELECT is_open
           FROM game_servers
          WHERE game_id = 'game-a' AND server_id = 2`,
      );
    assert.equal(Number(preservedServerRows[0]?.is_open), 0);

    const reopenedServer2 = await internalApp.inject({
      method: "PATCH",
      url: "/v1/admin/games/game-a/servers/2",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: {
        ...closeServer2Payload,
        isOpen: true,
        revision: closedServer2.json().revision,
      },
    });
    assert.equal(reopenedServer2.statusCode, 200, reopenedServer2.body);
    assert.equal(reopenedServer2.json().isOpen, true);

    const [gameAudit] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT game_id, action
         FROM admin_game_audit
        WHERE operator_id = 'ops_integration'
        ORDER BY id`,
    );
    assert.deepEqual(
      gameAudit.map((row) => [String(row.game_id), String(row.action)]),
      [
        ["game-c", "create"],
        ["game-c", "update"],
        ["game-a", "update"],
        ["game-a", "update"],
        ["game-c", "server_create"],
        ["game-a", "server_update"],
        ["game-a", "server_update"],
      ],
    );
    const [creationAudit] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT event, reason
         FROM admin_auth_audit
        WHERE operator_id = 'ops_integration'
          AND event = 'operator_created'`,
    );
    assert.deepEqual(
      creationAudit.map((row) => [String(row.event), String(row.reason)]),
      [["operator_created", "cli"]],
    );

    const ready = await publicApp.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { ready: true });
    assert.equal(await runtime.database.ready(0, ["game-a", "game-b"]), false);
    assert.equal(await runtime.database.ready(1, ["game-a", "game-b"]), false);
    assert.equal(
      await runtime.database.ready(2, ["game-a", "game-b", "missing-game"]),
      false,
    );

    const unknownGame = await publicApp.inject({
      method: "POST",
      url: "/v1/games/missing-game/sessions/dev",
      payload: { devKey: "unknown-game", serverId: 1 },
    });
    assert.equal(unknownGame.statusCode, 404);
    assert.equal(unknownGame.json().code, "GAME_NOT_FOUND");
    const unknownServer = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "unknown-server", serverId: 8 },
    });
    assert.equal(unknownServer.statusCode, 404);
    assert.equal(unknownServer.json().code, "SERVER_NOT_FOUND");
    const maintenanceServer = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "maintenance-server", serverId: 9 },
    });
    assert.equal(maintenanceServer.statusCode, 403);
    assert.equal(maintenanceServer.json().code, "SERVER_DISABLED");

    const concurrentLogins = await Promise.all(
      Array.from({ length: 8 }, () => loginDev("game-a", "concurrent-player", 2)),
    );
    assert.equal(new Set(concurrentLogins.map((body) => body.userId)).size, 1);
    assert.equal(concurrentLogins.filter((body) => body.isNewAccount).length, 1);
    assert.equal(new Set(concurrentLogins.map((body) => body.accessToken)).size, 8);
    const concurrentVerifications = await Promise.all(
      concurrentLogins.map(async (body) => (await verify("game-a", body.accessToken, 2)).json()),
    );
    assert.equal(
      concurrentVerifications.filter((body) => body.valid === true).length,
      1,
    );

    const wxAResponse = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/wechat",
      payload: { code: "wx-a", serverId: 1 },
    });
    const wxBResponse = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-b/sessions/wechat",
      payload: { code: "wx-b", serverId: 1 },
    });
    assert.equal(wxAResponse.statusCode, 200, wxAResponse.body);
    assert.equal(wxBResponse.statusCode, 200, wxBResponse.body);
    const [wechatAccounts] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT game_id, user_id
         FROM accounts
        WHERE openid = ?
        ORDER BY game_id`,
      ["shared-wx-openid"],
    );
    assert.deepEqual(
      wechatAccounts.map((row) => String(row.game_id)),
      ["game-a", "game-b"],
    );

    const sameIdentityA = await loginDev("game-a", "shared-player");
    const sameIdentityB = await loginDev("game-b", "shared-player");
    const [sameOpenIdAccounts] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT game_id, user_id
         FROM accounts
        WHERE openid = 'dev_shared-player'
        ORDER BY game_id`,
    );
    assert.equal(sameOpenIdAccounts.length, 2);
    assert.deepEqual(
      sameOpenIdAccounts.map((row) => String(row.game_id)),
      ["game-a", "game-b"],
    );

    assert.equal((await verify("game-a", sameIdentityA.accessToken)).json().valid, true);
    assert.equal((await verify("game-b", sameIdentityB.accessToken)).json().valid, true);
    assert.deepEqual(
      (await verify("game-b", sameIdentityA.accessToken)).json(),
      { valid: false, reason: "MISMATCH" },
    );
    const serviceCrossGame = await internalApp.inject({
      method: "POST",
      url: "/v1/games/game-b/internal/sessions/verify",
      headers: serviceA,
      payload: { accessToken: sameIdentityB.accessToken, serverId: 1 },
    });
    assert.equal(serviceCrossGame.statusCode, 403);
    assert.equal(serviceCrossGame.json().code, "GAME_ACCESS_DENIED");

    const registerA = await internalApp.inject({
      method: "PUT",
      url: `/v1/games/game-a/internal/characters/${sameIdentityA.userId}/1`,
      headers: serviceA,
    });
    assert.equal(registerA.statusCode, 200, registerA.body);
    const hasA = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-a/internal/characters/${sameIdentityA.userId}/1`,
      headers: serviceA,
    });
    assert.deepEqual(hasA.json(), { exists: true });
    const hasB = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-b/internal/characters/${sameIdentityB.userId}/1`,
      headers: serviceB,
    });
    assert.deepEqual(hasB.json(), { exists: false });
    const missingAccountCharacter = await internalApp.inject({
      method: "PUT",
      url: "/v1/games/game-a/internal/characters/u_999999/1",
      headers: serviceA,
    });
    assert.equal(missingAccountCharacter.statusCode, 404);
    assert.equal(missingAccountCharacter.json().code, "NOT_FOUND");

    const areasA = await publicApp.inject({
      method: "GET",
      url: "/v1/games/game-a/areas",
      headers: { authorization: `Bearer ${sameIdentityA.accessToken}` },
    });
    const areasB = await publicApp.inject({
      method: "GET",
      url: "/v1/games/game-b/areas",
      headers: { authorization: `Bearer ${sameIdentityB.accessToken}` },
    });
    assert.deepEqual(areasA.json().myServerIds, [1]);
    assert.deepEqual(areasB.json().myServerIds, []);
    assert.notEqual(areasA.json().servers[0].name, areasB.json().servers[0].name);

    const adminPlayerA = await loginDev("game-a", "admin-shared");
    const adminPlayerB = await loginDev("game-b", "admin-shared");
    const webAccount = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-a/admin/accounts/${adminPlayerA.userId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(webAccount.statusCode, 200);
    assert.equal(webAccount.json().userId, adminPlayerA.userId);
    assert.equal(webAccount.json().activeSessionCount, 1);
    const webCrossGame = await internalApp.inject({
      method: "GET",
      url: `/v1/games/game-b/admin/accounts/${adminPlayerB.userId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(webCrossGame.statusCode, 403);
    assert.equal(webCrossGame.json().code, "GAME_ACCESS_DENIED");
    const webWritePlayer = await loginDev("game-a", "web-admin-write");
    const webWritePayload = {
      operationId: "web-admin-revoke",
      reason: "browser integration test",
    };
    const webRevoke = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${webWritePlayer.userId}/revoke`,
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: webWritePayload,
    });
    assert.equal(webRevoke.statusCode, 200);
    assert.deepEqual(webRevoke.json(), {
      accountExists: true,
      status: "revoked",
    });
    const webRevokeReplay = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${webWritePlayer.userId}/revoke`,
      headers: { cookie: adminCookie, origin: config.adminOrigin },
      payload: webWritePayload,
    });
    assert.deepEqual(webRevokeReplay.json(), webRevoke.json());
    const sharedOperation = { operationId: "same-operation", reason: "integration test" };
    const revokeA = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${adminPlayerA.userId}/revoke`,
      headers: adminA,
      payload: sharedOperation,
    });
    assert.equal(revokeA.statusCode, 200);
    assert.deepEqual(revokeA.json(), { accountExists: true, status: "revoked" });
    assert.deepEqual(
      (await verify("game-a", adminPlayerA.accessToken)).json(),
      { valid: false, reason: "MISMATCH" },
    );
    assert.equal((await verify("game-b", adminPlayerB.accessToken)).json().valid, true);
    const reloginAfterRevoke = await loginDev("game-a", "admin-shared");
    assert.equal(reloginAfterRevoke.userId, adminPlayerA.userId);
    assert.equal(reloginAfterRevoke.isNewAccount, false);
    assert.equal((await verify("game-a", reloginAfterRevoke.accessToken)).json().valid, true);

    const revokeB = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-b/admin/accounts/${adminPlayerB.userId}/revoke`,
      headers: adminB,
      payload: sharedOperation,
    });
    assert.equal(revokeB.statusCode, 200);
    const [sameOperations] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT game_id
         FROM login_audit
        WHERE operation_id = 'same-operation'
        ORDER BY game_id`,
    );
    assert.deepEqual(
      sameOperations.map((row) => String(row.game_id)),
      ["game-a", "game-b"],
    );
    const revokeReplay = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${adminPlayerA.userId}/revoke`,
      headers: adminA,
      payload: sharedOperation,
    });
    assert.deepEqual(revokeReplay.json(), revokeA.json());
    const operationConflict = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${adminPlayerA.userId}/ban`,
      headers: adminA,
      payload: sharedOperation,
    });
    assert.equal(operationConflict.statusCode, 409);
    assert.equal(operationConflict.json().code, "OPERATION_CONFLICT");

    const concurrentAdminPlayer = await loginDev("game-a", "concurrent-admin");
    const concurrentAdminPayload = {
      operationId: "concurrent-admin-revoke",
      reason: "integration concurrency",
    };
    const concurrentAdminResponses = await Promise.all(
      Array.from({ length: 8 }, () => internalApp.inject({
        method: "POST",
        url:
          `/v1/games/game-a/admin/accounts/${concurrentAdminPlayer.userId}/revoke`,
        headers: adminA,
        payload: concurrentAdminPayload,
      })),
    );
    assert.equal(
      concurrentAdminResponses.every((response) => response.statusCode === 200),
      true,
      concurrentAdminResponses.map((response) => response.body).join("\n"),
    );
    assert.equal(
      concurrentAdminResponses.every((response) => (
        response.json().status === "revoked"
      )),
      true,
    );

    const adminCrossGame = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-b/admin/accounts/${adminPlayerB.userId}/ban`,
      headers: adminA,
      payload: { operationId: "cross-game-admin", reason: "must fail" },
    });
    assert.equal(adminCrossGame.statusCode, 403);
    assert.equal(adminCrossGame.json().code, "GAME_ACCESS_DENIED");

    const banPlayerA = await loginDev("game-a", "ban-shared");
    const banPlayerB = await loginDev("game-b", "ban-shared");
    const banPayload = { operationId: "ban-game-a-only", reason: "integration test" };
    const banA = await internalApp.inject({
      method: "POST",
      url: `/v1/games/game-a/admin/accounts/${banPlayerA.userId}/ban`,
      headers: adminA,
      payload: banPayload,
    });
    assert.equal(banA.statusCode, 200);
    assert.deepEqual(banA.json(), { accountExists: true, status: "banned" });
    const bannedLoginA = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-a/sessions/dev",
      payload: { devKey: "ban-shared", serverId: 1 },
    });
    assert.equal(bannedLoginA.statusCode, 403);
    assert.equal(bannedLoginA.json().code, "ACCOUNT_BANNED");
    const unaffectedLoginB = await publicApp.inject({
      method: "POST",
      url: "/v1/games/game-b/sessions/dev",
      payload: { devKey: "ban-shared", serverId: 1 },
    });
    assert.equal(unaffectedLoginB.statusCode, 200);
    const unaffectedB = unaffectedLoginB.json<LoginBody>();
    assert.equal(unaffectedB.userId, banPlayerB.userId);
    assert.equal((await verify("game-b", unaffectedB.accessToken)).json().valid, true);

    const logout = await internalApp.inject({
      method: "DELETE",
      url: "/v1/admin/auth/session",
      headers: { cookie: adminCookie, origin: config.adminOrigin },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal((await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: adminCookie },
    })).statusCode, 401);

    await runtime.database.pool.execute(
      `INSERT INTO admin_sessions
         (token_hash, operator_id, auth_version, created_at, last_seen_at, expires_at)
       VALUES (
         UNHEX(SHA2('integration-cleanup-token', 256)),
         'ops_integration',
         1,
         DATE_SUB(NOW(3), INTERVAL 2 HOUR),
         DATE_SUB(NOW(3), INTERVAL 31 MINUTE),
         DATE_ADD(NOW(3), INTERVAL 6 HOUR)
       )`,
    );
    assert.equal(await runtime.adminAuth.purgeExpiredSessions(10), 1);
    const [cleanedSessions] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS session_count
         FROM admin_sessions
        WHERE token_hash = UNHEX(SHA2('integration-cleanup-token', 256))`,
    );
    assert.equal(Number(cleanedSessions[0]?.session_count), 0);

    const idleCookie = await webLogin();
    await runtime.database.pool.execute(
      `UPDATE admin_sessions
          SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR),
              last_seen_at = DATE_SUB(NOW(3), INTERVAL 31 MINUTE)
        WHERE operator_id = 'ops_integration'`,
    );
    assert.equal((await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: idleCookie },
    })).statusCode, 401);

    const absoluteCookie = await webLogin();
    await runtime.database.pool.execute(
      `UPDATE admin_sessions
          SET created_at = DATE_SUB(NOW(3), INTERVAL 9 HOUR),
              last_seen_at = NOW(3),
              expires_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR)
        WHERE operator_id = 'ops_integration'`,
    );
    assert.equal((await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: absoluteCookie },
    })).statusCode, 401);

    const disabledCookie = await webLogin();
    await runtime.database.pool.execute(
      "UPDATE admin_operators SET status = 'disabled' WHERE operator_id = 'ops_integration'",
    );
    assert.equal((await internalApp.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { cookie: disabledCookie },
    })).statusCode, 401);

    const metricsA = await internalApp.inject({
      method: "GET",
      url: "/metrics",
      headers: serviceA,
    });
    assert.equal(metricsA.statusCode, 200);
    assert.match(metricsA.body, /game_id="game-a"/);
    assert.doesNotMatch(metricsA.body, /game_id="game-b"/);
    assert.doesNotMatch(metricsA.body, /user_id|access_token|operation_id|service_id/);

    const [auditGames] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT game_id
         FROM login_audit
        ORDER BY game_id`,
    );
    assert.deepEqual(
      auditGames.map((row) => String(row.game_id)),
      ["game-a", "game-b"],
    );
  } finally {
    if (runtime) {
      await Promise.all([
        runtime.apps.publicApp.close(),
        runtime.apps.internalApp.close(),
      ]).catch(() => undefined);
      await runtime.database.close().catch(() => undefined);
    }
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
