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
  ["GET /v1/admin/games", "Admin"],
  ["POST /v1/admin/games", "Admin"],
  ["PATCH /v1/admin/games/{gameId}", "Admin"],
  ["GET /v1/admin/games/{gameId}/servers", "Admin"],
  ["POST /v1/admin/games/{gameId}/servers", "Admin"],
  ["PATCH /v1/admin/games/{gameId}/servers/{serverId}", "Admin"],
  ["GET /v1/games", "Public"],
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
      } else if (path.startsWith("/v1/admin/")) {
        assert.deepEqual(operation.tags, ["Admin"]);
        if (path.includes("{gameId}")) {
          const parameters = pathItem.parameters as Array<{ $ref?: string }>;
          assert.equal(
            parameters.some((parameter) => (
              parameter.$ref === "#/components/parameters/GameId"
            )),
            true,
            `${method.toUpperCase()} ${path} 缺少统一 GameId path parameter`,
          );
          if (path.includes("{serverId}")) {
            assert.equal(
              parameters.some((parameter) => (
                parameter.$ref === "#/components/parameters/ServerId"
              )),
              true,
              `${method.toUpperCase()} ${path} 缺少统一 ServerId path parameter`,
            );
          }
        } else {
          assert.equal(pathItem.parameters, undefined);
        }
      } else if (path === "/v1/games") {
        assert.deepEqual(operation.tags, ["Public"]);
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

  for (const [path, method] of [
    ["/v1/admin/games", "get"],
    ["/v1/admin/games", "post"],
    ["/v1/admin/games/{gameId}", "patch"],
    ["/v1/admin/games/{gameId}/servers", "get"],
    ["/v1/admin/games/{gameId}/servers", "post"],
    ["/v1/admin/games/{gameId}/servers/{serverId}", "patch"],
  ] as const) {
    const operation = record(record(paths[path])[method]);
    assert.deepEqual(operation.security, [{ AdminSession: [] }]);
    if (method !== "get") {
      assert.match(String(operation.description), /Origin/u);
    }
  }

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

test("游戏项目管理契约固定权限、生命周期、乐观锁与客户端展示字段", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  assert.equal(record(document.info).version, "1.2.0");
  const schemas = record(record(document.components).schemas);

  assert.deepEqual(schemas.GameConfigurationState, {
    type: "string",
    enum: ["draft", "configured"],
  });

  const session = record(schemas.AdminSessionResponse);
  assert.deepEqual(session.required, [
    "operator",
    "games",
    "canManageGames",
    "expiresAt",
  ]);
  assert.deepEqual(record(session.properties).canManageGames, { type: "boolean" });
  for (const schemaName of [
    "AdminSessionResponse",
    "GameProjectListResponse",
    "ClientGameListResponse",
  ]) {
    const games = record(
      record(record(schemas[schemaName]).properties).games,
    );
    assert.equal(games.type, "array");
    assert.equal(games.maxItems, undefined);
  }

  const project = record(schemas.GameProject);
  assert.deepEqual(project.required, [
    "gameId",
    "name",
    "description",
    "status",
    "configurationState",
    "clientVisible",
    "sortOrder",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  const projectProperties = record(project.properties);
  assert.deepEqual(projectProperties.configurationState, {
    $ref: "#/components/schemas/GameConfigurationState",
  });
  assert.deepEqual(projectProperties.clientVisible, { type: "boolean" });
  assert.deepEqual(projectProperties.sortOrder, {
    type: "integer",
    minimum: 0,
    maximum: 65535,
  });
  assert.deepEqual(projectProperties.revision, {
    type: "integer",
    minimum: 1,
  });

  const create = record(schemas.CreateGameProjectRequest);
  assert.deepEqual(create.required, ["gameId", "name", "description"]);
  assert.deepEqual(Object.keys(record(create.properties)), [
    "gameId",
    "name",
    "description",
  ]);

  const update = record(schemas.UpdateGameProjectRequest);
  assert.deepEqual(update.required, [
    "name",
    "description",
    "status",
    "clientVisible",
    "sortOrder",
    "revision",
  ]);
  assert.deepEqual(
    record(record(update.properties).status),
    { $ref: "#/components/schemas/GameStatus" },
  );

  const clientSummary = record(schemas.ClientGameSummary);
  assert.deepEqual(clientSummary.required, [
    "gameId",
    "name",
    "description",
    "status",
  ]);
  assert.deepEqual(record(clientSummary.properties).status, {
    type: "string",
    enum: ["enabled", "maintenance"],
  });

  const paths = record(document.paths);
  const clientList = record(record(paths["/v1/games"]).get);
  assert.deepEqual(clientList.security, []);
  assert.deepEqual(
    record(record(record(clientList.responses)["200"]).content)["application/json"],
    { schema: { $ref: "#/components/schemas/ClientGameListResponse" } },
  );

  const createGame = record(record(paths["/v1/admin/games"]).post);
  assert.deepEqual(
    record(createGame.responses)["201"],
    {
      description: "游戏项目已创建",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/GameProject" },
        },
      },
    },
  );
  const updateGame = record(record(paths["/v1/admin/games/{gameId}"]).patch);
  assert.deepEqual(
    record(updateGame.responses)["200"],
    {
      description: "游戏项目已更新",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/GameProject" },
        },
      },
    },
  );

  const errorCodes = record(schemas.ErrorCode).enum as string[];
  assert.equal(errorCodes.includes("GAME_PROJECT_CONFLICT"), true);
});

