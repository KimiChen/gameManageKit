import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { createRuntime } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { insertAudit } from "../../src/domain/account/audit.js";
import { LoginService } from "../../src/domain/account/login.js";
import { SessionService } from "../../src/domain/session/service.js";
import { TokenBucketLimiter } from "../../src/infra/security/security.js";
import type {
  WechatExchangeResult,
  WechatIdentityClient,
} from "../../src/infra/wechat/client.js";

const execFileAsync = promisify(execFile);

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

test("空库迁移及账号服务完整 HTTP 链路", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName = `game_manage_kit_test_${process.pid}_${Date.now()}`;
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("测试数据库名非法");
  }
  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );

    const migrateEnv = {
      ...process.env,
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
    };
    await execFileAsync(
      process.execPath,
      ["dist/migrate.js"],
      { cwd: process.cwd(), env: migrateEnv },
    );
    await execFileAsync(
      process.execPath,
      ["dist/migrate.js"],
      { cwd: process.cwd(), env: migrateEnv },
    );

    const check = await mysql.createConnection(mysqlUrl);
    try {
      const [versions] = await check.query<RowDataPacket[]>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        versions.map((row) => [Number(row.version), String(row.name)]),
        [[1, "0001_initial.sql"]],
      );
      const [tables] = await check.query<RowDataPacket[]>("SHOW TABLES");
      assert.equal(tables.length, 6);
    } finally {
      await check.end();
    }

    const config = loadConfig({
      NODE_ENV: "development",
      GAME_MANAGE_KIT_MYSQL_URL: mysqlUrl,
      GAME_MANAGE_KIT_SERVICE_SECRET: "integration-service",
      GAME_MANAGE_KIT_ADMIN_SECRET: "integration-admin",
      GAME_MANAGE_KIT_AREA_CONFIG: "config/areas.json",
      AUTH_DEV_ENABLED: "1",
      LOGIN_RATE_CAPACITY: "100",
      GAME_MANAGE_KIT_LOG_ENABLED: "0",
    });
    runtime = await createRuntime(config);
    const { publicApp, internalApp } = runtime.apps;
    const serviceHeaders = {
      "x-service-id": "game-1",
      "x-service-secret": "integration-service",
    };

    const ready = await publicApp.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { ready: true });

    const concurrentLogins = await Promise.all(
      Array.from({ length: 8 }, () => publicApp.inject({
        method: "POST",
        url: "/v1/sessions/dev",
        payload: { devKey: "concurrent-player", serverId: 2 },
      })),
    );
    assert.equal(
      concurrentLogins.every((response) => response.statusCode === 200),
      true,
      concurrentLogins.map((response) => response.body).join("\n"),
    );
    const concurrentBodies = concurrentLogins.map((response) => response.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>());
    assert.equal(new Set(concurrentBodies.map((body) => body.userId)).size, 1);
    assert.equal(concurrentBodies.filter((body) => body.isNewAccount).length, 1);
    assert.equal(new Set(concurrentBodies.map((body) => body.accessToken)).size, 8);

    const zoneOneLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "zone-player", serverId: 1 },
    });
    const zoneOne = zoneOneLogin.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>();
    const zoneOneVerified = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: zoneOne.accessToken, serverId: 1 },
    });
    assert.equal(zoneOneVerified.statusCode, 200);
    const firstIssuedAtMs = Number(zoneOneVerified.json().issuedAtMs);

    const zoneTwoLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "zone-player", serverId: 2 },
    });
    const zoneTwo = zoneTwoLogin.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>();
    assert.equal(zoneTwo.userId, zoneOne.userId);
    assert.equal(zoneTwo.isNewAccount, false);
    const zoneTwoVerified = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: zoneTwo.accessToken, serverId: 2 },
    });
    assert.equal(zoneTwoVerified.json().valid, true);
    const crossZone = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: zoneTwo.accessToken, serverId: 1 },
    });
    assert.deepEqual(crossZone.json(), { valid: false, reason: "MISMATCH" });

    const zoneOneRotation = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "zone-player", serverId: 1 },
    });
    const rotated = zoneOneRotation.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>();
    const staleZoneOne = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: zoneOne.accessToken, serverId: 1 },
    });
    assert.deepEqual(staleZoneOne.json(), { valid: false, reason: "MISMATCH" });
    const rotatedVerified = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: rotated.accessToken, serverId: 1 },
    });
    assert.equal(rotatedVerified.json().valid, true);
    assert.equal(Number(rotatedVerified.json().issuedAtMs) > firstIssuedAtMs, true);
    const zoneTwoStillValid = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: zoneTwo.accessToken, serverId: 2 },
    });
    assert.equal(zoneTwoStillValid.json().valid, true);

    const identities = new Map<string, WechatExchangeResult>([
      ["backfill-empty", {
        ok: true,
        openid: "wx_backfill",
        unionid: null,
        sessionKey: "session-backfill-1",
      }],
      ["backfill-union", {
        ok: true,
        openid: "wx_backfill",
        unionid: "union_backfill",
        sessionKey: "session-backfill-2",
      }],
      ["dual-a-empty", {
        ok: true,
        openid: "wx_dual_a",
        unionid: null,
        sessionKey: "session-dual-a-1",
      }],
      ["dual-b-union", {
        ok: true,
        openid: "wx_dual_b",
        unionid: "union_shared",
        sessionKey: "session-dual-b",
      }],
      ["dual-a-collision", {
        ok: true,
        openid: "wx_dual_a",
        unionid: "union_shared",
        sessionKey: "session-dual-a-2",
      }],
    ]);
    const fakeWechat: WechatIdentityClient = {
      async exchange(code: string): Promise<WechatExchangeResult> {
        return identities.get(code) ?? { ok: false, reason: "wx_invalid" };
      },
    };
    const domainLogin = new LoginService(
      runtime.database,
      new SessionService(runtime.database.pool),
      fakeWechat,
      new TokenBucketLimiter(100, 100),
    );
    const attempt = (rateKey: string) => ({
      rateKey,
      ip: "127.0.0.1",
      deviceId: null,
      serverId: 3,
    });
    assert.equal((await domainLogin.loginWechat(
      "backfill-empty",
      attempt("backfill-empty"),
    )).ok, true);
    assert.equal((await domainLogin.loginWechat(
      "backfill-union",
      attempt("backfill-union"),
    )).ok, true);
    const [backfilled] = await runtime.database.pool.query<RowDataPacket[]>(
      "SELECT unionid FROM accounts WHERE openid = 'wx_backfill'",
    );
    assert.equal(backfilled[0]?.unionid, "union_backfill");

    assert.equal((await domainLogin.loginWechat(
      "dual-a-empty",
      attempt("dual-a-empty"),
    )).ok, true);
    assert.equal((await domainLogin.loginWechat(
      "dual-b-union",
      attempt("dual-b-union"),
    )).ok, true);
    assert.equal((await domainLogin.loginWechat(
      "dual-a-collision",
      attempt("dual-a-collision"),
    )).ok, true);
    const [dualAudit] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count
         FROM login_audit
        WHERE event = 'login_dual_account'`,
    );
    assert.equal(Number(dualAudit[0]?.count), 1);

    await insertAudit(runtime.database.pool, {
      userId: null,
      event: "e".repeat(100),
      operator: "o".repeat(100),
      caller: "c".repeat(100),
      reason: "r".repeat(400),
      ip: "invalid-ip",
      deviceId: "d".repeat(100),
    });
    const [clampedAudit] = await runtime.database.pool.query<RowDataPacket[]>(
      `SELECT CHAR_LENGTH(event) AS event_len,
              CHAR_LENGTH(\`operator\`) AS operator_len,
              CHAR_LENGTH(caller) AS caller_len,
              CHAR_LENGTH(reason) AS reason_len,
              CHAR_LENGTH(device_id) AS device_len,
              ip IS NULL AS ip_is_null
         FROM login_audit
        ORDER BY id DESC
        LIMIT 1`,
    );
    assert.deepEqual(
      {
        event: Number(clampedAudit[0]?.event_len),
        operator: Number(clampedAudit[0]?.operator_len),
        caller: Number(clampedAudit[0]?.caller_len),
        reason: Number(clampedAudit[0]?.reason_len),
        device: Number(clampedAudit[0]?.device_len),
        ipIsNull: Number(clampedAudit[0]?.ip_is_null),
      },
      {
        event: 24,
        operator: 64,
        caller: 64,
        reason: 255,
        device: 64,
        ipIsNull: 1,
      },
    );

    const firstLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "integration-player", serverId: 1, deviceId: "test-device" },
    });
    assert.equal(firstLogin.statusCode, 200, firstLogin.body);
    const first = firstLogin.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>();
    assert.match(first.userId, /^u_[0-9]+$/);
    assert.equal(first.isNewAccount, true);

    const verified = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: first.accessToken, serverId: 1 },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().valid, true);
    assert.equal(verified.json().userId, first.userId);

    const register = await internalApp.inject({
      method: "PUT",
      url: `/v1/internal/characters/${first.userId}/1`,
      headers: serviceHeaders,
    });
    assert.equal(register.statusCode, 200, register.body);
    assert.deepEqual(register.json(), { registered: true });
    const registerReplay = await internalApp.inject({
      method: "PUT",
      url: `/v1/internal/characters/${first.userId}/1`,
      headers: serviceHeaders,
    });
    assert.equal(registerReplay.statusCode, 200);

    const hasCharacter = await internalApp.inject({
      method: "GET",
      url: `/v1/internal/characters/${first.userId}/1`,
      headers: serviceHeaders,
    });
    assert.equal(hasCharacter.statusCode, 200);
    assert.deepEqual(hasCharacter.json(), { exists: true });

    const areas = await publicApp.inject({
      method: "GET",
      url: "/v1/areas",
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    assert.equal(areas.statusCode, 200);
    assert.deepEqual(areas.json().myServerIds, [1]);

    const adminHeaders = {
      "x-operator-id": "gm-integration",
      "x-admin-secret": "integration-admin",
    };
    const revokePayload = { operationId: "integration-revoke-1", reason: "integration test" };
    const revoke = await internalApp.inject({
      method: "POST",
      url: `/v1/admin/accounts/${first.userId}/revoke`,
      headers: adminHeaders,
      payload: revokePayload,
    });
    assert.equal(revoke.statusCode, 200);
    assert.deepEqual(revoke.json(), { accountExists: true, status: "revoked" });
    const revokeReplay = await internalApp.inject({
      method: "POST",
      url: `/v1/admin/accounts/${first.userId}/revoke`,
      headers: adminHeaders,
      payload: revokePayload,
    });
    assert.equal(revokeReplay.statusCode, 200);
    assert.deepEqual(revokeReplay.json(), revoke.json());

    const operationConflict = await internalApp.inject({
      method: "POST",
      url: `/v1/admin/accounts/${first.userId}/ban`,
      headers: adminHeaders,
      payload: revokePayload,
    });
    assert.equal(operationConflict.statusCode, 409);
    assert.equal(operationConflict.json().code, "OPERATION_CONFLICT");

    const revokedVerify = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: first.accessToken, serverId: 1 },
    });
    assert.deepEqual(revokedVerify.json(), { valid: false, reason: "MISMATCH" });

    const secondLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "integration-player", serverId: 1 },
    });
    assert.equal(secondLogin.statusCode, 200);
    const second = secondLogin.json<{
      userId: string;
      accessToken: string;
      isNewAccount: boolean;
    }>();
    assert.equal(second.userId, first.userId);
    assert.equal(second.isNewAccount, false);

    const banPayload = { operationId: "integration-ban-1", reason: "integration test" };
    const ban = await internalApp.inject({
      method: "POST",
      url: `/v1/admin/accounts/${first.userId}/ban`,
      headers: adminHeaders,
      payload: banPayload,
    });
    assert.equal(ban.statusCode, 200);
    assert.deepEqual(ban.json(), { accountExists: true, status: "banned" });
    const banReplay = await internalApp.inject({
      method: "POST",
      url: `/v1/admin/accounts/${first.userId}/ban`,
      headers: adminHeaders,
      payload: banPayload,
    });
    assert.equal(banReplay.statusCode, 200);
    assert.deepEqual(banReplay.json(), ban.json());

    const bannedVerify = await internalApp.inject({
      method: "POST",
      url: "/v1/internal/sessions/verify",
      headers: serviceHeaders,
      payload: { accessToken: second.accessToken, serverId: 1 },
    });
    assert.equal(bannedVerify.statusCode, 200);
    assert.deepEqual(bannedVerify.json(), { valid: false, reason: "BANNED" });

    const bannedLogin = await publicApp.inject({
      method: "POST",
      url: "/v1/sessions/dev",
      payload: { devKey: "integration-player", serverId: 1 },
    });
    assert.equal(bannedLogin.statusCode, 403);
    assert.equal(bannedLogin.json().code, "ACCOUNT_BANNED");
  } finally {
    if (runtime) {
      await Promise.all([
        runtime.apps.publicApp.close(),
        runtime.apps.internalApp.close(),
      ]).catch(() => undefined);
      await runtime.database.close().catch(() => undefined);
    }
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
