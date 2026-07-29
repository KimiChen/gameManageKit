import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import type {
  GameContext,
  GameRuntimeRegistry,
  GameStatus,
} from "./resolver.js";
import { GAME_ID_PATTERN } from "./resolver.js";

export type GameConfigurationState = "draft" | "configured";

export interface GameProject {
  readonly gameId: string;
  readonly name: string;
  readonly description: string;
  readonly status: GameStatus;
  readonly configurationState: GameConfigurationState;
  readonly clientVisible: boolean;
  readonly sortOrder: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClientGame {
  readonly gameId: string;
  readonly name: string;
  readonly description: string;
  readonly status: Exclude<GameStatus, "disabled">;
}

export interface CreateGameProjectInput {
  readonly gameId: string;
  readonly name: string;
  readonly description: string;
}

export interface UpdateGameProjectInput {
  readonly name: string;
  readonly description: string;
  readonly status: GameStatus;
  readonly clientVisible: boolean;
  readonly sortOrder: number;
  readonly revision: number;
}

export interface GameProjectAuthorization {
  readonly operatorId: string;
  readonly ip: string | null;
  authorize(connection: PoolConnection): Promise<void>;
}

export interface GameProjectDatabase {
  readonly pool: Pool;
  transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T>;
}

interface GameProjectRow extends RowDataPacket {
  readonly game_id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly configuration_state: string;
  readonly client_visible: number | boolean | string;
  readonly sort_order: number | string;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const GAME_STATUSES = new Set<GameStatus>([
  "enabled",
  "maintenance",
  "disabled",
]);
const CONFIGURATION_STATES = new Set<GameConfigurationState>([
  "draft",
  "configured",
]);
const MAXIMUM_SORT_ORDER = 65_535;

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

function unicodeLength(value: string): number {
  return [...value].length;
}

function normalizedName(value: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!isWellFormed(name) || unicodeLength(name) < 1 || unicodeLength(name) > 128) {
    throw new GameManageKitError(400, "INVALID_PAYLOAD");
  }
  return name;
}

function normalizedDescription(value: string): string {
  const description = typeof value === "string" ? value.trim() : "";
  if (!isWellFormed(description) || unicodeLength(description) > 500) {
    throw new GameManageKitError(400, "INVALID_PAYLOAD");
  }
  return description;
}

function normalizedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GameManageKitError(400, "INVALID_PAYLOAD");
  }
  return value;
}

function normalizedSortOrder(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAXIMUM_SORT_ORDER
  ) {
    throw new GameManageKitError(400, "INVALID_PAYLOAD");
  }
  return value;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("游戏项目时间数据无效");
  }
  return date.toISOString();
}

function projectFromRow(row: GameProjectRow): GameProject {
  const status = String(row.status);
  const configurationState = String(row.configuration_state);
  const revision = Number(row.revision);
  const sortOrder = Number(row.sort_order);
  if (
    !GAME_STATUSES.has(status as GameStatus)
    || !CONFIGURATION_STATES.has(
      configurationState as GameConfigurationState,
    )
    || !Number.isSafeInteger(revision)
    || revision < 1
    || !Number.isSafeInteger(sortOrder)
    || sortOrder < 0
    || sortOrder > MAXIMUM_SORT_ORDER
  ) {
    throw new Error("游戏项目数据无效");
  }
  return Object.freeze({
    gameId: String(row.game_id),
    name: String(row.name),
    description: String(row.description),
    status: status as GameStatus,
    configurationState: configurationState as GameConfigurationState,
    clientVisible: Number(row.client_visible) === 1,
    sortOrder,
    revision,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  });
}

function auditSnapshot(project: GameProject): string {
  return JSON.stringify({
    gameId: project.gameId,
    name: project.name,
    description: project.description,
    status: project.status,
    configurationState: project.configurationState,
    clientVisible: project.clientVisible,
    sortOrder: project.sortOrder,
    revision: project.revision,
  });
}

const SELECT_PROJECT = `
  SELECT game_id, name, description, status, configuration_state,
         client_visible, sort_order, revision, created_at, updated_at
    FROM games`;

export class GameProjectService {
  constructor(
    private readonly database: GameProjectDatabase,
    private readonly registry: GameRuntimeRegistry,
  ) {}

