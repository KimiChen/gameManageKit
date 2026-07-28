import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "./config.js";
import { Database } from "./infra/mysql/database.js";
import { hashAdminPassword } from "./infra/security/admin-password.js";

const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const GENERATED_PASSWORD_BYTES = 12;
const GENERATED_PASSWORD_LENGTH = 16;

export interface AdminCreateOptions {
  readonly operatorId: string;
  readonly displayName: string;
  readonly gameIds: readonly string[];
  readonly canOperateAccounts: boolean;
  readonly canManageGames?: boolean;
  readonly canManageIntegrations?: boolean;
  readonly canRotateSecrets?: boolean;
  readonly canManageMachineIdentities?: boolean;
}

function optionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} 缺少值`);
  }
  return value;
}

export function parseAdminCreateArgs(args: readonly string[]): AdminCreateOptions {
  let operatorId: string | null = null;
  let displayName: string | null = null;
  let gameList: string | null = null;
  let canOperateAccounts = true;
  let canManageGames = false;
  let canManageIntegrations = false;
  let canRotateSecrets = false;
  let canManageMachineIdentities = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--operator-id") {
      operatorId = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--display-name") {
      displayName = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--games") {
      gameList = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--read-only") {
      canOperateAccounts = false;
    } else if (argument === "--manage-games") {
      canManageGames = true;
    } else if (argument === "--manage-integrations") {
      canManageIntegrations = true;
    } else if (argument === "--rotate-secrets") {
      canRotateSecrets = true;
    } else if (argument === "--manage-machine-identities") {
      canManageMachineIdentities = true;
    } else if (argument === "--full-config") {
      canManageGames = true;
      canManageIntegrations = true;
      canRotateSecrets = true;
      canManageMachineIdentities = true;
    } else {
      throw new Error(`不支持的参数 ${argument ?? ""}`);
    }
  }

  const normalizedOperatorId = operatorId?.trim() ?? "";
  if (!OPERATOR_ID_PATTERN.test(normalizedOperatorId)) {
    throw new Error("operatorId 必须匹配 ^[a-z][a-z0-9_.-]{2,63}$");
  }
  const normalizedDisplayName = (displayName ?? normalizedOperatorId).trim();
  if (
    normalizedDisplayName.length === 0
    || [...normalizedDisplayName].length > 128
  ) {
    throw new Error("displayName 必须是 1..128 个字符");
  }
  const gameIds = (gameList ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const hasGlobalConfigurationCapability = canManageGames
    || canManageIntegrations
    || canRotateSecrets
    || canManageMachineIdentities;
  if (
    (gameIds.length === 0 && !hasGlobalConfigurationCapability)
    || new Set(gameIds).size !== gameIds.length
    || gameIds.some((gameId) => !GAME_ID_PATTERN.test(gameId))
  ) {
    throw new Error(
      "games 必须是无重复的合法 gameId 逗号列表；"
      + "全局配置管理员可配合权限参数省略",
    );
  }
  return Object.freeze({
    operatorId: normalizedOperatorId,
    displayName: normalizedDisplayName,
    gameIds: Object.freeze(gameIds),
    canOperateAccounts,
    canManageGames,
    canManageIntegrations,
    canRotateSecrets,
    canManageMachineIdentities,
  });
}

export function generateAdminPassword(
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): string {
  const entropy = randomBytes(GENERATED_PASSWORD_BYTES);
  if (
    !Buffer.isBuffer(entropy)
    || entropy.length !== GENERATED_PASSWORD_BYTES
  ) {
    throw new TypeError("管理员密码随机源必须返回 12 字节 Buffer");
  }
  const password = entropy.toString("base64url");
  if (
    password.length !== GENERATED_PASSWORD_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(password)
  ) {
    throw new Error("管理员密码生成失败");
  }
  return password;
}

export async function createAdminOperator(
  database: Database,
  options: AdminCreateOptions,
  password: string,
): Promise<void> {
  const passwordHash = await hashAdminPassword(password);
  await database.transaction(async (connection) => {
    if (options.gameIds.length > 0) {
      const [games] = await connection.query<RowDataPacket[]>(
        "SELECT game_id FROM games WHERE game_id IN (?) FOR SHARE",
        [[...options.gameIds]],
      );
      const known = new Set(games.map((row) => String(row.game_id)));
      const missing = options.gameIds.filter((gameId) => !known.has(gameId));
      if (missing.length > 0) {
        throw new Error(`未知 gameId: ${missing.join(",")}`);
      }
    }
    await connection.execute(
      `INSERT INTO admin_operators
         (operator_id, display_name, password_hash, status, auth_version,
          can_manage_games, can_manage_integrations, can_rotate_secrets,
          can_manage_machine_identities)
       VALUES (?, ?, ?, 'enabled', 1, ?, ?, ?, ?)`,
      [
        options.operatorId,
        options.displayName,
        passwordHash,
        options.canManageGames ? 1 : 0,
        options.canManageIntegrations ? 1 : 0,
        options.canRotateSecrets ? 1 : 0,
        options.canManageMachineIdentities ? 1 : 0,
      ],
    );
    for (const gameId of options.gameIds) {
      await connection.execute(
        `INSERT INTO admin_game_access
           (operator_id, game_id, can_operate_accounts)
         VALUES (?, ?, ?)`,
        [options.operatorId, gameId, options.canOperateAccounts ? 1 : 0],
      );
    }
    await connection.execute(
      `INSERT INTO admin_auth_audit
         (operator_id, event, reason)
       VALUES (?, 'operator_created', 'cli')`,
      [options.operatorId],
    );
  });
}

async function main(): Promise<void> {
  const options = parseAdminCreateArgs(process.argv.slice(2));
  const password = generateAdminPassword();
  const config = loadConfig();
  const database = new Database(config.mysqlUrl, Math.min(config.mysqlPoolSize, 2));
  try {
    await createAdminOperator(database, options, password);
    process.stdout.write(
      `管理员 ${options.operatorId} 已创建，`
      + (
        options.gameIds.length > 0
          ? `可访问 ${options.gameIds.join(",")}。`
          : "未分配账号管理游戏。"
      )
      + "\n",
    );
    process.stdout.write(`初始密码（仅显示一次）: ${password}\n`);
  } finally {
    await database.close();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
