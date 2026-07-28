import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { Database } from "../../src/infra/mysql/database.js";
import { runMigrations } from "../../src/migrate.js";

const execFileAsync = promisify(execFile);

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function hasMysqlErrno(expected: number): (error: unknown) => boolean {
  return (error: unknown): boolean => (
    typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === expected
  );
}

test("v3 迁移建立动态配置、权限、摘要与审计边界", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName = `game_manage_kit_migration_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  const initialMigrations = await mkdtemp(
    join(tmpdir(), "game-manage-kit-migration-"),
  );

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    for (const name of ["0001_initial.sql", "0002_game_servers.sql"]) {
      await writeFile(
        join(initialMigrations, name),
        await readFile(join("migrations", name), "utf8"),
        "utf8",
      );
    }
    await runMigrations(mysqlUrl, initialMigrations);

    const beforeUpgrade = await mysql.createConnection(mysqlUrl);
    try {
      await beforeUpgrade.query(
        `INSERT INTO admin_operators
           (operator_id, display_name, password_hash, can_manage_games)
         VALUES ('ops_before_upgrade', '升级前管理员', 'test-only-hash', 1)`,
      );
      await beforeUpgrade.query(
        `INSERT INTO games
           (game_id, name, status, configuration_state, client_visible)
         VALUES
           ('game-a', '游戏 A', 'enabled', 'configured', 1),
           ('game-b', '游戏 B', 'maintenance', 'draft', 0)`,
      );
      await beforeUpgrade.query(
        `INSERT INTO game_directory_settings (game_id, is_ops)
         VALUES ('game-a', 1)`,
      );
      await beforeUpgrade.query(
        `INSERT INTO seq (game_id, name, val)
         VALUES ('game-a', 'user_id', 7)`,
      );
    } finally {
      await beforeUpgrade.end();
    }

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

    const connection = await mysql.createConnection(mysqlUrl);
    try {
      const [versions] = await connection.query<RowDataPacket[]>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        versions.map((row) => [Number(row.version), String(row.name)]),
        [
          [1, "0001_initial.sql"],
          [2, "0002_game_servers.sql"],
          [3, "0003_admin_managed_config.sql"],
        ],
      );

      const [tables] = await connection.query<RowDataPacket[]>("SHOW TABLES");
      const tableNames = new Set(
        tables.flatMap((row) => Object.values(row).map(String)),
      );
      for (const table of [
        "game_integrations",
        "machine_identities",
        "machine_identity_games",
        "machine_secret_versions",
        "admin_secret_operations",
        "admin_secret_audit",
        "admin_machine_identity_audit",
      ]) {
        assert.equal(tableNames.has(table), true, `${table} 未创建`);
      }

      const [columns] = await connection.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                COLUMN_TYPE AS column_type
           FROM information_schema.columns
          WHERE TABLE_SCHEMA = DATABASE()
            AND (
              (TABLE_NAME = 'game_directory_settings'
                AND COLUMN_NAME = 'revision')
              OR (TABLE_NAME = 'admin_sessions'
                AND COLUMN_NAME = 'elevated_until')
              OR (TABLE_NAME = 'admin_operators'
                AND COLUMN_NAME IN (
                  'can_manage_integrations',
                  'can_rotate_secrets',
                  'can_manage_machine_identities'
                ))
              OR (TABLE_NAME = 'game_integrations'
                AND COLUMN_NAME IN (
                  'wechat_app_secret',
                  'wechat_secret_version',
                  'wechat_validation_failed_at',
                  'revision'
                ))
              OR (TABLE_NAME = 'machine_secret_versions'
                AND COLUMN_NAME = 'secret_digest')
            )`,
      );
      const columnTypes = new Map(columns.map((row) => [
        `${String(row.table_name)}.${String(row.column_name)}`,
        String(row.column_type),
      ]));
      assert.equal(
        columnTypes.get("game_integrations.wechat_app_secret"),
        "varchar(512)",
      );
      assert.equal(
        columnTypes.get("game_integrations.wechat_validation_failed_at"),
        "datetime(3)",
      );
      assert.equal(
        columnTypes.get("machine_secret_versions.secret_digest"),
        "binary(32)",
      );
      assert.equal(
        columnTypes.get("game_directory_settings.revision"),
        "bigint unsigned",
      );
      assert.equal(
        columnTypes.get("admin_sessions.elevated_until"),
        "datetime(3)",
      );
      for (const capability of [
        "can_manage_integrations",
        "can_rotate_secrets",
        "can_manage_machine_identities",
      ]) {
        assert.equal(
          columnTypes.get(`admin_operators.${capability}`),
          "tinyint unsigned",
        );
      }

      const [backfilled] = await connection.query<RowDataPacket[]>(
        `SELECT g.game_id, g.status, g.configuration_state,
                g.client_visible, g.revision AS game_revision,
                d.is_ops, d.revision AS directory_revision,
                i.wechat_app_secret, i.wechat_secret_version,
                i.revision AS integration_revision, s.val
           FROM games AS g
           JOIN game_directory_settings AS d ON d.game_id = g.game_id
           JOIN game_integrations AS i ON i.game_id = g.game_id
           JOIN seq AS s ON s.game_id = g.game_id AND s.name = 'user_id'
          ORDER BY g.game_id`,
      );
      assert.deepEqual(backfilled.map((row) => ({
        gameId: String(row.game_id),
        status: String(row.status),
        configurationState: String(row.configuration_state),
        clientVisible: Number(row.client_visible),
        gameRevision: Number(row.game_revision),
        isOps: Number(row.is_ops),
        directoryRevision: Number(row.directory_revision),
        appSecret: row.wechat_app_secret,
        secretVersion: Number(row.wechat_secret_version),
        integrationRevision: Number(row.integration_revision),
        sequence: Number(row.val),
      })), [
        {
          gameId: "game-a",
          status: "maintenance",
          configurationState: "draft",
          clientVisible: 0,
          gameRevision: 2,
          isOps: 1,
          directoryRevision: 1,
          appSecret: null,
          secretVersion: 0,
          integrationRevision: 1,
          sequence: 7,
        },
        {
          gameId: "game-b",
          status: "maintenance",
          configurationState: "draft",
          clientVisible: 0,
          gameRevision: 1,
          isOps: 0,
          directoryRevision: 1,
          appSecret: null,
          secretVersion: 0,
          integrationRevision: 1,
          sequence: 0,
        },
      ]);

      const [operator] = await connection.query<RowDataPacket[]>(
        `SELECT can_manage_games, can_manage_integrations,
                can_rotate_secrets, can_manage_machine_identities
           FROM admin_operators
          WHERE operator_id = 'ops_before_upgrade'`,
      );
      assert.deepEqual({
        canManageGames: Number(operator[0]?.can_manage_games),
        canManageIntegrations:
          Number(operator[0]?.can_manage_integrations),
        canRotateSecrets: Number(operator[0]?.can_rotate_secrets),
        canManageMachineIdentities:
          Number(operator[0]?.can_manage_machine_identities),
      }, {
        canManageGames: 1,
        canManageIntegrations: 0,
        canRotateSecrets: 0,
        canManageMachineIdentities: 0,
      });

      const appSecret = randomBytes(24).toString("base64url");
      await connection.query(
        `UPDATE game_integrations
            SET wechat_app_secret = ?,
                wechat_secret_version = 1,
                wechat_secret_updated_by = 'ops_before_upgrade',
                wechat_secret_updated_at = NOW(3)
          WHERE game_id = 'game-a'`,
        [appSecret],
      );
      const [storedAppSecret] = await connection.query<RowDataPacket[]>(
        `SELECT wechat_app_secret
           FROM game_integrations
          WHERE game_id = 'game-a'`,
      );
      assert.equal(storedAppSecret[0]?.wechat_app_secret, appSecret);

      await connection.query(
        `INSERT INTO machine_identities
           (identity_id, identity_type, display_name)
         VALUES
           ('game-a-service', 'service', '相同展示名'),
           ('game-b-service', 'service', '相同展示名')`,
      );
      await connection.query(
        `INSERT INTO machine_identity_games (identity_id, game_id)
         VALUES
           ('game-a-service', 'game-a'),
           ('game-b-service', 'game-b')`,
      );
      await connection.query(
        `INSERT INTO machine_secret_versions
           (identity_id, version, secret_digest, state, created_by)
         VALUES
           ('game-a-service', 1, ?, 'current', 'ops_before_upgrade'),
           ('game-b-service', 1, ?, 'current', 'ops_before_upgrade')`,
        [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)],
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO machine_secret_versions
             (identity_id, version, secret_digest, state, created_by)
           VALUES
             ('game-a-service', 2, ?, 'current', 'ops_before_upgrade')`,
          [Buffer.alloc(32, 0x33)],
        ),
        hasMysqlErrno(1062),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO machine_secret_versions
             (identity_id, version, secret_digest, state, created_by,
              revoked_at)
           VALUES
             ('game-a-service', 2, ?, 'revoked', 'ops_before_upgrade',
              NOW(3))`,
          [Buffer.alloc(32, 0x22)],
        ),
        hasMysqlErrno(1062),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO machine_secret_versions
             (identity_id, version, secret_digest, state, created_by)
           VALUES
             ('game-a-service', 2, ?, 'previous', 'ops_before_upgrade')`,
          [Buffer.alloc(32, 0x44)],
        ),
        hasMysqlErrno(3819),
      );

      await connection.query(
        `INSERT INTO admin_secret_operations
           (operation_id, operator_id, identity_id, secret_kind, action,
            old_version, new_version)
         VALUES
           ('create-service-op', 'ops_before_upgrade', 'game-a-service',
            'service_secret', 'set', NULL, 1)`,
      );
      await connection.query(
        `INSERT INTO admin_secret_audit
           (operator_id, identity_id, secret_kind, action, old_version,
            new_version, result, reason, request_id)
         VALUES
           ('ops_before_upgrade', 'game-a-service', 'service_secret', 'set',
            NULL, 1, 'succeeded', NULL, 'migration-test-request')`,
      );
      const [machineSecretColumns] = await connection.query<RowDataPacket[]>(
        `SHOW COLUMNS FROM machine_secret_versions`,
      );
      assert.deepEqual(
        machineSecretColumns
          .map((row) => String(row.Field))
          .filter((name) => name.includes("secret")),
        ["secret_digest"],
      );

      const database = new Database(mysqlUrl, 2);
      try {
        assert.equal(await database.ready(3), true);
        assert.equal(await database.ready(4), false);
      } finally {
        await database.close();
      }
    } finally {
      await connection.end();
    }
  } finally {
    await rm(initialMigrations, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
