# 管理员网页技术方案

## 1. 目标与范围

本方案在 `todo.md` 的多游戏改造基础上，为 gameManageKit 增加仅供内部使用的管理员网页。第一版只覆盖以下闭环：

1. 管理员使用个人账号登录。
2. 服务端返回该管理员允许管理的游戏。
3. 管理员选择游戏并查询账号。
4. 管理员撤销指定账号的全部会话，或封禁账号。
5. 所有登录和管理操作均可审计。

第一版不提供管理员自助注册、密码找回、角色编辑、游戏配置编辑、批量账号操作和数据大盘。

## 2. 基础框架

网页显示统一基于 Web Standard Kit：

- 来源：<https://github.com/KimiChen/wheels/tree/main/web-standard-kit>
- 固定版本：`f920dc584db1cb8d1b3e4206a54e1f1eebe497eb`
- 技术栈：原生 HTML、CSS、JavaScript
- 浏览器范围：Chrome/Edge 111+、Safari 16.2+、Firefox 113+

不引入 React、Vue、前端路由库、CSS 框架或组件库。管理页规模较小，原生实现可以减少构建链、运行依赖和供应链风险。

复用 Web Standard Kit 时遵循以下约定：

- 保留 `wsk-*` 类名和 `@layer wsk`。
- gameManageKit 自有类使用 `gmk-*` 前缀，并放入 `@layer gmk`。
- 只复制实际使用的设计令牌、组件样式和交互函数，不复制演示页面的无关内容。
- 在复用文件头部记录上游地址和固定提交，方便后续比对升级。
- 第一版只有一个菜单、一个数据表格和一个确认对话框，保留套件的单实例行为；出现多个实例需求后再改造成 `data-*` 多实例初始化。

## 3. 文件结构

```text
web/admin/
├── index.html       # 页面结构、SVG 图标和首屏主题初始化
├── wsk.css          # 从 Web Standard Kit 提取的基础令牌和组件
├── admin.css        # gameManageKit 页面布局及业务状态样式
├── wsk.js           # 主题、密码显示、对话框和 Toast 等基础行为
└── app.js           # 认证、路由、API 调用及账号操作
```

页面不需要编译。Fastify 的 Internal/Admin 应用负责提供 `/admin/` 及其静态资源，Public 应用不得注册这些路由。

## 4. 页面与导航

管理网页使用 Hash 表达视图状态，避免为静态页面增加 History API 回退逻辑：

```text
/admin/#login
/admin/#accounts
```

页面初始化流程：

```text
加载 /admin/
→ GET /v1/admin/auth/session
→ 未登录：显示 #login
→ 已登录：加载管理员与游戏权限
→ 单游戏：自动选中并显示 #accounts
→ 多游戏：要求选择游戏后显示 #accounts
→ 无游戏权限：显示无权限状态，只允许退出
```

Hash 只记录页面视图，不记录管理员、账号、密码、会话或操作原因等敏感信息。

## 5. 登录页

登录页复用 `wsk-auth-card`、`wsk-field`、`wsk-control`、`wsk-button`、`wsk-alert` 和密码显示按钮。

页面字段：

- 管理员账号：`autocomplete="username"`。
- 登录密码：`autocomplete="current-password"`。
- 登录按钮：提交期间显示 `wsk-loading` 和 `aria-busy="true"`。

交互要求：

- 不提供“记住密码”。
- 不允许输入或保存 `GAME_MANAGE_KIT_ADMIN_SECRET`。
- 登录失败统一提示“账号或密码错误”，不向客户端区分账号不存在、密码错误或管理员停用。
- 限流、网络错误和服务不可用使用不同的可恢复提示。
- 错误提示使用 `aria-live`；失败后焦点回到第一个需要处理的字段。
- 登录成功后清空密码输入框，再进入账号管理页。
- `localStorage` 只允许保存 `light`/`dark` 主题，不保存任何认证信息。

## 6. 账号管理页

账号管理页复用 Web Standard Kit 的参考应用外壳：

- `wsk-reference-shell`：侧栏与主内容布局。
- `wsk-topbar`：游戏选择器、管理员菜单和主题切换。
- `wsk-panel`：查询和账号信息卡片。
- `wsk-table`：账号信息或会话摘要。
- `wsk-badge`：游戏及账号状态。
- `wsk-dialog`：危险操作确认。
- `wsk-toast`：操作结果反馈。

第一版侧栏只保留“账号管理”和“退出登录”，不展示尚未实现的入口。

账号操作流程：

```text
选择有权限的游戏
→ 输入 userId
→ 查询账号
→ 显示账号状态、最近登录时间和活跃会话数
→ 选择“撤销全部会话”或“封禁账号”
→ 填写操作原因
→ 确认游戏、用户和影响范围
→ 提交操作并显示结果
```

