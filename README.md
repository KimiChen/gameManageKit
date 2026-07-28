# gameManageKit

gameManageKit 是多游戏独立账号门户服务。一套进程通过 HTTP 提供登录、会话校验、
角色足迹、选服目录和账号管理能力。同一微信身份在不同游戏中拥有相互隔离的账号。

核心边界：

- HTTP-only：不发布供游戏服直调的领域源码。
- MySQL-only：不连接游戏 Redis、游戏 MySQL 或 coord Redis。
- 强租户隔离：账号、会话、角色、审计和调用方权限都以 `gameId` 为边界。
- Public、Internal/Admin 端点分监听面注册。
- MySQL 是游戏、区服、接入参数和机器身份的唯一业务配置真源。

运行时不读取游戏或区服 JSON，也不从环境变量读取每游戏微信、Service 或机器 Admin
Secret。管理员保存配置后，当前实例立即失效缓存，其他实例在有界 TTL 内按数据库
revision 刷新，无需人工重启。

## 本地启动

推荐使用 MySQL 8.4。首次 checkout：

```bash
npm ci
cp .env.example .env

brew services start mysql@8.4
mysqladmin --protocol=tcp -h 127.0.0.1 -P 3306 -u root ping
mysql --protocol=tcp -h 127.0.0.1 -P 3306 -u root \
  -e 'CREATE DATABASE IF NOT EXISTS game_manage_kit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'

npm run migrate
npm run dev
```

服务启动后打开 Internal/Admin origin 的 `/admin/`。系统尚未创建过管理员时，页面
会进入首个管理员创建流程；操作者设置个人账号、显示名和密码，服务端固定授予
`full-config` 权限并建立管理员会话。这个引导开关只允许完成一次：即使之后从数据库
删除或停用全部管理员，也不会自动重新开放。

首次初始化没有可复用的管理员凭据，因此初始化期间必须确保 Internal/Admin origin
只有受信操作者可达，例如只监听本机并通过 SSH 隧道访问，或在反向代理前使用
mTLS、VPN 与访问控制。`Origin` 校验是 CSRF 防护，不是首个操作者的身份证明，不能
把尚未初始化的 Internal/Admin 端口直接发布到公网或共享网络。完整要求见
[管理员控制台运维指南](docs/admin-console.md)。

从空库开始的配置顺序是：

1. 在 `/admin/` 创建首个管理员并登录。
2. 创建草稿游戏项目。
3. 配置目录设置和全部区服；没有区服也是合法状态。
4. 在独立“接入配置”页面保存微信 AppID、调用参数和 AppSecret。
5. 创建 Service 或机器 Admin 身份，安全保存只显示一次的 Secret。
6. 游戏变为 `configured` 后，再按需要切换为 `enabled` 并允许客户端发现。

完整流程见[游戏接入指南](docs/game-onboarding.md)。

### 系统级环境变量

必需的部署信任根只有：

- `GAME_MANAGE_KIT_MYSQL_URL`
- 生产环境的 `GAME_MANAGE_KIT_ADMIN_ORIGIN`

监听地址、MySQL 连接池、可信代理、请求体上限、请求/关闭超时和日志开关都是可选的
进程级配置，示例见 [.env.example](.env.example)。`AUTH_DEV_ENABLED` 默认关闭，只允许
在 `NODE_ENV=development` 或 `test` 时显式设为 `1`；生产即使请求 dev-login 路径也
固定返回 404。

`npm run dev`、migration 和集成测试都会读取仓库根目录的 `.env`。
本地 MySQL root 有密码时，请同步修改连接 URL。默认监听为 Public
`127.0.0.1:2570`、Internal/Admin `127.0.0.1:2571`。容器 bridge 网络应将两个 host
设置为 `0.0.0.0`，但只向受信网络发布 Internal/Admin 端口。

### 数据库维护

重复执行 migration 是安全的：

```bash
npm run migrate
```

需要从空库重新开始时，明确删除并重建本地开发库：

```bash
mysql --protocol=tcp -h 127.0.0.1 -P 3306 -u root \
  -e 'DROP DATABASE IF EXISTS game_manage_kit; CREATE DATABASE game_manage_kit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
npm run migrate
```

停止 Homebrew 服务不会删除数据：

```bash
brew services stop mysql@8.4
```

### 可选：Docker MySQL

没有本机 MySQL 时，可以只启动 Compose 数据库：

```bash
npm run mysql:docker:up
```

MySQL 绑定到 `127.0.0.1:3316`。将 `.env` 中业务和测试管理连接的端口改为 `3316`，
再运行 migration 和服务。Compose 使用空 root 密码，仅供单机开发，禁止用于共享或
生产环境。

```bash
npm run migrate
npm run dev
```

停止容器会保留数据；以下命令会永久删除 Compose 本地数据库卷：

```bash
npm run mysql:docker:down
npm run mysql:docker:clean
```

## 测试

单元、契约和网页测试不要求数据库：

```bash
npm test
npm run test:web
```

