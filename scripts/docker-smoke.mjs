import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { hashAdminPassword } from "../dist/infra/security/admin-password.js";

const publicUrl = process.env.SMOKE_PUBLIC_URL ?? "http://127.0.0.1:12570";
const internalUrl = process.env.SMOKE_INTERNAL_URL ?? "http://127.0.0.1:12571";
const adminOrigin = process.env.GAME_MANAGE_KIT_ADMIN_ORIGIN ?? internalUrl;
const mysqlUrl = process.env.GAME_MANAGE_KIT_MYSQL_URL;

if (!mysqlUrl) {
  throw new Error("GAME_MANAGE_KIT_MYSQL_URL is required");
}

function redacted(value) {
  if (Array.isArray(value)) {
    return value.map(redacted);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(secret|password|token|cookie|authorization)/iu.test(key)
          ? "[REDACTED]"
          : redacted(item),
      ]),
    );
  }
  return value;
}

function safeResponseText(text) {
  try {
    return JSON.stringify(redacted(JSON.parse(text)));
  } catch {
    return text
      .replace(
        /("(?:[^"]*secret|password|token|cookie|authorization)[^"]*"\s*:\s*)"[^"]*"/giu,
        '$1"[REDACTED]"',
      )
      .slice(0, 2_000);
  }
}

async function request(baseUrl, path, expectedStatus, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
  const text = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${path} returned HTTP ${response.status}: ${safeResponseText(text)}`,
  );
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `${path} returned non-JSON HTTP ${response.status}: `
        + safeResponseText(text),
      );
    }
  }
  return { body, headers: response.headers };
}

async function requestText(baseUrl, path, expectedStatus, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
  const text = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${path} returned HTTP ${response.status}: ${safeResponseText(text)}`,
  );
  return { body: text, headers: response.headers };
}

