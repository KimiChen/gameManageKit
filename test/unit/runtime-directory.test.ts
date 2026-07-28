import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import {
  MysqlDirectoryProvider,
} from "../../src/domain/directory/service.js";
import { GameManageKitError } from "../../src/errors.js";

const compact = (sql: string): string => sql.replace(/\s+/gu, " ").trim();

const server = {
  configuration_state: "configured",
  game_status: "enabled",
  is_ops: 0,
  server_id: 1,
  name: "一区",
  tag: "normal",
  status: "smooth",
  open_time: 1_700_000_000,
  game_http_url: "https://game.example.invalid",
  game_ws_url: "wss://game.example.invalid",
};

test("MySQL 目录列表与登录复用完整 Public 区服准入条件", async () => {
  const statements: string[] = [];
  const pool = {
    async query(rawSql: string) {
      const sql = compact(rawSql);
      statements.push(sql);
      if (sql.includes("AS usable")) {
        return [[{ ...server, usable: 1 }], []];
      }
      return [[server], []];
    },
  } as unknown as Pool;
  const provider = new MysqlDirectoryProvider(
    pool,
    "game-a",
    true,
  );

  const directory = await provider.listAreas();
  const admission = await provider.serverAdmission(1);

  assert.deepEqual(
    directory.servers.map(({ serverId }) => serverId),
    [1],
  );
  assert.equal(admission.usable, true);
  for (const sql of statements) {
    assert.match(sql, /configuration_state/u);
    assert.match(sql, /g\.status AS game_status/u);
    assert.match(sql, /s\.is_open = 1/u);
    assert.match(sql, /s\.status IN \('smooth', 'busy'\)/u);
    assert.match(
      sql,
      /s\.open_time <= UNIX_TIMESTAMP\(NOW\(3\)\)/u,
    );
  }
});

test("目录提供者对 draft、maintenance、disabled 游戏失败关闭", async () => {
  for (const [configurationState, gameStatus, statusCode] of [
    ["draft", "maintenance", 404],
    ["configured", "maintenance", 503],
    ["configured", "disabled", 403],
  ] as const) {
    const pool = {
      async query() {
        return [[{
          ...server,
          configuration_state: configurationState,
          game_status: gameStatus,
          server_id: null,
          name: null,
          tag: null,
          status: null,
          open_time: null,
          game_http_url: null,
          game_ws_url: null,
        }], []];
      },
    } as unknown as Pool;
    const provider = new MysqlDirectoryProvider(
      pool,
      "game-a",
      true,
    );

    await assert.rejects(
      provider.listAreas(),
      (error: unknown) => (
        error instanceof GameManageKitError
        && error.statusCode === statusCode
      ),
      `${configurationState}/${gameStatus}`,
    );
  }
});

test("正常游戏无可进入区服时返回 200 语义的空目录", async () => {
  const pool = {
    async query() {
      return [[{
        ...server,
        server_id: null,
        name: null,
        tag: null,
        status: null,
        open_time: null,
        game_http_url: null,
        game_ws_url: null,
      }], []];
    },
  } as unknown as Pool;
  const provider = new MysqlDirectoryProvider(
    pool,
    "game-a",
    true,
  );

  const directory = await provider.listAreas();

  assert.deepEqual(directory.servers, []);
});
