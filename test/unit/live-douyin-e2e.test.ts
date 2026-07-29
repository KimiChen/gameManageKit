import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LiveDouyinVerificationError,
  parseLiveDouyinArgs,
  preflightLiveDouyin,
  verifyFreshDouyinCode,
  type LiveDouyinConfig,
} from "../../scripts/verify-live-douyin.js";

const serviceSecret = "s".repeat(43);
const code = "fresh-douyin-code-canary";
const accessToken = `game-a.u_7.${"a".repeat(48)}`;
const config: LiveDouyinConfig = {
  publicUrl: "https://public.example.test",
  internalUrl: "https://internal.example.test",
  gameId: "game-a",
  serverId: 11,
  serviceId: "service_game_a",
  timeoutMs: 1_000,
};
const scriptFile = fileURLToPath(
  new URL("../../scripts/verify-live-douyin.ts", import.meta.url),
);

function json(
  body: unknown,
  status = 200,
  requestId: string | null = null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(requestId === null ? {} : { "x-request-id": requestId }),
    },
  });
}

test("真实联调参数只接受非敏感配置并规范化 origin", () => {
  assert.deepEqual(parseLiveDouyinArgs([
    "--game-id", "game-a",
    "--server-id", "11",
    "--service-id", "service_game_a",
    "--public-url", "https://public.example.test/",
    "--internal-url", "http://127.0.0.1:2571",
  ]), {
    publicUrl: "https://public.example.test",
    internalUrl: "http://127.0.0.1:2571",
    gameId: "game-a",
    serverId: 11,
    serviceId: "service_game_a",
    timeoutMs: 10_000,
  });

  for (const args of [
    ["--game-id", "game-a", "--server-id", "11", "--service-id", "x"],
    ["--game-id", "Game-A", "--server-id", "11", "--service-id", "service-a"],
    ["--game-id", "game-a", "--server-id", "-1", "--service-id", "service-a"],
    [
      "--game-id", "game-a",
      "--server-id", "11",
      "--service-id", "service-a",
      "--public-url", "https://user:pass@example.test",
    ],
    [
      "--game-id", "game-a",
      "--server-id", "11",
      "--service-id", "service-a",
      "--public-url", "http://public.example.test",
    ],
    ["--game-id", "game-a", "--server-id", "11", "--service-id", "service-a", "--code", code],
  ]) {
    assert.throws(
      () => parseLiveDouyinArgs(args),
      LiveDouyinVerificationError,
    );
  }
});

test("真实联调先校验双监听、区服与 Service 身份且不消耗 code", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/readyz")) {
      return json({ ready: true });
    }
    if (url.endsWith("/areas")) {
      return json({ servers: [{ serverId: 11 }] });
    }
    if (url.endsWith("/internal/sessions/verify")) {
      return json({ valid: false, reason: "NOT_FOUND" });
    }
    return json({ code: "NOT_FOUND", requestId: "request-a" }, 404);
  }) as typeof fetch;

  await preflightLiveDouyin(config, serviceSecret, fetchImpl);

  assert.equal(calls.length, 4);
  assert.equal(
    calls.some(({ url }) => url.includes("/sessions/douyin")),
    false,
  );
  const probe = calls.at(-1)!;
  assert.equal(
    new Headers(probe.init.headers).get("x-service-id"),
    config.serviceId,
  );
  assert.equal(
    new Headers(probe.init.headers).get("x-service-secret"),
    serviceSecret,
  );
  const probeBody = JSON.parse(String(probe.init.body)) as {
    accessToken: string;
    serverId: number;
  };
  assert.equal(probeBody.serverId, 11);
  assert.match(probeBody.accessToken, /^game-a\.u_0\.[0-9a-f]{48}$/u);
});

test("fresh code 只请求一次并以同一 token 完成权威 Session 校验", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/sessions/douyin")) {
      return json({
        userId: "u_7",
        accessToken,
        isNewAccount: true,
      }, 200, "req-101");
    }
    if (url.endsWith("/internal/sessions/verify")) {
      return json({
        valid: true,
        userId: "u_7",
        issuedAtMs: 1_000,
        expiresAtMs: 61_000,
      }, 200, "req-102");
    }
    return json({ code: "NOT_FOUND", requestId: "request-b" }, 404);
  }) as typeof fetch;

  const result = await verifyFreshDouyinCode(
    config,
    code,
    serviceSecret,
    fetchImpl,
    () => 2_000,
  );

  assert.deepEqual(result, {
    gameId: "game-a",
    serverId: 11,
    userId: "u_7",
    isNewAccount: true,
    issuedAtMs: 1_000,
    expiresAtMs: 61_000,
    loginRequestId: "req-101",
    verifyRequestId: "req-102",
  });
  assert.equal(
    calls.filter(({ url }) => url.endsWith("/sessions/douyin")).length,
    1,
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    code,
    serverId: 11,
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    accessToken,
    serverId: 11,
  });
  assert.equal(JSON.stringify(result).includes(code), false);
  assert.equal(JSON.stringify(result).includes(accessToken), false);
  assert.equal(JSON.stringify(result).includes(serviceSecret), false);
});