function jsonInit(method, body, headers = {}) {
  return {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

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

const adminApplication = await fetch(`${internalUrl}/admin/app.js`);
assert.equal(adminApplication.status, 200);
assert.match(
  adminApplication.headers.get("content-type") ?? "",
  /^application\/javascript(?:;|$)/u,
);
assert.match(await adminApplication.text(), /bootstrapAdminConsole/u);

await request(publicUrl, "/admin/", 404);
await request(publicUrl, "/v1/admin/auth/session", 404);

const initialGames = await request(publicUrl, "/v1/games", 200);
assert.ok(Array.isArray(initialGames.body?.games));

// The first personal administrator is the deployment trust root. The smoke
// fixture creates that one row directly, then performs all business
// configuration through the administrator API.
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const operatorId = `smoke_${suffix}`;
const adminPassword = randomBytes(24).toString("base64url");
const adminPasswordHash = await hashAdminPassword(adminPassword);
const gameA = `smoke-a-${suffix}`;
const gameB = `smoke-b-${suffix}`;

const connection = await mysql.createConnection(mysqlUrl);
try {
  await connection.beginTransaction();
  await connection.execute(
    `INSERT INTO admin_operators
       (operator_id, display_name, password_hash, status, auth_version,
        can_manage_games, can_manage_integrations, can_rotate_secrets,
        can_manage_machine_identities)
     VALUES (?, 'Docker Smoke', ?, 'enabled', 1, 1, 1, 1, 1)`,
    [operatorId, adminPasswordHash],
  );
  await connection.execute(
    `INSERT INTO admin_auth_audit (operator_id, event, reason)
     VALUES (?, 'operator_created', 'docker_smoke')`,
    [operatorId],
  );
  await connection.commit();
} catch (error) {
  await connection.rollback();
  throw error;
}

const login = await request(
  internalUrl,
  "/v1/admin/auth/login",
  204,
  jsonInit(
    "POST",
    { operatorId, password: adminPassword },
    { origin: adminOrigin },
  ),
);
const setCookies = typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : [login.headers.get("set-cookie") ?? ""];
const cookieMatch = setCookies
  .join(", ")
  .match(/(?:^|[\s,])gmk_admin_session=([A-Za-z0-9_-]{43})(?:;|,|$)/u);
assert.ok(cookieMatch, "administrator login did not issue a session cookie");
const adminCookie = `gmk_admin_session=${cookieMatch[1]}`;
const adminHeaders = {
  origin: adminOrigin,
  cookie: adminCookie,
};

async function adminRequest(path, expectedStatus, method = "GET", body) {
  return request(
    internalUrl,
    path,
    expectedStatus,
    body === undefined
      ? {
          method,
          headers: {
            accept: "application/json",
            cookie: adminCookie,
            ...(method === "GET" ? {} : { origin: adminOrigin }),
          },
        }
      : jsonInit(method, body, adminHeaders),
  );
}

const gameAProject = await adminRequest(
  "/v1/admin/games",
  201,
  "POST",
  {
    gameId: gameA,
    name: "Smoke Game A",
    description: "Docker dynamic configuration fixture A",
  },
);
const gameBProject = await adminRequest(
  "/v1/admin/games",
  201,
  "POST",
  {
    gameId: gameB,
    name: "Smoke Game B",
    description: "Docker dynamic configuration fixture B",
  },
);
assert.equal(gameAProject.body.configurationState, "draft");
assert.equal(gameBProject.body.configurationState, "draft");

for (const [gameId, serverName] of [
  [gameA, "Smoke A Server"],
  [gameB, "Smoke B Server"],
]) {
  const directory = await adminRequest(
    `/v1/admin/games/${gameId}/directory-settings`,
    200,
  );
  await adminRequest(
    `/v1/admin/games/${gameId}/servers`,
    201,
    "POST",
    {
      directoryRevision: directory.body.revision,
      serverId: 1,
      name: serverName,
      tag: "new",
      status: "smooth",
      openTime: 0,
      gameHttpUrl: `https://${gameId}.example.invalid`,
      gameWsUrl: `wss://${gameId}.example.invalid`,
      isOpen: true,
      sortOrder: 0,
    },
  );
}

await adminRequest(
  "/v1/admin/auth/reauthenticate",
  204,
  "POST",
  { password: adminPassword },
);

const wechatSecrets = new Map([
  [gameA, randomBytes(32).toString("base64url")],
  [gameB, randomBytes(32).toString("base64url")],
]);
for (const gameId of [gameA, gameB]) {
  const current = await adminRequest(
    `/v1/admin/games/${gameId}/integration`,
    200,
  );
  const updated = await adminRequest(
    `/v1/admin/games/${gameId}/integration`,
    200,
    "PATCH",
    {
      wechatAppId: `wx-${gameId}`,
      wechatEndpoint: "https://api.weixin.qq.com/sns/jscode2session",
      wechatTimeoutMs: 3000,
      wechatBreakerThreshold: 5,
      wechatBreakerOpenMs: 10000,
      sessionTtlSeconds: 259200,
      loginRateCapacity: 50,
      loginRateRefillPerSecond: 10,
      adminRateCapacity: 50,
      adminRateRefillPerSecond: 10,
      revision: current.body.revision,
    },
  );
  const written = await adminRequest(
    `/v1/admin/games/${gameId}/secrets/wechat-app-secret`,
    200,
    "PUT",
    {
      wechatAppSecret: wechatSecrets.get(gameId),
      revision: updated.body.revision,
      operationId: `wx-set-${gameId}`,
    },
  );
  assert.equal(written.body.configurationState, "configured");
  assert.equal(written.body.wechatSecret.configured, true);
  assert.equal(
    JSON.stringify(written.body).includes(wechatSecrets.get(gameId)),
    false,
  );
  const readBack = await adminRequest(
    `/v1/admin/games/${gameId}/integration`,
    200,
  );
  assert.equal(
    JSON.stringify(readBack.body).includes(wechatSecrets.get(gameId)),
    false,
  );
}

const serviceAId = `service-a-${suffix}`;
const serviceBId = `service-b-${suffix}`;
const machineAdminId = `machine-admin-${suffix}`;
async function createMachineIdentity(identityId, identityType, gameIds) {
  const issued = await adminRequest(
    "/v1/admin/machine-identities",
    201,
    "POST",
    {
      identityId,
      identityType,
      displayName: `Docker Smoke ${identityType}`,
      gameIds,
      operationId: `create-${identityId}`,
    },
  );
  assert.equal(issued.body.replayed, false);
  assert.ok(
    typeof issued.body.secret === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(issued.body.secret),
    "machine identity did not return a valid one-time Secret",
  );
  return issued.body;
}

const serviceA = await createMachineIdentity(serviceAId, "service", [gameA]);
const serviceB = await createMachineIdentity(serviceBId, "service", [gameB]);
const machineAdmin = await createMachineIdentity(
  machineAdminId,
  "machine_admin",
  [gameA],
);

const configuredProjects = await adminRequest("/v1/admin/games", 200);
for (const [gameId, sortOrder] of [[gameA, 1], [gameB, 2]]) {
  const project = configuredProjects.body.games.find(
    (candidate) => candidate.gameId === gameId,
  );
  assert.ok(project);
  assert.equal(project.configurationState, "configured");
  await adminRequest(
    `/v1/admin/games/${gameId}`,
    200,
    "PATCH",
    {
      name: project.name,
      description: project.description,
      status: "enabled",
      clientVisible: true,
      sortOrder,
      revision: project.revision,
    },
  );
}

const publicGames = await request(publicUrl, "/v1/games", 200);
assert.ok(publicGames.body.games.some(({ gameId }) => gameId === gameA));
assert.ok(publicGames.body.games.some(({ gameId }) => gameId === gameB));
for (const gameId of [gameA, gameB]) {
  const areas = await request(
    publicUrl,
    `/v1/games/${gameId}/areas`,
    200,
  );
  assert.deepEqual(
    areas.body.servers.map(({ serverId }) => serverId),
    [1],
  );
  assert.match(
    areas.headers.get("cache-control") ?? "",
    /private,\s*no-store/iu,
  );
  assert.match(areas.headers.get("vary") ?? "", /authorization/iu);
}

const devKey = `shared-${suffix}`;
const gameALogin = await request(
  publicUrl,
  `/v1/games/${gameA}/sessions/dev`,
  200,
  jsonInit("POST", { devKey, serverId: 1 }),
);
const gameBLogin = await request(
  publicUrl,
  `/v1/games/${gameB}/sessions/dev`,
  200,
  jsonInit("POST", { devKey, serverId: 1 }),
);
assert.equal(typeof gameALogin.body.userId, "string");
assert.equal(typeof gameBLogin.body.userId, "string");
assert.equal(typeof gameALogin.body.accessToken, "string");
assert.equal(typeof gameBLogin.body.accessToken, "string");
assert.ok(
  gameALogin.body.accessToken !== gameBLogin.body.accessToken,
  "tenant logins reused an access token",
);

const serviceHeaders = (serviceId, secret) => ({
  "x-service-id": serviceId,
  "x-service-secret": secret,
});
const verifySession = (gameId, token, serviceId, secret, status = 200) => (
  request(
    internalUrl,
    `/v1/games/${gameId}/internal/sessions/verify`,
    status,
    jsonInit(
      "POST",
      { accessToken: token, serverId: 1 },
      serviceHeaders(serviceId, secret),
    ),
  )
);

const gameAVerification = await verifySession(
  gameA,
  gameALogin.body.accessToken,
  serviceAId,
  serviceA.secret,
);
assert.equal(gameAVerification.body.valid, true);
const crossTokenVerification = await verifySession(
  gameB,
  gameALogin.body.accessToken,
  serviceBId,
  serviceB.secret,
);
assert.equal(crossTokenVerification.body.valid, false);
const forbidden = await verifySession(
  gameB,
  gameBLogin.body.accessToken,
  serviceAId,
  serviceA.secret,
  403,
);
assert.equal(forbidden.body.code, "GAME_ACCESS_DENIED");

const adminAccount = await request(
  internalUrl,
  `/v1/games/${gameA}/admin/accounts/${gameALogin.body.userId}`,
  200,
  {
    headers: {
      "x-operator-id": machineAdminId,
      "x-admin-secret": machineAdmin.secret,
    },
  },
);
assert.equal(adminAccount.body.userId, gameALogin.body.userId);
await request(
  internalUrl,
  `/v1/games/${gameB}/admin/accounts/${gameBLogin.body.userId}`,
  403,
  {
    headers: {
      "x-operator-id": machineAdminId,
      "x-admin-secret": machineAdmin.secret,
    },
  },
);

const rotatedServiceA = await adminRequest(
  `/v1/admin/machine-identities/${serviceAId}/secret-rotations`,
  200,
  "POST",
  {
    operationId: `rotate-${serviceAId}`,
    revision: serviceA.identity.revision,
    previousValiditySeconds: 300,
  },
);
assert.ok(
  typeof rotatedServiceA.body.secret === "string"
  && /^[A-Za-z0-9_-]{43}$/u.test(rotatedServiceA.body.secret),
  "rotation did not return a valid one-time Secret",
);
assert.ok(
  rotatedServiceA.body.secret !== serviceA.secret,
  "rotation reused the previous Secret",
);
assert.ok(rotatedServiceA.body.previousExpiresAt);
assert.equal(
  (
    await verifySession(
      gameA,
      gameALogin.body.accessToken,
      serviceAId,
      serviceA.secret,
    )
  ).body.valid,
  true,
);
assert.equal(
  (
    await verifySession(
      gameA,
      gameALogin.body.accessToken,
      serviceAId,
      rotatedServiceA.body.secret,
    )
  ).body.valid,
  true,
);

const [accounts] = await connection.execute(
  `SELECT game_id, user_id
     FROM accounts
    WHERE openid = ?
      AND game_id IN (?, ?)
    ORDER BY game_id`,
  [`dev_${devKey}`, gameA, gameB],
);
assert.deepEqual(
  accounts.map(({ game_id: gameId }) => gameId),
  [gameA, gameB],
);

const [integrationRows] = await connection.execute(
  `SELECT game_id, wechat_app_secret
     FROM game_integrations
    WHERE game_id IN (?, ?)
    ORDER BY game_id`,
  [gameA, gameB],
);
assert.ok(
  integrationRows.length === 2
  && integrationRows.every(
    (row) => row.wechat_app_secret === wechatSecrets.get(row.game_id),
  ),
  "the current WeChat AppSecret was not stored as configured",
);

const [machineSecrets] = await connection.execute(
  `SELECT identity_id, secret_digest, state
     FROM machine_secret_versions
    WHERE identity_id IN (?, ?, ?)`,
  [serviceAId, serviceBId, machineAdminId],
);
for (const secret of [
  serviceA.secret,
  serviceB.secret,
  machineAdmin.secret,
  rotatedServiceA.body.secret,
]) {
  const digest = createHash("sha256").update(secret, "utf8").digest();
  assert.ok(
    machineSecrets.some(
      ({ secret_digest: stored }) => (
        Buffer.isBuffer(stored) && stored.equals(digest)
      ),
    ),
  );
}
assert.ok(
  machineSecrets.every(
    ({ secret_digest: digest }) => (
      Buffer.isBuffer(digest) && digest.length === 32
    ),
  ),
);

await connection.end();
console.log(
  "[docker-smoke] dynamic admin configuration, tenant isolation, "
  + "machine scopes and secret rotation verified",
);
