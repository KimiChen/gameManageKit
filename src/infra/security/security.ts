import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

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
  ) {}

  allow(key: string): boolean {
    const nowMs = this.now();
    if (this.buckets.size >= 10_000 && nowMs - this.lastSweepMs >= 1_000) {
      this.sweep(nowMs);
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
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