test("短 requestId 出现在长 token 中不误判，requestId 包含完整 code 时拒绝输出", async () => {
  const collidingConfig = {
    ...config,
    gameId: "req-102",
  };
  const collidingToken = `req-102.u_7.${"b".repeat(48)}`;
  let calls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    calls += 1;
    return calls === 1
      ? json(
        { userId: "u_7", accessToken: collidingToken, isNewAccount: false },
        200,
        "req-101",
      )
      : json({
        valid: true,
        userId: "u_7",
        issuedAtMs: 1_000,
        expiresAtMs: 61_000,
      }, 200, "req-102");
  }) as typeof fetch;
  const result = await verifyFreshDouyinCode(
    collidingConfig,
    code,
    serviceSecret,
    fetchImpl,
    () => 2_000,
  );
  assert.equal(result.verifyRequestId, "req-102");

  const reflectedCode = "sensitive";
  await assert.rejects(
    verifyFreshDouyinCode(
      config,
      reflectedCode,
      serviceSecret,
      (async (): Promise<Response> => json(
        { userId: "u_7", accessToken, isNewAccount: false },
        200,
        "req-sensitive",
      )) as typeof fetch,
    ),
    /抖音登录 缺少可信 x-request-id/u,
  );
});

test("HTTP 和结构错误只暴露规范化诊断且绝不重试或泄漏敏感值", async () => {
  let calls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    calls += 1;
    return json({
      code: "AUTH_CODE_INVALID",
      requestId: code,
      detail: `${code}:${accessToken}:${serviceSecret}`,
    }, 401, "req-103");
  }) as typeof fetch;

  await assert.rejects(
    verifyFreshDouyinCode(config, code, serviceSecret, fetchImpl),
    (error: unknown) => {
      assert.ok(error instanceof LiveDouyinVerificationError);
      assert.match(error.message, /HTTP 401 AUTH_CODE_INVALID requestId=req-103/u);
      assert.equal(error.message.includes(code), false);
      assert.equal(error.message.includes(accessToken), false);
      assert.equal(error.message.includes(serviceSecret), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Session 身份不一致、已过期或多余字段均使真实验收失败", async () => {
  for (const verification of [
    {
      valid: true,
      userId: "u_8",
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
    },
    {
      valid: true,
      userId: "u_7",
      issuedAtMs: 1_000,
      expiresAtMs: 2_000,
    },
    {
      valid: true,
      userId: "u_7",
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
      accessToken,
    },
  ]) {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? json(
          { userId: "u_7", accessToken, isNewAccount: false },
          200,
          "req-201",
        )
        : json(verification, 200, "req-202");
    }) as typeof fetch;
    await assert.rejects(
      verifyFreshDouyinCode(
        config,
        code,
        serviceSecret,
        fetchImpl,
        () => 2_000,
      ),
      /Session verify 返回结构、身份或过期时间非法/u,
    );
    assert.equal(calls, 2);
  }
});

test("真实联调拒绝重定向、超大响应及响应体超时", async () => {
  for (const response of [
    new Response(JSON.stringify({ redirect: true }), {
      status: 302,
      headers: {
        location: "https://attacker.example.test",
        "x-request-id": "req-301",
      },
    }),
    new Response("x", {
      status: 200,
      headers: {
        "content-length": String(64 * 1024 + 1),
        "x-request-id": "req-302",
      },
    }),
    new Response("x".repeat(64 * 1024 + 1), {
      status: 200,
      headers: { "x-request-id": "req-303" },
    }),
  ]) {
    let calls = 0;
    let redirectMode: RequestRedirect | undefined;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init: RequestInit = {},
    ): Promise<Response> => {
      calls += 1;
      redirectMode = init.redirect;
      return response;
    }) as typeof fetch;
    await assert.rejects(
      verifyFreshDouyinCode(config, code, serviceSecret, fetchImpl),
      LiveDouyinVerificationError,
    );
    assert.equal(calls, 1);
    assert.equal(redirectMode, "manual");
  }

  let timeoutCalls = 0;
  const timeoutFetch = (async (
    _input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    timeoutCalls += 1;
    const signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
      },
    }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    verifyFreshDouyinCode(
      { ...config, timeoutMs: 10 },
      code,
      serviceSecret,
      timeoutFetch,
    ),
    /抖音登录 超时/u,
  );
  assert.equal(timeoutCalls, 1);
});

test("CLI 在非 TTY 下拒绝敏感输入且不回显 stdin", () => {
  const stdinCanary = `${serviceSecret}\n${code}\n`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptFile,
      "--game-id",
      "game-a",
      "--server-id",
      "11",
      "--service-id",
      "service-game-a",
    ],
    {
      encoding: "utf8",
      input: stdinCanary,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /敏感输入要求交互式 TTY/u);
  assert.equal(result.stdout.includes(serviceSecret), false);
  assert.equal(result.stderr.includes(serviceSecret), false);
  assert.equal(result.stdout.includes(code), false);
  assert.equal(result.stderr.includes(code), false);
});
