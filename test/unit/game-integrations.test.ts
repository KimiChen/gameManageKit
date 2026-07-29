import assert from "node:assert/strict";
import test from "node:test";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import {
  type ConfigurationAuthorization,
  type GameIntegrationDatabase,
  type GameIntegrationRuntime,
  GameIntegrationService,
  type IdentityProvider,
} from "../../src/domain/game/integrations.js";
import { GameManageKitError } from "../../src/errors.js";
import { MetricsRegistry } from "../../src/infra/observability/metrics.js";

interface StoredIntegration {
  game_id: string;
  configuration_state: "draft" | "configured";
  status: "enabled" | "maintenance" | "disabled";
  client_visible: number;
  session_ttl_seconds: number;
  login_rate_capacity: number;
  login_rate_refill_per_second: number;
  admin_rate_capacity: number;
  admin_rate_refill_per_second: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface StoredProvider {
  game_id: string;
  provider: IdentityProvider;
  enabled: number;
  app_id: string | null;
  app_secret: string | null;
  secret_version: number;
  secret_updated_at: Date | null;
  endpoint: string;
  timeout_ms: number;
  breaker_threshold: number;
  breaker_open_ms: number;
  validation_state: "unvalidated" | "active" | "validation_failed";
  validation_failed_at: Date | null;
  validation_error_code: string | null;
  updated_by: string | null;
  updated_at: Date;
}

interface StoredOperation {
  operation_id: string;
  operator_id: string;
  game_id: string;
  provider: IdentityProvider;
  identity_id: null;
  secret_kind: "identity_provider_secret";
  action: "set" | "rotate" | "clear";
  old_version: number | null;
  new_version: number | null;
  revision: number;
  request_digest: Uint8Array;
  result_configuration_state: "draft" | "configured";
  result_revision: number;
  result_secret_updated_at: Date | null;
  created_at: Date;
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function providerKey(gameId: string, provider: IdentityProvider): string {
  return `${gameId}\0${provider}`;
}

class FakeIntegrationDatabase implements GameIntegrationDatabase {
  readonly integrations = new Map<string, StoredIntegration>();
  readonly providers = new Map<string, StoredProvider>();
  readonly operations = new Map<string, StoredOperation>();
  readonly identities = new Set<string>();
  readonly gameAudits: Array<readonly unknown[]> = [];
  readonly secretAudits: Array<readonly unknown[]> = [];
  nextGameAuditFailure: Error | null = null;
  private tick = 0;

  readonly pool = {} as Pool;

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

  seed(): void {
    const now = new Date("2026-07-28T00:00:00.000Z");
    this.integrations.set("game-a", {
      game_id: "game-a",
      configuration_state: "configured",
      status: "enabled",
      client_visible: 1,
      session_ttl_seconds: 86_400,
      login_rate_capacity: 20,
      login_rate_refill_per_second: 2,
      admin_rate_capacity: 10,
      admin_rate_refill_per_second: 1,
      revision: 1,
      created_at: now,
      updated_at: now,
    });
    this.providers.set(providerKey("game-a", "wechat"), {
      game_id: "game-a",
      provider: "wechat",
      enabled: 1,
      app_id: "wx-app",
      app_secret: "stored-wechat-secret",
      secret_version: 3,
      secret_updated_at: now,
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
      timeout_ms: 3_000,
      breaker_threshold: 5,
      breaker_open_ms: 10_000,
      validation_state: "active",
      validation_failed_at: null,
      validation_error_code: null,
      updated_by: "ops_config",
      updated_at: now,
    });
    this.providers.set(providerKey("game-a", "douyin"), {
      game_id: "game-a",
      provider: "douyin",
      enabled: 0,
      app_id: null,
      app_secret: null,
      secret_version: 0,
      secret_updated_at: null,
      endpoint:
        "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
      timeout_ms: 3_000,
      breaker_threshold: 5,
      breaker_open_ms: 10_000,
      validation_state: "unvalidated",
      validation_failed_at: null,
      validation_error_code: null,
      updated_by: null,
      updated_at: now,
    });
  }

