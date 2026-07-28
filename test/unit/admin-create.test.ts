import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminOperator,
  generateAdminPassword,
  parseAdminCreateArgs,
} from "../../src/admin-create.js";
import type { Database } from "../../src/infra/mysql/database.js";

test("管理员初始密码由 12 字节熵生成固定 16 位 Base64URL", () => {
  const entropy = Buffer.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55,
    0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
  ]);
  const password = generateAdminPassword((size) => {
    assert.equal(size, 12);
    return Buffer.from(entropy);
  });

  assert.equal(password, "ABEiM0RVZneImaq7");
  assert.equal(password.length, 16);
  assert.match(password, /^[A-Za-z0-9_-]{16}$/u);
});

test("管理员初始密码拒绝长度或类型错误的随机源", () => {
  assert.throws(
    () => generateAdminPassword(() => Buffer.alloc(11)),
    /12 字节 Buffer/u,
  );
  assert.throws(
    () => generateAdminPassword(
      () => new Uint8Array(12) as unknown as Buffer,
    ),
    /12 字节 Buffer/u,
  );
});

test("管理员创建参数支持账号、显示名、游戏及显式全局游戏管理能力", () => {
  assert.deepEqual(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--display-name",
      "Kimi",
      "--games",
      "game-a,game-b",
      "--manage-games",
    ]),
    {
      operatorId: "ops_kimi",
      displayName: "Kimi",
      gameIds: ["game-a", "game-b"],
      canOperateAccounts: true,
      canManageGames: true,
      canManageIntegrations: false,
      canRotateSecrets: false,
      canManageMachineIdentities: false,
    },
  );
  assert.equal(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_viewer",
      "--games",
      "game-a",
      "--read-only",
    ]).canOperateAccounts,
    false,
  );
  assert.equal(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_default",
      "--games",
      "game-a",
    ]).canManageGames,
    false,
  );
  assert.deepEqual(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_bootstrap",
      "--display-name",
      "Bootstrap Admin",
      "--full-config",
    ]),
    {
      operatorId: "ops_bootstrap",
      displayName: "Bootstrap Admin",
      gameIds: [],
      canOperateAccounts: true,
      canManageGames: true,
      canManageIntegrations: true,
      canRotateSecrets: true,
      canManageMachineIdentities: true,
    },
  );
});

test("管理员创建将各项全局配置能力写入数据库", async () => {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const database = {
    async transaction<T>(
      fn: (connection: {
        query: () => Promise<readonly [Array<{ game_id: string }>, readonly []]>;
        execute: (sql: string, params: readonly unknown[]) => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      return fn({
        async query() {
          return [[{ game_id: "game-a" }], []] as const;
        },
        async execute(sql, params) {
          statements.push({ sql: sql.replace(/\s+/gu, " ").trim(), params });
        },
      });
    },
  } as unknown as Database;

  await createAdminOperator(database, {
    operatorId: "ops_manager",
    displayName: "Manager",
    gameIds: ["game-a"],
    canOperateAccounts: true,
    canManageGames: true,
    canManageIntegrations: true,
    canRotateSecrets: true,
    canManageMachineIdentities: true,
  }, "valid-admin-password");

  assert.match(statements[0]?.sql ?? "", /\bcan_manage_games\b/u);
  assert.match(statements[0]?.sql ?? "", /\bcan_manage_integrations\b/u);
  assert.match(statements[0]?.sql ?? "", /\bcan_rotate_secrets\b/u);
  assert.match(
    statements[0]?.sql ?? "",
    /\bcan_manage_machine_identities\b/u,
  );
  assert.deepEqual(statements[0]?.params.slice(-4), [1, 1, 1, 1]);
});

test("全配置引导管理员可在零游戏环境直接创建", async () => {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  let gameLookupCount = 0;
  const database = {
    async transaction<T>(
      fn: (connection: {
        query: () => Promise<readonly [never[], readonly []]>;
        execute: (sql: string, params: readonly unknown[]) => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      return fn({
        async query() {
          gameLookupCount += 1;
          return [[], []] as const;
        },
        async execute(sql, params) {
          statements.push({ sql: sql.replace(/\s+/gu, " ").trim(), params });
        },
      });
    },
  } as unknown as Database;

  await createAdminOperator(database, {
    operatorId: "ops_bootstrap",
    displayName: "Bootstrap Admin",
    gameIds: [],
    canOperateAccounts: true,
    canManageGames: true,
    canManageIntegrations: true,
    canRotateSecrets: true,
    canManageMachineIdentities: true,
  }, "valid-admin-password");

  assert.equal(gameLookupCount, 0);
  assert.match(statements[0]?.sql ?? "", /INSERT INTO admin_operators/u);
  assert.deepEqual(statements[0]?.params.slice(-4), [1, 1, 1, 1]);
  assert.match(statements[1]?.sql ?? "", /INSERT INTO admin_auth_audit/u);
});

test("管理员创建参数拒绝密码参数、重复游戏和非法账号", () => {
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--games",
      "game-a",
      "--password",
      "do-not-put-secrets-in-argv",
    ]),
    /不支持的参数 --password/,
  );
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--games",
      "game-a,game-a",
    ]),
    /无重复/,
  );
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "INVALID",
      "--games",
      "game-a",
    ]),
    /operatorId/,
  );
});
