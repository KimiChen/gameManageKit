# 游戏接入指南

gameManageKit 使用 MySQL 作为游戏项目、区服、微信参数、限流参数和机器身份的唯一业务
配置真源。运行时不读取 `config/games.json`、区服 JSON、`directoryPath` 或每游戏
Secret 环境变量。管理员保存后通过 revision 自动热更新，不需要把配置发布和滚动重启
绑定在一起。

## 0. 准备管理员

先完成 migration 并启动服务：

```bash
npm run migrate
npm run dev
```

打开 Internal/Admin origin 的 `/admin/`。系统从未完成管理员引导时，页面会进入
首个管理员创建流程；操作者设置个人账号、显示名和密码，服务端固定授予
`full-config` 权限。引导只允许成功一次，删除或停用管理员不会使它重新开放。

初始化期间必须保证 Internal/Admin 监听面只有受信操作者可达，例如通过本机监听与
SSH 隧道，或受控的 mTLS/VPN 入口访问；不能把未初始化端口发布到公网或共享网络。
创建并登录后，从“游戏项目”和“接入配置”完成以下步骤。Secret 写入与机器身份范围
修改会要求再次输入当前管理员密码，提升会话约 5 分钟。

## 1. 创建草稿游戏

在“游戏项目”创建项目：

- `gameId` 必须匹配 `^[a-z][a-z0-9-]{1,31}$`，即 2 至 32 个小写 ASCII 字母、数字或
  连字符，并以字母开头。
- `gameId` 创建后不可修改、删除或复用。
- 新项目固定为 `draft + maintenance`、`clientVisible=false`、`sortOrder=0`。
- 创建事务会同时建立空目录设置、默认接入配置和账号序列。

零游戏、草稿游戏和零区服都属于合法管理状态，不影响服务启动或管理员登录。

## 2. 配置目录和区服

在游戏项目中打开区服管理，先设置目录的 `isOps`，再创建全部区服。每个区服包含：

- `serverId`：0..65535，只在本游戏内唯一；不同游戏可以使用相同值。
- 名称和展示标签。
- 状态：`smooth`、`busy` 或 `maintenance`。
- Unix 秒 `openTime`。
- 游戏 HTTP 与 WebSocket URL。
- `isOpen` 和 0..65535 的 `sortOrder`。

生产 URL 必须分别使用 `https://` 和 `wss://`；开发环境只额外允许 loopback 的
`http://` 和 `ws://`。`serverId` 创建后不可修改，第一阶段也不物理删除区服；退役时
设置 `isOpen=false`。

目录设置和区服共用目录级 revision。任何新增或编辑都会在同一事务中递增
`directoryRevision`；HTTP 409 表示其他管理员已经修改，刷新后再确认。

Public `/areas` 与登录共用以下准入规则：

```text
游戏 configurationState = configured
AND 游戏 status = enabled
AND 区服 isOpen = true
AND 区服 status IN (smooth, busy)
AND 区服 openTime <= 当前时间
```

维护、未开放或尚未到开放时间的区服不会下发，也不能登录。正常游戏暂时没有可进入
区服时，`/areas` 返回 HTTP 200 和空 `servers`。

## 3. 配置微信和运行参数

在独立“接入配置”页面填写：

- 微信 AppID 和 endpoint。
- 微信请求 timeout、熔断阈值和熔断开启时间。
- 玩家会话 TTL。
- 登录与管理接口的令牌桶 capacity 和 refill rate。

普通参数保存使用 integration `revision` 乐观锁，不包含 Secret。生产微信 endpoint
必须为 HTTPS。

随后选择“替换 AppSecret”，完成重新认证并输入新值。请求携带当前 revision 和唯一
`operationId`；同一个 operationId 的重放不会再次覆盖或递增版本。AppID 与 AppSecret
都存在后，项目自动从 `draft` 变为 `configured`。

微信 AppSecret 的边界：

