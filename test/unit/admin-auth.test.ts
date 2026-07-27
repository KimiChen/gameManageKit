import assert from "node:assert/strict";
import test from "node:test";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  AdminAuthService,
  DefaultAdminLoginProtection,
  hashAdminSessionToken,
  normalizeAdminOperatorId,
  parseAdminSessionToken,
  requireAdminAccountCapability,
  requireAdminGameAccess,
  type AdminAuthDatabase,
  type AdminLoginProtection,
} from "../../src/domain/admin/auth.js";
import { GameManageKitError } from "../../src/errors.js";

interface FakeOperator {
  operator_id: string;
  display_name: string;
  password_hash: string;
  status: "enabled" | "disabled";
  auth_version: number;
}

interface FakeSession {
  token_hash: Buffer;
  operator_id: string;
  auth_version: number;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

interface FakeAudit {
  operatorId: string | null;
  event: string;
  reason: string | null;
  ip: string | null;
}

interface FakeLog {
  source: "pool" | "transaction";
  method: "query" | "execute";
  sql: string;
  values: readonly unknown[];
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

class FakeDatabase implements AdminAuthDatabase {
  readonly operators = new Map<string, FakeOperator>();
  readonly access = new Map<string, Array<{
    game_id: string;
    can_operate_accounts: number;
  }>>();
  readonly sessions = new Map<string, FakeSession>();
  readonly audits: FakeAudit[] = [];
  readonly logs: FakeLog[] = [];

  readonly pool = {
    query: async (sql: string, values: readonly unknown[] = []) => (
      this.query("pool", sql, values)
    ),
    execute: async (sql: string, values: readonly unknown[] = []) => (
      this.execute("pool", sql, values)
    ),
  } as unknown as Pool;

  async transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = {
      query: async (sql: string, values: readonly unknown[] = []) => (
        this.query("transaction", sql, values)
      ),
      execute: async (sql: string, values: readonly unknown[] = []) => (
        this.execute("transaction", sql, values)
      ),
    } as unknown as PoolConnection;
    return fn(connection);
  }

  addOperator(
    overrides: Partial<FakeOperator> = {},
  ): FakeOperator {
    const operator: FakeOperator = {
      operator_id: "ops_kimi",
      display_name: "Kimi",
      password_hash: "stored-password-hash",
      status: "enabled",
      auth_version: 1,
      ...overrides,
    };
    this.operators.set(operator.operator_id, operator);
    return operator;
  }

