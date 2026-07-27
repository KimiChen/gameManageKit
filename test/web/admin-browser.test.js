import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ADMIN_ROOT = fileURLToPath(new URL("../../web/admin/", import.meta.url));
const CHROME_CANDIDATES = [
  process.env.GMK_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
]);

function chromePath() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDevToolsPort(profileDirectory, child) {
  const activePortFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome 提前退出，退出码 ${child.exitCode}`);
    }
    try {
      const [port] = (await readFile(activePortFile, "utf8")).trim().split("\n");
      if (/^[0-9]+$/u.test(port ?? "")) {
        return Number(port);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error("等待 Chrome DevTools 端口超时");
}

function json(reply, status, body) {
  const payload = JSON.stringify(body);
  reply.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "browser-e2e",
  });
  reply.end(payload);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function createAdminFixtureServer() {
  let authenticated = false;
  let nextOperationGate = null;
  const errors = [];
  const operations = [];
  const staticFiles = new Map([
    ["/admin/", "index.html"],
    ["/admin/admin.css", "admin.css"],
    ["/admin/app.js", "app.js"],
    ["/admin/wsk.css", "wsk.css"],
    ["/admin/wsk.js", "wsk.js"],
  ]);

  const server = createServer(async (request, reply) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const staticName = staticFiles.get(url.pathname);
      if (request.method === "GET" && staticName) {
        const payload = await readFile(join(ADMIN_ROOT, staticName));
        const extension = staticName.slice(staticName.lastIndexOf("."));
        reply.writeHead(200, {
          "cache-control": "no-cache",
          "content-length": payload.length,
          "content-type": MIME_TYPES.get(extension),
        });
        reply.end(payload);
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/admin/auth/session"
      ) {
        if (!authenticated) {
          json(reply, 401, {
            code: "ADMIN_AUTH_REQUIRED",
            message: "authentication required",
          });
          return;
        }
        json(reply, 200, {
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
          expiresAt: "2099-07-28T18:00:00.000Z",
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/v1/admin/auth/login"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        assert.deepEqual(body, {
          operatorId: "ops_kimi",
          password: "correct horse battery",
        });
        authenticated = true;
        reply.writeHead(204, {
          "cache-control": "no-store",
          "set-cookie":
            "gmk_admin_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; "
            + "Path=/; HttpOnly; SameSite=Strict",
        });
        reply.end();
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/v1/games/game-a/admin/accounts/u_12345"
      ) {
        json(reply, 200, {
          userId: "u_12345",
          status: "active",
          lastLoginAt: "2026-07-28T05:20:00.000Z",
          activeSessionCount: 2,
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname
          === "/v1/games/game-a/admin/accounts/u_12345/ban"
      ) {
        const body = JSON.parse(await readRequestBody(request));
        operations.push(body);
        const gate = nextOperationGate;
        nextOperationGate = null;
        if (gate) {
          gate.markStarted();
          await gate.wait;
        }
        json(reply, 200, {
          accountExists: true,
          status: "banned",
        });
        return;
      }

      json(reply, 404, {
        code: "NOT_FOUND",
        message: "not found",
      });
    } catch (error) {
      errors.push(error);
      if (!reply.headersSent) {
        json(reply, 500, {
          code: "FIXTURE_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        reply.destroy(error);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    delayNextOperation() {
      if (nextOperationGate) {
        throw new Error("已有待延迟的管理员操作");
      }
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      nextOperationGate = { markStarted, wait };
      return {
        started,
        release,
      };
    },
    errors,
    operations,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

class DevToolsClient {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? "浏览器脚本执行失败",
    );
  }
  return response.result.value;
}

async function waitFor(client, expression, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`等待浏览器状态超时：${label}`);
}

async function pressKey(client, key, code = key) {
  const virtualKeyCode = key === "Enter"
    ? 13
    : key === "Tab"
      ? 9
      : undefined;
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    ...(virtualKeyCode === undefined
      ? {}
      : {
          nativeVirtualKeyCode: virtualKeyCode,
          windowsVirtualKeyCode: virtualKeyCode,
        }),
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
  });
}

async function focusAndType(client, selector, value) {
  await evaluate(
    client,
    `document.querySelector(${JSON.stringify(selector)}).focus()`,
  );
  await client.send("Input.insertText", { text: value });
}

test("真实 Chrome 可用键盘完成管理员登录、查询和确认操作", {
  timeout: 30_000,
}, async (t) => {
  const executable = chromePath();
  if (!executable) {
    t.skip("未找到 Chrome/Chromium；可通过 GMK_CHROME_PATH 指定");
    return;
  }

  const fixture = await createAdminFixtureServer();
  t.after(fixture.close);
  const profileDirectory = await mkdtemp(join(tmpdir(), "gmk-admin-chrome-"));
  t.after(() => rm(profileDirectory, { force: true, recursive: true }));

  const chrome = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate",
    "--disable-gpu",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1024,900",
    "about:blank",
  ], {
    stdio: "ignore",
  });
  t.after(() => {
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
    }
  });

  const port = await waitForDevToolsPort(profileDirectory, chrome);
  const targetResponse = await fetch(
    `http://127.0.0.1:${port}/json/new?`
      + encodeURIComponent(`${fixture.baseUrl}/admin/`),
    { method: "PUT" },
  );
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  assert.equal(typeof target.webSocketDebuggerUrl, "string");

  const client = new DevToolsClient(target.webSocketDebuggerUrl);
  await client.open();
  t.after(() => client.close());

  const browserErrors = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    browserErrors.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") {
      browserErrors.push(entry.text);
    }
  });
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Log.enable"),
  ]);

  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "显示登录页",
  );
  // Restoring an anonymous session intentionally receives 401; Chrome logs
  // that HTTP response as a resource error even though the application handles it.
  browserErrors.length = 0;
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "operator-id",
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 1024,
  });
  assert.equal(
    await evaluate(
      client,
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
    true,
  );

  await focusAndType(client, "#operator-id", "ops_kimi");
  await pressKey(client, "Tab");
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "operator-password",
  );
  await client.send("Input.insertText", { text: "correct horse battery" });
  await pressKey(client, "Enter");

  try {
    await waitFor(
      client,
      "!document.querySelector('#accounts-view').hidden",
      "登录后显示账号管理",
    );
  } catch (error) {
    const loginState = await evaluate(client, `({
      active: document.activeElement?.id,
      error: document.querySelector("#login-error-message")?.textContent,
      invalid: document.querySelector("#operator-password")?.validationMessage,
      operator: document.querySelector("#operator-id")?.value,
      passwordLength: document.querySelector("#operator-password")?.value.length,
    })`);
    throw new Error(
      `${error.message}; fixture=${fixture.errors.map(String).join(" | ")}; `
      + `login=${JSON.stringify(loginState)}`,
      { cause: error },
    );
  }
  assert.equal(
    await evaluate(client, "document.querySelector('#operator-password').value"),
    "",
  );

  await evaluate(client, `(() => {
    const select = document.querySelector("#game-select");
    select.focus();
    select.value = "game-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.equal(
    await evaluate(client, "document.activeElement.id"),
    "account-user-id",
  );

  await client.send("Input.insertText", { text: "u_12345" });
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "!document.querySelector('#account-card').hidden",
    "显示账号查询结果",
  );

  await evaluate(
    client,
    "document.querySelector('[data-operation=\"ban\"]').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#operation-dialog').open",
    "打开确认对话框",
  );
  assert.match(
    await evaluate(
      client,
      "document.querySelector('#operation-dialog-target').textContent",
    ),
    /游戏 A（game-a） \/ u_12345/u,
  );

  await focusAndType(client, "#operation-reason", "安全处置确认");
  await evaluate(
    client,
    "document.querySelector('#operation-confirm').focus()",
  );
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#account-status-badge').textContent === '已封禁'",
    "封禁操作完成",
  );

  assert.equal(fixture.operations.length, 1);
  assert.equal(fixture.operations[0].reason, "安全处置确认");
  assert.match(
    fixture.operations[0].operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

  const previousTheme = await evaluate(
    client,
    "document.documentElement.dataset.theme",
  );
  await evaluate(
    client,
    "document.querySelector('[data-theme-toggle]').focus()",
  );
  await pressKey(client, "Enter");
  assert.notEqual(
    await evaluate(client, "document.documentElement.dataset.theme"),
    previousTheme,
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 844,
    mobile: false,
    width: 375,
  });
  assert.deepEqual(
    await evaluate(client, `({
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth,
      operationButtonsVisible: [...document.querySelectorAll("[data-operation]")]
        .every((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }),
    })`),
    {
      noHorizontalOverflow: true,
      operationButtonsVisible: true,
    },
  );

  assert.deepEqual(
    await evaluate(client, `(() => {
      const select = document.querySelector("#game-select");
      select.value = "game-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        emptyTitle: document.querySelector("#account-empty-title").textContent,
        searchDisabled: document.querySelector("#search-button").disabled,
        userIdDisabled: document.querySelector("#account-user-id").disabled,
      };
    })()`),
    {
      emptyTitle: "游戏维护中",
      searchDisabled: true,
      userIdDisabled: true,
    },
  );

  await evaluate(client, `(() => {
    const select = document.querySelector("#game-select");
    select.value = "game-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const userId = document.querySelector("#account-user-id");
    userId.value = "u_12345";
    document.querySelector("#account-search-form").requestSubmit();
  })()`);
  await waitFor(
    client,
    "!document.querySelector('#account-card').hidden",
    "重新加载竞态测试账号",
  );

  const delayedOperation = fixture.delayNextOperation();
  t.after(delayedOperation.release);
  await evaluate(client, `(() => {
    document.querySelector("#toast-region").replaceChildren();
    document.querySelector('[data-operation="ban"]').focus();
  })()`);
  await pressKey(client, "Enter");
  await waitFor(
    client,
    "document.querySelector('#operation-dialog').open",
    "打开待过期操作对话框",
  );
  await focusAndType(client, "#operation-reason", "延迟响应竞态");
  await evaluate(
    client,
    "document.querySelector('#operation-confirm').focus()",
  );
  await pressKey(client, "Enter");
  await delayedOperation.started;

  await client.send("Emulation.setVirtualTimePolicy", {
    budget: (30 * 60 * 1_000) + 1,
    maxVirtualTimeTaskStarvationCount: 10_000,
    policy: "advance",
  });
  await waitFor(
    client,
    "!document.querySelector('#login-view').hidden",
    "操作等待期间空闲会话自动退出",
  );
  delayedOperation.release();
  await delay(100);
  assert.deepEqual(
    await evaluate(client, `({
      accountHidden: document.querySelector("#account-card").hidden,
      accountFieldsEmpty: [
        "#account-card-user-id",
        "#account-game",
        "#account-last-login",
        "#account-session-count",
        "#operation-dialog-target",
        "#operation-dialog-description",
      ].every((selector) => document.querySelector(selector).textContent === ""),
      reason: document.querySelector("#operation-reason").value,
      selectedGame: document.querySelector("#selected-game-label").textContent,
      toastCount: document.querySelector("#toast-region").childElementCount,
      userId: document.querySelector("#account-user-id").value,
    })`),
    {
      accountHidden: true,
      accountFieldsEmpty: true,
      reason: "",
      selectedGame: "",
      toastCount: 0,
      userId: "",
    },
  );
  assert.equal(fixture.operations.length, 2);
  assert.deepEqual(browserErrors, []);
});
