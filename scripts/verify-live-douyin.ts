import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const SERVICE_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
const SERVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR_CODES = new Set([
  "INVALID_PAYLOAD",
  "INVALID_REQUEST",
  "AUTH_REQUIRED",
  "ACCOUNT_BANNED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "SERVICE_AUTH_REQUIRED",
  "SERVICE_FORBIDDEN",
  "OPERATION_CONFLICT",
  "INTERNAL",
  "GAME_NOT_FOUND",
  "GAME_DISABLED",
  "GAME_ACCESS_DENIED",
  "SERVER_NOT_FOUND",
  "SERVER_DISABLED",
  "ADMIN_AUTH_REQUIRED",
  "ORIGIN_FORBIDDEN",
  "GAME_PROJECT_CONFLICT",
  "GAME_SERVER_CONFLICT",
  "ADMIN_ALREADY_INITIALIZED",
  "AUTH_CODE_INVALID",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_CONFIGURATION_INVALID",
  "IDENTITY_CONFLICT",
  "IDENTITY_PROVIDER_CONFLICT",
]);
const VERIFY_REASONS = new Set([
  "NOT_FOUND",
  "MISMATCH",
  "BANNED",
  "DEREGISTERED",
  "EXPIRED",
]);

type Fetch = typeof globalThis.fetch;

export interface LiveDouyinConfig {
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly gameId: string;
  readonly serverId: number;
  readonly serviceId: string;
  readonly timeoutMs: number;
}

export interface LiveDouyinResult {
  readonly gameId: string;
  readonly serverId: number;
  readonly userId: string;
  readonly isNewAccount: boolean;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly loginRequestId: string;
  readonly verifyRequestId: string;
}

interface LoginResponse {
  readonly userId: string;
  readonly accessToken: string;
  readonly isNewAccount: boolean;
}

interface ValidSessionResponse {
  readonly valid: true;
  readonly userId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export class LiveDouyinVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDouyinVerificationError";
  }
}

function fail(message: string): never {
  throw new LiveDouyinVerificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function normalizeBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${label} 非法`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return fail(`${label} 必须是无凭据、路径、查询和 Hash 的 HTTP(S) origin`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  const loopback = hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    return fail(`${label} 远程 origin 必须使用 HTTPS`);
  }
  return parsed.origin;
}

function positiveInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return fail(`${label} 必须是整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fail(`${label} 必须位于 ${minimum}..${maximum}`);
  }
  return parsed;
}

export function parseLiveDouyinArgs(argv: readonly string[]): LiveDouyinConfig {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--public-url",
    "--internal-url",
    "--game-id",
    "--server-id",
    "--service-id",
    "--timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name)) {
      return fail(`未知参数 ${name ?? ""}`.trim());
    }
    if (value === undefined || value.startsWith("--")) {
      return fail(`${name} 缺少值`);
    }
    if (values.has(name)) {
      return fail(`${name} 不得重复`);
    }
    values.set(name, value);
  }

  const gameId = values.get("--game-id") ?? "";
  const serviceId = values.get("--service-id") ?? "";
  if (!GAME_ID_PATTERN.test(gameId)) {
    return fail("--game-id 非法");
  }
  if (!SERVICE_ID_PATTERN.test(serviceId)) {
    return fail("--service-id 非法");
  }

  return {
    publicUrl: normalizeBaseUrl(
      values.get("--public-url") ?? "http://127.0.0.1:2570",
      "--public-url",
    ),
    internalUrl: normalizeBaseUrl(
      values.get("--internal-url") ?? "http://127.0.0.1:2571",
      "--internal-url",
    ),
    gameId,
    serverId: positiveInteger(
      values.get("--server-id") ?? "",
      "--server-id",
      0,
      65_535,
    ),
    serviceId,
    timeoutMs: positiveInteger(
      values.get("--timeout-ms") ?? "10000",
      "--timeout-ms",
      100,
      60_000,
    ),
  };
}

function validateServiceSecret(value: string): void {
  if (!SERVICE_SECRET_PATTERN.test(value)) {
    fail("Service Secret 必须是 43 位 Base64URL");
  }
}

function validateCode(value: string): void {
  if (value.length < 1 || value.length > 128 || value.trim() !== value) {
    fail("tt.login code 必须是 1..128 位且首尾无空白");
  }
}

