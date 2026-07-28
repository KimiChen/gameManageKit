import {
  createToastController,
  initPasswordControls,
  initTheme,
  resetPasswordControl,
} from "./wsk.js";

export const USER_ID_PATTERN = /^u_[0-9]+$/u;
export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
export const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
export const MACHINE_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
export const ADMIN_ACTIONS = Object.freeze(["ban", "revoke"]);
export const ADMIN_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

const GAME_STATUSES = new Set(["enabled", "maintenance", "disabled"]);
const GAME_CONFIGURATION_STATES = new Set(["draft", "configured"]);
const SERVER_TAGS = new Set(["normal", "new", "full", "maintenance"]);
const SERVER_STATUSES = new Set(["smooth", "busy", "maintenance"]);
const MACHINE_IDENTITY_TYPES = new Set(["service", "machine_admin"]);
const MACHINE_IDENTITY_STATUSES = new Set(["enabled", "disabled"]);
const MACHINE_SECRET_STATES = new Set(["current", "previous", "revoked"]);
const MACHINE_SECRET_ACTIONS = new Set(["set", "rotate", "revoke"]);
const ACCOUNT_STATUSES = new Set(["active", "banned", "deregistered"]);
const OPERATION_STATUSES = new Set(["banned", "revoked", "not_found"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class InvalidApiPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidApiPayloadError";
  }
}

export class AdminApiError extends Error {
  constructor(message, {
    status = 0,
    code = "NETWORK_ERROR",
    requestId = null,
    retryAfterSeconds = null,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, label, maxLength) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || [...value].length > maxLength
  ) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return value;
}

function nullableDate(value, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return value;
}

function requiredDate(value, label) {
  const date = requiredString(value, label, 64);
  if (!Number.isFinite(Date.parse(date))) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return date;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return value;
}

function nonNegativeInteger(
  value,
  label,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return value;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return value;
}

function assertNoSensitiveFields(payload, label) {
  const forbidden = new Set([
    "wechatAppSecret",
    "wechat_app_secret",
    "secret",
    "secretDigest",
    "secret_digest",
    "digest",
  ]);
  for (const key of Object.keys(payload)) {
    if (forbidden.has(key)) {
      throw new InvalidApiPayloadError(`${label} 含敏感字段`);
    }
  }
}

export function normalizeSession(payload) {
  if (!isRecord(payload) || !isRecord(payload.operator)) {
    throw new InvalidApiPayloadError("管理员会话响应无效");
  }

  const operatorId = requiredString(
    payload.operator.operatorId,
    "operator.operatorId",
    64,
  );
  if (!OPERATOR_ID_PATTERN.test(operatorId)) {
    throw new InvalidApiPayloadError("operator.operatorId 无效");
  }
  const displayName = requiredString(
    payload.operator.displayName,
    "operator.displayName",
    128,
  );
  if (!Array.isArray(payload.games)) {
    throw new InvalidApiPayloadError("games 无效");
  }
  if (typeof payload.canManageGames !== "boolean") {
    throw new InvalidApiPayloadError("canManageGames 无效");
  }
  for (const capability of [
    "canManageIntegrations",
    "canRotateSecrets",
    "canManageMachineIdentities",
  ]) {
    if (typeof payload[capability] !== "boolean") {
      throw new InvalidApiPayloadError(`${capability} 无效`);
    }
  }

  const seen = new Set();
  const games = payload.games.map((rawGame, index) => {
    if (!isRecord(rawGame)) {
      throw new InvalidApiPayloadError(`games[${index}] 无效`);
    }
    const gameId = requiredString(rawGame.gameId, `games[${index}].gameId`, 32);
    if (!GAME_ID_PATTERN.test(gameId) || seen.has(gameId)) {
      throw new InvalidApiPayloadError(`games[${index}].gameId 无效`);
    }
    seen.add(gameId);

    const name = requiredString(rawGame.name, `games[${index}].name`, 128);
    if (!GAME_STATUSES.has(rawGame.status)) {
      throw new InvalidApiPayloadError(`games[${index}].status 无效`);
    }
    if (typeof rawGame.canOperateAccounts !== "boolean") {
      throw new InvalidApiPayloadError(
        `games[${index}].canOperateAccounts 无效`,
      );
    }
    return Object.freeze({
      gameId,
      name,
      status: rawGame.status,
      canOperateAccounts: rawGame.canOperateAccounts,
    });
  });

  const expiresAt = requiredDate(payload.expiresAt, "expiresAt");
  const elevatedUntil = nullableDate(payload.elevatedUntil, "elevatedUntil");

  return Object.freeze({
    operator: Object.freeze({ operatorId, displayName }),
    games: Object.freeze(games),
    canManageGames: payload.canManageGames,
    canManageIntegrations: payload.canManageIntegrations,
    canRotateSecrets: payload.canRotateSecrets,
    canManageMachineIdentities: payload.canManageMachineIdentities,
    expiresAt,
    elevatedUntil,
  });
}

export function normalizeGameProject(payload) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("游戏项目响应无效");
  }
  const gameId = requiredString(payload.gameId, "gameId", 32);
  if (!GAME_ID_PATTERN.test(gameId)) {
    throw new InvalidApiPayloadError("gameId 无效");
  }
  const name = requiredString(payload.name, "name", 128);
  if (
    typeof payload.description !== "string"
    || [...payload.description].length > 500
  ) {
    throw new InvalidApiPayloadError("description 无效");
  }
  if (!GAME_STATUSES.has(payload.status)) {
    throw new InvalidApiPayloadError("status 无效");
  }
  if (!GAME_CONFIGURATION_STATES.has(payload.configurationState)) {
    throw new InvalidApiPayloadError("configurationState 无效");
  }
  if (
    payload.configurationState === "draft"
    && payload.status === "enabled"
  ) {
    throw new InvalidApiPayloadError("草稿游戏不能启用");
  }
  if (
    typeof payload.clientVisible !== "boolean"
    || (payload.clientVisible && (
      payload.configurationState !== "configured"
      || payload.status === "disabled"
    ))
  ) {
    throw new InvalidApiPayloadError("clientVisible 无效");
  }
  if (
    !Number.isSafeInteger(payload.sortOrder)
    || payload.sortOrder < 0
    || payload.sortOrder > 65_535
  ) {
    throw new InvalidApiPayloadError("sortOrder 无效");
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision <= 0) {
    throw new InvalidApiPayloadError("revision 无效");
  }
  const createdAt = requiredString(payload.createdAt, "createdAt", 64);
  const updatedAt = requiredString(payload.updatedAt, "updatedAt", 64);
  if (
    !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new InvalidApiPayloadError("游戏项目时间无效");
  }
  return Object.freeze({
    gameId,
    name,
    description: payload.description,
    status: payload.status,
    configurationState: payload.configurationState,
    clientVisible: payload.clientVisible,
    sortOrder: payload.sortOrder,
    revision: payload.revision,
    createdAt,
    updatedAt,
  });
}

export function normalizeGameProjectList(payload) {
  if (
    !isRecord(payload)
    || !Array.isArray(payload.games)
  ) {
    throw new InvalidApiPayloadError("游戏项目列表响应无效");
  }
  const seen = new Set();
  const games = payload.games.map((value, index) => {
    let game;
    try {
      game = normalizeGameProject(value);
    } catch (error) {
      if (error instanceof InvalidApiPayloadError) {
        throw new InvalidApiPayloadError(`games[${index}] ${error.message}`);
      }
      throw error;
    }
    if (seen.has(game.gameId)) {
      throw new InvalidApiPayloadError(`games[${index}].gameId 重复`);
    }
    seen.add(game.gameId);
    return game;
  });
  return Object.freeze({ games: Object.freeze(games) });
}

export function normalizeDirectorySettings(payload, expectedGameId = null) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("目录设置响应无效");
  }
  const gameId = requiredString(payload.gameId, "gameId", 32);
  if (
    !GAME_ID_PATTERN.test(gameId)
    || (expectedGameId !== null && gameId !== expectedGameId)
    || typeof payload.isOps !== "boolean"
  ) {
    throw new InvalidApiPayloadError("目录设置响应无效");
  }
  return Object.freeze({
    gameId,
    isOps: payload.isOps,
    revision: positiveInteger(payload.revision, "revision"),
    createdAt: requiredDate(payload.createdAt, "createdAt"),
    updatedAt: requiredDate(payload.updatedAt, "updatedAt"),
  });
}

function requiredEndpoint(value, label, protocols) {
  const endpoint = requiredString(value, label, 2_048);
  if (endpoint !== endpoint.trim()) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  if (
    !protocols.has(url.protocol)
    || url.hostname.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
  ) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return endpoint;
}

function requiredWechatEndpoint(value, label) {
  const endpoint = requiredEndpoint(
    value,
    label,
    new Set(["http:", "https:"]),
  );
  const parsed = new URL(endpoint);
  const official = (
    parsed.protocol === "https:"
    && parsed.hostname === "api.weixin.qq.com"
    && parsed.port === ""
    && parsed.pathname === "/sns/jscode2session"
    && parsed.search === ""
  );
  const loopback = (
    parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]"
  );
  if (!official && !loopback) {
    throw new InvalidApiPayloadError(`${label} 无效`);
  }
  return endpoint;
}

export function normalizeGameServer(
  payload,
  expectedGameId = null,
  expectedServerId = null,
) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("区服响应无效");
  }
  const gameId = requiredString(payload.gameId, "gameId", 32);
  if (
    !GAME_ID_PATTERN.test(gameId)
    || (expectedGameId !== null && gameId !== expectedGameId)
  ) {
    throw new InvalidApiPayloadError("gameId 无效");
  }
  if (
    !Number.isSafeInteger(payload.serverId)
    || payload.serverId < 0
    || payload.serverId > 65_535
    || (expectedServerId !== null && payload.serverId !== expectedServerId)
  ) {
    throw new InvalidApiPayloadError("serverId 无效");
  }
  const name = requiredString(payload.name, "name", 64);
  if (!SERVER_TAGS.has(payload.tag)) {
    throw new InvalidApiPayloadError("tag 无效");
  }
  if (!SERVER_STATUSES.has(payload.status)) {
    throw new InvalidApiPayloadError("status 无效");
  }
  if (
    !Number.isSafeInteger(payload.openTime)
    || payload.openTime < 0
  ) {
    throw new InvalidApiPayloadError("openTime 无效");
  }
  const gameHttpUrl = requiredEndpoint(
    payload.gameHttpUrl,
    "gameHttpUrl",
    new Set(["http:", "https:"]),
  );
  const gameWsUrl = requiredEndpoint(
    payload.gameWsUrl,
    "gameWsUrl",
    new Set(["ws:", "wss:"]),
  );
  if (typeof payload.isOpen !== "boolean") {
    throw new InvalidApiPayloadError("isOpen 无效");
  }
  if (
    !Number.isSafeInteger(payload.sortOrder)
    || payload.sortOrder < 0
    || payload.sortOrder > 65_535
  ) {
    throw new InvalidApiPayloadError("sortOrder 无效");
  }
  if (!Number.isSafeInteger(payload.revision) || payload.revision <= 0) {
    throw new InvalidApiPayloadError("revision 无效");
  }
  const createdAt = requiredString(payload.createdAt, "createdAt", 64);
  const updatedAt = requiredString(payload.updatedAt, "updatedAt", 64);
  if (
    !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new InvalidApiPayloadError("区服时间无效");
  }
  return Object.freeze({
    gameId,
    serverId: payload.serverId,
    name,
    tag: payload.tag,
    status: payload.status,
    openTime: payload.openTime,
    gameHttpUrl,
    gameWsUrl,
    isOpen: payload.isOpen,
    sortOrder: payload.sortOrder,
    revision: payload.revision,
    createdAt,
    updatedAt,
  });
}

export function normalizeGameServerList(payload, expectedGameId = null) {
  if (
    !isRecord(payload)
    || !Number.isSafeInteger(payload.directoryRevision)
    || payload.directoryRevision < 1
    || !Array.isArray(payload.servers)
    || payload.servers.length > 65_536
  ) {
    throw new InvalidApiPayloadError("区服列表响应无效");
  }
  const seen = new Set();
  const servers = payload.servers.map((value, index) => {
    let server;
    try {
      server = normalizeGameServer(value, expectedGameId);
    } catch (error) {
      if (error instanceof InvalidApiPayloadError) {
        throw new InvalidApiPayloadError(`servers[${index}] ${error.message}`);
      }
      throw error;
    }
    if (seen.has(server.serverId)) {
      throw new InvalidApiPayloadError(`servers[${index}].serverId 重复`);
    }
    seen.add(server.serverId);
    return server;
  });
  return Object.freeze({
    directoryRevision: payload.directoryRevision,
    servers: Object.freeze(servers),
  });
}

export function normalizeGameServerMutation(
  payload,
  expectedGameId,
  expectedServerId,
) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("区服写入响应无效");
  }
  return Object.freeze({
    directoryRevision: positiveInteger(
      payload.directoryRevision,
      "directoryRevision",
    ),
    server: normalizeGameServer(
      payload.server,
      expectedGameId,
      expectedServerId,
    ),
  });
}

export function normalizeWechatSecretMetadata(payload) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("微信 Secret 元数据无效");
  }
  const version = Number.isSafeInteger(payload.version)
    && payload.version >= 0
    ? payload.version
    : null;
  if (
    typeof payload.configured !== "boolean"
    || version === null
    || !["active", "missing"].includes(payload.state)
    || (payload.configured && (version < 1 || payload.state !== "active"))
    || (!payload.configured && payload.state !== "missing")
  ) {
    throw new InvalidApiPayloadError("微信 Secret 元数据无效");
  }
  return Object.freeze({
    configured: payload.configured,
    version,
    state: payload.state,
    updatedAt: nullableDate(payload.updatedAt, "wechatSecret.updatedAt"),
  });
}

export function normalizeGameIntegration(payload, expectedGameId = null) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("游戏接入配置响应无效");
  }
  assertNoSensitiveFields(payload, "游戏接入配置响应");
  const gameId = requiredString(payload.gameId, "gameId", 32);
  if (
    !GAME_ID_PATTERN.test(gameId)
    || (expectedGameId !== null && gameId !== expectedGameId)
    || !GAME_CONFIGURATION_STATES.has(payload.configurationState)
  ) {
    throw new InvalidApiPayloadError("游戏接入配置响应无效");
  }
  const wechatAppId = payload.wechatAppId === null
    ? null
    : requiredString(payload.wechatAppId, "wechatAppId", 128);
  const loadedRevision = payload.loadedRevision === null
    ? null
    : positiveInteger(payload.loadedRevision, "loadedRevision");
  return Object.freeze({
    gameId,
    configurationState: payload.configurationState,
    wechatAppId,
    wechatSecret: normalizeWechatSecretMetadata(payload.wechatSecret),
    wechatEndpoint: requiredWechatEndpoint(
      payload.wechatEndpoint,
      "wechatEndpoint",
    ),
    wechatTimeoutMs: positiveInteger(
      payload.wechatTimeoutMs,
      "wechatTimeoutMs",
      30_000,
    ),
    wechatBreakerThreshold: positiveInteger(
      payload.wechatBreakerThreshold,
      "wechatBreakerThreshold",
      1_000,
    ),
    wechatBreakerOpenMs: positiveInteger(
      payload.wechatBreakerOpenMs,
      "wechatBreakerOpenMs",
      600_000,
    ),
    sessionTtlSeconds: positiveInteger(
      payload.sessionTtlSeconds,
      "sessionTtlSeconds",
      31_536_000,
    ),
    loginRateCapacity: positiveNumber(
      payload.loginRateCapacity,
      "loginRateCapacity",
    ),
    loginRateRefillPerSecond: positiveNumber(
      payload.loginRateRefillPerSecond,
      "loginRateRefillPerSecond",
    ),
    adminRateCapacity: positiveNumber(
      payload.adminRateCapacity,
      "adminRateCapacity",
    ),
    adminRateRefillPerSecond: positiveNumber(
      payload.adminRateRefillPerSecond,
      "adminRateRefillPerSecond",
    ),
    revision: positiveInteger(payload.revision, "revision"),
    loadedRevision,
    createdAt: requiredDate(payload.createdAt, "createdAt"),
    updatedAt: requiredDate(payload.updatedAt, "updatedAt"),
  });
}

export function normalizeWechatSecretWrite(payload, expectedGameId = null) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("微信 Secret 写入响应无效");
  }
  assertNoSensitiveFields(payload, "微信 Secret 写入响应");
  const gameId = requiredString(payload.gameId, "gameId", 32);
  if (
    !GAME_ID_PATTERN.test(gameId)
    || (expectedGameId !== null && gameId !== expectedGameId)
    || !GAME_CONFIGURATION_STATES.has(payload.configurationState)
    || typeof payload.replayed !== "boolean"
  ) {
    throw new InvalidApiPayloadError("微信 Secret 写入响应无效");
  }
  return Object.freeze({
    gameId,
    configurationState: payload.configurationState,
    wechatSecret: normalizeWechatSecretMetadata(payload.wechatSecret),
    revision: positiveInteger(payload.revision, "revision"),
    loadedRevision: payload.loadedRevision === null
      ? null
      : positiveInteger(payload.loadedRevision, "loadedRevision"),
    replayed: payload.replayed,
  });
}

export function normalizeMachineSecretVersion(payload) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("机器 Secret 版本元数据无效");
  }
  assertNoSensitiveFields(payload, "机器 Secret 版本元数据");
  if (!MACHINE_SECRET_STATES.has(payload.state)) {
    throw new InvalidApiPayloadError("机器 Secret 状态无效");
  }
  return Object.freeze({
    version: positiveInteger(payload.version, "version"),
    state: payload.state,
    expiresAt: nullableDate(payload.expiresAt, "expiresAt"),
    createdAt: requiredDate(payload.createdAt, "createdAt"),
    activatedAt: requiredDate(payload.activatedAt, "activatedAt"),
    lastUsedAt: nullableDate(payload.lastUsedAt, "lastUsedAt"),
    revokedAt: nullableDate(payload.revokedAt, "revokedAt"),
  });
}

export function normalizeMachineIdentity(payload, expectedIdentityId = null) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("机器身份响应无效");
  }
  assertNoSensitiveFields(payload, "机器身份响应");
  const identityId = requiredString(payload.identityId, "identityId", 64);
  if (
    !MACHINE_ID_PATTERN.test(identityId)
    || (expectedIdentityId !== null && identityId !== expectedIdentityId)
    || !MACHINE_IDENTITY_TYPES.has(payload.identityType)
    || !MACHINE_IDENTITY_STATUSES.has(payload.status)
    || !Array.isArray(payload.gameIds)
    || !Array.isArray(payload.secretVersions)
  ) {
    throw new InvalidApiPayloadError("机器身份响应无效");
  }
  const gameIds = payload.gameIds.map((gameId, index) => {
    if (
      typeof gameId !== "string"
      || !GAME_ID_PATTERN.test(gameId)
    ) {
      throw new InvalidApiPayloadError(`gameIds[${index}] 无效`);
    }
    return gameId;
  });
  if (new Set(gameIds).size !== gameIds.length) {
    throw new InvalidApiPayloadError("gameIds 重复");
  }
  const secretVersions = payload.secretVersions.map(
    normalizeMachineSecretVersion,
  );
  if (
    new Set(secretVersions.map((version) => version.version)).size
      !== secretVersions.length
  ) {
    throw new InvalidApiPayloadError("secretVersions 重复");
  }
  return Object.freeze({
    identityId,
    identityType: payload.identityType,
    displayName: requiredString(payload.displayName, "displayName", 128),
    status: payload.status,
    gameIds: Object.freeze(gameIds),
    revision: positiveInteger(payload.revision, "revision"),
    secretVersions: Object.freeze(secretVersions),
    createdAt: requiredDate(payload.createdAt, "createdAt"),
    updatedAt: requiredDate(payload.updatedAt, "updatedAt"),
  });
}

export function normalizeMachineIdentityList(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.identities)) {
    throw new InvalidApiPayloadError("机器身份列表响应无效");
  }
  const identities = payload.identities.map(
    (identity) => normalizeMachineIdentity(identity),
  );
  if (
    new Set(identities.map((identity) => identity.identityId)).size
      !== identities.length
  ) {
    throw new InvalidApiPayloadError("机器身份 ID 重复");
  }
  return Object.freeze({ identities: Object.freeze(identities) });
}

export function normalizeMachineSecretIssued(
  payload,
  expectedIdentityId = null,
) {
  if (!isRecord(payload) || typeof payload.replayed !== "boolean") {
    throw new InvalidApiPayloadError("一次性机器 Secret 响应无效");
  }
  const machineIdentity = normalizeMachineIdentity(
    payload.identity,
    expectedIdentityId,
  );
  const version = positiveInteger(payload.version, "version");
  if (
    payload.secret !== undefined
    && (
      typeof payload.secret !== "string"
      || payload.secret.length !== 43
      || !/^[A-Za-z0-9_-]+$/u.test(payload.secret)
    )
  ) {
    throw new InvalidApiPayloadError("一次性机器 Secret 无效");
  }
  return Object.freeze({
    identity: machineIdentity,
    version,
    previousExpiresAt: nullableDate(
      payload.previousExpiresAt,
      "previousExpiresAt",
    ),
    replayed: payload.replayed,
    ...(payload.secret === undefined ? {} : { secret: payload.secret }),
  });
}

export function normalizeMachineSecretRevoked(
  payload,
  expectedIdentityId,
  expectedVersion,
) {
  if (
    !isRecord(payload)
    || payload.identityId !== expectedIdentityId
    || payload.version !== expectedVersion
    || payload.state !== "revoked"
    || typeof payload.replayed !== "boolean"
  ) {
    throw new InvalidApiPayloadError("机器 Secret 撤销响应无效");
  }
  return Object.freeze({
    identityId: payload.identityId,
    version: payload.version,
    state: "revoked",
    identityRevision: positiveInteger(
      payload.identityRevision,
      "identityRevision",
    ),
    replayed: payload.replayed,
  });
}

