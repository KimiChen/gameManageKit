import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

const REQUIRED_SCHEMA_TABLES = Object.freeze([
  "games",
  "game_directory_settings",
  "game_servers",
  "game_integrations",
  "machine_identities",
  "machine_identity_games",
  "machine_secret_versions",
  "admin_bootstrap_latch",
  "admin_operators",
  "admin_game_access",
  "admin_game_audit",
  "admin_machine_identity_audit",
  "admin_secret_operations",
  "admin_secret_audit",
  "admin_sessions",
  "admin_auth_audit",
  "accounts",
  "account_identities",
  "schema_v5_identity_migration_state",
  "account_sessions",
  "char_registry",
  "game_identity_providers",
  "login_audit",
  "seq",
]);

export class Database {
  readonly pool: Pool;

  constructor(
    mysqlUrl: string,
    connectionLimit: number,
    private readonly requireTls = false,
  ) {
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

  async ready(expectedSchemaVersion: number): Promise<boolean> {
    if (!await this.secureTransportReady()) {
      return false;
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    if (Number(rows[0]?.version ?? 0) !== expectedSchemaVersion) {
      return false;
    }
    const [tables] = await this.pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (?)`,
      [[...REQUIRED_SCHEMA_TABLES]],
    );
    if (
      new Set(tables.map((row) => String(row.table_name))).size
      !== REQUIRED_SCHEMA_TABLES.length
    ) {
      return false;
    }
    return true;
  }

  async secureTransportReady(): Promise<boolean> {
    if (!this.requireTls) {
      return true;
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
    );
    return typeof rows[0]?.Value === "string"
      && rows[0].Value.length > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type { Pool, PoolConnection, RowDataPacket };
