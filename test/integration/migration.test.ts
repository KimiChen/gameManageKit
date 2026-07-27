import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";

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

test("0001 migration 建立多游戏复合约束并隔离相同领域标识", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName = `game_manage_kit_migration_${process.pid}_${Date.now()}`;
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("测试数据库名非法");
  }

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
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

    const connection = await mysql.createConnection(mysqlUrl);
    try {
      const [versions] = await connection.query<RowDataPacket[]>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        versions.map((row) => [Number(row.version), String(row.name)]),
        [[1, "0001_initial.sql"]],
      );

      const [tables] = await connection.query<RowDataPacket[]>("SHOW TABLES");
      assert.equal(tables.length, 7);

      const [accountColumns] = await connection.query<RowDataPacket[]>(
        "SHOW COLUMNS FROM accounts",
      );
      assert.equal(
        accountColumns.some((column) => String(column.Field) === "session_key"),
        false,
      );

      const [indexRows] = await connection.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns_list
           FROM information_schema.statistics
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN
              ('games', 'accounts', 'account_sessions', 'char_registry', 'login_audit', 'seq')
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
        ["char_registry.PRIMARY", "game_id,user_id,server_id"],
        ["char_registry.idx_user_time", "game_id,user_id,created_at"],
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
          "fk_account_sessions_account:account_sessions(game_id,user_id)"
            + "->accounts(game_id,user_id)",
          "fk_char_registry_account:char_registry(game_id,user_id)"
            + "->accounts(game_id,user_id)",
          "fk_login_audit_game:login_audit(game_id)->games(game_id)",
          "fk_seq_game:seq(game_id)->games(game_id)",
        ]),
      );

      await connection.query(
        `INSERT INTO games (game_id, status)
         VALUES ('game-a', 'enabled'), ('game-b', 'maintenance')`,
      );
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
          `INSERT INTO games (game_id, status)
           VALUES ('INVALID_GAME', 'enabled')`,
        ),
        hasMysqlErrno(3819),
      );
    } finally {
      await connection.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