集成测试根据 `.env` 中的管理连接创建并删除名字唯一的临时数据库：

```bash
npm run test:int
```

`GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL` 对应账号必须拥有测试环境的
`CREATE DATABASE` 和 `DROP DATABASE` 权限。

Docker 可用时，可以构建生产镜像并执行动态配置冒烟测试：

```bash
npm run mysql:docker:clean
npm run test:docker
npm run mysql:docker:down
```

冒烟测试必须使用尚未完成管理员引导的新数据库。它先通过
`GET/POST /v1/admin/bootstrap` 创建一次性首管并取得会话，再只通过管理员 API 创建
两个游戏、区服、微信接入和机器身份。它验证租户账号隔离、Service 越权拒绝、机器
Admin 范围、Secret 摘要和无停机轮换。测试不依赖静态游戏文件或每游戏环境变量；
命名卷会保留引导完成状态，再次测试前必须运行 `npm run mysql:docker:clean`。

## 生产部署

生产发布顺序：

```bash
npm run build
node --env-file=.env.production dist/migrate.js
node --env-file=.env.production dist/main.js
```

`.env.production` 由部署系统生成或挂载，不得提交到 Git。migration job 与服务进程
必须指向同一数据库；不再需要游戏配置文件或每游戏 Secret 环境变量。容器也提供相同
migration 入口：

```bash
docker run --rm \
  -e 'GAME_MANAGE_KIT_MYSQL_URL=mysql://...?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D' \
  game-manage-kit:1.0.0 node dist/migrate.js
```

生产进程会拒绝缺少 `ssl`、关闭证书校验或未实际协商出 TLS cipher 的 MySQL
连接。私有 CA 可按 mysql2 的 `ssl` JSON 参数传入，或使用受支持的可信 SSL profile；
数据库账号仍应设置服务端 `REQUIRE SSL` 作为纵深防御。

生产镜像默认监听容器内 Public `0.0.0.0:2570` 与 Internal/Admin
`0.0.0.0:2571`。只公开 Public 端口；Internal/Admin 必须位于受信网络和独立 HTTPS
origin 后，例如：

```bash
docker run --rm --env-file .env.production \
  -p 2570:2570 \
  -p 127.0.0.1:2571:2571 \
  game-manage-kit:1.0.0
```

服务允许在零游戏、零区服和草稿游戏状态启动。`/readyz` 校验数据库连接、schema 和
动态配置 Resolver；合法的未完成业务配置不会阻止管理员继续配置。

生产环境还必须在应用外落实以下信任边界：

- 应用与 MySQL 强制 TLS，应用账号使用最小权限。
- 仅 gameManageKit 运行账号可以读取明文 `wechat_app_secret`；禁止任意导出、复制和
  数据库管理权限。
- MySQL 数据盘、快照和备份加密，限制下载并记录访问审计。
- 测试/开发环境不得直接恢复生产备份；脱敏副本必须删除 AppSecret。
- 反向代理、WAF、APM、SQL/慢查询和错误追踪不得采集 Secret 路由请求体。
- 定期在隔离环境演练恢复；疑似泄露后替换微信 AppSecret，并轮换全部机器 Secret。

微信 AppSecret 按设计以明文保存在 MySQL，替换会覆盖旧值。Service 与机器 Admin
Secret 由服务端生成，数据库只保存 SHA-256 摘要，明文仅在创建或轮换响应中显示一次。
这两类 Secret 都不会通过 GET API 回显。

## 接口与运行规则

客户端发现可下发游戏：

```bash
curl --fail http://127.0.0.1:2570/v1/games
```

客户端获取当前可进入的区服：

```bash
curl --fail http://127.0.0.1:2570/v1/games/example-game/areas
```

`/areas` 与登录共用一条准入规则：游戏必须 `configured + enabled`，区服必须
`isOpen=true`、状态为 `smooth|busy`，且 `openTime` 已到。正常游戏没有可进入区服时
返回 HTTP 200 和空列表；维护、未开放或未来开服的区服都不下发。含角色足迹的响应
始终使用 `Cache-Control: private, no-store` 和 `Vary: Authorization`。

### 可观测性

`/livez`、`/readyz` 和 `/version` 同时注册在两个监听面。Prometheus 指标只在
Internal/Admin 的 `/metrics` 提供，并要求数据库中已启用且具备对应游戏范围的
Service 身份：

```bash
curl --fail \
  -H "x-service-id: ${SERVICE_ID}" \
  -H "x-service-secret: ${SERVICE_SECRET}" \
  http://127.0.0.1:2571/metrics
```

`SERVICE_SECRET` 应从受控 Secret Manager 注入调用进程，不要写入仓库或普通日志。
指标只使用有界标签；请求日志会关联 `gameId`、`serviceId` 或 `operatorId`，并脱敏
Authorization、Token、Cookie、密码和全部 Secret 字段。

HTTP 契约真源是 `openapi/openapi.yaml`。修改契约后执行：

```bash
npm run generate:contract
npm run verify:contract
npm run check:contract-breaking
```
