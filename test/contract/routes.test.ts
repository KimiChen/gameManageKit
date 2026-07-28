import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildApps, type GameManageKitServices } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { GameRuntimeRegistry } from "../../src/domain/game/resolver.js";
import {
  listRegisteredRoutes,
  type RegisteredHttpRoute,
} from "../../src/http/common.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import { checkContractBreaking } from "../../scripts/check-contract-breaking.js";
import { createTestRuntimeRegistry } from "../runtime-registry.js";

type JsonRecord = Record<string, unknown>;

const OLD_SINGLE_GAME_OPERATIONS = [
  "POST /v1/sessions/wechat",
  "POST /v1/sessions/dev",
  "GET /v1/areas",
  "POST /v1/internal/sessions/verify",
  "PUT /v1/internal/characters/{userId}/{serverId}",
  "GET /v1/internal/characters/{userId}/{serverId}",
  "POST /v1/admin/accounts/{userId}/ban",
  "POST /v1/admin/accounts/{userId}/revoke",
] as const;

function serviceStubs(games: GameRuntimeRegistry): GameManageKitServices {
  const project = {
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
          gameId: project.gameId,
          name: project.name,
          description: project.description,
          status: project.status,
        }];
      },
      async list() {
        return [project];
      },
      async create() {
        return project;
      },
      async update() {
        return project;
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
      async update() {
        throw new Error("测试未调用");
      },
      async replaceWechatSecret() {
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
          response: { userId: "u_1", accessToken: "opaque", isNewAccount: true },
        };
      },
      async loginDev() {
        return {
          ok: true,
          response: { userId: "u_1", accessToken: "opaque", isNewAccount: true },
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
    admin: {
      async find() {
        return null;
      },
      async auditDenied() {},
      async execute() {
        return { accountExists: false, status: "not_found" };
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
          operatorId: "ops_contract",
          displayName: "Contract",
          authVersion: 1,
          canManageGames: true,
          canManageIntegrations: true,
          canRotateSecrets: true,
          canManageMachineIdentities: true,
          games: [],
          expiresAt: "2026-07-28T18:00:00.000Z",
          elevatedUntil: null,
        };
      },
      async reauthenticate() {
        return {
          operatorId: "ops_contract",
          displayName: "Contract",
          authVersion: 1,
          canManageGames: true,
          canManageIntegrations: true,
          canRotateSecrets: true,
          canManageMachineIdentities: true,
          games: [],
          expiresAt: "2026-07-28T18:00:00.000Z",
          elevatedUntil: "2026-07-28T17:15:00.000Z",
        };
      },
      async authenticate() {
        return {
          operatorId: "ops_contract",
          displayName: "Contract",
          authVersion: 1,
          canManageGames: true,
          canManageIntegrations: true,
          canRotateSecrets: true,
          canManageMachineIdentities: true,
          games: [],
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
  };
}

function canonicalRoute(route: RegisteredHttpRoute): string {
  const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return `${route.method.toUpperCase()} ${path}`;
}

test("实际双监听路由全集与 OpenAPI method/path/tag 完全一致", async (t) => {
  const document = YAML.parse(await readFile("openapi/openapi.yaml", "utf8")) as {
    paths: Record<string, Record<string, { tags?: string[] }>>;
  };
  const expectedPublic = new Set<string>();
  const expectedInternal = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }
      const key = `${method.toUpperCase()} ${path}`;
      const tag = operation.tags?.[0];
      if (tag === "Public" || tag === "System") {
        expectedPublic.add(key);
      }
      if (tag === "Internal" || tag === "Admin" || tag === "System") {
        expectedInternal.add(key);
      }
    }
  }

  const config = loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_contract_test",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const games = createTestRuntimeRegistry();
  const apps = buildApps(config, serviceStubs(games));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });
  await Promise.all([apps.publicApp.ready(), apps.internalApp.ready()]);

  const actualPublic = new Set(listRegisteredRoutes(apps.publicApp).map(canonicalRoute));
  const actualInternal = new Set(
    listRegisteredRoutes(apps.internalApp)
      .filter((route) => !route.path.startsWith("/admin"))
      .map(canonicalRoute),
  );
  assert.deepEqual(actualPublic, expectedPublic);
  assert.deepEqual(actualInternal, expectedInternal);

  for (const operation of OLD_SINGLE_GAME_OPERATIONS) {
    assert.equal(actualPublic.has(operation), false, `Public 仍注册旧路径 ${operation}`);
    assert.equal(actualInternal.has(operation), false, `Internal 仍注册旧路径 ${operation}`);
  }
});

test("当前 OpenAPI 未破坏 committed v1 基线", async () => {
  await checkContractBreaking();
});

test("breaking-change 检查会拒绝删除既有 operation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "game-manage-kit-contract-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const document = YAML.parse(await readFile("openapi/openapi.yaml", "utf8")) as {
    paths: Record<string, unknown>;
  };
  delete document.paths["/livez"];
  const changedSpec = join(directory, "openapi.yaml");
  await writeFile(changedSpec, YAML.stringify(document), "utf8");

  await assert.rejects(
    checkContractBreaking(changedSpec, "openapi/contract-baseline.json"),
    /删除 operation: GET \/livez/,
  );
});
