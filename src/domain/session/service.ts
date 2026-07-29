import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { TOKEN_BYTES } from "../../config.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import { GAME_ID_PATTERN } from "../game/resolver.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const USER_ID_PATTERN = /^u_[0-9]+$/;
const RANDOM_TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export interface ParsedAccessToken {
  readonly gameId: string;
  readonly userId: string;
  readonly accessToken: string;
}

export function parseAccessToken(accessToken: string): ParsedAccessToken | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [gameId, userId, randomToken] = parts;
  if (
    !gameId
    || !GAME_ID_PATTERN.test(gameId)
    || !userId
    || userId.length > 32
    || !USER_ID_PATTERN.test(userId)
    || !randomToken
    || !RANDOM_TOKEN_PATTERN.test(randomToken)
  ) {
    return null;
  }
  return { gameId, userId, accessToken };
}

export type VerifySessionResult =
  | {
      valid: true;
      userId: string;
      issuedAtMs: number;
      expiresAtMs: number;
    }
  | {
      valid: false;
      reason: "NOT_FOUND" | "MISMATCH" | "BANNED" | "DEREGISTERED" | "EXPIRED";
    };

interface VerifyRow extends RowDataPacket {
  token_hash: string | null;
  status: number;
  issued_ms: number | null;
  now_ms: number;
}

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async issue(
    connection: PoolConnection,
    gameId: string,
    userId: string,
    serverId: number,
  ): Promise<{ accessToken: string; issuedAtMs: number }> {
    const accessToken = `${gameId}.${userId}.${randomBytes(TOKEN_BYTES).toString("hex")}`;
    await connection.execute<ResultSetHeader>(
      `INSERT INTO account_sessions (game_id, user_id, server_id, token_hash, token_issued_at)
       VALUES (?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         token_hash = VALUES(token_hash),
         token_issued_at = GREATEST(NOW(3), token_issued_at + INTERVAL 1000 MICROSECOND)`,
      [gameId, userId, serverId, sha256(accessToken)],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ROUND(UNIX_TIMESTAMP(token_issued_at) * 1000) AS issued_ms
         FROM account_sessions
        WHERE game_id = ? AND user_id = ? AND server_id = ?`,
      [gameId, userId, serverId],
    );
    const issuedAtMs = Number(rows[0]?.issued_ms ?? 0);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
      throw new Error("会话签发后无法回读 token_issued_at");
    }
    return { accessToken, issuedAtMs };
  }

  async verify(
    gameId: string,
    ttlSeconds: number,
    accessToken: string,
    serverId: number,
  ): Promise<VerifySessionResult> {
    const parsed = parseAccessToken(accessToken);
    if (!parsed || parsed.gameId !== gameId) {
      return { valid: false, reason: "MISMATCH" };
    }
    const query = () => this.pool.query<VerifyRow[]>(
      `SELECT s.token_hash, a.status,
              ROUND(UNIX_TIMESTAMP(s.token_issued_at) * 1000) AS issued_ms,
              ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS now_ms
         FROM accounts a
         LEFT JOIN account_sessions s
           ON s.game_id = a.game_id
          AND s.user_id = a.user_id
          AND s.server_id = ?
        WHERE a.game_id = ? AND a.user_id = ?`,
      [serverId, gameId, parsed.userId],
    );
    const [rows] = this.metrics
      ? await this.metrics.measureDatabase(gameId, "session_verify", query)
      : await query();
    const account = rows[0];
    if (!account) {
      return { valid: false, reason: "NOT_FOUND" };
    }
    // The uid prefix is an implementation detail owned by gameManageKit. Check
    // authoritative account state before session presence so ban/deregister
    // keeps its precise reason even after all active sessions are deleted.
    if (Number(account.status) === 1) {
      return { valid: false, reason: "BANNED" };
    }
    if (Number(account.status) !== 0) {
      return { valid: false, reason: "DEREGISTERED" };
    }
    if (
      account.token_hash === null
      || !safeEqualHex(String(account.token_hash), sha256(accessToken))
    ) {
      return { valid: false, reason: "MISMATCH" };
    }
    const issuedAtMs = Number(account.issued_ms);
    const nowMs = Number(account.now_ms);
    const expiresAtMs = issuedAtMs + ttlSeconds * 1_000;
    if (
      !Number.isSafeInteger(issuedAtMs)
      || issuedAtMs <= 0
      || !Number.isSafeInteger(nowMs)
      || nowMs <= 0
      || !Number.isSafeInteger(expiresAtMs)
    ) {
      throw new Error("会话时间数据无效");
    }
    if (nowMs > expiresAtMs) {
      return { valid: false, reason: "EXPIRED" };
    }
    return {
      valid: true,
      userId: parsed.userId,
      issuedAtMs,
      expiresAtMs,
    };
  }

  async verifyAnyZone(
    gameId: string,
    ttlSeconds: number,
    accessToken: string,
  ): Promise<string | null> {
    const parsed = parseAccessToken(accessToken);
    if (!parsed || parsed.gameId !== gameId) {
      return null;
    }
    const query = () => this.pool.query<RowDataPacket[]>(
      `SELECT s.token_hash
         FROM accounts a
         JOIN account_sessions s
           ON s.game_id = a.game_id AND s.user_id = a.user_id
        WHERE a.game_id = ? AND a.user_id = ? AND a.status = 0
          AND TIMESTAMPDIFF(SECOND, s.token_issued_at, NOW(3)) <= ?`,
      [gameId, parsed.userId, ttlSeconds],
    );
    const [rows] = this.metrics
      ? await this.metrics.measureDatabase(gameId, "session_lookup", query)
      : await query();
    const wanted = sha256(accessToken);
    return rows.some((row) => safeEqualHex(String(row.token_hash ?? ""), wanted))
      ? parsed.userId
      : null;
  }
}
