import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AdminApiError,
  InvalidApiPayloadError,
  accountStatusPresentation,
  accountPath,
  canPublishGameToClient,
  canPerformAccountAction,
  canSelectGameStatus,
  chooseAdminView,
  chooseInitialGame,
  configurationAuditPath,
  createConfigurationOperationId,
  createLatestRequestGuard,
  createAdminApi,
  createOperationIntent,
  dateTimeLocalToUnixSeconds,
  describeApiError,
  directorySettingsPath,
  gameIntegrationPath,
  gameProjectPath,
  gameServerPath,
  isSessionExpired,
  isCompletedLogout,
  isValidAdminDisplayNameInput,
  isValidAdminPasswordInput,
  isValidUserId,
  machineIdentityPath,
  machineSecretRevokePath,
  machineSecretRotationPath,
  normalizeAccount,
  normalizeBootstrapStatus,
  normalizeConfigurationAuditPage,
  normalizeDirectorySettings,
  normalizeGameIntegration,
  normalizeGameProject,
  normalizeGameProjectList,
  normalizeGameServer,
  normalizeGameServerList,
  normalizeMachineIdentity,
  normalizeMachineIdentityList,
  normalizeMachineSecretIssued,
  normalizeMachineSecretOperationStatus,
  normalizeMachineSecretRevoked,
  normalizeOperationResult,
  normalizeSession,
  normalizeWechatSecretMetadata,
  normalizeWechatSecretWrite,
  reuseOrCreateOperationIntent,
  unixSecondsToDateTimeLocal,
  wechatAppSecretPath,
} from "../../web/admin/app.js";
import { resetPasswordControl } from "../../web/admin/wsk.js";

const artifactUrl = (name) => new URL(`../../web/admin/${name}`, import.meta.url);

