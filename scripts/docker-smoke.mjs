import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const publicUrl = process.env.SMOKE_PUBLIC_URL ?? "http://127.0.0.1:12570";
const internalUrl = process.env.SMOKE_INTERNAL_URL ?? "http://127.0.0.1:12571";
const mysqlUrl = process.env.GAME_MANAGE_KIT_MYSQL_URL;

if (!mysqlUrl) {
  throw new Error("GAME_MANAGE_KIT_MYSQL_URL is required");
}

async function requestJson(baseUrl, path, expectedStatus, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text}`);
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${path} returned HTTP ${response.status}: ${text}`,
  );
  return body;
}

async function requestText(baseUrl, path, expectedStatus, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
  const body = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${path} returned HTTP ${response.status}: ${body}`,
  );
  return { body, headers: response.headers };
}

const jsonRequest = (body, headers = {}) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...headers,
  },
  body: JSON.stringify(body),
});

const adminIndex = await requestText(internalUrl, "/admin/", 200);
assert.match(
  adminIndex.headers.get("content-type") ?? "",
  /^text\/html(?:;|$)/u,
);
assert.match(
  adminIndex.headers.get("content-security-policy") ?? "",
  /default-src 'none'/u,
);
assert.match(adminIndex.body, /gameManageKit 管理控制台/u);

const adminApplication = await requestText(internalUrl, "/admin/app.js", 200);
assert.match(
  adminApplication.headers.get("content-type") ?? "",
  /^application\/javascript(?:;|$)/u,
);
assert.match(adminApplication.body, /bootstrapAdminConsole/u);

await requestText(publicUrl, "/admin/", 404);
await requestText(publicUrl, "/v1/admin/auth/session", 404);

const devKey = "docker-smoke-shared-identity";
const gameALogin = await requestJson(
  publicUrl,
  "/v1/games/game-a/sessions/dev",
  200,
  jsonRequest({ devKey, serverId: 1 }),
);
const gameBLogin = await requestJson(
  publicUrl,
  "/v1/games/game-b/sessions/dev",
  200,
  jsonRequest({ devKey, serverId: 1 }),
);

assert.equal(typeof gameALogin.userId, "string");
assert.equal(typeof gameBLogin.userId, "string");
assert.equal(typeof gameALogin.accessToken, "string");
assert.equal(typeof gameBLogin.accessToken, "string");
assert.notEqual(gameALogin.accessToken, gameBLogin.accessToken);

const connection = await mysql.createConnection(mysqlUrl);
try {
  const [accounts] = await connection.execute(
    `SELECT game_id, user_id
       FROM accounts
      WHERE openid = ?
      ORDER BY game_id`,
    [`dev_${devKey}`],
  );
  assert.deepEqual(
    accounts.map(({ game_id: gameId }) => gameId),
    ["game-a", "game-b"],
  );
} finally {
  await connection.end();
}

const gameAHeaders = {
  "x-service-id": "game-a-service",
  "x-service-secret": process.env.GAME_A_SERVICE_SECRET,
};
const gameBHeaders = {
  "x-service-id": "game-b-service",
  "x-service-secret": process.env.GAME_B_SERVICE_SECRET,
};

const gameAVerification = await requestJson(
  internalUrl,
  "/v1/games/game-a/internal/sessions/verify",
  200,
  jsonRequest(
    { accessToken: gameALogin.accessToken, serverId: 1 },
    gameAHeaders,
  ),
);
assert.equal(gameAVerification.valid, true);

const crossGameVerification = await requestJson(
  internalUrl,
  "/v1/games/game-b/internal/sessions/verify",
  200,
  jsonRequest(
    { accessToken: gameALogin.accessToken, serverId: 1 },
    gameBHeaders,
  ),
);
assert.equal(crossGameVerification.valid, false);

const forbidden = await requestJson(
  internalUrl,
  "/v1/games/game-b/internal/sessions/verify",
  403,
  jsonRequest(
    { accessToken: gameBLogin.accessToken, serverId: 1 },
    gameAHeaders,
  ),
);
assert.equal(forbidden.code, "GAME_ACCESS_DENIED");

console.log("[docker-smoke] admin surface and two-game isolation verified");
