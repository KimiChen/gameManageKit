import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminCreateArgs } from "../../src/admin-create.js";

test("管理员创建参数只接受账号、显示名、游戏和只读能力", () => {
  assert.deepEqual(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--display-name",
      "Kimi",
      "--games",
      "game-a,game-b",
    ]),
    {
      operatorId: "ops_kimi",
      displayName: "Kimi",
      gameIds: ["game-a", "game-b"],
      canOperateAccounts: true,
    },
  );
  assert.equal(
    parseAdminCreateArgs([
      "--operator-id",
      "ops_viewer",
      "--games",
      "game-a",
      "--read-only",
    ]).canOperateAccounts,
    false,
  );
});

test("管理员创建参数拒绝密码参数、重复游戏和非法账号", () => {
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--games",
      "game-a",
      "--password",
      "do-not-put-secrets-in-argv",
    ]),
    /不支持的参数 --password/,
  );
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "ops_kimi",
      "--games",
      "game-a,game-a",
    ]),
    /无重复/,
  );
  assert.throws(
    () => parseAdminCreateArgs([
      "--operator-id",
      "INVALID",
      "--games",
      "game-a",
    ]),
    /operatorId/,
  );
});
