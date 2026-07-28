import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/common.js";

test("结构化日志覆盖所有业务 Secret 字段名", async (t) => {
  const records: Array<Record<string, unknown>> = [];
  const app = createHttpApp(loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://gmk@127.0.0.1:3306/game_manage_kit_log_redaction",
    GAME_MANAGE_KIT_LOG_ENABLED: "1",
  }), {
    write(message) {
      records.push(JSON.parse(message) as Record<string, unknown>);
    },
  });
  t.after(async () => app.close());

  app.post<{ Body: Record<string, string> }>(
    "/redaction-probe",
    async (request) => {
      request.log.info({
        request: {
          headers: request.headers,
          body: request.body,
        },
        ...request.body,
      }, "redaction probe");
      return { ok: true };
    },
  );

  const secrets = {
    secret: "value-secret",
    appSecret: "value-app-secret",
    wechatAppSecret: "value-wechat-secret",
    wechat_app_secret: "value-wechat-snake-secret",
    serviceSecret: "value-service-secret",
    adminSecret: "value-admin-secret",
    machineSecret: "value-machine-secret",
    previousSecret: "value-previous-secret",
    newSecret: "value-new-secret",
  };
  const response = await app.inject({
    method: "POST",
    url: "/redaction-probe",
    headers: {
      "x-service-secret": "value-service-header",
      "x-admin-secret": "value-admin-header",
    },
    payload: secrets,
  });

  assert.equal(response.statusCode, 200);
  const serialized = JSON.stringify(records);
  for (const value of [
    ...Object.values(secrets),
    "value-service-header",
    "value-admin-header",
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.equal(serialized.includes("[REDACTED]"), true);
});
