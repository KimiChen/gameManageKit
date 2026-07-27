# 管理员控制台运维指南

管理员控制台只部署在 Internal/Admin 监听面，入口为 `/admin/`。浏览器管理员使用
数据库中的个人账号和 HttpOnly 会话 Cookie；`config/games.json` 中的
`x-operator-id + x-admin-secret` 仅保留给受信的机器调用方，不能作为网页登录凭证。

## 创建首个管理员

先完成数据库 migration 和游戏同步，再在可信终端执行：

```bash
npm run admin:create -- --operator-id ops_kimi --display-name Kimi --games game-a,game-b --manage-games
```

命令使用 Node.js `crypto.randomBytes` 生成 16 位 Base64URL 初始密码（12 字节、
约 96 bit 随机性），创建成功后仅在当前终端显示一次，不要求用户输入密码。请立即
安全交付并存入受控密码管理器；不要把密码写入 Shell history、环境变量、配置文件或
Git。只需查看账号时增加 `--read-only`。
`--manage-games` 是独立的全局能力，允许新增和编辑游戏项目、管理各游戏区服及调整
客户端下发开关和顺序；它不会自动扩大该管理员的账号管理游戏范围。不负责游戏和区服
管理时应省略。
创建命令拒绝覆盖已有管理员，并写入 `operator_created/cli` 安全审计。第一版不提供
网页权限编辑；需要修改管理员时应使用受控数据库运维事务，并同时递增
`auth_version`、删除该管理员的 `admin_sessions`、写入对应安全审计。

生产构建完成后可使用：

```bash
node --env-file=.env.production dist/admin-create.js --operator-id ops_kimi --display-name Kimi --games game-a,game-b --manage-games
```

## 同源与 TLS

`GAME_MANAGE_KIT_ADMIN_ORIGIN` 必须是浏览器实际访问的精确 origin。开发默认值为
`http://127.0.0.1:2571`；生产必须显式配置独立的 HTTPS origin，例如
`https://admin.example.invalid`。

生产反向代理应满足：

- Admin origin 只转发到 Internal/Admin 端口，不转发 Public 端口。
- Public origin 不暴露 `/admin/` 或管理员 API。
- TLS 在代理或等价安全传输层终止。
- Public 与 Admin 使用不同主机名；Cookie 不以端口作为隔离边界。
- 代理保留 `Origin`，并只从受信代理网络传递客户端地址。
- 多实例部署在 LB/WAF 或共享限流存储中按 IP、管理员账号及二者组合执行全局登录限流；
  应用内令牌桶只是单实例第一道保护。

生产 Cookie 使用 `__Host-gmk_admin_session`、`Secure`、`HttpOnly`、
`SameSite=Strict` 和 `Path=/`，不设置 `Domain`。开发 HTTP 使用不同名称的非 Secure
Cookie，不能把该降级配置带入生产。

## 权限与会话

`admin_game_access` 的一行授予对应游戏的查看权限；
`can_operate_accounts=1` 才允许封禁或撤销全部会话。服务端会在每次请求重新读取权限，
不能依赖浏览器页面中已经显示的权限。

`admin_operators.can_manage_games=1` 才允许访问全局游戏项目接口。新增项目固定为
`draft + maintenance` 且不向客户端下发；`gameId` 创建后不能修改或删除。项目完成
部署配置并重启成为 `configured` 后，管理员才能启用客户端下发。`disabled` 是不可逆
终态。该能力也允许为游戏新增和编辑区服，但不能修改已经创建的 `serverId`，也不提供
删除入口。所有游戏和区服编辑都使用 `revision` 乐观锁，避免两名管理员静默覆盖彼此
修改。

区服的“已开放”开关与维护状态含义不同：

- `isOpen=false`：区服不会下发给客户端，且新登录会被拒绝；适用于尚未开服或暂时撤下。
- `isOpen=true` 且 `status=maintenance`：区服仍下发，客户端可以显示维护提示，但新
  登录会被拒绝。
- `isOpen=true` 且状态为 `smooth` 或 `busy`：区服正常下发并允许登录。

生产环境的游戏 HTTP 与 WebSocket URL 必须分别使用 `https://` 和 `wss://`。修改
开服开关、状态或排序在数据库中即时生效，不需要重启；编辑 URL 前应确认目标地址已
部署并可用。

管理员会话有 8 小时绝对有效期和 30 分钟空闲有效期。停用管理员、修改密码或收回权限
时，必须在同一受控事务中递增 `auth_version` 并删除该管理员全部会话，使现有浏览器
立即失效。服务进程每 15 分钟按小批次清理无人再次访问的过期会话；清理遵循
管理员行再会话行的统一锁顺序，并记录会话过期审计。网页也会在 30 分钟内没有成功
管理请求时主动清空已显示的账号资料并返回登录页；服务端仍是最终有效期判定者。

登录成功、登录失败、退出和会话过期写入 `admin_auth_audit`；账号查询、权限拒绝、
封禁和撤销写入游戏级审计；游戏项目与区服的新增、编辑写入 `admin_game_audit`。
日志和审计不得写入密码、Cookie、会话原始令牌或 Admin Secret。

## 开发库升级

本轮区服结构由 `0002_game_servers.sql` 增加。已经具备新版游戏项目结构
（例如 `games.configuration_state` 与 `admin_operators.can_manage_games`）的本地库只
需执行 `npm run migrate`；migration 会保留现有管理员、权限和游戏项目。

如果数据库执行的是更早、尚无上述字段的旧版 `0001`，仍须删除并重建本地开发库后
重新运行 `npm run migrate`，不能靠 `0002` 补齐被改写过的旧初始结构。启动时会核对
全部必需表，旧结构会直接拒绝启动，而不是等到管理员登录时才失败。生产环境不得使用
开发期删库重建流程。