function jsonResponse(body, {
  status = 200,
  headers = {},
} = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const validSession = () => ({
  operator: {
    operatorId: "ops_kimi",
    displayName: "Kimi",
  },
  games: [
    {
      gameId: "game-a",
      name: "游戏 A",
      status: "enabled",
      canOperateAccounts: true,
    },
    {
      gameId: "game-b",
      name: "游戏 B",
      status: "maintenance",
      canOperateAccounts: false,
    },
  ],
  canManageGames: true,
  canManageIntegrations: true,
  canRotateSecrets: true,
  canManageMachineIdentities: true,
  expiresAt: "2026-07-28T18:00:00.000Z",
  elevatedUntil: "2026-07-28T17:30:00.000Z",
});

const validGameProject = (overrides = {}) => ({
  gameId: "game-a",
  name: "游戏 A",
  description: "示例游戏项目",
  status: "enabled",
  configurationState: "configured",
  clientVisible: true,
  sortOrder: 10,
  revision: 3,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  ...overrides,
});

const validGameServer = (overrides = {}) => ({
  gameId: "game-a",
  serverId: 1,
  name: "星海一区",
  tag: "new",
  status: "smooth",
  openTime: 1_785_220_200,
  gameHttpUrl: "https://game.example.com/api",
  gameWsUrl: "wss://game.example.com/socket",
  isOpen: true,
  sortOrder: 10,
  revision: 3,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  ...overrides,
});

const validIntegration = (overrides = {}) => ({
  gameId: "game-a",
  configurationState: "configured",
  wechatAppId: "wx-game-a",
  wechatSecret: {
    configured: true,
    version: 2,
    state: "active",
    updatedAt: "2026-07-28T10:00:00.000Z",
  },
  wechatEndpoint: "https://api.weixin.qq.com/sns/jscode2session",
  wechatTimeoutMs: 2_000,
  wechatBreakerThreshold: 4,
  wechatBreakerOpenMs: 5_000,
  sessionTtlSeconds: 7_200,
  loginRateCapacity: 40,
  loginRateRefillPerSecond: 2.5,
  adminRateCapacity: 20,
  adminRateRefillPerSecond: 1,
  revision: 3,
  loadedRevision: 3,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  ...overrides,
});

const validMachineIdentity = (overrides = {}) => ({
  identityId: "game-a-service",
  identityType: "service",
  displayName: "游戏 A 服务",
  status: "enabled",
  gameIds: ["game-a"],
  revision: 2,
  secretVersions: [
    {
      version: 2,
      state: "current",
      expiresAt: null,
      createdAt: "2026-07-28T10:00:00.000Z",
      activatedAt: "2026-07-28T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    },
  ],
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  ...overrides,
});

test("管理员页面只引用本地资源且不包含共享 Secret", async () => {
  const [html, wskCss, appJs, wskJs] = await Promise.all([
    readFile(artifactUrl("index.html"), "utf8"),
    readFile(artifactUrl("wsk.css"), "utf8"),
    readFile(artifactUrl("app.js"), "utf8"),
    readFile(artifactUrl("wsk.js"), "utf8"),
  ]);

  assert.match(html, /lang="zh-CN"/u);
  assert.match(html, /autocomplete="username"/u);
  assert.match(html, /autocomplete="current-password"/u);
  assert.match(
    html,
    /id="bootstrap-form"[\s\S]+?aria-labelledby="bootstrap-title"/u,
  );
  assert.match(
    html,
    /id="bootstrap-operator-id"[\s\S]+?pattern="\[a-z\]\[a-z0-9_.\\-\]\{2,63\}"/u,
  );
  assert.match(
    html,
    /id="bootstrap-password"[\s\S]+?autocomplete="new-password"/u,
  );
  assert.match(
    html,
    /id="bootstrap-password-confirm"[\s\S]+?autocomplete="new-password"/u,
  );
  assert.match(html, /id="bootstrap-error"[\s\S]+?role="alert"/u);
  assert.match(html, /id="operator-password"[\s\S]+?minlength="12"/u);
  assert.match(html, /id="operation-reason"[\s\S]+?maxlength="255"/u);
  assert.match(html, /aria-labelledby="operation-dialog-title"/u);
  assert.match(html, /href="#games"/u);
  assert.match(html, /id="game-dialog"[\s\S]+?aria-labelledby="game-dialog-title"/u);
  assert.match(html, /id="game-id"[\s\S]+?minlength="2"[\s\S]+?maxlength="32"/u);
  assert.match(html, /id="game-name"[\s\S]+?maxlength="256"/u);
  assert.match(html, /id="game-description"[\s\S]+?maxlength="1000"/u);
  assert.match(html, /id="game-client-visible"/u);
  assert.match(html, /id="game-sort-order"[\s\S]+?max="65535"/u);
  assert.match(html, /id="server-dialog"[\s\S]+?aria-labelledby="server-dialog-title"/u);
  assert.match(html, /id="server-id"[\s\S]+?max="65535"/u);
  assert.match(html, /id="server-name"[\s\S]+?maxlength="128"/u);
  assert.match(html, /id="server-open-time"[\s\S]+?type="datetime-local"/u);
  assert.match(html, /id="server-http-url"[\s\S]+?maxlength="2048"/u);
  assert.match(html, /id="server-ws-url"[\s\S]+?maxlength="2048"/u);
  assert.match(html, /未开放不下发且不可登录；维护中可下发但不可登录。/u);
  assert.match(html, /href="\/admin\/wsk\.css"/u);
  assert.match(html, /href="\/admin\/admin\.css"/u);
  assert.match(html, /src="\/admin\/app\.js"/u);
  assert.doesNotMatch(
    html,
    /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:\/\//iu,
  );

  const applicationSource = `${html}\n${appJs}\n${wskJs}`;
  assert.doesNotMatch(applicationSource, /x-admin-secret/iu);
  assert.doesNotMatch(applicationSource, /GAME_MANAGE_KIT_ADMIN_SECRET/u);
  assert.equal(
    [...applicationSource.matchAll(/localStorage\.(?:getItem|setItem)\(([^)]+)\)/gu)]
      .every((match) => match[1]?.includes("game-manage-kit-theme")),
    true,
  );
  assert.doesNotMatch(applicationSource, /sessionStorage/u);
  assert.doesNotMatch(
    appJs,
    /(?:localStorage|sessionStorage|replaceHash|toast)\s*\([^)]*(?:wechatAppSecret|oneTimeSecret|\.secret\b)/u,
  );
  assert.doesNotMatch(
    appJs,
    /(?:accountLiveStatus|gamesLiveStatus|serversLiveStatus)\.textContent\s*=\s*[^;]*(?:wechatAppSecret|oneTimeSecret|\.secret\b)/u,
  );

  assert.match(
    wskCss,
    /f920dc584db1cb8d1b3e4206a54e1f1eebe497eb/u,
  );
});

test("管理员初始化状态只接受单一布尔字段", () => {
  const required = normalizeBootstrapStatus({ required: true });
  assert.deepEqual(required, { required: true });
  assert.equal(Object.isFrozen(required), true);
  assert.deepEqual(
    normalizeBootstrapStatus({ required: false }),
    { required: false },
  );
  for (const payload of [
    null,
    {},
    { required: "yes" },
    { required: true, operatorId: "ops_kimi" },
    { required: true, password: "must-not-leak" },
  ]) {
    assert.throws(
      () => normalizeBootstrapStatus(payload),
      InvalidApiPayloadError,
    );
  }
});

test("会话响应按管理员和游戏权限严格校验", () => {
  const session = normalizeSession(validSession());
  assert.equal(session.operator.operatorId, "ops_kimi");
  assert.deepEqual(
    session.games.map((game) => game.gameId),
    ["game-a", "game-b"],
  );
  assert.equal(session.canManageGames, true);
  assert.equal(session.canManageIntegrations, true);
  assert.equal(session.canRotateSecrets, true);
  assert.equal(session.canManageMachineIdentities, true);
  assert.equal(session.elevatedUntil, "2026-07-28T17:30:00.000Z");
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.games), true);
  assert.equal(
    isSessionExpired(session, Date.parse("2026-07-28T18:00:00.000Z")),
    true,
  );
  assert.equal(
    isSessionExpired(session, Date.parse("2026-07-28T17:59:59.999Z")),
    false,
  );

  const duplicated = validSession();
  duplicated.games[1].gameId = "game-a";
  assert.throws(
    () => normalizeSession(duplicated),
    InvalidApiPayloadError,
  );
  const invalidOperator = validSession();
  invalidOperator.operator.operatorId = "INVALID OPERATOR";
  assert.throws(
    () => normalizeSession(invalidOperator),
    InvalidApiPayloadError,
  );

  const invalidCapability = validSession();
  invalidCapability.games[0].canOperateAccounts = "yes";
  assert.throws(
    () => normalizeSession(invalidCapability),
    InvalidApiPayloadError,
  );

  const invalidManageCapability = validSession();
  invalidManageCapability.canManageGames = "yes";
  assert.throws(
    () => normalizeSession(invalidManageCapability),
    InvalidApiPayloadError,
  );

  for (const capability of [
    "canManageIntegrations",
    "canRotateSecrets",
    "canManageMachineIdentities",
  ]) {
    const invalid = validSession();
    invalid[capability] = "yes";
    assert.throws(
      () => normalizeSession(invalid),
      InvalidApiPayloadError,
    );
  }

  const invalidExpiry = validSession();
  invalidExpiry.expiresAt = "tomorrow";
  assert.throws(
    () => normalizeSession(invalidExpiry),
    InvalidApiPayloadError,
  );

  const invalidElevation = validSession();
  invalidElevation.elevatedUntil = "tomorrow";
  assert.throws(
    () => normalizeSession(invalidElevation),
    InvalidApiPayloadError,
  );
  assert.equal(
    normalizeSession({
      ...validSession(),
      elevatedUntil: null,
    }).elevatedUntil,
    null,
  );
});

