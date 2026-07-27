import {
  createToastController,
  initPasswordControls,
  initTheme,
  resetPasswordControl,
} from "./wsk.js";

export const USER_ID_PATTERN = /^u_[0-9]+$/u;
export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
export const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
export const ADMIN_ACTIONS = Object.freeze(["ban", "revoke"]);
export const ADMIN_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

const GAME_STATUSES = new Set(["enabled", "maintenance", "disabled"]);
const GAME_CONFIGURATION_STATES = new Set(["draft", "configured"]);
const SERVER_TAGS = new Set(["normal", "new", "full", "maintenance"]);
const SERVER_STATUSES = new Set(["smooth", "busy", "maintenance"]);
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

  const expiresAt = requiredString(payload.expiresAt, "expiresAt", 64);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new InvalidApiPayloadError("expiresAt 无效");
  }

  return Object.freeze({
    operator: Object.freeze({ operatorId, displayName }),
    games: Object.freeze(games),
    canManageGames: payload.canManageGames,
    expiresAt,
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
  return Object.freeze({ servers: Object.freeze(servers) });
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
      ).servers;
    },
    async createGameServer(gameId, input) {
      return normalizeGameServer(
        await request(gameServerPath(gameId), {
          method: "POST",
          body: input,
        }),
        gameId,
        input.serverId,
      );
    },
    async updateGameServer(gameId, serverId, input) {
      return normalizeGameServer(
        await request(gameServerPath(gameId, serverId), {
          method: "PATCH",
          body: input,
        }),
        gameId,
        serverId,
      );
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
  if (hash === "#games" && session.canManageGames) {
    return "games";
  }
  if (session.games.length > 0) {
    return "accounts";
  }
  return session.canManageGames ? "games" : "no-access";
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
    managedServers: [],
    managedServersLoaded: false,
    serverFormMode: null,
    editingServer: null,
    serverSubmitting: false,
    serverDialogOpener: null,
    serverFormOpener: null,
    serverDialogGeneration: 0,
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
    state.managedServers = [];
    state.managedServersLoaded = false;
    state.serverFormMode = null;
    state.editingServer = null;
    state.serverSubmitting = false;
    state.serverDialogOpener = null;
    state.serverFormOpener = null;
    state.serverDialogGeneration += 1;
    state.logoutSubmitting = false;
    elements.sessionTools.hidden = true;
    elements.gameSelect.replaceChildren();
    elements.operatorName.textContent = "";
    elements.selectedGameLabel.textContent = "";
    elements.gameStatusBadge.textContent = "";
    elements.accountsGamesLink.hidden = true;
    elements.gamesAccountsLink.hidden = false;
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
      const servers = await api.listGameServers(gameId);
      if (
        !serverRequests.isCurrent(requestVersion)
        || dialogGeneration !== state.serverDialogGeneration
        || authGeneration !== state.authGeneration
        || !elements.serverDialog.open
        || state.serverGame?.gameId !== gameId
      ) {
        return;
      }
      state.managedServers = servers;
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
      const server = creating
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

  function routeAuthenticated({ focus = true } = {}) {
    const view = chooseAdminView(state.session, window.location.hash);
    showView(view, { focus });
    if (view === "games") {
      void loadManagedGames();
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
    elements.gamesAccountsLink.hidden = session.games.length === 0;
    if (!session.canManageGames) {
      gameRequests.invalidate();
      serverRequests.invalidate();
      state.managedGames = [];
      state.managedGamesLoaded = false;
      elements.gamesList.replaceChildren();
      closeGameDialog();
      closeServerDialog();
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