  private now(): Date {
    this.tick += 1;
    return new Date(Date.parse("2026-07-28T00:00:00.000Z") + this.tick);
  }

  private provider(gameId: unknown, provider: unknown): StoredProvider {
    const stored = this.providers.get(
      providerKey(String(gameId), String(provider) as IdentityProvider),
    );
    if (!stored) {
      throw new Error("测试 Provider 缺失");
    }
    return stored;
  }

  private async query(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[RowDataPacket[], unknown]> {
    const sql = compact(rawSql);
    if (sql.includes("FROM admin_secret_operations")) {
      const operation = this.operations.get(String(values[0]));
      return [[...(operation ? [operation] : [])] as RowDataPacket[], []];
    }
    if (sql.includes("FROM account_identities")) {
      const key = providerKey(
        String(values[0]),
        String(values[1]) as IdentityProvider,
      );
      return [[...(
        this.identities.has(key) ? [{ id: 1 }] : []
      )] as RowDataPacket[], []];
    }
    if (
      sql.startsWith("SELECT app_secret, secret_version")
      && sql.includes("FROM game_identity_providers")
    ) {
      const provider = this.providers.get(providerKey(
        String(values[0]),
        String(values[1]) as IdentityProvider,
      ));
      return [[...(provider ? [provider] : [])] as RowDataPacket[], []];
    }
    if (
      sql.includes("EXISTS (")
      && sql.includes("FROM game_identity_providers AS provider")
    ) {
      const integration = this.integrations.get(String(values[0]));
      if (!integration) {
        return [[], []];
      }
      const configured = [...this.providers.values()].some((provider) => (
        provider.game_id === integration.game_id
        && provider.enabled === 1
        && provider.app_id !== null
        && provider.app_secret !== null
      ));
      return [[{
        configuration_state: integration.configuration_state,
        provider_configured: configured ? 1 : 0,
      }] as RowDataPacket[], []];
    }
    if (sql.includes("FROM game_identity_providers")) {
      const gameId = String(values[0]);
      const rows = (["wechat", "douyin"] as const)
        .map((provider) => this.providers.get(providerKey(gameId, provider)))
        .filter((provider): provider is StoredProvider => Boolean(provider))
        .map((provider) => ({
          ...provider,
          secret_configured: provider.app_secret === null ? 0 : 1,
        }));
      return [[...rows] as RowDataPacket[], []];
    }
    if (
      sql.includes("FROM games AS g")
      && sql.includes("JOIN game_integrations AS i")
    ) {
      const integration = this.integrations.get(String(values[0]));
      return [[...(
        integration ? [integration] : []
      )] as RowDataPacket[], []];
    }
    if (sql.startsWith("SELECT game_id FROM games")) {
      const integration = this.integrations.get(String(values[0]));
      return [[...(
        integration ? [{ game_id: integration.game_id }] : []
      )] as RowDataPacket[], []];
    }
    throw new Error(`未实现 query: ${sql}`);
  }

  private async execute(
    rawSql: string,
    values: readonly unknown[],
  ): Promise<[Record<string, number>, unknown]> {
    const sql = compact(rawSql);
    if (
      sql.startsWith("UPDATE game_integrations")
      && sql.includes("session_ttl_seconds = ?")
    ) {
      const integration = this.integrations.get(String(values[5]));
      if (!integration || integration.revision !== Number(values[6])) {
        return [{ affectedRows: 0 }, []];
      }
      integration.session_ttl_seconds = Number(values[0]);
      integration.login_rate_capacity = Number(values[1]);
      integration.login_rate_refill_per_second = Number(values[2]);
      integration.admin_rate_capacity = Number(values[3]);
      integration.admin_rate_refill_per_second = Number(values[4]);
      integration.revision += 1;
      integration.updated_at = this.now();
      return [{ affectedRows: 1 }, []];
    }
    if (
      sql.startsWith("UPDATE game_integrations")
      && sql.includes("SET revision = revision + 1")
    ) {
      const integration = this.integrations.get(String(values[0]));
      if (!integration || integration.revision !== Number(values[1])) {
        return [{ affectedRows: 0 }, []];
      }
      integration.revision += 1;
      integration.updated_at = this.now();
      return [{ affectedRows: 1 }, []];
    }
    if (
      sql.startsWith("UPDATE game_identity_providers")
      && sql.includes("SET enabled = ?")
    ) {
      const provider = this.provider(values[7], values[8]);
      provider.enabled = Number(values[0]);
      provider.app_id = values[1] === null ? null : String(values[1]);
      provider.endpoint = String(values[2]);
      provider.timeout_ms = Number(values[3]);
      provider.breaker_threshold = Number(values[4]);
      provider.breaker_open_ms = Number(values[5]);
      provider.validation_state = "unvalidated";
      provider.validation_failed_at = null;
      provider.validation_error_code = null;
      provider.updated_by = String(values[6]);
      provider.updated_at = this.now();
      return [{ affectedRows: 1 }, []];
    }
    if (
      sql.startsWith("UPDATE game_identity_providers")
      && sql.includes("SET app_secret = ?")
    ) {
      const provider = this.provider(values[3], values[4]);
      provider.app_secret = String(values[0]);
      provider.secret_version = Number(values[1]);
      provider.validation_state = "unvalidated";
      provider.validation_failed_at = null;
      provider.validation_error_code = null;
      provider.updated_by = String(values[2]);
      provider.updated_at = this.now();
      provider.secret_updated_at = provider.updated_at;
      return [{ affectedRows: 1 }, []];
    }
    if (
      sql.startsWith("UPDATE game_identity_providers")
      && sql.includes("app_secret = NULL")
    ) {
      const provider = this.provider(values[1], values[2]);
      provider.enabled = 0;
      provider.app_secret = null;
      provider.secret_version = 0;
      provider.secret_updated_at = null;
      provider.validation_state = "unvalidated";
      provider.validation_failed_at = null;
      provider.validation_error_code = null;
      provider.updated_by = String(values[0]);
      provider.updated_at = this.now();
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("UPDATE games")) {
      const integration = this.integrations.get(String(values[0]));
      if (!integration) {
        return [{ affectedRows: 0 }, []];
      }
      if (sql.includes("configuration_state = 'configured'")) {
        integration.configuration_state = "configured";
      } else {
        integration.configuration_state = "draft";
        integration.status = integration.status === "disabled"
          ? "disabled"
          : "maintenance";
        integration.client_visible = 0;
      }
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_game_audit")) {
      const failure = this.nextGameAuditFailure;
      this.nextGameAuditFailure = null;
      if (failure) {
        throw failure;
      }
      this.gameAudits.push([...values]);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_secret_audit")) {
      this.secretAudits.push([...values]);
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("INSERT INTO admin_secret_operations")) {
      const operationId = String(values[0]);
      if (this.operations.has(operationId)) {
        throw Object.assign(new Error("duplicate"), { errno: 1062 });
      }
      this.operations.set(operationId, {
        operation_id: operationId,
        operator_id: String(values[1]),
        game_id: String(values[2]),
        provider: String(values[3]) as IdentityProvider,
        identity_id: null,
        secret_kind: "identity_provider_secret",
        action: String(values[4]) as StoredOperation["action"],
        old_version: values[5] === null ? null : Number(values[5]),
        new_version: values[6] === null ? null : Number(values[6]),
        revision: Number(values[7]),
        request_digest: values[8] as Uint8Array,
        result_configuration_state:
          String(values[9]) as StoredOperation["result_configuration_state"],
        result_revision: Number(values[10]),
        result_secret_updated_at:
          values[11] === null ? null : values[11] as Date,
        created_at: this.now(),
      });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`未实现 execute: ${sql}`);
  }
}

class FakeRuntime implements GameIntegrationRuntime {
  readonly invalidated: Array<Readonly<{
    gameId: string;
    provider: IdentityProvider | null | undefined;
  }>> = [];

