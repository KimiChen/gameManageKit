import type { GameManageKitErrorCode } from "@gono/game-manage-kit-contract";
export type { GameManageKitErrorCode } from "@gono/game-manage-kit-contract";

export class GameManageKitError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: GameManageKitErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "GameManageKitError";
  }
}

export class OperationConflictError extends GameManageKitError {
  constructor() {
    super(409, "OPERATION_CONFLICT", "同一 operationId 已用于其他账号或动作");
    this.name = "OperationConflictError";
  }
}
