import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/common.js";
import { closeWithDeadline } from "../../src/main.js";

test("SIGTERM 使用的 drain 会等待在途请求后再关闭数据库", async () => {
  const app = createHttpApp(loadConfig({
    NODE_ENV: "development",
    GAME_MANAGE_KIT_MYSQL_URL: "mysql://root@127.0.0.1:3316/game_manage_kit_lifecycle_test",
    GAME_MANAGE_KIT_SERVICE_SECRET: "service",
    GAME_MANAGE_KIT_ADMIN_SECRET: "admin",
    GAME_MANAGE_KIT_LOG_ENABLED: "0",
  }));
  let releaseRequest: (() => void) | undefined;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  app.get("/slow", async () => {
    markEntered?.();
    await requestGate;
    return { ok: true };
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const responsePromise = fetch(`${address}/slow`);
  await entered;

  let databaseClosed = false;
  let closeSettled = false;
  const closePromise = closeWithDeadline(
    [app],
    async () => {
      databaseClosed = true;
    },
    2_000,
  ).then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(databaseClosed, false);

  releaseRequest?.();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await closePromise;
  assert.equal(databaseClosed, true);
});

test("drain 超过截止时间会失败而不是无界等待", async () => {
  const neverClosing = {
    close: async () => new Promise<void>(() => undefined),
  } as FastifyInstance;
  let databaseClosed = false;
  await assert.rejects(
    closeWithDeadline(
      [neverClosing],
      async () => {
        databaseClosed = true;
      },
      25,
    ),
    /graceful shutdown 超过 25ms/,
  );
  assert.equal(databaseClosed, false);
});
