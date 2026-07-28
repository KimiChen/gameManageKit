import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";
import { loadConfig } from "../../src/config.js";

const rootFile = (path: string): URL => new URL(`../../${path}`, import.meta.url);

test("本地开发与迁移命令显式加载 .env", async () => {
  const packageJson = JSON.parse(
    await readFile(rootFile("package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.match(packageJson.scripts?.dev ?? "", /\btsx watch --env-file=\.env\b/);
  assert.match(packageJson.scripts?.migrate ?? "", /\btsx --env-file=\.env\b/);
  assert.match(packageJson.scripts?.["migrate:prod"] ?? "", /\bnode --env-file=\.env\b/);
  assert.match(packageJson.scripts?.["test:int"] ?? "", /\bnode --env-file=\.env\b/);
  assert.match(
    packageJson.scripts?.["test:docker"] ?? "",
    /\bup -d --build --wait app\b.*\brun --rm --no-deps smoke\b/,
  );
});

test("可选 Docker MySQL 仅监听本机并等待健康检查", async () => {
  const source = await readFile(rootFile("compose.yaml"), "utf8");
  const compose = YAML.parse(source) as {
    services?: {
      mysql?: {
        image?: string;
        environment?: Record<string, string>;
        ports?: string[];
        healthcheck?: { test?: string[] };
      };
      smoke?: {
        depends_on?: Record<string, { condition?: string }>;
        command?: string[];
      };
    };
  };
  const mysql = compose.services?.mysql;
  const smoke = compose.services?.smoke;

  assert.equal(mysql?.image, "mysql:8.4");
  assert.equal(mysql?.environment?.MYSQL_DATABASE, "game_manage_kit");
  assert.deepEqual(mysql?.ports, ["127.0.0.1:3316:3306"]);
  assert.equal(mysql?.healthcheck?.test?.join(" ").includes("mysqladmin ping"), true);
  assert.equal(smoke?.depends_on?.app?.condition, "service_healthy");
  assert.deepEqual(smoke?.command, ["node", "scripts/docker-smoke.mjs"]);
});

test("生产镜像以非 root 用户运行并提供 readiness 健康检查", async () => {
  const dockerfile = await readFile(rootFile("Dockerfile"), "utf8");

  assert.match(dockerfile, /GAME_MANAGE_KIT_PUBLIC_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /GAME_MANAGE_KIT_INTERNAL_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /COPY scripts\/docker-smoke\.mjs/);
  assert.match(dockerfile, /COPY web \.\/web/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:2570\/readyz/);
  assert.match(dockerfile, /\nUSER node\n/);
});

test("生产启动配置不要求游戏文件或每游戏 Secret", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    GAME_MANAGE_KIT_MYSQL_URL:
      "mysql://gmk@mysql.example.invalid/game_manage_kit",
    AUTH_DEV_ENABLED: "0",
    GAME_MANAGE_KIT_ADMIN_ORIGIN: "https://admin.example.invalid",
  });

  assert.equal("gamesConfigPath" in config, false);
  assert.equal(config.mysqlUrl.includes("game_manage_kit"), true);
});
