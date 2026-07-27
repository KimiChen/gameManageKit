import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";
import {
  createContractBaseline,
  type ContractBaseline,
} from "../../scripts/check-contract-breaking.js";

type JsonRecord = Record<string, unknown>;

const EXPECTED_OPERATIONS = new Map([
  ["POST /v1/admin/auth/login", "Admin"],
  ["GET /v1/admin/auth/session", "Admin"],
  ["DELETE /v1/admin/auth/session", "Admin"],
  ["POST /v1/games/{gameId}/sessions/wechat", "Public"],
  ["POST /v1/games/{gameId}/sessions/dev", "Public"],
  ["GET /v1/games/{gameId}/areas", "Public"],
  ["POST /v1/games/{gameId}/internal/sessions/verify", "Internal"],
  ["PUT /v1/games/{gameId}/internal/characters/{userId}/{serverId}", "Internal"],
  ["GET /v1/games/{gameId}/internal/characters/{userId}/{serverId}", "Internal"],
  ["POST /v1/games/{gameId}/admin/accounts/{userId}/ban", "Admin"],
  ["POST /v1/games/{gameId}/admin/accounts/{userId}/revoke", "Admin"],
  ["GET /v1/games/{gameId}/admin/accounts/{userId}", "Admin"],
  ["GET /metrics", "Internal"],
  ["GET /livez", "System"],
  ["GET /readyz", "System"],
  ["GET /version", "System"],
] as const);

const REQUIRED_TENANT_ERROR_CODES = [
  "GAME_NOT_FOUND",
  "GAME_DISABLED",
  "GAME_ACCESS_DENIED",
  "SERVER_NOT_FOUND",
  "SERVER_DISABLED",
] as const;

function record(value: unknown): JsonRecord {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonRecord;
}

test("OpenAPI 仅保留多游戏业务路径，并为每个业务 operation 声明 gameId", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  const paths = record(document.paths);
  const actualOperations = new Map<string, string>();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = record(rawPathItem);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (pathItem[method] === undefined) {
        continue;
      }
      const operation = record(pathItem[method]);
      const tags = operation.tags as unknown[];
      actualOperations.set(`${method.toUpperCase()} ${path}`, String(tags[0]));

      if (path.startsWith("/v1/games/")) {
        assert.match(path, /^\/v1\/games\/\{gameId\}\//);
        const parameters = pathItem.parameters as Array<{ $ref?: string }>;
        assert.equal(
          parameters.some((parameter) => (
            parameter.$ref === "#/components/parameters/GameId"
          )),
          true,
          `${method.toUpperCase()} ${path} 缺少统一 GameId path parameter`,
        );
        const responses = record(operation.responses);
        assert.deepEqual(responses["403"], { $ref: "#/components/responses/Forbidden" });
        assert.deepEqual(responses["404"], { $ref: "#/components/responses/NotFound" });
        assert.deepEqual(responses["503"], { $ref: "#/components/responses/Unavailable" });
      } else if (path.startsWith("/v1/admin/auth/")) {
        assert.deepEqual(operation.tags, ["Admin"]);
        assert.equal(pathItem.parameters, undefined);
      } else {
        assert.equal(["/metrics", "/livez", "/readyz", "/version"].includes(path), true);
        assert.equal(pathItem.parameters, undefined);
      }
    }
  }

  assert.deepEqual(actualOperations, EXPECTED_OPERATIONS);
});

test("管理员网页契约使用 Cookie 会话且保留机器管理员身份", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  const components = record(document.components);
  const schemes = record(components.securitySchemes);
  assert.deepEqual(schemes.AdminSession, {
    type: "apiKey",
    in: "cookie",
    name: "__Host-gmk_admin_session",
  });

  const paths = record(document.paths);
  const login = record(record(paths["/v1/admin/auth/login"]).post);
  assert.deepEqual(login.security, []);
  const session = record(record(paths["/v1/admin/auth/session"]).get);
  assert.deepEqual(session.security, [{ AdminSession: [] }]);

  for (const path of [
    "/v1/games/{gameId}/admin/accounts/{userId}",
    "/v1/games/{gameId}/admin/accounts/{userId}/ban",
    "/v1/games/{gameId}/admin/accounts/{userId}/revoke",
  ]) {
    const method = path.endsWith("}") ? "get" : "post";
    const operation = record(record(paths[path])[method]);
    assert.deepEqual(operation.security, [
      { AdminSession: [] },
      { AdminSecret: [], OperatorId: [] },
    ]);
  }
});

test("OpenAPI 固定 gameId、游戏状态和租户错误码", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  const schemas = record(record(document.components).schemas);
  assert.deepEqual(schemas.GameId, {
    type: "string",
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9-]{1,31}$",
  });
  assert.deepEqual(schemas.GameStatus, {
    type: "string",
    enum: ["enabled", "maintenance", "disabled"],
  });
  const errorCodes = record(schemas.ErrorCode).enum as string[];
  for (const code of REQUIRED_TENANT_ERROR_CODES) {
    assert.equal(errorCodes.includes(code), true, `ErrorCode 缺少 ${code}`);
  }
  assert.deepEqual(
    record(record(schemas.ErrorResponse).properties).code,
    { $ref: "#/components/schemas/ErrorCode" },
  );
});

test("metrics 是仅使用 Service 身份的全局文本端点", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  const metrics = record(record(record(document.paths)["/metrics"]).get);
  assert.deepEqual(metrics.tags, ["Internal"]);
  assert.deepEqual(metrics.security, [{
    ServiceId: [],
    ServiceSecret: [],
  }]);
  assert.deepEqual(
    record(record(record(metrics.responses)["200"]).content)["text/plain"],
    { schema: { type: "string" } },
  );
});

test("committed baseline 与当前多游戏契约完全一致", async () => {
  const baseline = JSON.parse(
    await readFile("openapi/contract-baseline.json", "utf8"),
  ) as ContractBaseline;
  assert.deepEqual(baseline, await createContractBaseline());
});
