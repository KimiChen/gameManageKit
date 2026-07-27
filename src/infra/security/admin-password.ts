import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

export const ADMIN_PASSWORD_MIN_CODE_POINTS = 12;
export const ADMIN_PASSWORD_MAX_CODE_POINTS = 256;
export const ADMIN_PASSWORD_MAX_UTF8_BYTES = 1_024;

const HASH_ALGORITHM = "gmk-scrypt";
const HASH_VERSION = "v=1";
const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const SCRYPT_PARAMETERS = `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const SALT_BASE64URL_LENGTH = 22;
const DERIVED_KEY_BASE64URL_LENGTH = 43;
const STORED_HASH_LENGTH = [
  HASH_ALGORITHM,
  HASH_VERSION,
  SCRYPT_PARAMETERS,
  "s".repeat(SALT_BASE64URL_LENGTH),
  "h".repeat(DERIVED_KEY_BASE64URL_LENGTH),
].join("$").length;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const SCRYPT_OPTIONS: Readonly<ScryptOptions> = Object.freeze({
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAX_MEMORY_BYTES,
});

interface PasswordShape {
  readonly codePoints: number;
  readonly utf8Bytes: number;
  readonly wellFormed: boolean;
}

interface ParsedHash {
  readonly salt: Buffer;
  readonly derivedKey: Buffer;
}

function inspectPassword(password: string): PasswordShape {
  let codePoints = 0;
  let wellFormed = true;

  for (let index = 0; index < password.length; index += 1) {
    const codeUnit = password.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = password.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        wellFormed = false;
        break;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed = false;
      break;
    }
    codePoints += 1;
  }

  return {
    codePoints,
    utf8Bytes: Buffer.byteLength(password, "utf8"),
    wellFormed,
  };
}

function isValidAdminPassword(password: string): boolean {
  const shape = inspectPassword(password);
  return shape.wellFormed
    && shape.codePoints >= ADMIN_PASSWORD_MIN_CODE_POINTS
    && shape.codePoints <= ADMIN_PASSWORD_MAX_CODE_POINTS
    && shape.utf8Bytes <= ADMIN_PASSWORD_MAX_UTF8_BYTES;
}

/**
 * Validates a password before it is persisted for an administrator.
 *
 * Passwords are counted as Unicode code points, not UTF-16 code units. They are
 * never trimmed or normalized because either operation would change the secret.
 */
export function validateAdminPassword(password: string): void {
  if (typeof password !== "string") {
    throw new TypeError("管理员密码必须是字符串");
  }
  if (!isValidAdminPassword(password)) {
    throw new TypeError(
      `管理员密码必须是 ${ADMIN_PASSWORD_MIN_CODE_POINTS} 至 `
      + `${ADMIN_PASSWORD_MAX_CODE_POINTS} 个有效 Unicode 字符，且 UTF-8 不超过 `
      + `${ADMIN_PASSWORD_MAX_UTF8_BYTES} 字节`,
    );
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      DERIVED_KEY_BYTES,
      SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function decodeCanonicalBase64Url(
  value: string,
  encodedLength: number,
  byteLength: number,
): Buffer | null {
  if (
    value.length !== encodedLength
    || !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== byteLength
    || decoded.toString("base64url") !== value
  ) {
    return null;
  }
  return decoded;
}

function parseStoredHash(storedHash: string): ParsedHash | null {
  // The exact length check also prevents an attacker-controlled value from
  // causing an unbounded split or decode allocation.
  if (storedHash.length !== STORED_HASH_LENGTH) {
    return null;
  }

  const fields = storedHash.split("$");
  if (
    fields.length !== 5
    || fields[0] !== HASH_ALGORITHM
    || fields[1] !== HASH_VERSION
    || fields[2] !== SCRYPT_PARAMETERS
  ) {
    return null;
  }

  const saltField = fields[3];
  const derivedKeyField = fields[4];
  if (saltField === undefined || derivedKeyField === undefined) {
    return null;
  }

  const salt = decodeCanonicalBase64Url(
    saltField,
    SALT_BASE64URL_LENGTH,
    SALT_BYTES,
  );
  const derivedKey = decodeCanonicalBase64Url(
    derivedKeyField,
    DERIVED_KEY_BASE64URL_LENGTH,
    DERIVED_KEY_BYTES,
  );
  return salt && derivedKey ? { salt, derivedKey } : null;
}

export async function hashAdminPassword(password: string): Promise<string> {
  validateAdminPassword(password);

  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(password, salt);
  return [
    HASH_ALGORITHM,
    HASH_VERSION,
    SCRYPT_PARAMETERS,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (typeof password !== "string" || typeof storedHash !== "string") {
    throw new TypeError("管理员密码和密码哈希必须是字符串");
  }
  if (!isValidAdminPassword(password)) {
    return false;
  }

  const parsed = parseStoredHash(storedHash);
  if (!parsed) {
    return false;
  }

  try {
    const candidate = await deriveKey(password, parsed.salt);
    return timingSafeEqual(candidate, parsed.derivedKey);
  } catch {
    return false;
  }
}
