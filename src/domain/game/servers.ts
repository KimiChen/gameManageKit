import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import { GAME_ID_PATTERN } from "./registry.js";

export type GameServerTag = "normal" | "new" | "full" | "maintenance";
export type GameServerStatus = "smooth" | "busy" | "maintenance";

export interface ManagedGameServer {
  readonly gameId: string;
  readonly serverId: number;
  readonly name: string;
  readonly tag: GameServerTag;
  readonly status: GameServerStatus;
  readonly openTime: number;
  readonly gameHttpUrl: string;
  readonly gameWsUrl: string;
  readonly isOpen: boolean;
  readonly sortOrder: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateGameServerInput {
  readonly serverId: number;
  readonly name: string;
  readonly tag: GameServerTag;
  readonly status: GameServerStatus;
  readonly openTime: number;
  readonly gameHttpUrl: string;
  readonly gameWsUrl: string;
  readonly isOpen: boolean;
  readonly sortOrder: number;
}

export interface UpdateGameServerInput {
  readonly name: string;
  readonly tag: GameServerTag;
  readonly status: GameServerStatus;
  readonly openTime: number;
  readonly gameHttpUrl: string;
  readonly gameWsUrl: string;
  readonly isOpen: boolean;
  readonly sortOrder: number;
  readonly revision: number;
}

export interface GameServerAuthorization {
  readonly operatorId: string;
  readonly ip: string | null;
  authorize(connection: PoolConnection): Promise<void>;
}

export interface GameServerDatabase {
  readonly pool: Pool;
  transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T>;
}

interface GameServerRow extends RowDataPacket {
  readonly game_id: string;
  readonly server_id: number | string;
  readonly name: string;
  readonly tag: string;
  readonly status: string;
  readonly open_time: number | string;
  readonly game_http_url: string;
  readonly game_ws_url: string;
  readonly is_open: number | boolean | string;
  readonly sort_order: number | string;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const TAGS = new Set<GameServerTag>([
  "normal",
  "new",
  "full",
  "maintenance",
]);
const STATUSES = new Set<GameServerStatus>([
  "smooth",
  "busy",
  "maintenance",
]);
const MAXIMUM_SMALLINT = 65_535;

function invalidPayload(): never {
  throw new GameManageKitError(400, "INVALID_PAYLOAD");
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

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

function normalizedName(value: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (
    !isWellFormed(name)
    || [...name].length < 1
    || [...name].length > 64
  ) {
    return invalidPayload();
  }
  return name;
}

function normalizedSmallint(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAXIMUM_SMALLINT
  ) {
    return invalidPayload();
  }
  return value;
}

function normalizedNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return invalidPayload();
  }
  return value;
}

function normalizedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidPayload();
  }
  return value;
}

function normalizedUrl(
  raw: string,
  expected: "http" | "ws",
  production: boolean,
): string {
  if (
    typeof raw !== "string"
    || raw !== raw.trim()
    || !isWellFormed(raw)
    || [...raw].length < 1
    || [...raw].length > 2_048
    || /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    return invalidPayload();
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidPayload();
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return invalidPayload();
  }
  const secureProtocol = expected === "http" ? "https:" : "wss:";
  if (parsed.protocol === secureProtocol) {
    return raw;
  }
  const developmentProtocol = expected === "http" ? "http:" : "ws:";
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  if (
    !production
    && loopback
    && parsed.protocol === developmentProtocol
  ) {
    return raw;
  }
  return invalidPayload();
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("游戏区服时间数据无效");
  }
  return date.toISOString();
}

