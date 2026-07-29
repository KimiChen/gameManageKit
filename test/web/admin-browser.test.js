import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ADMIN_ROOT = fileURLToPath(new URL("../../web/admin/", import.meta.url));
const CHROME_CANDIDATES = [
  process.env.GMK_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
]);

function chromePath() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDevToolsPort(profileDirectory, child) {
  const activePortFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome 提前退出，退出码 ${child.exitCode}`);
    }
    try {
      const [port] = (await readFile(activePortFile, "utf8")).trim().split("\n");
      if (/^[0-9]+$/u.test(port ?? "")) {
        return Number(port);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error("等待 Chrome DevTools 端口超时");
}

function json(reply, status, body) {
  const payload = JSON.stringify(body);
  reply.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "browser-e2e",
  });
  reply.end(payload);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function createAdminFixtureServer({
  bootstrapRequired = false,
  bootstrapResponse = "success",
  emptyGames = false,
} = {}) {
  let authenticated = false;
  let requiresBootstrap = bootstrapRequired;
  let elevatedUntil = null;
  let nextOperationGate = null;
  let nextServerListGate = null;
  let nextServerConflict = false;
  const errors = [];
  const bootstrapMutations = [];
  const operations = [];
  const gameMutations = [];
  const serverMutations = [];
  const integrationMutations = [];
  const machineIdentityMutations = [];
  const machineOperationStatuses = new Map();
  let directoryRevision = 3;
  const gameProjects = emptyGames ? [] : [
    {
      gameId: "game-a",
      name: "游戏 A",
      description: "已上线的示例游戏",
      status: "enabled",
      configurationState: "configured",
      clientVisible: true,
      sortOrder: 10,
      revision: 3,
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    },
  ];
  const gameServers = [
    {
      gameId: "game-a",
      serverId: 1,
      name: "星海一区",
      tag: "new",
      status: "smooth",
      openTime: 1_785_220_200,
      gameHttpUrl: "https://game.example.com/api",
      gameWsUrl: "wss://game.example.com/socket",
      isOpen: true,
      sortOrder: 10,
      revision: 3,
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    },
  ];
  const directorySettings = {
    gameId: "game-a",
    isOps: false,
    revision: 3,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
  const gameIntegration = {
    gameId: "game-a",
    configurationState: "configured",
    providers: [
      {
        provider: "wechat",
        enabled: true,
        appId: "wx-game-a",
        secretMetadata: {
          configured: true,
          version: 1,
          updatedAt: "2026-07-28T10:00:00.000Z",
        },
        endpoint: "https://api.weixin.qq.com/sns/jscode2session",
        timeoutMs: 2_000,
        breakerThreshold: 4,
        breakerOpenMs: 5_000,
        validationState: "validation_failed",
        validationFailedAt: "2026-07-28T10:05:00.000Z",
        validationErrorCode: "invalid_credentials",
        updatedBy: "ops_kimi",
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
      {
        provider: "douyin",
        enabled: false,
        appId: null,
        secretMetadata: {
          configured: false,
          version: 0,
          updatedAt: null,
        },
        endpoint:
          "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
        timeoutMs: 3_000,
        breakerThreshold: 5,
        breakerOpenMs: 10_000,
        validationState: "unvalidated",
        validationFailedAt: null,
        validationErrorCode: null,
        updatedBy: "ops_kimi",
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
    ],
    sessionTtlSeconds: 7_200,
    loginRateCapacity: 100,
    loginRateRefillPerSecond: 100,
    adminRateCapacity: 100,
    adminRateRefillPerSecond: 100,
    revision: 3,
    loadedRevision: 3,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
  const machineIdentities = [];
  const staticFiles = new Map([
    ["/admin/", "index.html"],
    ["/admin/admin.css", "admin.css"],
    ["/admin/app.js", "app.js"],
    ["/admin/wsk.css", "wsk.css"],
    ["/admin/wsk.js", "wsk.js"],
  ]);

  const server = createServer(async (request, reply) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const staticName = staticFiles.get(url.pathname);
      if (request.method === "GET" && staticName) {
        const payload = await readFile(join(ADMIN_ROOT, staticName));
        const extension = staticName.slice(staticName.lastIndexOf("."));
        reply.writeHead(200, {
          "cache-control": "no-cache",
          "content-length": payload.length,
          "content-type": MIME_TYPES.get(extension),
        });
        reply.end(payload);
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/bootstrap"
      ) {
        json(reply, 200, { required: requiresBootstrap });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/bootstrap"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        bootstrapMutations.push(body);
        if (!requiresBootstrap) {
          json(reply, 409, {
            code: "ADMIN_ALREADY_INITIALIZED",
            message: "bootstrap already completed",
          });
          return;
        }
        requiresBootstrap = false;
        if (bootstrapResponse === "conflict") {
          json(reply, 409, {
            code: "ADMIN_ALREADY_INITIALIZED",
            message: "bootstrap completed concurrently",
          });
          return;
        }
        if (bootstrapResponse === "server-error") {
          json(reply, 503, {
            code: "INTERNAL",
            message: "bootstrap result unknown",
          });
          return;
        }
        authenticated = true;
        reply.writeHead(204, {
          "cache-control": "no-store",
          "set-cookie":
            "gmk_admin_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; "
            + "Path=/; HttpOnly; SameSite=Strict",
        });
        reply.end();
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/auth/session"
      ) {
        if (!authenticated) {
          json(reply, 401, {
            code: "ADMIN_AUTH_REQUIRED",
            message: "authentication required",
          });
          return;
        }
        json(reply, 200, {
          operator: {
            operatorId: "ops_kimi",
            displayName: "Kimi",
          },
          games: emptyGames ? [] : [
            {
              gameId: "game-a",
              name: "游戏 A",
              status: "enabled",
              canOperateAccounts: true,
            },
            {
              gameId: "game-b",
              name: "游戏 B",
              status: "maintenance",
              canOperateAccounts: false,
            },
          ],
          canManageGames: true,
          canManageIntegrations: true,
          canRotateSecrets: true,
          canManageMachineIdentities: true,
          elevatedUntil,
          expiresAt: "2099-07-28T18:00:00.000Z",
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/auth/login"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, {
          operatorId: "ops_kimi",
          password: "correct horse battery",
        });
        authenticated = true;
        reply.writeHead(204, {
          "cache-control": "no-store",
          "set-cookie":
            "gmk_admin_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; "
            + "Path=/; HttpOnly; SameSite=Strict",
        });
        reply.end();
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/auth/reauthenticate"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, { password: "correct horse battery" });
        elevatedUntil = "2099-07-28T18:00:00.000Z";
        reply.writeHead(204, {
          "cache-control": "no-store",
        });
        reply.end();
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/games"
      ) {
        if (!authenticated) {
          json(reply, 401, {
            code: "ADMIN_AUTH_REQUIRED",
            message: "authentication required",
          });
          return;
        }
        json(reply, 200, { games: gameProjects });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/games"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, {
          gameId: "new-game",
          name: "新游戏",
          description: "客户端列表测试项目",
        });
        const game = {
          ...body,
          status: "maintenance",
          configurationState: "draft",
          clientVisible: false,
          sortOrder: 0,
          revision: 1,
          createdAt: "2026-07-28T11:00:00.000Z",
          updatedAt: "2026-07-28T11:00:00.000Z",
        };
        gameProjects.push(game);
        gameMutations.push({ method: "POST", body });
        json(reply, 201, game);
        return;
      }

      if (
        request.method === "PATCH"
        && url.pathname === "/v1/admin/games/new-game"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, {
          name: "新游戏（已编辑）",
          description: "仍是草稿，不能下发",
          status: "maintenance",
          clientVisible: false,
          sortOrder: 25,
          revision: 1,
        });
        const index = gameProjects.findIndex(
          (game) => game.gameId === "new-game",
        );
        assert.notEqual(index, -1);
        gameProjects[index] = {
          ...gameProjects[index],
          ...body,
          revision: 2,
          updatedAt: "2026-07-28T11:05:00.000Z",
        };
        gameMutations.push({ method: "PATCH", body });
        json(reply, 200, gameProjects[index]);
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/games/game-a/servers"
      ) {
        const gate = nextServerListGate;
        nextServerListGate = null;
        if (gate) {
          gate.markStarted();
          await gate.wait;
        }
        json(reply, 200, {
          directoryRevision,
          servers: gameServers,
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/games/new-game/servers"
      ) {
        json(reply, 200, {
          directoryRevision: 1,
          servers: [],
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/games/game-a/servers"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, {
          directoryRevision: 3,
          serverId: 2,
          name: "星海二区",
          tag: "normal",
          status: "busy",
          openTime: Math.floor(
            new Date(2026, 7, 1, 10, 0, 0).getTime() / 1_000,
          ),
          gameHttpUrl: "https://game-two.example.com/api",
          gameWsUrl: "wss://game-two.example.com/socket",
          isOpen: true,
          sortOrder: 20,
        });
        const server = {
          gameId: "game-a",
          ...body,
          revision: 1,
          createdAt: "2026-07-28T11:10:00.000Z",
          updatedAt: "2026-07-28T11:10:00.000Z",
        };
        gameServers.push(server);
        serverMutations.push({ method: "POST", body });
        directoryRevision += 1;
        json(reply, 201, {
          directoryRevision,
          server,
        });
        return;
      }

      if (
        request.method === "PATCH"
        && url.pathname === "/v1/admin/games/game-a/servers/2"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        const index = gameServers.findIndex(
          (server) => server.serverId === 2,
        );
        assert.notEqual(index, -1);
        if (nextServerConflict) {
          nextServerConflict = false;
          assert.equal(body.revision, gameServers[index].revision);
          gameServers[index] = {
            ...gameServers[index],
            name: "星海二区（外部更新）",
            revision: gameServers[index].revision + 1,
            updatedAt: "2026-07-28T11:16:00.000Z",
          };
          directoryRevision += 1;
          json(reply, 409, {
            code: "ADMIN_GAME_SERVER_REVISION_CONFLICT",
            message: "revision conflict",
          });
          return;
        }
        const priorSuccessfulUpdates = serverMutations.filter(
          (mutation) => mutation.method === "PATCH",
        ).length;
        assert.deepEqual(
          body,
          priorSuccessfulUpdates === 0
            ? {
                directoryRevision: 4,
                name: "星海二区（维护）",
                tag: "maintenance",
                status: "maintenance",
                openTime: Math.floor(
                  new Date(2026, 7, 1, 10, 0, 0).getTime() / 1_000,
                ),
                gameHttpUrl: "https://game-two.example.com/api",
                gameWsUrl: "wss://game-two.example.com/socket",
                isOpen: true,
                sortOrder: 20,
                revision: 1,
              }
            : {
                directoryRevision: 6,
                name: "星海二区（外部更新）",
                tag: "maintenance",
                status: "maintenance",
                openTime: Math.floor(
                  new Date(2026, 7, 1, 10, 0, 0).getTime() / 1_000,
                ),
                gameHttpUrl: "https://game-two.example.com/api",
                gameWsUrl: "wss://game-two.example.com/socket",
                isOpen: true,
                sortOrder: 20,
                revision: 3,
              },
        );
        gameServers[index] = {
          ...gameServers[index],
          ...body,
          revision: gameServers[index].revision + 1,
          updatedAt: priorSuccessfulUpdates === 0
            ? "2026-07-28T11:15:00.000Z"
            : "2026-07-28T11:17:00.000Z",
        };
        serverMutations.push({ method: "PATCH", body });
        directoryRevision += 1;
        json(reply, 200, {
          directoryRevision,
          server: gameServers[index],
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/games/game-a/directory-settings"
      ) {
        json(reply, 200, directorySettings);
        return;
      }

      if (
        request.method === "PATCH"
        && url.pathname === "/v1/admin/games/game-a/directory-settings"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        Object.assign(directorySettings, {
          isOps: body.isOps,
          revision: directorySettings.revision + 1,
          updatedAt: "2026-07-28T11:20:00.000Z",
        });
        integrationMutations.push({
          method: "PATCH_DIRECTORY",
          body,
        });
        json(reply, 200, directorySettings);
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/games/game-a/integration"
      ) {
        json(reply, 200, gameIntegration);
        return;
      }

      if (
        request.method === "PATCH"
        && url.pathname === "/v1/admin/games/game-a/integration"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        Object.assign(gameIntegration, body, {
          revision: gameIntegration.revision + 1,
          updatedAt: "2026-07-28T11:21:00.000Z",
        });
        integrationMutations.push({
          method: "PATCH_INTEGRATION",
          body,
        });
        json(reply, 200, gameIntegration);
        return;
      }

      const providerMatch = url.pathname.match(
        /^\/v1\/admin\/games\/game-a\/identity-providers\/(wechat|douyin)$/u,
      );
      if (request.method === "PATCH" && providerMatch) {
        const providerName = providerMatch[1];
        const body = JSON.parse(await readRequestBody(request));
        const provider = gameIntegration.providers.find(
          (candidate) => candidate.provider === providerName,
        );
        assert.equal(body.revision, gameIntegration.revision);
        const { revision: _revision, ...update } = body;
        Object.assign(provider, update, {
          validationState: "unvalidated",
          validationFailedAt: null,
          validationErrorCode: null,
          updatedBy: "ops_kimi",
          updatedAt: "2026-07-28T11:21:30.000Z",
        });
        gameIntegration.revision += 1;
        gameIntegration.updatedAt = "2026-07-28T11:21:30.000Z";
        integrationMutations.push({
          method: "PATCH_PROVIDER",
          provider: providerName,
          body,
        });
        json(reply, 200, gameIntegration);
        return;
      }

      const providerSecretMatch = url.pathname.match(
        /^\/v1\/admin\/games\/game-a\/identity-providers\/(wechat|douyin)\/secret$/u,
      );
      if (
        request.method === "PUT"
        && providerSecretMatch
      ) {
        const providerName = providerSecretMatch[1];
        const body = JSON.parse(await readRequestBody(request));
        const provider = gameIntegration.providers.find(
          (candidate) => candidate.provider === providerName,
        );
        assert.equal(body.appSecret, "fixture-douyin-secret");
        assert.equal(body.revision, gameIntegration.revision);
        Object.assign(provider, {
          secretMetadata: {
            configured: true,
            version: provider.secretMetadata.version + 1,
            updatedAt: "2026-07-28T11:22:00.000Z",
          },
          validationState: "unvalidated",
          validationFailedAt: null,
          validationErrorCode: null,
          updatedBy: "ops_kimi",
          updatedAt: "2026-07-28T11:22:00.000Z",
        });
        gameIntegration.revision += 1;
        gameIntegration.updatedAt = "2026-07-28T11:22:00.000Z";
        integrationMutations.push({
          method: "PUT_PROVIDER_SECRET",
          provider: providerName,
          body,
        });
        json(reply, 200, {
          gameId: "game-a",
          provider: providerName,
          configurationState: "configured",
          secretMetadata: provider.secretMetadata,
          revision: gameIntegration.revision,
          loadedRevision: gameIntegration.loadedRevision,
          replayed: false,
        });
        return;
      }

      if (request.method === "DELETE" && providerSecretMatch) {
        const providerName = providerSecretMatch[1];
        const body = JSON.parse(await readRequestBody(request));
        const provider = gameIntegration.providers.find(
          (candidate) => candidate.provider === providerName,
        );
        assert.equal(body.revision, gameIntegration.revision);
        Object.assign(provider, {
          enabled: false,
          secretMetadata: {
            configured: false,
            version: 0,
            updatedAt: null,
          },
          validationState: "unvalidated",
          validationFailedAt: null,
          validationErrorCode: null,
          updatedBy: "ops_kimi",
          updatedAt: "2026-07-28T11:23:00.000Z",
        });
        gameIntegration.revision += 1;
        gameIntegration.updatedAt = "2026-07-28T11:23:00.000Z";
        integrationMutations.push({
          method: "DELETE_PROVIDER_SECRET",
          provider: providerName,
          body,
        });
        json(reply, 200, {
          gameId: "game-a",
          provider: providerName,
          configurationState: "configured",
          secretMetadata: provider.secretMetadata,
          revision: gameIntegration.revision,
          loadedRevision: gameIntegration.loadedRevision,
          replayed: false,
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/machine-identities"
      ) {
        json(reply, 200, { identities: machineIdentities });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/machine-identities"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        const identity = {
          identityId: body.identityId,
          identityType: body.identityType,
          displayName: body.displayName,
          status: "enabled",
          gameIds: body.gameIds,
          revision: 1,
          secretVersions: [
            {
              version: 1,
              state: "current",
              expiresAt: null,
              createdAt: "2026-07-28T11:23:00.000Z",
              activatedAt: "2026-07-28T11:23:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
            },
          ],
          createdAt: "2026-07-28T11:23:00.000Z",
          updatedAt: "2026-07-28T11:23:00.000Z",
        };
        machineIdentities.push(identity);
        machineIdentityMutations.push({ method: "POST", body });
        json(reply, 201, {
          identity,
          version: 1,
          previousExpiresAt: null,
          replayed: false,
          secret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
        });
        return;
      }

      const machineIdentityMatch =
        /^\/v1\/admin\/machine-identities\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "PATCH" && machineIdentityMatch) {
        const identityId = decodeURIComponent(machineIdentityMatch[1]);
        const identity = machineIdentities.find(
          (candidate) => candidate.identityId === identityId,
        );
        if (!identity) {
          json(reply, 404, {
            code: "ADMIN_MACHINE_IDENTITY_NOT_FOUND",
            message: "identity not found",
          });
          return;
        }
        const body = JSON.parse(await readRequestBody(request));
        Object.assign(identity, body, {
          revision: identity.revision + 1,
          updatedAt: "2026-07-28T11:24:00.000Z",
        });
        machineIdentityMutations.push({ method: "PATCH", body });
        json(reply, 200, identity);
        return;
      }

      const rotationMatch =
        /^\/v1\/admin\/machine-identities\/([^/]+)\/secret-rotations$/u
          .exec(url.pathname);
      if (request.method === "POST" && rotationMatch) {
        const identityId = decodeURIComponent(rotationMatch[1]);
        const identity = machineIdentities.find(
          (candidate) => candidate.identityId === identityId,
        );
        if (!identity) {
          json(reply, 404, {
            code: "ADMIN_MACHINE_IDENTITY_NOT_FOUND",
            message: "identity not found",
          });
          return;
        }
        const body = JSON.parse(await readRequestBody(request));
        const version = Math.max(
          0,
          ...identity.secretVersions.map((candidate) => candidate.version),
        ) + 1;
        for (const candidate of identity.secretVersions) {
          if (candidate.state === "current") {
            candidate.state = "previous";
            candidate.expiresAt = "2026-07-28T12:24:00.000Z";
          }
        }
        identity.secretVersions.push({
          version,
          state: "current",
          expiresAt: null,
          createdAt: "2026-07-28T11:24:00.000Z",
          activatedAt: "2026-07-28T11:24:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        });
        identity.revision += 1;
        identity.updatedAt = "2026-07-28T11:24:00.000Z";
        machineIdentityMutations.push({ method: "ROTATE", body });
        machineOperationStatuses.set(body.operationId, {
          operationId: body.operationId,
          identityId,
          action: "rotate",
          status: "succeeded",
          version,
          deliveryLost: true,
          createdAt: "2026-07-28T11:24:00.000Z",
        });
        json(reply, 200, {
          identity,
          version,
          previousExpiresAt: "2026-07-28T12:24:00.000Z",
          replayed: false,
          secret: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg",
        });
        return;
      }

      const rotationStatusMatch =
        /^\/v1\/admin\/machine-identities\/([^/]+)\/secret-rotations\/([^/]+)$/u
          .exec(url.pathname);
      if (request.method === "GET" && rotationStatusMatch) {
        const operationId = decodeURIComponent(rotationStatusMatch[2]);
        const status = machineOperationStatuses.get(operationId);
        if (!status) {
          json(reply, 404, {
            code: "ADMIN_SECRET_OPERATION_NOT_FOUND",
            message: "operation not found",
          });
          return;
        }
        json(reply, 200, status);
        return;
      }

      const revokeMatch =
        /^\/v1\/admin\/machine-identities\/([^/]+)\/secret-versions\/([0-9]+)\/revoke$/u
          .exec(url.pathname);
      if (request.method === "POST" && revokeMatch) {
        const identityId = decodeURIComponent(revokeMatch[1]);
        const version = Number(revokeMatch[2]);
        const identity = machineIdentities.find(
          (candidate) => candidate.identityId === identityId,
        );
        const secretVersion = identity?.secretVersions.find(
          (candidate) => candidate.version === version,
        );
        if (!identity || !secretVersion) {
          json(reply, 404, {
            code: "ADMIN_MACHINE_SECRET_NOT_FOUND",
            message: "secret not found",
          });
          return;
        }
        const body = JSON.parse(await readRequestBody(request));
        Object.assign(secretVersion, {
          state: "revoked",
          revokedAt: "2026-07-28T11:25:00.000Z",
        });
        identity.revision += 1;
        identity.updatedAt = "2026-07-28T11:25:00.000Z";
        machineIdentityMutations.push({ method: "REVOKE", body });
        machineOperationStatuses.set(body.operationId, {
          operationId: body.operationId,
          identityId,
          action: "revoke",
          status: "succeeded",
          version,
          deliveryLost: false,
          createdAt: "2026-07-28T11:25:00.000Z",
        });
        json(reply, 200, {
          identityId,
          version,
          state: "revoked",
          identityRevision: identity.revision,
          replayed: false,
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/config-audit"
      ) {
        assert.equal(url.searchParams.get("gameId"), "game-a");
        json(reply, 200, {
          records: [
            {
              id: "audit-browser-1",
              auditType: "game_configuration",
              operatorId: "ops_kimi",
              gameId: "game-a",
              provider: "douyin",
              identityId: null,
              action: "integration.read",
              result: "succeeded",
              oldVersion: null,
              newVersion: 3,
              revision: 4,
              requestId: "request-browser-audit",
              operationId: null,
              beforeMetadata: { enabled: false },
              afterMetadata: { enabled: true },
              createdAt: "2026-07-28T11:00:00.000Z",
            },
          ],
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/games/game-a/admin/accounts/u_12345"
      ) {
        json(reply, 200, {
          userId: "u_12345",
          status: "active",
          lastLoginAt: "2026-07-28T05:20:00.000Z",
          activeSessionCount: 2,
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname
          === "/v1/games/game-a/admin/accounts/u_12345/ban"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        operations.push(body);
        const gate = nextOperationGate;
        nextOperationGate = null;
        if (gate) {
          gate.markStarted();
          await gate.wait;
        }
        json(reply, 200, {
          accountExists: true,
          status: "banned",
        });
        return;
      }

      json(reply, 404, {
        code: "NOT_FOUND",
        message: "not found",
      });
    } catch (error) {
      errors.push(error);
      if (!reply.headersSent) {
        json(reply, 500, {
          code: "FIXTURE_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        reply.destroy(error);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bootstrapMutations,
    delayNextOperation() {
      if (nextOperationGate) {
        throw new Error("已有待延迟的管理员操作");
      }
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      nextOperationGate = { markStarted, wait };
      return {
        started,
        release,
      };
    },
    delayNextServerList() {
      if (nextServerListGate) {
        throw new Error("已有待延迟的区服列表请求");
      }
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      nextServerListGate = { markStarted, wait };
      return {
        started,
        release,
      };
    },
    conflictNextServerUpdate() {
      nextServerConflict = true;
    },
    errors,
    gameMutations,
    gameProjects,
    gameServers,
    integrationMutations,
    machineIdentityMutations,
    operations,
    serverMutations,
    close: async () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

class DevToolsClient {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? "浏览器脚本执行失败",
    );
  }
  return response.result.value;
}

async function waitFor(client, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`等待浏览器状态超时：${label}`);
}

async function pressKey(client, key, code = key) {
  const virtualKeyCode = key === "Enter"
    ? 13
    : key === "Tab"
      ? 9
      : undefined;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    ...(virtualKeyCode === undefined
      ? {}
      : {
          nativeVirtualKeyCode: virtualKeyCode,
          windowsVirtualKeyCode: virtualKeyCode,
        }),
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
  });
}

async function focusAndType(client, selector, value) {
  await evaluate(
    client,
    `document.querySelector(${JSON.stringify(selector)}).focus()`,
  );
  await client.send("Input.insertText", { text: value });
}

async function launchAdminPage(t, executable, baseUrl, {
  height = 900,
  width = 1024,
} = {}) {
  const profileDirectory = await mkdtemp(join(tmpdir(), "gmk-admin-chrome-"));
  let chrome = null;
  let client = null;
  t.after(async () => {
    client?.close();
    if (chrome?.exitCode === null) {
      chrome.kill("SIGKILL");
    }
    await rm(profileDirectory, { force: true, recursive: true });
  });
  chrome = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate",
    "--disable-gpu",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ], {
    stdio: "ignore",
  });

  const port = await waitForDevToolsPort(profileDirectory, chrome);
  const targetResponse = await fetch(
    `http://127.0.0.1:${port}/json/new?`
      + encodeURIComponent(`${baseUrl}/admin/`),
    { method: "PUT" },
  );
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  assert.equal(typeof target.webSocketDebuggerUrl, "string");

  client = new DevToolsClient(target.webSocketDebuggerUrl);
  await client.open();

  const browserErrors = [];
  const runtimeErrors = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const message =
      exceptionDetails.exception?.description ?? exceptionDetails.text;
    runtimeErrors.push(message);
    browserErrors.push(message);
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") {
      browserErrors.push(entry.text);
    }
  });
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Log.enable"),
  ]);
  return { browserErrors, client, runtimeErrors };
}

