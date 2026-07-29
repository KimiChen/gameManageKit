# ADR 0001：以 `gameId` 作为强制租户边界

- 状态：已接受
- 日期：2026-07-28
- 修订：2026-07-28（Provider 身份命名空间与抖音登录）

## 背景

gameManageKit 需要由一套服务实例同时接入多个游戏和多个身份 Provider。外部身份、
账号、会话、角色、管理操作和区服目录都只在明确命名空间内有意义；相同 subject
不得跨游戏、微信、抖音或 AppID 自动合并。项目尚未上线，因此直接升级契约和数据库，
不提供双写兼容层。

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
- 微信和抖音的启用状态、AppID、AppSecret、endpoint、超时和熔断参数；
- 会话 TTL、登录限流和管理限流；
- Service 与机器 Admin 身份、游戏范围和 Secret 版本。

创建游戏时，在一个事务中创建：

- `games` 草稿记录；
- 空的 `game_directory_settings`；
- 默认 `game_integrations`；
- 默认禁用的 `game_identity_providers(wechat|douyin)`；
- `seq(game_id, 'user_id')`。

零游戏、零区服、缺少 AppSecret 和草稿游戏都是合法管理状态，不阻止进程启动或管理员
登录。至少一个启用 Provider 同时具备 AppID 与 AppSecret 时，项目自动变为
`configured`；没有可用 Provider 时回到 `draft + maintenance` 并取消客户端可见性。
区服不是配置完整度的前置条件，正常游戏可以合法返回空目录。

部署前必须存在的最小信任根仍保留在系统配置中：

- gameManageKit 自己的 MySQL 连接；
- TLS 私钥或反向代理证书；
- 首个个人管理员网页引导期间的 Internal/Admin 访问控制（一次性状态保存在 MySQL）；
- 监听地址、可信代理、请求和关闭超时等进程参数。

系统配置不包含任何每游戏 Provider 或机器 Secret。

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
Provider、微信/抖音 Client、会话 TTL、限流器和三个 revision：

- 游戏项目 revision；
- integration revision；
- 目录 revision。

Resolver 使用短 TTL、revision 比较和单航班刷新：

- 当前实例在管理员事务提交后立即失效对应 `gameId` 缓存；
- 其他实例在 TTL 到期后读取数据库 revision 并有界刷新；
- revision 未变化时复用上下文和状态对象；
- integration revision 变化时按 `gameId + provider` 重建对应 Client，并更新限流器；
- 目录查询始终以 MySQL 为准；
- 旧缓存不得无限期存活。

页面可以展示当前请求实例的 `loadedRevision`，但不得把它表述为所有实例已经生效。
第一阶段不引入额外消息中间件。

Provider AppSecret 不进入常规配置查询。只有首次调用对应 Provider 或 integration
revision 变化后需要构造 Client 时，Resolver 才从 MySQL 延迟读取当前明文，并只保留
在后端运行时内存。缓存与熔断按 `gameId + provider` 隔离；微信故障不能打开抖音熔断。
任何日志、错误、指标和管理 GET 响应都不得包含 Secret、code、`session_key` 或身份
原文。

### 外部身份命名空间

账号本体保存在 `accounts`，微信、抖音和 dev 身份保存在 `account_identities`。外部
身份唯一键固定为：

```text
(game_id, provider, provider_app_id, subject_type, subject)
```

Provider 只允许 `wechat | douyin | dev`；dev 固定使用 `provider_app_id=local` 和
`subject_type=dev_key`。登录只在相同游戏、Provider 和 AppID 内查找 openid，并把
同命名空间的可选 unionid 作为辅助身份。新账号与全部身份在一个事务中创建；并发唯一
键竞争后重新读取已有账号。openid 与 unionid 已指向不同账号时返回
`IDENTITY_CONFLICT`，禁止自动合并。

AppID 是身份命名空间。Provider 尚未产生身份时可通过普通管理接口修改；已有任意身份
后返回 `IDENTITY_PROVIDER_CONFLICT`。未来更换 AppID 必须通过独立、可审计的身份迁移
流程，不能静默给老玩家创建新账号。

### Secret 存储边界

Provider AppSecret 必须可恢复供 gameManageKit 调用上游，因此当前决策是直接明文
存入 `game_identity_providers.app_secret`。替换操作在单个事务中覆盖旧值、递增
Secret 和 integration 版本、记录操作者，并写入不含明文的独立审计。清除操作同时
禁用对应 Provider；数据库不保留旧 AppSecret，也不提供查看、复制、导出或历史值
API。Secret 元数据使用独立更新时间；只编辑 Provider 的非 Secret 参数不会让 Secret
看起来像刚刚轮换。

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
状态，不自动重复生成。Provider Secret 操作会持久保存不含明文的请求摘要和首次结果
快照：相同目标、revision 和内容的重放返回原 revision、版本与更新时间，后续配置变化
不会改变它；同一 operationId 搭配不同内容则拒绝。

