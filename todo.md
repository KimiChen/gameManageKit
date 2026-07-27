# 多游戏接入改造计划

## 已确认前提

- 当前没有线上业务和历史兼容负担，不设计或保留 v2 兼容层。
- 直接修改现有 HTTP 契约、数据库初始结构和调用方式。
- 默认采用“一套服务实例接入多个游戏、每个游戏拥有独立账号”的模型。
- 同一微信身份可以在不同游戏中产生不同的 `userId`；暂不建设跨游戏平台账号体系。
- Public 与 Internal/Admin 双监听面的安全边界继续保留。

## 1. 修复现有开发和生产启动问题

- [x] 让 `npm run dev` 和 migration 命令能够正确加载 `.env`。
- [x] 修正生产环境默认区服配置使用 `http/ws` 而无法启动的问题。
- [x] 提供本地 MySQL 启动方式，并明确数据库创建、迁移和清理命令。
- [x] 为生产配置和本地启动流程补充自动化测试。

验收标准：

- 新 checkout 按 README 操作即可启动。
- 生产配置校验不会因仓库默认区服文件必然失败。
- 本地可以完整运行 `npm run test:int`。

## 2. 定义游戏租户模型

- [x] 定义稳定的 `gameId` 格式、长度和允许字符。
- [x] 定义游戏状态：`enabled`、`maintenance`、`disabled`。
- [x] 定义每个游戏的微信配置、区服目录、会话 TTL 和限流策略。
- [x] 定义 Service/Admin 身份可以访问的游戏范围。
- [x] 编写架构决策记录，确认所有数据查询都必须带 `gameId`。

建议的运行时上下文：

```ts
interface GameContext {
  gameId: string;
  status: "enabled" | "maintenance" | "disabled";
  wechat: WechatConfig;
  directory: DirectoryProvider;
  sessionTtlSeconds: number;
}
```

## 3. 直接修改现有 HTTP 契约

- [x] 在现有 `/v1` 下加入 `gameId`，删除原来的单游戏业务路径。
- [x] 保留 `/livez`、`/readyz` 和 `/version` 为全局系统端点。
- [x] 增加游戏不存在、游戏停用、越权访问和区服不存在等错误码。
- [x] 重新生成 contract 类型、路径常量和 Fastify Schema。
- [x] 更新契约 baseline，不保留旧单游戏 operation。

目标路径：

```text
POST /v1/games/{gameId}/sessions/wechat
POST /v1/games/{gameId}/sessions/dev
GET  /v1/games/{gameId}/areas

POST /v1/games/{gameId}/internal/sessions/verify
PUT  /v1/games/{gameId}/internal/characters/{userId}/{serverId}
GET  /v1/games/{gameId}/internal/characters/{userId}/{serverId}

POST /v1/games/{gameId}/admin/accounts/{userId}/ban
POST /v1/games/{gameId}/admin/accounts/{userId}/revoke
```

新增错误码：

```text
GAME_NOT_FOUND
GAME_DISABLED
GAME_ACCESS_DENIED
SERVER_NOT_FOUND
SERVER_DISABLED
```

验收标准：

- OpenAPI 是唯一契约真源。
- 实际双监听面路由与 OpenAPI method/path/tag 完全一致。
- 原单游戏业务路径不再注册。

## 4. 重建多游戏数据库结构

当前没有线上数据，可以直接修改 `0001_initial.sql`，然后重建本地和测试数据库，不编写历史数据兼容逻辑。

- [x] 新增 `games` 表。
- [x] 为 `accounts`、`account_sessions`、`char_registry`、`login_audit` 和 `seq` 增加 `game_id`。
- [x] 所有主键、唯一键和查询索引加入 `game_id`。
- [x] 评估并补充合理的外键或领域完整性检查。
- [x] 明确删除旧数据库并重新执行 migration 的开发流程。

目标约束：

```text
accounts:
  PRIMARY KEY(game_id, user_id)
  UNIQUE(game_id, openid)
  UNIQUE(game_id, unionid)

account_sessions:
  PRIMARY KEY(game_id, user_id, server_id)

char_registry:
  PRIMARY KEY(game_id, user_id, server_id)

login_audit:
  UNIQUE(game_id, operation_id)

seq:
  PRIMARY KEY(game_id, name)
```

验收标准：

- 不存在缺少 `game_id` 条件的业务 SQL。
- 两个游戏可拥有相同的 `openid`、`operationId` 和 `serverId`，且互不冲突。
- 不允许为不存在的游戏创建账号、会话或角色记录。

## 5. 实现 GameRegistry 和多游戏配置

- [x] 新增 `GameRegistry`，负责加载、校验和解析 `GameContext`。
- [x] 将当前单个区服配置改为按 `gameId` 管理的目录 Provider。
- [x] 每个游戏分别配置微信 AppID/Secret、接口地址、超时和熔断参数。
- [x] 微信 Secret、Service Secret 和 Admin Secret 不写入普通业务表或日志。
- [x] 服务启动时校验所有游戏配置，发现重复 ID、非法 URL 或缺失密钥时拒绝启动。
- [x] 明确区服目录是启动快照、热加载还是数据库动态配置。

