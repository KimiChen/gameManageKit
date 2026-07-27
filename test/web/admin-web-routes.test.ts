import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAdminWebRoutes } from "../../src/http/admin/web.js";

test("管理员静态页面带安全响应头且只使用固定资源路由", async (t) => {
  const app = Fastify();
  registerAdminWebRoutes(app);
  t.after(async () => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/admin/",
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/html/u);
  assert.equal(response.headers["cache-control"], "no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(
    response.headers["cross-origin-resource-policy"],
    "same-origin",
  );

  const policy = response.headers["content-security-policy"] ?? "";
  assert.match(policy, /default-src 'none'/u);
  assert.match(policy, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/u);
  assert.match(policy, /frame-ancestors 'none'/u);
  assert.match(policy, /connect-src 'self'/u);
  assert.doesNotMatch(policy, /unsafe-inline/u);
  assert.match(response.body, /gameManageKit 管理控制台/u);

  const traversal = await app.inject({
    method: "GET",
    url: "/admin/%2e%2e/%2e%2e/.env",
  });
  assert.equal(traversal.statusCode, 404);
});

test("管理员静态资源支持 ETag 条件请求", async (t) => {
  const app = Fastify();
  registerAdminWebRoutes(app);
  t.after(async () => app.close());

  const first = await app.inject({
    method: "GET",
    url: "/admin/app.js",
  });
  assert.equal(first.statusCode, 200);
  assert.match(
    first.headers["content-type"] ?? "",
    /^application\/javascript/u,
  );
  assert.equal(
    first.headers["cache-control"],
    "private, max-age=0, must-revalidate",
  );
  const etag = first.headers.etag;
  assert.match(etag ?? "", /^"sha256-[A-Za-z0-9_-]+"$/u);

  const cached = await app.inject({
    method: "GET",
    url: "/admin/app.js",
    headers: {
      "if-none-match": etag ?? "",
    },
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, "");
  assert.equal(cached.headers.etag, etag);

  for (const ifNoneMatch of [
    "*",
    `W/${etag}`,
    `"other", W/${etag}`,
  ]) {
    const weaklyCached = await app.inject({
      method: "GET",
      url: "/admin/app.js",
      headers: {
        "if-none-match": ifNoneMatch,
      },
    });
    assert.equal(weaklyCached.statusCode, 304);
    assert.equal(weaklyCached.body, "");
  }
});

test("规范化入口重定向到带斜杠的管理页", async (t) => {
  const app = Fastify();
  registerAdminWebRoutes(app);
  t.after(async () => app.close());

  for (const url of ["/admin", "/admin/index.html"]) {
    const response = await app.inject({
      method: "GET",
      url,
    });
    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, "/admin/");
    assert.equal(response.headers["cache-control"], "no-cache");
  }
});
