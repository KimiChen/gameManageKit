# 游戏接入指南

gameManageKit 通过一个启动时加载的 `GameRegistry` 接入多个游戏。游戏普通配置存放在
JSON 文件中，所有微信、Service 和 Admin 密钥只通过环境变量或 Secret Manager 注入。
配置变更后需要滚动重启，不支持热加载。

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
文件；`serverId` 只要求在本游戏内唯一。生产环境的微信 endpoint、`gameHttpUrl` 和
`gameWsUrl` 必须分别使用 `https`、`https` 和 `wss`。开发环境只额外允许 loopback
地址使用 `http/ws`。

游戏状态含义：

- `enabled`：正常提供业务请求。
- `maintenance`：暂时停止业务请求，返回 HTTP 503 `GAME_DISABLED`。
- `disabled`：永久停用业务请求，返回 HTTP 403 `GAME_DISABLED`。

退役游戏不能从配置中删除，必须保留为 `disabled`；`disabled` 是不可逆状态，不能恢复
为 `enabled` 或 `maintenance`，`gameId` 也不能分配给另一个游戏。启动同步会校验这些
约束并拒绝不安全的配置。

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
curl --fail http://127.0.0.1:2570/v1/games/example-game/areas
```

`/readyz` 只有在数据库 schema 和 `GameRegistry` 都就绪时才返回 HTTP 200。发布时还应
验证该游戏 token 不能在其他游戏使用，Service/Admin 凭证不能越权访问其他游戏，
相同 `openid`、`operationId` 和 `serverId` 在两个游戏中互不影响。

## 4. 账号管理语义

`POST .../revoke` 只撤销该游戏、该账号的全部现有会话，不删除账号，也不阻止账号随后
重新登录。`POST .../ban` 会封禁该游戏内的账号并撤销其会话，不影响其他游戏中的同一
微信身份。

当前阶段明确不提供 `unban`、`deregister` 或账号恢复接口。需要这些能力时，应先定义
审计、授权和恢复语义，再扩展 OpenAPI；不能通过直接修改业务表绕过管理接口。