建议配置边界：

- 普通游戏元数据和状态可以存入 `games` 表。
- 密钥由环境变量或 Secret Manager 提供。
- 区服目录先按游戏拆分文件，后续如需运营后台再迁移到数据库。

## 6. 改造认证和 HTTP 上下文

- [x] 在统一 `preHandler` 中解析并校验 `gameId`。
- [x] Service 鉴权返回包含允许游戏范围的身份对象。
- [x] Admin 鉴权返回 operator 和允许管理的游戏范围。
- [x] 禁止仅凭客户端传入的 `gameId` 访问其他游戏。
- [x] 验证 `serverId` 确实属于当前游戏且处于可用状态。
- [x] 将 `GameContext` 注入 request，避免各路由重复查询和校验。

目标处理链：

```text
解析 gameId
→ 查询 GameRegistry
→ 校验游戏状态
→ 认证调用方
→ 校验调用方的游戏权限
→ 注入 GameContext
→ 执行业务服务
```

## 7. 改造领域服务

- [x] `LoginService` 的查号、建号、序列和审计全部限定 `gameId`。
- [x] `SessionService` 的签发、轮换、校验和跨区查询全部限定 `gameId`。
- [x] `CharacterService` 的登记、查询和区服足迹全部限定 `gameId`。
- [x] `DirectoryService` 只返回当前游戏目录和角色足迹。
- [x] `AdminAccountService` 的封禁、撤销和幂等重放全部限定 `gameId`。
- [x] 登录和 Admin 限流 key 加入 `gameId`。
- [x] 每个游戏拥有独立的微信熔断状态，避免一个游戏的故障影响其他游戏。
- [x] 日志和审计记录统一包含 `gameId`。

建议将访问令牌调整为：

```text
gameId.userId.randomToken
```

数据库仍只保存完整 token 的 SHA-256 hash。校验时必须同时匹配 token 中的游戏、请求路径中的游戏和数据库记录中的游戏。

## 8. 补齐账号与区服完整性

- [x] 登录前确认目标 `serverId` 属于当前游戏。
- [x] 角色登记前确认账号和区服均存在于当前游戏。
- [x] 明确 `revoke` 只是撤销全部会话，还是注销账号；如果只是会话撤销则调整命名和文档。
- [x] 决定是否实现 `unban`、`deregister` 和账号恢复。
- [x] 处理当前明文保存但没有读取方的微信 `session_key`：无用途则删除，有用途则加密并定义清理策略。

## 9. 建立多游戏测试矩阵

- [x] 两个游戏使用相同 `openid` 时分别创建账号。
- [x] A 游戏 token 不能在 B 游戏验证。
- [x] A 游戏 Service/Admin 凭证不能操作 B 游戏。
- [x] 相同 `operationId` 可以分别用于不同游戏。
- [x] 封禁、撤销会话和角色登记只影响当前游戏。
- [x] 两个游戏相同 `serverId` 的目录和角色数据互不影响。
- [x] 一个游戏的微信熔断不影响其他游戏。
- [x] 非法、停用或维护中的游戏返回预期错误。
- [x] 并发建号、会话轮换和 Admin 幂等测试在多游戏条件下继续通过。
- [x] 契约测试确认 Public 与 Internal/Admin 的监听面隔离。

验收命令：

```bash
npm run verify:contract
npm run check:contract-breaking
npm run typecheck
npm test
npm run test:int
npm run build
npm audit --omit=dev
```

## 10. 可观测性和部署验收

- [x] 日志加入 `gameId`、`serviceId` 和 `operatorId`，继续对 token 和 secret 脱敏。
- [x] 增加按游戏统计的登录成功率、限流、微信上游错误和数据库延迟指标。
- [x] 控制指标标签基数，禁止将 `userId`、token 或任意输入作为指标 label。
- [x] `/readyz` 校验数据库 schema 和 GameRegistry 是否就绪。
- [x] Docker 冒烟测试至少加载两个游戏并验证数据隔离。
- [x] 更新 README、环境变量示例、部署说明和游戏接入文档。

## 推荐实施顺序

1. 修复 `.env`、本地 MySQL 和生产目录启动问题。
2. 确认游戏租户及账号隔离模型。
3. 修改 OpenAPI 和 contract。
4. 重建初始数据库结构。
5. 实现 `GameRegistry` 与游戏级鉴权。
6. 改造登录和会话链路。
7. 改造角色、目录和 Admin 链路。
8. 补齐多游戏集成测试。
9. 完成日志、指标、Docker 冒烟和接入文档。

## 完成定义

- 一套进程可以同时加载至少两个游戏。
- 所有 API、SQL、缓存、限流、熔断、日志和审计均按 `gameId` 隔离。
- 任意跨游戏 token、凭证或数据访问都会被拒绝。
- 新游戏可以通过新增配置和密钥接入，不需要复制或修改业务代码。
- 全部契约、类型、测试、构建和生产镜像检查通过。
