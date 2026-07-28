import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import {
  hashAdminPassword,
  validateAdminPassword,
  verifyAdminPassword,
} from "../../infra/security/admin-password.js";
import {
  normalizeIp,
  TokenBucketLimiter,
} from "../../infra/security/security.js";

export const ADMIN_SESSION_TOKEN_BYTES = 32;
export const ADMIN_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1_000;
export const ADMIN_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;
export const ADMIN_SESSION_ELEVATED_TTL_MS = 5 * 60 * 1_000;

const ADMIN_SESSION_TOKEN_LENGTH = 43;
const SESSION_INSERT_ATTEMPTS = 3;
const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
const DUMMY_PASSWORD = "gmk dummy password work factor";
const DUMMY_PASSWORD_HASH =
  "gmk-scrypt$v=1$N=65536,r=8,p=2$AAAAAAAAAAAAAAAAAAAAAA$"
  + "dGoi6zHOWUhvuRTVpl1Axw4PVgyCnalsKEhok3xHfjs";

type AuthExecutor = Pick<Pool | PoolConnection, "execute">;

interface OperatorRow extends RowDataPacket {
  operator_id: string;
  display_name: string;
  password_hash: string;
  status: string;
  auth_version: number | string;
  can_manage_games: number | boolean | string;
  can_manage_integrations: number | boolean | string;
  can_rotate_secrets: number | boolean | string;
  can_manage_machine_identities: number | boolean | string;
}

interface SessionLookupRow extends RowDataPacket {
  operator_id: string;
}

interface SessionRow extends RowDataPacket {
  operator_id: string;
  auth_version: number | string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  elevated_until: Date | string | null;
}

interface AccessRow extends RowDataPacket {
  game_id: string;
  can_operate_accounts: number | boolean | string;
  name: string;
  status: string;
  configuration_state: string;
}

interface ExpiredSessionRow extends RowDataPacket {
  token_hash: Buffer;
  operator_id: string;
  absolute_expired: number | boolean | string;
  idle_expired: number | boolean | string;
}

interface BootstrapLatchRow extends RowDataPacket {
  initialized: number | boolean | string;
  operator_exists?: number | boolean | string;
}

interface AnyOperatorRow extends RowDataPacket {
  operator_id: string;
}

export interface AdminAuthDatabase {
  readonly pool: Pool;
  transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T>;
}

export interface AdminGameAccess {
  readonly gameId: string;
  readonly name: string;
  readonly status: "enabled" | "maintenance" | "disabled";
  readonly configurationState: "draft" | "configured";
  readonly canOperateAccounts: boolean;
}

export interface AdminSessionIdentity {
  readonly operatorId: string;
  readonly displayName: string;
  readonly authVersion: number;
  readonly canManageGames: boolean;
  readonly canManageIntegrations: boolean;
  readonly canRotateSecrets: boolean;
  readonly canManageMachineIdentities: boolean;
  readonly games: readonly AdminGameAccess[];
  /** The non-rolling, absolute session expiry exposed to the browser. */
  readonly expiresAt: string;
  /** Active recent-authentication window; null when reauthentication is needed. */
  readonly elevatedUntil: string | null;
}

export interface IssuedAdminSession extends AdminSessionIdentity {
  readonly sessionToken: string;
}

export interface AdminLoginInput {
  readonly operatorId: string;
  readonly password: string;
  readonly ip: string | null;
}

export interface AdminBootstrapInput {
  readonly operatorId: string;
  readonly displayName: string;
  readonly password: string;
  readonly ip: string | null;
}

export type AdminLoginLimitReason =
  | "rate_limited_ip"
  | "rate_limited_operator"
  | "rate_limited_operator_ip";

export type AdminScryptPermit =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false };

export interface AdminLoginProtection {
  checkRateLimit(operatorId: string, ip: string | null): AdminLoginLimitReason | null;
  acquireScrypt(): AdminScryptPermit;
}

export interface AdminLoginProtectionOptions {
  readonly ipCapacity?: number;
  readonly ipRefillPerSecond?: number;
  readonly operatorCapacity?: number;
  readonly operatorRefillPerSecond?: number;
  readonly operatorIpCapacity?: number;
  readonly operatorIpRefillPerSecond?: number;
  readonly maximumBuckets?: number;
  readonly maximumConcurrentScrypt?: number;
  readonly now?: () => number;
}

/**
 * Process-local first line of defence. A shared reverse-proxy/distributed
 * limiter is still required when multiple application instances are exposed.
 */
export class DefaultAdminLoginProtection implements AdminLoginProtection {
  private readonly ipLimiter: TokenBucketLimiter;
  private readonly operatorLimiter: TokenBucketLimiter;
  private readonly operatorIpLimiter: TokenBucketLimiter;
  private readonly maximumConcurrentScrypt: number;
  private activeScrypt = 0;