test("多游戏必须主动选择，单游戏才自动选中", () => {
  const games = normalizeSession(validSession()).games;
  assert.equal(chooseInitialGame(games), null);
  assert.equal(chooseInitialGame(games, "game-b"), "game-b");
  assert.equal(chooseInitialGame(games, "missing"), null);
  assert.equal(chooseInitialGame([games[0]]), "game-a");
  assert.equal(chooseInitialGame([]), null);
});

test("管理员路由隐藏无权访问的接入配置入口", () => {
  const session = normalizeSession(validSession());
  assert.equal(chooseAdminView(null, "#games"), "login");
  assert.equal(chooseAdminView(session, "#games"), "games");
  assert.equal(chooseAdminView(session, "#integration"), "integration");
  assert.equal(chooseAdminView(session, "#unknown"), "accounts");
  assert.equal(
    chooseAdminView(Object.freeze({
      ...session,
      games: Object.freeze([]),
    }), "#accounts"),
    "games",
  );
  assert.equal(
    chooseAdminView(Object.freeze({
      ...session,
      games: Object.freeze([]),
      canManageGames: false,
      canManageIntegrations: false,
      canManageMachineIdentities: false,
    }), "#games"),
    "no-access",
  );
  assert.equal(
    chooseAdminView(Object.freeze({
      ...session,
      canManageGames: false,
    }), "#games"),
    "accounts",
  );
  assert.equal(
    chooseAdminView(Object.freeze({
      ...session,
      canManageIntegrations: false,
      canManageMachineIdentities: false,
    }), "#integration"),
    "accounts",
  );
  assert.equal(
    chooseAdminView(Object.freeze({
      ...session,
      games: Object.freeze([]),
      canManageGames: false,
      canManageIntegrations: true,
      canManageMachineIdentities: false,
    }), "#accounts"),
    "integration",
  );
});

test("游戏项目响应严格校验状态、配置和客户端下发约束", () => {
  const game = normalizeGameProject(validGameProject());
  assert.equal(game.gameId, "game-a");
  assert.equal(game.clientVisible, true);
  assert.equal(game.sortOrder, 10);
  assert.equal(Object.isFrozen(game), true);
  assert.equal(
    normalizeGameProject(validGameProject({
      name: "😀".repeat(128),
      description: "😀".repeat(500),
    })).description,
    "😀".repeat(500),
  );

  const list = normalizeGameProjectList({
    games: [
      validGameProject(),
      validGameProject({
        gameId: "game-b",
        status: "maintenance",
        configurationState: "draft",
        clientVisible: false,
      }),
    ],
  });
  assert.equal(list.games.length, 2);
  assert.equal(Object.isFrozen(list.games), true);
  assert.equal(
    normalizeGameProjectList({
      games: Array.from({ length: 1_025 }, (_, index) => (
        validGameProject({ gameId: `game-${index}` })
      )),
    }).games.length,
    1_025,
  );

  assert.throws(
    () => normalizeGameProject(validGameProject({
      configurationState: "draft",
      status: "enabled",
      clientVisible: false,
    })),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeGameProject(validGameProject({
      status: "disabled",
      clientVisible: true,
    })),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeGameProject(validGameProject({ sortOrder: 65_536 })),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeGameProject(validGameProject({
      description: "😀".repeat(501),
    })),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeGameProjectList({
      games: [validGameProject(), validGameProject()],
    }),
    InvalidApiPayloadError,
  );
});

test("区服响应严格校验游戏归属、枚举、URL 和乐观锁字段", () => {
  const server = normalizeGameServer(validGameServer(), "game-a", 1);
  assert.equal(server.name, "星海一区");
  assert.equal(server.isOpen, true);
  assert.equal(Object.isFrozen(server), true);
  assert.equal(
    normalizeGameServer(validGameServer({ name: "😀".repeat(64) })).name,
    "😀".repeat(64),
  );

  const list = normalizeGameServerList({
    directoryRevision: 7,
    servers: [
      validGameServer(),
      validGameServer({
        serverId: 2,
        name: "星海二区",
        tag: "maintenance",
        status: "maintenance",
        isOpen: false,
      }),
    ],
  }, "game-a");
  assert.equal(list.directoryRevision, 7);
  assert.equal(list.servers.length, 2);
  assert.equal(Object.isFrozen(list.servers), true);

  for (const invalid of [
    validGameServer({ gameId: "game-b" }),
    validGameServer({ serverId: 65_536 }),
    validGameServer({ name: "😀".repeat(65) }),
    validGameServer({ tag: "hot" }),
    validGameServer({ status: "offline" }),
    validGameServer({ openTime: -1 }),
    validGameServer({ gameHttpUrl: "ftp://game.example.com" }),
    validGameServer({ gameHttpUrl: "https://user@example.com" }),
    validGameServer({ gameWsUrl: "wss://game.example.com/socket#debug" }),
    validGameServer({ isOpen: 1 }),
    validGameServer({ sortOrder: 65_536 }),
    validGameServer({ revision: 0 }),
  ]) {
    assert.throws(
      () => normalizeGameServer(invalid, "game-a"),
      InvalidApiPayloadError,
    );
  }
  assert.throws(
    () => normalizeGameServerList({
      directoryRevision: 7,
      servers: [validGameServer(), validGameServer()],
    }, "game-a"),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeGameServerList({
      directoryRevision: 0,
      servers: [],
    }, "game-a"),
    InvalidApiPayloadError,
  );
});

