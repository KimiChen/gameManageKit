import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";

const here = dirname(fileURLToPath(import.meta.url));
const defaultMigrationDir = resolve(here, "..", "migrations");

export async function runMigrations(
  mysqlUrl = process.env.GAME_MANAGE_KIT_MYSQL_URL,
  migrationDir = defaultMigrationDir,
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
  try {
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
    await connection.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations();
}
