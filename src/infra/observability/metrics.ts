import type {
  ExternalAuthProvider,
  ProviderFailureReason,
} from "../../domain/account/auth-provider.js";
import { GAME_ID_PATTERN } from "../../domain/game/resolver.js";

export const LOGIN_OUTCOMES = [
  "success",
  "banned",
  "rate_limited",
  "invalid_code",
  "invalid_credentials",
  "timeout",
  "circuit_open",
  "provider_unavailable",
  "identity_conflict",
  "admission_denied",
  "internal_error",
] as const;

export const IDENTITY_PROVIDER_OUTCOMES = [
  "success",
  "invalid_code",
  "invalid_credentials",
  "rate_limited",
  "timeout",
  "circuit_open",
  "provider_error",
] as const;

export const AUDIT_TYPES = ["login", "admin"] as const;
export const RATE_LIMIT_SURFACES = ["login", "admin"] as const;
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
export type IdentityProviderOutcome =
  typeof IDENTITY_PROVIDER_OUTCOMES[number];
export type AuditType = typeof AUDIT_TYPES[number];
export type RateLimitSurface = typeof RATE_LIMIT_SURFACES[number];
export type DatabaseOperation = typeof DATABASE_OPERATIONS[number];

const LOGIN_OUTCOME_SET = new Set<string>(LOGIN_OUTCOMES);
const IDENTITY_PROVIDER_OUTCOME_SET = new Set<string>(
  IDENTITY_PROVIDER_OUTCOMES,
);
const EXTERNAL_PROVIDER_SET = new Set<string>(["wechat", "douyin"]);
const AUDIT_TYPE_SET = new Set<string>(AUDIT_TYPES);
const RATE_LIMIT_SURFACE_SET = new Set<string>(RATE_LIMIT_SURFACES);
const DATABASE_OPERATION_SET = new Set<string>(DATABASE_OPERATIONS);

interface DurationAggregate {
  count: number;
  sumSeconds: number;
}

function counterKey(...values: readonly string[]): string {
  return values.join("\u0000");
}

function splitCounterKey(key: string): readonly string[] {
  return key.split("\u0000");
}

