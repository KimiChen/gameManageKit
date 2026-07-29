import type {
  AuthExchangeResult,
  IdentityProviderClient,
  ProviderFailureReason,
  ProviderRequestDurationRecorder,
} from "../../domain/account/auth-provider.js";
import {
  CircuitBreaker,
  type CircuitBreakerPermit,
} from "../identity/circuit-breaker.js";
import {
  DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES,
  discardResponseBody,
  readBoundedJsonObject,
} from "../identity/bounded-json.js";

export type WechatExchangeResult = AuthExchangeResult<"wechat">;

export interface WechatIdentityClient
  extends IdentityProviderClient<"wechat"> {
  readonly provider: "wechat";
}

export interface WechatClientOptions {
  readonly appId: string;
  readonly secret: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly breakerThreshold: number;
  readonly breakerOpenMs: number;
  readonly maximumResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface WechatAttempt {
  readonly result: WechatExchangeResult;
  readonly breakerFailure: boolean;
}

const INVALID_CREDENTIAL_CODES = new Set([40_013, 40_125]);
const INVALID_CODE_CODES = new Set([40_029, 40_163, 40_226]);
const RATE_LIMIT_CODES = new Set([45_011]);

function asciiValue(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && /^[\x21-\x7e]+$/u.test(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function elapsedMilliseconds(started: bigint): number {
  return Math.min(
    2_147_483_647,
    Math.max(
      0,
      Math.round(
        Number(process.hrtime.bigint() - started) / 1_000_000,
      ),
    ),
  );
}

function failure(reason: ProviderFailureReason): WechatExchangeResult {
  return { ok: false, reason };
}

function attempt(
  result: WechatExchangeResult,
  breakerFailure = !result.ok
    && (
      result.reason === "timeout"
      || result.reason === "unavailable"
      || result.reason === "invalid_response"
    ),
): WechatAttempt {
  return { result, breakerFailure };
}

export class WechatClient implements WechatIdentityClient {
  readonly provider = "wechat" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;
  private readonly maximumResponseBytes: number;

  constructor(private readonly options: WechatClientOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1
      || options.timeoutMs > 120_000
    ) {
      throw new TypeError("微信请求超时配置无效");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maximumResponseBytes = options.maximumResponseBytes
      ?? DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES;
    this.breaker = new CircuitBreaker({
      threshold: options.breakerThreshold,
      openMs: options.breakerOpenMs,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async exchange(
    code: string,
    recordRequestDuration?: ProviderRequestDurationRecorder,
  ): Promise<WechatExchangeResult> {
    if (!this.validConfiguration()) {
      return failure("invalid_credentials");
    }
    if (!asciiValue(code, 512)) {
      return failure("invalid_code");
    }
    const permit = this.breaker.tryAcquire();
    if (!permit) {
      return failure("circuit_open");
    }

    let current: WechatAttempt;
    let started: bigint | undefined;
    try {
      current = await this.request(code, () => {
        started = process.hrtime.bigint();
      });
    } catch {
      current = attempt(failure("unavailable"));
    } finally {
      if (started !== undefined) {
        recordRequestDuration?.(elapsedMilliseconds(started));
      }
    }
    this.settle(permit, current);
    return current.result;
  }

  resetCircuit(): void {
    this.breaker.reset();
  }

  private async request(
    code: string,
    requestStarted: () => void,
  ): Promise<WechatAttempt> {
    let url: URL;
    try {
      url = new URL(this.options.endpoint);
      url.searchParams.set("appid", this.options.appId);
      url.searchParams.set("secret", this.options.secret);
      url.searchParams.set("js_code", code);
      url.searchParams.set("grant_type", "authorization_code");
    } catch {
      return attempt(failure("invalid_response"));
    }

    const signal = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    requestStarted();
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        method: "GET",
        signal,
        redirect: "error",
      });
    } catch {
      return attempt(failure(signal.aborted ? "timeout" : "unavailable"));
    }

    if (response.status === 429) {
      await discardResponseBody(response);
      return attempt(failure("rate_limited"));
    }
    if (response.status >= 500 && response.status <= 599) {
      await discardResponseBody(response);
      return attempt(failure("unavailable"));
    }
    if (!response.ok) {
      await discardResponseBody(response);
      return attempt(
        failure("invalid_response"),
        response.status < 400 || response.status > 499,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await readBoundedJsonObject(
        response,
        this.maximumResponseBytes,
        signal,
      );
    } catch {
      return attempt(
        failure(signal.aborted ? "timeout" : "invalid_response"),
      );
    }
    return this.parse(body);
  }

  private parse(body: Record<string, unknown>): WechatAttempt {
    const errorCode = body.errcode === undefined
      ? 0
      : integer(body.errcode);
    if (errorCode === null) {
      return attempt(failure("invalid_response"));
    }
    if (errorCode !== 0) {
      if (errorCode === -1) {
        return attempt(failure("unavailable"));
      }
      if (INVALID_CREDENTIAL_CODES.has(errorCode)) {
        return attempt(failure("invalid_credentials"));
      }
      if (INVALID_CODE_CODES.has(errorCode)) {
        return attempt(failure("invalid_code"));
      }
      if (RATE_LIMIT_CODES.has(errorCode)) {
        return attempt(failure("rate_limited"));
      }
      return attempt(failure("invalid_response"));
    }

    if (
      !asciiValue(body.openid, 256)
      || !asciiValue(body.session_key, 512)
    ) {
      return attempt(failure("invalid_response"));
    }
    const unionSubject = body.unionid === undefined || body.unionid === ""
      ? null
      : asciiValue(body.unionid, 256)
        ? body.unionid
        : undefined;
    if (unionSubject === undefined) {
      return attempt(failure("invalid_response"));
    }
    return attempt({
      ok: true,
      provider: "wechat",
      providerAppId: this.options.appId,
      subject: body.openid,
      unionSubject,
    });
  }

  private settle(
    permit: CircuitBreakerPermit,
    current: WechatAttempt,
  ): void {
    if (current.breakerFailure) {
      this.breaker.recordFailure(permit);
      return;
    }
    this.breaker.recordSuccess(permit);
  }

  private validConfiguration(): boolean {
    return asciiValue(this.options.appId, 128)
      && typeof this.options.secret === "string"
      && this.options.secret.length > 0
      && this.options.secret.length <= 512;
  }
}
