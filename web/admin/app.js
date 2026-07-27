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
    || value.length > maxLength
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
    expiresAt,
  });
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
  if (error.status === 404 && context === "account") {
    return "当前游戏中不存在这个用户 ID。";
  }
  if (error.status === 409) {
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
    state.logoutSubmitting = false;
    elements.sessionTools.hidden = true;
    elements.gameSelect.replaceChildren();
    elements.operatorName.textContent = "";
    elements.selectedGameLabel.textContent = "";
    elements.gameStatusBadge.textContent = "";
    elements.toastRegion.replaceChildren();
    closeOperationDialog();
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

  function applySession(session) {
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
    hideLoginError();
    populateGames();
    clearAccount();
    renderGame();
    scheduleExpiry(session.expiresAt);

    if (session.games.length === 0) {
      showView("no-access");
      return true;
    }
    showView("accounts");
    if (!state.selectedGameId) {
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

  for (const button of elements.logoutButtons) {
    button.addEventListener("click", () => void logout());
  }
  window.addEventListener("hashchange", () => {
    if (!state.session) {
      showView("login");
    } else if (state.session.games.length === 0) {
      showView("no-access");
    } else {
      showView("accounts");
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