test("真实 Chrome 在零管理员时完成可访问的首次创建并清理密码", {
  timeout: 30_000,
}, async (t) => {
  const executable = chromePath();
  if (!executable) {
    t.skip("未找到 Chrome/Chromium；可通过 GMK_CHROME_PATH 指定");
    return;
  }

  const fixture = await createAdminFixtureServer({
    bootstrapRequired: true,
    emptyGames: true,
  });
  const conflictFixture = await createAdminFixtureServer({
    bootstrapRequired: true,
    bootstrapResponse: "conflict",
    emptyGames: true,
  });
  const unknownFixture = await createAdminFixtureServer({
    bootstrapRequired: true,
    bootstrapResponse: "server-error",
    emptyGames: true,
  });
  t.after(fixture.close);
  t.after(conflictFixture.close);
  t.after(unknownFixture.close);
  const { browserErrors, client, runtimeErrors } = await launchAdminPage(
    t,
    executable,
    fixture.baseUrl,
  );

  await waitFor(
    client,
    "!document.querySelector('#bootstrap-view').hidden",
    "显示管理员创建页",
  );
  // Restoring an anonymous session intentionally receives 401.
  browserErrors.length = 0;
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "bootstrap-title",
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 844,
    mobile: false,
    width: 375,
  });
  assert.equal(
    await evaluate(
      client,
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
    true,
  );

  await pressKey(client, "Tab");
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "bootstrap-operator-id",
  );
  await client.send("Input.insertText", { text: "ops_kimi" });
  await pressKey(client, "Tab");
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "bootstrap-display-name",
  );
  await client.send("Input.insertText", { text: "Kimi" });
  await pressKey(client, "Tab");
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "bootstrap-password",
  );
  await client.send("Input.insertText", { text: "correct horse battery" });
  await focusAndType(
    client,
    "#bootstrap-password-confirm",
    "different password",
  );
  await evaluate(client, "document.querySelector('#bootstrap-submit').focus()");
  await pressKey(client, "Enter");
  assert.equal(fixture.bootstrapMutations.length, 0);
  assert.equal(
    await evaluate(
      client,
      "document.querySelector('#bootstrap-password-confirm').validationMessage",
    ),
    "两次输入的密码不一致。",
  );

  await evaluate(client, `(() => {
    const input = document.querySelector("#bootstrap-password-confirm");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await focusAndType(
    client,
    "#bootstrap-password-confirm",
    "correct horse battery",
  );
  await evaluate(client, "document.querySelector('#bootstrap-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#games-view').hidden",
    "创建后进入游戏项目页",
  );

  assert.deepEqual(fixture.bootstrapMutations, [{
    operatorId: "ops_kimi",
    displayName: "Kimi",
    password: "correct horse battery",
  }]);
  assert.deepEqual(
    await evaluate(client, `({
      bootstrapHashClean: !location.hash.includes("correct horse battery"),
      confirmType:
        document.querySelector("#bootstrap-password-confirm").type,
      confirmValue:
        document.querySelector("#bootstrap-password-confirm").value,
      liveRegionClean: ![...document.querySelectorAll("[aria-live]")]
        .some((node) => node.textContent.includes("correct horse battery")),
      passwordType: document.querySelector("#bootstrap-password").type,
      passwordValue: document.querySelector("#bootstrap-password").value,
      storageClean:
        !Object.values(localStorage).includes("correct horse battery")
        && !Object.values(sessionStorage).includes("correct horse battery"),
      toastClean:
        !document.querySelector("#toast-region").textContent
          .includes("correct horse battery"),
    })`),
    {
      bootstrapHashClean: true,
      confirmType: "password",
      confirmValue: "",
      liveRegionClean: true,
      passwordType: "password",
      passwordValue: "",
      storageClean: true,
      toastClean: true,
    },
  );
  assert.deepEqual(browserErrors, []);

  await client.send("Page.navigate", {
    url: `${conflictFixture.baseUrl}/admin/`,
  });
  await waitFor(
    client,
    "!document.querySelector('#bootstrap-view').hidden",
    "竞争初始化前显示管理员创建页",
  );
  browserErrors.length = 0;
  await evaluate(client, `(() => {
    const values = new Map([
      ["#bootstrap-operator-id", "ops_loser"],
      ["#bootstrap-display-name", "Loser"],
      ["#bootstrap-password", "correct horse battery"],
      ["#bootstrap-password-confirm", "correct horse battery"],
    ]);
    for (const [selector, value] of values) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector("#bootstrap-form").requestSubmit();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "竞争失败后重新检查并进入登录页",
  );
  assert.deepEqual(conflictFixture.bootstrapMutations, [{
    operatorId: "ops_loser",
    displayName: "Loser",
    password: "correct horse battery",
  }]);
  assert.deepEqual(
    await evaluate(client, `({
      loginOperator: document.querySelector("#operator-id").value,
      password: document.querySelector("#bootstrap-password").value,
      passwordConfirm:
        document.querySelector("#bootstrap-password-confirm").value,
    })`),
    {
      loginOperator: "",
      password: "",
      passwordConfirm: "",
    },
  );

  await client.send("Page.navigate", {
    url: `${unknownFixture.baseUrl}/admin/`,
  });
  await waitFor(
    client,
    "!document.querySelector('#bootstrap-view').hidden",
    "未知创建结果前显示管理员创建页",
  );
  browserErrors.length = 0;
  await evaluate(client, `(() => {
    const values = new Map([
      ["#bootstrap-operator-id", "ops_uncertain"],
      ["#bootstrap-display-name", "Uncertain"],
      ["#bootstrap-password", "correct horse battery"],
      ["#bootstrap-password-confirm", "correct horse battery"],
    ]);
    for (const [selector, value] of values) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector("#bootstrap-form").requestSubmit();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "未知结果后重新检查并进入登录页",
  );
  assert.deepEqual(unknownFixture.bootstrapMutations, [{
    operatorId: "ops_uncertain",
    displayName: "Uncertain",
    password: "correct horse battery",
  }]);
  assert.deepEqual(
    await evaluate(client, `({
      loginOperator: document.querySelector("#operator-id").value,
      password: document.querySelector("#bootstrap-password").value,
      passwordConfirm:
        document.querySelector("#bootstrap-password-confirm").value,
    })`),
    {
      loginOperator: "ops_uncertain",
      password: "",
      passwordConfirm: "",
    },
  );
  assert.deepEqual(runtimeErrors, []);
});

test("真实 Chrome 可用键盘完成管理员登录、查询和确认操作", {
  timeout: 30_000,
}, async (t) => {
  const executable = chromePath();
  if (!executable) {
    t.skip("未找到 Chrome/Chromium；可通过 GMK_CHROME_PATH 指定");
    return;
  }

  const fixture = await createAdminFixtureServer();
  t.after(fixture.close);
  const profileDirectory = await mkdtemp(join(tmpdir(), "gmk-admin-chrome-"));
  t.after(() => rm(profileDirectory, { force: true, recursive: true }));

  const chrome = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate",
    "--disable-gpu",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1024,900",
    "about:blank",
  ], {
    stdio: "ignore",
  });
  t.after(() => {
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
    }
  });

  const port = await waitForDevToolsPort(profileDirectory, chrome);
  const targetResponse = await fetch(
    `http://127.0.0.1:${port}/json/new?`
      + encodeURIComponent(`${fixture.baseUrl}/admin/`),
    { method: "PUT" },
  );
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  assert.equal(typeof target.webSocketDebuggerUrl, "string");

  const client = new DevToolsClient(target.webSocketDebuggerUrl);
  await client.open();
  t.after(() => client.close());

  const browserErrors = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    browserErrors.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") {
      browserErrors.push(entry.text);
    }
  });
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Log.enable"),
  ]);

  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "显示登录页",
  );
  // Restoring an anonymous session intentionally receives 401; Chrome logs
  // that HTTP response as a resource error even though the application handles it.
  browserErrors.length = 0;
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "operator-id",
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 1024,
  });
  assert.equal(
    await evaluate(
      client,
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
    true,
  );

  await focusAndType(client, "#operator-id", "ops_kimi");
  await pressKey(client, "Tab");
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "operator-password",
  );
  await client.send("Input.insertText", { text: "correct horse battery" });
  await pressKey(client, "Enter");

  try {
    await waitFor(
      client,
      "!document.querySelector('#accounts-view').hidden",
      "登录后显示账号管理",
    );
  } catch (error) {
    const loginState = await evaluate(client, `({
      active: document.activeElement?.id,
      error: document.querySelector("#login-error-message")?.textContent,
      invalid: document.querySelector("#operator-password")?.validationMessage,
      operator: document.querySelector("#operator-id")?.value,
      passwordLength: document.querySelector("#operator-password")?.value.length,
    })`);
    throw new Error(
      `${error.message}; fixture=${fixture.errors.map(String).join(" | ")}; `
      + `login=${JSON.stringify(loginState)}`,
      { cause: error },
    );
  }
  assert.equal(
    await evaluate(client, "document.querySelector('#operator-password').value"),
    "",
  );

  assert.equal(
    await evaluate(
      client,
      "!document.querySelector('#accounts-integration-link').hidden",
    ),
    true,
  );
  await evaluate(
    client,
    "document.querySelector('#accounts-integration-link').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#integration-view').hidden"
      + " && !document.querySelector('#integration-content').hidden",
    "显示接入配置",
  );
  assert.deepEqual(
    await evaluate(client, `({
      auditVisible:
        !document.querySelector("#configuration-audit-section").hidden,
      completeness:
        document.querySelector("#configuration-completeness-score").textContent,
      providerAvailable:
        [...document.querySelectorAll("#configuration-check-list li")]
          .find((item) => item.textContent.includes("至少一个身份 Provider"))
          ?.dataset.complete,
      machineVisible:
        !document.querySelector("#machine-identities-section").hidden,
      noSecretInPage:
        !document.body.textContent.includes("fixture-douyin-secret"),
      providerCards:
        document.querySelectorAll("[data-provider-form]").length,
      selectedGame:
        document.querySelector("#integration-game-select").value,
      wechatValidation:
        document.querySelector("#provider-wechat-validation-badge").textContent,
      douyinValidation:
        document.querySelector("#provider-douyin-validation-badge").textContent,
    })`),
    {
      auditVisible: true,
      completeness: "4 / 5",
      douyinValidation: "尚未验证",
      machineVisible: true,
      noSecretInPage: true,
      providerAvailable: "false",
      providerCards: 2,
      selectedGame: "game-a",
      wechatValidation: "验证失败",
    },
  );

  await evaluate(
    client,
    "document.querySelector('#provider-douyin-secret').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#reauthenticate-dialog').open",
    "敏感配置操作要求重新认证",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "reauthenticate-password",
  );
  await client.send("Input.insertText", { text: "correct horse battery" });
  await evaluate(
    client,
    "document.querySelector('#reauthenticate-submit').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#reauthenticate-dialog').open"
      + " && document.querySelector('#provider-secret-dialog').open",
    "重新认证后打开 AppSecret 输入窗口",
  );
  assert.equal(
    await evaluate(
      client,
      "document.querySelector('#reauthenticate-password').value",
    ),
    "",
  );

  await focusAndType(
    client,
    "#provider-secret-input",
    "fixture-douyin-secret",
  );
  await evaluate(
    client,
    "document.querySelector('#provider-secret-submit').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#provider-secret-dialog').open"
      + " && document.querySelector('#provider-douyin-secret-badge')"
      + ".textContent === '已配置 · v1'",
    "AppSecret 替换完成",
  );
  assert.deepEqual(
    await evaluate(client, `({
      hashClean: !location.hash.includes("fixture-douyin-secret"),
      inputType: document.querySelector("#provider-secret-input").type,
      inputValue: document.querySelector("#provider-secret-input").value,
      liveRegionClean: ![...document.querySelectorAll('[aria-live]')]
        .some((node) => node.textContent.includes("fixture-douyin-secret")),
      pageClean: !document.body.textContent.includes("fixture-douyin-secret"),
      toastClean:
        !document.querySelector("#toast-region").textContent
          .includes("fixture-douyin-secret"),
    })`),
    {
      hashClean: true,
      inputType: "password",
      inputValue: "",
      liveRegionClean: true,
      pageClean: true,
      toastClean: true,
    },
  );
  assert.equal(
    fixture.integrationMutations.filter(
      (mutation) => (
        mutation.method === "PUT_PROVIDER_SECRET"
        && mutation.provider === "douyin"
      ),
    ).length,
    1,
  );

  await focusAndType(client, "#provider-douyin-appId", "tt-game-a");
  await evaluate(client, `(() => {
    const enabled = document.querySelector("#provider-douyin-enabled");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#provider-douyin-save").focus();
  })()`);
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('[data-provider-form=\"douyin\"] .wsk-badge')"
      + ".textContent === '已启用'",
    "启用抖音 Provider",
  );
  const douyinUpdate = fixture.integrationMutations.find(
    (mutation) => (
      mutation.method === "PATCH_PROVIDER"
      && mutation.provider === "douyin"
    ),
  );
  assert.equal(douyinUpdate.body.enabled, true);
  assert.equal(douyinUpdate.body.appId, "tt-game-a");
  assert.equal(
    douyinUpdate.body.endpoint,
    "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
  );

  await evaluate(
    client,
    "document.querySelector('#provider-douyin-secret').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#provider-secret-dialog').open"
      + " && !document.querySelector('#provider-secret-clear').hidden",
    "打开已配置的抖音 Secret 窗口",
  );
  await evaluate(
    client,
    "document.querySelector('#provider-secret-clear').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#provider-secret-dialog').open"
      + " && document.querySelector('#provider-douyin-secret-badge')"
      + ".textContent === '未配置'"
      + " && !document.querySelector('#provider-douyin-enabled').checked",
    "清除抖音 Secret 并停用 Provider",
  );
  assert.equal(
    fixture.integrationMutations.filter(
      (mutation) => (
        mutation.method === "DELETE_PROVIDER_SECRET"
        && mutation.provider === "douyin"
      ),
    ).length,
    1,
  );

  await evaluate(
    client,
    "document.querySelector('#machine-identity-create').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#machine-identity-dialog').open",
    "打开机器身份创建窗口",
  );
  await focusAndType(client, "#machine-identity-id", "browser-service");
  await focusAndType(client, "#machine-identity-name", "浏览器 Service");
  await evaluate(client, `(() => {
    const scope = document.querySelector('[data-machine-scope="game-a"]');
    scope.checked = true;
    document.querySelector("#machine-identity-submit").focus();
  })()`);
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#machine-identity-dialog').open"
      + " && document.querySelector('#one-time-secret-dialog').open",
    "创建机器身份后显示一次性 Secret",
  );
  assert.deepEqual(
    await evaluate(client, `({
      closeDisabled: document.querySelector("#one-time-secret-close").disabled,
      secretType: document.querySelector("#one-time-secret-value").type,
      secretValue: document.querySelector("#one-time-secret-value").value,
    })`),
    {
      closeDisabled: true,
      secretType: "password",
      secretValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    },
  );
  await evaluate(
    client,
    "document.querySelector('#one-time-secret-toggle').click()",
  );
  assert.equal(
    await evaluate(
      client,
      "document.querySelector('#one-time-secret-value').type",
    ),
    "text",
  );
  await evaluate(client, `(() => {
    const confirm = document.querySelector("#one-time-secret-confirm");
    confirm.checked = true;
    confirm.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#one-time-secret-close").click();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#one-time-secret-dialog').open",
    "确认保存后关闭一次性 Secret",
  );
  assert.deepEqual(
    await evaluate(client, `({
      context: document.querySelector("#one-time-secret-context").textContent,
      hashClean:
        !location.hash.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"),
      secretType: document.querySelector("#one-time-secret-value").type,
      secretValue: document.querySelector("#one-time-secret-value").value,
      toastClean:
        !document.querySelector("#toast-region").textContent
          .includes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"),
    })`),
    {
      context: "",
      hashClean: true,
      secretType: "password",
      secretValue: "",
      toastClean: true,
    },
  );
  assert.equal(fixture.machineIdentityMutations.length, 1);

  // Let the native dialog finish restoring focus before moving it to the
  // navigation link; otherwise that deferred restoration can swallow Enter.
  await delay(50);
  await evaluate(
    client,
    "document.querySelector('#integration-games-link').focus()",
  );
  await waitFor(
    client,
    "document.activeElement?.id === 'integration-games-link'",
    "聚焦游戏项目入口",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#games-view').hidden",
    "从接入配置进入游戏项目",
  );

  await waitFor(
    client,
    "!document.querySelector('#games-view').hidden"
      + " && !document.querySelector('#games-list').hidden",
    "显示游戏项目列表",
  );
  assert.equal(
    await evaluate(client, "document.querySelector('#game-select').parentElement.parentElement.hidden"),
    true,
  );

  await evaluate(
    client,
    "document.querySelector('#game-create-button').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#game-dialog').open",
    "打开新增游戏窗口",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "game-id",
  );
  await focusAndType(client, "#game-id", "new-game");
  await focusAndType(client, "#game-name", "新游戏");
  await focusAndType(
    client,
    "#game-description",
    "客户端列表测试项目",
  );
  assert.deepEqual(
    await evaluate(client, `({
      clientVisible: document.querySelector("#game-client-visible").checked,
      clientVisibleDisabled:
        document.querySelector("#game-client-visible").disabled,
      sortOrder: document.querySelector("#game-sort-order").value,
      sortOrderDisabled: document.querySelector("#game-sort-order").disabled,
      status: document.querySelector("#game-status").value,
      statusDisabled: document.querySelector("#game-status").disabled,
    })`),
    {
      clientVisible: false,
      clientVisibleDisabled: true,
      sortOrder: "0",
      sortOrderDisabled: true,
      status: "maintenance",
      statusDisabled: true,
    },
  );
  await evaluate(client, "document.querySelector('#game-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#game-dialog').open"
      + " && document.querySelector('[data-game-edit=\"new-game\"]')",
    "新增游戏完成",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "game-create-button",
  );

  await evaluate(client, `(() => {
    const button = document.querySelector('[data-game-edit="new-game"]');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    client,
    "document.querySelector('#game-dialog').open"
      + " && document.querySelector('#game-dialog-kind').textContent"
      + " === 'EDIT GAME'",
    "打开编辑游戏窗口",
  );
  assert.deepEqual(
    await evaluate(client, `({
      clientVisibleDisabled:
        document.querySelector("#game-client-visible").disabled,
      enabledDisabled:
        document.querySelector('#game-status option[value="enabled"]').disabled,
      gameIdReadonly: document.querySelector("#game-id").readOnly,
    })`),
    {
      clientVisibleDisabled: true,
      enabledDisabled: true,
      gameIdReadonly: true,
    },
  );
  await evaluate(client, `(() => {
    const name = document.querySelector("#game-name");
    const description = document.querySelector("#game-description");
    const sortOrder = document.querySelector("#game-sort-order");
    name.value = "";
    description.value = "";
    sortOrder.value = "25";
  })()`);
  await focusAndType(client, "#game-name", "新游戏（已编辑）");
  await focusAndType(client, "#game-description", "仍是草稿，不能下发");
  await evaluate(client, "document.querySelector('#game-submit').focus()");
  await pressKey(client, "Enter");
  try {
    await waitFor(
      client,
      "!document.querySelector('#game-dialog').open"
        + " && document.querySelector('[data-game-edit=\"new-game\"]')"
        + ".getAttribute('aria-label').includes('已编辑')",
      "编辑游戏完成",
    );
  } catch (error) {
    const gameState = await evaluate(client, `({
      active: document.activeElement?.id
        || document.activeElement?.dataset?.gameEdit,
      dialogOpen: document.querySelector("#game-dialog").open,
      error: document.querySelector("#game-form-error-message").textContent,
      invalid: [
        "#game-id",
        "#game-name",
        "#game-description",
        "#game-status",
        "#game-sort-order",
        "#game-disable-confirm",
      ].map((selector) => [
        selector,
        document.querySelector(selector).validationMessage,
      ]),
      submitBusy: document.querySelector("#game-submit")
        .getAttribute("aria-busy"),
      title: document.querySelector(
        '[data-game-edit="new-game"]',
      )?.getAttribute("aria-label"),
      values: {
        clientVisible:
          document.querySelector("#game-client-visible").checked,
        description: document.querySelector("#game-description").value,
        gameId: document.querySelector("#game-id").value,
        name: document.querySelector("#game-name").value,
        sortOrder: document.querySelector("#game-sort-order").value,
        status: document.querySelector("#game-status").value,
      },
    })`);
    throw new Error(
      `${error.message}; state=${JSON.stringify(gameState)}; `
        + `fixture=${fixture.errors.map(String).join(" | ")}; `
        + `mutations=${JSON.stringify(fixture.gameMutations)}`,
      { cause: error },
    );
  }
  await waitFor(
    client,
    "document.activeElement.dataset.gameEdit === 'new-game'",
    "编辑完成后恢复焦点",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.dataset.gameEdit"),
    "new-game",
  );
  assert.equal(fixture.gameMutations.length, 2);

  await evaluate(client, `(() => {
    const button = document.querySelector('[data-game-servers="game-a"]');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    client,
    "document.querySelector('#server-dialog').open"
      + " && !document.querySelector('#servers-list').hidden"
      + " && document.querySelector('[data-server-edit=\"1\"]')",
    "打开区服管理并加载列表",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "server-dialog-close",
  );
  assert.match(
    await evaluate(
      client,
      "document.querySelector('.gmk-server-policy').textContent",
    ),
    /未开放不下发且不可登录；维护中可下发但不可登录。/u,
  );
  assert.match(
    await evaluate(client, "document.querySelector('#servers-list').textContent"),
    /星海一区/u,
  );

  await evaluate(
    client,
    "document.querySelector('#server-create-button').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#server-editor').hidden",
    "打开新增区服表单",
  );
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "server-id",
  );
  await focusAndType(client, "#server-id", "2");
  await focusAndType(client, "#server-name", "星海二区");
  await evaluate(client, `(() => {
    document.querySelector("#server-tag").value = "normal";
    document.querySelector("#server-status").value = "busy";
    document.querySelector("#server-open-time").value =
      "2026-08-01T10:00:00";
    document.querySelector("#server-is-open").checked = true;
    document.querySelector("#server-sort-order").value = "20";
  })()`);
  await focusAndType(
    client,
    "#server-http-url",
    "https://game-two.example.com/api",
  );
  await focusAndType(
    client,
    "#server-ws-url",
    "wss://game-two.example.com/socket",
  );
  await evaluate(client, "document.querySelector('#server-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#server-editor').hidden"
      + " && document.querySelector('[data-server-edit=\"2\"]')",
    "新增区服完成",
  );
  await waitFor(
    client,
    "document.activeElement.id === 'server-create-button'",
    "新增完成后恢复焦点",
  );

  await evaluate(client, `(() => {
    const button = document.querySelector('[data-server-edit="2"]');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#server-editor').hidden"
      + " && document.querySelector('#server-editor-kind').textContent"
      + " === 'EDIT SERVER'",
    "打开编辑区服表单",
  );
  assert.equal(
    await evaluate(client, "document.querySelector('#server-id').readOnly"),
    true,
  );
  await evaluate(client, `(() => {
    document.querySelector("#server-name").value = "";
    document.querySelector("#server-tag").value = "maintenance";
    document.querySelector("#server-status").value = "maintenance";
    document.querySelector("#server-status").dispatchEvent(
      new Event("change", { bubbles: true }),
    );
  })()`);
  await focusAndType(client, "#server-name", "星海二区（维护）");
  assert.match(
    await evaluate(
      client,
      "document.querySelector('#server-is-open-help').textContent",
    ),
    /下发.*不可登录/u,
  );
  await evaluate(client, "document.querySelector('#server-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#server-editor').hidden"
      + " && document.querySelector('[data-server-edit=\"2\"]')"
      + ".getAttribute('aria-label').includes('维护')",
    "编辑区服完成",
  );
  await waitFor(
    client,
    "document.activeElement.dataset.serverEdit === '2'",
    "编辑区服后恢复焦点",
  );
  assert.equal(fixture.serverMutations.length, 2);

  fixture.conflictNextServerUpdate();
  await evaluate(client, `(() => {
    const button = document.querySelector('[data-server-edit="2"]');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#server-editor').hidden",
    "重新打开区服编辑表单",
  );
  await evaluate(client, "document.querySelector('#server-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#server-form-error').hidden",
    "显示区服乐观锁冲突",
  );
  assert.match(
    await evaluate(
      client,
      "document.querySelector('#server-form-error-message').textContent",
    ),
    /其他管理员修改.*取消编辑.*加载最新版本/u,
  );
  assert.equal(
    await evaluate(client, "document.querySelector('#server-dialog').open"),
    true,
  );
  assert.equal(
    await evaluate(client, "document.querySelector('#server-submit').disabled"),
    true,
  );
  await evaluate(client, "document.querySelector('#server-cancel').click()");
  await waitFor(
    client,
    "document.querySelector('#server-editor').hidden"
      + " && !document.querySelector('#server-create-button').disabled"
      + " && document.activeElement.dataset.serverEdit === '2'"
      + " && document.activeElement.getAttribute('aria-label')"
      + ".includes('外部更新')",
    "冲突后取消编辑、重新加载并恢复焦点",
  );
  // Chrome records handled non-2xx fetches as resource errors.
  browserErrors.length = 0;

  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#server-editor').hidden"
      + " && document.querySelector('#server-name').value"
      + " === '星海二区（外部更新）'",
    "使用冲突后刷新得到的区服版本重新编辑",
  );
  await evaluate(client, "document.querySelector('#server-submit').focus()");
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#server-editor').hidden"
      + " && document.activeElement.dataset.serverEdit === '2'",
    "使用最新 revision 保存区服",
  );
  assert.equal(fixture.serverMutations.length, 3);
  assert.equal(fixture.serverMutations.at(-1).body.revision, 3);

  assert.equal(
    await evaluate(client, `(() => {
      const button = document.querySelector("#server-dialog-close");
      button.focus();
      const enabled = !button.disabled;
      button.click();
      return enabled;
    })()`),
    true,
  );
  await waitFor(
    client,
    "!document.querySelector('#server-dialog').open",
    "关闭区服管理窗口",
  );
  await waitFor(
    client,
    "document.activeElement.dataset.gameServers === 'game-a'",
    "关闭区服管理后恢复焦点",
  );

  await evaluate(client, `(() => {
    const button = document.querySelector('[data-game-servers="new-game"]');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    client,
    "document.querySelector('#server-dialog').open"
      + " && !document.querySelector('#servers-empty').hidden",
    "显示新游戏的区服空态",
  );
  assert.match(
    await evaluate(client, "document.querySelector('#server-summary').textContent"),
    /0 个区服/u,
  );
  await evaluate(client, "document.querySelector('#server-dialog-close').click()");
  await waitFor(
    client,
    "!document.querySelector('#server-dialog').open"
      + " && document.activeElement.dataset.gameServers === 'new-game'",
    "关闭区服空态并恢复焦点",
  );

  const delayedServerList = fixture.delayNextServerList();
  t.after(delayedServerList.release);
  await evaluate(client, `(() => {
    const button = document.querySelector('[data-game-servers="game-a"]');
    button.focus();
    button.click();
  })()`);
  await delayedServerList.started;
  assert.equal(
    await evaluate(
      client,
      "!document.querySelector('#servers-loading').hidden",
    ),
    true,
  );
  await evaluate(client, "document.querySelector('#server-dialog-close').click()");
  await waitFor(
    client,
    "!document.querySelector('#server-dialog').open",
    "加载期间关闭区服窗口",
  );
  delayedServerList.release();
  await delay(100);
  assert.deepEqual(
    await evaluate(client, `({
      dialogOpen: document.querySelector("#server-dialog").open,
      listChildren: document.querySelector("#servers-list").childElementCount,
      listHidden: document.querySelector("#servers-list").hidden,
      focusedGame: document.activeElement.dataset.gameServers,
    })`),
    {
      dialogOpen: false,
      listChildren: 0,
      listHidden: true,
      focusedGame: "game-a",
    },
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 844,
    mobile: false,
    width: 375,
  });
  assert.deepEqual(
    await evaluate(client, `({
      editButtonsVisible: [...document.querySelectorAll("[data-game-edit]")]
        .every((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }),
      serverButtonsVisible: [...document.querySelectorAll("[data-game-servers]")]
        .every((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }),
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth,
    })`),
    {
      editButtonsVisible: true,
      serverButtonsVisible: true,
      noHorizontalOverflow: true,
    },
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 1024,
  });

  await evaluate(
    client,
    "document.querySelector('#games-accounts-link').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#accounts-view').hidden",
    "返回账号管理",
  );

  await evaluate(client, `(() => {
    const select = document.querySelector("#game-select");
    select.focus();
    select.value = "game-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "account-user-id",
  );

  await client.send("Input.insertText", { text: "u_12345" });
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#account-card').hidden",
    "显示账号查询结果",
  );

  await evaluate(
    client,
    "document.querySelector('[data-operation=\"ban\"]').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#operation-dialog').open",
    "打开确认对话框",
  );
  assert.match(
    await evaluate(
      client,
      "document.querySelector('#operation-dialog-target').textContent",
    ),
    /游戏 A（game-a） \/ u_12345/u,
  );

  await focusAndType(client, "#operation-reason", "安全处置确认");
  await evaluate(
    client,
    "document.querySelector('#operation-confirm').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#account-status-badge').textContent === '已封禁'",
    "封禁操作完成",
  );

  assert.equal(fixture.operations.length, 1);
  assert.equal(fixture.operations[0].reason, "安全处置确认");
  assert.match(
    fixture.operations[0].operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

  const previousTheme = await evaluate(
    client,
    "document.documentElement.dataset.theme",
  );
  await evaluate(
    client,
    "document.querySelector('[data-theme-toggle]').focus()",
  );
  await pressKey(client, "Enter");
  assert.notEqual(
    await evaluate(client, "document.documentElement.dataset.theme"),
    previousTheme,
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 844,
    mobile: false,
    width: 375,
  });
  assert.deepEqual(
    await evaluate(client, `({
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth,
      operationButtonsVisible: [...document.querySelectorAll("[data-operation]")]
        .every((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }),
    })`),
    {
      noHorizontalOverflow: true,
      operationButtonsVisible: true,
    },
  );

  assert.deepEqual(
    await evaluate(client, `(() => {
      const select = document.querySelector("#game-select");
      select.value = "game-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        emptyTitle: document.querySelector("#account-empty-title").textContent,
        searchDisabled: document.querySelector("#search-button").disabled,
        userIdDisabled: document.querySelector("#account-user-id").disabled,
      };
    })()`),
    {
      emptyTitle: "游戏维护中",
      searchDisabled: true,
      userIdDisabled: true,
    },
  );

  await evaluate(client, `(() => {
    const select = document.querySelector("#game-select");
    select.value = "game-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const userId = document.querySelector("#account-user-id");
    userId.value = "u_12345";
    document.querySelector("#account-search-form").requestSubmit();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#account-card').hidden",
    "重新加载竞态测试账号",
  );

  const delayedOperation = fixture.delayNextOperation();
  t.after(delayedOperation.release);
  await evaluate(client, `(() => {
    document.querySelector("#toast-region").replaceChildren();
    document.querySelector('[data-operation="ban"]').focus();
  })()`);
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#operation-dialog').open",
    "打开待过期操作对话框",
  );
  await focusAndType(client, "#operation-reason", "延迟响应竞态");
  await evaluate(
    client,
    "document.querySelector('#operation-confirm').focus()",
  );
  await pressKey(client, "Enter");
  await delayedOperation.started;

  await client.send("Emulation.setVirtualTimePolicy", {
    budget: (30 * 60 * 1_000) + 1,
    maxVirtualTimeTaskStarvationCount: 10_000,
    policy: "advance",
  });
  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "操作等待期间空闲会话自动退出",
  );
  delayedOperation.release();
  await delay(100);
  assert.deepEqual(
    await evaluate(client, `({
      accountHidden: document.querySelector("#account-card").hidden,
      accountFieldsEmpty: [
        "#account-card-user-id",
        "#account-game",
        "#account-last-login",
        "#account-session-count",
        "#operation-dialog-target",
        "#operation-dialog-description",
      ].every((selector) => document.querySelector(selector).textContent === ""),
      reason: document.querySelector("#operation-reason").value,
      selectedGame: document.querySelector("#selected-game-label").textContent,
      toastCount: document.querySelector("#toast-region").childElementCount,
      userId: document.querySelector("#account-user-id").value,
    })`),
    {
      accountHidden: true,
      accountFieldsEmpty: true,
      reason: "",
      selectedGame: "",
      toastCount: 0,
      userId: "",
    },
  );
  assert.equal(fixture.operations.length, 2);
  assert.deepEqual(browserErrors, []);
});
