import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";

export class CharacterService {
  constructor(
    private readonly pool: Pool,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async register(gameId: string, userId: string, serverId: number): Promise<void> {
    const execute = async (): Promise<void> => {
      const [accounts] = await this.pool.query<RowDataPacket[]>(
        `SELECT 1
           FROM accounts
          WHERE game_id = ? AND user_id = ?
          LIMIT 1`,
        [gameId, userId],
      );
      if (accounts.length === 0) {
        throw new GameManageKitError(404, "NOT_FOUND");
      }
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO char_registry (game_id, user_id, server_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = user_id`,
        [gameId, userId, serverId],
      );
    };
    return this.metrics
      ? this.metrics.measureDatabase(gameId, "character_register", execute)
      : execute();
  }

  async has(gameId: string, userId: string, serverId: number): Promise<boolean> {
    const execute = async (): Promise<boolean> => {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT 1
           FROM char_registry
          WHERE game_id = ? AND user_id = ? AND server_id = ?
          LIMIT 1`,
        [gameId, userId, serverId],
      );
      return rows.length > 0;
    };
    return this.metrics
      ? this.metrics.measureDatabase(gameId, "character_lookup", execute)
      : execute();
  }

  async zones(gameId: string, userId: string): Promise<number[]> {
    const execute = async (): Promise<number[]> => {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT server_id
           FROM char_registry
          WHERE game_id = ? AND user_id = ?
          ORDER BY created_at, server_id`,
        [gameId, userId],
      );
      return rows.map((row) => Number(row.server_id));
    };
    return this.metrics
      ? this.metrics.measureDatabase(gameId, "character_zones", execute)
      : execute();
  }
}
