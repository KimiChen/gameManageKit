import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export interface SafeErrorDetails {
  readonly errorName: string;
  readonly errorCode?: string;
  readonly errorNumber?: number;
}

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const candidate = typeof error === "object" && error !== null
    ? error as { name?: unknown; code?: unknown; errno?: unknown }
    : {};
  const rawName = typeof candidate.name === "string" ? candidate.name : typeof error;
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : "UnknownError";
  const errorCode = typeof candidate.code === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  const rawNumber = Number(candidate.errno);
  const errorNumber = Number.isSafeInteger(rawNumber)
    ? rawNumber
    : undefined;
  return {
    errorName,
    ...(errorCode ? { errorCode } : {}),
    ...(errorNumber !== undefined ? { errorNumber } : {}),
  };
}

export function safeSecretEqual(actual: string | null | undefined, expected: string | null | undefined): boolean {
  return Boolean(actual && expected) && timingSafeEqual(digest(actual ?? ""), digest(expected ?? ""));
}

export function matchesAnySecret(actual: string | null | undefined, expected: readonly string[]): boolean {
  let matched = false;
  for (const candidate of expected) {
    matched = safeSecretEqual(actual, candidate) || matched;
  }
  return matched;
}

export function normalizeIp(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const input = value.trim();
  if (!input || input.includes("%")) {
    return null;
  }
  if (isIP(input) !== 0) {
    return input;
  }
  const ipv6WithPort = /^\[(.+)\]:\d{1,5}$/.exec(input);
  if (ipv6WithPort?.[1] && isIP(ipv6WithPort[1]) !== 0) {
    return ipv6WithPort[1];
  }
  const ipv4WithPort = /^([^:]+):\d{1,5}$/.exec(input);
  if (ipv4WithPort?.[1] && isIP(ipv4WithPort[1]) !== 0) {
    return ipv4WithPort[1];
  }
  return null;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastMs: number }>();
  private lastSweepMs = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly maximumBuckets = 10_000,
  ) {}

  allow(key: string): boolean {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (
        this.buckets.size >= this.maximumBuckets
        && nowMs - this.lastSweepMs >= 1_000
      ) {
        this.sweep(nowMs);
      }
      if (this.buckets.size >= this.maximumBuckets) {
        return false;
      }
      bucket = { tokens: this.capacity, lastMs: nowMs };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((nowMs - bucket.lastMs) / 1_000) * this.refillPerSecond,
    );
    bucket.lastMs = nowMs;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  private sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + ((nowMs - bucket.lastMs) / 1_000) * this.refillPerSecond;
      if (refilled >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}
