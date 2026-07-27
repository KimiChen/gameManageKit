import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

test("迁移建立多游戏、目录和区服约束并隔离相同领域标识", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName = `game_manage_kit_migration_${process.pid}_${Date.now()}`;
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("测试数据库名非法");
  }

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  const initialMigrationDirectory = await mkdtemp(
    join(tmpdir(), "game-manage-kit-migration-"),
  );
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    const migrateEnv = {
      ...process.env,
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
    };
    await writeFile(
      join(initialMigrationDirectory, "0001_initial.sql"),
      await readFile("migrations/0001_initial.sql", "utf8"),
      "utf8",
    );
    await runMigrations(mysqlUrl, initialMigrationDirectory);
    const beforeUpgrade = await mysql.createConnection(mysqlUrl);
    try {
      await beforeUpgrade.query(
        `INSERT INTO admin_operators
           (operator_id, display_name, password_hash)
         VALUES ('ops_before_upgrade', '升级前管理员', 'test-only-hash')`,
      );
    } finally {
      await beforeUpgrade.end();
    }
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
        ],
      );
      const [preservedOperators] = await connection.query<RowDataPacket[]>(
        `SELECT operator_id
           FROM admin_operators
          WHERE operator_id = 'ops_before_upgrade'`,
      );
      assert.equal(preservedOperators.length, 1);

      const [tables] = await connection.query<RowDataPacket[]>("SHOW TABLES");
      assert.equal(tables.length, 14);

      const [accountColumns] = await connection.query<RowDataPacket[]>(
        "SHOW COLUMNS FROM accounts",
      );
      assert.equal(
        accountColumns.some((column) => String(column.Field) === "session_key"),
        false,
      );
      const [schemaColumns] = await connection.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                COLUMN_TYPE AS column_type, COLLATION_NAME AS collation_name,
                IS_NULLABLE AS is_nullable
           FROM information_schema.columns
          WHERE TABLE_SCHEMA = DATABASE()
            AND (
              (TABLE_NAME = 'games'
                AND COLUMN_NAME IN (
                  'name', 'description', 'status', 'configuration_state',
                  'client_visible', 'sort_order', 'revision'
                ))
              OR
              (TABLE_NAME = 'game_directory_settings'
                AND COLUMN_NAME IN ('game_id', 'is_ops'))
              OR
              (TABLE_NAME = 'game_servers'
                AND COLUMN_NAME IN (
                  'game_id', 'server_id', 'name', 'tag', 'status', 'open_time',
                  'game_http_url', 'game_ws_url', 'is_open', 'sort_order',
                  'revision'
                ))
              OR
              (TABLE_NAME = 'admin_operators'
                AND COLUMN_NAME IN (
                  'operator_id', 'password_hash', 'auth_version', 'can_manage_games'
                ))
              OR
              (TABLE_NAME = 'admin_game_audit'
                AND COLUMN_NAME IN ('action', 'before_data', 'after_data'))
              OR
              (TABLE_NAME = 'admin_sessions'
                AND COLUMN_NAME IN ('token_hash', 'operator_id', 'expires_at'))
            )`,
      );
      assert.deepEqual(
        new Map(schemaColumns.map((column) => [
          `${String(column.table_name)}.${String(column.column_name)}`,
          {
            type: String(column.column_type),
            collation: column.collation_name === null
              ? null
              : String(column.collation_name),
            nullable: String(column.is_nullable),
          },
        ])),
        new Map([
          ["admin_game_audit.action", {
            type: "enum('create','update','server_create','server_update')",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["admin_game_audit.after_data", {
            type: "json",
            collation: null,
            nullable: "NO",
          }],
          ["admin_game_audit.before_data", {
            type: "json",
            collation: null,
            nullable: "YES",
          }],
          ["admin_operators.auth_version", {
            type: "bigint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["admin_operators.can_manage_games", {
            type: "tinyint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["admin_operators.operator_id", {
            type: "varchar(64)",
            collation: "ascii_bin",
            nullable: "NO",
          }],
          ["admin_operators.password_hash", {
            type: "varchar(255)",
            collation: "ascii_bin",
            nullable: "NO",
          }],
          ["admin_sessions.expires_at", {
            type: "datetime(3)",
            collation: null,
            nullable: "NO",
          }],
          ["admin_sessions.operator_id", {
            type: "varchar(64)",
            collation: "ascii_bin",
            nullable: "NO",
          }],
          ["admin_sessions.token_hash", {
            type: "binary(32)",
            collation: null,
            nullable: "NO",
          }],
          ["games.client_visible", {
            type: "tinyint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["games.configuration_state", {
            type: "enum('draft','configured')",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["games.description", {
            type: "varchar(500)",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["games.name", {
            type: "varchar(128)",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["games.revision", {
            type: "bigint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["games.sort_order", {
            type: "smallint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["games.status", {
            type: "enum('enabled','maintenance','disabled')",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["game_directory_settings.game_id", {
            type: "varchar(32)",
            collation: "ascii_bin",
            nullable: "NO",
          }],
          ["game_directory_settings.is_ops", {
            type: "tinyint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.game_http_url", {
            type: "varchar(2048)",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["game_servers.game_id", {
            type: "varchar(32)",
            collation: "ascii_bin",
            nullable: "NO",
          }],
          ["game_servers.game_ws_url", {
            type: "varchar(2048)",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["game_servers.is_open", {
            type: "tinyint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.name", {
            type: "varchar(64)",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["game_servers.open_time", {
            type: "bigint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.revision", {
            type: "bigint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.server_id", {
            type: "smallint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.sort_order", {
            type: "smallint unsigned",
            collation: null,
            nullable: "NO",
          }],
          ["game_servers.status", {
            type: "enum('smooth','busy','maintenance')",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
          ["game_servers.tag", {
            type: "enum('normal','new','full','maintenance')",
            collation: "utf8mb4_0900_ai_ci",
            nullable: "NO",
          }],
        ]),
      );

      const [indexRows] = await connection.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns_list
           FROM information_schema.statistics
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN
              ('games', 'game_directory_settings', 'game_servers',
               'admin_operators', 'admin_game_access', 'admin_sessions',
               'admin_auth_audit', 'admin_game_audit', 'accounts',
               'account_sessions', 'char_registry', 'login_audit', 'seq')
          GROUP BY TABLE_NAME, INDEX_NAME`,
      );
      const indexes = new Map(
        indexRows.map((row) => [
          `${String(row.table_name)}.${String(row.index_name)}`,
          String(row.columns_list),
        ]),
      );
      assert.deepEqual(indexes, new Map([
        ["account_sessions.PRIMARY", "game_id,user_id,server_id"],
        ["accounts.PRIMARY", "game_id,user_id"],
        ["accounts.uk_openid", "game_id,openid"],
        ["accounts.uk_unionid", "game_id,unionid"],
        ["admin_auth_audit.PRIMARY", "id"],
        ["admin_auth_audit.idx_admin_auth_event_time", "event,created_at"],
        ["admin_auth_audit.idx_admin_auth_operator_time", "operator_id,created_at"],
        ["admin_game_access.PRIMARY", "operator_id,game_id"],
        ["admin_game_access.idx_admin_game_access_game", "game_id,operator_id"],
        ["admin_game_audit.PRIMARY", "id"],
        ["admin_game_audit.idx_admin_game_audit_game_time", "game_id,created_at"],
        [
          "admin_game_audit.idx_admin_game_audit_operator_time",
          "operator_id,created_at",
        ],
        ["admin_operators.PRIMARY", "operator_id"],
        ["admin_sessions.PRIMARY", "token_hash"],
        ["admin_sessions.idx_admin_sessions_expires", "expires_at"],
        ["admin_sessions.idx_admin_sessions_idle", "last_seen_at"],
        ["admin_sessions.idx_admin_sessions_operator", "operator_id,expires_at"],
        ["char_registry.PRIMARY", "game_id,user_id,server_id"],
        ["char_registry.idx_user_time", "game_id,user_id,created_at"],
        ["game_directory_settings.PRIMARY", "game_id"],
        ["game_servers.PRIMARY", "game_id,server_id"],
        [
          "game_servers.idx_game_servers_open_order",
          "game_id,is_open,sort_order,server_id",
        ],
        ["games.PRIMARY", "game_id"],
        ["login_audit.PRIMARY", "id,game_id"],
        ["login_audit.idx_user_time", "game_id,user_id,created_at"],
        ["login_audit.uk_operation", "game_id,operation_id"],
        ["seq.PRIMARY", "game_id,name"],
      ]));

      const [foreignKeyRows] = await connection.query<RowDataPacket[]>(
        `SELECT CONSTRAINT_NAME AS constraint_name, TABLE_NAME AS table_name,
                REFERENCED_TABLE_NAME AS referenced_table_name,
                GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ',') AS columns_list,
                GROUP_CONCAT(
                  REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ','
                ) AS referenced_columns_list
           FROM information_schema.key_column_usage
          WHERE TABLE_SCHEMA = DATABASE()
            AND REFERENCED_TABLE_NAME IS NOT NULL
          GROUP BY CONSTRAINT_NAME, TABLE_NAME, REFERENCED_TABLE_NAME`,
      );
      assert.deepEqual(
        new Set(foreignKeyRows.map((row) => (
          `${String(row.constraint_name)}:${String(row.table_name)}`
          + `(${String(row.columns_list)})->${String(row.referenced_table_name)}`
          + `(${String(row.referenced_columns_list)})`
        ))),
        new Set([
          "fk_accounts_game:accounts(game_id)->games(game_id)",
          "fk_admin_game_access_game:admin_game_access(game_id)->games(game_id)",
          "fk_admin_game_access_operator:admin_game_access(operator_id)"
            + "->admin_operators(operator_id)",
          "fk_admin_game_audit_game:admin_game_audit(game_id)->games(game_id)",
          "fk_admin_game_audit_operator:admin_game_audit(operator_id)"
            + "->admin_operators(operator_id)",
          "fk_admin_sessions_operator:admin_sessions(operator_id)"
            + "->admin_operators(operator_id)",
          "fk_account_sessions_account:account_sessions(game_id,user_id)"
            + "->accounts(game_id,user_id)",
          "fk_char_registry_account:char_registry(game_id,user_id)"
            + "->accounts(game_id,user_id)",
          "fk_game_directory_settings_game:game_directory_settings(game_id)"
            + "->games(game_id)",
          "fk_game_servers_directory:game_servers(game_id)"
            + "->game_directory_settings(game_id)",
          "fk_login_audit_game:login_audit(game_id)->games(game_id)",
          "fk_seq_game:seq(game_id)->games(game_id)",
        ]),
      );

      await connection.query(
        `INSERT INTO games
           (game_id, name, status, configuration_state, client_visible, sort_order)
         VALUES
           ('game-a', '游戏 A', 'enabled', 'configured', 1, 10),
           ('game-b', '游戏 B', 'maintenance', 'configured', 1, 20)`,
      );
      await connection.query(
        `INSERT INTO games (game_id, name)
         VALUES ('draft-game', '待接入游戏')`,
      );
      await connection.query(
        `INSERT INTO admin_operators
           (operator_id, display_name, password_hash, can_manage_games)
         VALUES ('ops_kimi', 'Kimi', 'test-only-hash', 1)`,
      );
      const [defaultRows] = await connection.query<RowDataPacket[]>(
        `SELECT description, status, configuration_state, client_visible,
                sort_order, revision
           FROM games
          WHERE game_id = 'draft-game'`,
      );
      assert.deepEqual({
        description: String(defaultRows[0]?.description),
        status: String(defaultRows[0]?.status),
        configurationState: String(defaultRows[0]?.configuration_state),
        clientVisible: Number(defaultRows[0]?.client_visible),
        sortOrder: Number(defaultRows[0]?.sort_order),
        revision: Number(defaultRows[0]?.revision),
      }, {
        description: "",
        status: "maintenance",
        configurationState: "draft",
        clientVisible: 0,
        sortOrder: 0,
        revision: 1,
      });
      const [operatorCapabilityRows] = await connection.query<RowDataPacket[]>(
        `SELECT can_manage_games
           FROM admin_operators
          WHERE operator_id = 'ops_kimi'`,
      );
      assert.equal(Number(operatorCapabilityRows[0]?.can_manage_games), 1);
      await connection.query(
        `INSERT INTO game_directory_settings (game_id, is_ops)
         VALUES ('game-a', 0), ('game-b', 1)`,
      );
      await connection.query(
        `INSERT INTO game_servers
           (game_id, server_id, name, tag, status, open_time,
            game_http_url, game_ws_url, is_open, sort_order)
         VALUES
           ('game-a', 1, 'A 一区', 'new', 'smooth', 1700000000,
            'https://game-a.example.invalid', 'wss://game-a.example.invalid',
            1, 10),
           ('game-b', 1, 'B 一区', 'normal', 'maintenance', 1700000001,
            'https://game-b.example.invalid', 'wss://game-b.example.invalid',
            0, 20)`,
      );
      const [serverRows] = await connection.query<RowDataPacket[]>(
        `SELECT game_id, server_id, is_open, sort_order, revision
           FROM game_servers
          ORDER BY game_id, server_id`,
      );
      assert.deepEqual(serverRows.map((row) => ({
        gameId: String(row.game_id),
        serverId: Number(row.server_id),
        isOpen: Number(row.is_open),
        sortOrder: Number(row.sort_order),
        revision: Number(row.revision),
      })), [
        {
          gameId: "game-a",
          serverId: 1,
          isOpen: 1,
          sortOrder: 10,
          revision: 1,
        },
        {
          gameId: "game-b",
          serverId: 1,
          isOpen: 0,
          sortOrder: 20,
          revision: 1,
        },
      ]);
      await connection.query(
        `INSERT INTO admin_game_access
           (operator_id, game_id, can_operate_accounts)
         VALUES
           ('ops_kimi', 'game-a', 1),
           ('ops_kimi', 'game-b', 0)`,
      );
      await connection.query(
        `INSERT INTO admin_sessions
           (token_hash, operator_id, auth_version, created_at, last_seen_at, expires_at)
         VALUES
           (UNHEX(SHA2('test-token', 256)), 'ops_kimi', 1, NOW(3), NOW(3),
            DATE_ADD(NOW(3), INTERVAL 8 HOUR))`,
      );
      await connection.query(
        `INSERT INTO admin_auth_audit (operator_id, event, reason)
         VALUES ('ops_kimi', 'login_success', 'password')`,
      );
      await connection.query(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, action, before_data, after_data, ip)
         VALUES (
           'game-a',
           'ops_kimi',
           'update',
           JSON_OBJECT('name', '旧游戏名'),
           JSON_OBJECT('name', '游戏 A'),
           INET6_ATON('127.0.0.1')
         )`,
      );
      await connection.query(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, action, before_data, after_data)
         VALUES (
           'game-a',
           'ops_kimi',
           'server_update',
           JSON_OBJECT('name', '旧一区'),
           JSON_OBJECT('name', 'A 一区')
         )`,
      );
      const [gameAuditRows] = await connection.query<RowDataPacket[]>(
        `SELECT action,
                JSON_UNQUOTE(JSON_EXTRACT(before_data, '$.name')) AS before_name,
                JSON_UNQUOTE(JSON_EXTRACT(after_data, '$.name')) AS after_name,
                INET6_NTOA(ip) AS ip
           FROM admin_game_audit
          ORDER BY id`,
      );
      assert.deepEqual(gameAuditRows.map((row) => ({
        action: String(row.action),
        beforeName: String(row.before_name),
        afterName: String(row.after_name),
        ip: String(row.ip),
      })), [
        {
          action: "update",
          beforeName: "旧游戏名",
          afterName: "游戏 A",
          ip: "127.0.0.1",
        },
        {
          action: "server_update",
          beforeName: "旧一区",
          afterName: "A 一区",
          ip: "null",
        },
      ]);
      await connection.query(
        `INSERT INTO seq (game_id, name, val)
         VALUES ('game-a', 'user_id', 1), ('game-b', 'user_id', 1)`,
      );
      await connection.query(
        `INSERT INTO accounts (game_id, user_id, openid, unionid)
         VALUES
           ('game-a', 'u_1', 'shared-openid', 'shared-unionid'),
           ('game-b', 'u_1', 'shared-openid', 'shared-unionid')`,
      );
      await connection.query(
        `INSERT INTO account_sessions
           (game_id, user_id, server_id, token_hash, token_issued_at)
         VALUES
           ('game-a', 'u_1', 1, REPEAT('a', 64), NOW(3)),
           ('game-b', 'u_1', 1, REPEAT('b', 64), NOW(3))`,
      );
      await connection.query(
        `INSERT INTO char_registry (game_id, user_id, server_id)
         VALUES ('game-a', 'u_1', 1), ('game-b', 'u_1', 1)`,
      );
      await connection.query(
        `INSERT INTO login_audit (game_id, operation_id, user_id, event)
         VALUES
           ('game-a', 'shared-operation', 'u_1', 'ban'),
           ('game-b', 'shared-operation', 'u_1', 'ban')`,
      );

      for (const table of [
        "accounts",
        "account_sessions",
        "char_registry",
        "login_audit",
        "seq",
      ]) {
        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT game_id, COUNT(*) AS row_count
             FROM \`${table}\`
            GROUP BY game_id
            ORDER BY game_id`,
        );
        assert.deepEqual(
          rows.map((row) => [String(row.game_id), Number(row.row_count)]),
          [["game-a", 1], ["game-b", 1]],
          `${table} 未按 game_id 隔离相同领域标识`,
        );
      }

      await assert.rejects(
        connection.query(
          `INSERT INTO accounts (game_id, user_id, openid)
           VALUES ('game-a', 'u_2', 'shared-openid')`,
        ),
        hasMysqlErrno(1062),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO login_audit (game_id, operation_id, user_id, event)
           VALUES ('game-a', 'shared-operation', 'u_1', 'revoke')`,
        ),
        hasMysqlErrno(1062),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO accounts (game_id, user_id, openid)
           VALUES ('missing-game', 'u_1', 'orphan-openid')`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO account_sessions
             (game_id, user_id, server_id, token_hash, token_issued_at)
           VALUES ('game-a', 'u_404', 1, REPEAT('c', 64), NOW(3))`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO char_registry (game_id, user_id, server_id)
           VALUES ('game-a', 'u_404', 1)`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO login_audit (game_id, operation_id, event)
           VALUES ('missing-game', 'orphan-operation', 'ban')`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO seq (game_id, name, val)
           VALUES ('missing-game', 'user_id', 0)`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games (game_id, name)
           VALUES ('INVALID_GAME', 'Invalid')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games (game_id, name)
           VALUES ('empty-name', '')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games (game_id, name, status, configuration_state)
           VALUES ('draft-enabled', 'Draft Enabled', 'enabled', 'draft')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games
             (game_id, name, status, configuration_state, client_visible)
           VALUES ('invalid-visible', 'Invalid Visible', 'maintenance', 'configured', 2)`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games
             (game_id, name, status, configuration_state, client_visible)
           VALUES ('draft-visible', 'Draft Visible', 'maintenance', 'draft', 1)`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games
             (game_id, name, status, configuration_state, client_visible)
           VALUES ('disabled-visible', 'Disabled Visible', 'disabled', 'configured', 1)`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO games (game_id, name, revision)
           VALUES ('invalid-revision', 'Invalid Revision', 0)`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `UPDATE game_directory_settings
              SET is_ops = 2
            WHERE game_id = 'game-a'`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO game_servers
             (game_id, server_id, name, tag, status, open_time,
              game_http_url, game_ws_url)
           VALUES
             ('missing-game', 1, '孤儿区服', 'normal', 'smooth', 0,
              'https://game.example.invalid', 'wss://game.example.invalid')`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO game_servers
             (game_id, server_id, name, tag, status, open_time,
              game_http_url, game_ws_url)
           VALUES
             ('game-a', 2, '', 'normal', 'smooth', 0,
              'https://game.example.invalid', 'wss://game.example.invalid')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO game_servers
             (game_id, server_id, name, tag, status, open_time,
              game_http_url, game_ws_url)
           VALUES
             ('game-a', 2, '超大时间区服', 'normal', 'smooth',
              9007199254740992,
              'https://game.example.invalid', 'wss://game.example.invalid')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `UPDATE game_servers
              SET is_open = 2
            WHERE game_id = 'game-a' AND server_id = 1`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO admin_operators
             (operator_id, display_name, password_hash)
           VALUES ('INVALID OPERATOR', 'Invalid', 'test-only-hash')`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `UPDATE admin_operators
              SET can_manage_games = 2
            WHERE operator_id = 'ops_kimi'`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO admin_game_access
             (operator_id, game_id, can_operate_accounts)
           VALUES ('ops_kimi', 'game-a', 2)`,
        ),
        hasMysqlErrno(3819),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO admin_game_audit
             (game_id, operator_id, action, after_data)
           VALUES ('missing-game', 'ops_kimi', 'create', JSON_OBJECT())`,
        ),
        hasMysqlErrno(1452),
      );
      await assert.rejects(
        connection.query(
          `INSERT INTO admin_sessions
             (token_hash, operator_id, auth_version,
              created_at, last_seen_at, expires_at)
           VALUES (
             UNHEX(SHA2('invalid-session-time', 256)),
             'ops_kimi',
             1,
             NOW(3),
             DATE_SUB(NOW(3), INTERVAL 1 SECOND),
             DATE_ADD(NOW(3), INTERVAL 1 HOUR)
           )`,
        ),
        hasMysqlErrno(3819),
      );

      const readinessProbe = new Database(mysqlUrl, 1);
      try {
        assert.equal(await readinessProbe.ready(2), true);
        await connection.query("DROP TABLE admin_auth_audit");
        assert.equal(await readinessProbe.ready(2), false);
      } finally {
        await readinessProbe.close();
      }
    } finally {
      await connection.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
    await rm(initialMigrationDirectory, { recursive: true, force: true });
  }
});
