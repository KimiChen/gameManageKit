import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mysql, {
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import { AdminAuthService } from "../../src/domain/admin/auth.js";
import { GameManageKitError } from "../../src/errors.js";
import { Database } from "../../src/infra/mysql/database.js";
import { runMigrations } from "../../src/migrate.js";

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

async function copyMigrations(
  targetDirectory: string,
  names: readonly string[],
): Promise<void> {
  await Promise.all(names.map(async (name) => {
    await writeFile(
      join(targetDirectory, name),
      await readFile(join("migrations", name), "utf8"),
      "utf8",
    );
  }));
}

test("v4 迁移建立动态配置、安全边界与单调管理员引导锁存器", async () => {
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

    for (const name of [
      "0003_admin_managed_config.sql",
      "0004_admin_bootstrap.sql",
    ]) {
      await writeFile(
        join(initialMigrations, name),
        await readFile(join("migrations", name), "utf8"),
        "utf8",
      );
    }
    await runMigrations(mysqlUrl, initialMigrations);
    await runMigrations(mysqlUrl, initialMigrations);

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
          [4, "0004_admin_bootstrap.sql"],
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
        "admin_bootstrap_latch",
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
      const [bootstrapLatch] = await connection.query<RowDataPacket[]>(
        `SELECT initialized, initialized_by, initialized_at
           FROM admin_bootstrap_latch
          WHERE latch_id = 1`,
      );
      assert.equal(Number(bootstrapLatch[0]?.initialized), 1);
      assert.equal(
        String(bootstrapLatch[0]?.initialized_by),
        "ops_before_upgrade",
      );
      assert.ok(bootstrapLatch[0]?.initialized_at);

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

    } finally {
      await connection.end();
    }
  } finally {
    await rm(initialMigrations, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});

test("v5 将旧身份与微信配置迁入显式 Provider 命名空间", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName =
    `game_manage_kit_v5_success_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/u);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  const v4Migrations = await mkdtemp(
    join(tmpdir(), "game-manage-kit-v4-migration-"),
  );
  let connection: Connection | undefined;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await copyMigrations(v4Migrations, [
      "0001_initial.sql",
      "0002_game_servers.sql",
      "0003_admin_managed_config.sql",
      "0004_admin_bootstrap.sql",
    ]);
    await runMigrations(mysqlUrl, v4Migrations);

    connection = await mysql.createConnection(mysqlUrl);
    await connection.query(
      `INSERT INTO admin_operators
         (operator_id, display_name, password_hash, can_manage_games,
          can_manage_integrations, can_rotate_secrets)
       VALUES
         ('ops_v5', 'V5 Operator', 'test-only-hash', 1, 1, 1)`,
    );
    await connection.query(
      `INSERT INTO machine_identities
         (identity_id, identity_type, display_name)
       VALUES ('svc_v5', 'service', 'V5 Service')`,
    );
    await connection.query(
      `INSERT INTO games
         (game_id, name, status, configuration_state, client_visible)
       VALUES
         ('game-a', '游戏 A', 'enabled', 'configured', 1),
         ('game-b', '游戏 B', 'maintenance', 'draft', 0)`,
    );
    const wechatSecret = randomBytes(24).toString("base64url");
    await connection.query(
      `INSERT INTO game_integrations
         (game_id, wechat_app_id, wechat_app_secret,
          wechat_secret_version, wechat_secret_updated_by,
          wechat_secret_updated_at, wechat_validation_failed_at, revision)
       VALUES
         ('game-a', 'wx-app-a', ?, 3, 'ops_v5',
          '2026-01-02 03:04:05.123', '2026-01-03 04:05:06.123', 7),
         ('game-b', NULL, NULL, 0, NULL, NULL, NULL, 2)`,
      [wechatSecret],
    );
    await connection.query(
      `UPDATE game_integrations
          SET wechat_endpoint =
            'https://API.WEIXIN.QQ.COM:443/sns/jscode2session?#'
        WHERE game_id = 'game-a'`,
    );
    await connection.query(
      `INSERT INTO accounts
         (game_id, user_id, openid, unionid, created_at, last_login_at)
       VALUES
         ('game-a', 'u_wechat', 'wx-open-a', 'wx-union-a',
          '2025-01-01 00:00:00.000', '2025-02-01 00:00:00.000'),
         ('game-a', 'u_union', NULL, 'wx-union-only',
          '2025-01-02 00:00:00.000', NULL),
         ('game-a', 'u_dev', 'dev_local-user', NULL,
          '2025-01-03 00:00:00.000', '2025-02-03 00:00:00.000'),
         ('game-b', 'u_dev_b', 'dev_second-user', NULL,
          '2025-01-04 00:00:00.000', NULL)`,
    );
    await connection.query(
      `INSERT INTO admin_secret_operations
         (operation_id, operator_id, game_id, identity_id, secret_kind,
          action, old_version, new_version)
       VALUES
         ('legacy-wechat-secret', 'ops_v5', 'game-a',
          NULL, 'wechat_app_secret', 'set', 0, 3),
         ('legacy-service-secret', 'ops_v5', NULL,
          'svc_v5', 'service_secret', 'set', 0, 1)`,
    );
    await connection.query(
      `INSERT INTO admin_secret_audit
         (operator_id, game_id, identity_id, secret_kind, action,
          old_version, new_version, result, request_id)
       VALUES
         ('ops_v5', 'game-a', NULL, 'wechat_app_secret', 'set', NULL,
          3, 'succeeded', 'legacy-wechat-request'),
         ('ops_v5', NULL, 'svc_v5', 'service_secret', 'set', 0,
          NULL, 'failed', 'legacy-service-request')`,
    );

    await runMigrations(mysqlUrl);
    await runMigrations(mysqlUrl);

    const [versions] = await connection.query<RowDataPacket[]>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => [Number(row.version), String(row.name)]),
      [
        [1, "0001_initial.sql"],
        [2, "0002_game_servers.sql"],
        [3, "0003_admin_managed_config.sql"],
        [4, "0004_admin_bootstrap.sql"],
        [5, "0005_identity_providers.sql"],
      ],
    );

    const [providers] = await connection.query<RowDataPacket[]>(
      `SELECT game_id, provider, enabled, app_id, app_secret,
              secret_version, endpoint, validation_state,
              validation_failed_at, validation_error_code, updated_by
         FROM game_identity_providers
        ORDER BY game_id, FIELD(provider, 'douyin', 'wechat')`,
    );
    assert.deepEqual(providers.map((row) => ({
      gameId: String(row.game_id),
      provider: String(row.provider),
      enabled: Number(row.enabled),
      appId: row.app_id,
      appSecret: row.app_secret,
      secretVersion: Number(row.secret_version),
      endpoint: String(row.endpoint),
      validationState: String(row.validation_state),
      validationFailedAt: row.validation_failed_at,
      validationErrorCode: row.validation_error_code,
      updatedBy: row.updated_by,
    })), [
      {
        gameId: "game-a",
        provider: "douyin",
        enabled: 0,
        appId: null,
        appSecret: null,
        secretVersion: 0,
        endpoint:
          "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
        validationState: "unvalidated",
        validationFailedAt: null,
        validationErrorCode: null,
        updatedBy: null,
      },
      {
        gameId: "game-a",
        provider: "wechat",
        enabled: 1,
        appId: "wx-app-a",
        appSecret: wechatSecret,
        secretVersion: 3,
        endpoint: "https://api.weixin.qq.com/sns/jscode2session",
        validationState: "unvalidated",
        validationFailedAt: null,
        validationErrorCode: null,
        updatedBy: "ops_v5",
      },
      {
        gameId: "game-b",
        provider: "douyin",
        enabled: 0,
        appId: null,
        appSecret: null,
        secretVersion: 0,
        endpoint:
          "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
        validationState: "unvalidated",
        validationFailedAt: null,
        validationErrorCode: null,
        updatedBy: null,
      },
      {
        gameId: "game-b",
        provider: "wechat",
        enabled: 0,
        appId: null,
        appSecret: null,
        secretVersion: 0,
        endpoint: "https://api.weixin.qq.com/sns/jscode2session",
        validationState: "unvalidated",
        validationFailedAt: null,
        validationErrorCode: null,
        updatedBy: null,
      },
    ]);

    const [identities] = await connection.query<RowDataPacket[]>(
      `SELECT game_id, user_id, provider, provider_app_id,
              subject_type, subject
         FROM account_identities
        ORDER BY game_id, user_id, subject_type`,
    );
    assert.deepEqual(identities.map((row) => ({
      gameId: String(row.game_id),
      userId: String(row.user_id),
      provider: String(row.provider),
      providerAppId: String(row.provider_app_id),
      subjectType: String(row.subject_type),
      subject: String(row.subject),
    })), [
      {
        gameId: "game-a",
        userId: "u_dev",
        provider: "dev",
        providerAppId: "local",
        subjectType: "dev_key",
        subject: "local-user",
      },
      {
        gameId: "game-a",
        userId: "u_union",
        provider: "wechat",
        providerAppId: "wx-app-a",
        subjectType: "unionid",
        subject: "wx-union-only",
      },
      {
        gameId: "game-a",
        userId: "u_wechat",
        provider: "wechat",
        providerAppId: "wx-app-a",
        subjectType: "openid",
        subject: "wx-open-a",
      },
      {
        gameId: "game-a",
        userId: "u_wechat",
        provider: "wechat",
        providerAppId: "wx-app-a",
        subjectType: "unionid",
        subject: "wx-union-a",
      },
      {
        gameId: "game-b",
        userId: "u_dev_b",
        provider: "dev",
        providerAppId: "local",
        subjectType: "dev_key",
        subject: "second-user",
      },
    ]);

    const [removedColumns] = await connection.query<RowDataPacket[]>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND (
            (table_name = 'accounts'
              AND column_name IN ('openid', 'unionid'))
            OR (
              table_name = 'game_integrations'
              AND column_name LIKE 'wechat\\_%'
            )
          )`,
    );
    assert.deepEqual(removedColumns, []);

    const [migratedAudit] = await connection.query<RowDataPacket[]>(
      `SELECT provider, secret_kind, action, old_version
         FROM admin_secret_operations
        WHERE operation_id = 'legacy-wechat-secret'`,
    );
    assert.deepEqual({
      provider: String(migratedAudit[0]?.provider),
      secretKind: String(migratedAudit[0]?.secret_kind),
      action: String(migratedAudit[0]?.action),
      oldVersion: migratedAudit[0]?.old_version,
    }, {
      provider: "wechat",
      secretKind: "identity_provider_secret",
      action: "set",
      oldVersion: null,
    });
    const [normalizedLegacyVersions] =
      await connection.query<RowDataPacket[]>(
        `SELECT
           (
             SELECT old_version
               FROM admin_secret_operations
              WHERE operation_id = 'legacy-service-secret'
           ) AS operation_old_version,
           (
             SELECT old_version
               FROM admin_secret_audit
              WHERE request_id = 'legacy-service-request'
           ) AS audit_old_version`,
      );
    assert.deepEqual({
      operationOldVersion:
        normalizedLegacyVersions[0]?.operation_old_version,
      auditOldVersion: normalizedLegacyVersions[0]?.audit_old_version,
    }, {
      operationOldVersion: null,
      auditOldVersion: null,
    });
    await connection.query(
      `INSERT INTO admin_secret_operations
         (operation_id, operator_id, game_id, provider, secret_kind,
          action, old_version, new_version)
       VALUES
         ('clear-douyin-secret', 'ops_v5', 'game-a', 'douyin',
          'identity_provider_secret', 'clear', 2, NULL)`,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO admin_secret_operations
           (operation_id, operator_id, game_id, provider, secret_kind,
            action, old_version, new_version)
         VALUES
           ('provider-secret-without-provider', 'ops_v5', 'game-a', NULL,
            'identity_provider_secret', 'set', NULL, 1)`,
      ),
      hasMysqlErrno(3819),
    );
    await connection.query(
      `INSERT INTO admin_game_audit
         (game_id, operator_id, provider, action, before_data, after_data)
       VALUES
         ('game-a', 'ops_v5', 'wechat', 'identity_provider_update',
          JSON_OBJECT('enabled', 0), JSON_OBJECT('enabled', 1))`,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, provider, action, before_data, after_data)
         VALUES
           ('game-a', 'ops_v5', 'wechat', 'integration_update',
            JSON_OBJECT(), JSON_OBJECT())`,
      ),
      hasMysqlErrno(3819),
    );
    await connection.query(
      `INSERT INTO login_audit
         (game_id, user_id, event, provider, request_id, server_id,
          outcome, provider_latency_ms, provider_version)
       VALUES
         ('game-a', 'u_wechat', 'login', 'wechat', 'login-request-v5',
          13, 'banned', 15, 3)`,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO login_audit
           (game_id, event, provider, request_id, outcome, provider_version)
         VALUES
           ('game-a', 'login', 'wechat', 'invalid-provider-version',
            'internal_error', 0)`,
      ),
      hasMysqlErrno(3819),
    );

    await connection.query(
      `INSERT INTO accounts (game_id, user_id)
       VALUES ('game-a', 'u_constraint')`,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO account_identities
           (game_id, user_id, provider, provider_app_id,
            subject_type, subject)
         VALUES
           ('game-a', 'u_constraint', 'wechat', 'wx-app-a',
            'openid', 'wx-open-a')`,
      ),
      hasMysqlErrno(1062),
    );
    await connection.query(
      `INSERT INTO account_identities
         (game_id, user_id, provider, provider_app_id,
          subject_type, subject)
       VALUES
         ('game-a', 'u_constraint', 'douyin', 'dy-app-a',
          'openid', 'wx-open-a'),
         ('game-a', 'u_constraint', 'wechat', 'wx-app-other',
          'openid', 'wx-open-a')`,
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO account_identities
           (game_id, user_id, provider, provider_app_id,
            subject_type, subject)
         VALUES
           ('game-b', 'u_wechat', 'wechat', 'wx-app-a',
            'openid', 'cross-game')`,
      ),
      hasMysqlErrno(1452),
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO account_identities
           (game_id, user_id, provider, provider_app_id,
            subject_type, subject)
         VALUES
           ('game-a', 'u_constraint', 'dev', 'local',
            'openid', 'invalid-dev')`,
      ),
      hasMysqlErrno(3819),
    );
    await assert.rejects(
      connection.query(
        `UPDATE game_identity_providers
            SET enabled = 1
          WHERE game_id = 'game-b' AND provider = 'douyin'`,
      ),
      hasMysqlErrno(3819),
    );
    await assert.rejects(
      connection.query(
        `UPDATE game_identity_providers
            SET secret_version = 1
          WHERE game_id = 'game-b' AND provider = 'douyin'`,
      ),
      hasMysqlErrno(3819),
    );
    await assert.rejects(
      connection.query(
        `UPDATE game_identity_providers
            SET app_id = 'local'
          WHERE game_id = 'game-b' AND provider = 'douyin'`,
      ),
      hasMysqlErrno(3819),
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO account_identities
           (game_id, user_id, provider, provider_app_id,
            subject_type, subject)
         VALUES
           ('game-a', 'u_constraint', 'wechat', 'local',
            'openid', 'external-local')`,
      ),
      hasMysqlErrno(3819),
    );

    const database = new Database(mysqlUrl, 2);
    try {
      assert.equal(await database.ready(5), true);
      assert.equal(await database.ready(4), false);
    } finally {
      await database.close();
    }
  } finally {
    await connection?.end();
    await rm(v4Migrations, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});

test("v5 预检与晚期失败均保留数据，修复后可安全重跑", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName =
    `game_manage_kit_v5_preflight_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/u);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  const v4Migrations = await mkdtemp(
    join(tmpdir(), "game-manage-kit-v4-preflight-"),
  );
  let connection: Connection | undefined;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await copyMigrations(v4Migrations, [
      "0001_initial.sql",
      "0002_game_servers.sql",
      "0003_admin_managed_config.sql",
      "0004_admin_bootstrap.sql",
    ]);
    await runMigrations(mysqlUrl, v4Migrations);
    connection = await mysql.createConnection(mysqlUrl);
    await connection.query(
      `INSERT INTO games (game_id, name)
       VALUES ('preflight-game', 'Preflight Game')`,
    );
    await connection.query(
      `INSERT INTO game_integrations (game_id)
       VALUES ('preflight-game')`,
    );
    await connection.query(
      `INSERT INTO accounts (game_id, user_id, openid, unionid)
       VALUES
         ('preflight-game', 'u_missing_app', 'wx-open', NULL),
         ('preflight-game', 'u_bad_dev', 'dev_bad', 'wx-union')`,
    );

    await assert.rejects(
      runMigrations(mysqlUrl),
      hasMysqlErrno(3819),
    );
    const [version] = await connection.query<RowDataPacket[]>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    assert.equal(Number(version[0]?.version), 4);
    const [errors] = await connection.query<RowDataPacket[]>(
      `SELECT user_id, error_code
         FROM schema_v5_identity_migration_errors
        ORDER BY user_id, error_code`,
    );
    assert.deepEqual(errors.map((row) => [
      String(row.user_id),
      String(row.error_code),
    ]), [
      ["u_bad_dev", "DEV_IDENTITY_HAS_UNIONID"],
      ["u_bad_dev", "WECHAT_APP_ID_MISSING"],
      ["u_missing_app", "WECHAT_APP_ID_MISSING"],
    ]);
    const [targetTables] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN (
            'account_identities',
            'game_identity_providers'
          )`,
    );
    assert.deepEqual(targetTables, []);

    await connection.query(
      `UPDATE game_integrations
          SET wechat_app_id = 'local'
        WHERE game_id = 'preflight-game'`,
    );
    await assert.rejects(
      runMigrations(mysqlUrl),
      hasMysqlErrno(3819),
    );
    const [reservedAppId] = await connection.query<RowDataPacket[]>(
      `SELECT game_id, user_id
         FROM schema_v5_identity_migration_errors
        WHERE error_code = 'WECHAT_APP_ID_RESERVED'`,
    );
    assert.deepEqual(reservedAppId.map((row) => ({
      gameId: String(row.game_id),
      userId: row.user_id,
    })), [{
      gameId: "preflight-game",
      userId: null,
    }]);

    await connection.query(
      `UPDATE game_integrations
          SET wechat_app_id = 'wx-preflight'
        WHERE game_id = 'preflight-game'`,
    );
    await connection.query(
      `UPDATE accounts
          SET unionid = NULL
        WHERE game_id = 'preflight-game'
          AND user_id = 'u_bad_dev'`,
    );
    await connection.query(
      `UPDATE accounts
          SET openid = ''
        WHERE game_id = 'preflight-game'
          AND user_id = 'u_missing_app'`,
    );
    await assert.rejects(
      runMigrations(mysqlUrl),
      hasMysqlErrno(3819),
    );
    const [emptySubject] = await connection.query<RowDataPacket[]>(
      `SELECT game_id, user_id
         FROM schema_v5_identity_migration_errors
        WHERE error_code = 'IDENTITY_SUBJECT_EMPTY'`,
    );
    assert.deepEqual(emptySubject.map((row) => ({
      gameId: String(row.game_id),
      userId: String(row.user_id),
    })), [{
      gameId: "preflight-game",
      userId: "u_missing_app",
    }]);
    await connection.query(
      `UPDATE accounts
          SET openid = 'wx-open'
        WHERE game_id = 'preflight-game'
          AND user_id = 'u_missing_app'`,
    );
    const v5Name = "0005_identity_providers.sql";
    const v5Sql = await readFile(join("migrations", v5Name), "utf8");
    const lateFailureMarker =
      "-- The first late ALTER is durable here.";
    assert.equal(v5Sql.includes(lateFailureMarker), true);
    await writeFile(
      join(v4Migrations, v5Name),
      v5Sql.replace(
        lateFailureMarker,
        `SIGNAL SQLSTATE '45000'\n`
          + `  SET MESSAGE_TEXT = 'fixture late migration failure';\n\n`
          + lateFailureMarker,
      ),
      "utf8",
    );
    await assert.rejects(
      runMigrations(mysqlUrl, v4Migrations),
      hasMysqlErrno(1644),
    );
    const [preservedTargets] =
      await connection.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM account_identities) AS identity_count,
           (SELECT COUNT(*) FROM game_identity_providers) AS provider_count`,
      );
    assert.deepEqual({
      identityCount: Number(preservedTargets[0]?.identity_count),
      providerCount: Number(preservedTargets[0]?.provider_count),
    }, {
      identityCount: 2,
      providerCount: 2,
    });
    const [partialSchema] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS column_count
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND (
            (table_name = 'admin_game_audit' AND column_name = 'provider')
            OR (table_name = 'accounts' AND column_name = 'openid')
            OR (
              table_name = 'game_integrations'
              AND column_name = 'wechat_app_id'
            )
          )`,
    );
    assert.equal(Number(partialSchema[0]?.column_count), 3);

    const destructiveFailureMarker =
      "-- The accounts cutover is durable here;";
    assert.equal(v5Sql.includes(destructiveFailureMarker), true);
    await writeFile(
      join(v4Migrations, v5Name),
      v5Sql.replace(
        destructiveFailureMarker,
        `SIGNAL SQLSTATE '45000'\n`
          + `  SET MESSAGE_TEXT = 'fixture destructive migration failure';\n\n`
          + destructiveFailureMarker,
      ),
      "utf8",
    );
    await assert.rejects(
      runMigrations(mysqlUrl, v4Migrations),
      hasMysqlErrno(1644),
    );
    const [partialCutover] = await connection.query<RowDataPacket[]>(
      `SELECT
         (
           SELECT COUNT(*)
             FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'accounts'
              AND column_name = 'openid'
         ) AS account_legacy_count,
         (
           SELECT COUNT(*)
             FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'game_integrations'
              AND column_name = 'wechat_app_id'
         ) AS integration_legacy_count`,
    );
    assert.deepEqual({
      accountLegacyCount:
        Number(partialCutover[0]?.account_legacy_count),
      integrationLegacyCount:
        Number(partialCutover[0]?.integration_legacy_count),
    }, {
      accountLegacyCount: 0,
      integrationLegacyCount: 1,
    });

    await writeFile(join(v4Migrations, v5Name), v5Sql, "utf8");
    await runMigrations(mysqlUrl, v4Migrations);

    const [finalVersion] = await connection.query<RowDataPacket[]>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    assert.equal(Number(finalVersion[0]?.version), 5);
    const [identityCount] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM account_identities",
    );
    assert.equal(Number(identityCount[0]?.count), 2);
    await connection.query(
      "DELETE FROM schema_migrations WHERE version = 5",
    );
    await runMigrations(mysqlUrl, v4Migrations);
    const [recoveredVersion] = await connection.query<RowDataPacket[]>(
      "SELECT name FROM schema_migrations WHERE version = 5",
    );
    assert.equal(
      String(recoveredVersion[0]?.name),
      "0005_identity_providers.sql",
    );
    const [recoveredIdentityCount] =
      await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM account_identities",
      );
    assert.equal(Number(recoveredIdentityCount[0]?.count), 2);
    const [diagnosticTable] = await connection.query<RowDataPacket[]>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'schema_v5_identity_migration_errors'`,
    );
    assert.deepEqual(diagnosticTable, []);
  } finally {
    await connection?.end();
    await rm(v4Migrations, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});