test("接入配置响应只接收 Secret 元数据并校验目录 revision", () => {
  const directory = normalizeDirectorySettings({
    gameId: "game-a",
    isOps: true,
    revision: 4,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  }, "game-a");
  assert.equal(directory.revision, 4);
  assert.equal(directory.isOps, true);

  const integration = normalizeGameIntegration(validIntegration(), "game-a");
  assert.equal(integration.wechatAppId, "wx-game-a");
  assert.deepEqual(integration.wechatSecret, {
    configured: true,
    version: 2,
    state: "active",
    updatedAt: "2026-07-28T10:00:00.000Z",
  });
  assert.equal(Object.isFrozen(integration.wechatSecret), true);

  assert.deepEqual(
    normalizeWechatSecretMetadata({
      configured: false,
      version: 0,
      state: "missing",
      updatedAt: null,
    }),
    {
      configured: false,
      version: 0,
      state: "missing",
      updatedAt: null,
    },
  );
  assert.equal(
    normalizeWechatSecretMetadata({
      configured: true,
      version: 2,
      state: "validation_failed",
      updatedAt: "2026-07-28T10:00:00.000Z",
    }).state,
    "validation_failed",
  );
  assert.throws(
    () => normalizeWechatSecretMetadata({
      configured: false,
      version: 0,
      state: "validation_failed",
      updatedAt: null,
    }),
    InvalidApiPayloadError,
  );
  const write = normalizeWechatSecretWrite({
    gameId: "game-a",
    configurationState: "configured",
    wechatSecret: validIntegration().wechatSecret,
    revision: 4,
    loadedRevision: 4,
    replayed: false,
  }, "game-a");
  assert.equal(write.replayed, false);
  assert.equal(write.wechatSecret.version, 2);

  assert.throws(
    () => normalizeDirectorySettings({
      ...directory,
      gameId: "game-b",
    }, "game-a"),
    InvalidApiPayloadError,
  );
  for (const sensitiveField of [
    "wechatAppSecret",
    "wechat_app_secret",
    "secretDigest",
  ]) {
    assert.throws(
      () => normalizeGameIntegration({
        ...validIntegration(),
        [sensitiveField]: "must-not-be-returned",
      }, "game-a"),
      InvalidApiPayloadError,
    );
  }
  assert.throws(
    () => normalizeWechatSecretWrite({
      ...write,
      secret: "must-not-be-returned",
    }, "game-a"),
    InvalidApiPayloadError,
  );
  for (const endpoint of [
    "https://example.com/collect",
    "https://api.weixin.qq.com/sns/jscode2session?redirect=1",
    "http://api.weixin.qq.com/sns/jscode2session",
  ]) {
    assert.throws(
      () => normalizeGameIntegration(
        validIntegration({ wechatEndpoint: endpoint }),
        "game-a",
      ),
      InvalidApiPayloadError,
    );
  }
  assert.equal(
    normalizeGameIntegration(validIntegration({
      wechatEndpoint: "http://127.0.0.1:8787/mock-wechat",
    }), "game-a").wechatEndpoint,
    "http://127.0.0.1:8787/mock-wechat",
  );
});

test("机器身份只接受范围与 Secret 版本元数据，一次性明文仅允许首次响应", () => {
  const identity = normalizeMachineIdentity(
    validMachineIdentity(),
    "game-a-service",
  );
  assert.deepEqual(identity.gameIds, ["game-a"]);
  assert.equal(identity.secretVersions[0].state, "current");
  assert.equal(Object.isFrozen(identity.secretVersions), true);
  assert.equal(
    normalizeMachineIdentityList({
      identities: [
        validMachineIdentity(),
        validMachineIdentity({
          identityId: "game-a-admin",
          identityType: "machine_admin",
          displayName: "游戏 A 机器管理员",
        }),
      ],
    }).identities.length,
    2,
  );

  const oneTimeValue = "A".repeat(43);
  const issued = normalizeMachineSecretIssued({
    identity: validMachineIdentity(),
    version: 2,
    secret: oneTimeValue,
    previousExpiresAt: "2026-07-28T11:00:00.000Z",
    replayed: false,
  }, "game-a-service");
  assert.equal(issued.secret, oneTimeValue);
  const replayed = normalizeMachineSecretIssued({
    identity: validMachineIdentity(),
    version: 2,
    previousExpiresAt: null,
    replayed: true,
  }, "game-a-service");
  assert.equal("secret" in replayed, false);

  assert.deepEqual(
    normalizeMachineSecretRevoked({
      identityId: "game-a-service",
      version: 1,
      state: "revoked",
      identityRevision: 3,
      replayed: false,
    }, "game-a-service", 1),
    {
      identityId: "game-a-service",
      version: 1,
      state: "revoked",
      identityRevision: 3,
      replayed: false,
    },
  );
  const status = normalizeMachineSecretOperationStatus({
    operationId: "rotate-game-a-service",
    identityId: "game-a-service",
    action: "rotate",
    status: "succeeded",
    version: 2,
    deliveryLost: true,
    createdAt: "2026-07-28T10:00:00.000Z",
  }, "game-a-service", "rotate-game-a-service");
  assert.equal(status.deliveryLost, true);
  assert.equal("secret" in status, false);

  assert.throws(
    () => normalizeMachineIdentity({
      ...validMachineIdentity(),
      secretDigest: "must-not-be-returned",
    }),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeMachineSecretOperationStatus({
      ...status,
      secret: oneTimeValue,
    }, "game-a-service", "rotate-game-a-service"),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeMachineIdentityList({
      identities: [validMachineIdentity(), validMachineIdentity()],
    }),
    InvalidApiPayloadError,
  );
});

test("配置审计接受 game_configuration 白名单且拒绝敏感字段", () => {
  const record = {
    id: "audit-1",
    auditType: "game_configuration",
    operatorId: "ops_kimi",
    gameId: "game-a",
    identityId: null,
    action: "update_integration",
    result: "succeeded",
    oldVersion: 2,
    newVersion: 3,
    createdAt: "2026-07-28T10:00:00.000Z",
  };
  const page = normalizeConfigurationAuditPage({ records: [record] });
  assert.equal(page.records[0].auditType, "game_configuration");
  assert.equal(Object.isFrozen(page.records), true);
  assert.throws(
    () => normalizeConfigurationAuditPage({
      records: [{ ...record, auditType: "configuration" }],
    }),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeConfigurationAuditPage({
      records: [{ ...record, secret_digest: "must-not-be-returned" }],
    }),
    InvalidApiPayloadError,
  );
});

