# ADR 0001：以 `gameId` 作为强制租户边界

- 状态：已接受
- 日期：2026-07-28

## 背景

gameManageKit 需要由一套服务实例同时接入多个游戏。微信身份、账号、会话、角色、
管理操作和区服目录都只在所属游戏内有意义；同一微信身份在不同游戏中应得到相互独立的
账号。项目尚未上线，因此直接替换原有单游戏契约和初始数据库，不提供兼容层。

## 决策

### 稳定标识

`gameId` 是创建后不可修改的租户标识，同时用于 HTTP 路径、配置键、日志字段和数据库
`game_id`。它必须：

- 长度为 2 至 32 个 ASCII 字符；
- 匹配 `^[a-z][a-z0-9-]{1,31}$`；
- 由小写字母开头，后续只允许小写字母、数字和连字符；
- 不复用已停用或已删除游戏的标识。

OpenAPI、配置加载器和数据库 `CHECK` 约束必须使用同一规则。展示名称不承担标识职责。

### 游戏状态

游戏状态只有：

- `enabled`：允许处理游戏业务请求；
- `maintenance`：临时停止游戏业务请求；
- `disabled`：停止游戏业务请求，且不能用于新接入。

`maintenance` 和 `disabled` 的游戏业务请求都使用 `GAME_DISABLED`：维护状态返回 HTTP
503，停用状态返回 HTTP 403。未知游戏返回 HTTP 404 `GAME_NOT_FOUND`。区服维护或停用
返回 HTTP 403 `SERVER_DISABLED`，未知区服返回 HTTP 404 `SERVER_NOT_FOUND`。两种游戏
`maintenance` 用于可恢复的运维停服，`disabled` 用于永久退役和审计。`/livez`、
`/readyz`、`/version` 和内部 `/metrics` 是进程级端点，不属于任何游戏，也不接收
`gameId`。

### 启动快照与密钥边界

`GameRegistry` 从 `GAME_MANAGE_KIT_GAMES_CONFIG` 指向的 JSON 文件加载一次启动快照。
变更配置后重启实例，不在本阶段实现热加载。每个游戏定义至少包含：

```ts
interface GameDefinition {
  gameId: string;
  status: "enabled" | "maintenance" | "disabled";
  directoryPath: string;
  sessionTtlSeconds: number;
  loginRate: { capacity: number; refillPerSecond: number };
  adminRate: { capacity: number; refillPerSecond: number };
  wechat: {
    appIdEnv: string;
    secretEnv: string;
    endpoint: string;
    timeoutMs: number;
    breakerThreshold: number;
    breakerOpenMs: number;
  };
}
```

普通元数据、区服目录路径和策略参数可以出现在配置文件中。微信 AppID 和 Secret 分别
通过 `appIdEnv`、`secretEnv` 引用环境变量或 Secret Manager 注入，不能把凭据值写入
配置文件、`games` 表、普通业务表或日志。每个游戏分别实例化微信客户端、熔断器和
限流器，避免故障状态跨游戏传播。

配置中的每个游戏在启动时同步到 `games(game_id, status)`，并确保存在
`seq(game_id, 'user_id')`。`games` 表是关系完整性的租户父表；运行时快照是连接信息和
策略的真源。配置含重复或非法 `gameId`、非法 URL、缺失密钥、非法 TTL/限流值时，启动
失败。

`disabled` 是终态。退役游戏必须永久保留在配置中并设为 `disabled`；启动同步会拒绝
遗漏数据库中已经登记的游戏，也会拒绝把已停用的 `gameId` 重新设为 `enabled` 或
`maintenance`。这样旧账号、会话和角色数据不会因标识复用而重新暴露。

### 调用方授权范围

Service 和 Admin 身份都由“身份、密钥引用、允许访问的 `gameId` 集合”组成。认证只说明
调用方是谁；只有路径中的 `gameId` 出现在该身份的允许集合中才获得授权，否则返回
`GAME_ACCESS_DENIED`。客户端提交的 `gameId` 不能扩大身份权限。

Public 请求也必须先解析路径中的 `gameId`。访问令牌包含 `gameId`，验证时必须同时匹配
令牌租户、HTTP 路径租户和数据库租户。

### 数据访问不变量

`accounts`、`account_sessions`、`char_registry`、`login_audit` 和 `seq` 的每次业务
读写都必须显式接收并使用 `gameId`：

- `SELECT`、`UPDATE`、`DELETE` 必须在条件中包含 `game_id`；
- `INSERT` 必须显式写入 `game_id`；
- 表连接必须同时连接 `game_id` 和领域键；
- 唯一约束和面向业务查询的索引必须包含 `game_id`；
- 不得仅凭 `userId`、`openid`、`operationId`、`serverId` 或 token 推断租户；
- 日志、审计、缓存键、限流键和幂等键都必须包含 `gameId`。

数据库通过外键阻止为不存在的游戏创建账号、会话、角色、审计和序列记录。会话和角色
使用 `(game_id, user_id)` 外键确认账号归属。区服目录来自配置快照，无法建立数据库
外键，因此登录和角色登记必须在写库前通过当前游戏的目录校验 `serverId` 及其状态。
审计允许记录不存在的目标账号，所以 `login_audit.user_id` 不引用账号表。

### 初始结构重建

`0001_initial.sql` 被直接改写，不提供历史数据迁移。已经执行过旧版 migration 的开发库
必须删除并重建，因为 `schema_migrations` 中已有版本 `1` 时不会重放该文件：

```sql
DROP DATABASE game_manage_kit;
CREATE DATABASE game_manage_kit
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

随后使用指向新数据库的 `GAME_MANAGE_KIT_MYSQL_URL` 执行 `npm run migrate`。生产环境不得
对已有数据库执行上述删除流程。

## 结果

- 同一 `openid`、`unionid`、`userId`、`operationId` 和 `serverId` 可以在不同游戏中
  重复而不冲突。
- 每个领域服务和 SQL 调用都需要增加 `gameId` 参数，遗漏租户条件应视为安全缺陷。
- 游戏配置变更需要重启，但实现简单、状态确定；如未来确需动态运营配置，再单独决策。
- `accounts.session_key` 不再保存微信明文会话密钥；若未来出现明确用途，需要另行设计
  加密、访问控制和清理策略。