- AppSecret 以明文保存在 `game_integrations`，替换时直接覆盖旧值。
- GET API 和网页永不返回明文，只返回是否配置、版本和更新时间。
- 管理页面的输入框永远为空；成功、失败、关闭、冲突或会话过期后立即清空。
- 成功保存只表示 gameManageKit 已持久化，不能宣称微信侧已经验证。
- 数据库 TLS、最小权限、磁盘/快照/备份加密和脱敏恢复属于部署强制项。

不要把 AppSecret 放入环境变量、URL、Hash、命令行、日志、工单、浏览器存储或普通
审计。

## 4. 创建机器身份

接入配置页可以创建两类身份：

- `service`：游戏服务调用 Internal API 和指标。
- `machine_admin`：受信自动化调用账号管理 API，不用于浏览器登录。

为每个身份选择最小 `gameIds` 范围。身份 ID 全局唯一；不同游戏、环境和调用程序不得
共享身份或 Secret。创建时服务端生成 32 字节随机值并返回 43 位 Base64URL Secret，
MySQL 只保存 SHA-256 摘要。

明文只在首次成功响应中显示一次。请在关闭对话框前复制到对应服务的 Secret Manager
并确认已安全保存；之后无法查询或恢复，丢失只能轮换。不要把 Secret 写入仓库、镜像、
普通配置表或日志。

调用 Service API 时使用：

```text
x-service-id: <identityId>
x-service-secret: <one-time Secret>
```

受信机器 Admin 使用：

```text
x-operator-id: <identityId>
x-admin-secret: <one-time Secret>
```

服务端先验证当前或未过期 previous 摘要，再检查请求 URL 中的 `gameId` 是否属于身份
范围；客户端不能通过修改路径扩大权限。

### 无停机轮换

轮换时指定 previous 的有效窗口。服务端生成新的 current，将原 current 变为带明确
失效时间的 previous；窗口内新旧 Secret 都可用。更新调用方后，可以等待窗口到期，
也可以明确撤销旧版本。

轮换请求使用唯一 `operationId`。网络超时或 HTTP 5xx 后不要盲目再次发起轮换，应先
查询该 operationId 的状态；幂等重放不会再次返回已交付过的明文。修改游戏范围、轮换
和撤销都需要对应权限与最近重新认证。

## 5. 启用并验收

接入完整后，在游戏项目中将状态改为 `enabled`，并按需要开启 `clientVisible` 和设置
排序。`disabled` 是不可逆终态；缺少 AppID 或 AppSecret 时，项目会回到
`draft + maintenance` 并取消客户端可见性。

基本检查：

```bash
curl --fail http://127.0.0.1:2570/readyz
curl --fail http://127.0.0.1:2570/v1/games
curl --fail http://127.0.0.1:2570/v1/games/example-game/areas
```

还应验证：

- 相同微信身份分别登录两个游戏时，账号与 token 相互隔离。
- A 游戏 token 不能在 B 游戏验证。
- Service 和机器 Admin 不能访问范围外游戏。
- 不同游戏可以安全使用相同 `serverId`。
- 新旧 Service Secret 在轮换窗口内都可用，到期或撤销后旧值被拒绝。
- AppSecret GET 响应、机器身份 GET 响应、日志、审计和指标中没有明文或摘要。
- 管理页面显示的保存 revision 与当前实例 loaded revision 符合预期；不要把单实例状态
  解读为所有实例已经同步。

## 6. 账号管理语义

`POST .../revoke` 只撤销该游戏、该账号的全部现有会话，不删除账号，也不阻止账号随后
重新登录。`POST .../ban` 会封禁当前游戏内账号并撤销其会话，不影响其他游戏中的同一
微信身份。

当前不提供 `unban`、`deregister` 或账号恢复接口。需要这些能力时，应先定义审计、
授权和恢复语义，再扩展 OpenAPI，不能通过直接修改业务表绕过管理 API。
