import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

export class Database {
  readonly pool: Pool;

  constructor(mysqlUrl: string, connectionLimit: number) {
    this.pool = mysql.createPool({
      uri: mysqlUrl,
      connectionLimit,
      supportBigNumbers: true,
      bigNumberStrings: false,
      flags: ["-FOUND_ROWS"],
    });
  }

  async transaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      // Login identity races need a fresh view after a duplicate-key winner
      // commits. Keep every service transaction on one explicit isolation
      // policy instead of depending on the MySQL server default (usually RR).
      await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await connection.beginTransaction();
      try {
        const result = await fn(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  async ready(
    expectedSchemaVersion: number,
    expectedGameIds: readonly string[] = [],
  ): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    if (Number(rows[0]?.version ?? 0) !== expectedSchemaVersion) {
      return false;
    }
    if (expectedGameIds.length === 0) {
      return true;
    }
    const [games] = await this.pool.query<RowDataPacket[]>(
      "SELECT game_id FROM games WHERE game_id IN (?)",
      [[...expectedGameIds]],
    );
    return new Set(games.map((row) => String(row.game_id))).size === expectedGameIds.length;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type { Pool, PoolConnection, RowDataPacket };
