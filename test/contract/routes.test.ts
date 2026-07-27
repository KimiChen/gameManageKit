import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildApps, type GameManageKitServices } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  listRegisteredRoutes,
  type RegisteredHttpRoute,
} from "../../src/http/common.js";
import { checkContractBreaking } from "../../scripts/check-contract-breaking.js";

type JsonRecord = Record<string, unknown>;

function serviceStubs(): GameManageKitServices {
  return {
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
    adminLimiter: {
      allow() {
        return true;
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
    GAME_MANAGE_KIT_SERVICE_SECRET: "service",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin",
    AUTH_DEV_ENABLED: "1",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  });
  const apps = buildApps(config, serviceStubs());
  t.after(async () => {
    await Promise.all([apps.publicApp.close(), apps.internalApp.close()]);
  });
  await Promise.all([apps.publicApp.ready(), apps.internalApp.ready()]);

  assert.deepEqual(
    new Set(listRegisteredRoutes(apps.publicApp).map(canonicalRoute)),
    expectedPublic,
  );
  assert.deepEqual(
    new Set(listRegisteredRoutes(apps.internalApp).map(canonicalRoute)),
    expectedInternal,
  );
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
