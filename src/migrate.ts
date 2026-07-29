import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { safeErrorDetails } from "./infra/security/security.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationDir = resolve(here, "..", "migrations");

export async function runMigrations(
  mysqlUrl = process.env.GAME_MANAGE_KIT_MYSQL_URL,
  migrationDir = defaultMigrationDir,
  requireTls = process.env.NODE_ENV === "production",
): Promise<void> {
  if (!mysqlUrl) {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 必填；gameManageKit 禁止回退游戏库 MYSQL_URL");
  }

  const url = new URL(mysqlUrl);
  const database = url.pathname.replace(/^\/+/, "");
  if (url.protocol !== "mysql:" || !database) {
    throw new Error("GAME_MANAGE_KIT_MYSQL_URL 必须是包含独立账号数据库名的 mysql:// URL");
  }

  const connection = await mysql.createConnection({
    uri: mysqlUrl,
    multipleStatements: true,
  });
  const migrationLockName = `game-manage-kit:migrate:${
    createHash("sha256").update(database).digest("hex").slice(0, 32)
  }`;
  let migrationLockAcquired = false;
  try {
    if (requireTls) {
      const [tls] = await connection.query<RowDataPacket[]>(
        "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
      );
      if (
        typeof tls[0]?.Value !== "string"
        || tls[0].Value.length === 0
      ) {
        throw new Error("生产 MySQL TLS 未协商成功");
      }
    }
    const [lockRows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [migrationLockName],
    );
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw new Error("无法取得数据库 migration 排他锁");
    }
    migrationLockAcquired = true;
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INT UNSIGNED NOT NULL,
        name       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const files = (await readdir(migrationDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const name of files) {
      const version = Number(name.slice(0, 4));
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT name FROM schema_migrations WHERE version = ?",
        [version],
      );
      if (rows.length > 0) {
        if (String(rows[0]?.name) !== name) {
          throw new Error(`migration ${version} 名称冲突: ${String(rows[0]?.name)} != ${name}`);
        }
        continue;
      }

      const sql = await readFile(resolve(migrationDir, name), "utf8");
      await connection.query(sql);
      await connection.execute(
        "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
        [version, name],
      );
      console.log(`[migrate] applied ${name}`);
    }
  } finally {
    if (migrationLockAcquired) {
      await connection.query(
        "SELECT RELEASE_LOCK(?)",
        [migrationLockName],
      ).catch(() => undefined);
    }
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations().catch((error: unknown) => {
    console.error("[migrate] failed", safeErrorDetails(error));
    process.exitCode = 1;
  });
}
