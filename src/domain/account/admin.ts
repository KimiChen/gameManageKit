import type { AdminAccountResponse } from "@gono/game-manage-kit-contract";
import type { RowDataPacket } from "mysql2/promise";
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
}

interface OperationRow extends RowDataPacket {
  user_id: string | null;
  event: string;
  target_exists: number | null;
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

  async execute(input: AdminOperationInput): Promise<AdminAccountResponse> {
    const execute = async (): Promise<AdminAccountResponse> => {
      try {
        return await this.database.transaction(async (connection) => {
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
        const replay = await this.findOperation(input.gameId, input.operationId);
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
    gameId: string,
    operationId: string,
  ): Promise<OperationRow | undefined> {
    const [rows] = await this.database.pool.query<OperationRow[]>(
      `SELECT user_id, event, target_exists
         FROM login_audit
        WHERE game_id = ? AND operation_id = ?`,
      [gameId, operationId],
    );
    return rows[0];
  }

  private replay(input: AdminOperationInput, row: OperationRow): AdminAccountResponse {
    if (row.user_id !== input.userId || row.event !== input.action) {
      throw new OperationConflictError();
    }
    return statusFor(input.action, Number(row.target_exists) === 1);
  }
}
