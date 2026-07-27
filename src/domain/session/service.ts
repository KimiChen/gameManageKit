import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { SESSION_TTL_SECONDS, TOKEN_BYTES } from "../../config.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export interface ParsedAccessToken {
  readonly userId: string;
  readonly accessToken: string;
}

export function parseAccessToken(accessToken: string): ParsedAccessToken | null {
  const separator = accessToken.lastIndexOf(".");
  if (separator <= 0 || separator === accessToken.length - 1) {
    return null;
  }
  const userId = accessToken.slice(0, separator);
  if (userId.length > 32 || !/^u_[0-9]+$/.test(userId)) {
    return null;
  }
  return { userId, accessToken };
}

export type VerifySessionResult =
  | { valid: true; userId: string; issuedAtMs: number }
  | {
      valid: false;
      reason: "NOT_FOUND" | "MISMATCH" | "BANNED" | "DEREGISTERED" | "EXPIRED";
    };

interface VerifyRow extends RowDataPacket {
  token_hash: string | null;
  status: number;
  age_s: number | null;
  issued_ms: number | null;
}

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly ttlSeconds = SESSION_TTL_SECONDS,
  ) {}

  async issue(
    connection: PoolConnection,
    userId: string,
    serverId: number,
    sessionKey: string | null,
  ): Promise<{ accessToken: string; issuedAtMs: number }> {
    const accessToken = `${userId}.${randomBytes(TOKEN_BYTES).toString("hex")}`;
    await connection.execute<ResultSetHeader>(
      `INSERT INTO account_sessions (user_id, server_id, token_hash, token_issued_at)
       VALUES (?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         token_hash = VALUES(token_hash),
         token_issued_at = GREATEST(NOW(3), token_issued_at + INTERVAL 1000 MICROSECOND)`,
      [userId, serverId, sha256(accessToken)],
    );
    if (sessionKey !== null) {
      await connection.execute<ResultSetHeader>(
        "UPDATE accounts SET session_key = ? WHERE user_id = ?",
        [sessionKey, userId],
      );
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ROUND(UNIX_TIMESTAMP(token_issued_at) * 1000) AS issued_ms
         FROM account_sessions
        WHERE user_id = ? AND server_id = ?`,
      [userId, serverId],
    );
    const issuedAtMs = Number(rows[0]?.issued_ms ?? 0);
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
      throw new Error("会话签发后无法回读 token_issued_at");
    }
    return { accessToken, issuedAtMs };
  }

  async verify(accessToken: string, serverId: number): Promise<VerifySessionResult> {
    const parsed = parseAccessToken(accessToken);
    if (!parsed) {
      return { valid: false, reason: "MISMATCH" };
    }
    const [rows] = await this.pool.query<VerifyRow[]>(
      `SELECT s.token_hash, a.status,
              TIMESTAMPDIFF(SECOND, s.token_issued_at, NOW(3)) AS age_s,
              ROUND(UNIX_TIMESTAMP(s.token_issued_at) * 1000) AS issued_ms
         FROM accounts a
         LEFT JOIN account_sessions s
           ON s.user_id = a.user_id AND s.server_id = ?
        WHERE a.user_id = ?`,
      [serverId, parsed.userId],
    );
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
    if (account.age_s === null || Number(account.age_s) > this.ttlSeconds) {
      return { valid: false, reason: "EXPIRED" };
    }
    return {
      valid: true,
      userId: parsed.userId,
      issuedAtMs: Number(account.issued_ms ?? 0),
    };
  }

  async verifyAnyZone(accessToken: string): Promise<string | null> {
    const parsed = parseAccessToken(accessToken);
    if (!parsed) {
      return null;
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT s.token_hash
         FROM accounts a
         JOIN account_sessions s ON s.user_id = a.user_id
        WHERE a.user_id = ? AND a.status = 0
          AND TIMESTAMPDIFF(SECOND, s.token_issued_at, NOW(3)) <= ?`,
      [parsed.userId, this.ttlSeconds],
    );
    const wanted = sha256(accessToken);
    return rows.some((row) => safeEqualHex(String(row.token_hash ?? ""), wanted))
      ? parsed.userId
      : null;
  }
}