  async list(
    authorization: GameProjectAuthorization,
  ): Promise<readonly GameProject[]> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      const [rows] = await connection.query<GameProjectRow[]>(
        `${SELECT_PROJECT}
          ORDER BY sort_order, game_id`,
      );
      return Object.freeze(rows.map(projectFromRow));
    });
  }

  async listForClient(): Promise<readonly ClientGame[]> {
    const [rows] = await this.database.pool.query<GameProjectRow[]>(
      `${SELECT_PROJECT}
        WHERE configuration_state = 'configured'
          AND client_visible = 1
          AND status IN ('enabled', 'maintenance')
        ORDER BY sort_order, game_id`,
    );
    return Object.freeze(rows.flatMap((row) => {
      const project = projectFromRow(row);
      if (project.status === "disabled") {
        return [];
      }
      return [Object.freeze({
        gameId: project.gameId,
        name: project.name,
        description: project.description,
        status: project.status,
      })];
    }));
  }

  async create(
    input: CreateGameProjectInput,
    authorization: GameProjectAuthorization,
  ): Promise<GameProject> {
    if (!GAME_ID_PATTERN.test(input.gameId)) {
      throw new GameManageKitError(400, "INVALID_PAYLOAD");
    }
    const name = normalizedName(input.name);
    const description = normalizedDescription(input.description);
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection);
        await connection.execute(
          `INSERT INTO games
             (game_id, name, description, status, configuration_state,
              client_visible, sort_order, revision)
           VALUES (?, ?, ?, 'maintenance', 'draft', 0, 0, 1)`,
          [input.gameId, name, description],
        );
        await connection.execute(
          `INSERT INTO game_directory_settings
             (game_id, is_ops, revision)
           VALUES (?, 0, 1)`,
          [input.gameId],
        );
        await connection.execute(
          "INSERT INTO game_integrations (game_id) VALUES (?)",
          [input.gameId],
        );
        await connection.execute(
          `INSERT INTO game_identity_providers
             (game_id, provider, enabled, app_id, app_secret,
              secret_version, endpoint, timeout_ms, breaker_threshold,
              breaker_open_ms, validation_state, updated_by)
           VALUES
             (?, 'wechat', 0, NULL, NULL, 0,
              'https://api.weixin.qq.com/sns/jscode2session',
              3000, 5, 10000, 'unvalidated', ?),
             (?, 'douyin', 0, NULL, NULL, 0,
              'https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session',
              3000, 5, 10000, 'unvalidated', ?)`,
          [
            input.gameId,
            authorization.operatorId,
            input.gameId,
            authorization.operatorId,
          ],
        );
        await connection.execute(
          `INSERT INTO seq (game_id, name, val)
           VALUES (?, 'user_id', 0)`,
          [input.gameId],
        );
        const project = await this.findLocked(connection, input.gameId);
        if (!project) {
          throw new Error("新建游戏项目后无法读取");
        }
        await this.insertAudit(
          connection,
          authorization,
          "create",
          null,
          project,
        );
        return project;
      });
    } catch (error) {
      if (isDuplicate(error)) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      throw error;
    }
  }

  async update(
    gameId: string,
    input: UpdateGameProjectInput,
    authorization: GameProjectAuthorization,
  ): Promise<GameProject> {
    if (!GAME_ID_PATTERN.test(gameId)) {
      throw new GameManageKitError(400, "INVALID_PAYLOAD");
    }
    const name = normalizedName(input.name);
    const description = normalizedDescription(input.description);
    const revision = normalizedRevision(input.revision);
    const sortOrder = normalizedSortOrder(input.sortOrder);
    if (
      !GAME_STATUSES.has(input.status)
      || typeof input.clientVisible !== "boolean"
    ) {
      throw new GameManageKitError(400, "INVALID_PAYLOAD");
    }

    const updated = await this.database.transaction(async (connection) => {
      await authorization.authorize(connection);
      const current = await this.findLocked(connection, gameId);
      if (!current) {
        throw new GameManageKitError(404, "GAME_NOT_FOUND");
      }
      if (current.revision !== revision) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      if (
        (current.status === "disabled" && input.status !== "disabled")
        || (
          current.configurationState === "draft"
          && input.status === "enabled"
        )
        || (
          input.clientVisible
          && (
            current.configurationState !== "configured"
            || input.status === "disabled"
          )
        )
      ) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      await connection.execute(
        `UPDATE games
            SET name = ?,
                description = ?,
                status = ?,
                client_visible = ?,
                sort_order = ?,
                revision = revision + 1
          WHERE game_id = ? AND revision = ?`,
        [
          name,
          description,
          input.status,
          input.clientVisible ? 1 : 0,
          sortOrder,
          gameId,
          revision,
        ],
      );
      const project = await this.findLocked(connection, gameId);
      if (!project || project.revision !== revision + 1) {
        throw new GameManageKitError(409, "GAME_PROJECT_CONFLICT");
      }
      await this.insertAudit(
        connection,
        authorization,
        "update",
        current,
        project,
      );
      return project;
    });

    this.registry.invalidate?.(updated.gameId);
    return updated;
  }

  async resolve(gameId: string): Promise<GameContext> {
    return this.registry.resolve(gameId);
  }

  private async findLocked(
    connection: PoolConnection,
    gameId: string,
  ): Promise<GameProject | null> {
    const [rows] = await connection.query<GameProjectRow[]>(
      `${SELECT_PROJECT}
        WHERE game_id = ?
        FOR UPDATE`,
      [gameId],
    );
    return rows[0] ? projectFromRow(rows[0]) : null;
  }

  private async insertAudit(
    connection: PoolConnection,
    authorization: GameProjectAuthorization,
    action: "create" | "update",
    before: GameProject | null,
    after: GameProject,
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