  invalidate(
    gameId: string,
    provider?: IdentityProvider | null,
  ): void {
    this.invalidated.push({ gameId, provider });
  }

  loadedRevision(): Readonly<{ integration: number }> {
    return { integration: 1 };
  }
}

function authorization(kinds: string[] = []): ConfigurationAuthorization {
  return {
    operatorId: "ops_config",
    ip: "127.0.0.1",
    requestId: "request-1",
    async authorize(_connection, kind) {
      kinds.push(kind);
    },
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

test("Provider 配置只返回 Secret 元数据，并用共享 revision 记录审计和失效缓存", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const runtime = new FakeRuntime();
  const service = new GameIntegrationService(database, runtime, false);
  const kinds: string[] = [];

  const fetched = await service.get("game-a", authorization(kinds));
  assert.equal(fetched.providers.length, 2);
  assert.deepEqual(fetched.providers.map((provider) => provider.provider), [
    "wechat",
    "douyin",
  ]);
  assert.equal(JSON.stringify(fetched).includes("stored-wechat-secret"), false);
  assert.deepEqual(fetched.providers[0]?.secretMetadata, {
    configured: true,
    version: 3,
    updatedAt: "2026-07-28T00:00:00.000Z",
  });

  const updated = await service.updateShared("game-a", {
    sessionTtlSeconds: 172_800,
    loginRateCapacity: 25,
    loginRateRefillPerSecond: 3,
    adminRateCapacity: 12,
    adminRateRefillPerSecond: 2,
    revision: 1,
  }, authorization(kinds));
  assert.equal(updated.revision, 2);
  assert.equal(updated.sessionTtlSeconds, 172_800);
  assert.equal(database.gameAudits.length, 1);
  assert.deepEqual(runtime.invalidated, [{
    gameId: "game-a",
    provider: null,
  }]);
  assert.deepEqual(kinds, ["read", "write"]);
});

test("已登记游戏的配置审计故障保留原错误并记录指标", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const metrics = new MetricsRegistry();
  metrics.registerGame("game-a");
  const service = new GameIntegrationService(
    database,
    new FakeRuntime(),
    false,
    metrics,
  );
  const auditFailure = new Error("fixture configuration audit unavailable");
  database.nextGameAuditFailure = auditFailure;

  await assert.rejects(
    service.updateShared("game-a", {
      sessionTtlSeconds: 172_800,
      loginRateCapacity: 25,
      loginRateRefillPerSecond: 3,
      adminRateCapacity: 12,
      adminRateRefillPerSecond: 2,
      revision: 1,
    }, authorization()),
    (error) => error === auditFailure,
  );

  assert.match(
    metrics.renderPrometheus(["game-a"]),
    /game_manage_kit_audit_write_failures_total\{game_id="game-a",audit_type="admin"\} 1/u,
  );
  assert.equal(database.gameAudits.length, 1);
});

test("Provider 白名单、官方端点、启用完整性和已有身份 AppID 锁均在写入前拒绝", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const runtime = new FakeRuntime();
  const service = new GameIntegrationService(database, runtime, true);
  const douyin = database.providers.get(providerKey("game-a", "douyin"))!;

  await assert.rejects(
    service.updateProvider("game-a", "douyin", {
      enabled: true,
      appId: "douyin-app",
      endpoint: douyin.endpoint,
      timeoutMs: 3_000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      revision: 1,
    }, authorization()),
    gameError(400, "INVALID_PAYLOAD"),
  );
  await assert.rejects(
    service.updateProvider("game-a", "wechat", {
      enabled: true,
      appId: "wx-app",
      endpoint:
        "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session",
      timeoutMs: 3_000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      revision: 1,
    }, authorization()),
    gameError(400, "INVALID_PAYLOAD"),
  );
  await assert.rejects(
    service.updateProvider(
      "game-a",
      "unknown" as IdentityProvider,
      {
        enabled: false,
        appId: null,
        endpoint: "https://example.com/provider",
        timeoutMs: 3_000,
        breakerThreshold: 5,
        breakerOpenMs: 10_000,
        revision: 1,
      },
      authorization(),
    ),
    gameError(400, "INVALID_PAYLOAD"),
  );
  await assert.rejects(
    service.updateProvider("game-a", "wechat", {
      enabled: true,
      appId: "local",
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
      timeoutMs: 3_000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      revision: 1,
    }, authorization()),
    gameError(400, "INVALID_PAYLOAD"),
  );

  database.identities.add(providerKey("game-a", "wechat"));
  await assert.rejects(
    service.updateProvider("game-a", "wechat", {
      enabled: true,
      appId: "wx-new-app",
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
      timeoutMs: 3_000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      revision: 1,
    }, authorization()),
    gameError(409, "IDENTITY_PROVIDER_CONFLICT"),
  );
  await assert.rejects(
    service.updateProvider("game-a", "wechat", {
      enabled: false,
      appId: "wx-app",
      endpoint: "https://api.weixin.qq.com/sns/jscode2session",
      timeoutMs: 3_000,
      breakerThreshold: 5,
      breakerOpenMs: 10_000,
      revision: 99,
    }, authorization()),
    gameError(409, "GAME_PROJECT_CONFLICT"),
  );
  assert.equal(database.gameAudits.length, 5);
  assert.deepEqual(
    database.gameAudits.map((audit) => audit[5]),
    [
      "identity_provider_enable",
      "identity_provider_update",
      "identity_provider_update",
      "identity_provider_update",
      "identity_provider_disable",
    ],
  );
  for (const audit of database.gameAudits.slice(1, 3)) {
    assert.deepEqual(JSON.parse(String(audit[6])), {
      errorCode: "INVALID_PAYLOAD",
    });
  }
  assert.deepEqual(runtime.invalidated, []);
});

test("官方 Provider endpoint 规范化后与 production Resolver 一致", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const runtime = new FakeRuntime();
  const service = new GameIntegrationService(database, runtime, true);

  const updated = await service.updateProvider("game-a", "wechat", {
    enabled: true,
    appId: "wx-app",
    endpoint: "https://API.WEIXIN.QQ.COM:443/sns/jscode2session",
    timeoutMs: 3_000,
    breakerThreshold: 5,
    breakerOpenMs: 10_000,
    revision: 1,
  }, authorization());

  assert.equal(
    updated.providers[0]?.endpoint,
    "https://api.weixin.qq.com/sns/jscode2session",
  );
  assert.equal(
    updated.providers[0]?.secretMetadata.updatedAt,
    "2026-07-28T00:00:00.000Z",
  );
  assert.notEqual(
    updated.providers[0]?.updatedAt,
    updated.providers[0]?.secretMetadata.updatedAt,
  );
  assert.deepEqual(runtime.invalidated, [{
    gameId: "game-a",
    provider: "wechat",
  }]);
});

test("Provider Secret 替换按 set/rotate 幂等且从不进入响应或审计", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const runtime = new FakeRuntime();
  const service = new GameIntegrationService(database, runtime, false);
  const firstRequest = {
    appSecret: "douyin-secret-one",
    revision: 1,
    operationId: "douyin-set-1",
  };

  const issued = await service.replaceProviderSecret(
    "game-a",
    "douyin",
    firstRequest,
    authorization(),
  );
  assert.deepEqual(issued.secretMetadata, {
    configured: true,
    version: 1,
    updatedAt: "2026-07-28T00:00:00.001Z",
  });
  assert.equal(JSON.stringify(issued).includes(firstRequest.appSecret), false);
  assert.deepEqual(
    database.operations.get(firstRequest.operationId),
    {
      operation_id: "douyin-set-1",
      operator_id: "ops_config",
      game_id: "game-a",
      provider: "douyin",
      identity_id: null,
      secret_kind: "identity_provider_secret",
      action: "set",
      old_version: null,
      new_version: 1,
      revision: 1,
      request_digest:
        database.operations.get(firstRequest.operationId)?.request_digest,
      result_configuration_state: "configured",
      result_revision: 2,
      result_secret_updated_at: new Date("2026-07-28T00:00:00.001Z"),
      created_at: new Date("2026-07-28T00:00:00.003Z"),
    },
  );
  assert.equal(
    JSON.stringify(database.secretAudits).includes(firstRequest.appSecret),
    false,
  );

  const replayed = await service.replaceProviderSecret(
    "game-a",
    "douyin",
    firstRequest,
    authorization(),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.secretMetadata.version, 1);
  assert.equal(database.operations.size, 1);
  assert.equal(database.secretAudits.length, 1);
  assert.deepEqual(runtime.invalidated, [{
    gameId: "game-a",
    provider: "douyin",
  }]);

  const rotated = await service.replaceProviderSecret(
    "game-a",
    "douyin",
    {
      appSecret: "douyin-secret-two",
      revision: 2,
      operationId: "douyin-rotate-2",
    },
    authorization(),
  );
  assert.equal(rotated.secretMetadata.version, 2);
  assert.deepEqual(
    {
      action: database.operations.get("douyin-rotate-2")?.action,
      oldVersion: database.operations.get("douyin-rotate-2")?.old_version,
      newVersion: database.operations.get("douyin-rotate-2")?.new_version,
    },
    { action: "rotate", oldVersion: 1, newVersion: 2 },
  );

  const historicalReplay = await service.replaceProviderSecret(
    "game-a",
    "douyin",
    firstRequest,
    authorization(),
  );
  assert.deepEqual({
    replayed: historicalReplay.replayed,
    revision: historicalReplay.revision,
    version: historicalReplay.secretMetadata.version,
    updatedAt: historicalReplay.secretMetadata.updatedAt,
  }, {
    replayed: true,
    revision: 2,
    version: 1,
    updatedAt: "2026-07-28T00:00:00.001Z",
  });
  await assert.rejects(
    service.replaceProviderSecret("game-a", "douyin", {
      ...firstRequest,
      appSecret: "different-payload",
    }, authorization()),
    gameError(409, "OPERATION_CONFLICT"),
  );
});