function serverFromRow(row: GameServerRow): ManagedGameServer {
  const tag = String(row.tag);
  const status = String(row.status);
  const serverId = Number(row.server_id);
  const openTime = Number(row.open_time);
  const sortOrder = Number(row.sort_order);
  const revision = Number(row.revision);
  const isOpen = Number(row.is_open);
  if (
    !TAGS.has(tag as GameServerTag)
    || !STATUSES.has(status as GameServerStatus)
    || !Number.isSafeInteger(serverId)
    || serverId < 0
    || serverId > MAXIMUM_SMALLINT
    || !Number.isSafeInteger(openTime)
    || openTime < 0
    || !Number.isSafeInteger(sortOrder)
    || sortOrder < 0
    || sortOrder > MAXIMUM_SMALLINT
    || !Number.isSafeInteger(revision)
    || revision < 1
    || (isOpen !== 0 && isOpen !== 1)
  ) {
    throw new Error("游戏区服数据无效");
  }
  return Object.freeze({
    gameId: String(row.game_id),
    serverId,
    name: String(row.name),
    tag: tag as GameServerTag,
    status: status as GameServerStatus,
    openTime,
    gameHttpUrl: String(row.game_http_url),
    gameWsUrl: String(row.game_ws_url),
    isOpen: isOpen === 1,
    sortOrder,
    revision,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  });
}

function auditSnapshot(server: ManagedGameServer): string {
  return JSON.stringify({
    gameId: server.gameId,
    serverId: server.serverId,
    name: server.name,
    tag: server.tag,
    status: server.status,
    openTime: server.openTime,
    gameHttpUrl: server.gameHttpUrl,
    gameWsUrl: server.gameWsUrl,
    isOpen: server.isOpen,
    sortOrder: server.sortOrder,
    revision: server.revision,
  });
}

const SELECT_SERVER = `
  SELECT game_id, server_id, name, tag, status, open_time,
         game_http_url, game_ws_url, is_open, sort_order, revision,
         created_at, updated_at
    FROM game_servers`;

export class GameServerService {
  constructor(
    private readonly database: GameServerDatabase,
    private readonly production: boolean,
  ) {}

