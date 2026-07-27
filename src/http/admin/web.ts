import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

interface AdminWebAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
  readonly html: boolean;
}

export interface AdminWebRouteOptions {
  readonly rootPath?: string;
}

const DEFAULT_ROOT = fileURLToPath(
  new URL("../../../web/admin/", import.meta.url),
);

const ASSET_FILES = Object.freeze([
  ["/admin/", "index.html", "text/html; charset=utf-8", true],
  ["/admin/wsk.css", "wsk.css", "text/css; charset=utf-8", false],
  ["/admin/admin.css", "admin.css", "text/css; charset=utf-8", false],
  ["/admin/wsk.js", "wsk.js", "application/javascript; charset=utf-8", false],
  ["/admin/app.js", "app.js", "application/javascript; charset=utf-8", false],
] as const);

function etag(body: Buffer): string {
  const digest = createHash("sha256").update(body).digest("base64url");
  return `"sha256-${digest}"`;
}

function themeScriptHash(html: Buffer): string {
  const scripts = [
    ...html
      .toString("utf8")
      .matchAll(/<script>([\s\S]*?)<\/script>/giu),
  ];
  if (scripts.length !== 1 || scripts[0]?.[1] === undefined) {
    throw new Error("管理员页面必须且只能包含一个内联首屏主题脚本");
  }
  return createHash("sha256")
    .update(scripts[0][1], "utf8")
    .digest("base64");
}

function securityHeaders(reply: FastifyReply, scriptHash: string): void {
  void reply
    .header(
      "content-security-policy",
      [
        "default-src 'none'",
        `script-src 'self' 'sha256-${scriptHash}'`,
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    )
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
}

function matchesEtag(request: FastifyRequest, expected: string): boolean {
  const value: unknown = request.headers["if-none-match"];
  if (typeof value === "string") {
    return value.split(",").some((candidate) => candidate.trim() === expected);
  }
  return Array.isArray(value) && value.some((candidate) => candidate === expected);
}

function sendAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  asset: AdminWebAsset,
  scriptHash: string,
): FastifyReply {
  securityHeaders(reply, scriptHash);
  void reply
    .header(
      "cache-control",
      asset.html ? "no-cache" : "private, max-age=0, must-revalidate",
    )
    .header("content-type", asset.contentType)
    .header("etag", asset.etag);
  if (matchesEtag(request, asset.etag)) {
    return reply.code(304).send();
  }
  return reply.send(asset.body);
}

export function registerAdminWebRoutes(
  app: FastifyInstance,
  options: AdminWebRouteOptions = {},
): void {
  const rootPath = options.rootPath ?? DEFAULT_ROOT;
  const assets = new Map<string, AdminWebAsset>();
  for (const [route, filename, contentType, html] of ASSET_FILES) {
    const body = readFileSync(join(rootPath, filename));
    assets.set(route, {
      body,
      contentType,
      etag: etag(body),
      html,
    });
  }

  const index = assets.get("/admin/");
  if (!index) {
    throw new Error("管理员页面 index.html 缺失");
  }
  const scriptHash = themeScriptHash(index.body);

  for (const [route, asset] of assets) {
    app.get(route, async (request, reply) => (
      sendAsset(request, reply, asset, scriptHash)
    ));
  }

  for (const route of ["/admin", "/admin/index.html"]) {
    app.get(route, async (_request, reply) => {
      securityHeaders(reply, scriptHash);
      return reply
        .header("cache-control", "no-cache")
        .redirect("/admin/", 308);
    });
  }
}
