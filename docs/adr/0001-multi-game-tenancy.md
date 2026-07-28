# ADR 0001：以 `gameId` 作为强制租户边界

- 状态：已接受
- 日期：2026-07-28
- 修订：2026-07-28（管理员动态配置）

## 背景

gameManageKit 需要由一套服务实例同时接入多个游戏。微信身份、账号、会话、角色、
管理操作和区服目录都只在所属游戏内有意义；同一微信身份在不同游戏中应得到相互独立的
账号。项目尚未上线，因此直接替换原有单游戏契约和初始数据库，不提供兼容层。

早期设计曾考虑从静态 JSON 和每游戏环境变量构造启动快照，并用区服文件做首次导入。
该方案会把业务配置发布绑定到进程重启，难以支持空状态接入、多实例收敛、Secret
轮换和一致审计，现已废弃。以下决策描述当前唯一有效的动态配置方案。

## 决策

### 稳定标识

`gameId` 是创建后不可修改的租户标识，同时用于 HTTP 路径、数据库 `game_id`、缓存键、
日志和审计字段。它必须：

- 长度为 2 至 32 个 ASCII 字符；
- 匹配 `^[a-z][a-z0-9-]{1,31}$`；
- 由小写字母开头，后续只允许小写字母、数字和连字符；
- 不复用已停用游戏的标识。

OpenAPI、管理员写入校验、运行时 Resolver 和数据库 `CHECK` 约束使用同一规则。展示
名称不承担标识职责。

### 游戏状态与配置状态

运行状态：

- `enabled`：允许处理游戏业务请求；
- `maintenance`：临时停止游戏业务请求；
- `disabled`：永久停止业务请求，不能恢复。

配置状态：

- `draft`：允许管理员继续配置，但不能进入 Public 业务；
- `configured`：必需接入配置已经完整。

`maintenance` 和 `disabled` 的业务请求都使用 `GAME_DISABLED`：维护状态返回 HTTP
503，停用状态返回 HTTP 403。未知游戏返回 HTTP 404 `GAME_NOT_FOUND`。`/livez`、
`/readyz`、`/version` 和 Internal `/metrics` 是进程级端点，不属于任何游戏，也不接收
`gameId`。

网页和数据库约束共同禁止草稿启用、草稿下发、停用游戏下发以及恢复已停用游戏。
`disabled` 游戏及其历史数据继续保留，避免标识复用重新暴露旧账号、会话或角色。

### MySQL 是唯一业务配置真源

以下配置全部由管理员 API 写入 MySQL：

- 游戏名称、说明、运行状态、客户端可见性和顺序；
- 目录 `isOps`、目录 revision 和全部区服；
- 微信 AppID、AppSecret、endpoint、超时和熔断参数；
- 会话 TTL、登录限流和管理限流；
- Service 与机器 Admin 身份、游戏范围和 Secret 版本。

创建游戏时，在一个事务中创建：

- `games` 草稿记录；
- 空的 `game_directory_settings`；
- 默认 `game_integrations`；
- `seq(game_id, 'user_id')`。

零游戏、零区服、缺少 AppSecret 和草稿游戏都是合法管理状态，不阻止进程启动或管理员
登录。AppID 与 AppSecret 都存在时，项目自动变为 `configured`；任一缺失时回到
`draft + maintenance` 并取消客户端可见性。区服不是配置完整度的前置条件，正常游戏
可以合法返回空目录。

部署前必须存在的最小信任根仍保留在系统配置中：

- gameManageKit 自己的 MySQL 连接；
- TLS 私钥或反向代理证书；
- 首个个人管理员的 CLI 引导流程；
- 监听地址、可信代理、请求和关闭超时等进程参数。

系统配置不包含任何每游戏微信或机器 Secret。

### 动态解析与多实例收敛

启动顺序固定为：