test("清除 Secret 同时禁用 Provider、重算草稿状态并支持幂等重放", async () => {
  const database = new FakeIntegrationDatabase();
  database.seed();
  const runtime = new FakeRuntime();
  const service = new GameIntegrationService(database, runtime, false);
  const request = {
    revision: 1,
    operationId: "wechat-clear-1",
  };

  const cleared = await service.clearProviderSecret(
    "game-a",
    "wechat",
    request,
    authorization(),
  );
  assert.deepEqual(cleared.secretMetadata, {
    configured: false,
    version: 0,
    updatedAt: null,
  });
  assert.equal(cleared.configurationState, "draft");
  const provider = database.providers.get(
    providerKey("game-a", "wechat"),
  )!;
  assert.equal(provider.enabled, 0);
  assert.equal(provider.app_secret, null);
  assert.equal(provider.secret_version, 0);
  assert.equal(database.integrations.get("game-a")?.status, "maintenance");
  assert.equal(database.integrations.get("game-a")?.client_visible, 0);
  assert.deepEqual(
    {
      action: database.operations.get(request.operationId)?.action,
      oldVersion: database.operations.get(request.operationId)?.old_version,
      newVersion: database.operations.get(request.operationId)?.new_version,
    },
    { action: "clear", oldVersion: 3, newVersion: null },
  );

  const replayed = await service.clearProviderSecret(
    "game-a",
    "wechat",
    request,
    authorization(),
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.configurationState, "draft");
  assert.equal(database.operations.size, 1);
  assert.equal(database.secretAudits.length, 1);
  assert.deepEqual(runtime.invalidated, [{
    gameId: "game-a",
    provider: "wechat",
  }]);
});