test("游戏区服管理契约固定字段、开放开关、乐观锁与公开结构", async () => {
  const document = record(YAML.parse(await readFile("openapi/openapi.yaml", "utf8")));
  const schemas = record(record(document.components).schemas);
  const serverFields = [
    "name",
    "tag",
    "status",
    "openTime",
    "gameHttpUrl",
    "gameWsUrl",
    "isOpen",
    "sortOrder",
  ];

  const managed = record(schemas.ManagedGameServer);
  assert.equal(managed.additionalProperties, false);
  assert.deepEqual(managed.required, [
    "gameId",
    "serverId",
    ...serverFields,
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  const managedProperties = record(managed.properties);
  assert.deepEqual(managedProperties.gameId, {
    $ref: "#/components/schemas/GameId",
  });
  assert.deepEqual(managedProperties.serverId, {
    type: "integer",
    minimum: 0,
    maximum: 65535,
  });
  assert.deepEqual(managedProperties.name, {
    type: "string",
    minLength: 1,
    maxLength: 64,
  });
  assert.deepEqual(managedProperties.tag, {
    type: "string",
    enum: ["normal", "new", "full", "maintenance"],
  });
  assert.deepEqual(managedProperties.status, {
    type: "string",
    enum: ["smooth", "busy", "maintenance"],
  });
  assert.deepEqual(managedProperties.openTime, {
    type: "integer",
    minimum: 0,
  });
  for (const property of ["gameHttpUrl", "gameWsUrl"]) {
    assert.deepEqual(managedProperties[property], {
      type: "string",
      format: "uri",
      maxLength: 2048,
    });
  }
  assert.deepEqual(managedProperties.isOpen, { type: "boolean" });
  assert.deepEqual(managedProperties.sortOrder, {
    type: "integer",
    minimum: 0,
    maximum: 65535,
  });
  assert.deepEqual(managedProperties.revision, {
    type: "integer",
    minimum: 1,
  });
  for (const property of ["createdAt", "updatedAt"]) {
    assert.deepEqual(managedProperties[property], {
      type: "string",
      format: "date-time",
    });
  }

  const list = record(schemas.ManagedGameServerListResponse);
  assert.equal(list.additionalProperties, false);
  assert.deepEqual(list.required, ["servers"]);
  assert.deepEqual(record(list.properties).servers, {
    type: "array",
    maxItems: 65536,
    items: { $ref: "#/components/schemas/ManagedGameServer" },
  });

  const create = record(schemas.CreateGameServerRequest);
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(create.required, ["serverId", ...serverFields]);
  assert.deepEqual(Object.keys(record(create.properties)), [
    "serverId",
    ...serverFields,
  ]);

  const update = record(schemas.UpdateGameServerRequest);
  assert.equal(update.additionalProperties, false);
  assert.deepEqual(update.required, [...serverFields, "revision"]);
  assert.deepEqual(Object.keys(record(update.properties)), [
    ...serverFields,
    "revision",
  ]);

  const paths = record(document.paths);
  const collection = record(paths["/v1/admin/games/{gameId}/servers"]);
  assert.deepEqual(collection.parameters, [{
    $ref: "#/components/parameters/GameId",
  }]);
  const listServers = record(collection.get);
  assert.deepEqual(
    record(record(record(listServers.responses)["200"]).content)["application/json"],
    { schema: { $ref: "#/components/schemas/ManagedGameServerListResponse" } },
  );
  for (const status of ["400", "401", "403", "404", "500", "503"]) {
    assert.equal(record(listServers.responses)[status] !== undefined, true);
  }
  const createServer = record(collection.post);
  assert.deepEqual(
    record(record(createServer.requestBody).content)["application/json"],
    { schema: { $ref: "#/components/schemas/CreateGameServerRequest" } },
  );
  assert.deepEqual(
    record(createServer.responses)["201"],
    {
      description: "游戏区服已创建",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ManagedGameServer" },
        },
      },
    },
  );

  const item = record(paths["/v1/admin/games/{gameId}/servers/{serverId}"]);
  assert.deepEqual(item.parameters, [
    { $ref: "#/components/parameters/GameId" },
    { $ref: "#/components/parameters/ServerId" },
  ]);
  const updateServer = record(item.patch);
  assert.deepEqual(
    record(record(updateServer.requestBody).content)["application/json"],
    { schema: { $ref: "#/components/schemas/UpdateGameServerRequest" } },
  );
  assert.deepEqual(
    record(updateServer.responses)["200"],
    {
      description: "游戏区服已更新",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ManagedGameServer" },
        },
      },
    },
  );
  for (const operation of [createServer, updateServer]) {
    assert.deepEqual(record(operation.responses)["409"], {
      $ref: "#/components/responses/Conflict",
    });
    for (const status of [
      "400",
      "401",
      "403",
      "404",
      "409",
      "429",
      "500",
      "503",
    ]) {
      assert.equal(record(operation.responses)[status] !== undefined, true);
    }
  }

  const publicServer = record(schemas.AreaServer);
  assert.equal(publicServer.additionalProperties, false);
  assert.deepEqual(publicServer.required, [
    "serverId",
    "name",
    "tag",
    "status",
    "openTime",
    "gameHttpUrl",
    "gameWsUrl",
  ]);
  assert.deepEqual(Object.keys(record(publicServer.properties)), [
    "serverId",
    "name",
    "tag",
    "status",
    "openTime",
    "gameHttpUrl",
    "gameWsUrl",
  ]);
  const publicAreas = record(record(paths["/v1/games/{gameId}/areas"]).get);
  assert.match(String(publicAreas.description), /isOpen=true/u);

  const errorCodes = record(schemas.ErrorCode).enum as string[];
  assert.equal(errorCodes.includes("GAME_SERVER_CONFLICT"), true);
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
