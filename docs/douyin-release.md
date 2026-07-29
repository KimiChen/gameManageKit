# 抖音发布与回滚手册

本手册把抖音 Provider 的测试应用验证与生产启用分开。测试应用使用独立 game、AppID
和区服；生产 Provider 在真实测试完成前保持禁用。任何步骤都不得把 AppSecret、
Service Secret、登录 code、accessToken、session_key、openid 或 unionid 写入命令行、
仓库、CI 日志、HAR、截图或发布记录。

## 1. 发布前门禁

发布负责人逐项保留不含敏感值的结果：

1. 已备份 schema v4 数据库并在等价隔离环境完成恢复演练；全部 v4 写进程已摘流。
2. `npm test`、`npm run test:web`、`npm run test:int`、`npm run typecheck`、
   `npm run verify:contract` 和 `npm run check:contract-breaking` 全部通过。
3. 在具备 Docker 的受控主机以新卷执行 `npm run mysql:docker:clean` 和
   `npm run test:docker`；本机集成测试不能替代生产镜像、双监听与 migration job 冒烟。
4. 已确认 Public 仅面向客户端，Internal/Admin 只在受信网络；两者均由 HTTPS 终止。
5. 已在发布记录中明确 MySQL 透明加密以及数据盘、快照、备份加密是否满足 AppSecret
   静态存储要求。不满足时先建立 KMS/信封加密工作项，不启用生产抖音 Provider。
6. 已准备测试应用、测试 game、开放区服和仅授权该 game 的 `service` 身份；Secret
   只从 Secret Manager 注入对应进程。

schema v5 会删除旧身份列，是一次性结构升级。迁移后禁止重新启动 v4 binary，也不能把
“回滚”解释成回退数据库结构或旧程序。

## 2. 部署与测试应用验证

1. 构建制品，停止全部 v4 写进程，执行 v5 migration，再启动新版本。此时新建 Provider
   默认禁用。
2. 先验证现有微信登录、目录和 Session verify；微信回归失败时停止发布。
3. 在隔离的测试 game 配置抖音 AppID、AppSecret、官方 endpoint、超时与熔断参数。
   AppID 必须与抖音开发者工具中测试应用完全一致。
4. 只对该测试 game 显式启用抖音 Provider；生产 game 继续禁用。
5. 运行无 code 预检和真实链路：

   ```bash
   npm run verify:douyin:live -- \
     --game-id <testGameId> \
     --server-id <serverId> \
     --service-id <scopedServiceIdentityId> \
     --public-url https://<GMK-Public-origin> \
     --internal-url https://<GMK-Internal-origin>
   ```

   Service Secret 与 fresh `tt.login` code 只在隐藏 TTY 中输入。脚本先验证双监听、
   区服和 Service scope，再消费一次 code，最后验证返回 token 的 userId 与权威
   `issuedAtMs/expiresAtMs`。Public API 不公开 Provider 配置，生成 code 前仍须在管理端
   确认测试 Provider 已启用且 AppID/Secret 正确。网络结果不确定时不得重放旧 code，
   应重新执行 `tt.login`。
6. 在抖音开发者工具或测试环境运行正常客户端构建，确认它自行完成
   `tt.login -> /sessions/douyin -> 目录 -> 游戏服 strict Session verify` 并进入游戏。
   CLI 验证不能替代这一项。
7. 检查 `provider=douyin` 的成功率、延迟、timeout、circuit_open、
   invalid_credentials、Session 签发失败和审计失败指标；按输出的 login requestId
   核对规范化登录审计，不查询或导出身份原文。
8. 观察窗口无异常后，才在独立变更中配置并显式启用生产 game 的抖音 Provider。

发布记录只保留命令退出状态、时间、版本、gameId、serverId、login/verify requestId、
是否新账号及权威签发/过期时间。不要保存网络响应、token 或 Secret。

## 3. 回滚

抖音异常时：

1. 立即禁用受影响 game 的抖音 Provider；不要清除身份、AppID 或 Secret version
   元数据。
2. 确认微信 Provider 仍启用并完成一次微信登录与 Session verify。
3. 观察抖音请求停止、微信成功率正常、熔断和审计结果符合预期。
4. 若怀疑 AppSecret 泄露，先保持 Provider 禁用，通过受保护接口轮换 Secret，再按本
   手册重新验证；不要直接编辑数据库。
5. 保留既有抖音 `account_identities`，避免修复后重新启用时给老玩家创建新账号。

应用故障需要回退时，只能回退到理解 schema v5 的已验证版本。不得恢复 v4 binary
继续写已迁移数据库。只有经过独立恢复演练和数据处置批准，才能整体恢复迁移前备份。