export function normalizeMachineSecretOperationStatus(
  payload,
  expectedIdentityId,
  expectedOperationId,
) {
  if (
    !isRecord(payload)
    || payload.identityId !== expectedIdentityId
    || payload.operationId !== expectedOperationId
    || !MACHINE_SECRET_ACTIONS.has(payload.action)
    || payload.status !== "succeeded"
    || typeof payload.deliveryLost !== "boolean"
  ) {
    throw new InvalidApiPayloadError("机器 Secret 操作状态响应无效");
  }
  assertNoSensitiveFields(payload, "机器 Secret 操作状态响应");
  return Object.freeze({
    operationId: payload.operationId,
    identityId: payload.identityId,
    action: payload.action,
    status: payload.status,
    version: payload.version === null
      ? null
      : positiveInteger(payload.version, "version"),
    deliveryLost: payload.deliveryLost,
    createdAt: requiredDate(payload.createdAt, "createdAt"),
  });
}

export function normalizeConfigurationAuditPage(payload) {
  if (
    !isRecord(payload)
    || !Array.isArray(payload.records)
    || payload.records.length > 100
  ) {
    throw new InvalidApiPayloadError("配置审计响应无效");
  }
  const records = payload.records.map((record, index) => {
    if (!isRecord(record)) {
      throw new InvalidApiPayloadError(`records[${index}] 无效`);
    }
    assertNoSensitiveFields(record, `records[${index}]`);
    if (
      ![
        "game_configuration",
        "machine_identity",
        "secret",
      ].includes(record.auditType)
    ) {
      throw new InvalidApiPayloadError(`records[${index}] 无效`);
    }
    const gameId = record.gameId === null
      ? null
      : requiredString(record.gameId, `records[${index}].gameId`, 32);
    const identityId = record.identityId === null
      ? null
      : requiredString(
          record.identityId,
          `records[${index}].identityId`,
          64,
        );
    const operatorId = requiredString(
      record.operatorId,
      `records[${index}].operatorId`,
      64,
    );
    if (
      (gameId !== null && !GAME_ID_PATTERN.test(gameId))
      || (identityId !== null && !MACHINE_ID_PATTERN.test(identityId))
      || !OPERATOR_ID_PATTERN.test(operatorId)
    ) {
      throw new InvalidApiPayloadError(`records[${index}] 无效`);
    }
    return Object.freeze({
      id: requiredString(record.id, `records[${index}].id`, 128),
      auditType: record.auditType,
      operatorId,
      gameId,
      identityId,
      action: requiredString(
        record.action,
        `records[${index}].action`,
        64,
      ),
      result: requiredString(
        record.result,
        `records[${index}].result`,
        64,
      ),
      oldVersion: record.oldVersion === null
        ? null
        : nonNegativeInteger(record.oldVersion, "oldVersion"),
      newVersion: record.newVersion === null
        ? null
        : nonNegativeInteger(record.newVersion, "newVersion"),
      createdAt: requiredDate(
        record.createdAt,
        `records[${index}].createdAt`,
      ),
    });
  });
  return Object.freeze({ records: Object.freeze(records) });
}

export function unixSecondsToDateTimeLocal(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Unix 秒必须是非负安全整数");
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  if (year.length !== 4) {
    return "";
  }
  const pad = (part) => String(part).padStart(2, "0");
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function dateTimeLocalToUnixSeconds(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/u
    .exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    0,
  );
  if (
    date.getFullYear() !== parts[0]
    || date.getMonth() !== parts[1] - 1
    || date.getDate() !== parts[2]
    || date.getHours() !== parts[3]
    || date.getMinutes() !== parts[4]
    || date.getSeconds() !== parts[5]
  ) {
    return null;
  }
  const unixSeconds = date.getTime() / 1_000;
  return Number.isSafeInteger(unixSeconds) && unixSeconds >= 0
    ? unixSeconds
    : null;
}

export function canSelectGameStatus(game, status) {
  if (!isRecord(game) || !GAME_STATUSES.has(status)) {
    return false;
  }
  if (game.status === "disabled") {
    return status === "disabled";
  }
  return !(game.configurationState === "draft" && status === "enabled");
}

export function canPublishGameToClient(game, status = game?.status) {
  return (
    isRecord(game)
    && game.configurationState === "configured"
    && GAME_STATUSES.has(status)
    && status !== "disabled"
  );
}

export function normalizeAccount(payload, expectedUserId = null) {
  if (!isRecord(payload)) {
    throw new InvalidApiPayloadError("账号响应无效");
  }
  const userId = requiredString(payload.userId, "userId", 32);
  if (
    !USER_ID_PATTERN.test(userId)
    || (expectedUserId !== null && userId !== expectedUserId)
  ) {
    throw new InvalidApiPayloadError("userId 无效");
  }
  if (!ACCOUNT_STATUSES.has(payload.status)) {
    throw new InvalidApiPayloadError("status 无效");
  }
  if (
    !Number.isSafeInteger(payload.activeSessionCount)
    || payload.activeSessionCount < 0
  ) {
    throw new InvalidApiPayloadError("activeSessionCount 无效");
  }
  return Object.freeze({
    userId,
    status: payload.status,
    lastLoginAt: nullableDate(payload.lastLoginAt, "lastLoginAt"),
    activeSessionCount: payload.activeSessionCount,
  });
}

export function normalizeOperationResult(payload, expectedAction) {
  if (!ADMIN_ACTIONS.includes(expectedAction)) {
    throw new TypeError("未知管理员操作");
  }
  const expectedStatus = expectedAction === "ban" ? "banned" : "revoked";
  if (
    !isRecord(payload)
    || typeof payload.accountExists !== "boolean"
    || !OPERATION_STATUSES.has(payload.status)
    || (payload.accountExists && payload.status !== expectedStatus)
    || (!payload.accountExists && payload.status !== "not_found")
  ) {
    throw new InvalidApiPayloadError("账号操作响应无效");
  }
  return Object.freeze({
    accountExists: payload.accountExists,
    status: payload.status,
  });
}

export function isValidUserId(value) {
  return typeof value === "string" && USER_ID_PATTERN.test(value.trim());
}

export function isValidAdminPasswordInput(value) {
  if (typeof value !== "string") {
    return false;
  }
  const codePoints = [...value];
  return (
    codePoints.length >= 12
    && codePoints.length <= 256
    && new TextEncoder().encode(value).length <= 1_024
    && !codePoints.some((character) => (
      character.length === 1
      && character.charCodeAt(0) >= 0xd800
      && character.charCodeAt(0) <= 0xdfff
    ))
  );
}

export function chooseInitialGame(games, currentGameId = null) {
  if (
    currentGameId
    && games.some((game) => game.gameId === currentGameId)
  ) {
    return currentGameId;
  }
  return games.length === 1 ? games[0].gameId : null;
}

export function isSessionExpired(session, timestamp = Date.now()) {
  return Date.parse(session.expiresAt) <= timestamp;
}

export function createLatestRequestGuard() {
  let version = 0;
  return Object.freeze({
    begin() {
      version += 1;
      return version;
    },
    invalidate() {
      version += 1;
    },
    isCurrent(requestVersion) {
      return requestVersion === version;
    },
  });
}

export function accountPath(gameId, userId) {
  return `/v1/games/${encodeURIComponent(gameId)}/admin/accounts/${encodeURIComponent(userId)}`;
}

export function gameProjectPath(gameId = null) {
  return gameId === null
    ? "/v1/admin/games"
    : `/v1/admin/games/${encodeURIComponent(gameId)}`;
}

export function gameServerPath(gameId, serverId = null) {
  const base = `${gameProjectPath(gameId)}/servers`;
  return serverId === null
    ? base
    : `${base}/${encodeURIComponent(String(serverId))}`;
}

export function directorySettingsPath(gameId) {
  return `${gameProjectPath(gameId)}/directory-settings`;
}

export function gameIntegrationPath(gameId) {
  return `${gameProjectPath(gameId)}/integration`;
}

export function wechatAppSecretPath(gameId) {
  return `${gameProjectPath(gameId)}/secrets/wechat-app-secret`;
}

export function machineIdentityPath(identityId = null) {
  return identityId === null
    ? "/v1/admin/machine-identities"
    : `/v1/admin/machine-identities/${encodeURIComponent(identityId)}`;
}

export function machineSecretRotationPath(identityId, operationId = null) {
  const base = `${machineIdentityPath(identityId)}/secret-rotations`;
  return operationId === null
    ? base
    : `${base}/${encodeURIComponent(operationId)}`;
}

export function machineSecretRevokePath(identityId, version) {
  return `${machineIdentityPath(identityId)}/secret-versions/`
    + `${encodeURIComponent(String(version))}/revoke`;
}

export function configurationAuditPath(gameId = null, limit = 50) {
  const query = new URLSearchParams();
  if (gameId !== null) {
    query.set("gameId", gameId);
  }
  query.set("limit", String(limit));
  return `/v1/admin/config-audit?${query}`;
}

export function createConfigurationOperationId(
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
) {
  if (typeof randomUUID !== "function") {
    throw new Error("当前环境不支持安全的 operationId");
  }
  const operationId = randomUUID();
  if (
    typeof operationId !== "string"
    || !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error("安全 operationId 无效");
  }
  return operationId;
}

export function createOperationIntent({
  action,
  gameId,
  userId,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
}) {
  if (!ADMIN_ACTIONS.includes(action)) {
    throw new TypeError("未知管理员操作");
  }
  if (!GAME_ID_PATTERN.test(gameId) || !USER_ID_PATTERN.test(userId)) {
    throw new TypeError("操作目标无效");
  }
  if (typeof randomUUID !== "function") {
    throw new Error("当前环境不支持安全的 operationId");
  }
  return Object.freeze({
    action,
    gameId,
    userId,
    operationId: randomUUID(),
  });
}

export function reuseOrCreateOperationIntent({
  previous = null,
  action,
  gameId,
  userId,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
}) {
  if (
    previous
    && previous.action === action
    && previous.gameId === gameId
    && previous.userId === userId
  ) {
    return previous;
  }
  return createOperationIntent({
    action,
    gameId,
    userId,
    randomUUID,
  });
}

function retryAfterSeconds(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw || !/^[0-9]+$/u.test(raw)) {
    return null;
  }
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

async function responsePayload(response) {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    if (response.ok) {
      throw new InvalidApiPayloadError("服务返回了无法解析的响应");
    }
    return null;
  }
}

export function createAdminApi(fetchImpl = globalThis.fetch, {
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  AbortControllerImpl = globalThis.AbortController,
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancelSchedule = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("缺少 fetch 实现");
  }
  if (
    !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs <= 0
    || typeof AbortControllerImpl !== "function"
    || typeof schedule !== "function"
    || typeof cancelSchedule !== "function"
  ) {
    throw new TypeError("API 请求超时配置无效");
  }

  async function request(path, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortControllerImpl();
    const timeout = schedule(() => controller.abort(), requestTimeoutMs);
    let response;
    let payload;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      payload = await responsePayload(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AdminApiError("管理服务响应超时", {
          code: "REQUEST_TIMEOUT",
          cause: error,
        });
      }
      if (error instanceof InvalidApiPayloadError) {
        throw error;
      }
      throw new AdminApiError("无法连接管理服务", { cause: error });
    } finally {
      cancelSchedule(timeout);
    }

    const requestId = response.headers?.get?.("x-request-id") ?? null;
    if (!response.ok) {
      throw new AdminApiError("管理服务拒绝了请求", {
        status: response.status,
        code:
          isRecord(payload) && typeof payload.code === "string"
            ? payload.code
            : `HTTP_${response.status}`,
        requestId,
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }
    return payload;
  }

  return Object.freeze({
    async login(operatorId, password) {
      await request("/v1/admin/auth/login", {
        method: "POST",
        body: { operatorId, password },
      });
    },
    async reauthenticate(password) {
      await request("/v1/admin/auth/reauthenticate", {
        method: "POST",
        body: { password },
      });
    },
    async session() {
      return normalizeSession(await request("/v1/admin/auth/session"));
    },
    async logout() {
      await request("/v1/admin/auth/session", { method: "DELETE" });
    },
    async listGames() {
      return normalizeGameProjectList(await request(gameProjectPath())).games;
    },
    async createGame(input) {
      return normalizeGameProject(await request(gameProjectPath(), {
        method: "POST",
        body: input,
      }));
    },
    async updateGame(gameId, input) {
      return normalizeGameProject(await request(gameProjectPath(gameId), {
        method: "PATCH",
        body: input,
      }));
    },
    async listGameServers(gameId) {
      return normalizeGameServerList(
        await request(gameServerPath(gameId)),
        gameId,
      );
    },
    async createGameServer(gameId, input) {
      return normalizeGameServerMutation(
        await request(gameServerPath(gameId), {
          method: "POST",
          body: input,
        }),
        gameId,
        input.serverId,
      );
    },
    async updateGameServer(gameId, serverId, input) {
      return normalizeGameServerMutation(
        await request(gameServerPath(gameId, serverId), {
          method: "PATCH",
          body: input,
        }),
        gameId,
        serverId,
      );
    },
    async getDirectorySettings(gameId) {
      return normalizeDirectorySettings(
        await request(directorySettingsPath(gameId)),
        gameId,
      );
    },
    async updateDirectorySettings(gameId, input) {
      return normalizeDirectorySettings(
        await request(directorySettingsPath(gameId), {
          method: "PATCH",
          body: input,
        }),
        gameId,
      );
    },
    async getGameIntegration(gameId) {
      return normalizeGameIntegration(
        await request(gameIntegrationPath(gameId)),
        gameId,
      );
    },
    async updateGameIntegration(gameId, input) {
      return normalizeGameIntegration(
        await request(gameIntegrationPath(gameId), {
          method: "PATCH",
          body: input,
        }),
        gameId,
      );
    },
    async replaceWechatAppSecret(gameId, input) {
      return normalizeWechatSecretWrite(
        await request(wechatAppSecretPath(gameId), {
          method: "PUT",
          body: input,
        }),
        gameId,
      );
    },
    async listMachineIdentities() {
      return normalizeMachineIdentityList(
        await request(machineIdentityPath()),
      ).identities;
    },
    async createMachineIdentity(input) {
      return normalizeMachineSecretIssued(
        await request(machineIdentityPath(), {
          method: "POST",
          body: input,
        }),
        input.identityId,
      );
    },
    async updateMachineIdentity(identityId, input) {
      return normalizeMachineIdentity(
        await request(machineIdentityPath(identityId), {
          method: "PATCH",
          body: input,
        }),
        identityId,
      );
    },
    async rotateMachineSecret(identityId, input) {
      return normalizeMachineSecretIssued(
        await request(machineSecretRotationPath(identityId), {
          method: "POST",
          body: input,
        }),
        identityId,
      );
    },
    async revokeMachineSecret(identityId, version, input) {
      return normalizeMachineSecretRevoked(
        await request(machineSecretRevokePath(identityId, version), {
          method: "POST",
          body: input,
        }),
        identityId,
        version,
      );
    },
    async machineSecretOperationStatus(identityId, operationId) {
      return normalizeMachineSecretOperationStatus(
        await request(machineSecretRotationPath(identityId, operationId)),
        identityId,
        operationId,
      );
    },
    async listConfigurationAudit(gameId = null, limit = 50) {
      return normalizeConfigurationAuditPage(
        await request(configurationAuditPath(gameId, limit)),
      ).records;
    },
    async findAccount(gameId, userId) {
      return normalizeAccount(
        await request(accountPath(gameId, userId)),
        userId,
      );
    },
    async perform(intent, reason) {
      return normalizeOperationResult(
        await request(`${accountPath(intent.gameId, intent.userId)}/${intent.action}`, {
          method: "POST",
          body: {
            operationId: intent.operationId,
            reason,
          },
        }),
        intent.action,
      );
    },
  });
}

function requestIdSuffix(error) {
  return error instanceof AdminApiError && error.requestId
    ? `（请求 ID：${error.requestId}）`
    : "";
}

export function describeApiError(error, context) {
  const suffix = requestIdSuffix(error);
  if (!(error instanceof AdminApiError)) {
    return `页面处理响应时发生错误，请稍后重试。${suffix}`;
  }
  if (error.status === 401) {
    return context === "login"
      ? "账号或密码错误。"
      : "管理员会话已过期，请重新登录。";
  }
  if (error.status === 403) {
    return `当前管理员没有执行此操作的权限。${suffix}`;
  }
  if (
    error.status === 400
    && typeof context === "string"
    && context.startsWith("game")
  ) {
    return `游戏项目信息无效，请检查后重试。${suffix}`;
  }
  if (
    error.status === 400
    && typeof context === "string"
    && context.startsWith("server")
  ) {
    return `区服信息无效，请检查后重试。${suffix}`;
  }
  if (error.status === 404 && context === "account") {
    return "当前游戏中不存在这个用户 ID。";
  }
  if (error.status === 404 && context === "game-update") {
    return `这个游戏项目已不存在，请关闭窗口后重新加载。${suffix}`;
  }
  if (
    error.status === 404
    && typeof context === "string"
    && context.startsWith("server")
  ) {
    return `这个游戏或区服已不存在，请关闭窗口后重新加载。${suffix}`;
  }
  if (error.status === 409) {
    if (context === "game-create") {
      return `游戏 ID 已存在，请使用另一个 ID。${suffix}`;
    }
    if (context === "game-update") {
      return `游戏项目已被其他管理员修改，请关闭窗口后重新加载。${suffix}`;
    }
    if (context === "server-create") {
      return `区服 ID 已存在，请使用另一个 ID。${suffix}`;
    }
    if (context === "server-update") {
      return `区服已被其他管理员修改，请取消编辑；页面会加载最新版本后再编辑。${suffix}`;
    }
    return `操作标识与已有记录冲突，请关闭窗口后重新发起。${suffix}`;
  }
  if (error.status === 429) {
    const wait = error.retryAfterSeconds;
    return wait === null
      ? `请求过于频繁，请稍后再试。${suffix}`
      : `请求过于频繁，请在 ${wait} 秒后重试。${suffix}`;
  }
  if (error.status >= 500) {
    return `管理服务暂时不可用，请稍后重试。${suffix}`;
  }
  if (error.status === 0) {
    return error.code === "REQUEST_TIMEOUT"
      ? "管理服务响应超时，请重试。"
      : "无法连接管理服务，请检查网络后重试。";
  }
  return `请求未完成，请稍后重试。${suffix}`;
}

export function isCompletedLogout(error) {
  return (
    error === null
    || (error instanceof AdminApiError && error.status === 401)
  );
}

export function formatDateTime(value, locale = "zh-CN") {
  if (value === null) {
    return "从未登录";
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function requiredElement(document, id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`管理员页面缺少 #${id}`);
  }
  return element;
}

function setButtonBusy(button, busy, { idleLabel, busyLabel }) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  const spinner = button.querySelector("[data-button-spinner]");
  const icon = button.querySelector("[data-button-icon]");
  const label = button.querySelector("[data-button-label]");
  if (spinner) {
    spinner.hidden = !busy;
  }
  if (icon) {
    icon.hidden = busy;
  }
  if (label) {
    label.textContent = busy ? busyLabel : idleLabel;
  }
}

function setBadge(element, text, variant) {
  element.textContent = text;
  element.className = "wsk-badge";
  if (variant === "danger") {
    element.classList.add("gmk-status-danger");
  } else if (variant) {
    element.classList.add(`wsk-${variant}`);
  }
}

function gameStatusPresentation(game) {
  if (!game) {
    return { text: "请选择游戏", variant: null };
  }
  if (game.status === "enabled") {
    return { text: "游戏已启用", variant: "success" };
  }
  if (game.status === "maintenance") {
    return { text: "游戏维护中", variant: "warning" };
  }
  return { text: "游戏已停用", variant: "danger" };
}

function serverTagPresentation(tag) {
  const labels = {
    normal: "普通",
    new: "新服",
    full: "爆满",
    maintenance: "维护标签",
  };
  return {
    text: labels[tag] ?? tag,
    variant:
      tag === "new"
        ? "accent"
        : tag === "maintenance"
          ? "warning"
          : tag === "full"
            ? "danger"
            : null,
  };
}

function serverStatusPresentation(status) {
  if (status === "smooth") {
    return { text: "流畅", variant: "success" };
  }
  return status === "busy"
    ? { text: "繁忙", variant: "warning" }
    : { text: "维护中", variant: "danger" };
}

function formatUnixTime(value) {
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime())
    ? formatDateTime(date)
    : `${value}（Unix 秒）`;
}

export function accountStatusPresentation(account) {
  if (account.status === "active") {
    return { text: "正常", variant: "success" };
  }
  return account.status === "banned"
    ? { text: "已封禁", variant: "danger" }
    : { text: "已注销", variant: "warning" };
}

export function canPerformAccountAction(account, action, canOperateAccounts) {
  if (
    !canOperateAccounts
    || account.status === "deregistered"
    || !ADMIN_ACTIONS.includes(action)
  ) {
    return false;
  }
  return action === "ban"
    ? account.status !== "banned"
    : account.activeSessionCount > 0;
}

export function chooseAdminView(session, hash = "") {
  if (!session) {
    return "login";
  }
  const canManageConfiguration =
    session.canManageIntegrations || session.canManageMachineIdentities;
  if (hash === "#integration" && canManageConfiguration) {
    return "integration";
  }
  if (hash === "#games" && session.canManageGames) {
    return "games";
  }
  if (session.games.length > 0) {
    return "accounts";
  }
  if (session.canManageGames) {
    return "games";
  }
  return canManageConfiguration ? "integration" : "no-access";
}