test("区服开放时间在 datetime-local 与 Unix 秒之间无损转换", () => {
  const unixSeconds = 1_785_220_200;
  const localValue = unixSecondsToDateTimeLocal(unixSeconds);
  assert.match(localValue, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/u);
  assert.equal(dateTimeLocalToUnixSeconds(localValue), unixSeconds);
  assert.equal(dateTimeLocalToUnixSeconds("2026-02-30T12:00:00"), null);
  assert.equal(dateTimeLocalToUnixSeconds("1969-12-31T23:59:59"), null);
  assert.equal(dateTimeLocalToUnixSeconds("not-a-date"), null);
});

test("游戏状态与客户端下发遵守草稿和永久停用规则", () => {
  const draft = validGameProject({
    status: "maintenance",
    configurationState: "draft",
    clientVisible: false,
  });
  assert.equal(canSelectGameStatus(draft, "enabled"), false);
  assert.equal(canSelectGameStatus(draft, "maintenance"), true);
  assert.equal(canPublishGameToClient(draft), false);

  const configured = validGameProject();
  assert.equal(canSelectGameStatus(configured, "maintenance"), true);
  assert.equal(canPublishGameToClient(configured), true);
  assert.equal(canPublishGameToClient(configured, "maintenance"), true);
  assert.equal(canPublishGameToClient(configured, "disabled"), false);

  const disabled = validGameProject({
    status: "disabled",
    clientVisible: false,
  });
  assert.equal(canSelectGameStatus(disabled, "disabled"), true);
  assert.equal(canSelectGameStatus(disabled, "enabled"), false);
});

test("管理员名称与密码校验和服务端 Unicode 边界一致", () => {
  assert.equal(isValidAdminDisplayNameInput("Kimi"), true);
  assert.equal(isValidAdminDisplayNameInput("管理😀"), true);
  assert.equal(isValidAdminDisplayNameInput(""), false);
  assert.equal(isValidAdminDisplayNameInput(" Kimi"), false);
  assert.equal(isValidAdminDisplayNameInput("名".repeat(129)), false);
  assert.equal(isValidAdminDisplayNameInput(`Kimi\ud800`), false);
  assert.equal(isValidAdminPasswordInput("密".repeat(12)), true);
  assert.equal(isValidAdminPasswordInput("密".repeat(11)), false);
  assert.equal(isValidAdminPasswordInput("a".repeat(256)), true);
  assert.equal(isValidAdminPasswordInput("a".repeat(257)), false);
  assert.equal(isValidAdminPasswordInput("🔐".repeat(256)), true);
  assert.equal(isValidAdminPasswordInput(`\ud800${"a".repeat(12)}`), false);
});

test("会话请求版本会拒绝退出或过期前发起的迟到响应", () => {
  const requests = createLatestRequestGuard();
  const first = requests.begin();
  assert.equal(requests.isCurrent(first), true);

  const second = requests.begin();
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);

  requests.invalidate();
  assert.equal(requests.isCurrent(second), false);
});

test("账号与操作响应拒绝宽松或错位数据", () => {
  const account = normalizeAccount({
    userId: "u_12345",
    status: "active",
    lastLoginAt: null,
    activeSessionCount: 2,
  }, "u_12345");
  assert.equal(account.activeSessionCount, 2);
  const deregistered = normalizeAccount({
    userId: "u_54321",
    status: "deregistered",
    lastLoginAt: null,
    activeSessionCount: 0,
  }, "u_54321");
  assert.equal(deregistered.status, "deregistered");
  assert.deepEqual(
    accountStatusPresentation(deregistered),
    { text: "已注销", variant: "warning" },
  );
  assert.equal(canPerformAccountAction(deregistered, "ban", true), false);
  assert.equal(canPerformAccountAction(deregistered, "revoke", true), false);
  assert.equal(canPerformAccountAction(account, "ban", true), true);
  assert.equal(canPerformAccountAction(account, "revoke", true), true);
  assert.equal(canPerformAccountAction(account, "ban", false), false);
  assert.equal(isValidUserId(" u_12345 "), true);
  assert.equal(isValidUserId("12345"), false);

  assert.throws(
    () => normalizeAccount({
      ...account,
      userId: "u_999",
    }, "u_12345"),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeAccount({
      ...account,
      activeSessionCount: -1,
    }),
    InvalidApiPayloadError,
  );
  assert.deepEqual(
    normalizeOperationResult(
      { accountExists: true, status: "revoked" },
      "revoke",
    ),
    { accountExists: true, status: "revoked" },
  );
  assert.throws(
    () => normalizeOperationResult(
      { accountExists: true, status: "done" },
      "revoke",
    ),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeOperationResult({
      accountExists: false,
      status: "banned",
    }, "ban"),
    InvalidApiPayloadError,
  );
  assert.throws(
    () => normalizeOperationResult({
      accountExists: true,
      status: "revoked",
    }, "ban"),
    InvalidApiPayloadError,
  );
});

test("路径参数编码且 operationId 在同一次重试中保持不变", async () => {
  assert.equal(
    accountPath("game a", "u/1"),
    "/v1/games/game%20a/admin/accounts/u%2F1",
  );

  let uuidCalls = 0;
  const intent = createOperationIntent({
    action: "revoke",
    gameId: "game-a",
    userId: "u_42",
    randomUUID: () => {
      uuidCalls += 1;
      return "c67d6996-67b0-48de-897f-d144b790be50";
    },
  });
  assert.equal(uuidCalls, 1);

  const requests = [];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return jsonResponse({ accountExists: true, status: "revoked" });
  });
  await api.perform(intent, "值班确认");
  await api.perform(intent, "值班确认");

  assert.equal(requests.length, 2);
  assert.equal(
    JSON.parse(requests[0].init.body).operationId,
    "c67d6996-67b0-48de-897f-d144b790be50",
  );
  assert.equal(requests[0].init.body, requests[1].init.body);

  const reused = reuseOrCreateOperationIntent({
    previous: intent,
    action: "revoke",
    gameId: "game-a",
    userId: "u_42",
    randomUUID: () => {
      throw new Error("同目标重试不应创建新的 operationId");
    },
  });
  assert.equal(reused, intent);

  const replaced = reuseOrCreateOperationIntent({
    previous: intent,
    action: "ban",
    gameId: "game-a",
    userId: "u_42",
    randomUUID: () => "5b31f2c1-7f8a-4480-815e-a074c63b1ae3",
  });
  assert.notEqual(replaced, intent);
  assert.equal(replaced.operationId, "5b31f2c1-7f8a-4480-815e-a074c63b1ae3");
});