```text
加载系统级配置
→ 连接 MySQL
→ 校验 migration
→ 初始化 GameConfigResolver
→ 校验已配置游戏的运行时元数据
→ 启动 Public 与 Internal/Admin 服务
```

业务请求只通过 `GameConfigResolver.resolve(gameId)` 获取游戏上下文，包括状态、目录
Provider、微信 Client、会话 TTL、限流器和三个 revision：

- 游戏项目 revision；
- integration revision；
- 目录 revision。

Resolver 使用短 TTL、revision 比较和单航班刷新：

- 当前实例在管理员事务提交后立即失效对应 `gameId` 缓存；
- 其他实例在 TTL 到期后读取数据库 revision 并有界刷新；
- revision 未变化时复用上下文和状态对象；
- integration revision 变化时重建该游戏的微信 Client 和限流器；
- 目录查询始终以 MySQL 为准；
- 旧缓存不得无限期存活。

页面可以展示当前请求实例的 `loadedRevision`，但不得把它表述为所有实例已经生效。
第一阶段不引入额外消息中间件。

微信 AppSecret 不进入常规配置查询。只有首次调用微信或 integration revision 变化后
需要构造 Client 时，Resolver 才从 MySQL 读取当前明文，并只保存在后端运行时内存。
任何日志、错误、指标和管理 GET 响应都不得包含该值。

### Secret 存储边界

微信 AppSecret 必须可恢复供 gameManageKit 调用微信，因此当前决策是直接明文存入
`game_integrations.wechat_app_secret`。替换操作在单个事务中覆盖旧值、递增 Secret
和 integration 版本、记录操作者，并写入不含明文的独立审计。数据库不保留旧
AppSecret，也不提供查看、复制、导出或历史版本 API。

该决策把 MySQL 纳入生产 Secret 边界：

- 应用与 MySQL 强制 TLS；
- 只有 gameManageKit 运行账号可以读取 AppSecret；
- 运行账号不得拥有任意导出、复制或数据库管理权限；
- 数据盘、快照和备份必须加密、限制下载并记录访问；
- 测试和开发环境不得直接恢复生产备份；
- SQL/慢查询日志、代理、WAF、APM 和错误追踪不得采集 Secret 请求体。

Service 和机器 Admin Secret 不需要恢复原文。它们由服务端使用 32 字节加密随机值
生成，首次创建或轮换响应只显示一次；MySQL 只保存 SHA-256 摘要。验证使用常量时间
比较，并只接受：

- 当前 `current` 版本；
- 尚未到期的一个 `previous` 版本。

轮换为 previous 设置明确失效时间；到期或撤销后旧值立即拒绝。一次性明文丢失只能
再次轮换，不能查询恢复。Secret 请求使用唯一 `operationId`；未知网络结果先查询操作
状态，不自动重复生成。

### 管理员配置与权限

首个个人管理员通过 CLI 创建，随后在 Internal/Admin `/admin/` 从空状态完成：

```text
创建草稿游戏
→ 配置目录和区服
→ 配置微信与运行参数
→ 重新认证并保存 AppSecret
→ 创建 Service/机器 Admin 身份及最小游戏范围
→ 启用游戏和客户端可见性
```

普通游戏、区服和非 Secret 参数使用各自 revision 乐观锁。Secret 修改与普通编辑使用
独立能力，并要求最近重新认证。机器身份范围修改也要求提升会话。所有授权都在写事务内
重新读取管理员状态、权限、`auth_version` 和提升期限，不能信任浏览器缓存的按钮或
会话快照。

Secret 明文不得进入 URL、Hash、Toast、`aria-live`、浏览器存储、日志、通用审计或
错误响应。机器 Secret 只在首次成功响应中出现，并使用 `Cache-Control: no-store`。

### 调用方授权范围

Service 和机器 Admin 身份由“身份、类型、状态、允许访问的 `gameId` 集合和 Secret
版本”组成。认证只说明调用方是谁；只有路径中的 `gameId` 出现在该身份范围中才获得
授权，否则返回 `GAME_ACCESS_DENIED`。客户端提交的 `gameId` 不能扩大权限。

