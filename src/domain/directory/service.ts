import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AreaListResponse,
  AreaServer,
} from "@gono/game-manage-kit-contract";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { SessionService } from "../session/service.js";
import type { CharacterService } from "../character/service.js";
import type { GameContext } from "../game/registry.js";

export interface AreaDirectory {
  readonly isOps: boolean;
  readonly servers: readonly AreaServer[];
  readonly hash: string;
}

export interface DirectoryProvider {
  listAreas(): Promise<AreaDirectory>;
  findServer(serverId: number): Promise<AreaServer | undefined>;
  isServerUsable(serverId: number): Promise<boolean>;
}

const TAGS = new Set(["normal", "new", "full", "maintenance"]);
const STATUSES = new Set(["smooth", "busy", "maintenance"]);

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertUrl(raw: unknown, expected: "http" | "ws", production: boolean): string {
  if (
    typeof raw !== "string"
    || raw !== raw.trim()
    || !isWellFormed(raw)
    || [...raw].length < 1
    || [...raw].length > 2_048
  ) {
    throw new Error(`目录 ${expected} URL 必须是字符串`);
  }
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("目录含非法 URL");
  }
  if (value.username || value.password || value.hash) {
    throw new Error("目录 URL 不允许包含凭证或 fragment");
  }
  const secureProtocol = expected === "http" ? "https:" : "wss:";
  const developmentProtocol = expected === "http" ? "http:" : "ws:";
  if (value.protocol === secureProtocol) {
    return raw;
  }
  const local = value.hostname === "localhost"
    || value.hostname === "127.0.0.1"
    || value.hostname === "::1"
    || value.hostname === "[::1]";
  if (!production && local && value.protocol === developmentProtocol) {
    return raw;
  }
  throw new Error(`目录 ${expected} URL 必须使用 ${secureProtocol}//；开发环境仅允许 localhost ${developmentProtocol}//`);
}

export function validateAreaServer(
  value: unknown,
  production: boolean,
): AreaServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("目录 servers 项必须是对象");
  }
  const item = value as Record<string, unknown>;
  const serverId = item.serverId;
  const name = item.name;
  const openTime = item.openTime;
  if (
    !Number.isSafeInteger(serverId)
    || Number(serverId) < 0
    || Number(serverId) > 65_535
  ) {
    throw new Error("目录 serverId 必须是 0..65535 整数");
  }
  if (
    typeof name !== "string"
    || name !== name.trim()
    || !isWellFormed(name)
    || [...name].length < 1
    || [...name].length > 64
  ) {
    throw new Error("目录 name 长度必须是 1..64");
  }
  if (typeof item.tag !== "string" || !TAGS.has(item.tag)) {
    throw new Error(`目录 tag 非法: ${String(item.tag)}`);
  }
  if (typeof item.status !== "string" || !STATUSES.has(item.status)) {
    throw new Error(`目录 status 非法: ${String(item.status)}`);
  }
  if (!Number.isSafeInteger(openTime) || Number(openTime) < 0) {
    throw new Error("目录 openTime 必须是非负整数");
  }
  return {
    serverId: Number(serverId),
    name,
    tag: item.tag as AreaServer["tag"],
    status: item.status as AreaServer["status"],
    openTime: Number(openTime),
    gameHttpUrl: assertUrl(item.gameHttpUrl, "http", production),
    gameWsUrl: assertUrl(item.gameWsUrl, "ws", production),
  };
}

export function validateAreaDirectory(value: unknown, production: boolean): AreaDirectory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("目录配置必须是对象");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.isOps !== "boolean" || !Array.isArray(input.servers)) {
    throw new Error("目录配置必须包含 boolean isOps 与 servers 数组");
  }
  const servers = input.servers.map((item) => validateAreaServer(item, production));
  const ids = new Set<number>();
  for (const server of servers) {
    if (ids.has(server.serverId)) {
      throw new Error(`目录 serverId 重复: ${server.serverId}`);
    }
    ids.add(server.serverId);
  }
  const normalized = {
    isOps: input.isOps,
    servers,
  };
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return { ...normalized, hash };
}

interface DatabaseDirectoryRow extends RowDataPacket {
  readonly is_ops: number | boolean | string;
  readonly server_id: number | string | null;
  readonly name: string | null;
  readonly tag: string | null;
  readonly status: string | null;
  readonly open_time: number | string | null;
  readonly game_http_url: string | null;
  readonly game_ws_url: string | null;
}