async function readBoundedJson(response: Response, label: string): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      return fail(`${label} Content-Length 非法`);
    }
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES) {
      return fail(`${label} 响应过大`);
    }
  }
  if (!response.body) {
    return fail(`${label} 响应为空`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail(`${label} 响应过大`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(`${label} 返回非法 JSON`);
  }
}

function safeHttpFailure(
  label: string,
  status: number,
  body: unknown,
  requestId: string | null,
): LiveDouyinVerificationError {
  const code = isRecord(body) && typeof body.code === "string"
    && ERROR_CODES.has(body.code)
    ? ` ${body.code}`
    : "";
  const requestIdDetail = requestId === null
    ? ""
    : ` requestId=${requestId}`;
  return new LiveDouyinVerificationError(
    `${label} 返回 HTTP ${status}${code}${requestIdDetail}`,
  );
}

function safeResponseRequestId(
  response: Response,
  sensitiveValues: readonly string[],
): string | null {
  const requestId = response.headers.get("x-request-id");
  if (
    requestId === null
    || !/^req-[0-9a-z]{1,16}$/u.test(requestId)
    || sensitiveValues.some((value) => (
      value !== "" && requestId.includes(value)
    ))
  ) {
    return null;
  }
  return requestId;
}

interface JsonResponse {
  readonly body: unknown;
  readonly requestId: string | null;
}

function requireRequestId(
  response: JsonResponse,
  label: string,
): string {
  return response.requestId === null
    ? fail(`${label} 缺少可信 x-request-id`)
    : response.requestId;
}

async function requestJson(
  fetchImpl: Fetch,
  config: LiveDouyinConfig,
  baseUrl: string,
  path: string,
  label: string,
  init: RequestInit = {},
  sensitiveValues: readonly string[] = [],
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
    const body = await readBoundedJson(response, label);
    const requestId = safeResponseRequestId(response, sensitiveValues);
    if (response.status < 200 || response.status >= 300) {
      throw safeHttpFailure(label, response.status, body, requestId);
    }
    return { body, requestId };
  } catch (error) {
    if (error instanceof LiveDouyinVerificationError) {
      throw error;
    }
    return fail(controller.signal.aborted ? `${label} 超时` : `${label} 网络失败`);
  } finally {
    clearTimeout(timer);
  }
}

function jsonRequest(
  method: "POST",
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function parseInvalidVerification(value: unknown, label: string): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["valid", "reason"])
    || value.valid !== false
    || typeof value.reason !== "string"
    || !VERIFY_REASONS.has(value.reason)
  ) {
    fail(`${label} 返回结构非法`);
  }
}

function parseLoginResponse(value: unknown): LoginResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["userId", "accessToken", "isNewAccount"])
    || typeof value.userId !== "string"
    || value.userId.length < 1
    || typeof value.accessToken !== "string"
    || value.accessToken.length < 1
    || value.accessToken.length > 256
    || typeof value.isNewAccount !== "boolean"
  ) {
    return fail("抖音登录返回结构非法");
  }
  return {
    userId: value.userId,
    accessToken: value.accessToken,
    isNewAccount: value.isNewAccount,
  };
}

function parseValidVerification(
  value: unknown,
  expectedUserId: string,
  nowMs: number,
): ValidSessionResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "valid",
      "userId",
      "issuedAtMs",
      "expiresAtMs",
    ])
    || value.valid !== true
    || value.userId !== expectedUserId
    || !Number.isSafeInteger(value.issuedAtMs)
    || Number(value.issuedAtMs) <= 0
    || !Number.isSafeInteger(value.expiresAtMs)
    || Number(value.expiresAtMs) < Number(value.issuedAtMs)
    || Number(value.expiresAtMs) <= nowMs
  ) {
    return fail("Session verify 返回结构、身份或过期时间非法");
  }
  return {
    valid: true,
    userId: value.userId,
    issuedAtMs: Number(value.issuedAtMs),
    expiresAtMs: Number(value.expiresAtMs),
  };
}

function serviceHeaders(
  config: LiveDouyinConfig,
  serviceSecret: string,
): Record<string, string> {
  return {
    "x-service-id": config.serviceId,
    "x-service-secret": serviceSecret,
  };
}

