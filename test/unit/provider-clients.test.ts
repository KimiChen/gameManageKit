import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthExchangeResult,
} from "../../src/domain/account/auth-provider.js";
import {
  DouyinClient,
  type DouyinClientOptions,
} from "../../src/infra/douyin/client.js";
import {
  WechatClient,
  type WechatClientOptions,
} from "../../src/infra/wechat/client.js";

const DOUYIN_ENDPOINT =
  "https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session";
const WECHAT_ENDPOINT =
  "https://api.weixin.qq.com/sns/jscode2session";

function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function douyinClient(
  fetchImpl: typeof fetch,
  overrides: Partial<DouyinClientOptions> = {},
): DouyinClient {
  return new DouyinClient({
    appId: "tt-app-id",
    secret: "douyin-secret-canary",
    endpoint: DOUYIN_ENDPOINT,
    timeoutMs: 100,
    breakerThreshold: 20,
    breakerOpenMs: 1_000,
    fetchImpl,
    ...overrides,
  });
}

function wechatClient(
  fetchImpl: typeof fetch,
  overrides: Partial<WechatClientOptions> = {},
): WechatClient {
  return new WechatClient({
    appId: "wx-app-id",
    secret: "wechat-secret-canary",
    endpoint: WECHAT_ENDPOINT,
    timeoutMs: 100,
    breakerThreshold: 20,
    breakerOpenMs: 1_000,
    fetchImpl,
    ...overrides,
  });
}

test("抖音 Client 构造固定 GET 查询并解析成功响应", async () => {
  const requested: {
    url?: URL;
    init: RequestInit | undefined;
  } = { init: undefined };
  const client = douyinClient(async (input, init) => {
    requested.url = new URL(String(input));
    requested.init = init;
    return jsonResponse({
      error: 0,
      openid: "douyin-openid",
      unionid: "douyin-unionid",
      session_key: "douyin-session-key",
    });
  });

  assert.deepEqual(await client.exchange("one-time-code"), {
    ok: true,
    provider: "douyin",
    providerAppId: "tt-app-id",
    subject: "douyin-openid",
    unionSubject: "douyin-unionid",
  });
  assert.ok(requested.url);
  assert.equal(requested.url.origin, "https://minigame.zijieapi.com");
  assert.equal(
    requested.url.pathname,
    "/mgplatform/api/apps/jscode2session",
  );
  assert.deepEqual(
    [...requested.url.searchParams.entries()],
    [
      ["appid", "tt-app-id"],
      ["secret", "douyin-secret-canary"],
      ["code", "one-time-code"],
    ],
  );
  assert.equal(requested.init?.redirect, "error");
  assert.equal(
    new Headers(requested.init?.headers).get("content-type"),
    "application/json",
  );
});

test("抖音 Client 接受缺失 unionid 并严格映射官方错误码", async () => {
  const results = new Map<number, AuthExchangeResult>();
  for (const code of [-1, 40_014, 40_015, 40_017, 40_018, 40_019]) {
    results.set(
      code,
      await douyinClient(async () => jsonResponse({
        error: code,
        errmsg: `sensitive-upstream-message-${code}`,
      })).exchange("one-time-code"),
    );
  }
  assert.deepEqual(results.get(-1), {
    ok: false,
    reason: "unavailable",
  });
  assert.deepEqual(results.get(40_014), {
    ok: false,
    reason: "invalid_response",
  });
  for (const code of [40_015, 40_017]) {
    assert.deepEqual(results.get(code), {
      ok: false,
      reason: "invalid_credentials",
    });
  }
  for (const code of [40_018, 40_019]) {
    assert.deepEqual(results.get(code), {
      ok: false,
      reason: "invalid_code",
    });
  }

  const withoutUnionId = await douyinClient(async () => jsonResponse({
    error: 0,
    openid: "douyin-openid",
    session_key: "douyin-session-key",
  })).exchange("one-time-code");
  assert.equal(withoutUnionId.ok && withoutUnionId.unionSubject, null);

  const detailedError = await douyinClient(async () => jsonResponse({
    error: 1,
    errcode: 40_018,
    message: "raw message must not escape",
  })).exchange("one-time-code");
  assert.deepEqual(detailedError, {
    ok: false,
    reason: "invalid_code",
  });
});