function databaseAreaServer(
  row: DatabaseDirectoryRow,
  production: boolean,
): AreaServer {
  return validateAreaServer({
    serverId: Number(row.server_id),
    name: row.name,
    tag: row.tag,
    status: row.status,
    openTime: Number(row.open_time),
    gameHttpUrl: row.game_http_url,
    gameWsUrl: row.game_ws_url,
  }, production);
}

export class FileDirectoryProvider implements DirectoryProvider {
  private readonly serversById: ReadonlyMap<number, AreaServer>;

  private constructor(private readonly directory: AreaDirectory) {
    this.serversById = new Map(directory.servers.map((server) => [server.serverId, server]));
  }

  static async load(path: string, production: boolean): Promise<FileDirectoryProvider> {
    const raw = await readFile(path, "utf8");
    return new FileDirectoryProvider(validateAreaDirectory(JSON.parse(raw) as unknown, production));
  }

  async listAreas(): Promise<AreaDirectory> {
    return this.directory;
  }

  async findServer(serverId: number): Promise<AreaServer | undefined> {
    const server = this.serversById.get(serverId);
    return server ? { ...server } : undefined;
  }

  async isServerUsable(serverId: number): Promise<boolean> {
    const server = this.serversById.get(serverId);
    return server !== undefined && server.status !== "maintenance";
  }
}

export class MysqlDirectoryProvider implements DirectoryProvider {
  constructor(
    private readonly pool: Pool,
    private readonly gameId: string,
    private readonly production: boolean,
  ) {}

  async listAreas(): Promise<AreaDirectory> {
    const [rows] = await this.pool.query<DatabaseDirectoryRow[]>(
      `SELECT d.is_ops, s.server_id, s.name, s.tag, s.status, s.open_time,
              s.game_http_url, s.game_ws_url
         FROM game_directory_settings d
         LEFT JOIN game_servers s
           ON s.game_id = d.game_id AND s.is_open = 1
        WHERE d.game_id = ?
        ORDER BY s.sort_order, s.server_id`,
      [this.gameId],
    );
    const first = rows[0];
    if (!first) {
      throw new Error(`游戏 ${this.gameId} 缺少目录设置`);
    }
    const isOpsValue = Number(first.is_ops);
    if (isOpsValue !== 0 && isOpsValue !== 1) {
      throw new Error(`游戏 ${this.gameId} 目录设置无效`);
    }
    const servers = rows.flatMap((row) => (
      row.server_id === null
        ? []
        : [databaseAreaServer(row, this.production)]
    ));
    return validateAreaDirectory({
      isOps: isOpsValue === 1,
      servers,
    }, this.production);
  }

  async findServer(serverId: number): Promise<AreaServer | undefined> {
    const [rows] = await this.pool.query<DatabaseDirectoryRow[]>(
      `SELECT d.is_ops, s.server_id, s.name, s.tag, s.status, s.open_time,
              s.game_http_url, s.game_ws_url
         FROM game_servers s
         JOIN game_directory_settings d ON d.game_id = s.game_id
        WHERE s.game_id = ? AND s.server_id = ?
        LIMIT 1`,
      [this.gameId, serverId],
    );
    return rows[0]
      ? databaseAreaServer(rows[0], this.production)
      : undefined;
  }

  async isServerUsable(serverId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT 1
         FROM game_servers
        WHERE game_id = ?
          AND server_id = ?
          AND is_open = 1
          AND status <> 'maintenance'
        LIMIT 1`,
      [this.gameId, serverId],
    );
    return rows.length === 1;
  }
}

export class DirectoryService {
  constructor(
    private readonly sessions: Pick<SessionService, "verifyAnyZone">,
    private readonly characters: Pick<CharacterService, "zones">,
  ) {}

  async list(game: GameContext, accessToken: string | null): Promise<AreaListResponse> {
    const directory = await game.directory.listAreas();
    let myServerIds: number[] = [];
    if (accessToken) {
      const userId = await this.sessions.verifyAnyZone(
        game.gameId,
        game.sessionTtlSeconds,
        accessToken,
      );
      if (userId) {
        const directoryServerIds = new Set(directory.servers.map((server) => server.serverId));
        myServerIds = (await this.characters.zones(game.gameId, userId))
          .filter((serverId) => directoryServerIds.has(serverId));
      }
    }
    return {
      isOps: directory.isOps,
      hash: directory.hash,
      servers: directory.servers.map((server) => ({ ...server })),
      myServerIds,
    };
  }
}
