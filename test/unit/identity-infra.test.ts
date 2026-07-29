import assert from "node:assert/strict";
import test from "node:test";
import {
  CircuitBreaker,
} from "../../src/infra/identity/circuit-breaker.js";
import {
  BoundedJsonError,
  readBoundedJsonObject,
} from "../../src/infra/identity/bounded-json.js";

test("熔断器达到阈值后开启并且半开只发放一个探针", () => {
  let nowMs = 1_000;
  const breaker = new CircuitBreaker({
    threshold: 2,
    openMs: 5_000,
    now: () => nowMs,
  });

  const first = breaker.tryAcquire();
  assert.ok(first);
  breaker.recordFailure(first);
  assert.deepEqual(breaker.snapshot(), {
    state: "closed",
    consecutiveFailures: 1,
    openUntilMs: 0,
  });

  const second = breaker.tryAcquire();
  assert.ok(second);
  breaker.recordFailure(second);
  assert.deepEqual(breaker.snapshot(), {
    state: "open",
    consecutiveFailures: 0,
    openUntilMs: 6_000,
  });
  assert.equal(breaker.tryAcquire(), null);

  nowMs = 6_000;
  const probe = breaker.tryAcquire();
  assert.deepEqual(probe, { mode: "half_open", epoch: 2 });
  assert.equal(breaker.tryAcquire(), null);
  assert.ok(probe);
  breaker.recordSuccess(probe);
  assert.equal(breaker.snapshot().state, "closed");
  assert.equal(breaker.tryAcquire()?.mode, "closed");
});

test("半开探针失败重新开启且 reset 忽略旧请求结果", () => {
  let nowMs = 100;
  const breaker = new CircuitBreaker({
    threshold: 1,
    openMs: 50,
    now: () => nowMs,
  });
  const initial = breaker.tryAcquire();
  assert.ok(initial);
  breaker.recordFailure(initial);

  nowMs = 150;
  const probe = breaker.tryAcquire();
  assert.ok(probe);
  breaker.recordFailure(probe);
  assert.equal(breaker.snapshot().state, "open");
  assert.equal(breaker.snapshot().openUntilMs, 200);

  breaker.reset();
  assert.equal(breaker.snapshot().state, "closed");
  breaker.recordFailure(probe);
  assert.deepEqual(breaker.snapshot(), {
    state: "closed",
    consecutiveFailures: 0,
    openUntilMs: 0,
  });
});

test("有界 JSON 读取器接受分块对象并拒绝非法或超大响应", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('{"error":0,'),
    encoder.encode('"openid":"subject"}'),
  ];
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  }));
  assert.deepEqual(await readBoundedJsonObject(response, 128), {
    error: 0,
    openid: "subject",
  });

  for (const invalid of [
    new Response(""),
    new Response("[]"),
    new Response("{invalid"),
    new Response(new Uint8Array([0xc3, 0x28])),
    new Response("{}", {
      headers: { "content-length": "invalid" },
    }),
    new Response("{}", {
      headers: { "content-length": "1000" },
    }),
    new Response('{"too":"large"}'),
  ]) {
    await assert.rejects(
      readBoundedJsonObject(invalid, 8),
      BoundedJsonError,
    );
  }
});