test("游戏项目 API 使用固定集合路径和精确新增编辑请求", async () => {
  assert.equal(gameProjectPath(), "/v1/admin/games");
  assert.equal(gameProjectPath("game/a"), "/v1/admin/games/game%2Fa");

  const requests = [];
  const created = validGameProject({
    gameId: "new-game",
    name: "新游戏",
    description: "首轮草稿",
    status: "maintenance",
    configurationState: "draft",
    clientVisible: false,
    sortOrder: 0,
    revision: 1,
  });
  const updated = validGameProject({
    name: "游戏 A 新名称",
    description: "已更新",
    status: "maintenance",
    clientVisible: true,
    sortOrder: 20,
    revision: 4,
  });
  const responses = [
    jsonResponse({ games: [validGameProject()] }),
    jsonResponse(created, { status: 201 }),
    jsonResponse(updated),
  ];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return responses.shift();
  });

  const games = await api.listGames();
  const createResult = await api.createGame({
    gameId: "new-game",
    name: "新游戏",
    description: "首轮草稿",
  });
  const updateResult = await api.updateGame("game-a", {
    name: "游戏 A 新名称",
    description: "已更新",
    status: "maintenance",
    clientVisible: true,
    sortOrder: 20,
    revision: 3,
  });

  assert.equal(games.length, 1);
  assert.equal(createResult.configurationState, "draft");
  assert.equal(updateResult.revision, 4);
  assert.deepEqual(
    requests.map((request) => [request.path, request.init.method]),
    [
      ["/v1/admin/games", "GET"],
      ["/v1/admin/games", "POST"],
      ["/v1/admin/games/game-a", "PATCH"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    gameId: "new-game",
    name: "新游戏",
    description: "首轮草稿",
  });
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    name: "游戏 A 新名称",
    description: "已更新",
    status: "maintenance",
    clientVisible: true,
    sortOrder: 20,
    revision: 3,
  });
});

test("区服 API 路径编码并发送精确的新增编辑请求", async () => {
  assert.equal(
    gameServerPath("game/a"),
    "/v1/admin/games/game%2Fa/servers",
  );
  assert.equal(
    gameServerPath("game/a", 7),
    "/v1/admin/games/game%2Fa/servers/7",
  );

  const requests = [];
  const created = validGameServer({ revision: 1 });
  const updated = validGameServer({
    name: "星海一区（维护）",
    status: "maintenance",
    revision: 4,
  });
  const responses = [
    jsonResponse({
      directoryRevision: 3,
      servers: [validGameServer()],
    }),
    jsonResponse({
      directoryRevision: 4,
      server: created,
    }, { status: 201 }),
    jsonResponse({
      directoryRevision: 5,
      server: updated,
    }),
  ];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return responses.shift();
  });
  const createInput = {
    directoryRevision: 3,
    serverId: 1,
    name: "星海一区",
    tag: "new",
    status: "smooth",
    openTime: 1_785_220_200,
    gameHttpUrl: "https://game.example.com/api",
    gameWsUrl: "wss://game.example.com/socket",
    isOpen: true,
    sortOrder: 10,
  };
  const updateInput = {
    directoryRevision: 4,
    name: "星海一区（维护）",
    tag: "new",
    status: "maintenance",
    openTime: 1_785_220_200,
    gameHttpUrl: "https://game.example.com/api",
    gameWsUrl: "wss://game.example.com/socket",
    isOpen: true,
    sortOrder: 10,
    revision: 3,
  };

  const servers = await api.listGameServers("game-a");
  const createResult = await api.createGameServer("game-a", createInput);
  const updateResult = await api.updateGameServer("game-a", 1, updateInput);

  assert.equal(servers.directoryRevision, 3);
  assert.equal(servers.servers.length, 1);
  assert.equal(createResult.directoryRevision, 4);
  assert.equal(createResult.server.revision, 1);
  assert.equal(updateResult.directoryRevision, 5);
  assert.equal(updateResult.server.revision, 4);
  assert.deepEqual(
    requests.map((request) => [request.path, request.init.method]),
    [
      ["/v1/admin/games/game-a/servers", "GET"],
      ["/v1/admin/games/game-a/servers", "POST"],
      ["/v1/admin/games/game-a/servers/1", "PATCH"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].init.body), createInput);
  assert.deepEqual(JSON.parse(requests[2].init.body), updateInput);
});

