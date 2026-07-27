# 游戏接入指南

gameManageKit 使用两层游戏模型：MySQL 保存展示名称、说明、运行状态、客户端下发
设置和区服目录；启动时加载的 `GameRegistry` 保存微信、限流及机器身份等技术接入
配置。所有微信、Service 和 Admin 密钥只通过环境变量或 Secret Manager 注入。技术
配置变更后需要滚动重启；数据库中的非敏感游戏和区服元数据可由管理员网页即时编辑。

## 0. 在管理员网页创建项目

具备 `can_manage_games` 能力的管理员可在 `/admin/#games` 新增游戏项目。新项目固定为
`draft + maintenance`，默认不向客户端下发。`gameId` 创建后不可修改、删除或复用。

网页只管理以下非敏感字段：

- 展示名称与客户端说明；
- `enabled`、`maintenance`、`disabled` 运行状态；
- 游戏是否下发给客户端及展示顺序；
- 每个区服的名称、标签、状态、开放时间、HTTP/WebSocket URL、开服开关及顺序。

网页不接收目录路径、微信 endpoint、环境变量名或任何 Secret。新项目必须继续按下文
补齐 JSON、用于首次导入的区服文件、环境变量和机器身份范围；服务重启通过完整校验
后，项目才会从 `draft` 原子变为 `configured`。`draft` 不能启用或下发，`disabled`
是不可逆终态。

## 1. 定义游戏和区服目录

在 `GAME_MANAGE_KIT_GAMES_CONFIG` 指向的文件中增加游戏。`gameId` 创建后不可复用或
修改，必须匹配 `^[a-z][a-z0-9-]{1,31}$`，即 2 至 32 个小写 ASCII 字母、数字或
连字符，并以字母开头。

```json
{
  "gameId": "example-game",
  "status": "enabled",
  "directoryPath": "areas.example-game.json",
  "sessionTtlSeconds": 259200,
  "wechat": {
    "appIdEnv": "EXAMPLE_GAME_WX_APPID",
    "secretEnv": "EXAMPLE_GAME_WX_SECRET",
    "endpoint": "https://api.weixin.qq.com/sns/jscode2session",
    "timeoutMs": 3000,
    "breakerThreshold": 5,
    "breakerOpenMs": 10000
  },
  "loginRate": {
    "capacity": 5,
    "refillPerSecond": 0.2
  },
  "adminRate": {
    "capacity": 10,
    "refillPerSecond": 1
  }
}
```

相对的 `directoryPath` 以游戏配置文件所在目录为基准。每个游戏必须使用独立的目录
文件；`serverId` 只要求在本游戏内唯一。该文件是首次接入的种子数据：当数据库中还
没有该游戏的 `game_directory_settings` 时，服务一次性导入 `isOps` 和全部区服，
默认令每个区服 `isOpen=true`，并按文件顺序生成 `sortOrder`。导入完成后，数据库是
唯一真源；后续启动不会用文件覆盖后台修改。

生产环境的微信 endpoint、`gameHttpUrl` 和 `gameWsUrl` 必须分别使用 `https`、
`https` 和 `wss`。开发环境只额外允许 loopback 地址使用 `http/ws`。首次导入后可在
管理员网页新增或编辑区服，无需修改区服文件或重启。

区服开放与维护是两个正交状态：

- `isOpen=false`：不向客户端下发，登录和角色登记等需要可用区服的入口会拒绝访问。
- `isOpen=true`、`status=maintenance`：仍向客户端下发，方便展示维护提示，但登录会
  被拒绝。
- `isOpen=true`、`status=smooth|busy`：正常下发并允许登录。

区服按 `sortOrder, serverId` 下发。`serverId` 创建后不可修改或删除；编辑必须携带
当前 `revision`，冲突时刷新最新数据后再提交。

JSON 中的状态用于项目首次接入时初始化数据库；项目成为 `configured` 后，数据库状态
是请求处理和客户端列表的真源。游戏状态含义：

- `enabled`：正常提供业务请求。
- `maintenance`：暂时停止业务请求，返回 HTTP 503 `GAME_DISABLED`。
- `disabled`：永久停用业务请求，返回 HTTP 403 `GAME_DISABLED`。

已接入游戏不能从配置中删除；即使已在网页永久停用，也必须保留对应技术配置，确保
历史租户标识不被误用。`disabled` 不能恢复为 `enabled` 或 `maintenance`，`gameId`
也不能分配给另一个游戏。启动同步允许配置文件暂时缺少尚未接入的 `draft`，但会拒绝
遗漏任何 `configured` 游戏。

## 2. 配置调用方权限

在同一文件的 `serviceIdentities` 和 `adminIdentities` 中配置最小游戏范围：

```json
{
  "serviceId": "example-game-server",
  "secretEnv": "EXAMPLE_GAME_SERVICE_SECRET",
  "gameIds": ["example-game"]
}
```

```json
{
  "operatorId": "example-game-admin",
  "secretEnv": "EXAMPLE_GAME_ADMIN_SECRET",
  "gameIds": ["example-game"]
}
```

轮换时可以临时增加 `previousSecretEnv`。不同 Service/Admin 身份不得复用相同密钥；
每个 Secret 必须是 16 至 512 个字符；客户端传入的 `gameId` 也不能扩大配置中的授权
范围。

## 3. 注入密钥并验收

将 JSON 中引用的环境变量写入本地 `.env`，或通过部署平台注入。不要把真实值提交到
Git、普通业务表或日志。

启动前执行：

```bash
npm run migrate
npm run typecheck
npm test
npm run test:int
npm run build
```

启动后确认：

```bash
curl --fail http://127.0.0.1:2570/readyz
curl --fail http://127.0.0.1:2570/v1/games
curl --fail http://127.0.0.1:2570/v1/games/example-game/areas
```

`/readyz` 只有在数据库 schema 和 `GameRegistry` 都就绪时才返回 HTTP 200。发布时还应
验证该游戏 token 不能在其他游戏使用，Service/Admin 凭证不能越权访问其他游戏，
相同 `openid`、`operationId` 和 `serverId` 在两个游戏中互不影响。

Public `GET /v1/games` 只返回 `configured`、显式勾选下发且状态为 `enabled` 或
`maintenance` 的项目，并按管理员设置的顺序排序。维护中的游戏保留在列表中供客户端
显示维护提示；`draft`、未勾选下发和 `disabled` 项目不会返回。

Public `GET /v1/games/{gameId}/areas` 只返回 `isOpen=true` 的区服，并按
`sortOrder, serverId` 排序。公开的 `AreaServer` 结构不包含 `isOpen`、`sortOrder`、
`revision` 或审计时间；这些字段仅用于管理员接口。

## 4. 账号管理语义

`POST .../revoke` 只撤销该游戏、该账号的全部现有会话，不删除账号，也不阻止账号随后
重新登录。`POST .../ban` 会封禁该游戏内的账号并撤销其会话，不影响其他游戏中的同一
微信身份。

当前阶段明确不提供 `unban`、`deregister` 或账号恢复接口。需要这些能力时，应先定义
审计、授权和恢复语义，再扩展 OpenAPI；不能通过直接修改业务表绕过管理接口。