  private async query(
    source: FakeLog["source"],
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[RowDataPacket[], unknown]> {
    const sql = compactSql(rawSql);
    this.logs.push({ source, method: "query", sql, values });
    if (sql.includes("FROM admin_operators")) {
      const operator = this.operators.get(String(values[0]));
      return [[...(operator ? [operator] : [])] as RowDataPacket[], []];
    }
    if (
      sql.startsWith("SELECT operator_id FROM admin_sessions")
      || sql.startsWith(
        "SELECT operator_id, auth_version, created_at, last_seen_at, expires_at FROM admin_sessions",
      )
    ) {
      const hash = values[0];
      assert.equal(Buffer.isBuffer(hash), true);
      const session = this.sessions.get((hash as Buffer).toString("hex"));
      return [[...(session ? [session] : [])] as RowDataPacket[], []];
    }
    if (sql.includes("FROM admin_game_access")) {
      const rows = this.access.get(String(values[0])) ?? [];
      return [[...rows] as RowDataPacket[], []];
    }
    throw new Error(`未实现 FakeDatabase query: ${sql}`);
  }

  private async execute(
    source: FakeLog["source"],
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[Record<string, number>, unknown]> {
    const sql = compactSql(rawSql);
    this.logs.push({ source, method: "execute", sql, values });
    if (sql.startsWith("INSERT INTO admin_auth_audit")) {
      this.audits.push({
        operatorId: values[0] === null ? null : String(values[0]),
        event: String(values[1]),
        reason: values[2] === null ? null : String(values[2]),
        ip: values[3] === null ? null : String(values[3]),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_sessions")) {
      const hash = values[0];
      assert.equal(Buffer.isBuffer(hash), true);
      const key = (hash as Buffer).toString("hex");
      if (this.sessions.has(key)) {
        throw Object.assign(new Error("duplicate"), { errno: 1062 });
      }
      this.sessions.set(key, {
        token_hash: Buffer.from(hash as Buffer),
        operator_id: String(values[1]),
        auth_version: Number(values[2]),
        created_at: new Date(values[3] as Date),
        last_seen_at: new Date(values[4] as Date),
        expires_at: new Date(values[5] as Date),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("UPDATE admin_sessions SET last_seen_at")) {
      const hash = values[1] as Buffer;
      const session = this.sessions.get(hash.toString("hex"));
      if (session) {
        session.last_seen_at = new Date(values[0] as Date);
      }
      return [{ affectedRows: session ? 1 : 0 }, []];
    }
    if (sql.startsWith("DELETE FROM admin_sessions")) {
      const hash = values[0] as Buffer;
      return [{
        affectedRows: Number(this.sessions.delete(hash.toString("hex"))),
      }, []];
    }
    throw new Error(`未实现 FakeDatabase execute: ${sql}`);
  }
}

const ALLOW_LOGIN: AdminLoginProtection = {
  checkRateLimit() {
    return null;
  },
  acquireScrypt() {
    return { ok: true, release() {} };
  },
};

function isGameError(
  error: unknown,
  statusCode: number,
  code: string,
): boolean {
  assert.equal(error instanceof GameManageKitError, true);
  assert.equal((error as GameManageKitError).statusCode, statusCode);
  assert.equal((error as GameManageKitError).code, code);
  return true;
}

test("会话令牌使用 32 字节随机值并以 BINARY(32) SHA-256 表示", () => {
  const token = Buffer.alloc(32, 0x5a).toString("base64url");
  assert.equal(token.length, 43);
  assert.equal(parseAdminSessionToken(token)?.length, 32);
  assert.equal(hashAdminSessionToken(token)?.length, 32);
  assert.equal(hashAdminSessionToken(token)?.equals(Buffer.from(token)), false);
  for (const invalid of [
    "",
    token.slice(1),
    `${token}=`,
    `${token}x`,
    "x".repeat(43),
    "🔥".repeat(43),
  ]) {
    assert.equal(parseAdminSessionToken(invalid), null, invalid.slice(0, 20));
    assert.equal(hashAdminSessionToken(invalid), null, invalid.slice(0, 20));
  }
});

test("登录锁定 operator 后签发会话并返回实时游戏权限", async () => {
  const database = new FakeDatabase();
  database.addOperator();
  database.access.set("ops_kimi", [
    { game_id: "game-a", can_operate_accounts: 1 },
    { game_id: "game-b", can_operate_accounts: 0 },
  ]);
  const now = new Date("2026-07-28T10:00:00.000Z");
  const entropy = Buffer.alloc(32, 0x11);
  const verified: Array<[string, string]> = [];
  const service = new AdminAuthService(database, {
    now: () => now,
    randomBytes: () => Buffer.from(entropy),
    verifyPassword: async (password, hash) => {
      verified.push([password, hash]);
      return password === "correct horse battery" && hash === "stored-password-hash";
    },
    loginProtection: ALLOW_LOGIN,
  });

  const issued = await service.login({
    operatorId: " OPS_KIMI ",
    password: "correct horse battery",
    ip: "127.0.0.1:4512",
  });

  assert.deepEqual(verified, [[
    "correct horse battery",
    "stored-password-hash",
  ]]);
  assert.equal(issued.operatorId, "ops_kimi");
  assert.equal(issued.displayName, "Kimi");
  assert.equal(issued.authVersion, 1);
  assert.deepEqual(issued.games, [
    { gameId: "game-a", canOperateAccounts: true },
    { gameId: "game-b", canOperateAccounts: false },
  ]);
  assert.equal(
    issued.expiresAt,
    new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_TTL_MS).toISOString(),
  );
  assert.equal(issued.sessionToken, entropy.toString("base64url"));
  const stored = [...database.sessions.values()][0];
  assert.ok(stored);
  assert.equal(stored.token_hash.length, 32);
  assert.equal(
    stored.expires_at.toISOString(),
    new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_TTL_MS).toISOString(),
  );
  assert.deepEqual(database.audits, [{
    operatorId: "ops_kimi",
    event: "login_success",
    reason: null,
    ip: "127.0.0.1",
  }]);

  const transactionOperations = database.logs.filter(
    (entry) => entry.source === "transaction",
  );
  assert.match(transactionOperations[0]?.sql ?? "", /admin_operators/u);
  assert.match(transactionOperations[0]?.sql ?? "", /FOR UPDATE$/u);
  assert.match(transactionOperations[1]?.sql ?? "", /INSERT INTO admin_sessions/u);
});

test("未知、停用和非法密码都执行等成本 dummy 验证并返回统一 401", async () => {
  for (const scenario of ["unknown", "disabled", "malformed"] as const) {
    const database = new FakeDatabase();
    if (scenario !== "unknown") {
      database.addOperator({
        status: scenario === "disabled" ? "disabled" : "enabled",
      });
    }
    const verifications: Array<[string, string]> = [];
    const service = new AdminAuthService(database, {
      verifyPassword: async (password, hash) => {
        verifications.push([password, hash]);
        return false;
      },
      loginProtection: ALLOW_LOGIN,
    });

    await assert.rejects(
      service.login({
        operatorId: "ops_kimi",
        password: scenario === "malformed" ? "short" : "wrong password value",
        ip: "192.0.2.8",
      }),
      (error) => isGameError(error, 401, "ADMIN_AUTH_REQUIRED"),
    );
    assert.equal(verifications.length, 1);
    if (scenario === "unknown" || scenario === "disabled") {
      assert.match(verifications[0]?.[1] ?? "", /^gmk-scrypt\$/u);
    }
    if (scenario === "malformed") {
      assert.notEqual(verifications[0]?.[0], "short");
    }
    assert.deepEqual(database.audits, [{
      operatorId: "ops_kimi",
      event: "login_failure",
      reason: "invalid_credentials",
      ip: "192.0.2.8",
    }]);
    assert.equal(database.sessions.size, 0);
  }
});

test("登录同时受 IP、operator/IP 令牌桶和 scrypt 并发上限保护", () => {
  let nowMs = 1_000;
  const byIp = new DefaultAdminLoginProtection({
    ipCapacity: 1,
    ipRefillPerSecond: 1,
    operatorCapacity: 10,
    operatorRefillPerSecond: 1,
    operatorIpCapacity: 10,
    operatorIpRefillPerSecond: 1,
    now: () => nowMs,
  });
  assert.equal(byIp.checkRateLimit("ops_a", "192.0.2.1"), null);
  assert.equal(
    byIp.checkRateLimit("ops_b", "192.0.2.1"),
    "rate_limited_ip",
  );
  nowMs += 1_000;
  assert.equal(byIp.checkRateLimit("ops_b", "192.0.2.1"), null);

  const byOperatorIp = new DefaultAdminLoginProtection({
    ipCapacity: 10,
    ipRefillPerSecond: 1,
    operatorCapacity: 10,
    operatorRefillPerSecond: 1,
    operatorIpCapacity: 1,
    operatorIpRefillPerSecond: 1,
    now: () => nowMs,
    maximumConcurrentScrypt: 1,
  });
  assert.equal(
    byOperatorIp.checkRateLimit(" OPS_A ", "192.0.2.2"),
    null,
  );
  assert.equal(
    byOperatorIp.checkRateLimit("ops_a", "192.0.2.2"),
    "rate_limited_operator_ip",
  );
  const first = byOperatorIp.acquireScrypt();
  assert.equal(first.ok, true);
  assert.equal(byOperatorIp.acquireScrypt().ok, false);
  if (first.ok) {
    first.release();
    first.release();
  }
  assert.equal(byOperatorIp.acquireScrypt().ok, true);

  const byOperator = new DefaultAdminLoginProtection({
    ipCapacity: 10,
    ipRefillPerSecond: 1,
    operatorCapacity: 1,
    operatorRefillPerSecond: 1,
    operatorIpCapacity: 10,
    operatorIpRefillPerSecond: 1,
    now: () => nowMs,
  });
  assert.equal(byOperator.checkRateLimit("ops_a", "192.0.2.3"), null);
  assert.equal(
    byOperator.checkRateLimit(" OPS_A ", "192.0.2.4"),
    "rate_limited_operator",
  );
  assert.equal(normalizeAdminOperatorId(" OPS_KIMI "), "ops_kimi");
  assert.equal(normalizeAdminOperatorId("bad operator"), null);
});

test("限流和 scrypt 容量耗尽统一返回 429 并记录有限原因", async () => {
  for (const mode of ["rate", "capacity"] as const) {
    const database = new FakeDatabase();
    database.addOperator();
    let verifyCalls = 0;
    const protection: AdminLoginProtection = {
      checkRateLimit() {
        return mode === "rate" ? "rate_limited_ip" : null;
      },
      acquireScrypt() {
        return mode === "capacity"
          ? { ok: false }
          : { ok: true, release() {} };
      },
    };
    const service = new AdminAuthService(database, {
      loginProtection: protection,
      verifyPassword: async () => {
        verifyCalls += 1;
        return true;
      },
    });
    await assert.rejects(
      service.login({
        operatorId: "ops_kimi",
        password: "correct horse battery",
        ip: "198.51.100.3",
      }),
      (error) => isGameError(error, 429, "RATE_LIMITED"),
    );
    assert.equal(verifyCalls, 0);
    assert.equal(
      database.audits[0]?.reason,
      mode === "rate" ? "rate_limited_ip" : "scrypt_capacity",
    );
  }
});

test("重复保护性限流只按窗口记录一条审计，避免数据库写放大", async () => {
  const database = new FakeDatabase();
  let now = new Date("2026-07-28T10:00:00.000Z");
  const service = new AdminAuthService(database, {
    now: () => now,
    loginProtection: {
      checkRateLimit() {
        return "rate_limited_ip";
      },
      acquireScrypt() {
        throw new Error("限流后不应获取 scrypt 许可");
      },
    },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      service.login({
        operatorId: `ops_${attempt}`,
        password: "correct horse battery",
        ip: "192.0.2.80",
      }),
      (error) => isGameError(error, 429, "RATE_LIMITED"),
    );
  }
  assert.equal(database.audits.length, 1);

  now = new Date(now.getTime() + 60_000);
  await assert.rejects(
    service.login({
      operatorId: "ops_after",
      password: "correct horse battery",
      ip: "192.0.2.80",
    }),
    (error) => isGameError(error, 429, "RATE_LIMITED"),
  );
  assert.equal(database.audits.length, 2);
});

async function issueFixture(): Promise<{
  database: FakeDatabase;
  service: AdminAuthService;
  token: string;
  setNow: (value: Date) => void;
}> {
  const database = new FakeDatabase();
  database.addOperator();
  database.access.set("ops_kimi", [{
    game_id: "game-a",
    can_operate_accounts: true as unknown as number,
  }]);
  let current = new Date("2026-07-28T10:00:00.000Z");
  const service = new AdminAuthService(database, {
    now: () => current,
    randomBytes: () => Buffer.alloc(32, 0x44),
    verifyPassword: async () => true,
    loginProtection: ALLOW_LOGIN,
  });
  const issued = await service.login({
    operatorId: "ops_kimi",
    password: "correct horse battery",
    ip: "203.0.113.5",
  });
  database.logs.length = 0;
  database.audits.length = 0;
  return {
    database,
    service,
    token: issued.sessionToken,
    setNow(value) {
      current = value;
    },
  };
}

test("每次认证按 operator→session 锁序并实时读取权限、刷新空闲期", async () => {
  const fixture = await issueFixture();
  fixture.database.access.set("ops_kimi", [{
    game_id: "game-b",
    can_operate_accounts: 0,
  }]);
  const now = new Date("2026-07-28T10:05:00.000Z");
  fixture.setNow(now);

  const identity = await fixture.service.authenticate(
    fixture.token,
    "203.0.113.5",
  );

  assert.deepEqual(identity.games, [{
    gameId: "game-b",
    canOperateAccounts: false,
  }]);
  const stored = [...fixture.database.sessions.values()][0];
  assert.equal(stored?.last_seen_at.toISOString(), now.toISOString());
  assert.equal(
    identity.expiresAt,
    stored?.expires_at.toISOString(),
  );
  assert.match(fixture.database.logs[0]?.sql ?? "", /SELECT operator_id FROM admin_sessions/u);
  const locked = fixture.database.logs.filter(
    (entry) => entry.source === "transaction" && entry.method === "query",
  );
  assert.match(locked[0]?.sql ?? "", /admin_operators.*FOR UPDATE$/u);
  assert.match(locked[1]?.sql ?? "", /admin_sessions.*FOR UPDATE$/u);
  assert.match(locked[2]?.sql ?? "", /admin_game_access/u);
});

test("空闲和绝对过期均删除会话、写审计并立即返回 401", async () => {
  for (const mode of ["idle", "absolute"] as const) {
    const fixture = await issueFixture();
    const session = [...fixture.database.sessions.values()][0];
    assert.ok(session);
    if (mode === "idle") {
      fixture.setNow(
        new Date(session.last_seen_at.getTime() + ADMIN_SESSION_IDLE_TTL_MS),
      );
    } else {
      fixture.setNow(new Date(session.expires_at));
    }

    await assert.rejects(
      fixture.service.authenticate(fixture.token, "203.0.113.9"),
      (error) => isGameError(error, 401, "ADMIN_AUTH_REQUIRED"),
    );
    assert.equal(fixture.database.sessions.size, 0);
    assert.deepEqual(fixture.database.audits, [{
      operatorId: "ops_kimi",
      event: "session_expired",
      reason: mode === "absolute" ? "absolute_timeout" : "idle_timeout",
      ip: "203.0.113.9",
    }]);
  }
});

test("停用或 auth_version 变化会在下一请求删除现有会话", async () => {
  for (const mode of ["disabled", "version"] as const) {
    const fixture = await issueFixture();
    const operator = fixture.database.operators.get("ops_kimi");
    assert.ok(operator);
    if (mode === "disabled") {
      operator.status = "disabled";
    } else {
      operator.auth_version += 1;
    }
    await assert.rejects(
      fixture.service.authenticate(fixture.token),
      (error) => isGameError(error, 401, "ADMIN_AUTH_REQUIRED"),
    );
    assert.equal(fixture.database.sessions.size, 0);
    assert.equal(fixture.database.audits[0]?.event, "session_invalidated");
    assert.equal(
      fixture.database.audits[0]?.reason,
      mode === "disabled" ? "operator_disabled" : "auth_version_changed",
    );
  }
});

test("退出按统一锁序删除会话并记录审计，未知令牌幂等", async () => {
  const fixture = await issueFixture();
  await fixture.service.logout(fixture.token, "203.0.113.11");
  assert.equal(fixture.database.sessions.size, 0);
  assert.deepEqual(fixture.database.audits, [{
    operatorId: "ops_kimi",
    event: "logout",
    reason: "logout",
    ip: "203.0.113.11",
  }]);
  const locked = fixture.database.logs.filter(
    (entry) => entry.source === "transaction" && entry.method === "query",
  );
  assert.match(locked[0]?.sql ?? "", /admin_operators.*FOR UPDATE$/u);
  assert.match(locked[1]?.sql ?? "", /admin_sessions.*FOR UPDATE$/u);

  await assert.doesNotReject(
    fixture.service.logout(Buffer.alloc(32, 0x99).toString("base64url")),
  );
  assert.equal(fixture.database.audits.length, 1);
});

test("游戏与账号操作能力由当前会话权限严格判定", () => {
  const identity = {
    operatorId: "ops_kimi",
    displayName: "Kimi",
    authVersion: 1,
    expiresAt: "2026-07-28T10:30:00.000Z",
    games: [
      { gameId: "game-a", canOperateAccounts: true },
      { gameId: "game-b", canOperateAccounts: false },
    ],
  };
  assert.equal(requireAdminGameAccess(identity, "game-a").gameId, "game-a");
  assert.doesNotThrow(() => requireAdminAccountCapability(identity, "game-a"));
  assert.throws(
    () => requireAdminAccountCapability(identity, "game-b"),
    (error) => isGameError(error, 403, "GAME_ACCESS_DENIED"),
  );
  assert.throws(
    () => requireAdminGameAccess(identity, "game-c"),
    (error) => isGameError(error, 403, "GAME_ACCESS_DENIED"),
  );
});

test("账号写操作在同一事务重新锁定管理员并读取实时能力", async () => {
  const fixture = await issueFixture();
  const identity = await fixture.service.authenticate(fixture.token);
  fixture.database.logs.length = 0;
  const connection = {
    query: async (sql: string, values: readonly unknown[] = []) => (
      (fixture.database as unknown as {
        query(
          source: "transaction",
          sql: string,
          values: readonly unknown[],
        ): Promise<[RowDataPacket[], unknown]>;
      }).query("transaction", sql, values)
    ),
  } as unknown as PoolConnection;

  await fixture.service.requireAccountOperation(
    connection,
    identity,
    "game-a",
  );
  assert.match(
    fixture.database.logs[0]?.sql ?? "",
    /admin_operators.*FOR UPDATE$/u,
  );
  assert.match(
    fixture.database.logs[1]?.sql ?? "",
    /admin_game_access.*FOR SHARE$/u,
  );

  fixture.database.access.set("ops_kimi", [{
    game_id: "game-a",
    can_operate_accounts: 0,
  }]);
  await assert.rejects(
    fixture.service.requireAccountOperation(connection, identity, "game-a"),
    (error) => isGameError(error, 403, "GAME_ACCESS_DENIED"),
  );

  const operator = fixture.database.operators.get("ops_kimi");
  assert.ok(operator);
  operator.auth_version += 1;
  await assert.rejects(
    fixture.service.requireAccountOperation(connection, identity, "game-a"),
    (error) => isGameError(error, 401, "ADMIN_AUTH_REQUIRED"),
  );
});
