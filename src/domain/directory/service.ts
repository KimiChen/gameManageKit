import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AreaListResponse,
  AreaServer,
} from "@gono/game-manage-kit-contract";
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

function assertUrl(raw: unknown, expected: "http" | "ws", production: boolean): string {
  if (typeof raw !== "string") {
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

function asAreaServer(value: unknown, production: boolean): AreaServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("目录 servers 项必须是对象");
  }
  const item = value as Record<string, unknown>;
  const serverId = item.serverId;
  const name = item.name;
  const openTime = item.openTime;
  if (!Number.isInteger(serverId) || Number(serverId) < 0 || Number(serverId) > 65_535) {
    throw new Error("目录 serverId 必须是 0..65535 整数");
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    throw new Error("目录 name 长度必须是 1..64");
  }
  if (typeof item.tag !== "string" || !TAGS.has(item.tag)) {
    throw new Error(`目录 tag 非法: ${String(item.tag)}`);
  }
  if (typeof item.status !== "string" || !STATUSES.has(item.status)) {
    throw new Error(`目录 status 非法: ${String(item.status)}`);
  }
  if (!Number.isInteger(openTime) || Number(openTime) < 0) {
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
  const servers = input.servers.map((item) => asAreaServer(item, production));
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