  constructor(options: AdminLoginProtectionOptions = {}) {
    const maximumBuckets = options.maximumBuckets ?? 10_000;
    this.maximumConcurrentScrypt = options.maximumConcurrentScrypt ?? 2;
    if (
      !Number.isSafeInteger(this.maximumConcurrentScrypt)
      || this.maximumConcurrentScrypt < 1
    ) {
      throw new TypeError("管理员 scrypt 并发上限必须为正整数");
    }
    this.ipLimiter = new TokenBucketLimiter(
      options.ipCapacity ?? 20,
      options.ipRefillPerSecond ?? (20 / 60),
      options.now,
      maximumBuckets,
    );
    this.operatorLimiter = new TokenBucketLimiter(
      options.operatorCapacity ?? 20,
      options.operatorRefillPerSecond ?? (20 / 300),
      options.now,
      maximumBuckets,
    );
    this.operatorIpLimiter = new TokenBucketLimiter(
      options.operatorIpCapacity ?? 5,
      options.operatorIpRefillPerSecond ?? (5 / 300),
      options.now,
      maximumBuckets,
    );
  }

  checkRateLimit(
    operatorId: string,
    ip: string | null,
  ): AdminLoginLimitReason | null {
    const ipKey = normalizeIp(ip) ?? "unknown";
    if (!this.ipLimiter.allow(ipKey)) {
      return "rate_limited_ip";
    }
    const operatorKey = normalizeAdminOperatorId(operatorId) ?? "invalid";
    if (!this.operatorLimiter.allow(operatorKey)) {
      return "rate_limited_operator";
    }
    if (!this.operatorIpLimiter.allow(`${operatorKey}\0${ipKey}`)) {
      return "rate_limited_operator_ip";
    }
    return null;
  }

  acquireScrypt(): AdminScryptPermit {
    if (this.activeScrypt >= this.maximumConcurrentScrypt) {
      return { ok: false };
    }
    this.activeScrypt += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.activeScrypt -= 1;
        }
      },
    };
  }
}

export interface AdminAuthServiceOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly hashPassword?: (password: string) => Promise<string>;
  readonly verifyPassword?: (
    password: string,
    storedHash: string,
  ) => Promise<boolean>;
  readonly loginProtection?: AdminLoginProtection;
  readonly absoluteTtlMs?: number;
  readonly idleTtlMs?: number;
  readonly elevatedTtlMs?: number;
  readonly protectionAuditMaximumBuckets?: number;
}

type AuthAuditEvent =
  | "operator_created"
  | "bootstrap_failure"
  | "login_success"
  | "login_failure"
  | "reauthentication_success"
  | "reauthentication_failure"
  | "logout"
  | "session_expired"
  | "session_invalidated";

type AuthAuditReason =
  | "web_bootstrap"
  | "invalid_credentials"
  | AdminLoginLimitReason
  | "scrypt_capacity"
  | "operator_changed"
  | "session_invalid"
  | "absolute_timeout"
  | "idle_timeout"
  | "operator_disabled"
  | "auth_version_changed"
  | "logout";

interface AuthAuditInput {
  readonly operatorId: string | null;
  readonly event: AuthAuditEvent;
  readonly reason: AuthAuditReason | null;
  readonly ip: string | null;
}

function normalizedPositiveDuration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new TypeError(`${name} 必须为正整数毫秒`);
  }
  return duration;
}

function wellFormedUnicodeLength(value: string): number | null {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return null;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
    length += 1;
  }
  return length;
}

function normalizeAdminDisplayName(value: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const length = wellFormedUnicodeLength(normalized);
  return length !== null && length >= 1 && length <= 128
    ? normalized
    : null;
}

export function normalizeAdminOperatorId(value: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return OPERATOR_ID_PATTERN.test(normalized) ? normalized : null;
}

export function parseAdminSessionToken(value: string): Buffer | null {
  if (
    typeof value !== "string"
    || value.length !== ADMIN_SESSION_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== ADMIN_SESSION_TOKEN_BYTES
    || decoded.toString("base64url") !== value
  ) {
    return null;
  }
  return decoded;
}

