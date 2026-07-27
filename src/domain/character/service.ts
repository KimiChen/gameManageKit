import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export class CharacterService {
  constructor(private readonly pool: Pool) {}

  async register(userId: string, serverId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO char_registry (user_id, server_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      [userId, serverId],
    );
  }

  async has(userId: string, serverId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1
         FROM char_registry
        WHERE user_id = ? AND server_id = ?
        LIMIT 1`,
      [userId, serverId],
    );
    return rows.length > 0;
  }

  async zones(userId: string): Promise<number[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT server_id
         FROM char_registry
        WHERE user_id = ?
        ORDER BY created_at, server_id`,
      [userId],
    );
    return rows.map((row) => Number(row.server_id));
  }
}
