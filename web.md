# 管理员网页技术方案

## 1. 目标与边界

管理员网页部署在 Internal/Admin 监听面，提供完整的业务配置和账号管理闭环：

1. 个人管理员账号登录。
2. 按逐游戏权限查询、封禁账号和撤销全部会话。
3. 创建和编辑游戏项目、目录设置及全部区服。
4. 配置微信 AppID、AppSecret、endpoint、会话、超时、熔断和限流参数。
5. 创建、编辑、轮换和撤销 Service/机器 Admin 身份及其 Secret。
6. 查看不含 Secret 的最近配置审计。

MySQL 是全部业务配置的唯一真源。网页不处理数据库连接、TLS 私钥或首个管理员引导等
部署信任根。运行时不再读取静态游戏/区服 JSON 或每游戏 Secret 环境变量。

## 2. 基础框架

页面继续基于 Web Standard Kit：

- 来源：<https://github.com/KimiChen/wheels/tree/main/web-standard-kit>
- 固定版本：`f920dc584db1cb8d1b3e4206a54e1f1eebe497eb`
- 技术栈：原生 HTML、CSS、JavaScript
- 浏览器范围：Chrome/Edge 111+、Safari 16.2+、Firefox 113+

不引入框架、前端路由库、CSS 框架或构建步骤。复用约定：

- 保留 `wsk-*` 类名和 `@layer wsk`。
- 自有类使用 `gmk-*` 前缀并放入 `@layer gmk`。
- 只复制实际使用的令牌、组件和交互，文件头记录上游版本。
- 业务数据只通过 `textContent` 或 DOM 属性写入，不用 `innerHTML`。

文件结构：

```text
web/admin/
├── index.html
├── wsk.css
├── admin.css
├── wsk.js
└── app.js
```

Fastify 只在 Internal/Admin 应用挂载 `/admin/` 和静态资源；Public 监听面固定返回 404。

## 3. 页面与导航

Hash 只表达视图，不包含游戏 ID、管理员、用户、密码、Secret、operationId 或错误信息：

```text
/admin/#login
/admin/#accounts
/admin/#games
/admin/#configuration
```

已登录页面共用侧栏和顶栏：

- “账号管理”：管理员至少有一个逐游戏访问权限时显示。
- “游戏项目”：`canManageGames=true` 时显示。
- “接入配置”：具备接入或机器身份管理权限时显示。
- “退出登录”：始终显示。

直接修改 Hash 不能绕过权限。没有任何可用能力时显示无权限状态，只允许退出。初始化
流程：

```text
GET /v1/admin/auth/session
→ 401：显示登录
→ 已登录：保存非敏感会话元数据
→ 根据实时权限选择第一个可用视图
→ 并行加载该视图的必要 GET 数据
```

## 4. 登录、会话和重新认证

登录页字段：

- 管理员账号：`autocomplete="username"`。
- 密码：`autocomplete="current-password"`。
- 登录提交期间设置 `aria-busy=true` 并禁止重复提交。

登录成功只接收 HttpOnly Cookie，不接收 JavaScript 可读 token；清空密码后进入业务
页面。登录失败统一提示账号或密码错误，不区分不存在、密码错误和停用。

普通会话响应包含四项全局能力和 `elevatedUntil`。Secret 写入或机器范围修改前，如果
提升会话不存在或即将过期，打开重新认证对话框：

- 只提交当前密码到 `/v1/admin/auth/reauthenticate`。
- 不签发或保存独立高权限 Bearer Token。
- 成功后重新读取会话，随后由管理员主动继续原操作。
- 失败、关闭或页面隐藏时立即清空密码。

网页不把密码写入 Toast、`aria-live`、URL、日志或任意存储。

## 5. 账号管理

账号流程保持：

```text
选择授权游戏
→ 输入 userId
→ 查询账号
→ 显示状态、最近登录和活跃会话数
→ 确认“撤销全部会话”或“封禁账号”
→ 填写原因并提交
```

切换游戏立即清空账号数据和操作原因。每次新操作使用 `crypto.randomUUID()` 作为
`operationId`；人工重试同一操作时复用该值。封禁和撤销只影响 URL 中的 `gameId`，
服务端仍会实时复核逐游戏权限。

## 6. 游戏项目与区服

游戏列表展示名称、`gameId`、运行状态、配置完整度、客户端可见性、顺序、revision 和
更新时间。

- 新项目只接收 `gameId`、名称和说明，固定创建为
  `draft + maintenance + clientVisible=false`。
- `gameId` 创建后不可修改、删除或复用。
- `configured` 后才允许 `enabled` 或客户端可见。
- `disabled` 是不可逆终态。
- 编辑携带当前 revision；409 时保留非敏感输入，但禁止继续使用旧版本提交。

区服管理显示全部区服，包括未开放、未来开服和维护状态。目录设置与区服共用
`directoryRevision`：

- 修改 `isOps`、新增区服和编辑区服都携带当前目录 revision。
- `serverId` 创建后只读，不提供删除。
- URL、Unix 秒开放时间、标签、状态、开关和排序在前端预校验，服务端独立复核。
- 409 后重新读取完整目录，再允许管理员编辑。