export async function preflightLiveDouyin(
  config: LiveDouyinConfig,
  serviceSecret: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<void> {
  validateServiceSecret(serviceSecret);
  const publicReady = (await requestJson(
    fetchImpl,
    config,
    config.publicUrl,
    "/readyz",
    "Public readiness",
    {},
    [serviceSecret],
  )).body;
  if (
    !isRecord(publicReady)
    || !hasExactKeys(publicReady, ["ready"])
    || publicReady.ready !== true
  ) {
    fail("Public readiness 返回结构非法");
  }

  const internalReady = (await requestJson(
    fetchImpl,
    config,
    config.internalUrl,
    "/readyz",
    "Internal readiness",
    {},
    [serviceSecret],
  )).body;
  if (
    !isRecord(internalReady)
    || !hasExactKeys(internalReady, ["ready"])
    || internalReady.ready !== true
  ) {
    fail("Internal readiness 返回结构非法");
  }

  const areas = (await requestJson(
    fetchImpl,
    config,
    config.publicUrl,
    `/v1/games/${encodeURIComponent(config.gameId)}/areas`,
    "区服目录",
    {},
    [serviceSecret],
  )).body;
  if (
    !isRecord(areas)
    || !Array.isArray(areas.servers)
    || !areas.servers.some(
      (server) => isRecord(server) && server.serverId === config.serverId,
    )
  ) {
    fail(`区服目录不包含 serverId=${config.serverId}`);
  }

  const dummyToken = `${config.gameId}.u_0.${randomBytes(24).toString("hex")}`;
  const serviceProbe = (await requestJson(
    fetchImpl,
    config,
    config.internalUrl,
    `/v1/games/${encodeURIComponent(config.gameId)}/internal/sessions/verify`,
    "Service 身份预检",
    jsonRequest(
      "POST",
      { accessToken: dummyToken, serverId: config.serverId },
      serviceHeaders(config, serviceSecret),
    ),
    [serviceSecret],
  )).body;
  parseInvalidVerification(serviceProbe, "Service 身份预检");
}

export async function verifyFreshDouyinCode(
  config: LiveDouyinConfig,
  code: string,
  serviceSecret: string,
  fetchImpl: Fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<LiveDouyinResult> {
  validateCode(code);
  validateServiceSecret(serviceSecret);
  const loginResponse = await requestJson(
    fetchImpl,
    config,
    config.publicUrl,
    `/v1/games/${encodeURIComponent(config.gameId)}/sessions/douyin`,
    "抖音登录",
    jsonRequest("POST", { code, serverId: config.serverId }),
    [code, serviceSecret],
  );
  const login = parseLoginResponse(loginResponse.body);
  const loginRequestId = requireRequestId(loginResponse, "抖音登录");
  const verificationResponse = await requestJson(
    fetchImpl,
    config,
    config.internalUrl,
    `/v1/games/${encodeURIComponent(config.gameId)}/internal/sessions/verify`,
    "Session verify",
    jsonRequest(
      "POST",
      { accessToken: login.accessToken, serverId: config.serverId },
      serviceHeaders(config, serviceSecret),
    ),
    [code, login.accessToken, serviceSecret],
  );
  const verification = parseValidVerification(
    verificationResponse.body,
    login.userId,
    now(),
  );
  const verifyRequestId = requireRequestId(
    verificationResponse,
    "Session verify",
  );

  return {
    gameId: config.gameId,
    serverId: config.serverId,
    userId: login.userId,
    isNewAccount: login.isNewAccount,
    issuedAtMs: verification.issuedAtMs,
    expiresAtMs: verification.expiresAtMs,
    loginRequestId,
    verifyRequestId,
  };
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return fail("敏感输入要求交互式 TTY，禁止通过命令行参数或管道传入");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });
  const readline = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  process.stdout.write(prompt);
  muted = true;
  try {
    return (await readline.question("")).trim();
  } finally {
    muted = false;
    readline.close();
    process.stdout.write("\n");
  }
}

function help(): string {
  return [
    "真实抖音登录与 Session 校验（code 和 Service Secret 仅通过隐藏 TTY 输入）",
    "",
    "npm run verify:douyin:live -- \\",
    "  --game-id <gameId> --server-id <serverId> --service-id <serviceId> \\",
    "  [--public-url http://127.0.0.1:2570] \\",
    "  [--internal-url http://127.0.0.1:2571] [--timeout-ms 10000]",
  ].join("\n");
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const config = parseLiveDouyinArgs(process.argv.slice(2));
  const serviceSecret = await hiddenQuestion("Service Secret（隐藏输入）: ");
  await preflightLiveDouyin(config, serviceSecret);
  process.stdout.write(
    `[douyin-live] 预检通过：game=${config.gameId} server=${config.serverId}\n`,
  );
  process.stdout.write(
    "[douyin-live] Provider 状态无法从 Public API 预读；请先在管理端再次确认测试"
      + " Provider 已启用且 AppID/Secret 正确。\n",
  );
  process.stdout.write(
    "[douyin-live] 现在于抖音开发者工具执行 tt.login，随后立即输入 fresh code。\n",
  );
  const code = await hiddenQuestion("tt.login code（隐藏输入）: ");
  const result = await verifyFreshDouyinCode(config, code, serviceSecret);
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    ...result,
  })}\n`);
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof LiveDouyinVerificationError
      ? error.message
      : "未分类内部错误";
    process.stderr.write(`[douyin-live] FAIL ${message}\n`);
    process.exitCode = 1;
  });
}
