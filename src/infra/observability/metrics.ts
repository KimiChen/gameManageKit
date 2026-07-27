export const LOGIN_OUTCOMES = [
  "success",
  "banned",
  "rate_limited",
  "wx_invalid",
  "wx_rate_limited",
  "wx_unavailable",
] as const;

export const RATE_LIMIT_SURFACES = ["login", "admin"] as const;
export const WECHAT_OUTCOMES = ["success", "invalid", "rate_limited", "unavailable"] as const;
export const DATABASE_OPERATIONS = [
  "login",
  "session_verify",
  "session_lookup",
  "character_register",
  "character_lookup",
  "character_zones",
  "admin",
] as const;

export type LoginOutcome = typeof LOGIN_OUTCOMES[number];
export type RateLimitSurface = typeof RATE_LIMIT_SURFACES[number];
export type WechatOutcome = typeof WECHAT_OUTCOMES[number];
export type DatabaseOperation = typeof DATABASE_OPERATIONS[number];

const LOGIN_OUTCOME_SET = new Set<string>(LOGIN_OUTCOMES);
const RATE_LIMIT_SURFACE_SET = new Set<string>(RATE_LIMIT_SURFACES);
const WECHAT_OUTCOME_SET = new Set<string>(WECHAT_OUTCOMES);
const DATABASE_OPERATION_SET = new Set<string>(DATABASE_OPERATIONS);

interface DurationAggregate {
  count: number;
  sumSeconds: number;
}

function counterKey(gameId: string, value: string): string {
  return `${gameId}\u0000${value}`;
}

function splitCounterKey(key: string): readonly [string, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

/**
 * A deliberately bounded in-process metrics registry.
 *
 * Every label other than a validated registry gameId is a closed TypeScript
 * union. User ids, tokens, operation ids, IPs and other request input can
 * therefore never become metric labels.
 */
export class MetricsRegistry {
  private readonly gameIds: ReadonlySet<string>;
  private readonly loginCounters = new Map<string, number>();
  private readonly rateLimitCounters = new Map<string, number>();
  private readonly wechatCounters = new Map<string, number>();
  private readonly databaseDurations = new Map<string, DurationAggregate>();

  constructor(gameIds: readonly string[]) {
    this.gameIds = new Set(gameIds);
  }

  recordLogin(gameId: string, outcome: LoginOutcome): void {
    this.increment(this.loginCounters, gameId, outcome, LOGIN_OUTCOME_SET);
  }

  recordRateLimit(gameId: string, surface: RateLimitSurface): void {
    this.increment(this.rateLimitCounters, gameId, surface, RATE_LIMIT_SURFACE_SET);
  }

  recordWechat(gameId: string, outcome: WechatOutcome): void {
    this.increment(this.wechatCounters, gameId, outcome, WECHAT_OUTCOME_SET);
  }

  recordDatabaseDuration(
    gameId: string,
    operation: DatabaseOperation,
    durationSeconds: number,
  ): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(operation, DATABASE_OPERATION_SET);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return;
    }
    const key = counterKey(gameId, operation);
    const current = this.databaseDurations.get(key) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += durationSeconds;
    this.databaseDurations.set(key, current);
  }

  async measureDatabase<T>(
    gameId: string,
    operation: DatabaseOperation,
    callback: () => Promise<T>,
  ): Promise<T> {
    const started = process.hrtime.bigint();
    try {
      return await callback();
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.recordDatabaseDuration(gameId, operation, durationSeconds);
    }
  }

  renderPrometheus(allowedGameIds: readonly string[]): string {
    const allowed = new Set(allowedGameIds.filter((gameId) => this.gameIds.has(gameId)));
    const lines: string[] = [
      "# HELP game_manage_kit_login_attempts_total Login attempts by bounded outcome.",
      "# TYPE game_manage_kit_login_attempts_total counter",
    ];
    this.renderCounters(lines, this.loginCounters, allowed, "game_manage_kit_login_attempts_total", "outcome");
    lines.push(
      "# HELP game_manage_kit_rate_limit_rejections_total Rejected requests by surface.",
      "# TYPE game_manage_kit_rate_limit_rejections_total counter",
    );
    this.renderCounters(
      lines,
      this.rateLimitCounters,
      allowed,
      "game_manage_kit_rate_limit_rejections_total",
      "surface",
    );
    lines.push(
      "# HELP game_manage_kit_wechat_requests_total WeChat upstream results.",
      "# TYPE game_manage_kit_wechat_requests_total counter",
    );
    this.renderCounters(lines, this.wechatCounters, allowed, "game_manage_kit_wechat_requests_total", "outcome");
    lines.push(
      "# HELP game_manage_kit_database_operation_duration_seconds Database operation latency.",
      "# TYPE game_manage_kit_database_operation_duration_seconds summary",
    );
    for (const [key, aggregate] of [...this.databaseDurations].sort(([a], [b]) => a.localeCompare(b))) {
      const [gameId, operation] = splitCounterKey(key);
      if (!allowed.has(gameId)) {
        continue;
      }
      const labels = `game_id="${label(gameId)}",operation="${label(operation)}"`;
      lines.push(
        `game_manage_kit_database_operation_duration_seconds_sum{${labels}} ${aggregate.sumSeconds}`,
        `game_manage_kit_database_operation_duration_seconds_count{${labels}} ${aggregate.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private increment(
    target: Map<string, number>,
    gameId: string,
    value: string,
    allowed: ReadonlySet<string>,
  ): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(value, allowed);
    const key = counterKey(gameId, value);
    target.set(key, (target.get(key) ?? 0) + 1);
  }

  private assertKnownGame(gameId: string): void {
    if (!this.gameIds.has(gameId)) {
      throw new Error(`指标拒绝未知 gameId: ${gameId}`);
    }
  }

  private assertBoundedLabel(value: string, allowed: ReadonlySet<string>): void {
    if (!allowed.has(value)) {
      throw new Error(`指标拒绝未定义 label 值: ${value}`);
    }
  }

  private renderCounters(
    lines: string[],
    counters: ReadonlyMap<string, number>,
    allowed: ReadonlySet<string>,
    metric: string,
    labelName: string,
  ): void {
    for (const [key, count] of [...counters].sort(([a], [b]) => a.localeCompare(b))) {
      const [gameId, value] = splitCounterKey(key);
      if (!allowed.has(gameId)) {
        continue;
      }
      lines.push(
        `${metric}{game_id="${label(gameId)}",${labelName}="${label(value)}"} ${count}`,
      );
    }
  }
}