test("抖音 Client 校验 HTTP 状态、重定向及响应结构", async () => {
  const cases: ReadonlyArray<readonly [Response, AuthExchangeResult]> = [
    [
      jsonResponse({ error: 0 }, 429),
      { ok: false, reason: "rate_limited" },
    ],
    [
      jsonResponse({ error: 0 }, 503),
      { ok: false, reason: "unavailable" },
    ],
    [
      jsonResponse({
        error: 0,
        openid: "should-not-pass",
        session_key: "should-not-pass",
      }, 302, { location: "https://example.invalid" }),
      { ok: false, reason: "invalid_response" },
    ],
    [
      jsonResponse({
        error: 0,
        openid: "should-not-pass",
        session_key: "should-not-pass",
      }, 400),
      { ok: false, reason: "invalid_response" },
    ],
    [
      new Response("{invalid", { status: 200 }),
      { ok: false, reason: "invalid_response" },
    ],
    [
      jsonResponse({ error: 0, session_key: "missing-openid" }),
      { ok: false, reason: "invalid_response" },
    ],
    [
      jsonResponse({
        error: 0,
        openid: "openid",
        session_key: "session",
        unionid: 7,
      }),
      { ok: false, reason: "invalid_response" },
    ],
    [
      jsonResponse({ error: "0", openid: "openid", session_key: "session" }),
      { ok: false, reason: "invalid_response" },
    ],
  ];

  for (const [response, expected] of cases) {
    const actual = await douyinClient(async () => response).exchange(
      "one-time-code",
    );
    assert.deepEqual(actual, expected);
  }

  const oversized = await douyinClient(
    async () => jsonResponse({
      error: 0,
      openid: "x".repeat(100),
      session_key: "session",
    }),
    { maximumResponseBytes: 32 },
  ).exchange("one-time-code");
  assert.deepEqual(oversized, {
    ok: false,
    reason: "invalid_response",
  });
});

test("抖音 Client 区分网络错误与超时且不泄露敏感值", async () => {
  const code = "code-sensitive-canary";
  const secret = "secret-sensitive-canary";
  let calls = 0;
  const networkResult = await douyinClient(async (input) => {
    calls += 1;
    throw new Error(`network failed: ${String(input)}`);
  }, {
    secret,
  }).exchange(code);
  assert.deepEqual(networkResult, {
    ok: false,
    reason: "unavailable",
  });
  assert.equal(calls, 1);

  const timeoutResult = await douyinClient(
    async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error(`${code}:${secret}`));
      }, { once: true });
    }),
    {
      secret,
      timeoutMs: 5,
    },
  ).exchange(code);
  assert.deepEqual(timeoutResult, {
    ok: false,
    reason: "timeout",
  });

  const bodyTimeoutResult = await douyinClient(
    async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        // Keep the body pending until the request timeout cancels it.
      },
    })),
    {
      timeoutMs: 5,
    },
  ).exchange(code);
  assert.deepEqual(bodyTimeoutResult, {
    ok: false,
    reason: "timeout",
  });

  const serialized = JSON.stringify([
    networkResult,
    timeoutResult,
    bodyTimeoutResult,
  ]);
  assert.equal(serialized.includes(code), false);
  assert.equal(serialized.includes(secret), false);
});

test("微信 Client 使用统一结果并精确区分凭据、code 与限流", async () => {
  const requested: { url?: URL } = {};
  const success = await wechatClient(async (input, init) => {
    requested.url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    return jsonResponse({
      openid: "wechat-openid",
      unionid: "wechat-unionid",
      session_key: "wechat-session-key",
    });
  }).exchange("wechat-one-time-code");
  assert.deepEqual(success, {
    ok: true,
    provider: "wechat",
    providerAppId: "wx-app-id",
    subject: "wechat-openid",
    unionSubject: "wechat-unionid",
  });
  assert.ok(requested.url);
  assert.deepEqual(
    [...requested.url.searchParams.entries()],
    [
      ["appid", "wx-app-id"],
      ["secret", "wechat-secret-canary"],
      ["js_code", "wechat-one-time-code"],
      ["grant_type", "authorization_code"],
    ],
  );

  const expectations = new Map<number, string>([
    [-1, "unavailable"],
    [40_013, "invalid_credentials"],
    [40_125, "invalid_credentials"],
    [40_029, "invalid_code"],
    [40_163, "invalid_code"],
    [40_226, "invalid_code"],
    [45_011, "rate_limited"],
    [99_999, "invalid_response"],
  ]);
  for (const [errcode, reason] of expectations) {
    const result = await wechatClient(
      async () => jsonResponse({
        errcode,
        errmsg: "raw-wechat-message",
      }),
    ).exchange("wechat-one-time-code");
    assert.deepEqual(result, { ok: false, reason });
  }
});

