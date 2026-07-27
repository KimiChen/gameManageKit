import { pathToFileURL } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "./config.js";
import { Database } from "./infra/mysql/database.js";
import { hashAdminPassword } from "./infra/security/admin-password.js";

const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const MAX_PASSWORD_INPUT_BYTES = 1_026;

export interface AdminCreateOptions {
  readonly operatorId: string;
  readonly displayName: string;
  readonly gameIds: readonly string[];
  readonly canOperateAccounts: boolean;
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
  if (
    gameIds.length === 0
    || new Set(gameIds).size !== gameIds.length
    || gameIds.some((gameId) => !GAME_ID_PATTERN.test(gameId))
  ) {
    throw new Error("games 必须是无重复的合法 gameId 逗号列表");
  }
  return Object.freeze({
    operatorId: normalizedOperatorId,
    displayName: normalizedDisplayName,
    gameIds: Object.freeze(gameIds),
    canOperateAccounts,
  });
}

async function readHiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_PASSWORD_INPUT_BYTES) {
        throw new Error("管理员密码输入超过允许长度");
      }
    }
    return input.replace(/\r?\n$/u, "");
  }

  process.stderr.write("管理员密码（输入不会显示）: ");
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let password = "";
    let finished = false;
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (finished) {
          return;
        }
        if (character === "\u0003") {
          finished = true;
          cleanup();
          reject(new Error("已取消"));
        } else if (character === "\r" || character === "\n") {
          finished = true;
          cleanup();
          resolve(password);
        } else if (character === "\u007f" || character === "\b") {
          password = [...password].slice(0, -1).join("");
        } else if (character === "\u001b") {
          finished = true;
          cleanup();
          reject(new Error("密码输入不支持终端控制序列"));
        } else {
          password += character;
          if (Buffer.byteLength(password, "utf8") > 1_024) {
            finished = true;
            cleanup();
            reject(new Error("管理员密码输入超过允许长度"));
          }
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function createAdminOperator(
  database: Database,
  options: AdminCreateOptions,
  password: string,
): Promise<void> {
  const passwordHash = await hashAdminPassword(password);
  await database.transaction(async (connection) => {
    const [games] = await connection.query<RowDataPacket[]>(
      "SELECT game_id FROM games WHERE game_id IN (?) FOR SHARE",
      [[...options.gameIds]],
    );
    const known = new Set(games.map((row) => String(row.game_id)));
    const missing = options.gameIds.filter((gameId) => !known.has(gameId));
    if (missing.length > 0) {
      throw new Error(`未知 gameId: ${missing.join(",")}`);
    }
    await connection.execute(
      `INSERT INTO admin_operators
         (operator_id, display_name, password_hash, status, auth_version)
       VALUES (?, ?, ?, 'enabled', 1)`,
      [options.operatorId, options.displayName, passwordHash],
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
  const password = await readHiddenPassword();
  const config = loadConfig();
  const database = new Database(config.mysqlUrl, Math.min(config.mysqlPoolSize, 2));
  try {
    await createAdminOperator(database, options, password);
    process.stdout.write(
      `管理员 ${options.operatorId} 已创建，可访问 ${options.gameIds.join(",")}。\n`,
    );
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
