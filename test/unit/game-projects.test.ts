import assert from "node:assert/strict";
import test from "node:test";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import {
  GameProjectService,
  type GameProjectAuthorization,
  type GameProjectDatabase,
} from "../../src/domain/game/projects.js";
import type {
  GameContext,
  GameRuntimeRegistry,
} from "../../src/domain/game/resolver.js";
import { GameManageKitError } from "../../src/errors.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";

interface StoredProject {
  game_id: string;
  name: string;
  description: string;
  status: "enabled" | "maintenance" | "disabled";
  configuration_state: "draft" | "configured";
  client_visible: number;
  sort_order: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

class FakeProjectDatabase implements GameProjectDatabase {
  readonly projects = new Map<string, StoredProject>();
  readonly audits: Array<readonly unknown[]> = [];
  readonly companionInserts: string[] = [];
  private tick = 0;

  readonly pool = {
    query: async (sql: string, values: readonly unknown[] = []) => (
      this.query(sql, values)
    ),
  } as unknown as Pool;

  async transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = {
      query: async (sql: string, values: readonly unknown[] = []) => (
        this.query(sql, values)
      ),
      execute: async (sql: string, values: readonly unknown[] = []) => (
        this.execute(sql, values)
      ),
    } as unknown as PoolConnection;
    return fn(connection);
  }

  seed(
    gameId: string,
    overrides: Partial<StoredProject> = {},
  ): StoredProject {
    const created = new Date("2026-07-28T00:00:00.000Z");
    const project: StoredProject = {
      game_id: gameId,
      name: gameId,
      description: "",
      status: "enabled",
      configuration_state: "configured",
      client_visible: 1,
      sort_order: 0,
      revision: 1,
      created_at: created,
      updated_at: created,
      ...overrides,
    };
    this.projects.set(gameId, project);
    return project;
  }

  private rows(): StoredProject[] {
    return [...this.projects.values()]
      .sort((left, right) => (
        left.sort_order - right.sort_order
        || left.game_id.localeCompare(right.game_id)
      ));
  }