test("客户端熔断彼此隔离且业务失败不累计故障", async () => {
  let nowMs = 1_000;
  let failingCalls = 0;
  const probeControl: {
    resolve?: (response: Response) => void;
  } = {};
  const failing = douyinClient(async () => {
    failingCalls += 1;
    if (nowMs >= 1_100) {
      return new Promise<Response>((resolve) => {
        probeControl.resolve = resolve;
      });
    }
    throw new Error("unavailable");
  }, {
    breakerThreshold: 2,
    breakerOpenMs: 100,
    now: () => nowMs,
  });
  assert.equal((await failing.exchange("code-1")).ok, false);
  assert.equal((await failing.exchange("code-2")).ok, false);
  assert.deepEqual(await failing.exchange("blocked"), {
    ok: false,
    reason: "circuit_open",
  });
  assert.equal(failingCalls, 2);

  const healthy = wechatClient(async () => jsonResponse({
    openid: "wechat-openid",
    session_key: "wechat-session",
  }), {
    breakerThreshold: 1,
    now: () => nowMs,
  });
  assert.equal((await healthy.exchange("healthy-code")).ok, true);

  nowMs += 100;
  const probe = failing.exchange("probe");
  assert.deepEqual(await failing.exchange("parallel"), {
    ok: false,
    reason: "circuit_open",
  });
  assert.ok(probeControl.resolve);
  probeControl.resolve(jsonResponse({
    error: 0,
    openid: "douyin-openid",
    session_key: "douyin-session",
  }));
  assert.deepEqual(await probe, {
    ok: true,
    provider: "douyin",
    providerAppId: "tt-app-id",
    subject: "douyin-openid",
    unionSubject: null,
  });

  let sequence = 0;
  const ignoredBusinessFailure = douyinClient(async () => {
    sequence += 1;
    if (sequence === 1 || sequence === 3) {
      throw new Error("fault");
    }
    return jsonResponse({ error: 40_018 });
  }, {
    breakerThreshold: 2,
  });
  assert.deepEqual(await ignoredBusinessFailure.exchange("first"), {
    ok: false,
    reason: "unavailable",
  });
  assert.deepEqual(await ignoredBusinessFailure.exchange("invalid-code"), {
    ok: false,
    reason: "invalid_code",
  });
  assert.deepEqual(await ignoredBusinessFailure.exchange("third"), {
    ok: false,
    reason: "unavailable",
  });
  assert.equal(sequence, 3);
});

test("普通 Provider 4xx 与抖音 40014 不开启熔断，真实故障仍开启", async () => {
  let parameterCalls = 0;
  const parameterError = douyinClient(async () => {
    parameterCalls += 1;
    return parameterCalls === 1
      ? jsonResponse({ error: 40_014 })
      : jsonResponse({
          error: 0,
          openid: "douyin-openid",
          session_key: "douyin-session",
        });
  }, {
    breakerThreshold: 1,
  });
  assert.deepEqual(await parameterError.exchange("parameter-error"), {
    ok: false,
    reason: "invalid_response",
  });
  assert.equal((await parameterError.exchange("next-code")).ok, true);
  assert.equal(parameterCalls, 2);

  let douyin4xxCalls = 0;
  const douyin4xx = douyinClient(async () => {
    douyin4xxCalls += 1;
    return douyin4xxCalls === 1
      ? jsonResponse({ error: 40_014 }, 400)
      : jsonResponse({
          error: 0,
          openid: "douyin-openid",
          session_key: "douyin-session",
        });
  }, {
    breakerThreshold: 1,
  });
  assert.deepEqual(await douyin4xx.exchange("http-400"), {
    ok: false,
    reason: "invalid_response",
  });
  assert.equal((await douyin4xx.exchange("next-code")).ok, true);
  assert.equal(douyin4xxCalls, 2);

  let wechat4xxCalls = 0;
  const wechat4xx = wechatClient(async () => {
    wechat4xxCalls += 1;
    return wechat4xxCalls === 1
      ? jsonResponse({}, 400)
      : jsonResponse({
          openid: "wechat-openid",
          session_key: "wechat-session",
        });
  }, {
    breakerThreshold: 1,
  });
  assert.deepEqual(await wechat4xx.exchange("http-400"), {
    ok: false,
    reason: "invalid_response",
  });
  assert.equal((await wechat4xx.exchange("next-code")).ok, true);
  assert.equal(wechat4xxCalls, 2);

  const breakerFailures: ReadonlyArray<Readonly<{
    response: Response;
    maximumResponseBytes?: number;
  }>> = [
    { response: jsonResponse({}, 503) },
    { response: new Response("{invalid") },
    {
      response: jsonResponse({
        error: 0,
        openid: "x".repeat(100),
        session_key: "session",
      }),
      maximumResponseBytes: 32,
    },
    { response: jsonResponse({ error: -1 }) },
  ];
  for (const failureCase of breakerFailures) {
    let calls = 0;
    const client = douyinClient(async () => {
      calls += 1;
      return failureCase.response;
    }, {
      breakerThreshold: 1,
      ...(failureCase.maximumResponseBytes === undefined
        ? {}
        : { maximumResponseBytes: failureCase.maximumResponseBytes }),
    });
    assert.equal((await client.exchange("fault")).ok, false);
    assert.deepEqual(await client.exchange("blocked"), {
      ok: false,
      reason: "circuit_open",
    });
    assert.equal(calls, 1);
  }
});
