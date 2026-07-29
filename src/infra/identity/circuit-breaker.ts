export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  readonly threshold: number;
  readonly openMs: number;
  readonly now?: () => number;
}

export interface CircuitBreakerPermit {
  readonly mode: "closed" | "half_open";
  readonly epoch: number;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitBreakerState;
  readonly consecutiveFailures: number;
  readonly openUntilMs: number;
}

/**
 * A process-local consecutive-failure circuit breaker.
 *
 * Acquiring the half-open permit is synchronous, so only one request can
 * probe an expired open circuit even when many callers resume concurrently.
 */
export class CircuitBreaker {
  private readonly now: () => number;
  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openUntilMs = 0;
  private epoch = 0;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (
      !Number.isSafeInteger(options.threshold)
      || options.threshold < 1
      || !Number.isSafeInteger(options.openMs)
      || options.openMs < 1
    ) {
      throw new TypeError("熔断配置必须是正整数");
    }
    this.now = options.now ?? Date.now;
  }

  tryAcquire(): CircuitBreakerPermit | null {
    if (this.state === "open") {
      if (this.now() < this.openUntilMs) {
        return null;
      }
      this.state = "half_open";
      this.epoch += 1;
      return Object.freeze({
        mode: "half_open",
        epoch: this.epoch,
      });
    }
    if (this.state === "half_open") {
      return null;
    }
    return Object.freeze({
      mode: "closed",
      epoch: this.epoch,
    });
  }

  recordSuccess(permit: CircuitBreakerPermit): void {
    if (!this.isCurrent(permit)) {
      return;
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
    if (permit.mode === "half_open") {
      this.epoch += 1;
    }
  }

  recordFailure(permit: CircuitBreakerPermit): void {
    if (!this.isCurrent(permit)) {
      return;
    }
    if (permit.mode === "half_open") {
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.threshold) {
      this.open();
    }
  }

  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntilMs = 0;
    this.epoch += 1;
  }

  snapshot(): CircuitBreakerSnapshot {
    return Object.freeze({
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openUntilMs: this.openUntilMs,
    });
  }

  private isCurrent(permit: CircuitBreakerPermit): boolean {
    return permit.epoch === this.epoch
      && (
        (permit.mode === "closed" && this.state === "closed")
        || (
          permit.mode === "half_open"
          && this.state === "half_open"
        )
      );
  }

  private open(): void {
    this.state = "open";
    this.consecutiveFailures = 0;
    this.openUntilMs = this.now() + this.options.openMs;
    this.epoch += 1;
  }
}