test("接入配置 API 路径编码并按契约发送精确请求", async () => {
  assert.equal(
    directorySettingsPath("game/a"),
    "/v1/admin/games/game%2Fa/directory-settings",
  );
  assert.equal(
    gameIntegrationPath("game/a"),
    "/v1/admin/games/game%2Fa/integration",
  );
  assert.equal(
    wechatAppSecretPath("game/a"),
    "/v1/admin/games/game%2Fa/secrets/wechat-app-secret",
  );
  assert.equal(
    machineIdentityPath("service/a"),
    "/v1/admin/machine-identities/service%2Fa",
  );
  assert.equal(
    machineSecretRotationPath("service/a"),
    "/v1/admin/machine-identities/service%2Fa/secret-rotations",
  );
  assert.equal(
    machineSecretRotationPath("service/a", "operation/a"),
    "/v1/admin/machine-identities/service%2Fa/secret-rotations/operation%2Fa",
  );
  assert.equal(
    machineSecretRevokePath("service/a", 2),
    "/v1/admin/machine-identities/service%2Fa/secret-versions/2/revoke",
  );
  assert.equal(
    configurationAuditPath("game/a", 25),
    "/v1/admin/config-audit?gameId=game%2Fa&limit=25",
  );
  assert.equal(
    createConfigurationOperationId(() => "operation-1"),
    "operation-1",
  );
  assert.throws(
    () => createConfigurationOperationId(() => "contains whitespace"),
    /operationId/u,
  );

  const requests = [];
  const directory = {
    gameId: "game-a",
    isOps: true,
    revision: 4,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
  const identity = validMachineIdentity();
  const issued = {
    identity,
    version: 2,
    secret: "A".repeat(43),
    previousExpiresAt: null,
    replayed: false,
  };
  const audit = {
    records: [{
      id: "audit-1",
      auditType: "game_configuration",
      operatorId: "ops_kimi",
      gameId: "game-a",
      identityId: null,
      action: "update_integration",
      result: "succeeded",
      oldVersion: 2,
      newVersion: 3,
      createdAt: "2026-07-28T10:00:00.000Z",
    }],
  };
  const responses = [
    new Response(null, { status: 204 }),
    jsonResponse(directory),
    jsonResponse({ ...directory, revision: 5 }),
    jsonResponse(validIntegration()),
    jsonResponse(validIntegration({ revision: 4, loadedRevision: 4 })),
    jsonResponse({
      gameId: "game-a",
      configurationState: "configured",
      wechatSecret: validIntegration().wechatSecret,
      revision: 4,
      loadedRevision: 4,
      replayed: false,
    }),
    jsonResponse({ identities: [identity] }),
    jsonResponse(issued, { status: 201 }),
    jsonResponse({ ...identity, displayName: "新名称", revision: 3 }),
    jsonResponse(issued),
    jsonResponse({
      identityId: "game-a-service",
      version: 2,
      state: "revoked",
      identityRevision: 3,
      replayed: false,
    }),
    jsonResponse({
      operationId: "operation-rotate",
      identityId: "game-a-service",
      action: "rotate",
      status: "succeeded",
      version: 2,
      deliveryLost: true,
      createdAt: "2026-07-28T10:00:00.000Z",
    }),
    jsonResponse(audit),
  ];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return responses.shift();
  });

  const directoryInput = { isOps: true, revision: 4 };
  const integrationInput = {
    wechatAppId: "wx-game-a",
    wechatEndpoint: "https://api.weixin.qq.com/sns/jscode2session",
    wechatTimeoutMs: 2_000,
    wechatBreakerThreshold: 4,
    wechatBreakerOpenMs: 5_000,
    sessionTtlSeconds: 7_200,
    loginRateCapacity: 40,
    loginRateRefillPerSecond: 2.5,
    adminRateCapacity: 20,
    adminRateRefillPerSecond: 1,
    revision: 3,
  };
  const secretInput = {
    wechatAppSecret: "test-only-placeholder",
    revision: 3,
    operationId: "operation-wechat",
  };
  const createIdentityInput = {
    identityId: "game-a-service",
    identityType: "service",
    displayName: "游戏 A 服务",
    gameIds: ["game-a"],
    operationId: "operation-create",
  };
  const updateIdentityInput = {
    displayName: "新名称",
    status: "enabled",
    gameIds: ["game-a"],
    revision: 2,
  };
  const rotateInput = {
    operationId: "operation-rotate",
    revision: 2,
    previousValiditySeconds: 3_600,
  };
  const revokeInput = {
    operationId: "operation-revoke",
    revision: 2,
    reason: "应急撤销",
  };

  await api.reauthenticate("test-only-password");
  await api.getDirectorySettings("game-a");
  await api.updateDirectorySettings("game-a", directoryInput);
  await api.getGameIntegration("game-a");
  await api.updateGameIntegration("game-a", integrationInput);
  await api.replaceWechatAppSecret("game-a", secretInput);
  await api.listMachineIdentities();
  await api.createMachineIdentity(createIdentityInput);
  await api.updateMachineIdentity("game-a-service", updateIdentityInput);
  await api.rotateMachineSecret("game-a-service", rotateInput);
  await api.revokeMachineSecret("game-a-service", 2, revokeInput);
  const status = await api.machineSecretOperationStatus(
    "game-a-service",
    "operation-rotate",
  );
  const records = await api.listConfigurationAudit("game-a", 25);

  assert.equal(status.deliveryLost, true);
  assert.equal("secret" in status, false);
  assert.equal(records[0].auditType, "game_configuration");
  assert.deepEqual(
    requests.map((request) => [request.path, request.init.method]),
    [
      ["/v1/admin/auth/reauthenticate", "POST"],
      ["/v1/admin/games/game-a/directory-settings", "GET"],
      ["/v1/admin/games/game-a/directory-settings", "PATCH"],
      ["/v1/admin/games/game-a/integration", "GET"],
      ["/v1/admin/games/game-a/integration", "PATCH"],
      ["/v1/admin/games/game-a/secrets/wechat-app-secret", "PUT"],
      ["/v1/admin/machine-identities", "GET"],
      ["/v1/admin/machine-identities", "POST"],
      ["/v1/admin/machine-identities/game-a-service", "PATCH"],
      ["/v1/admin/machine-identities/game-a-service/secret-rotations", "POST"],
      ["/v1/admin/machine-identities/game-a-service/secret-versions/2/revoke", "POST"],
      ["/v1/admin/machine-identities/game-a-service/secret-rotations/operation-rotate", "GET"],
      ["/v1/admin/config-audit?gameId=game-a&limit=25", "GET"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    password: "test-only-password",
  });
  assert.deepEqual(JSON.parse(requests[2].init.body), directoryInput);
  assert.deepEqual(JSON.parse(requests[4].init.body), integrationInput);
  assert.deepEqual(JSON.parse(requests[5].init.body), secretInput);
  assert.deepEqual(JSON.parse(requests[7].init.body), createIdentityInput);
  assert.deepEqual(JSON.parse(requests[8].init.body), updateIdentityInput);
  assert.deepEqual(JSON.parse(requests[9].init.body), rotateInput);
  assert.deepEqual(JSON.parse(requests[10].init.body), revokeInput);
});

