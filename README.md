# gameManageKit

gameManageKit 是多游戏独立账号门户服务。一套进程可接入多个游戏，并通过 HTTP
提供登录、会话校验、角色足迹、选服目录与账号管理能力。同一微信身份在不同游戏中
拥有相互隔离的账号。

硬边界：

- HTTP-only：不发布可供游戏服直调的领域源码。
- MySQL-only：不连接游戏 Redis、游戏 MySQL 或 coord Redis。
- 强租户隔离：HTTP、账号、会话、角色、审计和调用方权限都以 `gameId` 为边界。
- Public、Internal、Admin 端点分监听面注册。

## 本地启动

推荐直接使用本机 Homebrew MySQL 8.4。首次 checkout：

```bash
npm ci
cp .env.example .env

brew services start mysql@8.4
mysqladmin --protocol=tcp -h 127.0.0.1 -P 3306 -u root ping
mysql --protocol=tcp -h 127.0.0.1 -P 3306 -u root -e 'CREATE DATABASE IF NOT EXISTS game_manage_kit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'

npm run migrate
npm run dev
```

`npm run dev`、`npm run migrate`、`npm run migrate:prod` 和
`npm run test:int` 都会读取仓库根目录的 `.env`。如果本机 MySQL root 账号设有
密码，请在上述 MySQL 命令中增加 `-p`，并同步修改 `.env` 中的连接 URL。

必需配置：

- `GAME_MANAGE_KIT_MYSQL_URL`
- `GAME_MANAGE_KIT_GAMES_CONFIG`
- 生产环境的 `GAME_MANAGE_KIT_ADMIN_ORIGIN`
- 游戏配置中 `appIdEnv`、`secretEnv` 和各调用方 `secretEnv` 引用的全部环境变量

`AUTH_DEV_ENABLED` 默认关闭，只允许在 `NODE_ENV=development` 或 `test` 时显式设为
`1`。生产环境即使请求 dev-login 契约路径也固定返回 404。

仓库默认 `config/games.json` 会同时加载 `game-a` 与 `game-b`。`.env.example`
只包含可公开的本地开发占位值；生产密钥必须通过部署平台的 Secret 机制注入。
游戏与调用方接入步骤见 [游戏接入指南](docs/game-onboarding.md)。

默认监听为 Public `127.0.0.1:2570`、Internal/Admin `127.0.0.1:2571`。
使用容器 bridge 网络时，应把 `GAME_MANAGE_KIT_PUBLIC_HOST` 与
`GAME_MANAGE_KIT_INTERNAL_HOST` 配成 `0.0.0.0`，并只向受信网络发布 Internal 端口。
Public 登录与 Admin 写操作分别使用独立的进程内令牌桶；多实例的全局限流仍应由
LB/WAF 承担。

管理员网页位于 Internal/Admin origin 的 `/admin/`。完成 migration 并至少启动一次
服务以同步游戏配置后，创建个人管理员：

```bash
npm run admin:create -- --operator-id ops_kimi --display-name Kimi --games game-a,game-b --manage-games
```

命令使用系统加密随机源生成 16 位初始密码，并仅在创建成功后显示一次；请立即交付给
对应管理员并存入受控密码管理器。管理员密码不允许作为命令行参数。网页登录不会接收
或保存游戏配置里的 Admin Secret。`--manage-games` 显式授予新增、编辑游戏项目、
管理每个游戏的区服及配置客户端下发列表的全局能力；不需要该能力的账号请省略。
账号权限、HTTPS 反向代理、Cookie 和会话失效要求见
[管理员控制台运维指南](docs/admin-console.md)。

### 数据库维护

重复执行 migration 是安全的：

```bash
npm run migrate
```

需要从空库重新开始时，明确删除并重建本地开发库，然后重新迁移：

```bash
mysql --protocol=tcp -h 127.0.0.1 -P 3306 -u root -e 'DROP DATABASE IF EXISTS game_manage_kit; CREATE DATABASE game_manage_kit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
npm run migrate
```

停止 Homebrew 服务不会删除数据：

```bash
brew services stop mysql@8.4
```

### 可选：Docker MySQL

没有本机 MySQL 时，可以只用 Compose 启动数据库：

```bash
npm run mysql:docker:up
```

Compose 将 MySQL 绑定到 `127.0.0.1:3316`。此时把 `.env` 中
`GAME_MANAGE_KIT_MYSQL_URL` 的端口改为 `3316`，再运行 migration 和服务。
该 Compose 数据库使用空 root 密码且仅供本机开发，禁止用于共享或生产环境。

```bash
npm run migrate
npm run dev
```

停止容器会保留数据；清空命名卷会永久删除 Compose 本地数据库：

```bash
npm run mysql:docker:down
npm run mysql:docker:clean
```

