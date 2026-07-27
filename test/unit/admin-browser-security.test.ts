import assert from "node:assert/strict";
import test from "node:test";
import { GameManageKitError } from "../../src/errors.js";
import {
  ADMIN_SESSION_COOKIE_DEVELOPMENT,
  ADMIN_SESSION_COOKIE_PRODUCTION,
  clearAdminSessionCookies,
  isAllowedAdminOrigin,
  parseAdminSessionCookie,
  requireAdminSessionCookie,
  requireAllowedAdminOrigin,
  serializeAdminSessionCookie,
} from "../../src/http/admin/browser-security.js";

const TOKEN = Buffer.alloc(32, 0xa5).toString("base64url");

function isGameError(
  error: unknown,
  statusCode: number,
  code: string,
): boolean {
  assert.equal(error instanceof GameManageKitError, true);
  assert.equal((error as GameManageKitError).statusCode, statusCode);
  assert.equal((error as GameManageKitError).code, code);
  return true;
}

test("生产与开发 Cookie 使用隔离名称和严格属性", () => {
  assert.equal(
    serializeAdminSessionCookie(TOKEN, {
      production: true,
      maxAgeSeconds: 28_800,
    }),
    `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}; Path=/; HttpOnly; `
      + "SameSite=Strict; Secure; Max-Age=28800",
  );
  assert.equal(
    serializeAdminSessionCookie(TOKEN, { production: false }),
    `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
  );
  assert.throws(
    () => serializeAdminSessionCookie("not-a-token", { production: true }),
    TypeError,
  );
  assert.throws(
    () => serializeAdminSessionCookie(TOKEN, {
      production: true,
      maxAgeSeconds: 0,
    }),
    TypeError,
  );

  const cleared = clearAdminSessionCookies();
  assert.equal(cleared.length, 2);
  assert.match(cleared[0] ?? "", /^__Host-gmk_admin_session=;/u);
  assert.match(cleared[0] ?? "", /; Secure$/u);
  assert.match(cleared[1] ?? "", /^gmk_admin_session=;/u);
  assert.doesNotMatch(cleared[1] ?? "", /; Secure$/u);
  for (const cookie of cleared) {
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /SameSite=Strict/u);
    assert.match(cookie, /Max-Age=0/u);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/u);
  }
});

test("Cookie 解析拒绝双名称、重复名称和非规范令牌", () => {
  assert.deepEqual(
    parseAdminSessionCookie(
      `theme=dark; ${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}`,
      { production: true },
    ),
    {
      ok: true,
      token: TOKEN,
      name: ADMIN_SESSION_COOKIE_PRODUCTION,
    },
  );
  assert.deepEqual(parseAdminSessionCookie(null, { production: true }), {
    ok: false,
    reason: "missing",
  });
  assert.deepEqual(
    parseAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}; `
      + `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=${TOKEN}`,
      { production: true },
    ),
    { ok: false, reason: "conflict" },
  );
  assert.deepEqual(
    parseAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}; `
      + `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}`,
      { production: true },
    ),
    { ok: false, reason: "conflict" },
  );
  assert.deepEqual(
    parseAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=abc%2Fdef`,
      { production: false },
    ),
    { ok: false, reason: "malformed" },
  );
  assert.deepEqual(
    parseAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=${TOKEN}`,
      { production: true },
    ),
    { ok: false, reason: "mode_mismatch" },
  );
  assert.deepEqual(
    parseAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}`,
      { production: false },
    ),
    { ok: false, reason: "mode_mismatch" },
  );
  assert.throws(
    () => requireAdminSessionCookie(
      `${ADMIN_SESSION_COOKIE_PRODUCTION}=${TOKEN}; `
      + `${ADMIN_SESSION_COOKIE_DEVELOPMENT}=${TOKEN}`,
      { production: true },
    ),
    (error) => isGameError(error, 401, "ADMIN_AUTH_REQUIRED"),
  );
});

test("Origin 只接受配置中的规范化精确源", () => {
  const allowed = [
    "https://admin.example.com",
    "http://127.0.0.1:3101",
  ];
  assert.equal(
    isAllowedAdminOrigin("https://admin.example.com", allowed),
    true,
  );
  assert.equal(
    isAllowedAdminOrigin("http://127.0.0.1:3101", allowed),
    true,
  );
  for (const denied of [
    null,
    "null",
    "https://admin.example.com/",
    "https://ADMIN.example.com",
    "http://admin.example.com",
    "https://admin.example.com:444",
    "https://admin.example.com.evil.invalid",
    "https://admin.example.com https://evil.invalid",
  ]) {
    assert.equal(
      isAllowedAdminOrigin(denied, allowed),
      false,
      denied ?? "<null>",
    );
  }
  assert.throws(
    () => requireAllowedAdminOrigin(null, allowed),
    (error) => isGameError(error, 403, "ORIGIN_FORBIDDEN"),
  );
  assert.throws(
    () => isAllowedAdminOrigin(
      "https://admin.example.com",
      ["https://admin.example.com/path"],
    ),
    TypeError,
  );
});
