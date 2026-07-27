import { timingSafeEqual } from "node:crypto";
import { GameManageKitError } from "../../errors.js";

export const ADMIN_SESSION_COOKIE_PRODUCTION = "__Host-gmk_admin_session";
export const ADMIN_SESSION_COOKIE_DEVELOPMENT = "gmk_admin_session";

const ADMIN_SESSION_TOKEN_BYTES = 32;
const ADMIN_SESSION_TOKEN_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type AdminSessionCookieResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly name:
        | typeof ADMIN_SESSION_COOKIE_PRODUCTION
        | typeof ADMIN_SESSION_COOKIE_DEVELOPMENT;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "conflict" | "malformed" | "mode_mismatch";
    };

export interface AdminSessionCookieReadOptions {
  readonly production: boolean;
}

function validSessionToken(value: string): boolean {
  if (
    value.length !== ADMIN_SESSION_TOKEN_LENGTH
    || !BASE64URL_PATTERN.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === ADMIN_SESSION_TOKEN_BYTES
    && decoded.toString("base64url") === value;
}

/**
 * Parses only the two names reserved for the administrator session.
 *
 * A request carrying both the production and development cookie, or repeating
 * either name, is deliberately rejected. Picking one would let intermediaries
 * and browsers disagree about which credential is authoritative.
 */
export function parseAdminSessionCookie(
  cookieHeader: string | null | undefined,
  options: AdminSessionCookieReadOptions,
): AdminSessionCookieResult {
  if (!cookieHeader) {
    return { ok: false, reason: "missing" };
  }

  const values: Array<{
    name:
      | typeof ADMIN_SESSION_COOKIE_PRODUCTION
      | typeof ADMIN_SESSION_COOKIE_DEVELOPMENT;
    value: string;
  }> = [];
  for (const field of cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const name = field.slice(0, separator).trim();
    if (
      name !== ADMIN_SESSION_COOKIE_PRODUCTION
      && name !== ADMIN_SESSION_COOKIE_DEVELOPMENT
    ) {
      continue;
    }
    values.push({
      name,
      value: field.slice(separator + 1).trim(),
    });
  }

  if (values.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (values.length !== 1) {
    return { ok: false, reason: "conflict" };
  }
  const selected = values[0];
  if (selected === undefined || !validSessionToken(selected.value)) {
    return { ok: false, reason: "malformed" };
  }
  if (selected.name !== cookieName(options.production)) {
    return { ok: false, reason: "mode_mismatch" };
  }
  return {
    ok: true,
    token: selected.value,
    name: selected.name,
  };
}

export function requireAdminSessionCookie(
  cookieHeader: string | null | undefined,
  options: AdminSessionCookieReadOptions,
): string {
  const parsed = parseAdminSessionCookie(cookieHeader, options);
  if (!parsed.ok) {
    throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
  }
  return parsed.token;
}

export interface AdminSessionCookieOptions {
  readonly production: boolean;
  readonly maxAgeSeconds?: number;
}

function cookieName(production: boolean): string {
  return production
    ? ADMIN_SESSION_COOKIE_PRODUCTION
    : ADMIN_SESSION_COOKIE_DEVELOPMENT;
}

export function serializeAdminSessionCookie(
  token: string,
  options: AdminSessionCookieOptions,
): string {
  if (!validSessionToken(token)) {
    throw new TypeError("管理员会话令牌格式无效");
  }
  const maxAge = options.maxAgeSeconds;
  if (
    maxAge !== undefined
    && (!Number.isSafeInteger(maxAge) || maxAge < 1)
  ) {
    throw new TypeError("管理员会话 Cookie Max-Age 必须为正整数");
  }

  return [
    `${cookieName(options.production)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(options.production ? ["Secure"] : []),
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join("; ");
}

/**
 * Clear both names so a deployment mode change cannot leave a shadow
 * credential behind in the browser.
 */
export function clearAdminSessionCookies(): readonly string[] {
  const attributes = "Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  return [
    `${ADMIN_SESSION_COOKIE_PRODUCTION}=; ${attributes}; Secure`,
    `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=; ${attributes}`,
  ];
}

function canonicalOrigin(value: string): string | null {
  if (value.length === 0 || value === "null") {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
      || url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(actual);
  const expectedDigest = Buffer.from(expected);
  return actualDigest.length === expectedDigest.length
    && timingSafeEqual(actualDigest, expectedDigest);
}

export function isAllowedAdminOrigin(
  originHeader: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!originHeader || allowedOrigins.length === 0) {
    return false;
  }
  const origin = canonicalOrigin(originHeader);
  if (!origin) {
    return false;
  }

  let allowed = false;
  for (const configured of allowedOrigins) {
    const candidate = canonicalOrigin(configured);
    if (!candidate) {
      throw new TypeError(`管理员 Origin 配置无效: ${configured}`);
    }
    allowed = constantTimeStringEqual(origin, candidate) || allowed;
  }
  return allowed;
}

export function requireAllowedAdminOrigin(
  originHeader: string | null | undefined,
  allowedOrigins: readonly string[],
): void {
  if (!isAllowedAdminOrigin(originHeader, allowedOrigins)) {
    throw new GameManageKitError(403, "ORIGIN_FORBIDDEN");
  }
}