function label(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

export function providerMetricOutcome(
  reason: ProviderFailureReason,
): IdentityProviderOutcome {
  switch (reason) {
    case "invalid_code":
    case "invalid_credentials":
    case "rate_limited":
    case "timeout":
    case "circuit_open":
      return reason;
    case "unavailable":
    case "invalid_response":
      return "provider_error";
  }
}

/**
 * A deliberately bounded in-process metrics registry.
 *
 * Every label other than a validated registry gameId is a closed TypeScript
 * union. AppIDs, subjects, login codes, tokens and other request input can
 * therefore never become metric labels.
 */
export class MetricsRegistry {
  private readonly gameIds: Set<string>;
  private readonly loginCounters = new Map<string, number>();
  private readonly rateLimitCounters = new Map<string, number>();
  private readonly providerCounters = new Map<string, number>();
  private readonly providerDurations = new Map<string, DurationAggregate>();
  private readonly databaseDurations = new Map<string, DurationAggregate>();
  private readonly sessionIssueFailures = new Map<string, number>();
  private readonly auditWriteFailures = new Map<string, number>();

  constructor(gameIds: readonly string[] = []) {
    this.gameIds = new Set(gameIds);
    for (const gameId of this.gameIds) {
      if (!GAME_ID_PATTERN.test(gameId)) {
        throw new Error(`指标拒绝非法 gameId: ${gameId}`);
      }
    }
  }

  registerGame(gameId: string): void {
    if (!GAME_ID_PATTERN.test(gameId)) {
      throw new Error(`指标拒绝非法 gameId: ${gameId}`);
    }
    this.gameIds.add(gameId);
  }

  recordLogin(gameId: string, outcome: LoginOutcome): void {
    this.increment(
      this.loginCounters,
      [gameId],
      outcome,
      LOGIN_OUTCOME_SET,
    );
  }

  recordRateLimit(gameId: string, surface: RateLimitSurface): void {
    this.increment(
      this.rateLimitCounters,
      [gameId],
      surface,
      RATE_LIMIT_SURFACE_SET,
    );
  }

  recordIdentityProvider(
    gameId: string,
    provider: ExternalAuthProvider,
    outcome: IdentityProviderOutcome,
  ): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(provider, EXTERNAL_PROVIDER_SET);
    this.assertBoundedLabel(outcome, IDENTITY_PROVIDER_OUTCOME_SET);
    const key = counterKey(gameId, provider, outcome);
    this.providerCounters.set(
      key,
      (this.providerCounters.get(key) ?? 0) + 1,
    );
  }

  recordIdentityProviderDuration(
    gameId: string,
    provider: ExternalAuthProvider,
    durationSeconds: number,
  ): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(provider, EXTERNAL_PROVIDER_SET);
    this.recordDuration(
      this.providerDurations,
      counterKey(gameId, provider),
      durationSeconds,
    );
  }

  recordSessionIssueFailure(gameId: string): void {
    this.assertKnownGame(gameId);
    this.sessionIssueFailures.set(
      gameId,
      (this.sessionIssueFailures.get(gameId) ?? 0) + 1,
    );
  }

  recordAuditWriteFailure(gameId: string, auditType: AuditType): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(auditType, AUDIT_TYPE_SET);
    const key = counterKey(gameId, auditType);
    this.auditWriteFailures.set(
      key,
      (this.auditWriteFailures.get(key) ?? 0) + 1,
    );
  }

  recordDatabaseDuration(
    gameId: string,
    operation: DatabaseOperation,
    durationSeconds: number,
  ): void {
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(operation, DATABASE_OPERATION_SET);
    this.recordDuration(
      this.databaseDurations,
      counterKey(gameId, operation),
      durationSeconds,
    );
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
      const durationSeconds =
        Number(process.hrtime.bigint() - started) / 1_000_000_000;
      this.recordDatabaseDuration(gameId, operation, durationSeconds);
    }
  }

  renderPrometheus(allowedGameIds: readonly string[]): string {
    const allowed = new Set(
      allowedGameIds.filter((gameId) => this.gameIds.has(gameId)),
    );
    const lines: string[] = [
      "# HELP game_manage_kit_login_attempts_total Login attempts by bounded outcome.",
      "# TYPE game_manage_kit_login_attempts_total counter",
    ];
    this.renderCounters(
      lines,
      this.loginCounters,
      allowed,
      "game_manage_kit_login_attempts_total",
      ["outcome"],
    );
    lines.push(
      "# HELP game_manage_kit_rate_limit_rejections_total Rejected requests by surface.",
      "# TYPE game_manage_kit_rate_limit_rejections_total counter",
    );
    this.renderCounters(
      lines,
      this.rateLimitCounters,
      allowed,
      "game_manage_kit_rate_limit_rejections_total",
      ["surface"],
    );
    lines.push(
      "# HELP game_manage_kit_identity_provider_requests_total Identity provider requests by bounded outcome.",
      "# TYPE game_manage_kit_identity_provider_requests_total counter",
    );
    this.renderCounters(
      lines,
      this.providerCounters,
      allowed,
      "game_manage_kit_identity_provider_requests_total",
      ["provider", "outcome"],
    );
    lines.push(
      "# HELP game_manage_kit_identity_provider_request_duration_seconds Identity provider request latency.",
      "# TYPE game_manage_kit_identity_provider_request_duration_seconds summary",
    );
    this.renderDurations(
      lines,
      this.providerDurations,
      allowed,
      "game_manage_kit_identity_provider_request_duration_seconds",
      ["provider"],
    );
    lines.push(
      "# HELP game_manage_kit_session_issue_failures_total Session issue failures.",
      "# TYPE game_manage_kit_session_issue_failures_total counter",
    );
    for (const [gameId, count] of [...this.sessionIssueFailures].sort()) {
      if (allowed.has(gameId)) {
        lines.push(
          `game_manage_kit_session_issue_failures_total{game_id="${label(gameId)}"} ${count}`,
        );
      }
    }
    lines.push(
      "# HELP game_manage_kit_audit_write_failures_total Audit write failures.",
      "# TYPE game_manage_kit_audit_write_failures_total counter",
    );
    this.renderCounters(
      lines,
      this.auditWriteFailures,
      allowed,
      "game_manage_kit_audit_write_failures_total",
      ["audit_type"],
    );
    lines.push(
      "# HELP game_manage_kit_database_operation_duration_seconds Database operation latency.",
      "# TYPE game_manage_kit_database_operation_duration_seconds summary",
    );
    this.renderDurations(
      lines,
      this.databaseDurations,
      allowed,
      "game_manage_kit_database_operation_duration_seconds",
      ["operation"],
    );
    return `${lines.join("\n")}\n`;
  }

  private increment(
    target: Map<string, number>,
    prefix: readonly string[],
    value: string,
    allowed: ReadonlySet<string>,
  ): void {
    const gameId = prefix[0] ?? "";
    this.assertKnownGame(gameId);
    this.assertBoundedLabel(value, allowed);
    const key = counterKey(...prefix, value);
    target.set(key, (target.get(key) ?? 0) + 1);
  }

  private recordDuration(
    target: Map<string, DurationAggregate>,
    key: string,
    durationSeconds: number,
  ): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return;
    }
    const current = target.get(key) ?? {
      count: 0,
      sumSeconds: 0,
    };
    current.count += 1;
    current.sumSeconds += durationSeconds;
    target.set(key, current);
  }

  private assertKnownGame(gameId: string): void {
    if (!this.gameIds.has(gameId)) {
      throw new Error(`指标拒绝未知 gameId: ${gameId}`);
    }
  }

  private assertBoundedLabel(
    value: string,
    allowed: ReadonlySet<string>,
  ): void {
    if (!allowed.has(value)) {
      throw new Error(`指标拒绝未定义 label 值: ${value}`);
    }
  }

  private renderCounters(
    lines: string[],
    counters: ReadonlyMap<string, number>,
    allowed: ReadonlySet<string>,
    metric: string,
    labelNames: readonly string[],
  ): void {
    for (const [key, count] of [...counters].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const [gameId = "", ...values] = splitCounterKey(key);
      if (!allowed.has(gameId)) {
        continue;
      }
      const labels = [
        `game_id="${label(gameId)}"`,
        ...labelNames.map(
          (name, index) => `${name}="${label(values[index] ?? "")}"`,
        ),
      ];
      lines.push(`${metric}{${labels.join(",")}} ${count}`);
    }
  }

  private renderDurations(
    lines: string[],
    durations: ReadonlyMap<string, DurationAggregate>,
    allowed: ReadonlySet<string>,
    metric: string,
    labelNames: readonly string[],
  ): void {
    for (const [key, aggregate] of [...durations].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const [gameId = "", ...values] = splitCounterKey(key);
      if (!allowed.has(gameId)) {
        continue;
      }
      const labels = [
        `game_id="${label(gameId)}"`,
        ...labelNames.map(
          (name, index) => `${name}="${label(values[index] ?? "")}"`,
        ),
      ].join(",");
      lines.push(
        `${metric}_sum{${labels}} ${aggregate.sumSeconds}`,
        `${metric}_count{${labels}} ${aggregate.count}`,
      );
    }
  }
}