不要让 Homebrew MySQL 与 Compose MySQL 使用同一个主机端口。

## 测试

单元与契约测试不要求数据库：

```bash
npm test
npm run test:web
```

集成测试会根据 `.env` 中的管理连接创建并删除名字唯一的临时数据库：

```bash
npm run test:int
```

使用 Compose MySQL 时，还要把 `.env` 中
`GAME_MANAGE_KIT_TEST_MYSQL_ADMIN_URL` 的端口改成 `3316`。该账号必须拥有
`CREATE DATABASE` 和 `DROP DATABASE` 权限。

Docker 可用时，还可以构建生产镜像并运行双游戏数据隔离冒烟测试：

```bash
npm run test:docker
npm run mysql:docker:down
```

冒烟测试会依次启动 MySQL、执行 migration、启动应用，再以同一个开发身份分别登录
`game-a` 与 `game-b`。它会核对两条租户账号记录、同游戏 token 校验、跨游戏 token
拒绝和 Service 凭证越权拒绝。Compose 数据卷默认保留；需要空库重测时先运行
`npm run mysql:docker:clean`。

## 生产部署

生产使用：

```bash
npm run build
node --env-file=.env.production dist/migrate.js
node --env-file=.env.production dist/main.js
```

`.env.production` 只表示由部署系统生成或挂载的运行时文件，不得提交到 Git。若平台直接
注入环境变量，则省略 `--env-file`；migration job 与服务进程必须使用同一组数据库和
游戏配置。

镜像也包含同一 migration 入口，部署时应先以一次性 job 执行：

```bash
docker run --rm -e GAME_MANAGE_KIT_MYSQL_URL=mysql://... game-manage-kit:1.0.0 node dist/migrate.js
```

生产镜像默认监听容器内 Public `0.0.0.0:2570` 与 Internal/Admin
`0.0.0.0:2571`，并通过 Public `/readyz` 执行健康检查。运行服务时仅公开
Public 端口；Internal/Admin 端口必须绑定到受信网络，例如：

```bash
docker run --rm --env-file .env.production -p 2570:2570 -p 127.0.0.1:2571:2571 game-manage-kit:1.0.0
```

生产配置中的微信接口与区服 URL 必须使用 `https/wss`。仓库默认多游戏配置已满足
启动校验，但其中 `.invalid` 区服域名和开发密钥只是安全占位值，部署前必须替换。
`GameRegistry` 的微信、限流和机器身份配置是启动快照；修改这些技术配置或密钥后需要
滚动重启实例。`directoryPath` 指向的区服文件只在该游戏首次同步时导入数据库，此后
不会在启动时覆盖运营修改。游戏展示信息、运行状态、客户端可见性、区服目录和开服
状态由数据库管理，可在管理员网页即时编辑。新建项目先处于 `draft`，只有补齐部署
配置并重启通过校验后才会成为 `configured`。
`/readyz` 同时检查数据库 schema 与 `GameRegistry`，只有返回 HTTP 200 才可接流量。
管理员 origin 必须配置为独立的 HTTPS 主机名，并且只代理 Internal/Admin 监听面；
不能只用同一主机的不同端口隔离 Public 和管理员 Cookie。

客户端从 Public 接口获取已配置且允许下发的游戏：

```bash
curl --fail http://127.0.0.1:2570/v1/games
```

`maintenance` 游戏会保留在列表中，便于客户端显示维护状态；`draft`、未勾选下发和
`disabled` 游戏不会返回。

客户端区服列表仍从具体游戏的 Public 接口获取：

```bash
curl --fail http://127.0.0.1:2570/v1/games/game-a/areas
```

只有后台勾选“已开放”的区服会下发，并按区服顺序和 `serverId` 排序。已开放但状态为
`maintenance` 的区服仍会下发，供客户端显示维护状态，但登录该区服会被拒绝；取消
“已开放”会将区服从列表移除并拒绝新登录。

### 可观测性

`/livez`、`/readyz` 和 `/version` 同时注册在两个监听面。Prometheus 文本指标只注册在
Internal/Admin 监听面的 `/metrics`，并要求一个有效的 Service 身份：

```bash
curl --fail -H 'x-service-id: game-a-service' -H "x-service-secret: ${GAME_A_SERVICE_SECRET}" http://127.0.0.1:2571/metrics
```

指标按该 Service 获准访问的 `gameId` 过滤，只使用有界的结果、surface 和数据库操作
标签；`userId`、token 与任意请求输入不会成为 label。请求日志会在可用时加入
`gameId`、`serviceId` 或 `operatorId`，并对 Authorization、token 和 secret 字段脱敏。

HTTP 契约真源是 `openapi/openapi.yaml`。修改契约后必须执行：

```bash
npm run generate:contract
npm run verify:contract
npm run check:contract-breaking
```
