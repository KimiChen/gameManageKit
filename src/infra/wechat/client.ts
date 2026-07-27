export type WechatExchangeResult =
  | { ok: true; openid: string; unionid: string | null; sessionKey: string }
  | { ok: false; reason: "wx_invalid" | "wx_rate_limited" | "wx_unavailable" };

export interface WechatIdentityClient {
  exchange(code: string): Promise<WechatExchangeResult>;
}

export interface WechatClientOptions {
  readonly appId: string;
  readonly secret: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly breakerThreshold: number;
  readonly breakerOpenMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function asciiIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[\x21-\x7e]+$/.test(value);
}

export class WechatClient implements WechatIdentityClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openUntilMs = 0;

  constructor(private readonly options: WechatClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async exchange(code: string): Promise<WechatExchangeResult> {
    if (this.now() < this.openUntilMs || !this.options.appId || !this.options.secret) {
      return { ok: false, reason: "wx_unavailable" };
    }
    const url = new URL(this.options.endpoint);
    url.searchParams.set("appid", this.options.appId);
    url.searchParams.set("secret", this.options.secret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    let body: Record<string, unknown>;
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      body = await response.json() as Record<string, unknown>;
    } catch {
      this.recordFailure();
      return { ok: false, reason: "wx_unavailable" };
    }

    const errorCode = Number(body.errcode ?? 0);
    if (errorCode !== 0) {
      if (errorCode === -1) {
        this.recordFailure();
        return { ok: false, reason: "wx_unavailable" };
      }
      this.recordSuccess();
      return {
        ok: false,
        reason: errorCode === 45011 ? "wx_rate_limited" : "wx_invalid",
      };
    }

    if (!asciiIdentity(body.openid) || !asciiIdentity(body.session_key)) {
      this.recordFailure();
      return { ok: false, reason: "wx_unavailable" };
    }
    this.recordSuccess();
    const unionid = asciiIdentity(body.unionid) && body.unionid.trim().length > 0
      ? body.unionid
      : null;
    return {
      ok: true,
      openid: body.openid,
      unionid,
      sessionKey: body.session_key,
    };
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.breakerThreshold) {
      this.openUntilMs = this.now() + this.options.breakerOpenMs;
      this.consecutiveFailures = 0;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }
}