export function bootstrapAdminConsole({
  document = globalThis.document,
  window = globalThis.window,
  api = createAdminApi(),
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  now = () => Date.now(),
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancelSchedule = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!document || !window || !schedule || !cancelSchedule) {
    throw new Error("管理员控制台需要浏览器环境");
  }

  initTheme({ root: document.documentElement });
  initPasswordControls({ document });
  const toast = createToastController({ document, schedule });
  const sessionRequests = createLatestRequestGuard();
  const loginRequests = createLatestRequestGuard();
  const gameRequests = createLatestRequestGuard();
  const serverRequests = createLatestRequestGuard();
  const configurationRequests = createLatestRequestGuard();

  const elements = {
    views: new Map(
      [...document.querySelectorAll("[data-view]")].map((view) => [
        view.dataset.view,
        view,
      ]),
    ),
    sessionTools: requiredElement(document, "session-tools"),
    gameSelect: requiredElement(document, "game-select"),
    gameField: document.querySelector(".gmk-game-field"),
    operatorName: requiredElement(document, "operator-name"),
    logoutButtons: [
      requiredElement(document, "logout-button"),
      requiredElement(document, "no-access-logout"),
      requiredElement(document, "sidebar-logout"),
      requiredElement(document, "games-sidebar-logout"),
      requiredElement(document, "integration-sidebar-logout"),
    ],
    bootSpinner: requiredElement(document, "boot-spinner"),
    bootMessage: requiredElement(document, "boot-message"),
    bootRetry: requiredElement(document, "boot-retry"),
    loginForm: requiredElement(document, "login-form"),
    operatorId: requiredElement(document, "operator-id"),
    password: requiredElement(document, "operator-password"),
    passwordToggle: requiredElement(document, "password-toggle"),
    loginButton: requiredElement(document, "login-button"),
    loginError: requiredElement(document, "login-error"),
    loginErrorMessage: requiredElement(document, "login-error-message"),
    selectedGameLabel: requiredElement(document, "selected-game-label"),
    gameStatusBadge: requiredElement(document, "game-status-badge"),
    searchForm: requiredElement(document, "account-search-form"),
    userId: requiredElement(document, "account-user-id"),
    searchButton: requiredElement(document, "search-button"),
    accountLiveStatus: requiredElement(document, "account-live-status"),
    accountEmpty: requiredElement(document, "account-empty"),
    accountEmptyTitle: requiredElement(document, "account-empty-title"),
    accountEmptyMessage: requiredElement(document, "account-empty-message"),
    accountLoading: requiredElement(document, "account-loading"),
    accountNotFound: requiredElement(document, "account-not-found"),
    accountNotFoundMessage: requiredElement(document, "account-not-found-message"),
    accountError: requiredElement(document, "account-error"),
    accountErrorMessage: requiredElement(document, "account-error-message"),
    accountCard: requiredElement(document, "account-card"),
    accountCardUserId: requiredElement(document, "account-card-user-id"),
    accountStatusBadge: requiredElement(document, "account-status-badge"),
    accountGame: requiredElement(document, "account-game"),
    accountLastLogin: requiredElement(document, "account-last-login"),
    accountSessionCount: requiredElement(document, "account-session-count"),
    operationHelp: requiredElement(document, "operation-capability-help"),
    operationButtons: [...document.querySelectorAll("[data-operation]")],
    dialog: requiredElement(document, "operation-dialog"),
    operationForm: requiredElement(document, "operation-form"),
    dialogClose: requiredElement(document, "operation-dialog-close"),
    operationCancel: requiredElement(document, "operation-cancel"),
    operationConfirm: requiredElement(document, "operation-confirm"),
    operationTitle: requiredElement(document, "operation-dialog-title"),
    operationKind: requiredElement(document, "operation-dialog-kind"),
    operationTarget: requiredElement(document, "operation-dialog-target"),
    operationDescription: requiredElement(
      document,
      "operation-dialog-description",
    ),
    operationReason: requiredElement(document, "operation-reason"),
    operationError: requiredElement(document, "operation-error"),
    operationErrorMessage: requiredElement(
      document,
      "operation-error-message",
    ),
    accountsGamesLink: requiredElement(document, "accounts-games-link"),
    gamesAccountsLink: requiredElement(document, "games-accounts-link"),
    accountsIntegrationLink: requiredElement(
      document,
      "accounts-integration-link",
    ),
    gamesIntegrationLink: requiredElement(
      document,
      "games-integration-link",
    ),
    integrationAccountsLink: requiredElement(
      document,
      "integration-accounts-link",
    ),
    integrationGamesLink: requiredElement(
      document,
      "integration-games-link",
    ),
    gameCreateButton: requiredElement(document, "game-create-button"),
    gamesEmptyCreate: requiredElement(document, "games-empty-create"),
    gamesLiveStatus: requiredElement(document, "games-live-status"),
    gamesLoading: requiredElement(document, "games-loading"),
    gamesError: requiredElement(document, "games-error"),
    gamesErrorMessage: requiredElement(document, "games-error-message"),
    gamesRetry: requiredElement(document, "games-retry"),
    gamesEmpty: requiredElement(document, "games-empty"),
    gamesList: requiredElement(document, "games-list"),
    gameDialog: requiredElement(document, "game-dialog"),
    gameForm: requiredElement(document, "game-form"),
    gameDialogClose: requiredElement(document, "game-dialog-close"),
    gameCancel: requiredElement(document, "game-cancel"),
    gameSubmit: requiredElement(document, "game-submit"),
    gameDialogKind: requiredElement(document, "game-dialog-kind"),
    gameDialogTitle: requiredElement(document, "game-dialog-title"),
    gameDialogDescription: requiredElement(
      document,
      "game-dialog-description",
    ),
    gameId: requiredElement(document, "game-id"),
    gameName: requiredElement(document, "game-name"),
    gameDescription: requiredElement(document, "game-description"),
    gameStatus: requiredElement(document, "game-status"),
    gameStatusHelp: requiredElement(document, "game-status-help"),
    gameClientVisible: requiredElement(document, "game-client-visible"),
    gameClientVisibleHelp: requiredElement(
      document,
      "game-client-visible-help",
    ),
    gameSortOrder: requiredElement(document, "game-sort-order"),
    gameDisableWarning: requiredElement(document, "game-disable-warning"),
    gameDisableConfirm: requiredElement(document, "game-disable-confirm"),
    gameFormError: requiredElement(document, "game-form-error"),
    gameFormErrorMessage: requiredElement(
      document,
      "game-form-error-message",
    ),
    serverDialog: requiredElement(document, "server-dialog"),
    serverDialogTitle: requiredElement(document, "server-dialog-title"),
    serverDialogDescription: requiredElement(
      document,
      "server-dialog-description",
    ),
    serverDialogClose: requiredElement(document, "server-dialog-close"),
    serverGameLabel: requiredElement(document, "server-game-label"),
    serverSummary: requiredElement(document, "server-summary"),
    serverCreateButton: requiredElement(document, "server-create-button"),
    serversEmptyCreate: requiredElement(document, "servers-empty-create"),
    serversLiveStatus: requiredElement(document, "servers-live-status"),
    serversLoading: requiredElement(document, "servers-loading"),
    serversError: requiredElement(document, "servers-error"),
    serversErrorMessage: requiredElement(document, "servers-error-message"),
    serversRetry: requiredElement(document, "servers-retry"),
    serversEmpty: requiredElement(document, "servers-empty"),
    serversList: requiredElement(document, "servers-list"),
    serverEditor: requiredElement(document, "server-editor"),
    serverForm: requiredElement(document, "server-form"),
    serverEditorKind: requiredElement(document, "server-editor-kind"),
    serverEditorTitle: requiredElement(document, "server-editor-title"),
    serverEditorClose: requiredElement(document, "server-editor-close"),
    serverId: requiredElement(document, "server-id"),
    serverName: requiredElement(document, "server-name"),
    serverTag: requiredElement(document, "server-tag"),
    serverStatus: requiredElement(document, "server-status"),
    serverStatusHelp: requiredElement(document, "server-status-help"),
    serverOpenTime: requiredElement(document, "server-open-time"),
    serverHttpUrl: requiredElement(document, "server-http-url"),
    serverWsUrl: requiredElement(document, "server-ws-url"),
    serverIsOpen: requiredElement(document, "server-is-open"),
    serverIsOpenHelp: requiredElement(document, "server-is-open-help"),
    serverSortOrder: requiredElement(document, "server-sort-order"),
    serverFormError: requiredElement(document, "server-form-error"),
    serverFormErrorMessage: requiredElement(
      document,
      "server-form-error-message",
    ),
    serverCancel: requiredElement(document, "server-cancel"),
    serverSubmit: requiredElement(document, "server-submit"),
    integrationGameSelect: requiredElement(
      document,
      "integration-game-select",
    ),
    integrationRefresh: requiredElement(document, "integration-refresh"),
    integrationLoading: requiredElement(document, "integration-loading"),
    integrationError: requiredElement(document, "integration-error"),
    integrationErrorMessage: requiredElement(
      document,
      "integration-error-message",
    ),
    integrationRetry: requiredElement(document, "integration-retry"),
    integrationContent: requiredElement(document, "integration-content"),
    integrationSettingsSection: requiredElement(
      document,
      "integration-settings-section",
    ),
    configurationCompletenessSummary: requiredElement(
      document,
      "configuration-completeness-summary",
    ),
    configurationCompletenessScore: requiredElement(
      document,
      "configuration-completeness-score",
    ),
    configurationStateBadge: requiredElement(
      document,
      "configuration-state-badge",
    ),
    configurationCheckList: requiredElement(
      document,
      "configuration-check-list",
    ),
    configurationLoadedRevision: requiredElement(
      document,
      "configuration-loaded-revision",
    ),
    integrationForm: requiredElement(document, "integration-form"),
    integrationWechatAppId: requiredElement(
      document,
      "integration-wechat-app-id",
    ),
    integrationWechatEndpoint: requiredElement(
      document,
      "integration-wechat-endpoint",
    ),
    integrationWechatTimeout: requiredElement(
      document,
      "integration-wechat-timeout",
    ),
    integrationBreakerThreshold: requiredElement(
      document,
      "integration-breaker-threshold",
    ),
    integrationBreakerOpen: requiredElement(
      document,
      "integration-breaker-open",
    ),
    integrationSessionTtl: requiredElement(
      document,
      "integration-session-ttl",
    ),
    integrationLoginCapacity: requiredElement(
      document,
      "integration-login-capacity",
    ),
    integrationLoginRefill: requiredElement(
      document,
      "integration-login-refill",
    ),
    integrationAdminCapacity: requiredElement(
      document,
      "integration-admin-capacity",
    ),
    integrationAdminRefill: requiredElement(
      document,
      "integration-admin-refill",
    ),
    wechatSecretStatusBadge: requiredElement(
      document,
      "wechat-secret-status-badge",
    ),
    directoryRevisionLabel: requiredElement(
      document,
      "directory-revision-label",
    ),
    directoryIsOps: requiredElement(document, "directory-is-ops"),
    directorySave: requiredElement(document, "directory-save"),
    integrationFormError: requiredElement(
      document,
      "integration-form-error",
    ),
    integrationFormErrorMessage: requiredElement(
      document,
      "integration-form-error-message",
    ),
    wechatSecretReplace: requiredElement(
      document,
      "wechat-secret-replace",
    ),
    integrationSave: requiredElement(document, "integration-save"),
    machineIdentitiesSection: requiredElement(
      document,
      "machine-identities-section",
    ),
    machineIdentityCreate: requiredElement(
      document,
      "machine-identity-create",
    ),
    machineIdentitiesList: requiredElement(
      document,
      "machine-identities-list",
    ),
    machineIdentitiesEmpty: requiredElement(
      document,
      "machine-identities-empty",
    ),
    configurationAuditSection: requiredElement(
      document,
      "configuration-audit-section",
    ),
    configurationAuditList: requiredElement(
      document,
      "configuration-audit-list",
    ),
    configurationAuditEmpty: requiredElement(
      document,
      "configuration-audit-empty",
    ),
    reauthenticateDialog: requiredElement(
      document,
      "reauthenticate-dialog",
    ),
    reauthenticateForm: requiredElement(document, "reauthenticate-form"),
    reauthenticateClose: requiredElement(document, "reauthenticate-close"),
    reauthenticatePassword: requiredElement(
      document,
      "reauthenticate-password",
    ),
    reauthenticatePasswordToggle: requiredElement(
      document,
      "reauthenticate-password-toggle",
    ),
    reauthenticateError: requiredElement(
      document,
      "reauthenticate-error",
    ),
    reauthenticateErrorMessage: requiredElement(
      document,
      "reauthenticate-error-message",
    ),
    reauthenticateCancel: requiredElement(
      document,
      "reauthenticate-cancel",
    ),
    reauthenticateSubmit: requiredElement(
      document,
      "reauthenticate-submit",
    ),
    wechatSecretDialog: requiredElement(document, "wechat-secret-dialog"),
    wechatSecretForm: requiredElement(document, "wechat-secret-form"),
    wechatSecretClose: requiredElement(document, "wechat-secret-close"),
    wechatSecretInput: requiredElement(document, "wechat-secret-input"),
    wechatSecretToggle: requiredElement(document, "wechat-secret-toggle"),
    wechatSecretError: requiredElement(document, "wechat-secret-error"),
    wechatSecretErrorMessage: requiredElement(
      document,
      "wechat-secret-error-message",
    ),
    wechatSecretCancel: requiredElement(document, "wechat-secret-cancel"),
    wechatSecretSubmit: requiredElement(document, "wechat-secret-submit"),
    machineIdentityDialog: requiredElement(
      document,
      "machine-identity-dialog",
    ),
    machineIdentityForm: requiredElement(document, "machine-identity-form"),
    machineIdentityDialogKind: requiredElement(
      document,
      "machine-identity-dialog-kind",
    ),
    machineIdentityDialogTitle: requiredElement(
      document,
      "machine-identity-dialog-title",
    ),
    machineIdentityClose: requiredElement(
      document,
      "machine-identity-close",
    ),
    machineIdentityId: requiredElement(document, "machine-identity-id"),
    machineIdentityType: requiredElement(
      document,
      "machine-identity-type",
    ),
    machineIdentityName: requiredElement(
      document,
      "machine-identity-name",
    ),
    machineIdentityStatus: requiredElement(
      document,
      "machine-identity-status",
    ),
    machineScopeOptions: requiredElement(document, "machine-scope-options"),
    machineIdentityError: requiredElement(
      document,
      "machine-identity-error",
    ),
    machineIdentityErrorMessage: requiredElement(
      document,
      "machine-identity-error-message",
    ),
    machineIdentityCancel: requiredElement(
      document,
      "machine-identity-cancel",
    ),
    machineIdentitySubmit: requiredElement(
      document,
      "machine-identity-submit",
    ),
    machineRevokeDialog: requiredElement(document, "machine-revoke-dialog"),
    machineRevokeForm: requiredElement(document, "machine-revoke-form"),
    machineRevokeClose: requiredElement(document, "machine-revoke-close"),
    machineRevokeTarget: requiredElement(document, "machine-revoke-target"),
    machineRevokeReason: requiredElement(document, "machine-revoke-reason"),
    machineRevokeError: requiredElement(document, "machine-revoke-error"),
    machineRevokeErrorMessage: requiredElement(
      document,
      "machine-revoke-error-message",
    ),
    machineRevokeCancel: requiredElement(document, "machine-revoke-cancel"),
    machineRevokeSubmit: requiredElement(document, "machine-revoke-submit"),
    oneTimeSecretDialog: requiredElement(
      document,
      "one-time-secret-dialog",
    ),
    oneTimeSecretContext: requiredElement(
      document,
      "one-time-secret-context",
    ),
    oneTimeSecretValue: requiredElement(
      document,
      "one-time-secret-value",
    ),
    oneTimeSecretToggle: requiredElement(
      document,
      "one-time-secret-toggle",
    ),
    oneTimeSecretCopy: requiredElement(
      document,
      "one-time-secret-copy",
    ),
    oneTimeSecretConfirm: requiredElement(
      document,
      "one-time-secret-confirm",
    ),
    oneTimeSecretClose: requiredElement(
      document,
      "one-time-secret-close",
    ),
    toastRegion: requiredElement(document, "toast-region"),
  };

  const state = {
    session: null,
    selectedGameId: null,
    account: null,
    accountRequestVersion: 0,
    pendingOperation: null,
    retryOperation: null,
    operationSubmitting: false,
    loginSubmitting: false,
    logoutSubmitting: false,
    operationOpener: null,
    managedGames: [],
    managedGamesLoaded: false,
    gameFormMode: null,
    editingGame: null,
    gameSubmitting: false,
    gameOpener: null,
    serverGame: null,
    directoryRevision: null,
    managedServers: [],
    managedServersLoaded: false,
    serverFormMode: null,
    editingServer: null,
    serverSubmitting: false,
    serverDialogOpener: null,
    serverFormOpener: null,
    serverDialogGeneration: 0,
    configurationGameId: null,
    integration: null,
    directorySettings: null,
    configurationServers: [],
    machineIdentities: [],
    configurationAudit: [],
    configurationLoaded: false,
    configurationSubmitting: false,
    configurationGeneration: 0,
    reauthenticationSubmitting: false,
    elevatedAction: null,
    elevatedActionOpener: null,
    wechatSecretSubmitting: false,
    machineFormMode: null,
    editingMachineIdentity: null,
    machineIdentitySubmitting: false,
    machineIdentityOpener: null,
    machineRevokeTarget: null,
    machineRevokeSubmitting: false,
    oneTimeSecret: null,
    expiryTimer: null,
    idleExpiresAt: null,
    authGeneration: 0,
  };

  function currentGame() {
    return (
      state.session?.games.find(
        (game) => game.gameId === state.selectedGameId,
      ) ?? null
    );
  }

  function replaceHash(hash) {
    if (window.location.hash === hash) {
      return;
    }
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  }

  function showView(name, { focus = true } = {}) {
    for (const [viewName, view] of elements.views) {
      view.hidden = viewName !== name;
    }
    if (name === "login") {
      replaceHash("#login");
    } else if (name === "accounts" || name === "no-access") {
      replaceHash("#accounts");
    } else if (name === "games") {
      replaceHash("#games");
    } else if (name === "integration") {
      replaceHash("#integration");
    }
    if (elements.gameField) {
      elements.gameField.hidden =
        name !== "accounts" || (state.session?.games.length ?? 0) === 0;
    }
    if (focus) {
      elements.views.get(name)?.querySelector("h1")?.focus();
    }
  }

  function showLoginError(message, { focusError = false } = {}) {
    elements.loginErrorMessage.textContent = message;
    elements.loginError.hidden = false;
    if (focusError) {
      elements.loginError.focus();
    }
  }

  function hideLoginError() {
    elements.loginError.hidden = true;
    elements.loginErrorMessage.textContent = "";
  }

  function clearExpiryTimer() {
    if (state.expiryTimer !== null) {
      cancelSchedule(state.expiryTimer);
      state.expiryTimer = null;
    }
  }

  function closeOperationDialog() {
    if (elements.dialog.open) {
      elements.dialog.close();
    }
  }

  function closeGameDialog() {
    if (elements.gameDialog.open) {
      elements.gameDialog.close();
    }
  }

  function closeServerDialog() {
    if (elements.serverDialog.open) {
      elements.serverDialog.close();
    }
  }

  function hasConfigurationAccess(session = state.session) {
    return Boolean(
      session
      && (
        session.canManageIntegrations
        || session.canManageMachineIdentities
      ),
    );
  }

  function hasRecentAuthentication() {
    return (
      state.session?.elevatedUntil !== null
      && Date.parse(state.session.elevatedUntil) > now()
    );
  }

  function resetSecretField(input, toggle = null) {
    input.value = "";
    input.type = "password";
    if (toggle) {
      toggle.setAttribute("aria-pressed", "false");
      if (toggle === elements.wechatSecretToggle) {
        toggle.setAttribute("aria-label", "显示 AppSecret");
      }
    }
  }

  function clearWechatSecretInput() {
    resetSecretField(
      elements.wechatSecretInput,
      elements.wechatSecretToggle,
    );
    elements.wechatSecretInput.setCustomValidity("");
  }

  function clearOneTimeSecret() {
    state.oneTimeSecret = null;
    elements.oneTimeSecretValue.value = "";
    elements.oneTimeSecretValue.type = "password";
    elements.oneTimeSecretToggle.setAttribute("aria-pressed", "false");
    elements.oneTimeSecretToggle.textContent = "显示一次";
    elements.oneTimeSecretToggle.disabled = false;
    elements.oneTimeSecretContext.textContent = "";
    elements.oneTimeSecretConfirm.checked = false;
    elements.oneTimeSecretClose.disabled = true;
  }

  function closeReauthenticationDialog({ clearAction = true } = {}) {
    resetSecretField(
      elements.reauthenticatePassword,
      elements.reauthenticatePasswordToggle,
    );
    elements.reauthenticateError.hidden = true;
    elements.reauthenticateErrorMessage.textContent = "";
    if (clearAction) {
      state.elevatedAction = null;
      state.elevatedActionOpener = null;
    }
    if (elements.reauthenticateDialog.open) {
      elements.reauthenticateDialog.close();
    }
  }

  function closeWechatSecretDialog() {
    clearWechatSecretInput();
    elements.wechatSecretError.hidden = true;
    elements.wechatSecretErrorMessage.textContent = "";
    if (elements.wechatSecretDialog.open) {
      elements.wechatSecretDialog.close();
    }
  }

  function closeMachineIdentityDialog() {
    if (elements.machineIdentityDialog.open) {
      elements.machineIdentityDialog.close();
    }
  }

  function closeMachineRevokeDialog() {
    elements.machineRevokeReason.value = "";
    elements.machineRevokeError.hidden = true;
    elements.machineRevokeErrorMessage.textContent = "";
    if (elements.machineRevokeDialog.open) {
      elements.machineRevokeDialog.close();
    }
  }

  function closeOneTimeSecretDialog() {
    if (elements.oneTimeSecretDialog.open) {
      elements.oneTimeSecretDialog.close();
    }
    clearOneTimeSecret();
  }

  function clearSensitiveState() {
    clearWechatSecretInput();
    closeWechatSecretDialog();
    closeReauthenticationDialog();
    closeMachineIdentityDialog();
    closeMachineRevokeDialog();
    closeOneTimeSecretDialog();
  }

  function clearConfigurationState() {
    configurationRequests.invalidate();
    state.configurationGeneration += 1;
    state.configurationGameId = null;
    state.integration = null;
    state.directorySettings = null;
    state.configurationServers = [];
    state.machineIdentities = [];
    state.configurationAudit = [];
    state.configurationLoaded = false;
    state.configurationSubmitting = false;
    elements.integrationGameSelect.replaceChildren();
    elements.integrationContent.hidden = true;
    elements.integrationLoading.hidden = true;
    elements.integrationError.hidden = true;
    elements.integrationErrorMessage.textContent = "";
    elements.integrationForm.reset();
    elements.integrationFormError.hidden = true;
    elements.integrationFormErrorMessage.textContent = "";
    elements.configurationCheckList.replaceChildren();
    elements.machineIdentitiesList.replaceChildren();
    elements.machineIdentitiesEmpty.hidden = true;
    elements.configurationAuditList.replaceChildren();
    elements.configurationAuditEmpty.hidden = true;
    clearSensitiveState();
  }

  function availableConfigurationGames() {
    const projects = state.session?.canManageGames && state.managedGamesLoaded
      ? state.managedGames
      : state.session?.games ?? [];
    const seen = new Set();
    return projects.filter((game) => {
      if (seen.has(game.gameId)) {
        return false;
      }
      seen.add(game.gameId);
      return true;
    });
  }

  function populateConfigurationGames() {
    const games = availableConfigurationGames();
    const previous = state.configurationGameId;
    if (!games.some((game) => game.gameId === previous)) {
      state.configurationGameId = games[0]?.gameId ?? null;
    }
    const options = games.map((game) => {
      const option = document.createElement("option");
      option.value = game.gameId;
      option.textContent = `${game.name} · ${game.gameId}`;
      return option;
    });
    if (options.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "没有可配置游戏";
      options.push(option);
    }
    elements.integrationGameSelect.replaceChildren(...options);
    elements.integrationGameSelect.value =
      state.configurationGameId ?? "";
    elements.integrationGameSelect.disabled = games.length === 0;
  }

  function setConfigurationFormDisabled(disabled) {
    for (const control of elements.integrationForm.elements) {
      control.disabled = disabled;
    }
    elements.integrationRefresh.disabled = disabled;
    elements.integrationGameSelect.disabled =
      disabled || availableConfigurationGames().length === 0;
    if (!disabled) {
      const canManage = Boolean(
        state.session?.canManageIntegrations && state.integration,
      );
      for (const control of elements.integrationForm.elements) {
        control.disabled = !canManage;
      }
      elements.wechatSecretReplace.disabled =
        !canManage || !state.session?.canRotateSecrets;
      elements.directorySave.disabled =
        !canManage || !state.directorySettings;
    }
  }

  function renderConfigurationCompleteness() {
    const integration = state.integration;
    const checks = [
      {
        label: "微信 AppID",
        complete: Boolean(integration?.wechatAppId),
      },
      {
        label: "微信 AppSecret",
        complete: integration?.wechatSecret.configured === true,
      },
      {
        label: "至少一个区服",
        complete: state.configurationServers.length > 0,
      },
      {
        label: "游戏已完成配置",
        complete: integration?.configurationState === "configured",
      },
    ];
    const completeCount = checks.filter((check) => check.complete).length;
    elements.configurationCompletenessScore.textContent =
      `${completeCount} / ${checks.length}`;
    elements.configurationCompletenessSummary.textContent =
      completeCount === checks.length
        ? "必需接入配置已完整。"
        : `还有 ${checks.length - completeCount} 项需要处理。`;
    setBadge(
      elements.configurationStateBadge,
      integration?.configurationState === "configured" ? "配置完成" : "草稿",
      integration?.configurationState === "configured" ? "success" : "warning",
    );
    elements.configurationLoadedRevision.textContent =
      integration?.loadedRevision === null
        ? "运行时尚未加载当前配置。"
        : `运行时已加载第 ${integration?.loadedRevision ?? "—"} 版；`
          + `数据库当前为第 ${integration?.revision ?? "—"} 版。`;
    elements.configurationCheckList.replaceChildren(...checks.map((check) => {
      const item = document.createElement("li");
      item.className = check.complete ? "gmk-check-complete" : "";
      const marker = document.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = check.complete ? "✓" : "○";
      const label = document.createElement("span");
      label.textContent = check.label;
      item.append(marker, label);
      return item;
    }));
  }

  function renderIntegrationSettings() {
    const integration = state.integration;
    const canManage = Boolean(
      state.session?.canManageIntegrations && integration,
    );
    elements.integrationSettingsSection.hidden =
      !state.session?.canManageIntegrations;
    if (!integration) {
      return;
    }
    elements.integrationWechatAppId.value = integration.wechatAppId ?? "";
    elements.integrationWechatEndpoint.value = integration.wechatEndpoint;
    elements.integrationWechatTimeout.value =
      String(integration.wechatTimeoutMs);
    elements.integrationBreakerThreshold.value =
      String(integration.wechatBreakerThreshold);
    elements.integrationBreakerOpen.value =
      String(integration.wechatBreakerOpenMs);
    elements.integrationSessionTtl.value =
      String(integration.sessionTtlSeconds);
    elements.integrationLoginCapacity.value =
      String(integration.loginRateCapacity);
    elements.integrationLoginRefill.value =
      String(integration.loginRateRefillPerSecond);
    elements.integrationAdminCapacity.value =
      String(integration.adminRateCapacity);
    elements.integrationAdminRefill.value =
      String(integration.adminRateRefillPerSecond);
    setBadge(
      elements.wechatSecretStatusBadge,
      integration.wechatSecret.configured ? "已生效" : "未配置",
      integration.wechatSecret.configured ? "success" : "warning",
    );
    elements.directoryIsOps.checked = state.directorySettings?.isOps ?? false;
    elements.directoryRevisionLabel.textContent = state.directorySettings
      ? `当前目录修订第 ${state.directorySettings.revision} 版。`
      : "";
    elements.wechatSecretReplace.hidden =
      !state.session?.canRotateSecrets;
    elements.wechatSecretReplace.disabled =
      !canManage || !state.session?.canRotateSecrets;
    elements.directorySave.disabled =
      !canManage || !state.directorySettings;
    elements.integrationSave.disabled = !canManage;
  }

  function secretStatePresentation(stateValue) {
    if (stateValue === "current") {
      return { text: "当前版本", variant: "success" };
    }
    if (stateValue === "previous") {
      return { text: "过渡版本", variant: "warning" };
    }
    return { text: "已撤销", variant: "danger" };
  }

  function upsertMachineIdentity(identity) {
    const index = state.machineIdentities.findIndex(
      (candidate) => candidate.identityId === identity.identityId,
    );
    state.machineIdentities = index === -1
      ? [...state.machineIdentities, identity]
      : state.machineIdentities.map((candidate, candidateIndex) => (
          candidateIndex === index ? identity : candidate
        ));
    renderMachineIdentities();
  }

  function createMachineIdentityCard(identity) {
    const card = document.createElement("article");
    card.className = "wsk-panel gmk-machine-card";
    card.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "gmk-machine-card-head";
    const titleGroup = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = identity.displayName;
    const identifier = document.createElement("code");
    identifier.className = "gmk-game-id";
    identifier.textContent = identity.identityId;
    titleGroup.append(title, identifier);
    const badges = document.createElement("div");
    badges.className = "gmk-machine-badges";
    const typeBadge = document.createElement("span");
    setBadge(
      typeBadge,
      identity.identityType === "service" ? "Service" : "机器 Admin",
      "accent",
    );
    const statusBadge = document.createElement("span");
    setBadge(
      statusBadge,
      identity.status === "enabled" ? "已启用" : "已停用",
      identity.status === "enabled" ? "success" : "danger",
    );
    badges.append(typeBadge, statusBadge);
    head.append(titleGroup, badges);

    const scopes = document.createElement("p");
    scopes.className = "gmk-machine-scopes";
    scopes.textContent = identity.gameIds.length > 0
      ? `游戏范围：${identity.gameIds.join("、")}`
      : "游戏范围：无";

    const versions = document.createElement("div");
    versions.className = "gmk-secret-version-list";
    for (const secretVersion of identity.secretVersions) {
      const row = document.createElement("div");
      row.className = "gmk-secret-version";
      const summary = document.createElement("div");
      const versionLabel = document.createElement("strong");
      versionLabel.textContent = `Secret v${secretVersion.version}`;
      const stateBadge = document.createElement("span");
      const presentation = secretStatePresentation(secretVersion.state);
      setBadge(stateBadge, presentation.text, presentation.variant);
      summary.append(versionLabel, stateBadge);
      const metadata = document.createElement("p");
      metadata.className = "wsk-help";
      metadata.textContent = secretVersion.expiresAt
        ? `失效时间：${formatDateTime(secretVersion.expiresAt)}`
        : `创建时间：${formatDateTime(secretVersion.createdAt)}`;
      row.append(summary, metadata);
      if (
        state.session?.canRotateSecrets
        && secretVersion.state !== "revoked"
      ) {
        const revoke = document.createElement("button");
        revoke.className = "wsk-button wsk-danger";
        revoke.type = "button";
        revoke.dataset.machineRevoke =
          `${identity.identityId}:${secretVersion.version}`;
        revoke.textContent = "撤销此版本";
        revoke.addEventListener("click", () => {
          requestElevatedAction(
            () => openMachineRevoke(identity, secretVersion, revoke),
            revoke,
          );
        });
        row.append(revoke);
      }
      versions.append(row);
    }
    if (identity.secretVersions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wsk-help";
      empty.textContent = "暂无 Secret 版本。";
      versions.append(empty);
    }

    const actions = document.createElement("div");
    actions.className = "gmk-machine-actions";
    const edit = document.createElement("button");
    edit.className = "wsk-button wsk-secondary";
    edit.type = "button";
    edit.dataset.machineEdit = identity.identityId;
    edit.textContent = "编辑身份与范围";
    edit.addEventListener("click", () => {
      requestElevatedAction(
        () => openMachineIdentityForm("edit", identity, edit),
        edit,
      );
    });
    actions.append(edit);
    if (state.session?.canRotateSecrets) {
      const validityLabel = document.createElement("label");
      validityLabel.className = "wsk-label";
      validityLabel.textContent = "旧版本过渡窗口";
      const validity = document.createElement("select");
      validity.className = "wsk-select";
      validity.setAttribute("aria-label", `${identity.displayName} 旧版本过渡窗口`);
      for (const [seconds, label] of [
        [300, "5 分钟"],
        [1_800, "30 分钟"],
        [3_600, "1 小时"],
        [86_400, "24 小时"],
      ]) {
        const option = document.createElement("option");
        option.value = String(seconds);
        option.textContent = label;
        validity.append(option);
      }
      const rotate = document.createElement("button");
      rotate.className = "wsk-button";
      rotate.type = "button";
      rotate.dataset.machineRotate = identity.identityId;
      rotate.textContent = "轮换 Secret";
      rotate.disabled = identity.status !== "enabled";
      rotate.addEventListener("click", () => {
        requestElevatedAction(
          () => rotateMachineSecret(
            identity,
            Number(validity.value),
            rotate,
          ),
          rotate,
        );
      });
      actions.append(validityLabel, validity, rotate);
    }

    card.append(head, scopes, versions, actions);
    return card;
  }

  function renderMachineIdentities() {
    const allowed = Boolean(state.session?.canManageMachineIdentities);
    elements.machineIdentitiesSection.hidden = !allowed;
    if (!allowed) {
      elements.machineIdentitiesList.replaceChildren();
      elements.machineIdentitiesEmpty.hidden = true;
      return;
    }
    const identities = [...state.machineIdentities].sort((left, right) => (
      left.identityType.localeCompare(right.identityType, "en")
      || left.identityId.localeCompare(right.identityId, "en")
    ));
    elements.machineIdentitiesList.replaceChildren(
      ...identities.map(createMachineIdentityCard),
    );
    elements.machineIdentitiesList.hidden = identities.length === 0;
    elements.machineIdentitiesEmpty.hidden = identities.length > 0;
    elements.machineIdentityCreate.hidden =
      !state.session?.canRotateSecrets;
  }

  function renderConfigurationAudit() {
    elements.configurationAuditSection.hidden = !hasConfigurationAccess();
    const records = state.configurationAudit;
    elements.configurationAuditList.replaceChildren(...records.map((record) => {
      const item = document.createElement("article");
      item.className = "gmk-audit-item";
      const head = document.createElement("div");
      const action = document.createElement("strong");
      action.textContent = record.action;
      const kind = document.createElement("span");
      kind.className = "wsk-badge";
      kind.textContent = {
        game_configuration: "游戏配置",
        machine_identity: "机器身份",
        secret: "Secret",
      }[record.auditType];
      head.append(action, kind);
      const target = document.createElement("p");
      target.textContent = [
        record.gameId ? `游戏 ${record.gameId}` : null,
        record.identityId ? `身份 ${record.identityId}` : null,
        `结果 ${record.result}`,
      ].filter(Boolean).join(" · ");
      const metadata = document.createElement("p");
      metadata.className = "wsk-help";
      const versionText =
        record.oldVersion === null && record.newVersion === null
          ? ""
          : ` · 版本 ${record.oldVersion ?? "—"} → ${record.newVersion ?? "—"}`;
      metadata.textContent =
        `${record.operatorId} · ${formatDateTime(record.createdAt)}`
        + versionText;
      item.append(head, target, metadata);
      return item;
    }));
    elements.configurationAuditList.hidden = records.length === 0;
    elements.configurationAuditEmpty.hidden = records.length > 0;
  }

  function renderConfiguration() {
    elements.integrationLoading.hidden = true;
    elements.integrationError.hidden = true;
    elements.integrationContent.hidden = false;
    renderIntegrationSettings();
    if (state.session?.canManageIntegrations) {
      renderConfigurationCompleteness();
    }
    renderMachineIdentities();
    renderConfigurationAudit();
    setConfigurationFormDisabled(false);
  }

  async function loadConfiguration({ focusError = false } = {}) {
    if (!hasConfigurationAccess()) {
      return;
    }
    const gameId = state.configurationGameId;
    const version = configurationRequests.begin();
    const authGeneration = state.authGeneration;
    const generation = ++state.configurationGeneration;
    elements.integrationContent.hidden = true;
    elements.integrationError.hidden = true;
    elements.integrationLoading.hidden = false;
    elements.integrationRefresh.disabled = true;
    try {
      const [
        integration,
        directorySettings,
        serverResult,
        identities,
        audit,
      ] = await Promise.all([
        state.session.canManageIntegrations && gameId
          ? api.getGameIntegration(gameId)
          : null,
        state.session.canManageIntegrations && gameId
          ? api.getDirectorySettings(gameId)
          : null,
        state.session.canManageIntegrations && gameId
          ? api.listGameServers(gameId)
          : null,
        state.session.canManageMachineIdentities
          ? api.listMachineIdentities()
          : [],
        api.listConfigurationAudit(gameId, 50),
      ]);
      if (
        !configurationRequests.isCurrent(version)
        || generation !== state.configurationGeneration
        || authGeneration !== state.authGeneration
        || !hasConfigurationAccess()
      ) {
        return;
      }
      state.integration = integration;
      state.directorySettings = directorySettings;
      state.configurationServers = serverResult?.servers ?? [];
      state.machineIdentities = identities;
      state.configurationAudit = audit;
      state.configurationLoaded = true;
      touchSessionActivity();
      renderConfiguration();
    } catch (error) {
      if (
        !configurationRequests.isCurrent(version)
        || generation !== state.configurationGeneration
        || authGeneration !== state.authGeneration
      ) {
        return;
      }
      elements.integrationLoading.hidden = true;
      elements.integrationContent.hidden = true;
      if (error instanceof AdminApiError && error.status === 401) {
        clearSensitiveState();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        clearSensitiveState();
        await refreshPermissions();
        return;
      }
      if (error instanceof AdminApiError && error.status === 404) {
        state.managedGamesLoaded = false;
        state.configurationGameId = null;
        populateConfigurationGames();
      }
      elements.integrationErrorMessage.textContent =
        describeApiError(error, "configuration");
      elements.integrationError.hidden = false;
      if (focusError) {
        elements.integrationError.focus();
      }
    } finally {
      if (
        configurationRequests.isCurrent(version)
        && generation === state.configurationGeneration
      ) {
        elements.integrationRefresh.disabled = false;
      }
    }
  }

  async function prepareConfigurationPage() {
    if (!hasConfigurationAccess()) {
      return;
    }
    if (state.session.canManageGames && !state.managedGamesLoaded) {
      const authGeneration = state.authGeneration;
      try {
        state.managedGames = await api.listGames();
        if (
          authGeneration !== state.authGeneration
          || !hasConfigurationAccess()
        ) {
          return;
        }
        state.managedGamesLoaded = true;
      } catch (error) {
        if (error instanceof AdminApiError && error.status === 401) {
          becomeAnonymous("管理员会话已过期，请重新登录。");
          return;
        }
        if (error instanceof AdminApiError && error.status === 403) {
          await refreshPermissions();
          return;
        }
        elements.integrationLoading.hidden = true;
        elements.integrationErrorMessage.textContent =
          describeApiError(error, "configuration");
        elements.integrationError.hidden = false;
        return;
      }
    }
    populateConfigurationGames();
    await loadConfiguration();
  }

  function hideAccountPanels() {
    elements.accountEmpty.hidden = true;
    elements.accountLoading.hidden = true;
    elements.accountNotFound.hidden = true;
    elements.accountError.hidden = true;
    elements.accountCard.hidden = true;
  }

  function clearAccount({ announcement = "" } = {}) {
    state.accountRequestVersion += 1;
    state.account = null;
    hideAccountPanels();
    elements.accountEmpty.hidden = false;
    elements.accountNotFoundMessage.textContent = "";
    elements.accountErrorMessage.textContent = "";
    elements.accountCardUserId.textContent = "";
    elements.accountStatusBadge.textContent = "";
    elements.accountGame.textContent = "";
    elements.accountLastLogin.textContent = "";
    elements.accountSessionCount.textContent = "";
    elements.accountLiveStatus.textContent = announcement;
    elements.userId.value = "";
    elements.userId.setAttribute("aria-invalid", "false");
    elements.operationReason.value = "";
    elements.operationTarget.textContent = "";
    elements.operationDescription.textContent = "";
    elements.operationErrorMessage.textContent = "";
    closeOperationDialog();
    state.pendingOperation = null;
    state.retryOperation = null;
  }

  function clearAuthenticatedState() {
    sessionRequests.invalidate();
    gameRequests.invalidate();
    serverRequests.invalidate();
    configurationRequests.invalidate();
    clearExpiryTimer();
    state.idleExpiresAt = null;
    state.session = null;
    state.authGeneration += 1;
    state.selectedGameId = null;
    state.accountRequestVersion += 1;
    state.account = null;
    state.pendingOperation = null;
    state.retryOperation = null;
    state.operationSubmitting = false;
    state.managedGames = [];
    state.managedGamesLoaded = false;
    state.gameFormMode = null;
    state.editingGame = null;
    state.gameSubmitting = false;
    state.gameOpener = null;
    state.serverGame = null;
    state.directoryRevision = null;
    state.managedServers = [];
    state.managedServersLoaded = false;
    state.serverFormMode = null;
    state.editingServer = null;
    state.serverSubmitting = false;
    state.serverDialogOpener = null;
    state.serverFormOpener = null;
    state.serverDialogGeneration += 1;
    clearConfigurationState();
    state.logoutSubmitting = false;
    elements.sessionTools.hidden = true;
    elements.gameSelect.replaceChildren();
    elements.operatorName.textContent = "";
    elements.selectedGameLabel.textContent = "";
    elements.gameStatusBadge.textContent = "";
    elements.accountsGamesLink.hidden = true;
    elements.accountsIntegrationLink.hidden = true;
    elements.gamesAccountsLink.hidden = false;
    elements.gamesIntegrationLink.hidden = true;
    elements.integrationAccountsLink.hidden = true;
    elements.integrationGamesLink.hidden = true;
    elements.gamesList.replaceChildren();
    elements.gamesList.hidden = true;
    elements.gamesLoading.hidden = true;
    elements.gamesError.hidden = true;
    elements.gamesEmpty.hidden = true;
    elements.gamesLiveStatus.textContent = "";
    elements.serversList.replaceChildren();
    elements.serversList.hidden = true;
    elements.serversLoading.hidden = true;
    elements.serversError.hidden = true;
    elements.serversEmpty.hidden = true;
    elements.serversLiveStatus.textContent = "";
    elements.serverSummary.textContent = "";
    elements.serverGameLabel.textContent = "";
    elements.serverEditor.hidden = true;
    elements.serverForm.reset();
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    elements.toastRegion.replaceChildren();
    closeOperationDialog();
    closeGameDialog();
    closeServerDialog();
    clearAccount();
  }

  function becomeAnonymous(message = "") {
    clearAuthenticatedState();
    elements.password.value = "";
    resetPasswordControl(elements.password, elements.passwordToggle);
    if (message) {
      showLoginError(message);
    } else {
      hideLoginError();
    }
    showView("login");
    elements.operatorId.focus();
  }

  function scheduleExpiry(expiresAt) {
    clearExpiryTimer();
    const expiresAtMs = Date.parse(expiresAt);
    const effectiveExpiry = Math.min(
      expiresAtMs,
      state.idleExpiresAt ?? expiresAtMs,
    );
    const remaining = effectiveExpiry - now();
    if (remaining <= 0) {
      becomeAnonymous("管理员会话已过期，请重新登录。");
      return;
    }
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    state.expiryTimer = schedule(() => {
      if (remaining > MAX_TIMER_DELAY_MS) {
        scheduleExpiry(expiresAt);
      } else {
        becomeAnonymous("管理员会话已过期，请重新登录。");
      }
    }, delay);
  }

  function touchSessionActivity() {
    if (!state.session) {
      return;
    }
    state.idleExpiresAt = now() + ADMIN_SESSION_IDLE_TTL_MS;
    scheduleExpiry(state.session.expiresAt);
  }

  function canQueryGame(game) {
    return game?.status === "enabled";
  }

  function populateGames() {
    const games = state.session?.games ?? [];
    const options = [];
    if (games.length !== 1) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = games.length === 0 ? "没有可用游戏" : "请选择游戏";
      options.push(placeholder);
    }
    for (const game of games) {
      const option = document.createElement("option");
      option.value = game.gameId;
      option.textContent = `${game.name} · ${game.gameId}`;
      options.push(option);
    }
    elements.gameSelect.replaceChildren(...options);
    elements.gameSelect.value = state.selectedGameId ?? "";
    elements.gameSelect.disabled = games.length === 0;
    if (elements.gameField) {
      elements.gameField.hidden = games.length === 0;
    }
  }

  function renderGame() {
    const game = currentGame();
    const status = gameStatusPresentation(game);
    setBadge(elements.gameStatusBadge, status.text, status.variant);
    elements.selectedGameLabel.textContent = game
      ? `${game.name} · ${game.gameId}`
      : "尚未选择游戏";

    const canQuery = canQueryGame(game);
    elements.userId.disabled = !canQuery;
    elements.searchButton.disabled = !canQuery;
    if (!game) {
      elements.accountEmptyTitle.textContent = "等待选择游戏";
      elements.accountEmptyMessage.textContent =
        "选择游戏后即可输入用户 ID 查询账号。";
      elements.operationHelp.textContent = "请先选择要管理的游戏。";
    } else if (game.status === "maintenance") {
      elements.accountEmptyTitle.textContent = "游戏维护中";
      elements.accountEmptyMessage.textContent =
        "当前游戏暂停管理员账号查询和操作，请在维护结束后重试。";
      elements.operationHelp.textContent = "游戏维护期间不能执行账号操作。";
    } else if (game.status === "disabled") {
      elements.accountEmptyTitle.textContent = "游戏已停用";
      elements.accountEmptyMessage.textContent =
        "当前游戏已停用，不能查询或修改账号。";
      elements.operationHelp.textContent = "已停用游戏不能执行账号操作。";
    } else {
      elements.accountEmptyTitle.textContent = "等待查询";
      elements.accountEmptyMessage.textContent =
        "输入完整用户 ID，账号信息会显示在这里。";
    }
  }

  function hideManagedGamePanels() {
    elements.gamesLoading.hidden = true;
    elements.gamesError.hidden = true;
    elements.gamesEmpty.hidden = true;
    elements.gamesList.hidden = true;
  }

  function appendFact(list, label, value) {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    item.append(term, description);
    list.append(item);
  }

  function createGameCard(game) {
    const card = document.createElement("article");
    card.className = "wsk-panel gmk-game-card";
    card.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "gmk-game-card-head";
    const identity = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = game.name;
    const gameId = document.createElement("code");
    gameId.className = "gmk-game-id";
    gameId.textContent = game.gameId;
    identity.append(title, gameId);

    const badges = document.createElement("div");
    badges.className = "gmk-game-badges";
    const statusBadge = document.createElement("span");
    const status = gameStatusPresentation(game);
    setBadge(statusBadge, status.text.replace(/^游戏/u, ""), status.variant);
    const configurationBadge = document.createElement("span");
    setBadge(
      configurationBadge,
      game.configurationState === "configured" ? "配置完成" : "草稿",
      game.configurationState === "configured" ? "success" : "warning",
    );
    const clientBadge = document.createElement("span");
    setBadge(
      clientBadge,
      game.clientVisible ? "客户端可见" : "不下发",
      game.clientVisible ? "accent" : null,
    );
    badges.append(statusBadge, configurationBadge, clientBadge);
    head.append(identity, badges);

    const description = document.createElement("p");
    description.className = "gmk-game-description";
    description.textContent = game.description || "暂无游戏说明。";

    const facts = document.createElement("dl");
    facts.className = "gmk-game-facts";
    appendFact(
      facts,
      "客户端展示顺序",
      game.clientVisible ? String(game.sortOrder) : `未下发 · ${game.sortOrder}`,
    );
    appendFact(facts, "最近更新", formatDateTime(game.updatedAt));
    appendFact(facts, "修订版本", `第 ${game.revision} 版`);

    const actions = document.createElement("div");
    actions.className = "gmk-game-card-actions";
    const manageServers = document.createElement("button");
    manageServers.className = "wsk-button";
    manageServers.type = "button";
    manageServers.dataset.gameServers = game.gameId;
    manageServers.setAttribute("aria-label", `管理游戏 ${game.name} 的区服`);
    const serverIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    serverIcon.classList.add("wsk-icon");
    serverIcon.setAttribute("aria-hidden", "true");
    const serverUse = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "use",
    );
    serverUse.setAttribute("href", "#sessions");
    serverIcon.append(serverUse);
    manageServers.append(serverIcon, "管理区服");
    manageServers.addEventListener("click", () => {
      openServerDialog(game, manageServers);
    });

    const edit = document.createElement("button");
    edit.className = "wsk-button wsk-secondary";
    edit.type = "button";
    edit.dataset.gameEdit = game.gameId;
    edit.setAttribute("aria-label", `编辑游戏 ${game.name}`);
    const editIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    editIcon.classList.add("wsk-icon");
    editIcon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#edit");
    editIcon.append(use);
    edit.append(editIcon, "编辑");
    edit.addEventListener("click", () => openGameForm("edit", game, edit));
    actions.append(manageServers, edit);

    card.append(head, description, facts, actions);
    return card;
  }

  function renderManagedGames() {
    hideManagedGamePanels();
    const games = [...state.managedGames].sort((left, right) => (
      left.sortOrder - right.sortOrder
      || left.gameId.localeCompare(right.gameId, "en")
    ));
    if (games.length === 0) {
      elements.gamesEmpty.hidden = false;
      elements.gamesLiveStatus.textContent = "当前没有游戏项目。";
      return;
    }
    elements.gamesList.replaceChildren(...games.map(createGameCard));
    elements.gamesList.hidden = false;
    elements.gamesLiveStatus.textContent = `已加载 ${games.length} 个游戏项目。`;
  }

  async function loadManagedGames({ force = false, focusError = false } = {}) {
    if (!state.session?.canManageGames) {
      return;
    }
    if (state.managedGamesLoaded && !force) {
      renderManagedGames();
      return;
    }
    const version = gameRequests.begin();
    const authGeneration = state.authGeneration;
    hideManagedGamePanels();
    elements.gamesLoading.hidden = false;
    elements.gamesErrorMessage.textContent = "";
    try {
      const games = await api.listGames();
      if (
        !gameRequests.isCurrent(version)
        || authGeneration !== state.authGeneration
        || !state.session?.canManageGames
      ) {
        return;
      }
      state.managedGames = games;
      state.managedGamesLoaded = true;
      touchSessionActivity();
      renderManagedGames();
    } catch (error) {
      if (
        !gameRequests.isCurrent(version)
        || authGeneration !== state.authGeneration
      ) {
        return;
      }
      hideManagedGamePanels();
      if (error instanceof AdminApiError && error.status === 401) {
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        await refreshPermissions();
        return;
      }
      elements.gamesErrorMessage.textContent = describeApiError(error, "games");
      elements.gamesError.hidden = false;
      elements.gamesLiveStatus.textContent = "游戏项目加载失败。";
      if (focusError) {
        elements.gamesError.focus();
      }
    }
  }

  function hideManagedServerPanels() {
    elements.serversLoading.hidden = true;
    elements.serversError.hidden = true;
    elements.serversEmpty.hidden = true;
    elements.serversList.hidden = true;
  }

  function createServerCard(server) {
    const card = document.createElement("article");
    card.className = "gmk-server-card";
    card.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "gmk-server-card-head";
    const identity = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = server.name;
    const serverId = document.createElement("code");
    serverId.className = "gmk-game-id";
    serverId.textContent = `区服 ID ${server.serverId}`;
    identity.append(title, serverId);

    const badges = document.createElement("div");
    badges.className = "gmk-server-card-badges";
    const openBadge = document.createElement("span");
    setBadge(
      openBadge,
      server.isOpen ? "已开放" : "未开放",
      server.isOpen ? "success" : "warning",
    );
    const statusBadge = document.createElement("span");
    const status = serverStatusPresentation(server.status);
    setBadge(statusBadge, status.text, status.variant);
    const tagBadge = document.createElement("span");
    const tag = serverTagPresentation(server.tag);
    setBadge(tagBadge, tag.text, tag.variant);
    badges.append(openBadge, statusBadge, tagBadge);
    head.append(identity, badges);

    const facts = document.createElement("dl");
    facts.className = "gmk-server-facts";
    appendFact(facts, "开放时间", formatUnixTime(server.openTime));
    appendFact(facts, "展示顺序", String(server.sortOrder));
    appendFact(facts, "最近更新", formatDateTime(server.updatedAt));
    appendFact(facts, "修订版本", `第 ${server.revision} 版`);

    const endpoints = document.createElement("div");
    endpoints.className = "gmk-server-endpoints";
    for (const [label, value] of [
      ["HTTP", server.gameHttpUrl],
      ["WebSocket", server.gameWsUrl],
    ]) {
      const row = document.createElement("div");
      row.className = "gmk-server-endpoint";
      const term = document.createElement("span");
      term.textContent = label;
      const endpoint = document.createElement("code");
      endpoint.textContent = value;
      row.append(term, endpoint);
      endpoints.append(row);
    }

    const actions = document.createElement("div");
    actions.className = "gmk-server-card-actions";
    const edit = document.createElement("button");
    edit.className = "wsk-button wsk-secondary";
    edit.type = "button";
    edit.dataset.serverEdit = String(server.serverId);
    edit.setAttribute("aria-label", `编辑区服 ${server.name}`);
    const editIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    editIcon.classList.add("wsk-icon");
    editIcon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#edit");
    editIcon.append(use);
    edit.append(editIcon, "编辑区服");
    edit.addEventListener("click", () => openServerForm("edit", server, edit));
    actions.append(edit);

    card.append(head, facts, endpoints, actions);
    return card;
  }

  function renderManagedServers() {
    hideManagedServerPanels();
    const servers = [...state.managedServers].sort((left, right) => (
      left.sortOrder - right.sortOrder
      || left.serverId - right.serverId
    ));
    const openCount = servers.filter((server) => server.isOpen).length;
    elements.serverSummary.textContent =
      `${servers.length} 个区服，${openCount} 个开放`;
    elements.serverCreateButton.disabled = false;
    if (servers.length === 0) {
      elements.serversEmpty.hidden = false;
      elements.serversLiveStatus.textContent = "当前游戏还没有区服。";
      return;
    }
    elements.serversList.replaceChildren(...servers.map(createServerCard));
    elements.serversList.hidden = false;
    elements.serversLiveStatus.textContent =
      `已加载 ${servers.length} 个区服，其中 ${openCount} 个开放。`;
  }

  async function loadManagedServers({ focusError = false } = {}) {
    const game = state.serverGame;
    if (
      !elements.serverDialog.open
      || !state.session?.canManageGames
      || !game
    ) {
      return;
    }
    const requestVersion = serverRequests.begin();
    const dialogGeneration = state.serverDialogGeneration;
    const authGeneration = state.authGeneration;
    const gameId = game.gameId;
    state.managedServersLoaded = false;
    elements.serverCreateButton.disabled = true;
    hideManagedServerPanels();
    elements.serversLoading.hidden = false;
    elements.serverSummary.textContent = "正在读取区服…";
    elements.serversErrorMessage.textContent = "";
    try {
      const result = await api.listGameServers(gameId);
      if (
        !serverRequests.isCurrent(requestVersion)
        || dialogGeneration !== state.serverDialogGeneration
        || authGeneration !== state.authGeneration
        || !elements.serverDialog.open
        || state.serverGame?.gameId !== gameId
      ) {
        return;
      }
      state.directoryRevision = result.directoryRevision;
      state.managedServers = result.servers;
      state.managedServersLoaded = true;
      touchSessionActivity();
      renderManagedServers();
    } catch (error) {
      if (
        !serverRequests.isCurrent(requestVersion)
        || dialogGeneration !== state.serverDialogGeneration
        || authGeneration !== state.authGeneration
        || !elements.serverDialog.open
      ) {
        return;
      }
      hideManagedServerPanels();
      elements.serverCreateButton.disabled = true;
      if (error instanceof AdminApiError && error.status === 401) {
        closeServerDialog();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        const message = describeApiError(error, "servers");
        closeServerDialog();
        await refreshPermissions();
        toast(message, "danger");
        return;
      }
      elements.serversErrorMessage.textContent =
        describeApiError(error, "server-list");
      elements.serversError.hidden = false;
      elements.serverSummary.textContent = "区服读取失败";
      elements.serversLiveStatus.textContent = "区服加载失败。";
      if (focusError) {
        elements.serversError.focus();
      }
    }
  }

  function openServerDialog(game, opener) {
    if (!state.session?.canManageGames || !game || elements.serverDialog.open) {
      return;
    }
    serverRequests.invalidate();
    state.serverDialogGeneration += 1;
    state.serverGame = game;
    state.directoryRevision = null;
    state.managedServers = [];
    state.managedServersLoaded = false;
    state.serverFormMode = null;
    state.editingServer = null;
    state.serverSubmitting = false;
    state.serverDialogOpener = opener ?? document.activeElement;
    state.serverFormOpener = null;
    elements.serverGameLabel.textContent = `${game.name}（${game.gameId}）`;
    elements.serverDialogDescription.textContent =
      `查看和维护 ${game.gameId} 向客户端提供的区服。`;
    elements.serverSummary.textContent = "正在读取区服…";
    elements.serverCreateButton.disabled = true;
    elements.serverDialogClose.disabled = false;
    elements.serverEditorClose.disabled = false;
    elements.serverCancel.disabled = false;
    elements.serversList.replaceChildren();
    elements.serverEditor.hidden = true;
    elements.serverForm.reset();
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    hideManagedServerPanels();
    elements.serversLoading.hidden = false;
    elements.serverDialog.showModal();
    window.queueMicrotask(() => elements.serverDialogClose.focus());
    void loadManagedServers();
  }

  function resetServerFormValidation() {
    for (const input of [
      elements.serverId,
      elements.serverName,
      elements.serverTag,
      elements.serverStatus,
      elements.serverOpenTime,
      elements.serverHttpUrl,
      elements.serverWsUrl,
      elements.serverSortOrder,
    ]) {
      input.setCustomValidity("");
    }
  }

  function updateServerFormPolicy() {
    if (!elements.serverIsOpen.checked) {
      elements.serverIsOpenHelp.textContent =
        "未开放不下发且不可登录。";
    } else if (elements.serverStatus.value === "maintenance") {
      elements.serverIsOpenHelp.textContent =
        "维护中的开放区服会下发给客户端，但玩家不可登录。";
    } else {
      elements.serverIsOpenHelp.textContent =
        "开放区服会下发给客户端，并按负载状态决定是否可登录。";
    }
    elements.serverStatusHelp.textContent =
      elements.serverStatus.value === "maintenance"
        ? "维护中的区服可下发，但玩家不可登录。"
        : "流畅和繁忙状态不额外阻止已开放区服登录。";
  }

  function setServerFormBusy(busy) {
    state.serverSubmitting = busy;
    for (const input of [
      elements.serverId,
      elements.serverName,
      elements.serverTag,
      elements.serverStatus,
      elements.serverOpenTime,
      elements.serverHttpUrl,
      elements.serverWsUrl,
      elements.serverIsOpen,
      elements.serverSortOrder,
    ]) {
      input.disabled = busy;
    }
    elements.serverDialogClose.disabled = busy;
    elements.serverEditorClose.disabled = busy;
    elements.serverCancel.disabled = busy;
    elements.serverCreateButton.disabled =
      busy || !state.managedServersLoaded;
    elements.serversEmptyCreate.disabled = busy;
    for (const button of elements.serversList.querySelectorAll(
      "[data-server-edit]",
    )) {
      button.disabled = busy;
    }
    setButtonBusy(elements.serverSubmit, busy, {
      idleLabel:
        state.serverFormMode === "create" ? "新增区服" : "保存修改",
      busyLabel: "正在保存…",
    });
    elements.serverSubmit.disabled = busy || !state.managedServersLoaded;
    if (!busy) {
      elements.serverId.disabled = false;
      elements.serverId.readOnly = state.serverFormMode === "edit";
      elements.serverId.setAttribute(
        "aria-readonly",
        String(state.serverFormMode === "edit"),
      );
    }
  }

  function openServerForm(mode, server = null, opener = null) {
    if (
      !elements.serverDialog.open
      || !state.session?.canManageGames
      || !state.serverGame
      || !state.managedServersLoaded
      || (mode !== "create" && mode !== "edit")
      || (mode === "edit" && !server)
      || state.serverSubmitting
    ) {
      return;
    }
    state.serverFormMode = mode;
    state.editingServer = server;
    state.serverFormOpener = opener ?? document.activeElement;
    elements.serverForm.reset();
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    resetServerFormValidation();

    if (mode === "create") {
      elements.serverEditorKind.textContent = "CREATE SERVER";
      elements.serverEditorTitle.textContent = "新增区服";
      elements.serverId.value = "";
      elements.serverName.value = "";
      elements.serverTag.value = "normal";
      elements.serverStatus.value = "smooth";
      elements.serverOpenTime.value =
        unixSecondsToDateTimeLocal(Math.max(0, Math.floor(now() / 1_000)));
      elements.serverHttpUrl.value = "";
      elements.serverWsUrl.value = "";
      elements.serverIsOpen.checked = false;
      elements.serverSortOrder.value = "0";
    } else {
      elements.serverEditorKind.textContent = "EDIT SERVER";
      elements.serverEditorTitle.textContent = `编辑区服 ${server.serverId}`;
      elements.serverId.value = String(server.serverId);
      elements.serverName.value = server.name;
      elements.serverTag.value = server.tag;
      elements.serverStatus.value = server.status;
      const localOpenTime = unixSecondsToDateTimeLocal(server.openTime);
      elements.serverOpenTime.value = localOpenTime;
      if (localOpenTime.length === 0) {
        elements.serverFormErrorMessage.textContent =
          `现有开放时间 ${server.openTime}（Unix 秒）超出浏览器可编辑范围，`
          + "请填写新的有效时间后保存。";
        elements.serverFormError.hidden = false;
      }
      elements.serverHttpUrl.value = server.gameHttpUrl;
      elements.serverWsUrl.value = server.gameWsUrl;
      elements.serverIsOpen.checked = server.isOpen;
      elements.serverSortOrder.value = String(server.sortOrder);
    }
    updateServerFormPolicy();
    setServerFormBusy(false);
    elements.serverEditor.hidden = false;
    elements.serverEditor.scrollIntoView?.({ block: "nearest" });
    window.queueMicrotask(() => (
      mode === "create" ? elements.serverId : elements.serverName
    ).focus());
  }

  function hideServerEditor({ restoreFocus = true } = {}) {
    if (state.serverSubmitting) {
      return;
    }
    const needsReload = !state.managedServersLoaded;
    const editedServerId = state.editingServer?.serverId ?? null;
    const opener = state.serverFormOpener;
    state.serverFormMode = null;
    state.editingServer = null;
    state.serverFormOpener = null;
    elements.serverEditor.hidden = true;
    elements.serverForm.reset();
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    resetServerFormValidation();
    if (!restoreFocus || !elements.serverDialog.open) {
      return;
    }
    if (needsReload) {
      void loadManagedServers({ focusError: true }).then(() => {
        if (!state.managedServersLoaded || !elements.serverDialog.open) {
          return;
        }
        const replacement = editedServerId === null
          ? null
          : [...elements.serversList.querySelectorAll(
              "[data-server-edit]",
            )].find(
              (button) => (
                button.dataset.serverEdit === String(editedServerId)
              ),
            );
        window.queueMicrotask(() => (replacement ?? opener)?.focus());
      });
      return;
    }
    const replacement = editedServerId === null
      ? null
      : [...elements.serversList.querySelectorAll("[data-server-edit]")].find(
          (button) => button.dataset.serverEdit === String(editedServerId),
        );
    window.queueMicrotask(() => (replacement ?? opener)?.focus());
  }

  function upsertManagedServer(server) {
    const index = state.managedServers.findIndex(
      (candidate) => candidate.serverId === server.serverId,
    );
    state.managedServers = index === -1
      ? [...state.managedServers, server]
      : state.managedServers.map((candidate, candidateIndex) => (
          candidateIndex === index ? server : candidate
        ));
    state.managedServersLoaded = true;
    renderManagedServers();
  }

  function validateServerEndpoint(input, label, protocols) {
    const value = input.value.trim();
    input.value = value;
    try {
      requiredEndpoint(value, label, protocols);
      input.setCustomValidity("");
      return value;
    } catch {
      input.setCustomValidity(
        label === "HTTP URL"
          ? "请输入不含账号、密码或片段的 http:// 或 https:// 地址。"
          : "请输入不含账号、密码或片段的 ws:// 或 wss:// 地址。",
      );
      return value;
    }
  }

  async function submitServerForm(event) {
    event.preventDefault();
    const game = state.serverGame;
    if (
      state.serverSubmitting
      || !state.session?.canManageGames
      || !game
      || !state.serverFormMode
    ) {
      return;
    }

    const creating = state.serverFormMode === "create";
    const editingServer = state.editingServer;
    const serverId = elements.serverId.valueAsNumber;
    const name = elements.serverName.value.trim();
    const tag = elements.serverTag.value;
    const status = elements.serverStatus.value;
    const openTime = dateTimeLocalToUnixSeconds(
      elements.serverOpenTime.value,
    );
    const sortOrder = elements.serverSortOrder.valueAsNumber;
    const gameHttpUrl = validateServerEndpoint(
      elements.serverHttpUrl,
      "HTTP URL",
      new Set(["http:", "https:"]),
    );
    const gameWsUrl = validateServerEndpoint(
      elements.serverWsUrl,
      "WebSocket URL",
      new Set(["ws:", "wss:"]),
    );
    elements.serverName.value = name;
    elements.serverId.setCustomValidity(
      Number.isSafeInteger(serverId)
      && serverId >= 0
      && serverId <= 65_535
        ? ""
        : "区服 ID 必须是 0–65535 的整数。",
    );
    elements.serverName.setCustomValidity(
      [...name].length >= 1 && [...name].length <= 64
        ? ""
        : "区服名称必须为 1–64 个字符。",
    );
    elements.serverTag.setCustomValidity(
      SERVER_TAGS.has(tag) ? "" : "区服标签无效。",
    );
    elements.serverStatus.setCustomValidity(
      SERVER_STATUSES.has(status) ? "" : "负载状态无效。",
    );
    elements.serverOpenTime.setCustomValidity(
      openTime === null ? "请输入有效且不早于 1970 年的开放时间。" : "",
    );
    elements.serverSortOrder.setCustomValidity(
      Number.isSafeInteger(sortOrder)
      && sortOrder >= 0
      && sortOrder <= 65_535
        ? ""
        : "展示顺序必须是 0–65535 的整数。",
    );
    if (!elements.serverForm.reportValidity() || openTime === null) {
      return;
    }

    const input = {
      directoryRevision: state.directoryRevision,
      ...(creating ? { serverId } : {}),
      name,
      tag,
      status,
      openTime,
      gameHttpUrl,
      gameWsUrl,
      isOpen: elements.serverIsOpen.checked,
      sortOrder,
      ...(creating ? {} : { revision: editingServer?.revision }),
    };
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    setServerFormBusy(true);
    const dialogGeneration = state.serverDialogGeneration;
    const authGeneration = state.authGeneration;
    try {
      const result = creating
        ? await api.createGameServer(game.gameId, input)
        : await api.updateGameServer(game.gameId, serverId, input);
      if (
        dialogGeneration !== state.serverDialogGeneration
        || authGeneration !== state.authGeneration
        || !elements.serverDialog.open
        || state.serverGame?.gameId !== game.gameId
      ) {
        return;
      }
      touchSessionActivity();
      state.directoryRevision = result.directoryRevision;
      const server = result.server;
      upsertManagedServer(server);
      setServerFormBusy(false);
      hideServerEditor();
      toast(
        creating
          ? `区服 ${server.serverId} 已新增。`
          : `区服 ${server.serverId} 已更新。`,
      );
    } catch (error) {
      if (
        dialogGeneration !== state.serverDialogGeneration
        || authGeneration !== state.authGeneration
        || !elements.serverDialog.open
      ) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        closeServerDialog();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        const message = describeApiError(error, "server-update");
        closeServerDialog();
        await refreshPermissions();
        toast(message, "danger");
        return;
      }
      if (
        !creating
        && error instanceof AdminApiError
        && error.status === 409
      ) {
        state.managedServersLoaded = false;
      }
      elements.serverFormErrorMessage.textContent = describeApiError(
        error,
        creating ? "server-create" : "server-update",
      );
      elements.serverFormError.hidden = false;
      elements.serverFormError.focus();
    } finally {
      if (
        elements.serverDialog.open
        && !elements.serverEditor.hidden
        && dialogGeneration === state.serverDialogGeneration
      ) {
        setServerFormBusy(false);
      } else {
        state.serverSubmitting = false;
      }
    }
  }

  function requestElevatedAction(action, opener = null) {
    if (
      typeof action !== "function"
      || !hasConfigurationAccess()
    ) {
      return;
    }
    if (hasRecentAuthentication()) {
      void action();
      return;
    }
    state.elevatedAction = action;
    state.elevatedActionOpener = opener ?? document.activeElement;
    resetSecretField(
      elements.reauthenticatePassword,
      elements.reauthenticatePasswordToggle,
    );
    elements.reauthenticateError.hidden = true;
    elements.reauthenticateErrorMessage.textContent = "";
    elements.reauthenticateDialog.showModal();
    window.queueMicrotask(() => elements.reauthenticatePassword.focus());
  }

  function setReauthenticationBusy(busy) {
    state.reauthenticationSubmitting = busy;
    elements.reauthenticatePassword.disabled = busy;
    elements.reauthenticatePasswordToggle.disabled = busy;
    elements.reauthenticateClose.disabled = busy;
    elements.reauthenticateCancel.disabled = busy;
    setButtonBusy(elements.reauthenticateSubmit, busy, {
      idleLabel: "重新认证",
      busyLabel: "正在验证…",
    });
  }

  async function submitReauthentication(event) {
    event.preventDefault();
    if (state.reauthenticationSubmitting || !state.session) {
      return;
    }
    elements.reauthenticatePassword.setCustomValidity(
      isValidAdminPasswordInput(elements.reauthenticatePassword.value)
        ? ""
        : "密码必须为 12–256 个 Unicode 字符，且不超过 1024 字节。",
    );
    if (!elements.reauthenticateForm.reportValidity()) {
      return;
    }
    elements.reauthenticatePassword.setCustomValidity("");
    const action = state.elevatedAction;
    const password = elements.reauthenticatePassword.value;
    const authGeneration = state.authGeneration;
    elements.reauthenticateError.hidden = true;
    setReauthenticationBusy(true);
    try {
      await api.reauthenticate(password);
      const session = await api.session();
      if (
        authGeneration !== state.authGeneration
        || !state.session
      ) {
        return;
      }
      closeReauthenticationDialog({ clearAction: false });
      state.elevatedAction = null;
      state.elevatedActionOpener = null;
      if (!applySession(session, { focus: false })) {
        return;
      }
      if (!hasRecentAuthentication()) {
        throw new AdminApiError("重新认证状态未生效", {
          code: "ELEVATION_NOT_ACTIVE",
        });
      }
      if (typeof action === "function") {
        await action();
      }
    } catch (error) {
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        clearSensitiveState();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        clearSensitiveState();
        await refreshPermissions();
        return;
      }
      elements.reauthenticateErrorMessage.textContent =
        describeApiError(error, "reauthentication");
      elements.reauthenticateError.hidden = false;
      elements.reauthenticateError.focus();
    } finally {
      resetSecretField(
        elements.reauthenticatePassword,
        elements.reauthenticatePasswordToggle,
      );
      if (elements.reauthenticateDialog.open) {
        setReauthenticationBusy(false);
      } else {
        state.reauthenticationSubmitting = false;
      }
    }
  }

  function integrationNumber(element, { integer = false } = {}) {
    const value = element.valueAsNumber;
    return integer ? Math.trunc(value) : value;
  }

  function integrationInput() {
    const appId = elements.integrationWechatAppId.value.trim();
    const integration = state.integration;
    return {
      wechatAppId: appId.length === 0 ? null : appId,
      wechatEndpoint: elements.integrationWechatEndpoint.value.trim(),
      wechatTimeoutMs: integrationNumber(
        elements.integrationWechatTimeout,
        { integer: true },
      ),
      wechatBreakerThreshold: integrationNumber(
        elements.integrationBreakerThreshold,
        { integer: true },
      ),
      wechatBreakerOpenMs: integrationNumber(
        elements.integrationBreakerOpen,
        { integer: true },
      ),
      sessionTtlSeconds: integrationNumber(
        elements.integrationSessionTtl,
        { integer: true },
      ),
      loginRateCapacity: integrationNumber(
        elements.integrationLoginCapacity,
      ),
      loginRateRefillPerSecond: integrationNumber(
        elements.integrationLoginRefill,
      ),
      adminRateCapacity: integrationNumber(
        elements.integrationAdminCapacity,
      ),
      adminRateRefillPerSecond: integrationNumber(
        elements.integrationAdminRefill,
      ),
      revision: integration.revision,
    };
  }

  async function handleConfigurationWriteError(
    error,
    context,
    { close = null, unknownStatusFirst = false } = {},
  ) {
    if (error instanceof AdminApiError && error.status === 401) {
      clearSensitiveState();
      becomeAnonymous("管理员会话已过期，请重新登录。");
      return true;
    }
    if (error instanceof AdminApiError && error.status === 403) {
      clearSensitiveState();
      close?.();
      await refreshPermissions();
      return true;
    }
    if (
      error instanceof AdminApiError
      && (error.status === 404 || error.status === 409)
    ) {
      clearSensitiveState();
      close?.();
      await loadConfiguration();
      toast(describeApiError(error, context), "warning");
      return true;
    }
    if (
      !unknownStatusFirst
      && error instanceof AdminApiError
      && (error.status === 0 || error.status >= 500)
    ) {
      clearWechatSecretInput();
      await loadConfiguration();
      toast(
        "结果暂时未知，已先刷新服务器状态；请核对后再决定是否重试。",
        "warning",
      );
      return true;
    }
    return false;
  }

  async function submitIntegration(event) {
    event.preventDefault();
    if (
      state.configurationSubmitting
      || !state.session?.canManageIntegrations
      || !state.integration
      || !state.configurationGameId
    ) {
      return;
    }
    try {
      requiredWechatEndpoint(
        elements.integrationWechatEndpoint.value.trim(),
        "微信接口地址",
      );
      elements.integrationWechatEndpoint.setCustomValidity("");
    } catch {
      elements.integrationWechatEndpoint.setCustomValidity(
        "仅允许微信官方接口，或非生产环境的 loopback 地址。",
      );
    }
    if (!elements.integrationForm.reportValidity()) {
      return;
    }
    elements.integrationFormError.hidden = true;
    state.configurationSubmitting = true;
    setConfigurationFormDisabled(true);
    setButtonBusy(elements.integrationSave, true, {
      idleLabel: "保存运行参数",
      busyLabel: "正在保存…",
    });
    const authGeneration = state.authGeneration;
    const gameId = state.configurationGameId;
    try {
      const integration = await api.updateGameIntegration(
        gameId,
        integrationInput(),
      );
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      state.integration = integration;
      touchSessionActivity();
      renderConfiguration();
      toast("接入参数已保存；微信凭据尚需实际调用验证。");
      void reloadConfigurationAudit();
    } catch (error) {
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      if (await handleConfigurationWriteError(error, "integration-update")) {
        return;
      }
      elements.integrationFormErrorMessage.textContent =
        describeApiError(error, "integration-update");
      elements.integrationFormError.hidden = false;
      elements.integrationFormError.focus();
    } finally {
      state.configurationSubmitting = false;
      setButtonBusy(elements.integrationSave, false, {
        idleLabel: "保存运行参数",
        busyLabel: "正在保存…",
      });
      if (state.session && state.configurationLoaded) {
        setConfigurationFormDisabled(false);
      }
    }
  }

  async function submitDirectorySettings() {
    if (
      state.configurationSubmitting
      || !state.session?.canManageIntegrations
      || !state.directorySettings
      || !state.configurationGameId
    ) {
      return;
    }
    state.configurationSubmitting = true;
    setConfigurationFormDisabled(true);
    const authGeneration = state.authGeneration;
    const gameId = state.configurationGameId;
    try {
      state.directorySettings = await api.updateDirectorySettings(gameId, {
        isOps: elements.directoryIsOps.checked,
        revision: state.directorySettings.revision,
      });
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      touchSessionActivity();
      renderConfiguration();
      toast("运营目录设置已保存。");
      void reloadConfigurationAudit();
    } catch (error) {
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      if (await handleConfigurationWriteError(error, "directory-update")) {
        return;
      }
      elements.integrationFormErrorMessage.textContent =
        describeApiError(error, "directory-update");
      elements.integrationFormError.hidden = false;
      elements.integrationFormError.focus();
    } finally {
      state.configurationSubmitting = false;
      if (state.session && state.configurationLoaded) {
        setConfigurationFormDisabled(false);
      }
    }
  }

  async function reloadConfigurationAudit() {
    if (!hasConfigurationAccess()) {
      return;
    }
    try {
      const records = await api.listConfigurationAudit(
        state.configurationGameId,
        50,
      );
      if (!hasConfigurationAccess()) {
        return;
      }
      state.configurationAudit = records;
      renderConfigurationAudit();
    } catch {
      // The primary mutation already succeeded. A later refresh can recover
      // this non-sensitive audit panel without repeating the write.
    }
  }

  function openWechatSecretDialog() {
    if (
      !state.session?.canManageIntegrations
      || !state.session.canRotateSecrets
      || !state.integration
    ) {
      return;
    }
    clearWechatSecretInput();
    elements.wechatSecretError.hidden = true;
    elements.wechatSecretErrorMessage.textContent = "";
    elements.wechatSecretDialog.showModal();
    window.queueMicrotask(() => elements.wechatSecretInput.focus());
  }

  function setWechatSecretBusy(busy) {
    state.wechatSecretSubmitting = busy;
    elements.wechatSecretInput.disabled = busy;
    elements.wechatSecretToggle.disabled = busy;
    elements.wechatSecretClose.disabled = busy;
    elements.wechatSecretCancel.disabled = busy;
    setButtonBusy(elements.wechatSecretSubmit, busy, {
      idleLabel: "确认替换",
      busyLabel: "正在保存…",
    });
  }

  async function submitWechatSecret(event) {
    event.preventDefault();
    if (
      state.wechatSecretSubmitting
      || !state.session?.canManageIntegrations
      || !state.session.canRotateSecrets
      || !state.integration
      || !state.configurationGameId
    ) {
      clearWechatSecretInput();
      return;
    }
    let submittedSecret = elements.wechatSecretInput.value;
    elements.wechatSecretInput.setCustomValidity(
      submittedSecret.length > 0 && submittedSecret.length <= 512
        ? ""
        : "AppSecret 必须为 1–512 个字符。",
    );
    if (!elements.wechatSecretForm.reportValidity()) {
      submittedSecret = "";
      clearWechatSecretInput();
      return;
    }
    const gameId = state.configurationGameId;
    const revision = state.integration.revision;
    const operationId = createConfigurationOperationId(randomUUID);
    const authGeneration = state.authGeneration;
    elements.wechatSecretError.hidden = true;
    setWechatSecretBusy(true);
    try {
      const result = await api.replaceWechatAppSecret(gameId, {
        wechatAppSecret: submittedSecret,
        revision,
        operationId,
      });
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      state.integration = Object.freeze({
        ...state.integration,
        configurationState: result.configurationState,
        wechatSecret: result.wechatSecret,
        revision: result.revision,
        loadedRevision: result.loadedRevision,
      });
      touchSessionActivity();
      closeWechatSecretDialog();
      renderConfiguration();
      toast("AppSecret 已安全保存；尚未声明微信侧验证成功。");
      void reloadConfigurationAudit();
    } catch (error) {
      if (
        authGeneration !== state.authGeneration
        || gameId !== state.configurationGameId
      ) {
        return;
      }
      if (
        await handleConfigurationWriteError(
          error,
          "wechat-secret",
          { close: closeWechatSecretDialog },
        )
      ) {
        return;
      }
      setBadge(
        elements.wechatSecretStatusBadge,
        "替换失败",
        "danger",
      );
      elements.wechatSecretErrorMessage.textContent =
        describeApiError(error, "wechat-secret");
      elements.wechatSecretError.hidden = false;
      elements.wechatSecretError.focus();
    } finally {
      submittedSecret = "";
      clearWechatSecretInput();
      if (elements.wechatSecretDialog.open) {
        setWechatSecretBusy(false);
      } else {
        state.wechatSecretSubmitting = false;
      }
    }
  }

  function renderMachineScopeOptions(selectedGameIds = []) {
    const selected = new Set(selectedGameIds);
    elements.machineScopeOptions.replaceChildren(
      ...availableConfigurationGames().map((game) => {
        const label = document.createElement("label");
        label.className = "gmk-confirm-label";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = game.gameId;
        checkbox.dataset.machineScope = game.gameId;
        checkbox.checked = selected.has(game.gameId);
        label.append(checkbox, `${game.name} · ${game.gameId}`);
        return label;
      }),
    );
  }

  function openMachineIdentityForm(mode, identity = null, opener = null) {
    if (
      !state.session?.canManageMachineIdentities
      || (
        mode === "create"
        && !state.session.canRotateSecrets
      )
      || !["create", "edit"].includes(mode)
    ) {
      return;
    }
    state.machineFormMode = mode;
    state.editingMachineIdentity = identity;
    state.machineIdentityOpener = opener ?? document.activeElement;
    elements.machineIdentityForm.reset();
    elements.machineIdentityError.hidden = true;
    elements.machineIdentityErrorMessage.textContent = "";
    const creating = mode === "create";
    elements.machineIdentityDialogKind.textContent = creating
      ? "CREATE MACHINE IDENTITY"
      : "EDIT MACHINE IDENTITY";
    elements.machineIdentityDialogTitle.textContent = creating
      ? "新增机器身份"
      : "编辑机器身份";
    elements.machineIdentityId.value = identity?.identityId ?? "";
    elements.machineIdentityId.readOnly = !creating;
    elements.machineIdentityType.value = identity?.identityType ?? "service";
    elements.machineIdentityType.disabled = !creating;
    elements.machineIdentityName.value = identity?.displayName ?? "";
    elements.machineIdentityStatus.value = identity?.status ?? "enabled";
    elements.machineIdentityStatus.disabled = creating;
    renderMachineScopeOptions(identity?.gameIds ?? []);
    elements.machineIdentitySubmit.querySelector(
      "[data-button-label]",
    ).textContent = creating ? "创建并生成 Secret" : "保存修改";
    elements.machineIdentityDialog.showModal();
    window.queueMicrotask(() => (
      creating ? elements.machineIdentityId : elements.machineIdentityName
    ).focus());
  }

  function setMachineIdentityBusy(busy) {
    state.machineIdentitySubmitting = busy;
    for (const control of elements.machineIdentityForm.elements) {
      control.disabled = busy;
    }
    elements.machineIdentityClose.disabled = busy;
    elements.machineIdentityCancel.disabled = busy;
    setButtonBusy(elements.machineIdentitySubmit, busy, {
      idleLabel:
        state.machineFormMode === "create"
          ? "创建并生成 Secret"
          : "保存修改",
      busyLabel: "正在保存…",
    });
    if (!busy) {
      elements.machineIdentityId.disabled = false;
      elements.machineIdentityType.disabled =
        state.machineFormMode !== "create";
      elements.machineIdentityStatus.disabled =
        state.machineFormMode === "create";
    }
  }

  function selectedMachineScopes() {
    return [...elements.machineScopeOptions.querySelectorAll(
      "[data-machine-scope]",
    )].filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  }

  async function submitMachineIdentity(event) {
    event.preventDefault();
    if (
      state.machineIdentitySubmitting
      || !state.session?.canManageMachineIdentities
      || !state.machineFormMode
    ) {
      return;
    }
    const creating = state.machineFormMode === "create";
    const identityId = elements.machineIdentityId.value.trim();
    const displayName = elements.machineIdentityName.value.trim();
    elements.machineIdentityId.value = identityId;
    elements.machineIdentityName.value = displayName;
    elements.machineIdentityId.setCustomValidity(
      MACHINE_ID_PATTERN.test(identityId) ? "" : "请输入合法的身份 ID。",
    );
    elements.machineIdentityName.setCustomValidity(
      [...displayName].length >= 1 && [...displayName].length <= 128
        ? ""
        : "显示名称必须为 1–128 个字符。",
    );
    if (!elements.machineIdentityForm.reportValidity()) {
      return;
    }
    const operationId = creating
      ? createConfigurationOperationId(randomUUID)
      : null;
    const authGeneration = state.authGeneration;
    elements.machineIdentityError.hidden = true;
    setMachineIdentityBusy(true);
    try {
      if (creating) {
        const result = await api.createMachineIdentity({
          identityId,
          identityType: elements.machineIdentityType.value,
          displayName,
          gameIds: selectedMachineScopes(),
          operationId,
        });
        if (
          authGeneration !== state.authGeneration
          || !state.session?.canManageMachineIdentities
        ) {
          return;
        }
        upsertMachineIdentity(result.identity);
        closeMachineIdentityDialog();
        if (typeof result.secret === "string") {
          openOneTimeSecret(
            result.secret,
            `${result.identity.displayName} · Secret v${result.version}`,
          );
        } else {
          toast(
            "身份已创建，但一次性 Secret 已无法恢复；请按需重新轮换。",
            "warning",
          );
        }
      } else {
        const identity = state.editingMachineIdentity;
        const result = await api.updateMachineIdentity(identityId, {
          displayName,
          status: elements.machineIdentityStatus.value,
          gameIds: selectedMachineScopes(),
          revision: identity.revision,
        });
        if (
          authGeneration !== state.authGeneration
          || !state.session?.canManageMachineIdentities
        ) {
          return;
        }
        upsertMachineIdentity(result);
        closeMachineIdentityDialog();
        toast(`机器身份 ${identityId} 已更新。`);
      }
      touchSessionActivity();
      void reloadConfigurationAudit();
    } catch (error) {
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      if (
        creating
        && error instanceof AdminApiError
        && (error.status === 0 || error.status >= 500)
      ) {
        closeMachineIdentityDialog();
        await recoverMachineOperation(identityId, operationId);
        return;
      }
      if (
        await handleConfigurationWriteError(
          error,
          creating ? "machine-create" : "machine-update",
          { close: closeMachineIdentityDialog, unknownStatusFirst: creating },
        )
      ) {
        return;
      }
      elements.machineIdentityErrorMessage.textContent =
        describeApiError(
          error,
          creating ? "machine-create" : "machine-update",
        );
      elements.machineIdentityError.hidden = false;
      elements.machineIdentityError.focus();
    } finally {
      if (elements.machineIdentityDialog.open) {
        setMachineIdentityBusy(false);
      } else {
        state.machineIdentitySubmitting = false;
      }
    }
  }

  function openOneTimeSecret(secret, context) {
    closeOneTimeSecretDialog();
    state.oneTimeSecret = secret;
    elements.oneTimeSecretValue.value = secret;
    elements.oneTimeSecretValue.type = "password";
    elements.oneTimeSecretContext.textContent = context;
    elements.oneTimeSecretConfirm.checked = false;
    elements.oneTimeSecretClose.disabled = true;
    elements.oneTimeSecretDialog.showModal();
    window.queueMicrotask(() => elements.oneTimeSecretToggle.focus());
  }

  async function recoverMachineOperation(identityId, operationId) {
    try {
      const status = await api.machineSecretOperationStatus(
        identityId,
        operationId,
      );
      await loadConfiguration();
      toast(
        status.deliveryLost
          ? "操作已完成，但一次性 Secret 已无法恢复；请重新轮换。"
          : "操作已完成；已刷新状态，请核对后继续。",
        "warning",
      );
    } catch (statusError) {
      if (
        statusError instanceof AdminApiError
        && statusError.status === 401
      ) {
        clearSensitiveState();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (
        statusError instanceof AdminApiError
        && statusError.status === 403
      ) {
        clearSensitiveState();
        await refreshPermissions();
        return;
      }
      await loadConfiguration();
      toast(
        "操作结果未知；已先查询并刷新状态，未自动重复生成 Secret。",
        "warning",
      );
    }
  }

  async function rotateMachineSecret(identity, previousValiditySeconds) {
    if (
      !state.session?.canManageMachineIdentities
      || !state.session.canRotateSecrets
    ) {
      return;
    }
    const operationId = createConfigurationOperationId(randomUUID);
    const authGeneration = state.authGeneration;
    try {
      const result = await api.rotateMachineSecret(identity.identityId, {
        operationId,
        revision: identity.revision,
        previousValiditySeconds,
      });
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      upsertMachineIdentity(result.identity);
      touchSessionActivity();
      if (typeof result.secret === "string") {
        openOneTimeSecret(
          result.secret,
          `${result.identity.displayName} · Secret v${result.version}`,
        );
      } else {
        toast(
          "轮换已完成，但一次性 Secret 已无法恢复；请重新轮换。",
          "warning",
        );
      }
      void reloadConfigurationAudit();
    } catch (error) {
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      if (
        error instanceof AdminApiError
        && (error.status === 0 || error.status >= 500)
      ) {
        await recoverMachineOperation(identity.identityId, operationId);
        return;
      }
      if (
        await handleConfigurationWriteError(
          error,
          "machine-rotate",
          { unknownStatusFirst: true },
        )
      ) {
        return;
      }
      toast(describeApiError(error, "machine-rotate"), "danger");
    }
  }

  function openMachineRevoke(identity, secretVersion, opener) {
    state.machineRevokeTarget = { identity, secretVersion };
    elements.machineRevokeTarget.textContent =
      `${identity.displayName}（${identity.identityId}）/ Secret v`
      + `${secretVersion.version}`;
    elements.machineRevokeReason.value = "";
    elements.machineRevokeError.hidden = true;
    state.machineIdentityOpener = opener;
    elements.machineRevokeDialog.showModal();
    window.queueMicrotask(() => elements.machineRevokeReason.focus());
  }

  function setMachineRevokeBusy(busy) {
    state.machineRevokeSubmitting = busy;
    elements.machineRevokeReason.disabled = busy;
    elements.machineRevokeClose.disabled = busy;
    elements.machineRevokeCancel.disabled = busy;
    setButtonBusy(elements.machineRevokeSubmit, busy, {
      idleLabel: "确认撤销",
      busyLabel: "正在撤销…",
    });
  }

  async function submitMachineRevoke(event) {
    event.preventDefault();
    const target = state.machineRevokeTarget;
    if (
      state.machineRevokeSubmitting
      || !target
      || !state.session?.canManageMachineIdentities
      || !state.session.canRotateSecrets
    ) {
      return;
    }
    const reason = elements.machineRevokeReason.value.trim();
    elements.machineRevokeReason.value = reason;
    if (!elements.machineRevokeForm.reportValidity()) {
      return;
    }
    const operationId = createConfigurationOperationId(randomUUID);
    const authGeneration = state.authGeneration;
    setMachineRevokeBusy(true);
    try {
      const result = await api.revokeMachineSecret(
        target.identity.identityId,
        target.secretVersion.version,
        {
          operationId,
          revision: target.identity.revision,
          reason,
        },
      );
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      closeMachineRevokeDialog();
      await loadConfiguration();
      touchSessionActivity();
      toast(
        `机器 Secret v${result.version} 已撤销。`,
      );
    } catch (error) {
      if (authGeneration !== state.authGeneration || !state.session) {
        return;
      }
      if (
        error instanceof AdminApiError
        && (error.status === 0 || error.status >= 500)
      ) {
        closeMachineRevokeDialog();
        await recoverMachineOperation(
          target.identity.identityId,
          operationId,
        );
        return;
      }
      if (
        await handleConfigurationWriteError(
          error,
          "machine-revoke",
          { close: closeMachineRevokeDialog, unknownStatusFirst: true },
        )
      ) {
        return;
      }
      elements.machineRevokeErrorMessage.textContent =
        describeApiError(error, "machine-revoke");
      elements.machineRevokeError.hidden = false;
      elements.machineRevokeError.focus();
    } finally {
      if (elements.machineRevokeDialog.open) {
        setMachineRevokeBusy(false);
      } else {
        state.machineRevokeSubmitting = false;
      }
    }
  }

  function routeAuthenticated({ focus = true } = {}) {
    const view = chooseAdminView(state.session, window.location.hash);
    if (view !== "integration") {
      clearSensitiveState();
    }
    showView(view, { focus });
    if (view === "games") {
      void loadManagedGames();
    } else if (view === "integration") {
      void prepareConfigurationPage();
    }
  }

  function shouldConfirmDisable() {
    return (
      state.gameFormMode === "edit"
      && state.editingGame?.status !== "disabled"
      && elements.gameStatus.value === "disabled"
    );
  }

  function updateGameFormRules() {
    const game = state.editingGame;
    const creating = state.gameFormMode === "create";
    const status = elements.gameStatus.value;
    const enabledOption = elements.gameStatus.querySelector(
      'option[value="enabled"]',
    );
    if (enabledOption) {
      enabledOption.disabled = creating || game?.configurationState === "draft";
    }

    elements.gameId.readOnly = !creating;
    elements.gameId.setAttribute("aria-readonly", String(!creating));
    elements.gameStatus.disabled =
      state.gameSubmitting || creating || game?.status === "disabled";
    elements.gameSortOrder.disabled = state.gameSubmitting || creating;

    const publishAllowed =
      !creating && canPublishGameToClient(game, status);
    if (!publishAllowed) {
      elements.gameClientVisible.checked = false;
    }
    elements.gameClientVisible.disabled =
      state.gameSubmitting || !publishAllowed;

    if (creating) {
      elements.gameStatusHelp.textContent =
        "新游戏固定以“维护中”草稿创建，完成部署配置后才能启用。";
      elements.gameClientVisibleHelp.textContent =
        "新游戏默认不下发；完成部署配置后可在编辑中开启。";
    } else if (game?.status === "disabled") {
      elements.gameStatusHelp.textContent =
        "这个游戏已永久停用，不能恢复为其他状态。";
      elements.gameClientVisibleHelp.textContent =
        "已停用游戏不能下发给客户端。";
    } else if (game?.configurationState === "draft") {
      elements.gameStatusHelp.textContent =
        "草稿不能启用；可继续维护，或永久停用。";
      elements.gameClientVisibleHelp.textContent =
        "草稿需要先完成部署配置，暂时不能下发给客户端。";
    } else if (status === "disabled") {
      elements.gameStatusHelp.textContent =
        "停用提交成功后不能恢复。";
      elements.gameClientVisibleHelp.textContent =
        "即将停用的游戏不能继续下发给客户端。";
    } else {
      elements.gameStatusHelp.textContent =
        "已配置游戏可以在启用和维护状态之间切换。";
      elements.gameClientVisibleHelp.textContent =
        "开启后，游戏会按展示顺序出现在客户端游戏列表。";
    }

    const confirmDisable = shouldConfirmDisable();
    elements.gameDisableWarning.hidden = !confirmDisable;
    elements.gameDisableConfirm.required = confirmDisable;
    elements.gameDisableConfirm.disabled =
      state.gameSubmitting || !confirmDisable;
    if (!confirmDisable) {
      elements.gameDisableConfirm.checked = false;
    }
  }

  function setGameFormBusy(busy) {
    state.gameSubmitting = busy;
    elements.gameName.disabled = busy;
    elements.gameDescription.disabled = busy;
    elements.gameDialogClose.disabled = busy;
    elements.gameCancel.disabled = busy;
    elements.gameId.disabled = busy;
    elements.gameClientVisible.disabled = busy;
    elements.gameSortOrder.disabled = busy;
    elements.gameDisableConfirm.disabled = busy;
    setButtonBusy(elements.gameSubmit, busy, {
      idleLabel: state.gameFormMode === "create" ? "新增游戏" : "保存修改",
      busyLabel: "正在保存…",
    });
    if (!busy) {
      elements.gameId.disabled = false;
    }
    updateGameFormRules();
  }

  function openGameForm(mode, game = null, opener = null) {
    if (
      !state.session?.canManageGames
      || (mode !== "create" && mode !== "edit")
      || (mode === "edit" && !game)
    ) {
      return;
    }
    state.gameFormMode = mode;
    state.editingGame = game;
    state.gameOpener = opener ?? document.activeElement;
    elements.gameForm.reset();
    elements.gameFormError.hidden = true;
    elements.gameFormErrorMessage.textContent = "";
    elements.gameId.setCustomValidity("");
    elements.gameName.setCustomValidity("");
    elements.gameDescription.setCustomValidity("");
    elements.gameStatus.setCustomValidity("");
    elements.gameDisableConfirm.setCustomValidity("");

    if (mode === "create") {
      elements.gameDialogKind.textContent = "CREATE GAME";
      elements.gameDialogTitle.textContent = "新增游戏";
      elements.gameDialogDescription.textContent =
        "新游戏将以维护中的草稿状态创建，默认不下发给客户端。";
      elements.gameId.value = "";
      elements.gameName.value = "";
      elements.gameDescription.value = "";
      elements.gameStatus.value = "maintenance";
      elements.gameClientVisible.checked = false;
      elements.gameSortOrder.value = "0";
    } else {
      elements.gameDialogKind.textContent = "EDIT GAME";
      elements.gameDialogTitle.textContent = "编辑游戏";
      elements.gameDialogDescription.textContent =
        game.configurationState === "configured"
          ? `正在编辑 ${game.gameId}；保存时会校验第 ${game.revision} 版。`
          : `正在编辑草稿 ${game.gameId}；完成部署配置前不能启用或下发。`;
      elements.gameId.value = game.gameId;
      elements.gameName.value = game.name;
      elements.gameDescription.value = game.description;
      elements.gameStatus.value = game.status;
      elements.gameClientVisible.checked = game.clientVisible;
      elements.gameSortOrder.value = String(game.sortOrder);
    }
    setGameFormBusy(false);
    elements.gameDialog.showModal();
    window.queueMicrotask(() => (
      mode === "create" ? elements.gameId : elements.gameName
    ).focus());
  }

  function dismissGameForm() {
    if (!state.gameSubmitting) {
      closeGameDialog();
    }
  }

  function upsertManagedGame(game) {
    const index = state.managedGames.findIndex(
      (candidate) => candidate.gameId === game.gameId,
    );
    state.managedGames = index === -1
      ? [...state.managedGames, game]
      : state.managedGames.map((candidate, candidateIndex) => (
          candidateIndex === index ? game : candidate
        ));
    state.managedGamesLoaded = true;
    renderManagedGames();

    if (!state.session) {
      return;
    }
    let changed = false;
    const sessionGames = state.session.games.map((access) => {
      if (access.gameId !== game.gameId) {
        return access;
      }
      changed = true;
      return Object.freeze({
        ...access,
        name: game.name,
        status: game.status,
        canOperateAccounts:
          game.status === "enabled" && access.canOperateAccounts,
      });
    });
    if (changed) {
      state.session = Object.freeze({
        ...state.session,
        games: Object.freeze(sessionGames),
      });
      populateGames();
      if (state.selectedGameId === game.gameId) {
        clearAccount({
          announcement: `游戏 ${game.gameId} 的项目配置已更新。`,
        });
        renderGame();
      }
    }
  }

  async function submitGameForm(event) {
    event.preventDefault();
    if (
      state.gameSubmitting
      || !state.session?.canManageGames
      || !state.gameFormMode
    ) {
      return;
    }
    const creating = state.gameFormMode === "create";
    const editingGame = state.editingGame;
    const gameId = elements.gameId.value.trim();
    const name = elements.gameName.value.trim();
    const description = elements.gameDescription.value.trim();
    const status = elements.gameStatus.value;
    const sortOrder = elements.gameSortOrder.valueAsNumber;
    elements.gameId.value = gameId;
    elements.gameName.value = name;
    elements.gameDescription.value = description;
    elements.gameId.setCustomValidity(
      GAME_ID_PATTERN.test(gameId) ? "" : "请输入合法的游戏 ID。",
    );
    elements.gameName.setCustomValidity(
      [...name].length >= 1 && [...name].length <= 128
        ? ""
        : "游戏名称必须为 1–128 个 Unicode 字符。",
    );
    elements.gameDescription.setCustomValidity(
      [...description].length <= 500
        ? ""
        : "游戏说明最多 500 个 Unicode 字符。",
    );
    elements.gameStatus.setCustomValidity(
      creating || canSelectGameStatus(editingGame, status)
        ? ""
        : "当前游戏不能切换到这个状态。",
    );
    if (
      !creating
      && (
        !Number.isSafeInteger(sortOrder)
        || sortOrder < 0
        || sortOrder > 65_535
      )
    ) {
      elements.gameSortOrder.setCustomValidity(
        "展示顺序必须是 0–65535 的整数。",
      );
    } else {
      elements.gameSortOrder.setCustomValidity("");
    }
    if (shouldConfirmDisable() && !elements.gameDisableConfirm.checked) {
      elements.gameDisableConfirm.setCustomValidity(
        "请确认永久停用这个游戏。",
      );
    } else {
      elements.gameDisableConfirm.setCustomValidity("");
    }
    if (!elements.gameForm.reportValidity()) {
      return;
    }

    elements.gameFormError.hidden = true;
    setGameFormBusy(true);
    const authGeneration = state.authGeneration;
    try {
      const game = creating
        ? await api.createGame({ gameId, name, description })
        : await api.updateGame(gameId, {
            name,
            description,
            status,
            clientVisible: elements.gameClientVisible.checked,
            sortOrder,
            revision: editingGame.revision,
          });
      if (
        authGeneration !== state.authGeneration
        || !state.session?.canManageGames
      ) {
        return;
      }
      touchSessionActivity();
      upsertManagedGame(game);
      if (!await synchronizeSessionAfterGameMutation(authGeneration)) {
        return;
      }
      closeGameDialog();
      toast(
        creating
          ? `游戏 ${game.gameId} 已创建为草稿。`
          : `游戏 ${game.gameId} 已更新。`,
      );
    } catch (error) {
      if (
        authGeneration !== state.authGeneration
        || !state.session
      ) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        closeGameDialog();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        closeGameDialog();
        await refreshPermissions();
        toast(describeApiError(error, "game-update"), "danger");
        return;
      }
      if (
        !creating
        && error instanceof AdminApiError
        && (error.status === 404 || error.status === 409)
      ) {
        state.managedGamesLoaded = false;
      }
      elements.gameFormErrorMessage.textContent = describeApiError(
        error,
        creating ? "game-create" : "game-update",
      );
      elements.gameFormError.hidden = false;
      elements.gameFormError.focus();
    } finally {
      if (elements.gameDialog.open) {
        setGameFormBusy(false);
      } else {
        state.gameSubmitting = false;
      }
    }
  }

  function renderAccount(account) {
    const game = currentGame();
    if (!game) {
      clearAccount();
      return;
    }
    state.account = account;
    hideAccountPanels();
    elements.accountCard.hidden = false;
    elements.accountCardUserId.textContent = account.userId;
    const status = accountStatusPresentation(account);
    setBadge(elements.accountStatusBadge, status.text, status.variant);
    elements.accountGame.textContent = `${game.name}（${game.gameId}）`;
    elements.accountLastLogin.textContent = formatDateTime(account.lastLoginAt);
    elements.accountSessionCount.textContent = `${account.activeSessionCount} 个`;

    const canOperate = game.canOperateAccounts;
    for (const button of elements.operationButtons) {
      const action = button.dataset.operation;
      button.disabled = !canPerformAccountAction(account, action, canOperate);
    }
    elements.operationHelp.textContent = account.status === "deregistered"
      ? "账号已注销，不能再执行封禁或会话撤销操作。"
      : canOperate
        ? "操作前需要填写原因，并再次核对游戏和用户。"
        : "当前管理员只有查看权限，不能修改这个游戏的账号。";
    elements.accountLiveStatus.textContent = `已加载账号 ${account.userId}。`;
  }

  function applySession(session, { focus = true } = {}) {
    if (isSessionExpired(session, now())) {
      becomeAnonymous("管理员会话已过期，请重新登录。");
      return false;
    }
    const previousGameId = state.selectedGameId;
    state.authGeneration += 1;
    state.session = session;
    state.idleExpiresAt = now() + ADMIN_SESSION_IDLE_TTL_MS;
    state.selectedGameId = chooseInitialGame(session.games, previousGameId);
    elements.operatorName.textContent = session.operator.displayName;
    elements.sessionTools.hidden = false;
    elements.accountsGamesLink.hidden = !session.canManageGames;
    elements.accountsIntegrationLink.hidden =
      !hasConfigurationAccess(session);
    elements.gamesAccountsLink.hidden = session.games.length === 0;
    elements.gamesIntegrationLink.hidden =
      !hasConfigurationAccess(session);
    elements.integrationAccountsLink.hidden = session.games.length === 0;
    elements.integrationGamesLink.hidden = !session.canManageGames;
    if (!session.canManageGames) {
      gameRequests.invalidate();
      serverRequests.invalidate();
      state.managedGames = [];
      state.managedGamesLoaded = false;
      elements.gamesList.replaceChildren();
      closeGameDialog();
      closeServerDialog();
    }
    if (!hasConfigurationAccess(session)) {
      clearConfigurationState();
    } else {
      state.configurationLoaded = false;
    }
    hideLoginError();
    populateGames();
    clearAccount();
    renderGame();
    scheduleExpiry(session.expiresAt);

    routeAuthenticated({ focus });
    if (
      !state.selectedGameId
      && !elements.views.get("accounts")?.hidden
    ) {
      elements.gameSelect.focus();
    }
    return true;
  }

  async function restoreSession({ showBoot = true } = {}) {
    const version = sessionRequests.begin();
    if (showBoot) {
      showView("boot", { focus: false });
      elements.bootSpinner.hidden = false;
      elements.bootRetry.hidden = true;
      elements.bootMessage.textContent = "正在安全地恢复管理员会话…";
    }
    try {
      const session = await api.session();
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      applySession(session);
    } catch (error) {
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        becomeAnonymous();
        return;
      }
      if (!showBoot) {
        throw error;
      }
      elements.bootSpinner.hidden = true;
      elements.bootMessage.textContent = describeApiError(error, "session");
      elements.bootRetry.hidden = false;
      elements.views.get("boot")?.querySelector("h1")?.focus();
    }
  }

  async function refreshPermissions() {
    const version = sessionRequests.begin();
    try {
      const session = await api.session();
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      if (applySession(session)) {
        toast("管理员权限已经刷新。", "info");
      }
    } catch (error) {
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      toast(describeApiError(error, "session"), "danger");
    }
  }

  async function synchronizeSessionAfterGameMutation(authGeneration) {
    const version = sessionRequests.begin();
    try {
      const session = await api.session();
      if (
        !sessionRequests.isCurrent(version)
        || authGeneration !== state.authGeneration
      ) {
        return false;
      }
      applySession(session, { focus: false });
      return true;
    } catch (error) {
      if (
        !sessionRequests.isCurrent(version)
        || authGeneration !== state.authGeneration
      ) {
        return false;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return false;
      }
      toast(
        "游戏已保存，但账号管理权限状态刷新失败；请刷新页面后再操作账号。",
        "warning",
      );
      return true;
    }
  }

  async function loadAccount(gameId, userId) {
    state.retryOperation = null;
    const version = ++state.accountRequestVersion;
    hideAccountPanels();
    elements.accountLoading.hidden = false;
    setButtonBusy(elements.searchButton, true, {
      idleLabel: "查询账号",
      busyLabel: "查询中…",
    });
    try {
      const account = await api.findAccount(gameId, userId);
      if (
        version !== state.accountRequestVersion
        || gameId !== state.selectedGameId
      ) {
        return;
      }
      touchSessionActivity();
      renderAccount(account);
    } catch (error) {
      if (
        version !== state.accountRequestVersion
        || gameId !== state.selectedGameId
      ) {
        return;
      }
      hideAccountPanels();
      if (error instanceof AdminApiError && error.status === 401) {
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        const message = describeApiError(error, "account");
        elements.accountErrorMessage.textContent = message;
        elements.accountError.hidden = false;
        elements.accountError.focus();
        await refreshPermissions();
        toast(message, "danger");
        return;
      }
      if (error instanceof AdminApiError && error.status === 404) {
        elements.accountNotFoundMessage.textContent =
          `${userId} 不存在于当前游戏。`;
        elements.accountNotFound.hidden = false;
        elements.accountLiveStatus.textContent = `没有找到账号 ${userId}。`;
        return;
      }
      elements.accountErrorMessage.textContent = describeApiError(error, "account");
      elements.accountError.hidden = false;
      elements.accountError.focus();
    } finally {
      if (version === state.accountRequestVersion) {
        setButtonBusy(elements.searchButton, false, {
          idleLabel: "查询账号",
          busyLabel: "查询中…",
        });
        elements.searchButton.disabled = !canQueryGame(currentGame());
      }
    }
  }

  function setOperationBusy(busy) {
    state.operationSubmitting = busy;
    elements.operationReason.disabled = busy;
    elements.operationCancel.disabled = busy;
    elements.dialogClose.disabled = busy;
    setButtonBusy(elements.operationConfirm, busy, {
      idleLabel:
        state.pendingOperation?.action === "ban" ? "确认封禁" : "确认撤销",
      busyLabel: "正在提交…",
    });
  }

  function openOperation(action, opener) {
    const game = currentGame();
    const account = state.account;
    if (!game || !account || !game.canOperateAccounts || opener.disabled) {
      return;
    }
    state.pendingOperation = reuseOrCreateOperationIntent({
      previous: state.retryOperation?.intent ?? null,
      action,
      gameId: game.gameId,
      userId: account.userId,
      randomUUID,
    });
    state.operationOpener = opener;
    elements.operationReason.value =
      state.pendingOperation === state.retryOperation?.intent
        ? state.retryOperation.reason
        : "";
    elements.operationError.hidden = true;
    elements.operationErrorMessage.textContent = "";

    const isBan = action === "ban";
    elements.operationTitle.textContent = isBan ? "确认封禁账号" : "确认撤销全部会话";
    elements.operationKind.textContent = isBan ? "BAN ACCOUNT" : "REVOKE SESSIONS";
    elements.operationTarget.textContent =
      `${game.name}（${game.gameId}） / ${account.userId}`;
    elements.operationDescription.textContent = isBan
      ? "封禁后该账号将无法登录，当前全部会话也会立即失效。"
      : `将立即撤销该账号当前的 ${account.activeSessionCount} 个活跃会话，不会注销账号。`;
    setOperationBusy(false);
    elements.dialog.showModal();
    window.queueMicrotask(() => elements.operationReason.focus());
  }

  function dismissOperation() {
    if (!state.operationSubmitting) {
      closeOperationDialog();
    }
  }

  async function submitOperation(event) {
    event.preventDefault();
    let intent = state.pendingOperation;
    if (!intent || state.operationSubmitting) {
      return;
    }
    const reason = elements.operationReason.value.trim();
    elements.operationReason.value = reason;
    if (!elements.operationForm.reportValidity()) {
      return;
    }
    if (
      state.retryOperation?.intent === intent
      && state.retryOperation.reason !== reason
    ) {
      intent = createOperationIntent({
        action: intent.action,
        gameId: intent.gameId,
        userId: intent.userId,
        randomUUID,
      });
      state.pendingOperation = intent;
    }

    elements.operationError.hidden = true;
    setOperationBusy(true);
    state.retryOperation = { intent, reason };
    const authGeneration = state.authGeneration;
    const accountVersion = state.accountRequestVersion;
    try {
      const result = await api.perform(intent, reason);
      if (
        authGeneration !== state.authGeneration
        || accountVersion !== state.accountRequestVersion
        || !state.session
      ) {
        return;
      }
      touchSessionActivity();
      state.retryOperation = null;
      if (!result.accountExists) {
        closeOperationDialog();
        state.pendingOperation = null;
        hideAccountPanels();
        elements.accountNotFoundMessage.textContent =
          `${intent.userId} 已不存在于当前游戏。`;
        elements.accountNotFound.hidden = false;
        toast("目标账号不存在，未执行修改。", "warning");
        return;
      }

      const account = state.account;
      if (
        account
        && state.selectedGameId === intent.gameId
        && account.userId === intent.userId
      ) {
        renderAccount(Object.freeze({
          ...account,
          status: intent.action === "ban" ? "banned" : account.status,
          activeSessionCount: 0,
        }));
      }
      closeOperationDialog();
      state.pendingOperation = null;
      toast(
        intent.action === "ban"
          ? `账号 ${intent.userId} 已封禁。`
          : `账号 ${intent.userId} 的全部会话已撤销。`,
      );
    } catch (error) {
      if (
        authGeneration !== state.authGeneration
        || accountVersion !== state.accountRequestVersion
        || !state.session
      ) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 409) {
        state.retryOperation = null;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        closeOperationDialog();
        becomeAnonymous("管理员会话已过期，请重新登录。");
        return;
      }
      if (error instanceof AdminApiError && error.status === 403) {
        const message = describeApiError(error, "operation");
        closeOperationDialog();
        await refreshPermissions();
        toast(message, "danger");
        return;
      }
      elements.operationErrorMessage.textContent = describeApiError(
        error,
        "operation",
      );
      elements.operationError.hidden = false;
      elements.operationError.focus();
    } finally {
      if (elements.dialog.open) {
        setOperationBusy(false);
      } else {
        state.operationSubmitting = false;
      }
    }
  }

  async function logout() {
    if (state.logoutSubmitting) {
      return;
    }
    state.logoutSubmitting = true;
    sessionRequests.invalidate();
    for (const button of elements.logoutButtons) {
      button.disabled = true;
    }
    let failure = null;
    try {
      await api.logout();
    } catch (error) {
      if (!isCompletedLogout(error)) {
        failure = error;
      }
    } finally {
      state.logoutSubmitting = false;
      for (const button of elements.logoutButtons) {
        button.disabled = false;
      }
    }
    if (failure) {
      toast(describeApiError(failure, "logout"), "danger");
      return;
    }
    becomeAnonymous("你已安全退出管理控制台。");
  }

  elements.bootRetry.addEventListener("click", () => restoreSession());
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.loginSubmitting) {
      return;
    }
    hideLoginError();
    const operatorId = elements.operatorId.value.trim();
    elements.operatorId.value = operatorId;
    elements.password.setCustomValidity(
      isValidAdminPasswordInput(elements.password.value)
        ? ""
        : "密码必须为 12–256 个 Unicode 字符，且不超过 1024 字节。",
    );
    if (!elements.loginForm.reportValidity()) {
      return;
    }
    elements.password.setCustomValidity("");

    const version = sessionRequests.begin();
    const loginVersion = loginRequests.begin();
    state.loginSubmitting = true;
    setButtonBusy(elements.loginButton, true, {
      idleLabel: "登录管理控制台",
      busyLabel: "正在登录…",
    });
    try {
      await api.login(operatorId, elements.password.value);
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      const session = await api.session();
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      applySession(session);
    } catch (error) {
      if (!sessionRequests.isCurrent(version)) {
        return;
      }
      const isCredentialFailure =
        error instanceof AdminApiError && error.status === 401;
      showLoginError(describeApiError(error, "login"), {
        focusError: !isCredentialFailure,
      });
      if (isCredentialFailure) {
        elements.operatorId.focus();
      }
    } finally {
      if (loginRequests.isCurrent(loginVersion)) {
        state.loginSubmitting = false;
        elements.password.value = "";
        resetPasswordControl(elements.password, elements.passwordToggle);
        setButtonBusy(elements.loginButton, false, {
          idleLabel: "登录管理控制台",
          busyLabel: "正在登录…",
        });
      }
    }
  });
  elements.password.addEventListener("input", () => {
    elements.password.setCustomValidity("");
  });

  elements.gameSelect.addEventListener("change", () => {
    state.selectedGameId = elements.gameSelect.value || null;
    clearAccount({
      announcement: state.selectedGameId
        ? `已切换到游戏 ${state.selectedGameId}，原查询结果已清空。`
        : "已清空游戏选择和账号查询结果。",
    });
    renderGame();
    if (state.selectedGameId) {
      elements.userId.focus();
    }
  });

  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const game = currentGame();
    if (!canQueryGame(game)) {
      toast(
        game
          ? "当前游戏不可用，暂时不能查询账号。"
          : "请先选择要管理的游戏。",
        "warning",
      );
      elements.gameSelect.focus();
      return;
    }
    const userId = elements.userId.value.trim();
    elements.userId.value = userId;
    elements.userId.setAttribute(
      "aria-invalid",
      String(!isValidUserId(userId)),
    );
    if (!elements.searchForm.reportValidity() || !isValidUserId(userId)) {
      elements.userId.focus();
      return;
    }
    void loadAccount(game.gameId, userId);
  });

  for (const button of elements.operationButtons) {
    button.addEventListener("click", () => {
      openOperation(button.dataset.operation, button);
    });
  }
  elements.operationForm.addEventListener("submit", submitOperation);
  elements.operationCancel.addEventListener("click", dismissOperation);
  elements.dialogClose.addEventListener("click", dismissOperation);
  elements.dialog.addEventListener("cancel", (event) => {
    if (state.operationSubmitting) {
      event.preventDefault();
    }
  });
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) {
      dismissOperation();
    }
  });
  elements.dialog.addEventListener("close", () => {
    state.pendingOperation = null;
    state.operationSubmitting = false;
    const opener = state.operationOpener;
    state.operationOpener = null;
    opener?.focus();
  });

  for (const button of [elements.gameCreateButton, elements.gamesEmptyCreate]) {
    button.addEventListener("click", () => {
      openGameForm("create", null, button);
    });
  }
  elements.gamesRetry.addEventListener("click", () => {
    void loadManagedGames({ force: true, focusError: true });
  });
  elements.gameForm.addEventListener("submit", submitGameForm);
  elements.gameCancel.addEventListener("click", dismissGameForm);
  elements.gameDialogClose.addEventListener("click", dismissGameForm);
  elements.gameStatus.addEventListener("change", () => {
    elements.gameStatus.setCustomValidity("");
    elements.gameDisableConfirm.setCustomValidity("");
    updateGameFormRules();
  });
  elements.gameId.addEventListener("input", () => {
    elements.gameId.setCustomValidity("");
  });
  elements.gameName.addEventListener("input", () => {
    elements.gameName.setCustomValidity("");
  });
  elements.gameDescription.addEventListener("input", () => {
    elements.gameDescription.setCustomValidity("");
  });
  elements.gameSortOrder.addEventListener("input", () => {
    elements.gameSortOrder.setCustomValidity("");
  });
  elements.gameDisableConfirm.addEventListener("change", () => {
    elements.gameDisableConfirm.setCustomValidity("");
  });
  elements.gameDialog.addEventListener("cancel", (event) => {
    if (state.gameSubmitting) {
      event.preventDefault();
    }
  });
  elements.gameDialog.addEventListener("click", (event) => {
    if (event.target === elements.gameDialog) {
      dismissGameForm();
    }
  });
  elements.gameDialog.addEventListener("close", () => {
    // A fast follow-up edit may reopen the same <dialog> before the previous
    // close event is delivered. Never let that stale event reset the new form.
    if (elements.gameDialog.open) {
      return;
    }
    const editedGameId = state.editingGame?.gameId ?? null;
    const opener = state.gameOpener;
    state.gameFormMode = null;
    state.editingGame = null;
    state.gameSubmitting = false;
    state.gameOpener = null;
    elements.gameForm.reset();
    elements.gameFormError.hidden = true;
    elements.gameFormErrorMessage.textContent = "";
    elements.gameDisableWarning.hidden = true;
    elements.gameDisableConfirm.required = false;
    elements.gameId.setCustomValidity("");
    elements.gameName.setCustomValidity("");
    elements.gameDescription.setCustomValidity("");
    elements.gameStatus.setCustomValidity("");
    elements.gameSortOrder.setCustomValidity("");
    elements.gameDisableConfirm.setCustomValidity("");
    const replacement = editedGameId
      ? [...elements.gamesList.querySelectorAll("[data-game-edit]")].find(
          (button) => button.dataset.gameEdit === editedGameId,
        )
      : null;
    const focusTarget = replacement ?? opener;
    if (state.session && !elements.views.get("games")?.hidden) {
      window.queueMicrotask(() => focusTarget?.focus());
    }
    if (
      !state.managedGamesLoaded
      && state.session?.canManageGames
      && !elements.views.get("games")?.hidden
    ) {
      void loadManagedGames({ force: true });
    }
  });

  for (const button of [
    elements.serverCreateButton,
    elements.serversEmptyCreate,
  ]) {
    button.addEventListener("click", () => {
      openServerForm("create", null, button);
    });
  }
  elements.serversRetry.addEventListener("click", () => {
    void loadManagedServers({ focusError: true });
  });
  elements.serverForm.addEventListener("submit", submitServerForm);
  elements.serverCancel.addEventListener("click", () => hideServerEditor());
  elements.serverEditorClose.addEventListener(
    "click",
    () => hideServerEditor(),
  );
  for (const input of [
    elements.serverId,
    elements.serverName,
    elements.serverTag,
    elements.serverOpenTime,
    elements.serverHttpUrl,
    elements.serverWsUrl,
    elements.serverSortOrder,
  ]) {
    input.addEventListener("input", () => input.setCustomValidity(""));
  }
  elements.serverStatus.addEventListener("change", () => {
    elements.serverStatus.setCustomValidity("");
    updateServerFormPolicy();
  });
  elements.serverIsOpen.addEventListener("change", updateServerFormPolicy);
  elements.serverDialogClose.addEventListener("click", () => {
    if (!state.serverSubmitting) {
      closeServerDialog();
    }
  });
  elements.serverDialog.addEventListener("cancel", (event) => {
    if (state.serverSubmitting) {
      event.preventDefault();
    }
  });
  elements.serverDialog.addEventListener("click", (event) => {
    if (event.target === elements.serverDialog && !state.serverSubmitting) {
      closeServerDialog();
    }
  });
  elements.serverDialog.addEventListener("close", () => {
    // Ignore a delayed close event if the same dialog was already reopened.
    if (elements.serverDialog.open) {
      return;
    }
    serverRequests.invalidate();
    const gameId = state.serverGame?.gameId ?? null;
    const opener = state.serverDialogOpener;
    state.serverDialogGeneration += 1;
    state.serverGame = null;
    state.directoryRevision = null;
    state.managedServers = [];
    state.managedServersLoaded = false;
    state.serverFormMode = null;
    state.editingServer = null;
    state.serverSubmitting = false;
    state.serverDialogOpener = null;
    state.serverFormOpener = null;
    elements.serverGameLabel.textContent = "";
    elements.serverSummary.textContent = "";
    elements.serverCreateButton.disabled = true;
    elements.serverDialogClose.disabled = false;
    elements.serverEditorClose.disabled = false;
    elements.serverCancel.disabled = false;
    elements.serversList.replaceChildren();
    hideManagedServerPanels();
    elements.serverEditor.hidden = true;
    elements.serverForm.reset();
    elements.serverFormError.hidden = true;
    elements.serverFormErrorMessage.textContent = "";
    resetServerFormValidation();
    const replacement = gameId === null
      ? null
      : [...elements.gamesList.querySelectorAll("[data-game-servers]")].find(
          (button) => button.dataset.gameServers === gameId,
        );
    if (state.session && !elements.views.get("games")?.hidden) {
      window.queueMicrotask(() => (replacement ?? opener)?.focus());
    }
  });

  elements.integrationGameSelect.addEventListener("change", () => {
    clearSensitiveState();
    state.configurationGameId =
      elements.integrationGameSelect.value || null;
    state.integration = null;
    state.directorySettings = null;
    state.configurationServers = [];
    state.configurationLoaded = false;
    void loadConfiguration();
  });
  elements.integrationRefresh.addEventListener("click", () => {
    clearSensitiveState();
    void loadConfiguration({ focusError: true });
  });
  elements.integrationRetry.addEventListener("click", () => {
    void prepareConfigurationPage();
  });
  elements.integrationForm.addEventListener("submit", submitIntegration);
  elements.directorySave.addEventListener(
    "click",
    () => void submitDirectorySettings(),
  );
  for (const input of elements.integrationForm.elements) {
    input.addEventListener?.("input", () => {
      input.setCustomValidity?.("");
      elements.integrationFormError.hidden = true;
    });
  }

  elements.wechatSecretReplace.addEventListener("click", () => {
    requestElevatedAction(
      () => openWechatSecretDialog(),
      elements.wechatSecretReplace,
    );
  });
  elements.wechatSecretForm.addEventListener("submit", submitWechatSecret);
  elements.wechatSecretInput.addEventListener("input", () => {
    elements.wechatSecretInput.setCustomValidity("");
    elements.wechatSecretError.hidden = true;
  });
  elements.wechatSecretToggle.addEventListener("click", () => {
    const visible = elements.wechatSecretInput.type === "text";
    elements.wechatSecretInput.type = visible ? "password" : "text";
    elements.wechatSecretToggle.setAttribute(
      "aria-pressed",
      String(!visible),
    );
    elements.wechatSecretToggle.setAttribute(
      "aria-label",
      visible ? "显示 AppSecret" : "隐藏 AppSecret",
    );
  });
  for (const button of [
    elements.wechatSecretClose,
    elements.wechatSecretCancel,
  ]) {
    button.addEventListener("click", () => {
      if (!state.wechatSecretSubmitting) {
        closeWechatSecretDialog();
      }
    });
  }
  elements.wechatSecretDialog.addEventListener("cancel", (event) => {
    if (state.wechatSecretSubmitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeWechatSecretDialog();
  });
  elements.wechatSecretDialog.addEventListener("click", (event) => {
    if (
      event.target === elements.wechatSecretDialog
      && !state.wechatSecretSubmitting
    ) {
      closeWechatSecretDialog();
    }
  });
  elements.wechatSecretDialog.addEventListener("close", () => {
    clearWechatSecretInput();
    state.wechatSecretSubmitting = false;
  });

  elements.reauthenticateForm.addEventListener(
    "submit",
    submitReauthentication,
  );
  elements.reauthenticatePassword.addEventListener("input", () => {
    elements.reauthenticatePassword.setCustomValidity("");
    elements.reauthenticateError.hidden = true;
  });
  for (const button of [
    elements.reauthenticateClose,
    elements.reauthenticateCancel,
  ]) {
    button.addEventListener("click", () => {
      if (!state.reauthenticationSubmitting) {
        closeReauthenticationDialog();
      }
    });
  }
  elements.reauthenticateDialog.addEventListener("cancel", (event) => {
    if (state.reauthenticationSubmitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeReauthenticationDialog();
  });
  elements.reauthenticateDialog.addEventListener("click", (event) => {
    if (
      event.target === elements.reauthenticateDialog
      && !state.reauthenticationSubmitting
    ) {
      closeReauthenticationDialog();
    }
  });
  elements.reauthenticateDialog.addEventListener("close", () => {
    resetSecretField(
      elements.reauthenticatePassword,
      elements.reauthenticatePasswordToggle,
    );
    state.reauthenticationSubmitting = false;
  });

  elements.machineIdentityCreate.addEventListener("click", () => {
    requestElevatedAction(
      () => openMachineIdentityForm(
        "create",
        null,
        elements.machineIdentityCreate,
      ),
      elements.machineIdentityCreate,
    );
  });
  elements.machineIdentityForm.addEventListener(
    "submit",
    submitMachineIdentity,
  );
  for (const input of [
    elements.machineIdentityId,
    elements.machineIdentityName,
  ]) {
    input.addEventListener("input", () => input.setCustomValidity(""));
  }
  for (const button of [
    elements.machineIdentityClose,
    elements.machineIdentityCancel,
  ]) {
    button.addEventListener("click", () => {
      if (!state.machineIdentitySubmitting) {
        closeMachineIdentityDialog();
      }
    });
  }
  elements.machineIdentityDialog.addEventListener("cancel", (event) => {
    if (state.machineIdentitySubmitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeMachineIdentityDialog();
  });
  elements.machineIdentityDialog.addEventListener("click", (event) => {
    if (
      event.target === elements.machineIdentityDialog
      && !state.machineIdentitySubmitting
    ) {
      closeMachineIdentityDialog();
    }
  });
  elements.machineIdentityDialog.addEventListener("close", () => {
    if (elements.machineIdentityDialog.open) {
      return;
    }
    const opener = state.machineIdentityOpener;
    state.machineFormMode = null;
    state.editingMachineIdentity = null;
    state.machineIdentitySubmitting = false;
    state.machineIdentityOpener = null;
    elements.machineIdentityForm.reset();
    elements.machineScopeOptions.replaceChildren();
    elements.machineIdentityError.hidden = true;
    elements.machineIdentityErrorMessage.textContent = "";
    if (state.session && !elements.views.get("integration")?.hidden) {
      window.queueMicrotask(() => opener?.focus());
    }
  });

  elements.machineRevokeForm.addEventListener(
    "submit",
    submitMachineRevoke,
  );
  elements.machineRevokeReason.addEventListener("input", () => {
    elements.machineRevokeError.hidden = true;
  });
  for (const button of [
    elements.machineRevokeClose,
    elements.machineRevokeCancel,
  ]) {
    button.addEventListener("click", () => {
      if (!state.machineRevokeSubmitting) {
        closeMachineRevokeDialog();
      }
    });
  }
  elements.machineRevokeDialog.addEventListener("cancel", (event) => {
    if (state.machineRevokeSubmitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeMachineRevokeDialog();
  });
  elements.machineRevokeDialog.addEventListener("click", (event) => {
    if (
      event.target === elements.machineRevokeDialog
      && !state.machineRevokeSubmitting
    ) {
      closeMachineRevokeDialog();
    }
  });
  elements.machineRevokeDialog.addEventListener("close", () => {
    state.machineRevokeTarget = null;
    state.machineRevokeSubmitting = false;
    elements.machineRevokeReason.value = "";
    elements.machineRevokeTarget.textContent = "";
  });

  elements.oneTimeSecretToggle.addEventListener("click", () => {
    if (state.oneTimeSecret === null) {
      return;
    }
    elements.oneTimeSecretValue.type = "text";
    elements.oneTimeSecretToggle.setAttribute("aria-pressed", "true");
    elements.oneTimeSecretToggle.textContent = "已显示";
    elements.oneTimeSecretToggle.disabled = true;
  });
  elements.oneTimeSecretCopy.addEventListener("click", async () => {
    if (state.oneTimeSecret === null) {
      return;
    }
    try {
      if (typeof window.navigator?.clipboard?.writeText === "function") {
        await window.navigator.clipboard.writeText(state.oneTimeSecret);
      } else {
        elements.oneTimeSecretValue.select();
        if (!document.execCommand?.("copy")) {
          throw new Error("copy unavailable");
        }
      }
      toast("一次性 Secret 已复制，请立即存入受控系统。");
    } catch {
      toast("无法自动复制，请手动保存一次性 Secret。", "warning");
    }
  });
  elements.oneTimeSecretConfirm.addEventListener("change", () => {
    elements.oneTimeSecretClose.disabled =
      !elements.oneTimeSecretConfirm.checked;
  });
  elements.oneTimeSecretClose.addEventListener("click", () => {
    if (elements.oneTimeSecretConfirm.checked) {
      closeOneTimeSecretDialog();
    }
  });
  elements.oneTimeSecretDialog.addEventListener(
    "cancel",
    (event) => event.preventDefault(),
  );
  elements.oneTimeSecretDialog.addEventListener("close", clearOneTimeSecret);

  for (const button of elements.logoutButtons) {
    button.addEventListener("click", () => void logout());
  }
  window.addEventListener("hashchange", () => {
    if (!state.session) {
      showView("login");
    } else {
      routeAuthenticated();
    }
  });
  window.addEventListener("pagehide", clearSensitiveState);

  void restoreSession();
  return Object.freeze({
    restoreSession,
    snapshot() {
      return Object.freeze({
        authenticated: state.session !== null,
        selectedGameId: state.selectedGameId,
        accountUserId: state.account?.userId ?? null,
        pendingOperationId: state.pendingOperation?.operationId ?? null,
        retryOperationId: state.retryOperation?.intent.operationId ?? null,
      });
    },
  });
}

function startBrowserApplication() {
  try {
    bootstrapAdminConsole();
  } catch (error) {
    const message = globalThis.document?.getElementById("boot-message");
    const spinner = globalThis.document?.getElementById("boot-spinner");
    if (spinner) {
      spinner.hidden = true;
    }
    if (message) {
      message.textContent = "管理页面初始化失败，请刷新页面或联系系统负责人。";
    }
    globalThis.console?.error?.("[admin-web] bootstrap failed", error);
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startBrowserApplication, {
      once: true,
    });
  } else {
    startBrowserApplication();
  }
}
