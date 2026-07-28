import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import { GAME_ID_PATTERN } from "./resolver.js";

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

export interface GameDirectorySettings {
  readonly gameId: string;
  readonly isOps: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedGameServerList {
  readonly directoryRevision: number;
  readonly servers: readonly ManagedGameServer[];
}

export interface ManagedGameServerMutation {
  readonly directoryRevision: number;
  readonly server: ManagedGameServer;
}

export interface UpdateGameDirectorySettingsInput {
  readonly isOps: boolean;
  readonly revision: number;
}

export interface CreateGameServerInput {
  readonly directoryRevision: number;
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
  readonly directoryRevision: number;
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

interface GameDirectorySettingsRow extends RowDataPacket {
  readonly game_id: string;
  readonly is_ops: number | boolean | string;
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

function directorySettingsFromRow(
  row: GameDirectorySettingsRow,
): GameDirectorySettings {
  const isOps = Number(row.is_ops);
  const revision = Number(row.revision);
  if (
    (isOps !== 0 && isOps !== 1)
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw new Error("游戏目录设置数据无效");
  }
  return Object.freeze({
    gameId: String(row.game_id),
    isOps: isOps === 1,
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

const SELECT_DIRECTORY_SETTINGS = `
  SELECT game_id, is_ops, revision, created_at, updated_at
    FROM game_directory_settings`;

export class GameServerService {
  constructor(
    private readonly database: GameServerDatabase,
    private readonly production: boolean,
  ) {}

  async getDirectorySettings(
    gameId: string,
    authorization: GameServerAuthorization,
  ): Promise<GameDirectorySettings> {
    this.validateGameId(gameId);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, false);
      return this.requireDirectorySettings(connection, gameId, false);
    });
  }

  async updateDirectorySettings(
    gameId: string,
    input: UpdateGameDirectorySettingsInput,
    authorization: GameServerAuthorization,
  ): Promise<GameDirectorySettings> {
    this.validateGameId(gameId);
    if (!input || typeof input.isOps !== "boolean") {
      return invalidPayload();
    }
    const revision = normalizedRevision(input.revision);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, true);
      const current = await this.requireDirectorySettings(
        connection,
        gameId,
        true,
      );
      if (current.revision !== revision) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
      await connection.execute(
        `UPDATE game_directory_settings
            SET is_ops = ?,
                revision = revision + 1
          WHERE game_id = ? AND revision = ?`,
        [input.isOps ? 1 : 0, gameId, revision],
      );
      const updated = await this.requireDirectorySettings(
        connection,
        gameId,
        true,
      );
      if (updated.revision !== revision + 1) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
      await connection.execute(
        `INSERT INTO admin_game_audit
           (game_id, operator_id, action, before_data, after_data, ip)
         VALUES (?, ?, 'directory_update', ?, ?, INET6_ATON(?))`,
        [
          gameId,
          authorization.operatorId,
          JSON.stringify(current),
          JSON.stringify(updated),
          normalizeIp(authorization.ip),
        ],
      );
      return updated;
    });
  }

  async list(
    gameId: string,
    authorization: GameServerAuthorization,
  ): Promise<ManagedGameServerList> {
    this.validateGameId(gameId);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, false);
      const settings = await this.requireDirectorySettings(
        connection,
        gameId,
        false,
      );
      const [rows] = await connection.query<GameServerRow[]>(
        `${SELECT_SERVER}
          WHERE game_id = ?
          ORDER BY sort_order, server_id`,
        [gameId],
      );
      return Object.freeze({
        directoryRevision: settings.revision,
        servers: Object.freeze(rows.map(serverFromRow)),
      });
    });
  }

  async create(
    gameId: string,
    input: CreateGameServerInput,
    authorization: GameServerAuthorization,
  ): Promise<ManagedGameServerMutation> {
    this.validateGameId(gameId);
    const normalized = this.normalizeCreate(input);
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection);
        await this.requireGame(connection, gameId, true);
        const directory = await this.requireDirectorySettings(
          connection,
          gameId,
          true,
        );
        if (directory.revision !== normalized.directoryRevision) {
          throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
        }
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
        const directoryRevision = await this.bumpDirectoryRevision(
          connection,
          gameId,
          directory.revision,
        );
        await this.insertAudit(
          connection,
          authorization,
          "server_create",
          null,
          server,
        );
        return Object.freeze({ directoryRevision, server });
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
  ): Promise<ManagedGameServerMutation> {
    this.validateGameId(gameId);
    const normalizedServerId = normalizedSmallint(serverId);
    const normalized = this.normalizeUpdate(input);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      await this.requireGame(connection, gameId, true);
      const directory = await this.requireDirectorySettings(
        connection,
        gameId,
        true,
      );
      if (directory.revision !== normalized.directoryRevision) {
        throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
      }
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
      const directoryRevision = await this.bumpDirectoryRevision(
        connection,
        gameId,
        directory.revision,
      );
      await this.insertAudit(
        connection,
        authorization,
        "server_update",
        current,
        server,
      );
      return Object.freeze({ directoryRevision, server });
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
      directoryRevision: normalizedRevision(input.directoryRevision),
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
      directoryRevision: normalizedRevision(input.directoryRevision),
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

  private async requireDirectorySettings(
    connection: PoolConnection,
    gameId: string,
    lock: boolean,
  ): Promise<GameDirectorySettings> {
    const [rows] = await connection.query<GameDirectorySettingsRow[]>(
      `${SELECT_DIRECTORY_SETTINGS}
        WHERE game_id = ?${lock ? " FOR UPDATE" : ""}`,
      [gameId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`游戏 ${gameId} 缺少目录设置`);
    }
    return directorySettingsFromRow(row);
  }

  private async bumpDirectoryRevision(
    connection: PoolConnection,
    gameId: string,
    revision: number,
  ): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE game_directory_settings
          SET revision = revision + 1
        WHERE game_id = ? AND revision = ?`,
      [gameId, revision],
    );
    if (Number(result.affectedRows) !== 1) {
      throw new GameManageKitError(409, "GAME_SERVER_CONFLICT");
    }
    return revision + 1;
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
