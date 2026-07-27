import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildApps, type GameManageKitServices } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { GameRegistry } from "../../src/domain/game/registry.js";
import {
  listRegisteredRoutes,
  type RegisteredHttpRoute,
} from "../../src/http/common.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";
import { checkContractBreaking } from "../../scripts/check-contract-breaking.js";

type JsonRecord = Record<string, unknown>;

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

function serviceStubs(games: GameRegistry): GameManageKitServices {
  return {
    games,
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
      async execute() {
        return { accountExists: false, status: "not_found" };
      },
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
    GAME_MANAGE_KIT_GAMES_CONFIG: "config/games.json",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const games = await GameRegistry.load(config.gamesConfigPath, {
    production: false,
    env: GAME_ENV,
  });
  const apps = buildApps(config, serviceStubs(games));
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });
  await Promise.all([apps.publicApp.ready(), apps.internalApp.ready()]);

  const actualPublic = new Set(listRegisteredRoutes(apps.publicApp).map(canonicalRoute));
  const actualInternal = new Set(listRegisteredRoutes(apps.internalApp).map(canonicalRoute));
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
