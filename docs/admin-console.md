# 管理员控制台运维指南

管理员控制台只部署在 Internal/Admin 监听面，入口为 `/admin/`。浏览器管理员使用
数据库中的个人账号和 HttpOnly 会话 Cookie。Service 与机器 Admin 身份只供受信程序
调用，不能用于网页登录。

## 创建首个管理员

先完成数据库 migration，再在可信终端创建引导管理员。空库尚无游戏时可以省略
`--games`：

```bash
npm run admin:create -- \
  --operator-id ops_kimi \
  --display-name Kimi \
  --full-config
```

命令使用 `crypto.randomBytes` 生成 16 位 Base64URL 初始密码（12 字节、约 96 bit
随机性），创建成功后仅在当前终端显示一次。请立即安全交付并存入受控密码管理器；
不要把密码写入 Shell history、环境变量、配置文件、工单或 Git。创建命令拒绝覆盖已有
管理员，并写入 `operator_created/cli` 安全审计。

已有游戏后，可创建只负责逐游戏账号工作的管理员：

```bash
npm run admin:create -- \
  --operator-id support_a \
  --display-name "Support A" \
  --games game-a
```

增加 `--read-only` 会收回封禁和撤销会话能力。生产构建使用：

```bash
node --env-file=.env.production dist/admin-create.js \
  --operator-id ops_kimi \
  --display-name Kimi \
  --full-config
```

### 权限模型

CLI 支持以下相互独立的全局能力：

- `--manage-games`：创建/编辑游戏、目录设置和区服。
- `--manage-integrations`：查看和编辑微信及运行参数。
- `--rotate-secrets`：替换或轮换 Secret；还必须具备对应资源管理权限。
- `--manage-machine-identities`：查看、创建和编辑 Service/机器 Admin 身份与范围。
- `--full-config`：同时授予以上四项能力。

`admin_game_access` 的一行只授予对应游戏的账号查看权限；
`can_operate_accounts=1` 才允许封禁或撤销该游戏账号会话。全局配置权限不会自动扩大
逐游戏账号权限，逐游戏账号权限也不会授予配置权限。

普通游戏、区服和非 Secret 接入参数编辑不要求提升会话。以下操作要求管理员在最近
5 分钟通过当前密码重新认证：

- 替换微信 AppSecret。
- 创建或轮换 Service/机器 Admin Secret。
- 撤销 current 或 previous Secret。
- 修改机器身份的游戏授权范围。

Secret 操作还会在事务内重新读取管理员状态、`auth_version`、权限和提升会话，不能
依赖网页先前显示的按钮。停用管理员、修改密码或收回权限时，必须在同一受控事务中
递增 `auth_version` 并删除该管理员全部会话。

当前版本不提供网页管理员权限编辑。需要修改时，应使用受控数据库运维事务，并写入
相应安全审计。

## 动态配置工作流

游戏和区服 JSON 已移除。管理员从空状态完成配置：

1. 在“游戏项目”创建项目。新项目固定为 `draft + maintenance`，不向客户端下发。
2. 配置目录 `isOps` 和全部区服。空区服是合法状态；`serverId` 创建后不可修改或
   删除。
3. 在独立“接入配置”页面保存微信 AppID、endpoint、会话 TTL、超时、熔断和限流参数。
4. 重新认证并替换微信 AppSecret。AppID 与 AppSecret 都存在后，项目自动变为
   `configured`。
5. 创建 Service 与机器 Admin 身份，选择最小游戏范围，并安全保存只显示一次的
   Secret。
6. 最后把项目切换为 `enabled`，并按需开启客户端可见性。

游戏、接入、目录、区服和机器身份写入都使用 revision 乐观锁。HTTP 409 表示页面
版本已过期；必须重新加载后再次确认，不能用旧 revision 覆盖。管理员保存后，当前实例
立即失效缓存，其他实例通过短 TTL 和数据库 revision 自动刷新。页面中的
`loadedRevision` 只表示当前请求实例的加载版本，不能解读为全部实例已生效。

`disabled` 是游戏不可逆终态。AppID 或 AppSecret 变为不完整时，服务会把项目降回
`draft + maintenance` 并取消客户端可见性。

### 区服准入

区服开放开关、运行状态和开放时间共同决定准入：

- `isOpen=false`：不下发，也拒绝新登录。
- `isOpen=true`、`status=maintenance`：不下发，也拒绝新登录。
- `isOpen=true`、`status=smooth|busy`，但 `openTime` 未到：不下发，也拒绝新登录。
- `isOpen=true`、`status=smooth|busy`，且 `openTime` 已到：下发并允许登录。

`/areas` 与登录使用同一个服务端判断。游戏正常但当前无可进入区服时返回 HTTP 200 和
空列表。生产游戏 HTTP/WebSocket URL 必须分别使用 `https://` 和 `wss://`。

## Secret 运维

微信 AppSecret 由管理员输入，并在单个事务中覆盖 MySQL 中的旧明文、递增版本和写入
不含 Secret 的审计。GET API 和网页只显示“未配置/已生效”、版本与更新时间，不提供
查看、复制或历史值。保存成功表示 gameManageKit 已持久化，不表示微信侧已经验证。

