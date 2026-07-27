import type { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";
import { normalizeIp } from "../../infra/security/security.js";

type AuditExecutor = Pick<Pool | PoolConnection, "execute">;

export interface AuditInput {
  readonly operationId?: string | null;
  readonly userId: string | null;
  readonly event: string;
  readonly operator?: string | null;
  readonly caller?: string | null;
  readonly targetExists?: boolean | null;
  readonly reason?: string | null;
  readonly ip?: string | null;
  readonly deviceId?: string | null;
}

function clamp(value: string | null | undefined, maximum: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length <= maximum) {
    return value;
  }
  const cut = value.slice(0, maximum);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export async function insertAudit(executor: AuditExecutor, input: AuditInput): Promise<void> {
  await executor.execute<ResultSetHeader>(
    `INSERT INTO login_audit
       (operation_id, user_id, event, \`operator\`, caller, target_exists, reason, ip, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?)`,
    [
      clamp(input.operationId, 64),
      input.userId,
      clamp(input.event, 24),
      clamp(input.operator, 64),
      clamp(input.caller, 64),
      input.targetExists === undefined || input.targetExists === null
        ? null
        : Number(input.targetExists),
      clamp(input.reason, 255),
      normalizeIp(input.ip),
      clamp(input.deviceId, 64),
    ],
  );
}