  async list(
    gameId: string,
    authorization: GameServerAuthorization,
  ): Promise<readonly ManagedGameServer[]> {
    this.validateGameId(gameId);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, false);
      const [rows] = await connection.query<GameServerRow[]>(
        `${SELECT_SERVER}
          WHERE game_id = ?
          ORDER BY sort_order, server_id`,
        [gameId],
      );
      return Object.freeze(rows.map(serverFromRow));
    });
  }

  async create(
    gameId: string,
    input: CreateGameServerInput,
    authorization: GameServerAuthorization,
  ): Promise<ManagedGameServer> {
    this.validateGameId(gameId);
    const normalized = this.normalizeCreate(input);
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection);
        await this.requireGame(connection, gameId, true);
        await connection.execute(
          `INSERT IGNORE INTO game_directory_settings (game_id, is_ops)
           VALUES (?, 0)`,
          [gameId],
        );
        await connection.execute(
          `INSERT INTO game_servers
             (game_id, server_id, name, tag, status, open_time,
              game_http_url, game_ws_url, is_open, sort_order, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            gameId,
            normalized.serverId,
            normalized.name,
            normalized.tag,
            normalized.status,
            normalized.openTime,
            normalized.gameHttpUrl,
            normalized.gameWsUrl,
            normalized.isOpen ? 1 : 0,
            normalized.sortOrder,
          ],
        );
        const server = await this.findLocked(
          connection,
          gameId,
          normalized.serverId,
        );
        if (!server) {
          throw new Error("新建区服后无法读取");
        }
        await this.insertAudit(
          connection,
          authorization,
          "server_create",
          null,
          server,
        );
        return server;
      });
    } catch (error) {
      if (isDuplicate(error)) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
      throw error;
    }
  }

  async update(
    gameId: string,
    serverId: number,
    input: UpdateGameServerInput,
    authorization: GameServerAuthorization,
  ): Promise<ManagedGameServer> {
    this.validateGameId(gameId);
    const normalizedServerId = normalizedSmallint(serverId);
    const normalized = this.normalizeUpdate(input);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, true);
      const current = await this.findLocked(
        connection,
        gameId,
        normalizedServerId,
      );
      if (!current) {
        throw new GameManageKitError(404, "SERVER_NOT_FOUND");
      }
      if (current.revision !== normalized.revision) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
      await connection.execute(
        `UPDATE game_servers
            SET name = ?,
                tag = ?,
                status = ?,
                open_time = ?,
                game_http_url = ?,
                game_ws_url = ?,
                is_open = ?,
                sort_order = ?,
                revision = revision + 1
          WHERE game_id = ? AND server_id = ? AND revision = ?`,
        [
          normalized.name,
          normalized.tag,
          normalized.status,
          normalized.openTime,
          normalized.gameHttpUrl,
          normalized.gameWsUrl,
          normalized.isOpen ? 1 : 0,
          normalized.sortOrder,
          gameId,
          normalizedServerId,
          normalized.revision,
        ],
      );
      const server = await this.findLocked(
        connection,
        gameId,
        normalizedServerId,
      );
      if (!server || server.revision !== normalized.revision + 1) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
      await this.insertAudit(
        connection,
        authorization,
        "server_update",
        current,
        server,
      );
      return server;
    });
  }

  private validateGameId(gameId: string): void {
    if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) {
      invalidPayload();
    }
  }

  private normalizeCreate(
    input: CreateGameServerInput,
  ): CreateGameServerInput {
    if (
      !input
      || typeof input !== "object"
      || !TAGS.has(input.tag)
      || !STATUSES.has(input.status)
      || typeof input.isOpen !== "boolean"
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      serverId: normalizedSmallint(input.serverId),
      name: normalizedName(input.name),
      tag: input.tag,
      status: input.status,
      openTime: normalizedNonNegativeInteger(input.openTime),
      gameHttpUrl: normalizedUrl(
        input.gameHttpUrl,
        "http",
        this.production,
      ),
      gameWsUrl: normalizedUrl(
        input.gameWsUrl,
        "ws",
        this.production,
      ),
      isOpen: input.isOpen,
      sortOrder: normalizedSmallint(input.sortOrder),
    });
  }

  private normalizeUpdate(
    input: UpdateGameServerInput,
  ): UpdateGameServerInput {
    if (
      !input
      || typeof input !== "object"
      || !TAGS.has(input.tag)
      || !STATUSES.has(input.status)
      || typeof input.isOpen !== "boolean"
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      name: normalizedName(input.name),
      tag: input.tag,
      status: input.status,
      openTime: normalizedNonNegativeInteger(input.openTime),
      gameHttpUrl: normalizedUrl(
        input.gameHttpUrl,
        "http",
        this.production,
      ),
      gameWsUrl: normalizedUrl(
        input.gameWsUrl,
        "ws",
        this.production,
      ),
      isOpen: input.isOpen,
      sortOrder: normalizedSmallint(input.sortOrder),
      revision: normalizedRevision(input.revision),
    });
  }

  private async requireGame(
    connection: PoolConnection,
    gameId: string,
    lock: boolean,
  ): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT game_id
         FROM games
        WHERE game_id = ?
        LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [gameId],
    );
    if (!rows[0]) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
  }

  private async findLocked(
    connection: PoolConnection,
    gameId: string,
    serverId: number,
  ): Promise<ManagedGameServer | null> {
    const [rows] = await connection.query<GameServerRow[]>(
      `${SELECT_SERVER}
        WHERE game_id = ? AND server_id = ?
        FOR UPDATE`,
      [gameId, serverId],
    );
    return rows[0] ? serverFromRow(rows[0]) : null;
  }

  private async insertAudit(
    connection: PoolConnection,
    authorization: GameServerAuthorization,
    action: "server_create" | "server_update",
    before: ManagedGameServer | null,
    after: ManagedGameServer,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO admin_game_audit
         (game_id, operator_id, action, before_data, after_data, ip)
       VALUES (?, ?, ?, ?, ?, INET6_ATON(?))`,
      [
        after.gameId,
        authorization.operatorId,
        action,
        before ? auditSnapshot(before) : null,
        auditSnapshot(after),
        normalizeIp(authorization.ip),
      ],
    );
  }
}
