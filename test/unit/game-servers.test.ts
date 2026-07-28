import assert from "node:assert/strict";
import test from "node:test";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import { MysqlDirectoryProvider } from "../../src/domain/directory/service.js";
import {
  GameServerService,
  type GameServerAuthorization,
  type GameServerDatabase,
} from "../../src/domain/game/servers.js";
import { GameManageKitError } from "../../src/errors.js";

interface StoredServer {
  game_id: string;
  server_id: number;
  name: string;
  tag: "normal" | "new" | "full" | "maintenance";
  status: "smooth" | "busy" | "maintenance";
  open_time: number;
  game_http_url: string;
  game_ws_url: string;
  is_open: number;
  sort_order: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

class FakeServerDatabase implements GameServerDatabase {
  readonly games = new Set(["game-a", "draft-game"]);
  readonly directories = new Map([
    ["game-a", {
      game_id: "game-a",
      is_ops: 0,
      revision: 1,
      created_at: new Date("2026-07-28T00:00:00.000Z"),
      updated_at: new Date("2026-07-28T00:00:00.000Z"),
    }],
    ["draft-game", {
      game_id: "draft-game",
      is_ops: 0,
      revision: 1,
      created_at: new Date("2026-07-28T00:00:00.000Z"),
      updated_at: new Date("2026-07-28T00:00:00.000Z"),
    }],
  ]);
  readonly servers = new Map<string, StoredServer>();
  readonly audits: Array<readonly unknown[]> = [];
  authorizationCount = 0;
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

  private key(gameId: string, serverId: number): string {
    return `${gameId}\0${serverId}`;
  }