  private async query(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[RowDataPacket[], unknown]> {
    const sql = compact(rawSql);
    if (!sql.includes("FROM games")) {
      throw new Error(`未实现 query: ${sql}`);
    }
    if (sql.includes("WHERE game_id = ?")) {
      const project = this.projects.get(String(values[0]));
      return [[...(project ? [project] : [])] as RowDataPacket[], []];
    }
    if (sql.includes("client_visible = 1")) {
      const rows = this.rows().filter((project) => (
        project.configuration_state === "configured"
        && project.client_visible === 1
        && project.status !== "disabled"
      ));
      return [[...rows] as RowDataPacket[], []];
    }
    return [[...this.rows()] as RowDataPacket[], []];
  }

  private async execute(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[Record<string, number>, unknown]> {
    const sql = compact(rawSql);
    if (sql.startsWith("INSERT INTO games")) {
      const gameId = String(values[0]);
      if (this.projects.has(gameId)) {
        throw Object.assign(new Error("duplicate"), { errno: 1062 });
      }
      this.seed(gameId, {
        name: String(values[1]),
        description: String(values[2]),
        status: "maintenance",
        configuration_state: "draft",
        client_visible: 0,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("UPDATE games")) {
      const gameId = String(values[5]);
      const revision = Number(values[6]);
      const project = this.projects.get(gameId);
      if (!project || project.revision !== revision) {
        return [{ affectedRows: 0 }, []];
      }
      project.name = String(values[0]);
      project.description = String(values[1]);
      project.status = String(values[2]) as StoredProject["status"];
      project.client_visible = Number(values[3]);
      project.sort_order = Number(values[4]);
      project.revision += 1;
      this.tick += 1;
      project.updated_at = new Date(
        Date.parse("2026-07-28T00:00:00.000Z") + this.tick,
      );
      return [{ affectedRows: 1 }, []];
    }
    if (
      sql.startsWith("INSERT INTO game_directory_settings")
      || sql.startsWith("INSERT INTO game_integrations")
      || sql.startsWith("INSERT INTO game_identity_providers")
      || sql.startsWith("INSERT INTO seq")
    ) {
      this.companionInserts.push(sql);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_game_audit")) {
      this.audits.push([...values]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`未实现 execute: ${sql}`);
  }
}

const authorization = (): GameProjectAuthorization => ({
  operatorId: "ops_games",
  ip: "127.0.0.1:9000",
  async authorize() {},
});

function gameError(
  statusCode: number,
  code: string,
): (error: unknown) => boolean {
  return (error) => (
    error instanceof GameManageKitError
    && error.statusCode === statusCode
    && error.code === code
  );
}

function runtime(
  resolve: (gameId: string) => Promise<GameContext> = async () => {
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  },
): GameRuntimeRegistry {
  return {
    ready: () => true,
    list: () => [],
    get: () => undefined,
    resolve,
    requireServer: async () => {
      throw new GameManageKitError(404, "SERVER_NOT_FOUND");
    },
    authenticateService: async () => null,
    authenticateAdmin: async () => null,
    canAccess: () => false,
    invalidate() {},
  };
}

test("创建游戏项目固定为不下发的维护中草稿并记录审计", async () => {
  const database = new FakeProjectDatabase();
  const metrics = new MetricsRegistry();
  const registeredGameIds: string[] = [];
  const service = new GameProjectService(database, runtime(), (gameId) => {
    registeredGameIds.push(gameId);
    metrics.registerGame(gameId);
  });

  const created = await service.create({
    gameId: "new-game",
    name: "  新游戏  ",
    description: "  客户端简介  ",
  }, authorization());

  assert.deepEqual({
    gameId: created.gameId,
    name: created.name,
    description: created.description,
    status: created.status,
    configurationState: created.configurationState,
    clientVisible: created.clientVisible,
    sortOrder: created.sortOrder,
    revision: created.revision,
  }, {
    gameId: "new-game",
    name: "新游戏",
    description: "客户端简介",
    status: "maintenance",
    configurationState: "draft",
    clientVisible: false,
    sortOrder: 0,
    revision: 1,
  });
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0]?.[0], "new-game");
  assert.deepEqual(registeredGameIds, ["new-game"]);
  metrics.recordAuditWriteFailure("new-game", "admin");
  assert.match(
    metrics.renderPrometheus(["new-game"]),
    /game_manage_kit_audit_write_failures_total\{game_id="new-game",audit_type="admin"\} 1/u,
  );
  assert.equal(database.companionInserts.length, 4);
  assert.match(database.companionInserts[0] ?? "", /game_directory_settings/u);
  assert.match(database.companionInserts[1] ?? "", /game_integrations/u);
  assert.match(
    database.companionInserts[2] ?? "",
    /game_identity_providers/u,
  );
  assert.match(database.companionInserts[3] ?? "", /INSERT INTO seq/u);

  await assert.rejects(
    service.create({
      gameId: "new-game",
      name: "重复",
      description: "",
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );
  assert.deepEqual(registeredGameIds, ["new-game"]);
});

test("编辑使用 revision 乐观锁并阻止草稿启用、误下发和 disabled 恢复", async () => {
  const database = new FakeProjectDatabase();
  database.seed("draft-game", {
    configuration_state: "draft",
    status: "maintenance",
    client_visible: 0,
  });
  const service = new GameProjectService(database, runtime());

  await assert.rejects(
    service.update("draft-game", {
      name: "草稿",
      description: "",
      status: "enabled",
      clientVisible: false,
      sortOrder: 1,
      revision: 1,
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );
  await assert.rejects(
    service.update("draft-game", {
      name: "草稿",
      description: "",
      status: "maintenance",
      clientVisible: true,
      sortOrder: 1,
      revision: 1,
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );

  const updated = await service.update("draft-game", {
    name: "<b>纯文本名称</b>",
    description: "等待部署配置",
    status: "maintenance",
    clientVisible: false,
    sortOrder: 7,
    revision: 1,
  }, authorization());
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "<b>纯文本名称</b>");
  assert.equal(updated.sortOrder, 7);

  await assert.rejects(
    service.update("draft-game", {
      name: "并发旧版本",
      description: "",
      status: "maintenance",
      clientVisible: false,
      sortOrder: 0,
      revision: 1,
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );

  database.seed("retired-game", {
    status: "disabled",
    client_visible: 0,
  });
  await assert.rejects(
    service.update("retired-game", {
      name: "不能恢复",
      description: "",
      status: "maintenance",
      clientVisible: false,
      sortOrder: 0,
      revision: 1,
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );
});

test("客户端列表以 MySQL 为唯一真源下发已配置且可见的游戏", async () => {
  const database = new FakeProjectDatabase();
  database.seed("game-a", {
    name: "游戏 A",
    description: "开放",
    status: "enabled",
    client_visible: 1,
    sort_order: 2,
  });
  database.seed("game-b", {
    name: "游戏 B",
    description: "维护",
    status: "maintenance",
    client_visible: 1,
    sort_order: 1,
  });
  database.seed("draft-game", {
    configuration_state: "draft",
    status: "maintenance",
    client_visible: 0,
  });
  database.seed("missing-config", {
    client_visible: 1,
  });
  const service = new GameProjectService(database, runtime());

  assert.deepEqual(await service.listForClient(), [
    {
      gameId: "missing-config",
      name: "missing-config",
      description: "",
      status: "enabled",
    },
    {
      gameId: "game-b",
      name: "游戏 B",
      description: "维护",
      status: "maintenance",
    },
    {
      gameId: "game-a",
      name: "游戏 A",
      description: "开放",
      status: "enabled",
    },
  ]);
});

test("业务解析以数据库项目状态为真源并拒绝草稿", async () => {
  const database = new FakeProjectDatabase();
  database.seed("game-a", {
    name: "数据库名称",
    status: "maintenance",
  });
  database.seed("game-b", {
    configuration_state: "draft",
    status: "maintenance",
    client_visible: 0,
  });
  const service = new GameProjectService(database, runtime(async (gameId) => {
    if (gameId === "game-a") {
      throw new GameManageKitError(503, "GAME_DISABLED");
    }
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  }));

  await assert.rejects(
    service.resolve("game-a"),
    gameError(503, "GAME_DISABLED"),
  );
  await assert.rejects(
    service.resolve("game-b"),
    gameError(404, "GAME_NOT_FOUND"),
  );
});