test("管理员初始化 API 严格检查状态并只提交创建字段", async () => {
  const requests = [];
  const responses = [
    jsonResponse({ required: true }),
    new Response(null, { status: 204 }),
  ];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return responses.shift();
  });

  const status = await api.bootstrapStatus();
  await api.createBootstrapAdmin({
    operatorId: "ops_bootstrap",
    displayName: "Bootstrap Admin",
    password: "correct horse battery",
  });

  assert.deepEqual(status, { required: true });
  assert.deepEqual(
    requests.map((request) => [request.path, request.init.method]),
    [
      ["/v1/admin/bootstrap", "GET"],
      ["/v1/admin/bootstrap", "POST"],
    ],
  );
  assert.equal(requests[0].init.body, undefined);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    operatorId: "ops_bootstrap",
    displayName: "Bootstrap Admin",
    password: "correct horse battery",
  });
  assert.equal("passwordConfirm" in JSON.parse(requests[1].init.body), false);
});

test("API 客户端使用同源 Cookie、正确方法和 JSON 请求", async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 204 }),
    jsonResponse(validSession()),
    jsonResponse({
      userId: "u_7",
      status: "active",
      lastLoginAt: "2026-07-28T05:20:00.000Z",
      activeSessionCount: 1,
    }),
    new Response(null, { status: 204 }),
  ];
  const api = createAdminApi(async (path, init) => {
    requests.push({ path, init });
    return responses.shift();
  });

  await api.login("ops_kimi", "correct horse");
  const session = await api.session();
  const account = await api.findAccount("game-a", "u_7");
  await api.logout();

  assert.equal(session.operator.displayName, "Kimi");
  assert.equal(account.userId, "u_7");
  assert.deepEqual(
    requests.map((request) => [request.path, request.init.method]),
    [
      ["/v1/admin/auth/login", "POST"],
      ["/v1/admin/auth/session", "GET"],
      ["/v1/games/game-a/admin/accounts/u_7", "GET"],
      ["/v1/admin/auth/session", "DELETE"],
    ],
  );
  for (const request of requests) {
    assert.equal(request.init.credentials, "same-origin");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.headers.Accept, "application/json");
  }
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    operatorId: "ops_kimi",
    password: "correct horse",
  });
  assert.equal(requests[1].init.body, undefined);
});

test("API 请求失败不自动重试并保留限流信息", async () => {
  let attempts = 0;
  const api = createAdminApi(async () => {
    attempts += 1;
    return jsonResponse(
      { code: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "retry-after": "17",
          "x-request-id": "req-429",
        },
      },
    );
  });

  await assert.rejects(
    () => api.session(),
    (error) => {
      assert.equal(error instanceof AdminApiError, true);
      assert.equal(error.status, 429);
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.retryAfterSeconds, 17);
      assert.equal(error.requestId, "req-429");
      assert.match(describeApiError(error, "session"), /17 秒/u);
      assert.match(describeApiError(error, "session"), /req-429/u);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("退出接口 401 视为会话已经结束，其他失败仍可重试", () => {
  assert.equal(isCompletedLogout(null), true);
  assert.equal(
    isCompletedLogout(new AdminApiError("expired", { status: 401 })),
    true,
  );
  assert.equal(
    isCompletedLogout(new AdminApiError("offline", { status: 0 })),
    false,
  );
});

test("API 请求超时会中止 fetch 并返回可重试错误", async () => {
  let timeoutCleared = false;
  const api = createAdminApi(async (_path, init) => {
    assert.equal(init.signal.aborted, true);
    throw new DOMException("aborted", "AbortError");
  }, {
    requestTimeoutMs: 1,
    schedule(callback) {
      callback();
      return 17;
    },
    cancelSchedule(timer) {
      assert.equal(timer, 17);
      timeoutCleared = true;
    },
  });

  await assert.rejects(
    () => api.session(),
    (error) => {
      assert.equal(error instanceof AdminApiError, true);
      assert.equal(error.code, "REQUEST_TIMEOUT");
      assert.equal(describeApiError(error, "session"), "管理服务响应超时，请重试。");
      return true;
    },
  );
  assert.equal(timeoutCleared, true);
});

test("危险操作拒绝与操作意图不一致的成功响应", async () => {
  const api = createAdminApi(async () => (
    jsonResponse({ accountExists: true, status: "revoked" })
  ));
  const intent = createOperationIntent({
    action: "ban",
    gameId: "game-a",
    userId: "u_42",
    randomUUID: () => "97a6279c-1a98-425f-b8b1-c2bc5a1a1a30",
  });

  await assert.rejects(
    () => api.perform(intent, "安全处置"),
    InvalidApiPayloadError,
  );
});

test("网络错误与成功状态下的非法响应被区分", async () => {
  const offlineApi = createAdminApi(async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(
    () => offlineApi.session(),
    (error) => {
      assert.equal(error instanceof AdminApiError, true);
      assert.equal(error.status, 0);
      assert.equal(describeApiError(error, "session"), "无法连接管理服务，请检查网络后重试。");
      return true;
    },
  );

  const malformedApi = createAdminApi(async () => (
    new Response("<html>wrong surface</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  ));
  await assert.rejects(
    () => malformedApi.session(),
    InvalidApiPayloadError,
  );
});

test("清空密码时同步恢复隐藏状态和无障碍标签", () => {
  const attributes = new Map();
  const useAttributes = new Map();
  const input = { type: "text" };
  const button = {
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    querySelector(selector) {
      assert.equal(selector, "use");
      return {
        setAttribute(name, value) {
          useAttributes.set(name, value);
        },
      };
    },
  };

  resetPasswordControl(input, button);
  assert.equal(input.type, "password");
  assert.equal(attributes.get("aria-pressed"), "false");
  assert.equal(attributes.get("aria-label"), "显示密码");
  assert.equal(attributes.get("title"), "显示密码");
  assert.equal(useAttributes.get("href"), "#eye");
});