  private async query(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[RowDataPacket[], unknown]> {
    const sql = compact(rawSql);
    if (sql.includes("FROM games")) {
      const gameId = String(values[0]);
      const rows = this.games.has(gameId)
        ? [{ game_id: gameId }] as RowDataPacket[]
        : [];
      return [rows, []];
    }
    if (sql.includes("FROM game_directory_settings")) {
      const directory = this.directories.get(String(values[0]));
      return [[...(directory ? [directory] : [])] as RowDataPacket[], []];
    }
    if (!sql.includes("FROM game_servers")) {
      throw new Error(`未实现 query: ${sql}`);
    }
    const gameId = String(values[0]);
    if (sql.includes("server_id = ?")) {
      const server = this.servers.get(this.key(gameId, Number(values[1])));
      return [[...(server ? [server] : [])] as RowDataPacket[], []];
    }
    const servers = [...this.servers.values()]
      .filter((server) => server.game_id === gameId)
      .sort((left, right) => (
        left.sort_order - right.sort_order
        || left.server_id - right.server_id
      ));
    return [[...servers] as RowDataPacket[], []];
  }

  private async execute(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[Record<string, number>, unknown]> {
    const sql = compact(rawSql);
    if (sql.startsWith("UPDATE game_directory_settings")) {
      const settingsUpdate = sql.includes("SET is_ops = ?");
      const gameId = String(values[settingsUpdate ? 1 : 0]);
      const revision = Number(values[settingsUpdate ? 2 : 1]);
      const directory = this.directories.get(gameId);
      if (!directory || directory.revision !== revision) {
        return [{ affectedRows: 0 }, []];
      }
      if (settingsUpdate) {
        directory.is_ops = Number(values[0]);
      }
      directory.revision += 1;
      this.tick += 1;
      directory.updated_at = new Date(
        Date.parse("2026-07-28T00:00:00.000Z") + this.tick,
      );
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO game_servers")) {
      const gameId = String(values[0]);
      const serverId = Number(values[1]);
      const key = this.key(gameId, serverId);
      if (this.servers.has(key)) {
        throw Object.assign(new Error("duplicate"), { errno: 1062 });
      }
      const now = new Date("2026-07-28T00:00:00.000Z");
      this.servers.set(key, {
        game_id: gameId,
        server_id: serverId,
        name: String(values[2]),
        tag: String(values[3]) as StoredServer["tag"],
        status: String(values[4]) as StoredServer["status"],
        open_time: Number(values[5]),
        game_http_url: String(values[6]),
        game_ws_url: String(values[7]),
        is_open: Number(values[8]),
        sort_order: Number(values[9]),
        revision: 1,
        created_at: now,
        updated_at: now,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("UPDATE game_servers")) {
      const gameId = String(values[8]);
      const serverId = Number(values[9]);
      const revision = Number(values[10]);
      const server = this.servers.get(this.key(gameId, serverId));
      if (!server || server.revision !== revision) {
        return [{ affectedRows: 0 }, []];
      }
      server.name = String(values[0]);
      server.tag = String(values[1]) as StoredServer["tag"];
      server.status = String(values[2]) as StoredServer["status"];
      server.open_time = Number(values[3]);
      server.game_http_url = String(values[4]);
      server.game_ws_url = String(values[5]);
      server.is_open = Number(values[6]);
      server.sort_order = Number(values[7]);
      server.revision += 1;
      this.tick += 1;
      server.updated_at = new Date(
        Date.parse("2026-07-28T00:00:00.000Z") + this.tick,
      );
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_game_audit")) {
      this.audits.push([...values]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`未实现 execute: ${sql}`);
  }
}

function authorization(
  database: FakeServerDatabase,
): GameServerAuthorization {
  return {
    operatorId: "ops_servers",
    ip: "127.0.0.1:9000",
    async authorize() {
      database.authorizationCount += 1;
    },
  };
}

function serverPayload(overrides: Record<string, unknown> = {}) {
  return {
    directoryRevision: 1,
    serverId: 1,
    name: "  新一区  ",
    tag: "new" as const,
    status: "smooth" as const,
    openTime: 1_700_000_000,
    gameHttpUrl: "https://game.example.invalid",
    gameWsUrl: "wss://game.example.invalid",
    isOpen: true,
    sortOrder: 10,
    ...overrides,
  };
}

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

test("草稿游戏可预配置区服，重复 serverId 冲突并记录审计", async () => {
  const database = new FakeServerDatabase();
  const service = new GameServerService(database, true);
  const auth = authorization(database);

  const created = await service.create(
    "draft-game",
    serverPayload(),
    auth,
  );
  assert.deepEqual({
    gameId: created.server.gameId,
    serverId: created.server.serverId,
    name: created.server.name,
    isOpen: created.server.isOpen,
    sortOrder: created.server.sortOrder,
    revision: created.server.revision,
    directoryRevision: created.directoryRevision,
  }, {
    gameId: "draft-game",
    serverId: 1,
    name: "新一区",
    isOpen: true,
    sortOrder: 10,
    revision: 1,
    directoryRevision: 2,
  });
  assert.equal(database.authorizationCount, 1);
  assert.equal(database.audits[0]?.[0], "draft-game");
  assert.equal(database.audits[0]?.[2], "server_create");

  await assert.rejects(
    service.create("draft-game", serverPayload(), auth),
    gameError(409, "GAME_SERVER_CONFLICT"),
  );
  await assert.rejects(
    service.create("missing-game", serverPayload(), auth),
    gameError(404, "GAME_NOT_FOUND"),
  );
});

test("目录设置与区服写入共享目录 revision 乐观锁", async () => {
  const database = new FakeServerDatabase();
  const service = new GameServerService(database, true);
  const auth = authorization(database);

  const initial = await service.getDirectorySettings("game-a", auth);
  assert.equal(initial.isOps, false);
  assert.equal(initial.revision, 1);

  const settings = await service.updateDirectorySettings("game-a", {
    isOps: true,
    revision: initial.revision,
  }, auth);
  assert.equal(settings.isOps, true);
  assert.equal(settings.revision, 2);

  await assert.rejects(
    service.create("game-a", serverPayload(), auth),
    gameError(409, "GAME_SERVER_CONFLICT"),
  );
  const created = await service.create(
    "game-a",
    serverPayload({ directoryRevision: settings.revision }),
    auth,
  );
  assert.equal(created.directoryRevision, 3);
  const list = await service.list("game-a", auth);
  assert.equal(list.directoryRevision, 3);
  assert.equal(list.servers.length, 1);
});

test("编辑区服使用 revision 乐观锁并允许关闭或维护", async () => {
  const database = new FakeServerDatabase();
  const service = new GameServerService(database, true);
  const auth = authorization(database);
  const created = await service.create("game-a", serverPayload(), auth);

  const updated = await service.update("game-a", 1, {
    directoryRevision: created.directoryRevision,
    name: "维护一区",
    tag: "maintenance",
    status: "maintenance",
    openTime: created.server.openTime,
    gameHttpUrl: created.server.gameHttpUrl,
    gameWsUrl: created.server.gameWsUrl,
    isOpen: false,
    sortOrder: 2,
    revision: created.server.revision,
  }, auth);
  assert.equal(updated.server.status, "maintenance");
  assert.equal(updated.server.isOpen, false);
  assert.equal(updated.server.revision, 2);
  assert.equal(updated.directoryRevision, 3);
  assert.equal(database.audits[1]?.[2], "server_update");
  assert.notEqual(database.audits[1]?.[3], null);

  await assert.rejects(
    service.update("game-a", 1, {
      directoryRevision: updated.directoryRevision,
      name: updated.server.name,
      tag: updated.server.tag,
      status: updated.server.status,
      openTime: updated.server.openTime,
      gameHttpUrl: updated.server.gameHttpUrl,
      gameWsUrl: updated.server.gameWsUrl,
      isOpen: updated.server.isOpen,
      sortOrder: updated.server.sortOrder,
      revision: 1,
    }, auth),
    gameError(409, "GAME_SERVER_CONFLICT"),
  );
  await assert.rejects(
    service.update("game-a", 2, {
      directoryRevision: updated.directoryRevision,
      name: "不存在",
      tag: "normal",
      status: "smooth",
      openTime: 0,
      gameHttpUrl: "https://game.example.invalid",
      gameWsUrl: "wss://game.example.invalid",
      isOpen: false,
      sortOrder: 0,
      revision: 1,
    }, auth),
    gameError(404, "SERVER_NOT_FOUND"),
  );
});

test("区服字段校验 Unicode、整数边界和安全 URL", async () => {
  const database = new FakeServerDatabase();
  const productionService = new GameServerService(database, true);
  const developmentService = new GameServerService(database, false);
  const auth = authorization(database);

  for (const overrides of [
    { serverId: 65_536 },
    { serverId: -1 },
    { name: "\ud800" },
    { name: "界".repeat(65) },
    { openTime: Number.MAX_SAFE_INTEGER + 1 },
    { sortOrder: 65_536 },
    { gameHttpUrl: "http://game.example.invalid" },
    { gameHttpUrl: "https://user:pass@game.example.invalid" },
    { gameHttpUrl: "https://game.example.invalid/#secret" },
    { gameWsUrl: "https://game.example.invalid" },
  ]) {
    await assert.rejects(
      productionService.create(
        "game-a",
        serverPayload(overrides),
        auth,
      ),
      gameError(400, "INVALID_PAYLOAD"),
    );
  }

  const local = await developmentService.create(
    "game-a",
    serverPayload({
      serverId: 65_535,
      name: "😀".repeat(64),
      gameHttpUrl: "http://127.0.0.1:8080",
      gameWsUrl: "ws://localhost:8081",
      sortOrder: 65_535,
    }),
    auth,
  );
  assert.equal(local.server.serverId, 65_535);
  assert.equal([...local.server.name].length, 64);
});

test("MySQL 目录以同一准入规则过滤维护、关闭和未来区服", async () => {
  const rows = [
    {
      game_id: "game-a",
      server_id: 1,
      name: "开放一区",
      tag: "normal",
      status: "smooth",
      open_time: 1_700_000_000,
      game_http_url: "https://game.example.invalid",
      game_ws_url: "wss://game.example.invalid",
      is_open: 1,
      sort_order: 1,
    },
    {
      game_id: "game-a",
      server_id: 2,
      name: "维护二区",
      tag: "maintenance",
      status: "maintenance",
      open_time: 1_700_000_001,
      game_http_url: "https://game.example.invalid",
      game_ws_url: "wss://game.example.invalid",
      is_open: 1,
      sort_order: 2,
    },
    {
      game_id: "game-a",
      server_id: 3,
      name: "关闭三区",
      tag: "normal",
      status: "smooth",
      open_time: 1_700_000_002,
      game_http_url: "https://game.example.invalid",
      game_ws_url: "wss://game.example.invalid",
      is_open: 0,
      sort_order: 3,
    },
    {
      game_id: "game-a",
      server_id: 4,
      name: "未来四区",
      tag: "new",
      status: "busy",
      open_time: 4_000_000_000,
      game_http_url: "https://game.example.invalid",
      game_ws_url: "wss://game.example.invalid",
      is_open: 1,
      sort_order: 4,
    },
  ];
  const pool = {
    async query(rawSql: string, values: readonly unknown[]) {
      const sql = compact(rawSql);
      if (sql.includes("AS usable")) {
        const row = rows.find((item) => (
          item.server_id === Number(values[0])
        ));
        const usable = row
          && row.is_open === 1
          && (row.status === "smooth" || row.status === "busy")
          && row.open_time < 2_000_000_000;
        return [[{
          configuration_state: "configured",
          game_status: "enabled",
          is_ops: 0,
          ...(row ?? {
            server_id: null,
            name: null,
            tag: null,
            status: null,
            open_time: null,
            game_http_url: null,
            game_ws_url: null,
          }),
          usable: usable ? 1 : 0,
        }], []];
      }
      if (sql.includes("LEFT JOIN game_servers")) {
        assert.match(sql, /s\.is_open = 1/u);
        assert.match(sql, /s\.status IN \('smooth', 'busy'\)/u);
        assert.match(sql, /s\.open_time <= UNIX_TIMESTAMP\(NOW\(3\)\)/u);
        return [rows
          .filter((row) => (
            row.is_open === 1
            && (row.status === "smooth" || row.status === "busy")
            && row.open_time < 2_000_000_000
          ))
          .map((row) => ({
            ...row,
            configuration_state: "configured",
            game_status: "enabled",
            is_ops: 0,
          })), []];
      }
      throw new Error(`未实现 query: ${sql}`);
    },
  } as unknown as Pool;
  const provider = new MysqlDirectoryProvider(pool, "game-a", true);

  const directory = await provider.listAreas();
  assert.deepEqual(
    directory.servers.map((server) => server.serverId),
    [1],
  );
  assert.match(directory.hash, /^[0-9a-f]{64}$/u);
  assert.equal((await provider.findServer(3))?.name, "关闭三区");
  assert.equal(await provider.isServerUsable(1), true);
  assert.equal(await provider.isServerUsable(2), false);
  assert.equal(await provider.isServerUsable(3), false);
  assert.equal(await provider.isServerUsable(4), false);
});