Service 用于 Internal API 和指标；机器 Admin 用于受信自动化的账号管理 API。浏览器
管理员使用个人账号、密码和 HttpOnly Cookie，这三类身份不能互换。

Public 请求也必须先解析路径中的 `gameId`。访问令牌包含 `gameId`，验证时必须同时匹配
令牌租户、HTTP 路径租户和数据库租户。

### 数据访问不变量

`accounts`、`account_sessions`、`char_registry`、`login_audit`、`seq`、
`game_directory_settings`、`game_servers`、`game_integrations` 和机器身份授权关系的
每次业务读写都必须显式保留租户边界：

- `SELECT`、`UPDATE`、`DELETE` 必须在条件中包含 `game_id`；
- `INSERT` 必须显式写入 `game_id`；
- 表连接必须同时连接 `game_id` 和领域键；
- 唯一约束和面向业务查询的索引必须包含 `game_id`；
- 不得仅凭 `userId`、`openid`、`operationId`、`serverId`、身份 ID 或 token 推断
  租户；
- 日志、审计、缓存键、限流键和幂等语义必须包含或校验 `gameId`。

机器身份 ID 是全局唯一键，其游戏范围保存在独立关联表；验证身份后仍必须检查目标
`gameId`。Secret 摘要全局唯一，不能跨身份、游戏或环境复用。

数据库通过外键阻止为不存在游戏创建账号、会话、角色、区服、integration、授权和
审计记录。会话和角色使用 `(game_id, user_id)` 确认账号归属；区服使用
`(game_id, server_id)` 作为租户内唯一标识。审计允许记录不存在的目标账号，所以
`login_audit.user_id` 不引用账号表。

### 统一区服准入

Public `/areas` 和登录必须调用同一条准入规则：

```text
游戏 configuration_state = configured
AND 游戏 status = enabled
AND game_servers.is_open = true
AND game_servers.status IN (smooth, busy)
AND game_servers.open_time <= 当前时间
```

未知区服返回 HTTP 404 `SERVER_NOT_FOUND`；已配置但当前不可进入的区服返回 HTTP 403
`SERVER_DISABLED`。正常游戏没有可进入区服时，`/areas` 返回 HTTP 200 和空
`servers`。带角色足迹的响应使用 `Cache-Control: private, no-store` 和
`Vary: Authorization`。

### Schema 演进

当前动态配置结构由 migration v3 提供，包括 integration、目录 revision、机器身份、
机器 Secret 版本、管理员配置权限、提升会话和 Secret 审计。

开发阶段曾直接改写初始 migration，因此执行过不受支持旧结构的本地数据库应删除并
重建；生产环境不得使用删库升级。受支持数据库按正常发布流程备份后执行：

```bash
npm run migrate
```

启动会核对 migration 版本和全部必需表。备份包含明文微信 AppSecret，必须按生产
Secret 集合管理，并在隔离环境验证恢复后没有复活已撤销或过期机器 Secret。

## 结果

- 同一 `openid`、`unionid`、`userId`、`operationId` 和 `serverId` 可以在不同游戏中
  重复而不冲突。
- 每个领域服务和 SQL 调用都显式保留 `gameId`；遗漏租户条件属于安全缺陷。
- 管理员可以从零游戏状态完成全部业务配置，保存后无需重启。
- 多实例通过短 TTL 和 revision 在有界时间内收敛，不依赖静态文件或消息中间件。
- 微信 AppSecret 只保留当前明文；Service 和机器 Admin Secret 只保留不可逆摘要。
- `/areas` 与登录共享准入规则，不会出现列表可见但登录被不同规则拒绝。
- `accounts.session_key` 不保存微信明文会话密钥；若未来出现明确用途，需要另行设计
  加密、访问控制和清理策略。