限制：

- 未完成账号查询前不允许执行写操作。
- `userId` 在浏览器端进行格式校验，但服务端仍必须独立校验。
- 每次新操作使用 `crypto.randomUUID()` 生成 `operationId`。
- 同一次操作因超时或网络错误重试时必须复用原 `operationId`。
- 切换游戏后立即清空查询结果、操作原因和待确认操作。
- “撤销”在界面上明确命名为“撤销全部会话”，不使用容易被理解为注销账号的文字。
- 封禁按钮使用危险色；确认对话框必须显示游戏名称、`gameId`、`userId` 和影响说明。
- 游戏是否允许操作以服务端返回的权限和能力为准，前端不能仅根据游戏状态自行推断授权。

## 7. HTTP 契约

管理员认证发生在选择游戏之前，因此认证端点是全局端点：

```text
POST   /v1/admin/auth/login
GET    /v1/admin/auth/session
DELETE /v1/admin/auth/session
```

账号查询和操作必须位于具体游戏下：

```text
GET  /v1/games/{gameId}/admin/accounts/{userId}
POST /v1/games/{gameId}/admin/accounts/{userId}/ban
POST /v1/games/{gameId}/admin/accounts/{userId}/revoke
```

建议的登录请求：

```json
{
  "operatorId": "ops_kimi",
  "password": "仅在请求体中传输"
}
```

登录成功只通过响应头设置会话 Cookie，响应体不返回会话令牌。

建议的会话响应：

```json
{
  "operator": {
    "operatorId": "ops_kimi",
    "displayName": "Kimi"
  },
  "games": [
    {
      "gameId": "game_a",
      "name": "示例游戏",
      "status": "enabled",
      "canOperateAccounts": true
    }
  ],
  "expiresAt": "2026-07-28T18:00:00.000Z"
}
```

建议的账号查询响应：

```json
{
  "userId": "u_12345",
  "status": "active",
  "lastLoginAt": "2026-07-28T05:20:00.000Z",
  "activeSessionCount": 2
}
```

封禁和撤销请求继续使用：

```json
{
  "operationId": "3f1a0d6c-3a43-4a43-bfad-f13f7baed362",
  "reason": "人工确认的操作原因"
}
```

OpenAPI 仍是唯一契约真源。网页代码不得复制维护另一份请求或响应类型定义；实现阶段应提供少量运行时响应校验，防止后端异常响应直接进入页面状态。

## 8. 管理员身份与数据模型

现有 `x-operator-id + x-admin-secret` 不能作为浏览器登录方案：

- `x-operator-id` 由调用方填写，不能证明真实身份。
- 共享 Admin Secret 一旦进入网页，就可能被浏览器存储、扩展、日志或前端构建产物泄露。
- 共享 Secret 无法单独停用某个管理员，也无法可靠限制管理员可访问的游戏。

建议增加：

```text
admin_operators
  operator_id
  display_name
  password_hash
  status
  created_at
  updated_at

admin_game_access
  operator_id
  game_id
  can_operate_accounts

admin_sessions
  token_hash
  operator_id
  created_at
  last_seen_at
  expires_at
```

密码使用 Node.js `crypto.scrypt` 和每个管理员独立的随机盐，保存带版本和参数的哈希结果，不保存明文或可逆密文。

首个管理员通过命令行创建，例如：

```text
npm run admin:create -- --operator-id ops_kimi --games game_a,game_b
```

密码必须从 TTY 隐藏输入或标准输入读取，不允许作为命令行参数进入 Shell history。第一版不提供网页注册入口。

## 9. 会话与请求安全

管理员会话使用至少 256 bit 的随机令牌。浏览器保存原始令牌，数据库只保存 SHA-256 哈希。

Cookie 建议：

```text
Name: __Host-gmk_admin_session
HttpOnly: true
Secure: true
SameSite: Strict
Path: /
Domain: 不设置
```

默认采用 8 小时绝对有效期和 30 分钟空闲有效期。退出、管理员停用、修改密码或权限收回时应立即删除相关会话。

其他安全要求：

- 管理网页与 API 同源部署，不开放任意跨域。
- 所有写请求验证 `Origin`。
- 每个请求重新校验管理员状态和目标 `gameId` 权限，不能信任页面保存的权限。
- 登录限流键包含规范化 `operatorId` 和 IP。
- 管理操作限流键包含 `operatorId`、`gameId` 和 IP。
- 登录成功、登录失败、退出、会话过期、权限拒绝、封禁和撤销均写入审计。
- 日志不得记录密码、Cookie、会话令牌、Admin Secret 或完整请求体。
- Internal/Admin 服务必须位于 TLS 反向代理或等价的安全传输层之后。