Service 和机器 Admin Secret 由服务端生成 32 字节随机值并编码为 Base64URL；MySQL
只保存 SHA-256 摘要。明文仅在创建或轮换的首次成功响应中显示一次：

- 默认遮罩，管理员主动选择后才能显示。
- 复制后应立即写入受控 Secret Manager。
- 关闭前确认“我已安全保存”；关闭后 DOM 和内存引用都会清空。
- 页面刷新、返回、重新打开或幂等重放都不能恢复；丢失只能轮换。
- 轮换时 current 变为有明确失效时间的 previous，新旧值在窗口内都可用。
- 撤销或 previous 到期后，旧值立即拒绝。

Secret 写入请求携带唯一 `operationId`。网络超时或 HTTP 5xx 代表结果未知，网页先查
操作状态，绝不自动再次 POST。页面还必须按以下规则清理敏感状态：

- `401`：清空密码、AppSecret 输入和一次性 Secret，返回登录页。
- `403`：关闭表单并刷新权限。
- `404`：目标不存在，返回列表。
- `409`：清空 Secret 并重新加载 revision。
- `429`：显示明确的重试时间，不循环重试。

AppSecret、一次性 Secret、密码和会话令牌不得进入 URL、Hash、Toast、`aria-live`、
浏览器存储、日志或错误响应。

## 同源、TLS 与 Cookie

`GAME_MANAGE_KIT_ADMIN_ORIGIN` 必须是浏览器实际访问的精确 origin。开发默认值为
`http://127.0.0.1:2571`；生产必须显式配置独立 HTTPS origin，例如
`https://admin.example.invalid`。

生产反向代理必须满足：

- Admin origin 只转发 Internal/Admin 端口，Public origin 不暴露 `/admin/` 或管理
  API。
- Public 与 Admin 使用不同主机名；Cookie 不能依靠端口隔离。
- TLS 在代理或等价传输层终止，代理保留 `Origin`。
- 只有受信代理网络可以提供客户端地址；配置相应可信代理 CIDR。
- 多实例由 LB/WAF 或共享存储执行全局登录和写操作限流；应用内令牌桶只是单实例
  第一道保护。

生产 Cookie 使用 `__Host-gmk_admin_session`、`Secure`、`HttpOnly`、
`SameSite=Strict` 和 `Path=/`，不设置 `Domain`。开发 HTTP 使用独立的非 Secure
Cookie 名称，不能把降级方式带入生产。

管理员会话有 8 小时绝对有效期和 30 分钟空闲有效期。服务端定期清理过期会话；网页
也会清除页面状态，但服务端始终是有效期和权限的最终判定者。

## 数据库和备份边界

微信 AppSecret 以明文存入 MySQL，因此数据库本身属于生产 Secret 边界：

- 应用与 MySQL 必须强制 TLS。
- 生产 `GAME_MANAGE_KIT_MYSQL_URL` 必须提供启用证书校验的 `ssl` 参数；启动与
  migration 会验证实际协商出的 TLS cipher，失败时拒绝继续。
- 运行账号遵循最小权限；只有 gameManageKit 可以读取 AppSecret，禁止导出、复制和
  数据库管理权限。
- 禁用包含绑定参数的 SQL/慢查询日志和 ORM/APM 请求体采集。
- 数据盘、快照和备份必须加密，限制下载、记录访问并设置保留期限。
- 测试/开发不得直接恢复生产备份；脱敏副本必须删除 AppSecret。
- 在隔离且受控的生产等价环境定期演练恢复。
- 备份泄露或恢复环境失控后，立即替换微信 AppSecret，并轮换 Service 和机器 Admin
  Secret。

这些保护由数据库和部署平台强制实施，不能通过管理员网页关闭。恢复后应检查 Secret
版本状态，确保已撤销或过期版本没有被复活。

## 审计

登录成功/失败、退出、重新认证失败和会话过期写入认证审计。账号查询/拒绝/封禁/撤销、
游戏/目录/区服/接入编辑、机器身份编辑分别写入对应审计。Secret 操作只写入独立的
`admin_secret_audit`，记录类型、动作、版本、操作者、结果和请求元数据，不记录明文、
完整摘要、请求体或请求头。

应对以下事件告警：Secret 轮换和撤销、重新认证失败、撤销或过期 Secret 仍被使用、
微信凭据验证失败以及重复轮换冲突。

机器鉴权命中已撤销或过期版本时仍会拒绝请求，并更新该版本的最后使用时间，供告警
规则识别撤销后的继续使用。

运行时首次调用微信失败时会记录连接验证失败状态；后续调用成功会自动清除。管理员页
只展示该状态，不展示上游错误原文或任何 Secret。

## Schema 升级

动态配置使用 schema v3。升级现有开发库直接执行：

```bash
npm run migrate
```

启动会核对全部必需表和 migration 版本。生产不得使用删库重建升级；部署前先备份并在
等价环境验证 migration 和恢复流程。