Public `/areas` 不复用管理员列表模型。只有 `isOpen=true`、`status=smooth|busy` 且
`openTime` 已到的区服可以下发和登录；维护区服不会下发。

## 7. 独立“接入配置”页面

页面按所选游戏分为六块：

1. 配置完整度和游戏 revision。
2. 微信接入。
3. 会话、超时、熔断和限流参数。
4. Service 身份及游戏范围。
5. 机器 Admin 身份及游戏范围。
6. 最近配置与 Secret 审计。

普通接入表单使用 integration revision，只提交非 Secret 字段。页面同时展示保存
revision 与当前请求实例的 `loadedRevision`；文案必须说明这不代表所有实例已经同步。

### 7.1 微信 AppSecret

AppID 可以完整显示和编辑。AppSecret 只显示：

- 未配置。
- 已生效及版本。
- 最近更新时间。
- 本次替换结果未知或失败。

AppSecret 输入框永远为空，不预填旧值。替换使用独立对话框和唯一 operationId，请求
包含当前 integration revision。保存成功响应仍不含明文，只能说明已经写入 MySQL，
不能宣称微信凭据已验证。

输入值只存在于输入元素和最短生命周期的局部变量中。提交开始即从通用页面状态移出；
无论成功、失败、关闭、409、401、`pagehide` 或超时都调用统一清理函数：

```text
input.value = ""
局部引用 = null
移除可能包含值的文本节点
```

AppSecret 不进入 URL、Hash、Toast、`aria-live`、DOM `data-*`、浏览器存储、调试日志或
错误对象。

### 7.2 机器身份

身份列表只显示 ID、类型、名称、状态、游戏范围、revision 和 Secret 版本元数据，不
显示摘要。创建和编辑表单要求：

- `identityId` 创建后不可修改。
- 类型仅为 `service` 或 `machine_admin`。
- 游戏范围使用显式多选，默认不自动授予全部游戏。
- 修改范围前重新认证。
- 停用身份不删除历史审计。

创建和轮换由服务端生成 Secret。首次成功响应进入专用一次性对话框：

- 默认遮罩，只有管理员主动点击才显示。
- 提供复制按钮，但不把内容放入 Toast 或 live region。
- 未勾选“我已安全保存”时，关闭需要再次确认。
- 关闭、确认、退出、路由切换、`pagehide`、401/403/409 或超时后，删除文本节点并清空
  内存引用；重新打开无法恢复。
- `Cache-Control: no-store`，不得缓存响应。

浏览器无法可靠清空系统剪贴板，因此复制后明确提醒管理员立即保存到 Secret Manager，
并避免在共享终端操作。

轮换请求携带 operationId、identity revision 和 previous 有效窗口。网络超时或 5xx
后将结果标为“未知”，只允许调用对应的状态 GET；绝不自动重发 POST。状态 GET 只说明
操作是否发生，不能恢复一次性明文。若 Secret 已生成但响应丢失，管理员只能发起下一次
明确轮换。

### 7.3 审计

审计列表只渲染后端白名单字段：审计类型、资源、动作、操作者、版本、结果和时间。
不得渲染通用 before/after JSON、请求体、请求头、Secret 或摘要。

## 8. HTTP 契约

管理员认证：

```text
POST   /v1/admin/auth/login
GET    /v1/admin/auth/session
POST   /v1/admin/auth/reauthenticate
DELETE /v1/admin/auth/session
```

游戏、目录和区服：

```text
GET    /v1/admin/games
POST   /v1/admin/games
PATCH  /v1/admin/games/{gameId}
GET    /v1/admin/games/{gameId}/directory-settings
PATCH  /v1/admin/games/{gameId}/directory-settings
GET    /v1/admin/games/{gameId}/servers
POST   /v1/admin/games/{gameId}/servers
PATCH  /v1/admin/games/{gameId}/servers/{serverId}
```

接入和 Secret：

```text
GET    /v1/admin/games/{gameId}/integration
PATCH  /v1/admin/games/{gameId}/integration
PUT    /v1/admin/games/{gameId}/secrets/wechat-app-secret
GET    /v1/admin/machine-identities
POST   /v1/admin/machine-identities
PATCH  /v1/admin/machine-identities/{identityId}
POST   /v1/admin/machine-identities/{identityId}/secret-rotations
POST   /v1/admin/machine-identities/{identityId}/secret-versions/{version}/revoke
GET    /v1/admin/machine-identities/{identityId}/secret-rotations/{operationId}
GET    /v1/admin/config-audit
```

账号接口仍位于具体游戏：

```text
GET  /v1/games/{gameId}/admin/accounts/{userId}
POST /v1/games/{gameId}/admin/accounts/{userId}/ban
POST /v1/games/{gameId}/admin/accounts/{userId}/revoke
```

OpenAPI 是唯一契约真源。`app.js` 只做必要的运行时响应验证，拒绝未知或缺失的安全关键
字段，不复制维护另一套类型定义。所有 GET 响应都不允许包含 Secret 或摘要。