### 管理员配置与权限

完成 migration 并启动服务后，Internal/Admin `/admin/` 会在尚未完成管理员引导时
进入首个管理员创建页。操作者自设账号、显示名和密码，服务端固定创建
`enabled + full-config` 管理员并关闭引导状态。引导状态是单调的一次性状态，多实例
并发下也只能完成一次；删除或停用全部管理员不会重新开放。管理员全部失效只能通过
受控数据库恢复流程处理。

由于创建首管前不存在可复用的管理员身份，初始化阶段的 Internal/Admin 监听面必须
只允许受信操作者访问，例如本机监听配合 SSH 隧道，或部署侧 mTLS、VPN 和严格访问
控制。`Origin` 校验只承担 CSRF 防护，不能作为首管身份凭据；未初始化监听面不得发布
到公网或共享网络。

首管创建成功后从空状态完成：

```text
创建草稿游戏
→ 配置目录和区服
→ 配置共享运行参数与微信/抖音 Provider
→ 重新认证并保存对应 AppSecret、启用至少一个 Provider
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

`accounts`、`account_identities`、`account_sessions`、`char_registry`、
`login_audit`、`seq`、`game_directory_settings`、`game_servers`、
`game_integrations`、`game_identity_providers` 和机器身份授权关系的每次业务读写都
必须显式保留租户边界：

- `SELECT`、`UPDATE`、`DELETE` 必须在条件中包含 `game_id`；
- `INSERT` 必须显式写入 `game_id`；
- 表连接必须同时连接 `game_id` 和领域键；
- 唯一约束和面向业务查询的索引必须包含 `game_id`；
- 不得仅凭 `userId`、`subject`、`operationId`、`serverId`、身份 ID 或 token 推断
  租户或 Provider 命名空间；
- 日志、审计、缓存键、限流键和幂等语义必须包含或校验 `gameId`。

机器身份 ID 是全局唯一键，其游戏范围保存在独立关联表；验证身份后仍必须检查目标
`gameId`。Secret 摘要全局唯一，不能跨身份、游戏或环境复用。

数据库通过外键阻止为不存在游戏创建账号、身份、会话、角色、区服、integration、
Provider 配置、授权和审计记录。`account_identities` 的复合外键保证 identity 与
account 的 `game_id` 一致；会话和角色使用 `(game_id, user_id)` 确认账号归属；区服
使用 `(game_id, server_id)` 作为租户内唯一标识。审计允许记录不存在的目标账号，
所以 `login_audit.user_id` 不引用账号表。

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

动态配置主体由 migration v3 提供，migration v4 增加单调的首管网页引导锁存器；
migration v5 新增 `game_identity_providers` 与 `account_identities`，把旧 dev/微信
身份迁入显式命名空间，随后移除 `accounts.openid/unionid` 和旧微信专用配置列。当前
服务要求 schema v5。

v5 不提供旧新结构双写，因此必须作为离线破坏性升级执行：先摘流并停止全部 v4 写
实例，再备份、迁移和启动 v5。执行账号需要临时 `CREATE ROUTINE` 权限；迁移 procedure
使用 `SQL SECURITY INVOKER` 并在成功后删除。迁移预检在首次创建目标表前完成；晚期
DDL 失败时保留已经回填的目标表和不含身份原文或 Secret 的阶段检查点。修复失败原因后
重新执行相同 migration，它会根据实际结构安全续跑，禁止删除已回填目标表。生产发布前
必须在等价数据副本演练升级、晚期失败续跑和恢复。

开发阶段曾直接改写初始 migration，因此执行过不受支持旧结构的本地数据库应删除并
重建；生产环境不得使用删库升级。受支持数据库按正常发布流程备份后执行：

```bash
npm run migrate
```

启动会核对 migration 版本和全部必需表。备份包含明文 Provider AppSecret，必须按生产
Secret 集合管理，并在隔离环境验证恢复后没有复活已撤销或过期机器 Secret。

## 结果

- 同一 subject 可以在不同游戏、Provider 和 AppID 中重复而不冲突；同一命名空间重复
  登录稳定解析为同一账号。
- 每个领域服务和 SQL 调用都显式保留 `gameId`；遗漏租户条件属于安全缺陷。
- 管理员可以从零游戏状态完成全部业务配置，保存后无需重启。
- 多实例通过短 TTL 和 revision 在有界时间内收敛，不依赖静态文件或消息中间件。
- 微信/抖音 AppSecret 只保留当前明文；Service 和机器 Admin Secret 只保留不可逆
  摘要。
- `/areas` 与登录共享准入规则，不会出现列表可见但登录被不同规则拒绝。
- `session_key` 仅在当前上游交换调用内存中短暂存在，不进入账号表、响应、日志或审计；
  若未来出现明确用途，需要另行设计加密、访问控制和清理策略。