export function hashAdminSessionToken(value: string): Buffer | null {
  return parseAdminSessionToken(value)
    ? createHash("sha256").update(value, "utf8").digest()
    : null;
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function authVersion(value: number | string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function enabled(row: OperatorRow | undefined): row is OperatorRow {
  return row?.status === "enabled" && authVersion(row.auth_version) !== null;
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

async function insertAuthAudit(
  executor: AuthExecutor,
  input: AuthAuditInput,
): Promise<void> {
  await executor.execute<ResultSetHeader>(
    `INSERT INTO admin_auth_audit
       (operator_id, event, reason, ip)
     VALUES (?, ?, ?, INET6_ATON(?))`,
    [
      input.operatorId,
      input.event,
      input.reason,
      normalizeIp(input.ip),
    ],
  );
}

function identityFrom(
  operator: OperatorRow,
  accessRows: readonly AccessRow[],
  expiresAt: Date,
  elevatedUntil: Date | null,
): AdminSessionIdentity {
  const version = authVersion(operator.auth_version);
  if (version === null) {
    throw new Error("管理员 auth_version 数据无效");
  }
  return {
    operatorId: operator.operator_id,
    displayName: operator.display_name,
    authVersion: version,
    canManageGames: Number(operator.can_manage_games) === 1,
    canManageIntegrations: Number(operator.can_manage_integrations) === 1,
    canRotateSecrets: Number(operator.can_rotate_secrets) === 1,
    canManageMachineIdentities:
      Number(operator.can_manage_machine_identities) === 1,
    games: accessRows.map((row) => ({
      gameId: row.game_id,
      name: row.name,
      status: row.status as AdminGameAccess["status"],
      configurationState:
        row.configuration_state as AdminGameAccess["configurationState"],
      canOperateAccounts: Number(row.can_operate_accounts) === 1,
    })),
    expiresAt: expiresAt.toISOString(),
    elevatedUntil: elevatedUntil?.toISOString() ?? null,
  };
}

export function requireAdminGameAccess(
  identity: AdminSessionIdentity,
  gameId: string,
): AdminGameAccess {
  const access = identity.games.find((candidate) => candidate.gameId === gameId);
  if (!access) {
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
  return access;
}

export function requireAdminAccountCapability(
  identity: AdminSessionIdentity,
  gameId: string,
): void {
  if (!requireAdminGameAccess(identity, gameId).canOperateAccounts) {
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
}

export function requireAdminGameManagement(
  identity: Pick<AdminSessionIdentity, "canManageGames">,
): void {
  if (!identity.canManageGames) {
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
}

export class AdminAuthService {
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly hashPassword: (password: string) => Promise<string>;
  private readonly verifyPassword: (
    password: string,
    storedHash: string,
  ) => Promise<boolean>;
  private readonly loginProtection: AdminLoginProtection;
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly elevatedTtlMs: number;
  private readonly protectionAuditLimiter: TokenBucketLimiter;

  constructor(
    private readonly database: AdminAuthDatabase,
    options: AdminAuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.hashPassword = options.hashPassword ?? hashAdminPassword;
    this.verifyPassword = options.verifyPassword ?? verifyAdminPassword;
    this.loginProtection = options.loginProtection
      ?? new DefaultAdminLoginProtection();
    this.absoluteTtlMs = normalizedPositiveDuration(
      options.absoluteTtlMs,
      ADMIN_SESSION_ABSOLUTE_TTL_MS,
      "管理员会话绝对 TTL",
    );
    this.idleTtlMs = normalizedPositiveDuration(
      options.idleTtlMs,
      ADMIN_SESSION_IDLE_TTL_MS,
      "管理员会话空闲 TTL",
    );
    this.elevatedTtlMs = normalizedPositiveDuration(
      options.elevatedTtlMs,
      ADMIN_SESSION_ELEVATED_TTL_MS,
      "管理员提升会话 TTL",
    );
    if (this.idleTtlMs > this.absoluteTtlMs) {
      throw new TypeError("管理员会话空闲 TTL 不得超过绝对 TTL");
    }
    if (this.elevatedTtlMs > this.absoluteTtlMs) {
      throw new TypeError("管理员提升会话 TTL 不得超过绝对 TTL");
    }
    this.protectionAuditLimiter = new TokenBucketLimiter(
      1,
      1 / 60,
      () => this.currentTime().getTime(),
      options.protectionAuditMaximumBuckets ?? 10_000,
    );
  }

  async bootstrapRequired(): Promise<boolean> {
    const [rows] = await this.database.pool.query<BootstrapLatchRow[]>(
      `SELECT l.initialized,
              EXISTS(
                SELECT 1
                  FROM admin_operators
                 LIMIT 1
              ) AS operator_exists
         FROM admin_bootstrap_latch AS l
        WHERE l.latch_id = 1`,
    );
    const initialized = Number(rows[0]?.initialized);
    const operatorExists = Number(rows[0]?.operator_exists);
    if (
      rows.length !== 1
      || (initialized !== 0 && initialized !== 1)
      || (operatorExists !== 0 && operatorExists !== 1)
    ) {
      throw new Error("管理员引导锁存器数据无效");
    }
    return initialized === 0 && operatorExists === 0;
  }

  async bootstrap(input: AdminBootstrapInput): Promise<IssuedAdminSession> {
    const operatorId = normalizeAdminOperatorId(input.operatorId);
    const displayName = normalizeAdminDisplayName(input.displayName);
    if (!operatorId || !displayName) {
      throw new GameManageKitError(400, "INVALID_PAYLOAD");
    }
    try {
      validateAdminPassword(input.password);
    } catch {
      throw new GameManageKitError(400, "INVALID_PAYLOAD");
    }
    const ip = normalizeIp(input.ip);

    const available = await this.database.transaction(
      (connection) => this.lockAvailableBootstrap(connection),
    );
    if (!available) {
      throw new GameManageKitError(409, "ADMIN_ALREADY_INITIALIZED");
    }

    const limited = this.loginProtection.checkRateLimit(operatorId, ip);
    if (limited) {
      await this.auditProtectionFailure({
        operatorId,
        event: "bootstrap_failure",
        reason: limited,
        ip,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }
    const permit = this.loginProtection.acquireScrypt();
    if (!permit.ok) {
      await this.auditProtectionFailure({
        operatorId,
        event: "bootstrap_failure",
        reason: "scrypt_capacity",
        ip,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }

    let passwordHash: string;
    try {
      passwordHash = await this.hashPassword(input.password);
    } finally {
      permit.release();
    }

    const issued = await this.database.transaction(async (connection) => {
      if (!await this.lockAvailableBootstrap(connection)) {
        return null;
      }

      await connection.execute<ResultSetHeader>(
        `INSERT INTO admin_operators
           (operator_id, display_name, password_hash, status, auth_version,
            can_manage_games, can_manage_integrations, can_rotate_secrets,
            can_manage_machine_identities)
         VALUES (?, ?, ?, 'enabled', 1, 1, 1, 1, 1)`,
        [operatorId, displayName, passwordHash],
      );

      const now = this.currentTime();
      await this.completeBootstrapLatch(connection, operatorId, now);

      const operator = {
        operator_id: operatorId,
        display_name: displayName,
        password_hash: passwordHash,
        status: "enabled",
        auth_version: 1,
        can_manage_games: 1,
        can_manage_integrations: 1,
        can_rotate_secrets: 1,
        can_manage_machine_identities: 1,
      } as OperatorRow;
      const expiresAt = new Date(now.getTime() + this.absoluteTtlMs);
      const sessionToken = await this.insertUniqueSession(
        connection,
        operator,
        now,
        expiresAt,
      );
      await insertAuthAudit(connection, {
        operatorId,
        event: "operator_created",
        reason: "web_bootstrap",
        ip,
      });
      return {
        ...identityFrom(operator, [], expiresAt, null),
        sessionToken,
      };
    });
    if (!issued) {
      throw new GameManageKitError(409, "ADMIN_ALREADY_INITIALIZED");
    }
    return issued;
  }

  async login(input: AdminLoginInput): Promise<IssuedAdminSession> {
    const operatorId = normalizeAdminOperatorId(input.operatorId);
    const ip = normalizeIp(input.ip);
    const limited = this.loginProtection.checkRateLimit(
      operatorId ?? input.operatorId,
      ip,
    );
    if (limited) {
      await this.auditProtectionFailure({
        operatorId,
        event: "login_failure",
        reason: limited,
        ip,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }

    const permit = this.loginProtection.acquireScrypt();
    if (!permit.ok) {
      await this.auditProtectionFailure({
        operatorId,
        event: "login_failure",
        reason: "scrypt_capacity",
        ip,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }

    let operator: OperatorRow | undefined;
    let passwordWellFormed = true;
    let passwordMatches = false;
    try {
      operator = operatorId
        ? await this.findOperator(this.database.pool, operatorId, false)
        : undefined;
      try {
        validateAdminPassword(input.password);
      } catch {
        passwordWellFormed = false;
      }
      const passwordForWork = passwordWellFormed
        ? input.password
        : DUMMY_PASSWORD;
      const hashForWork = enabled(operator)
        ? operator.password_hash
        : DUMMY_PASSWORD_HASH;
      passwordMatches = await this.verifyPassword(passwordForWork, hashForWork);
    } finally {
      permit.release();
    }

    if (!enabled(operator) || !passwordWellFormed || !passwordMatches) {
      await insertAuthAudit(this.database.pool, {
        operatorId,
        event: "login_failure",
        reason: "invalid_credentials",
        ip,
      });
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }

    const expectedAuthVersion = authVersion(operator.auth_version);
    if (expectedAuthVersion === null) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    const issued = await this.database.transaction(async (connection) => {
      // All authentication transactions lock in the same order:
      // administrator first, then an existing/new session.
      const locked = await this.findOperator(connection, operator.operator_id, true);
      if (
        !enabled(locked)
        || authVersion(locked.auth_version) !== expectedAuthVersion
        || locked.password_hash !== operator.password_hash
      ) {
        await insertAuthAudit(connection, {
          operatorId: operator.operator_id,
          event: "login_failure",
          reason: "operator_changed",
          ip,
        });
        return null;
      }

      const now = this.currentTime();
      const expiresAt = new Date(now.getTime() + this.absoluteTtlMs);
      const token = await this.insertUniqueSession(
        connection,
        locked,
        now,
        expiresAt,
      );
      const access = await this.findAccess(connection, locked.operator_id);
      await insertAuthAudit(connection, {
        operatorId: locked.operator_id,
        event: "login_success",
        reason: null,
        ip,
      });
      return {
        ...identityFrom(locked, access, expiresAt, null),
        sessionToken: token,
      };
    });

    if (!issued) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    return issued;
  }

  async reauthenticate(
    sessionToken: string,
    password: string,
    ip: string | null = null,
  ): Promise<AdminSessionIdentity> {
    const tokenHash = hashAdminSessionToken(sessionToken);
    const normalizedIp = normalizeIp(ip);
    let operatorId: string | null = null;
    if (tokenHash) {
      const [lookupRows] = await this.database.pool.query<SessionLookupRow[]>(
        "SELECT operator_id FROM admin_sessions WHERE token_hash = ?",
        [tokenHash],
      );
      operatorId = lookupRows[0]?.operator_id ?? null;
    }

    const limited = this.loginProtection.checkRateLimit(
      operatorId ?? "invalid",
      normalizedIp,
    );
    if (limited) {
      await this.auditProtectionFailure({
        operatorId,
        event: "reauthentication_failure",
        reason: limited,
        ip: normalizedIp,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }
    const permit = this.loginProtection.acquireScrypt();
    if (!permit.ok) {
      await this.auditProtectionFailure({
        operatorId,
        event: "reauthentication_failure",
        reason: "scrypt_capacity",
        ip: normalizedIp,
      });
      throw new GameManageKitError(429, "RATE_LIMITED");
    }

    let operator: OperatorRow | undefined;
    let passwordWellFormed = true;
    let passwordMatches = false;
    try {
      operator = operatorId
        ? await this.findOperator(this.database.pool, operatorId, false)
        : undefined;
      try {
        validateAdminPassword(password);
      } catch {
        passwordWellFormed = false;
      }
      passwordMatches = await this.verifyPassword(
        passwordWellFormed ? password : DUMMY_PASSWORD,
        enabled(operator) ? operator.password_hash : DUMMY_PASSWORD_HASH,
      );
    } finally {
      permit.release();
    }

    if (
      !tokenHash
      || !operatorId
      || !enabled(operator)
      || !passwordWellFormed
      || !passwordMatches
    ) {
      await insertAuthAudit(this.database.pool, {
        operatorId,
        event: "reauthentication_failure",
        reason: "invalid_credentials",
        ip: normalizedIp,
      });
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }

    const expectedAuthVersion = authVersion(operator.auth_version);
    if (expectedAuthVersion === null) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    const identity = await this.database.transaction(async (connection) => {
      const locked = await this.findOperator(connection, operatorId, true);
      if (
        !enabled(locked)
        || authVersion(locked.auth_version) !== expectedAuthVersion
        || locked.password_hash !== operator.password_hash
      ) {
        await insertAuthAudit(connection, {
          operatorId,
          event: "reauthentication_failure",
          reason: "operator_changed",
          ip: normalizedIp,
        });
        return null;
      }

      const [sessionRows] = await connection.query<SessionRow[]>(
        `SELECT operator_id, auth_version, created_at, last_seen_at, expires_at,
                elevated_until
           FROM admin_sessions
          WHERE token_hash = ?
          FOR UPDATE`,
        [tokenHash],
      );
      const session = sessionRows[0];
      const now = this.currentTime();
      const absoluteExpiry = dateValue(session?.expires_at);
      const lastSeenAt = dateValue(session?.last_seen_at);
      const sessionAuthVersion = authVersion(session?.auth_version ?? 0);
      const absoluteExpired = absoluteExpiry
        ? now.getTime() >= absoluteExpiry.getTime()
        : true;
      const idleExpired = lastSeenAt
        ? now.getTime() - lastSeenAt.getTime() >= this.idleTtlMs
        : true;
      const sessionInvalid = !session
        || session.operator_id !== operatorId
        || sessionAuthVersion !== expectedAuthVersion
        || !absoluteExpiry
        || !lastSeenAt;
      if (
        sessionInvalid
        || absoluteExpired
        || idleExpired
      ) {
        if (session?.operator_id === operatorId) {
          await this.deleteSession(connection, tokenHash);
        }
        await insertAuthAudit(connection, {
          operatorId,
          event: "reauthentication_failure",
          reason: sessionInvalid
            ? "session_invalid"
            : absoluteExpired
              ? "absolute_timeout"
              : "idle_timeout",
          ip: normalizedIp,
        });
        return null;
      }

      const elevatedUntil = new Date(Math.min(
        now.getTime() + this.elevatedTtlMs,
        absoluteExpiry.getTime(),
      ));
      await connection.execute<ResultSetHeader>(
        `UPDATE admin_sessions
            SET last_seen_at = ?, elevated_until = ?
          WHERE token_hash = ?`,
        [now, elevatedUntil, tokenHash],
      );
      const access = await this.findAccess(connection, operatorId);
      await insertAuthAudit(connection, {
        operatorId,
        event: "reauthentication_success",
        reason: null,
        ip: normalizedIp,
      });
      return identityFrom(locked, access, absoluteExpiry, elevatedUntil);
    });

    if (!identity) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    return identity;
  }

  private async auditProtectionFailure(input: AuthAuditInput): Promise<void> {
    const ip = normalizeIp(input.ip) ?? "unknown";
    const operatorId = input.operatorId ?? "invalid";
    const key = input.reason === "rate_limited_ip"
      ? `${input.reason}\0${ip}`
      : input.reason === "rate_limited_operator"
        ? `${input.reason}\0${operatorId}`
        : input.reason === "rate_limited_operator_ip"
          ? `${input.reason}\0${operatorId}\0${ip}`
          : String(input.reason);
    if (this.protectionAuditLimiter.allow(key)) {
      await insertAuthAudit(this.database.pool, input);
    }
  }

  async authenticate(
    sessionToken: string,
    ip: string | null = null,
  ): Promise<AdminSessionIdentity> {
    const tokenHash = hashAdminSessionToken(sessionToken);
    if (!tokenHash) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }

    // This is a non-locking locator read. The transaction below always takes
    // the authoritative operator lock before the session lock.
    const [lookupRows] = await this.database.pool.query<SessionLookupRow[]>(
      "SELECT operator_id FROM admin_sessions WHERE token_hash = ?",
      [tokenHash],
    );
    const operatorId = lookupRows[0]?.operator_id;
    if (!operatorId) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }

    const result = await this.database.transaction(async (connection) => {
      const operator = await this.findOperator(connection, operatorId, true);
      const [sessionRows] = await connection.query<SessionRow[]>(
        `SELECT operator_id, auth_version, created_at, last_seen_at, expires_at,
                elevated_until
           FROM admin_sessions
          WHERE token_hash = ?
          FOR UPDATE`,
        [tokenHash],
      );
      const session = sessionRows[0];
      if (!session || session.operator_id !== operatorId) {
        return null;
      }

      const now = this.currentTime();
      const absoluteExpiry = dateValue(session.expires_at);
      const lastSeenAt = dateValue(session.last_seen_at);
      const elevatedUntil = dateValue(session.elevated_until);
      const sessionAuthVersion = authVersion(session.auth_version);
      if (
        !absoluteExpiry
        || !lastSeenAt
        || sessionAuthVersion === null
        || (session.elevated_until !== null && !elevatedUntil)
      ) {
        await this.deleteSession(connection, tokenHash);
        await insertAuthAudit(connection, {
          operatorId,
          event: "session_invalidated",
          reason: "auth_version_changed",
          ip,
        });
        return null;
      }

      const absoluteExpired = now.getTime() >= absoluteExpiry.getTime();
      const idleExpired =
        now.getTime() - lastSeenAt.getTime() >= this.idleTtlMs;
      if (absoluteExpired || idleExpired) {
        await this.deleteSession(connection, tokenHash);
        await insertAuthAudit(connection, {
          operatorId,
          event: "session_expired",
          reason: absoluteExpired ? "absolute_timeout" : "idle_timeout",
          ip,
        });
        return null;
      }

      if (!enabled(operator)) {
        await this.deleteSession(connection, tokenHash);
        await insertAuthAudit(connection, {
          operatorId,
          event: "session_invalidated",
          reason: "operator_disabled",
          ip,
        });
        return null;
      }
      if (authVersion(operator.auth_version) !== sessionAuthVersion) {
        await this.deleteSession(connection, tokenHash);
        await insertAuthAudit(connection, {
          operatorId,
          event: "session_invalidated",
          reason: "auth_version_changed",
          ip,
        });
        return null;
      }

      await connection.execute<ResultSetHeader>(
        "UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?",
        [now, tokenHash],
      );
      // Access rows are deliberately fetched on every request. The session
      // contains no cached authorization grants.
      const access = await this.findAccess(connection, operator.operator_id);
      return identityFrom(
        operator,
        access,
        absoluteExpiry,
        elevatedUntil && now.getTime() < elevatedUntil.getTime()
          ? elevatedUntil
          : null,
      );
    });

    if (!result) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    return result;
  }

  async logout(
    sessionToken: string,
    ip: string | null = null,
  ): Promise<void> {
    const tokenHash = hashAdminSessionToken(sessionToken);
    if (!tokenHash) {
      return;
    }
    const [lookupRows] = await this.database.pool.query<SessionLookupRow[]>(
      "SELECT operator_id FROM admin_sessions WHERE token_hash = ?",
      [tokenHash],
    );
    const operatorId = lookupRows[0]?.operator_id;
    if (!operatorId) {
      return;
    }

    await this.database.transaction(async (connection) => {
      // Keep the global lock order even when the administrator is disabled.
      await this.findOperator(connection, operatorId, true);
      const [sessionRows] = await connection.query<SessionLookupRow[]>(
        `SELECT operator_id
           FROM admin_sessions
          WHERE token_hash = ?
          FOR UPDATE`,
        [tokenHash],
      );
      if (sessionRows[0]?.operator_id !== operatorId) {
        return;
      }
      await this.deleteSession(connection, tokenHash);
      await insertAuthAudit(connection, {
        operatorId,
        event: "logout",
        reason: "logout",
        ip,
      });
    });
  }

  /**
   * Removes abandoned expired sessions in small batches. Candidate discovery
   * is non-locking; every deletion then follows the global operator -> session
   * lock order and rechecks expiry with the database clock.
   */
  async purgeExpiredSessions(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("管理员会话清理批次必须是 1..1000 的整数");
    }
    const idleTtlMicroseconds = this.idleTtlMs * 1_000;
    const [candidates] = await this.database.pool.query<ExpiredSessionRow[]>(
      `SELECT token_hash, operator_id,
              expires_at <= NOW(3) AS absolute_expired,
              TIMESTAMPDIFF(MICROSECOND, last_seen_at, NOW(3)) >= ?
                AS idle_expired
         FROM admin_sessions
        WHERE expires_at <= NOW(3)
           OR TIMESTAMPDIFF(MICROSECOND, last_seen_at, NOW(3)) >= ?
        ORDER BY expires_at, last_seen_at
        LIMIT ?`,
      [idleTtlMicroseconds, idleTtlMicroseconds, limit],
    );

    let deleted = 0;
    for (const candidate of candidates) {
      const removed = await this.database.transaction(async (connection) => {
        await this.findOperator(connection, candidate.operator_id, true);
        const [rows] = await connection.query<ExpiredSessionRow[]>(
          `SELECT token_hash, operator_id,
                  expires_at <= NOW(3) AS absolute_expired,
                  TIMESTAMPDIFF(MICROSECOND, last_seen_at, NOW(3)) >= ?
                    AS idle_expired
             FROM admin_sessions
            WHERE token_hash = ?
              AND (
                expires_at <= NOW(3)
                OR TIMESTAMPDIFF(MICROSECOND, last_seen_at, NOW(3)) >= ?
              )
            FOR UPDATE`,
          [idleTtlMicroseconds, candidate.token_hash, idleTtlMicroseconds],
        );
        const expired = rows[0];
        if (!expired || expired.operator_id !== candidate.operator_id) {
          return false;
        }
        await this.deleteSession(connection, candidate.token_hash);
        await insertAuthAudit(connection, {
          operatorId: candidate.operator_id,
          event: "session_expired",
          reason: Number(expired.absolute_expired) === 1
            ? "absolute_timeout"
            : "idle_timeout",
          ip: null,
        });
        return true;
      });
      if (removed) {
        deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * Re-authorizes a destructive account operation inside that operation's
   * database transaction. Call this before locking the target account so all
   * administrative writers use the global operator -> business-row lock order.
   *
   * Permission mutators must likewise lock admin_operators first. The shared
   * lock on the access row then closes the gap between authorization and the
   * account mutation until the caller commits.
   */
  async requireAccountOperation(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    gameId: string,
  ): Promise<void> {
    const access = await this.lockGameAccess(connection, identity, gameId);
    if (Number(access.can_operate_accounts) !== 1) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
  }

  /**
   * Holds the administrator and access-row locks while a protected account
   * query runs, so a concurrent permission revocation cannot race the read.
   */
  async requireGameAccess(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    gameId: string,
  ): Promise<void> {
    await this.lockGameAccess(connection, identity, gameId);
  }

  async requireGameManagement(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
  ): Promise<void> {
    const operator = await this.lockCurrentOperator(connection, identity);
    if (Number(operator.can_manage_games) !== 1) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
  }

  async requireIntegrationManagement(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
  ): Promise<void> {
    const operator = await this.lockCurrentOperator(connection, identity);
    if (Number(operator.can_manage_integrations) !== 1) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
  }

  async requireMachineIdentityManagement(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
  ): Promise<void> {
    const operator = await this.lockCurrentOperator(connection, identity);
    if (Number(operator.can_manage_machine_identities) !== 1) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
  }

  async requireSecretRotation(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    sessionToken: string,
  ): Promise<void> {
    const operator = await this.lockCurrentOperator(connection, identity);
    if (Number(operator.can_rotate_secrets) !== 1) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
    await this.requireElevatedSessionLocked(
      connection,
      identity,
      sessionToken,
    );
  }

  async requireElevatedSession(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    sessionToken: string,
  ): Promise<void> {
    await this.lockCurrentOperator(connection, identity);
    await this.requireElevatedSessionLocked(
      connection,
      identity,
      sessionToken,
    );
  }

  private async lockGameAccess(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    gameId: string,
  ): Promise<AccessRow> {
    await this.lockCurrentOperator(connection, identity);
    const [rows] = await connection.query<AccessRow[]>(
      `SELECT game_id, can_operate_accounts
         FROM admin_game_access
        WHERE operator_id = ? AND game_id = ?
        FOR SHARE`,
      [identity.operatorId, gameId],
    );
    const access = rows[0];
    if (!access) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
    return access;
  }

  private async lockCurrentOperator(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
  ): Promise<OperatorRow> {
    const operator = await this.findOperator(
      connection,
      identity.operatorId,
      true,
    );
    if (
      !enabled(operator)
      || authVersion(operator.auth_version) !== identity.authVersion
    ) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    return operator;
  }

  private async requireElevatedSessionLocked(
    connection: PoolConnection,
    identity: Pick<AdminSessionIdentity, "operatorId" | "authVersion">,
    sessionToken: string,
  ): Promise<void> {
    const tokenHash = hashAdminSessionToken(sessionToken);
    if (!tokenHash) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    const [rows] = await connection.query<SessionRow[]>(
      `SELECT operator_id, auth_version, created_at, last_seen_at, expires_at,
              elevated_until
         FROM admin_sessions
        WHERE token_hash = ?
        FOR UPDATE`,
      [tokenHash],
    );
    const session = rows[0];
    const now = this.currentTime();
    const absoluteExpiry = dateValue(session?.expires_at);
    const lastSeenAt = dateValue(session?.last_seen_at);
    if (
      !session
      || session.operator_id !== identity.operatorId
      || authVersion(session.auth_version) !== identity.authVersion
      || !absoluteExpiry
      || !lastSeenAt
      || now.getTime() >= absoluteExpiry.getTime()
      || now.getTime() - lastSeenAt.getTime() >= this.idleTtlMs
    ) {
      throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
    }
    const elevatedUntil = dateValue(session.elevated_until);
    if (!elevatedUntil || now.getTime() >= elevatedUntil.getTime()) {
      throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
    }
  }

  private async completeBootstrapLatch(
    connection: PoolConnection,
    operatorId: string,
    initializedAt: Date,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE admin_bootstrap_latch
          SET initialized = 1,
              initialized_by = ?,
              initialized_at = ?
        WHERE latch_id = 1 AND initialized = 0`,
      [operatorId, initializedAt],
    );
    if (result.affectedRows !== 1) {
      throw new Error("管理员引导锁存器更新失败");
    }
  }

  private async lockAvailableBootstrap(
    connection: PoolConnection,
  ): Promise<boolean> {
    const [latchRows] = await connection.query<BootstrapLatchRow[]>(
      `SELECT initialized
         FROM admin_bootstrap_latch
        WHERE latch_id = 1
        FOR UPDATE`,
    );
    const initialized = Number(latchRows[0]?.initialized);
    if (
      latchRows.length !== 1
      || (initialized !== 0 && initialized !== 1)
    ) {
      throw new Error("管理员引导锁存器数据无效");
    }
    if (initialized === 1) {
      return false;
    }

    const [operators] = await connection.query<AnyOperatorRow[]>(
      `SELECT operator_id
         FROM admin_operators
        ORDER BY operator_id
        LIMIT 1`,
    );
    const existing = operators[0];
    if (!existing) {
      return true;
    }
    await this.completeBootstrapLatch(
      connection,
      existing.operator_id,
      this.currentTime(),
    );
    return false;
  }

  private currentTime(): Date {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("管理员认证时钟返回了无效时间");
    }
    return new Date(now.getTime());
  }

  private async findOperator(
    executor: Pick<Pool | PoolConnection, "query">,
    operatorId: string,
    lock: boolean,
  ): Promise<OperatorRow | undefined> {
    const [rows] = await executor.query<OperatorRow[]>(
      `SELECT operator_id, display_name, password_hash, status, auth_version,
              can_manage_games, can_manage_integrations, can_rotate_secrets,
              can_manage_machine_identities
         FROM admin_operators
        WHERE operator_id = ?${lock ? " FOR UPDATE" : ""}`,
      [operatorId],
    );
    return rows[0];
  }

  private async findAccess(
    executor: Pick<Pool | PoolConnection, "query">,
    operatorId: string,
  ): Promise<AccessRow[]> {
    const [rows] = await executor.query<AccessRow[]>(
      `SELECT a.game_id, a.can_operate_accounts,
              g.name, g.status, g.configuration_state
         FROM admin_game_access AS a
         JOIN games AS g ON g.game_id = a.game_id
        WHERE a.operator_id = ?
        ORDER BY a.game_id`,
      [operatorId],
    );
    return rows;
  }

  private async insertUniqueSession(
    connection: PoolConnection,
    operator: OperatorRow,
    now: Date,
    expiresAt: Date,
  ): Promise<string> {
    const version = authVersion(operator.auth_version);
    if (version === null) {
      throw new Error("管理员 auth_version 数据无效");
    }
    for (let attempt = 0; attempt < SESSION_INSERT_ATTEMPTS; attempt += 1) {
      const entropy = this.randomBytes(ADMIN_SESSION_TOKEN_BYTES);
      if (
        !Buffer.isBuffer(entropy)
        || entropy.length !== ADMIN_SESSION_TOKEN_BYTES
      ) {
        throw new TypeError("管理员会话随机源必须返回 32 字节 Buffer");
      }
      const token = entropy.toString("base64url");
      const tokenHash = hashAdminSessionToken(token);
      if (!tokenHash) {
        throw new Error("管理员会话令牌生成失败");
      }
      try {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO admin_sessions
             (token_hash, operator_id, auth_version, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            tokenHash,
            operator.operator_id,
            version,
            now,
            now,
            expiresAt,
          ],
        );
        return token;
      } catch (error) {
        if (!isDuplicate(error)) {
          throw error;
        }
      }
    }
    throw new Error("管理员会话令牌碰撞次数超过上限");
  }

  private async deleteSession(
    connection: PoolConnection,
    tokenHash: Buffer,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      "DELETE FROM admin_sessions WHERE token_hash = ?",
      [tokenHash],
    );
  }
}