## 9. 前端状态

`app.js` 使用小型显式状态对象：

```text
auth:
  booting | anonymous | authenticated

session:
  operator | games | capabilities | expiresAt | elevatedUntil

selection:
  gameId | queriedUserId

accounts:
  idle | loading | found | notFound | error

projects:
  idle | loading | ready | empty | error

directory:
  idle | loading | ready | empty | conflict | error

integration:
  idle | loading | ready | conflict | unknown | error

machines:
  idle | loading | ready | empty | conflict | unknown | error

audit:
  idle | loading | ready | empty | error
```

Secret 明文不属于该通用状态对象，只允许存在于专用对话框的局部闭包。统一
`clearSensitiveState()` 清空密码、AppSecret 和一次性 Secret，并由以下事件调用：

- 视图切换、退出和 `pagehide`。
- 401、403、404、409。
- 对话框关闭、请求结束或请求超时。
- 全局未捕获错误处理前。

`localStorage` 只允许保存 `light`/`dark` 主题；`sessionStorage`、IndexedDB、Cache API
和 Service Worker 不保存管理数据。

## 10. 请求和错误处理

所有 API 请求通过一个 `request()`：

- `credentials: "same-origin"` 和 `Accept: application/json`。
- 写请求设置 `Content-Type: application/json`，服务端校验精确 Origin。
- 使用 `AbortController` 实现超时。
- 统一解析错误码、`Retry-After` 和 `x-request-id`，但错误对象不附加敏感请求体。
- 普通安全 GET 可由管理员主动重试；写请求默认不自动重试。

错误动作：

- 401：清空全部敏感和业务状态，回到登录。
- 403：关闭表单，清空敏感值并刷新会话权限。
- 404：清空目标数据并返回列表。
- 409：清空 Secret，标记 revision 冲突并重新加载。
- 429：展示明确重试时间，不循环重试。
- 网络超时/5xx：Secret 操作为未知；先查询状态或读取最新元数据，绝不自动再次生成。

普通成功消息可以使用 Toast；Secret、密码、token 和可能含敏感值的错误永远不进入
Toast 或 `aria-live`。

## 11. 服务与浏览器安全

- 管理网页/API 同源部署，不开放任意 CORS。
- 生产使用独立 HTTPS Admin 主机名和 `__Host-`、Secure、HttpOnly、
  SameSite=Strict Cookie。
- 所有写请求校验 Origin，每次事务实时复核管理员状态、权限、auth version 和提升
  会话。
- Secret 路由关闭请求体日志，日志脱敏覆盖所有 Secret/密码/token/Cookie 字段名。
- 页面不向浏览器暴露微信旧 Secret、机器摘要或数据库字段结构。
- 管理端响应使用 `Cache-Control: no-store`；一次性 Secret 响应强制 no-store。

Content-Security-Policy：

```text
default-src 'none';
script-src 'self' 'sha256-<固定首屏主题脚本哈希>';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
font-src 'self';
form-action 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
```

固定首屏主题脚本使用哈希，不启用宽泛的 `unsafe-inline`。

## 12. 测试

### 单元与网页测试

- 权限控制下的导航和 Hash 回退。
- 登录、重新认证、会话过期和退出清理。
- 游戏/目录/integration/机器 identity revision 冲突。
- `/areas` 和登录统一准入文案。
- AppSecret 输入永不预填，所有退出路径都清空。
- 一次性 Secret 默认遮罩、显示、复制、确认关闭和不可恢复。
- 401/403/404/409/429/超时/5xx 的敏感状态清理。
- Secret 轮换未知结果只发状态 GET，不自动 POST。
- 页面、URL、Toast、live region 和浏览器存储不出现 canary Secret。

### 契约与集成测试

- Public 与 Internal/Admin 监听面隔离。
- GET integration/identity/audit 不含 Secret 或摘要。
- Secret 权限与提升会话在事务内复核。
- operationId 重放不产生新版本，也不再次返回一次性 Secret。
- Service previous 在窗口内有效，到期/撤销后拒绝。
- 动态保存后无需重启生效，多实例在 TTL 内收敛。
- AppSecret 只保留当前明文；机器 Secret 只保存摘要。
- 两个游戏的账号、token、区服和机器范围不串租户。

验收命令：

```bash
npm run verify:contract
npm run check:contract-breaking
npm run typecheck
npm test
npm run test:int
npm run test:web
npm run build
npm audit --omit=dev
```

## 13. 完成定义

- 管理员可以从空库完成游戏、区服、微信参数和机器身份配置。
- 独立“接入配置”页面覆盖完整度、微信、运行参数、两类机器身份和审计。
- Secret 只在允许的写请求/一次性响应出现，关闭后无法恢复。
- 未授权、未提升或 revision 过期的请求由服务端拒绝。
- 管理保存后运行时动态加载，不依赖 JSON、每游戏环境变量或人工重启。
- Public `/areas` 与登录只接受同一组可进入区服。
- Public 监听面不暴露管理页面和管理 API。
- 页面满足键盘操作、焦点恢复、主题和无障碍基线。
