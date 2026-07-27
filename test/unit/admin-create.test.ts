import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAdminPassword,
  parseAdminCreateArgs,
} from "../../src/admin-create.js";

test("管理员初始密码由 12 字节熵生成固定 16 位 Base64URL", () => {
  const entropy = Buffer.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55,
    0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
  ]);
  const password = generateAdminPassword((size) => {
    assert.equal(size, 12);
    return Buffer.from(entropy);
  });

  assert.equal(password, "ABEiM0RVZneImaq7");
  assert.equal(password.length, 16);
  assert.match(password, /^[A-Za-z0-9_-]{16}$/u);
});

test("管理员初始密码拒绝长度或类型错误的随机源", () => {
  assert.throws(
    () => generateAdminPassword(() => Buffer.alloc(11)),
    /12 字节 Buffer/u,
  );
  assert.throws(
    () => generateAdminPassword(
      () => new Uint8Array(12) as unknown as Buffer,
    ),
    /12 字节 Buffer/u,
  );
});

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
