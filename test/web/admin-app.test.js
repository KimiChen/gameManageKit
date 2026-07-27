import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AdminApiError,
  InvalidApiPayloadError,
  accountPath,
  chooseInitialGame,
  createAdminApi,
  createOperationIntent,
  describeApiError,
  isValidUserId,
  normalizeAccount,
  normalizeOperationResult,
  normalizeSession,
} from "../../web/admin/app.js";

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
  expiresAt: "2026-07-28T18:00:00.000Z",
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
  assert.match(html, /aria-labelledby="operation-dialog-title"/u);
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

  assert.match(
    wskCss,
    /f920dc584db1cb8d1b3e4206a54e1f1eebe497eb/u,
  );
});

test("会话响应按管理员和游戏权限严格校验", () => {
  const session = normalizeSession(validSession());
  assert.equal(session.operator.operatorId, "ops_kimi");
  assert.deepEqual(
    session.games.map((game) => game.gameId),
    ["game-a", "game-b"],
  );
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.games), true);

  const duplicated = validSession();
  duplicated.games[1].gameId = "game-a";
  assert.throws(
    () => normalizeSession(duplicated),
    InvalidApiPayloadError,
  );

  const invalidCapability = validSession();
  invalidCapability.games[0].canOperateAccounts = "yes";
  assert.throws(
    () => normalizeSession(invalidCapability),
    InvalidApiPayloadError,
  );

  const invalidExpiry = validSession();
  invalidExpiry.expiresAt = "tomorrow";
  assert.throws(
    () => normalizeSession(invalidExpiry),
    InvalidApiPayloadError,
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

test("账号与操作响应拒绝宽松或错位数据", () => {
  const account = normalizeAccount({
    userId: "u_12345",
    status: "active",
    lastLoginAt: null,
    activeSessionCount: 2,
  }, "u_12345");
  assert.equal(account.activeSessionCount, 2);
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
    normalizeOperationResult({ accountExists: true, status: "revoked" }),
    { accountExists: true, status: "revoked" },
  );
  assert.throws(
    () => normalizeOperationResult({ accountExists: true, status: "done" }),
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