test("并发首管创建仅一个成功且删除管理员不会重新开放引导", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName =
    `game_manage_kit_bootstrap_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/u);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  let database: Database | undefined;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await runMigrations(mysqlUrl);
    database = new Database(mysqlUrl, 5);

    const [initialLatch] = await database.pool.query<RowDataPacket[]>(
      `SELECT initialized, initialized_by, initialized_at
         FROM admin_bootstrap_latch
        WHERE latch_id = 1`,
    );
    assert.deepEqual({
      initialized: Number(initialLatch[0]?.initialized),
      initializedBy: initialLatch[0]?.initialized_by,
      initializedAt: initialLatch[0]?.initialized_at,
    }, {
      initialized: 0,
      initializedBy: null,
      initializedAt: null,
    });

    let hashArrivals = 0;
    let releaseHashes: (() => void) | undefined;
    const bothHashing = new Promise<void>((resolve) => {
      releaseHashes = resolve;
    });
    const hashPassword = (value: string) => async (password: string) => {
      assert.equal(password, "correct horse battery");
      hashArrivals += 1;
      if (hashArrivals === 2) {
        releaseHashes?.();
      }
      await bothHashing;
      return value;
    };
    const first = new AdminAuthService(database, {
      randomBytes: () => Buffer.alloc(32, 0x31),
      hashPassword: hashPassword("first-test-hash"),
    });
    const second = new AdminAuthService(database, {
      randomBytes: () => Buffer.alloc(32, 0x32),
      hashPassword: hashPassword("second-test-hash"),
    });

    const results = await Promise.allSettled([
      first.bootstrap({
        operatorId: "ops_first",
        displayName: "First",
        password: "correct horse battery",
        ip: "192.0.2.10",
      }),
      second.bootstrap({
        operatorId: "ops_second",
        displayName: "Second",
        password: "correct horse battery",
        ip: "192.0.2.11",
      }),
    ]);
    assert.equal(hashArrivals, 2);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected);
    assert.equal(rejected.reason instanceof GameManageKitError, true);
    assert.equal(
      (rejected.reason as GameManageKitError).code,
      "ADMIN_ALREADY_INITIALIZED",
    );

    const [state] = await database.pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM admin_operators) AS operator_count,
         (SELECT COUNT(*) FROM admin_sessions) AS session_count,
         (SELECT COUNT(*) FROM admin_auth_audit
           WHERE event = 'operator_created'
             AND reason = 'web_bootstrap') AS audit_count,
         l.initialized, l.initialized_by
       FROM admin_bootstrap_latch AS l
       WHERE l.latch_id = 1`,
    );
    assert.deepEqual({
      operatorCount: Number(state[0]?.operator_count),
      sessionCount: Number(state[0]?.session_count),
      auditCount: Number(state[0]?.audit_count),
      initialized: Number(state[0]?.initialized),
      initializedBy: String(state[0]?.initialized_by),
    }, {
      operatorCount: 1,
      sessionCount: 1,
      auditCount: 1,
      initialized: 1,
      initializedBy:
        results[0]?.status === "fulfilled" ? "ops_first" : "ops_second",
    });

    await database.pool.query("DELETE FROM admin_operators");
    assert.equal(await first.bootstrapRequired(), false);
    const hashCallsBeforeRetry = hashArrivals;
    await assert.rejects(
      first.bootstrap({
        operatorId: "ops_reopened",
        displayName: "Reopened",
        password: "correct horse battery",
        ip: "192.0.2.12",
      }),
      (error) => (
        error instanceof GameManageKitError
        && error.statusCode === 409
        && error.code === "ADMIN_ALREADY_INITIALIZED"
      ),
    );
    assert.equal(hashArrivals, hashCallsBeforeRetry);
  } finally {
    await database?.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
