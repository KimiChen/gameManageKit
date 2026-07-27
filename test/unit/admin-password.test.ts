import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_PASSWORD_MAX_CODE_POINTS,
  ADMIN_PASSWORD_MAX_UTF8_BYTES,
  ADMIN_PASSWORD_MIN_CODE_POINTS,
  hashAdminPassword,
  validateAdminPassword,
  verifyAdminPassword,
} from "../../src/infra/security/admin-password.js";

const PASSWORD = "管理员🔐correct horse";

test("管理员密码哈希验证正确密码并拒绝错误密码", async () => {
  const storedHash = await hashAdminPassword(PASSWORD);

  assert.match(
    storedHash,
    /^gmk-scrypt\$v=1\$N=65536,r=8,p=2\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u,
  );
  assert.equal(await verifyAdminPassword(PASSWORD, storedHash), true);
  assert.equal(await verifyAdminPassword(`${PASSWORD}!`, storedHash), false);
});

test("每次哈希使用独立随机盐", async () => {
  const first = await hashAdminPassword(PASSWORD);
  const second = await hashAdminPassword(PASSWORD);

  assert.notEqual(first, second);
  assert.notEqual(first.split("$")[3], second.split("$")[3]);
  assert.equal(await verifyAdminPassword(PASSWORD, first), true);
  assert.equal(await verifyAdminPassword(PASSWORD, second), true);
});

test("损坏哈希和恶意资源参数均安全失败且不抛出", async () => {
  const storedHash = await hashAdminPassword(PASSWORD);
  const fields = storedHash.split("$");
  const salt = fields[3] ?? "";
  const digest = fields[4] ?? "";
  const invalidHashes = [
    "",
    storedHash.slice(0, -1),
    `${storedHash}$extra`,
    `gmk-scrypt$v=2$N=65536,r=8,p=2$${salt}$${digest}`,
    `gmk-scrypt$v=1$N=32768,r=8,p=2$${salt}$${digest}`,
    `gmk-scrypt$v=1$N=999999999999,r=8,p=2$${salt}$${digest}`,
    `gmk-scrypt$v=1$N=65536,r=999999999,p=2$${salt}$${digest}`,
    `gmk-scrypt$v=1$r=8,N=65536,p=2$${salt}$${digest}`,
    `gmk-scrypt$v=1$N=65536,r=8,p=1$${salt}$${digest}`,
    `gmk-scrypt$v=1$N=65536,r=8,p=2$${"=".repeat(22)}$${digest}`,
    `gmk-scrypt$v=1$N=65536,r=8,p=2$${salt}$${"!".repeat(43)}`,
    "x".repeat(1_000_000),
  ];

  for (const invalidHash of invalidHashes) {
    await assert.doesNotReject(async () => {
      assert.equal(
        await verifyAdminPassword(PASSWORD, invalidHash),
        false,
        invalidHash.slice(0, 120),
      );
    });
  }
});

test("Unicode 密码按原始码点验证且不执行规范化", async () => {
  const composed = `é${"安全密码".repeat(3)}`;
  const decomposed = `e\u0301${"安全密码".repeat(3)}`;
  const storedHash = await hashAdminPassword(composed);

  assert.equal(await verifyAdminPassword(composed, storedHash), true);
  assert.equal(await verifyAdminPassword(decomposed, storedHash), false);
});

test("密码字符数和 UTF-8 字节边界严格生效", async () => {
  const minimum = "密".repeat(ADMIN_PASSWORD_MIN_CODE_POINTS);
  const belowMinimum = "密".repeat(ADMIN_PASSWORD_MIN_CODE_POINTS - 1);
  const maximum = "a".repeat(ADMIN_PASSWORD_MAX_CODE_POINTS);
  const aboveMaximum = "a".repeat(ADMIN_PASSWORD_MAX_CODE_POINTS + 1);
  const maximumUtf8 = "🔐".repeat(ADMIN_PASSWORD_MAX_CODE_POINTS);

  assert.equal(Buffer.byteLength(maximumUtf8, "utf8"), ADMIN_PASSWORD_MAX_UTF8_BYTES);
  assert.doesNotThrow(() => validateAdminPassword(minimum));
  assert.doesNotThrow(() => validateAdminPassword(maximum));
  assert.doesNotThrow(() => validateAdminPassword(maximumUtf8));
  assert.throws(() => validateAdminPassword(belowMinimum), TypeError);
  assert.throws(() => validateAdminPassword(aboveMaximum), TypeError);
  assert.throws(
    () => validateAdminPassword(`\ud800${"a".repeat(ADMIN_PASSWORD_MIN_CODE_POINTS)}`),
    TypeError,
  );
  await assert.rejects(() => hashAdminPassword(belowMinimum), TypeError);
  assert.equal(await verifyAdminPassword(belowMinimum, "not-a-hash"), false);
});

test("非字符串输入作为编程错误抛出", async () => {
  assert.throws(
    () => validateAdminPassword(null as unknown as string),
    TypeError,
  );
  await assert.rejects(
    () => hashAdminPassword(undefined as unknown as string),
    TypeError,
  );
  await assert.rejects(
    () => verifyAdminPassword(PASSWORD, null as unknown as string),
    TypeError,
  );
});
