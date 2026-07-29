import assert from "node:assert/strict";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type {
  AuthExchangeResult,
  ExternalAuthProvider,
  IdentityProviderClient,
} from "../../src/domain/account/auth-provider.js";
import { LoginService } from "../../src/domain/account/login.js";
import type { GameContext } from "../../src/domain/game/resolver.js";
import { SessionService } from "../../src/domain/session/service.js";
import { Database } from "../../src/infra/mysql/database.js";
import { runMigrations } from "../../src/migrate.js";

function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function providerClient<Provider extends ExternalAuthProvider>(
  provider: Provider,
  providerAppId: string,
  subject: string,
  unionSubject: string | null = null,
): IdentityProviderClient<Provider> {
  return {
    provider,
    async exchange(): Promise<AuthExchangeResult<Provider>> {
      return {
        ok: true,
        provider,
        providerAppId,
        subject,
        unionSubject,
      };
    },
  };
}

function gameContext(
  wechat: IdentityProviderClient<"wechat">,
  douyin: IdentityProviderClient<"douyin"> = providerClient(
    "douyin",
    "dy-unused",
    "unused",
  ),
): GameContext {
  return {
    gameId: "identity-game",
    loginLimiter: { allow: () => true },
    wechat,
    douyin,
  } as unknown as GameContext;
}

function attempt(requestId: string) {
  return {
    rateKey: requestId,
    ip: "192.0.2.10",
    deviceId: `device-${requestId}`,
    requestId,
    serverId: 13,
  } as const;
}

type LoginSuccess = {
  readonly userId: string;
  readonly accessToken: string;
  readonly isNewAccount: boolean;
};

function requireSuccess(
  result: Awaited<ReturnType<LoginService["loginWechat"]>>,
): LoginSuccess {
  if (!result.ok) {
    assert.fail(`登录失败: ${result.reason}`);
  }
  return result.response;
}

