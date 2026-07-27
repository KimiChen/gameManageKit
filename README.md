# gameManageKit

gameManageKit 是游戏专属的独立账号门户服务。服务通过 HTTP 提供登录、会话校验、角色足迹、选服目录与账号管理能力。

硬边界：

- HTTP-only：不发布可供游戏服直调的领域源码。
- MySQL-only：不连接游戏 Redis、游戏 MySQL 或 coord Redis。
- 单游戏：一套服务对应一个游戏和一套独立账号库。
- Public、Internal、Admin 端点分监听面注册。

## 本地启动

```bash
npm ci
cp .env.example .env
npm run migrate
npm run dev
```

必需配置：

- `GAME_MANAGE_KIT_MYSQL_URL`
- `GAME_MANAGE_KIT_SERVICE_SECRET`
- `GAME_MANAGE_KIT_ADMIN_SECRET`
- 生产环境另需 `WX_APPID`、`WX_SECRET`

默认监听为 Public `127.0.0.1:2570`、Internal/Admin `127.0.0.1:2571`。
使用容器 bridge 网络时，应把 `GAME_MANAGE_KIT_PUBLIC_HOST` 与
`GAME_MANAGE_KIT_INTERNAL_HOST` 配成 `0.0.0.0`，并只向受信网络发布 Internal 端口。
Public 登录与 Admin 写操作分别使用独立的进程内令牌桶；多实例的全局限流仍应由
LB/WAF 承担。

生产使用：

```bash
npm run build
GAME_MANAGE_KIT_MYSQL_URL=mysql://... node dist/migrate.js
npm start
```

镜像也包含同一 migration 入口，部署时应先以一次性 job 执行：

```bash
docker run --rm \
  -e GAME_MANAGE_KIT_MYSQL_URL=mysql://... \
  game-manage-kit:1.0.0 node dist/migrate.js
```

HTTP 契约真源是 `openapi/openapi.yaml`。修改契约后必须执行：

```bash
npm run generate:contract
npm run verify:contract
npm run check:contract-breaking
```

本地测试（集成测试会创建并删除一个名字唯一的临时空库）：

```bash
npm test
GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3316/mysql npm run test:int
```