建议的 Content-Security-Policy：

```text
default-src 'none';
script-src 'self' 'sha256-<首屏主题脚本哈希>';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
font-src 'self';
form-action 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
```

Web Standard Kit 的首屏主题脚本需要保留以避免主题闪烁，实现时为固定脚本计算 CSP Hash，不使用宽泛的 `unsafe-inline`。

## 10. 前端状态管理

`app.js` 使用一个小型显式状态对象，不引入状态管理库：

```text
auth:
  booting | anonymous | authenticated

session:
  operator | games | expiresAt

selection:
  gameId | queriedUserId

account:
  idle | loading | found | notFound | error

operation:
  idle | confirming | submitting | succeeded | failed
```

所有网络请求统一经过 `request()`：

- 默认 `credentials: "same-origin"`。
- 设置 `Accept: application/json`。
- 写请求设置 `Content-Type: application/json`。
- 统一解析错误码和 `x-request-id`。
- 收到 `401` 时清空业务状态并切回登录页。
- 收到 `403` 时刷新当前会话权限。
- 收到 `429` 时显示限流提示，不自动循环重试。
- 不自动重试封禁或撤销；由管理员主动重试并复用相同 `operationId`。

## 11. 静态资源服务

静态资源只挂载到 Internal/Admin Fastify 实例：

```text
GET /admin/
GET /admin/wsk.css
GET /admin/admin.css
GET /admin/wsk.js
GET /admin/app.js
```

要求：

- Public Fastify 实例访问 `/admin` 或相关资源时返回 404。
- `index.html` 使用 `Cache-Control: no-cache`。
- CSS 和 JavaScript 使用 ETag；没有文件名指纹前不设置长期 immutable 缓存。
- 静态文件根目录必须固定为 `web/admin`，不得接受用户输入拼接文件路径。
- API 和静态页面共享 Internal/Admin 源，避免 CORS 和跨站 Cookie。

## 12. 测试方案

### 单元测试

- 登录表单校验和提交锁定。
- 密码显示按钮的可访问状态。
- Hash 页面切换。
- 会话过期后的状态清理。
- 游戏切换后账号数据清理。
- API 错误码到页面提示的映射。
- 同一操作重试复用 `operationId`。

### 契约测试

- OpenAPI 包含管理员认证和账号查询端点。
- Public 与 Internal/Admin 监听面隔离。
- 会话响应只包含管理员有权访问的游戏。
- 账号操作路径必须包含 `gameId`。

### 集成测试

- 正确密码登录成功，错误密码返回统一错误。
- 停用管理员无法登录，已有会话立即失效。
- A 游戏管理员不能查询或操作 B 游戏。
- 修改 URL 中的 `gameId` 不能绕过权限。
- 会话空闲过期、绝对过期和退出均立即生效。
- 相同 `operationId` 重放不会产生重复副作用。
- 登录和写操作限流生效。
- 非法 Origin 被拒绝。

### 浏览器测试

- 键盘可以完成登录、查询和确认操作。
- 登录中、失败、限流、断网和会话过期状态正确。
- 深色与浅色主题首屏无明显闪烁。
- 确认对话框包含正确的游戏和用户。
- Public 监听面不能加载管理网页。
- 1024px 及以上桌面宽度布局可用；窄屏不出现不可操作的控件。

验收命令在现有命令基础上增加网页测试：

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

## 13. 实施顺序

1. 完成 `todo.md` 中游戏模型、OpenAPI 路径、GameRegistry 和管理员游戏权限设计。
2. 增加管理员、游戏权限、会话表和管理员初始化命令。
3. 实现登录、当前会话、退出和账号查询 API。
4. 从固定版本的 Web Standard Kit 提取所需基础组件。
5. 完成登录页和认证状态切换。
6. 完成游戏选择、账号查询、封禁和撤销流程。
7. 将网页静态资源挂载到 Internal/Admin 监听面。
8. 增加安全响应头、审计、限流和会话清理。
9. 完成契约、集成和浏览器验收测试。

## 14. 完成定义

- 管理员可以使用个人账号登录、选择授权游戏并完成账号查询和操作。
- Admin Secret 不出现在 HTML、JavaScript、浏览器存储、请求日志或构建产物中。
- 未登录、会话过期和停用管理员均不能访问管理数据。
- 管理员无法通过修改 Hash、请求体或 URL 访问未授权游戏。
- 封禁和撤销只影响当前 `gameId`，且重试不会重复执行。
- Public 监听面不暴露管理页面和管理 API。
- 页面遵循 Web Standard Kit 的主题、组件命名、键盘操作和无障碍基线。
- 所有契约、类型、单元、集成、浏览器和构建检查通过。