test("身份事务隔离 Provider/AppID、补绑 unionid 并收敛并发首次登录", async () => {
  const adminUrl = process.env.GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL
    ?? "mysql://root@127.0.0.1:3316/mysql";
  const databaseName =
    `game_manage_kit_account_login_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^[a-z0-9_]+$/u);

  const admin = await mysql.createConnection(adminUrl);
  const mysqlUrl = databaseUrl(adminUrl, databaseName);
  let database: Database | undefined;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await runMigrations(mysqlUrl);
    database = new Database(mysqlUrl, 16);
    await database.pool.query(
      `INSERT INTO games (game_id, name)
       VALUES ('identity-game', 'Identity Test')`,
    );
    await database.pool.query(
      `INSERT INTO seq (game_id, name, val)
       VALUES ('identity-game', 'user_id', 0)`,
    );
    await database.pool.query(
      `INSERT INTO game_integrations (game_id)
       VALUES ('identity-game')`,
    );
    await database.pool.query(
      `INSERT INTO game_identity_providers
         (game_id, provider, enabled, app_id, app_secret,
          secret_version, secret_updated_at, endpoint)
       VALUES
         ('identity-game', 'wechat', 1, 'wx-app-a',
          'wechat-secret', 1, NOW(3),
          'https://api.weixin.qq.com/sns/jscode2session'),
         ('identity-game', 'douyin', 1, 'dy-app-a',
          'douyin-secret', 1, NOW(3),
          'https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session')`,
    );

    const login = new LoginService(
      database,
      new SessionService(database.pool),
    );

    const sameWechat = gameContext(
      providerClient("wechat", "wx-app-a", "same-subject"),
    );
    const first = requireSuccess(
      await login.loginWechat(sameWechat, "code-1", attempt("same-1")),
    );
    const repeated = requireSuccess(
      await login.loginWechat(sameWechat, "code-2", attempt("same-2")),
    );
    assert.equal(first.isNewAccount, true);
    assert.equal(repeated.isNewAccount, false);
    assert.equal(repeated.userId, first.userId);

    const douyinSameSubject = gameContext(
      providerClient("wechat", "wx-unused", "unused"),
      providerClient("douyin", "dy-app-a", "same-subject"),
    );
    const douyin = requireSuccess(
      await login.loginDouyin(
        douyinSameSubject,
        "douyin-code",
        attempt("douyin-same"),
      ),
    );
    await database.pool.query(
      `UPDATE game_identity_providers
          SET app_id = 'wx-app-b'
        WHERE game_id = 'identity-game' AND provider = 'wechat'`,
    );
    const otherWechatApp = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient("wechat", "wx-app-b", "same-subject"),
        ),
        "wechat-other-app-code",
        attempt("wechat-other-app"),
      ),
    );
    assert.notEqual(douyin.userId, first.userId);
    assert.notEqual(otherWechatApp.userId, first.userId);
    assert.notEqual(otherWechatApp.userId, douyin.userId);
    await database.pool.query(
      `UPDATE game_identity_providers
          SET app_id = 'wx-app-a'
        WHERE game_id = 'identity-game' AND provider = 'wechat'`,
    );

    const unionFirst = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient(
            "wechat",
            "wx-app-a",
            "union-openid-first",
            "shared-unionid",
          ),
        ),
        "union-code-1",
        attempt("union-1"),
      ),
    );
    const unionBackfill = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient(
            "wechat",
            "wx-app-a",
            "union-openid-second",
            "shared-unionid",
          ),
        ),
        "union-code-2",
        attempt("union-2"),
      ),
    );
    assert.equal(unionBackfill.userId, unionFirst.userId);
    assert.equal(unionBackfill.isNewAccount, false);
    const [unionIdentities] = await database.pool.query<RowDataPacket[]>(
      `SELECT subject_type, subject, user_id
         FROM account_identities
        WHERE game_id = 'identity-game'
          AND provider = 'wechat'
          AND provider_app_id = 'wx-app-a'
          AND subject IN (
            'union-openid-first',
            'union-openid-second',
            'shared-unionid'
          )
        ORDER BY subject`,
    );
    assert.equal(unionIdentities.length, 3);
    assert.deepEqual(
      new Set(unionIdentities.map((row) => String(row.user_id))),
      new Set([unionFirst.userId]),
    );
    await database.pool.query(
      `UPDATE account_identities
          SET last_login_at = NULL
        WHERE game_id = 'identity-game'
          AND provider = 'wechat'
          AND provider_app_id = 'wx-app-a'
          AND subject IN (
            'union-openid-first',
            'union-openid-second',
            'shared-unionid'
          )`,
    );
    const unionRepeated = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient(
            "wechat",
            "wx-app-a",
            "union-openid-second",
            "shared-unionid",
          ),
        ),
        "union-code-3",
        attempt("union-3"),
      ),
    );
    assert.equal(unionRepeated.userId, unionFirst.userId);
    const [identityLoginTimes] =
      await database.pool.query<RowDataPacket[]>(
        `SELECT subject, last_login_at
           FROM account_identities
          WHERE game_id = 'identity-game'
            AND provider = 'wechat'
            AND provider_app_id = 'wx-app-a'
            AND subject IN (
              'union-openid-first',
              'union-openid-second',
              'shared-unionid'
            )`,
      );
    const lastLoginBySubject = new Map(
      identityLoginTimes.map((row) => [
        String(row.subject),
        row.last_login_at,
      ]),
    );
    assert.equal(lastLoginBySubject.get("union-openid-first"), null);
    assert.notEqual(lastLoginBySubject.get("union-openid-second"), null);
    assert.notEqual(lastLoginBySubject.get("shared-unionid"), null);

    const conflictPrimary = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient("wechat", "wx-app-a", "conflict-openid"),
        ),
        "conflict-code-primary",
        attempt("conflict-primary"),
      ),
    );
    const conflictUnion = requireSuccess(
      await login.loginWechat(
        gameContext(
          providerClient(
            "wechat",
            "wx-app-a",
            "other-openid",
            "conflict-unionid",
          ),
        ),
        "conflict-code-union",
        attempt("conflict-union"),
      ),
    );
    assert.notEqual(conflictPrimary.userId, conflictUnion.userId);
    const conflicting = await login.loginWechat(
      gameContext(
        providerClient(
          "wechat",
          "wx-app-a",
          "conflict-openid",
          "conflict-unionid",
        ),
      ),
      "conflict-code",
      attempt("identity-conflict"),
    );
    assert.deepEqual(conflicting, {
      ok: false,
      reason: "identity_conflict",
    });
    const [conflictAudit] = await database.pool.query<RowDataPacket[]>(
      `SELECT provider, outcome, user_id, reason
         FROM login_audit
        WHERE game_id = 'identity-game'
          AND request_id = 'identity-conflict'`,
    );
    assert.deepEqual({
      provider: String(conflictAudit[0]?.provider),
      outcome: String(conflictAudit[0]?.outcome),
      userId: conflictAudit[0]?.user_id,
      reason: String(conflictAudit[0]?.reason),
    }, {
      provider: "wechat",
      outcome: "identity_conflict",
      userId: null,
      reason: "identity_conflict",
    });
    const [conflictIdentities] =
      await database.pool.query<RowDataPacket[]>(
        `SELECT subject, user_id
           FROM account_identities
          WHERE game_id = 'identity-game'
            AND provider = 'wechat'
            AND provider_app_id = 'wx-app-a'
            AND subject IN ('conflict-openid', 'conflict-unionid')
          ORDER BY subject`,
      );
    assert.deepEqual(
      conflictIdentities.map((row) => [
        String(row.subject),
        String(row.user_id),
      ]),
      [
        ["conflict-openid", conflictPrimary.userId],
        ["conflict-unionid", conflictUnion.userId],
      ],
    );

    const concurrentResults = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        return login.loginWechat(
          gameContext(
            providerClient("wechat", "wx-app-a", "concurrent-openid"),
          ),
          `concurrent-code-${index}`,
          attempt(`concurrent-${index}`),
        );
      }),
    );
    const concurrentSuccesses = concurrentResults.map(requireSuccess);
    assert.equal(
      new Set(concurrentSuccesses.map((result) => result.userId)).size,
      1,
    );
    assert.equal(
      concurrentSuccesses.filter((result) => result.isNewAccount).length,
      1,
    );
    const [concurrentState] = await database.pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*)
            FROM account_identities
           WHERE game_id = 'identity-game'
             AND provider = 'wechat'
             AND provider_app_id = 'wx-app-a'
             AND subject_type = 'openid'
             AND subject = 'concurrent-openid') AS identity_count,
         (SELECT COUNT(DISTINCT a.user_id)
            FROM accounts AS a
            JOIN account_identities AS i
              ON i.game_id = a.game_id AND i.user_id = a.user_id
           WHERE i.game_id = 'identity-game'
             AND i.provider = 'wechat'
             AND i.provider_app_id = 'wx-app-a'
             AND i.subject_type = 'openid'
             AND i.subject = 'concurrent-openid') AS account_count`,
    );
    assert.deepEqual({
      identityCount: Number(concurrentState[0]?.identity_count),
      accountCount: Number(concurrentState[0]?.account_count),
    }, {
      identityCount: 1,
      accountCount: 1,
    });

    const concurrentUnionResults = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        return login.loginWechat(
          gameContext(
            providerClient(
              "wechat",
              "wx-app-a",
              `concurrent-union-openid-${index}`,
              "concurrent-shared-unionid",
            ),
          ),
          `concurrent-union-code-${index}`,
          attempt(`concurrent-union-${index}`),
        );
      }),
    );
    const concurrentUnionSuccesses =
      concurrentUnionResults.map(requireSuccess);
    assert.equal(
      new Set(
        concurrentUnionSuccesses.map((result) => result.userId),
      ).size,
      1,
    );
    assert.equal(
      concurrentUnionSuccesses.filter(
        (result) => result.isNewAccount,
      ).length,
      1,
    );
    const [concurrentUnionState] =
      await database.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS identity_count,
                COUNT(DISTINCT user_id) AS account_count
           FROM account_identities
          WHERE game_id = 'identity-game'
            AND provider = 'wechat'
            AND provider_app_id = 'wx-app-a'
            AND (
              subject = 'concurrent-shared-unionid'
              OR subject LIKE 'concurrent-union-openid-%'
            )`,
      );
    assert.deepEqual({
      identityCount: Number(concurrentUnionState[0]?.identity_count),
      accountCount: Number(concurrentUnionState[0]?.account_count),
    }, {
      identityCount: 9,
      accountCount: 1,
    });

    const devFirst = requireSuccess(
      await login.loginDev(
        sameWechat,
        "same-subject",
        attempt("dev-1"),
      ),
    );
    const devRepeated = requireSuccess(
      await login.loginDev(
        sameWechat,
        "same-subject",
        attempt("dev-2"),
      ),
    );
    assert.notEqual(devFirst.userId, first.userId);
    assert.equal(devRepeated.userId, devFirst.userId);
    assert.equal(devFirst.isNewAccount, true);
    assert.equal(devRepeated.isNewAccount, false);
    const [devIdentity] = await database.pool.query<RowDataPacket[]>(
      `SELECT provider, provider_app_id, subject_type, subject, user_id
         FROM account_identities
        WHERE game_id = 'identity-game'
          AND provider = 'dev'
          AND provider_app_id = 'local'
          AND subject_type = 'dev_key'
          AND subject = 'same-subject'`,
    );
    assert.deepEqual({
      provider: String(devIdentity[0]?.provider),
      providerAppId: String(devIdentity[0]?.provider_app_id),
      subjectType: String(devIdentity[0]?.subject_type),
      subject: String(devIdentity[0]?.subject),
      userId: String(devIdentity[0]?.user_id),
    }, {
      provider: "dev",
      providerAppId: "local",
      subjectType: "dev_key",
      subject: "same-subject",
      userId: devFirst.userId,
    });

    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const staleLogin = login.loginWechat(
      gameContext({
        provider: "wechat",
        async exchange() {
          markExchangeStarted();
          await release;
          return {
            ok: true,
            provider: "wechat",
            providerAppId: "wx-app-a",
            providerVersion: 1,
            subject: "stale-app-id-subject",
            unionSubject: null,
          };
        },
      }),
      "stale-app-id-code",
      attempt("stale-app-id"),
    );
    await exchangeStarted;
    await database.pool.query(
      `UPDATE game_identity_providers
          SET app_id = 'wx-app-raced'
        WHERE game_id = 'identity-game' AND provider = 'wechat'`,
    );
    releaseExchange();
    assert.deepEqual(await staleLogin, {
      ok: false,
      reason: "unavailable",
    });
    const [staleAudit] = await database.pool.query<RowDataPacket[]>(
      `SELECT outcome, reason, provider_version
         FROM login_audit
        WHERE game_id = 'identity-game'
          AND request_id = 'stale-app-id'`,
    );
    assert.deepEqual({
      outcome: String(staleAudit[0]?.outcome),
      reason: String(staleAudit[0]?.reason),
      providerVersion: Number(staleAudit[0]?.provider_version),
    }, {
      outcome: "provider_unavailable",
      reason: "provider_configuration_changed",
      providerVersion: 1,
    });
    const [staleIdentity] = await database.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS identity_count
         FROM account_identities
        WHERE game_id = 'identity-game'
          AND provider = 'wechat'
          AND subject = 'stale-app-id-subject'`,
    );
    assert.equal(Number(staleIdentity[0]?.identity_count), 0);
    await database.pool.query(
      `UPDATE game_identity_providers
          SET app_id = 'wx-app-a'
        WHERE game_id = 'identity-game' AND provider = 'wechat'`,
    );

    const failingLogin = new LoginService(
      database,
      {
        async issue() {
          throw new Error("fixture session issue failure");
        },
      } as unknown as SessionService,
    );
    await assert.rejects(
      failingLogin.loginWechat(
        gameContext(
          providerClient(
            "wechat",
            "wx-app-a",
            "session-issue-failure",
          ),
        ),
        "session-issue-code",
        attempt("session-issue-failure"),
      ),
      /fixture session issue failure/u,
    );
    const [internalFailureAudit] =
      await database.pool.query<RowDataPacket[]>(
        `SELECT provider, outcome, reason, user_id
           FROM login_audit
          WHERE game_id = 'identity-game'
            AND request_id = 'session-issue-failure'`,
      );
    assert.deepEqual({
      provider: String(internalFailureAudit[0]?.provider),
      outcome: String(internalFailureAudit[0]?.outcome),
      reason: String(internalFailureAudit[0]?.reason),
      userId: internalFailureAudit[0]?.user_id,
    }, {
      provider: "wechat",
      outcome: "internal_error",
      reason: "internal_error",
      userId: null,
    });
    const [rolledBackIdentity] =
      await database.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS identity_count
           FROM account_identities
          WHERE game_id = 'identity-game'
            AND provider = 'wechat'
            AND provider_app_id = 'wx-app-a'
            AND subject = 'session-issue-failure'`,
      );
    assert.equal(Number(rolledBackIdentity[0]?.identity_count), 0);
  } finally {
    await database?.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});
