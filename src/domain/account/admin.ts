import type {
  AdminAccountDetailResponse,
  AdminAccountResponse,
} from "@gono/game-manage-kit-contract";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { OperationConflictError } from "../../errors.js";
import { Database } from "../../infra/mysql/database.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import { insertAudit } from "./audit.js";

export type AdminAction = "ban" | "revoke";

export interface AdminOperationInput {
  readonly gameId: string;
  readonly action: AdminAction;
  readonly userId: string;
  readonly operationId: string;
  readonly operatorId: string;
  readonly caller: string;
  readonly reason: string;
  readonly ip: string | null;
  readonly authorize?: (connection: PoolConnection) => Promise<void>;
}

export interface AdminAccountQueryInput {
  readonly gameId: string;
  readonly userId: string;
  readonly sessionTtlSeconds: number;
  readonly operatorId: string;
  readonly caller: string;
  readonly ip: string | null;
  readonly authorize?: (connection: PoolConnection) => Promise<void>;
}

export interface AdminAccountDeniedInput {
  readonly gameId: string;
  readonly userId: string;
  readonly operatorId: string;
  readonly caller: string;
  readonly ip: string | null;
  readonly reason: "game_access_denied" | "account_capability_denied";
}

interface OperationRow extends RowDataPacket {
  user_id: string | null;
  event: string;
  target_exists: number | null;
}

interface AccountDetailRow extends RowDataPacket {
  readonly status: number;
  readonly last_login_at: Date | null;
  readonly active_session_count: number | string;
}

function statusFor(action: AdminAction, accountExists: boolean): AdminAccountResponse {
  return {
    accountExists,
    status: accountExists ? (action === "ban" ? "banned" : "revoked") : "not_found",
  };
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

export class AdminAccountService {
  constructor(
    private readonly database: Database,
    private readonly metrics?: MetricsRegistry,
  ) {}

  async auditDenied(input: AdminAccountDeniedInput): Promise<void> {
    await insertAudit(this.database.pool, {
      gameId: input.gameId,
      userId: input.userId,
      event: "admin_denied",
      operator: input.operatorId,
      caller: input.caller,
      reason: input.reason,
      ip: input.ip,
    });
  }

  async find(
    input: AdminAccountQueryInput,
  ): Promise<AdminAccountDetailResponse | null> {
    const query = async (): Promise<AdminAccountDetailResponse | null> => {
      return this.database.transaction(async (connection) => {
        await input.authorize?.(connection);
        const [rows] = await connection.query<AccountDetailRow[]>(
          `SELECT a.status, a.last_login_at,
                  COUNT(s.user_id) AS active_session_count
             FROM accounts a
             LEFT JOIN account_sessions s
              ON s.game_id = a.game_id
              AND s.user_id = a.user_id
              AND TIMESTAMPDIFF(SECOND, s.token_issued_at, NOW(3)) <= ?
            WHERE a.game_id = ? AND a.user_id = ?
            GROUP BY a.game_id, a.user_id, a.status, a.last_login_at`,
          [input.sessionTtlSeconds, input.gameId, input.userId],
        );
        const row = rows[0];
        await insertAudit(connection, {
          gameId: input.gameId,
          userId: input.userId,
          event: "account_query",
          operator: input.operatorId,
          caller: input.caller,
          targetExists: row !== undefined,
          ip: input.ip,
        });
        if (!row) {
          return null;
        }
        const status = Number(row.status);
        if (status !== 0 && status !== 1 && status !== 2) {
          throw new Error("数据库包含未知账号状态");
        }
        return {
          userId: input.userId,
          status: status === 0
            ? "active"
            : status === 1
              ? "banned"
              : "deregistered",
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
          activeSessionCount: Number(row.active_session_count),
        };
      });
    };
    return this.metrics
      ? this.metrics.measureDatabase(input.gameId, "admin", query)
      : query();
  }

  async execute(input: AdminOperationInput): Promise<AdminAccountResponse> {
    const execute = async (): Promise<AdminAccountResponse> => {
      try {
        return await this.database.transaction(async (connection) => {
          await input.authorize?.(connection);
          const [operations] = await connection.query<OperationRow[]>(
            `SELECT user_id, event, target_exists
               FROM login_audit
              WHERE game_id = ? AND operation_id = ?`,
            [input.gameId, input.operationId],
          );
          const replay = operations[0];
          if (replay) {
            return this.replay(input, replay);
          }

          const [accounts] = await connection.query<RowDataPacket[]>(
            "SELECT status FROM accounts WHERE game_id = ? AND user_id = ? FOR UPDATE",
            [input.gameId, input.userId],
          );
          const accountExists = accounts.length > 0;
          if (accountExists) {
            if (input.action === "ban") {
              await connection.execute(
                "UPDATE accounts SET status = 1 WHERE game_id = ? AND user_id = ?",
                [input.gameId, input.userId],
              );
            }
            await connection.execute(
              "DELETE FROM account_sessions WHERE game_id = ? AND user_id = ?",
              [input.gameId, input.userId],
            );
          }
          await insertAudit(connection, {
            gameId: input.gameId,
            operationId: input.operationId,
            userId: input.userId,
            event: input.action,
            operator: input.operatorId,
            caller: input.caller,
            targetExists: accountExists,
            reason: input.reason,
            ip: input.ip,
          });
          return statusFor(input.action, accountExists);
        });
      } catch (error) {
        if (!isDuplicate(error)) {
          throw error;
        }
        const replay = await this.findOperation(input);
        if (!replay) {
          throw error;
        }
        return this.replay(input, replay);
      }
    };
    return this.metrics
      ? this.metrics.measureDatabase(input.gameId, "admin", execute)
      : execute();
  }

  private async findOperation(
    input: AdminOperationInput,
  ): Promise<OperationRow | undefined> {
    return this.database.transaction(async (connection) => {
      await input.authorize?.(connection);
      const [rows] = await connection.query<OperationRow[]>(
        `SELECT user_id, event, target_exists
           FROM login_audit
          WHERE game_id = ? AND operation_id = ?`,
        [input.gameId, input.operationId],
      );
      return rows[0];
    });
  }

  private replay(input: AdminOperationInput, row: OperationRow): AdminAccountResponse {
    if (row.user_id !== input.userId || row.event !== input.action) {
      throw new OperationConflictError();
    }
    return statusFor(input.action, Number(row.target_exists) === 1);
  }
}
