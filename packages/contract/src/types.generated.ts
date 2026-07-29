/* eslint-disable */
// Generated from openapi/openapi.yaml. Do not edit.
export type paths = {
    "/livez": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["livez"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["metrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["readyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["adminLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/reauthenticate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description 验证当前管理员密码并提升现有 HttpOnly Cookie 会话；必须校验请求 Origin，且不签发独立高权限令牌。 */
        post: operations["adminReauthenticate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminSession"];
        put?: never;
        post?: never;
        delete: operations["adminLogout"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminBootstrapStatus"];
        put?: never;
        /** @description 仅在单调引导锁存器尚未完成时创建首个全权限管理员、签发普通会话；必须校验请求 Origin。 */
        post: operations["bootstrapAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/config-audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description 返回最近的配置与 Secret 审计白名单元数据，不返回 Secret、摘要或通用 before/after JSON。 */
        get: operations["listAdminConfigAudit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/games": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAdminGames"];
        put?: never;
        /** @description 创建草稿游戏项目；必须使用管理员 Cookie 会话，并校验请求 Origin。 */
        post: operations["createAdminGame"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/games/{gameId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按 revision 编辑游戏项目；gameId 不可修改，且必须校验请求 Origin。 */
        patch: operations["updateAdminGame"];
        trace?: never;
    };
    "/v1/admin/games/{gameId}/directory-settings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        /** @description 返回游戏目录设置及用于目录级乐观锁的 revision。 */
        get: operations["getAdminGameDirectorySettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按目录 revision 修改 isOps；必须校验请求 Origin。 */
        patch: operations["updateAdminGameDirectorySettings"];
        trace?: never;
    };
    "/v1/admin/games/{gameId}/identity-providers/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                provider: components["parameters"]["IdentityProvider"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按 revision 修改白名单 Provider 的启用状态、AppID、端点、超时和熔断参数；必须校验请求 Origin。 */
        patch: operations["updateAdminIdentityProvider"];
        trace?: never;
    };
    "/v1/admin/games/{gameId}/identity-providers/{provider}/secret": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                provider: components["parameters"]["IdentityProvider"];
            };
            cookie?: never;
        };
        get?: never;
        /** @description 替换白名单 Provider 的 AppSecret；要求 Secret 权限、最近重新认证、Origin、revision 和幂等 operationId。 */
        put: operations["replaceAdminIdentityProviderSecret"];
        post?: never;
        /** @description 清除白名单 Provider 的 AppSecret 并禁用该 Provider；要求 Secret 权限、最近重新认证、Origin、revision 和幂等 operationId。 */
        delete: operations["clearAdminIdentityProviderSecret"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/games/{gameId}/integration": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        /** @description 返回共享登录参数、Provider 配置、运行时加载 revision 和 Secret 元数据；永不返回 Secret 或摘要。 */
        get: operations["getAdminGameIntegration"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按 revision 修改 Session TTL 与限流等共享参数；不修改 Provider 或 Secret，且必须校验请求 Origin。 */
        patch: operations["updateAdminGameIntegration"];
        trace?: never;
    };
    "/v1/admin/games/{gameId}/servers": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        /** @description 返回指定游戏的全部区服，包括尚未开放给客户端的区服。 */
        get: operations["listAdminGameServers"];
        put?: never;
        /** @description 为指定游戏新增区服；必须使用管理员 Cookie 会话，并校验请求 Origin。 */
        post: operations["createAdminGameServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/games/{gameId}/servers/{serverId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按 revision 编辑区服；gameId 与 serverId 不可修改，且必须校验请求 Origin。 */
        patch: operations["updateAdminGameServer"];
        trace?: never;
    };
    "/v1/admin/machine-identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description 返回 Service 与机器 Admin 身份、游戏范围和 Secret 版本元数据；永不返回摘要。 */
        get: operations["listAdminMachineIdentities"];
        put?: never;
        /** @description 创建机器身份并生成一次性 Secret；要求机器身份和 Secret 权限、最近重新认证与 Origin。 */
        post: operations["createAdminMachineIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/machine-identities/{identityId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** @description 按 revision 修改机器身份；游戏范围变化要求最近重新认证，且必须校验 Origin。 */
        patch: operations["updateAdminMachineIdentity"];
        trace?: never;
    };
    "/v1/admin/machine-identities/{identityId}/secret-rotations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description 生成新 current Secret，并让旧 current 在明确窗口内成为 previous；必须校验 Origin。 */
        post: operations["rotateAdminMachineSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/machine-identities/{identityId}/secret-rotations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        /** @description 查询未知结果的 Secret 操作状态；只返回元数据，永不恢复一次性 Secret。 */
        get: operations["getAdminMachineSecretRotationStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/machine-identities/{identityId}/secret-versions/{version}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
                version: components["parameters"]["SecretVersion"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description 撤销 current 或 previous Secret；要求 Secret 权限、最近重新认证与 Origin。 */
        post: operations["revokeAdminMachineSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description 返回允许客户端发现的游戏；仅包含 enabled 或 maintenance 状态。 */
        get: operations["listClientGames"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/admin/accounts/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get: operations["getAdminAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/admin/accounts/{userId}/ban": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["banAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/admin/accounts/{userId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/areas": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        /** @description 仅下发已经开服、isOpen=true 且状态为 smooth 或 busy 的区服；与登录共用同一准入规则。 */
        get: operations["listAreas"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/internal/characters/{userId}/{serverId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                serverId: components["parameters"]["ServerId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get: operations["hasCharacter"];
        put: operations["registerCharacter"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/internal/sessions/verify": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["verifySession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/sessions/dev": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description 仅 AUTH_DEV_ENABLED=1 时可用；生产环境固定返回 404。 */
        post: operations["devLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/sessions/douyin": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["douyinLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/games/{gameId}/sessions/wechat": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["wxLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["version"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        AdminAccountDetailResponse: {
            activeSessionCount: number;
            /** Format: date-time */
            lastLoginAt: string | null;
            /** @enum {string} */
            status: "active" | "banned" | "deregistered";
            userId: string;
        };
        AdminAccountRequest: {
            operationId: string;
            reason: string;
        };
        AdminAccountResponse: {
            accountExists: boolean;
            /** @enum {string} */
            status: "banned" | "revoked" | "not_found";
        };
        AdminBootstrapRequest: {
            displayName: string;
            operatorId: string;
            password: string;
        };
        AdminBootstrapStatus: {
            required: boolean;
        };
        AdminGameAccess: {
            canOperateAccounts: boolean;
            gameId: components["schemas"]["GameId"];
            name: string;
            status: components["schemas"]["GameStatus"];
        };
        AdminLoginRequest: {
            operatorId: string;
            password: string;
        };
        AdminOperator: {
            displayName: string;
            operatorId: string;
        };
        AdminReauthenticateRequest: {
            password: string;
        };
        AdminSessionResponse: {
            canManageGames: boolean;
            canManageIntegrations: boolean;
            canManageMachineIdentities: boolean;
            canRotateSecrets: boolean;
            /** Format: date-time */
            elevatedUntil: string | null;
            /** Format: date-time */
            expiresAt: string;
            games: components["schemas"]["AdminGameAccess"][];
            operator: components["schemas"]["AdminOperator"];
        };
        AreaListResponse: {
            hash: string;
            isOps: boolean;
            myServerIds: number[];
            servers: components["schemas"]["AreaServer"][];
        };
        AreaServer: {
            gameHttpUrl: string;
            gameWsUrl: string;
            name: string;
            openTime: number;
            serverId: number;
            /** @enum {string} */
            status: "smooth" | "busy" | "maintenance";
            /** @enum {string} */
            tag: "normal" | "new" | "full" | "maintenance";
        };
        ClearIdentityProviderSecretRequest: {
            operationId: components["schemas"]["OperationId"];
            revision: number;
        };
        ClientGameListResponse: {
            games: components["schemas"]["ClientGameSummary"][];
        };
        ClientGameSummary: {
            description: string;
            gameId: components["schemas"]["GameId"];
            name: string;
            /** @enum {string} */
            status: "enabled" | "maintenance";
        };
        ConfigurationAuditPage: {
            records: components["schemas"]["ConfigurationAuditRecord"][];
        };
        ConfigurationAuditRecord: {
            action: string;
            afterMetadata: {
                [key: string]: unknown;
            } | null;
            /** @enum {string} */
            auditType: "game_configuration" | "machine_identity" | "secret";
            beforeMetadata: {
                [key: string]: unknown;
            } | null;
            /** Format: date-time */
            createdAt: string;
            gameId: components["schemas"]["GameId"] | null;
            id: string;
            identityId: components["schemas"]["MachineIdentityId"] | null;
            newVersion: number | null;
            oldVersion: number | null;
            operationId: string | null;
            operatorId: string;
            provider: components["schemas"]["IdentityProvider"] | null;
            requestId: string | null;
            result: string;
            revision: number | null;
        };
        CreateGameProjectRequest: {
            description: string;
            gameId: components["schemas"]["GameId"];
            name: string;
        };
        CreateGameServerRequest: {
            directoryRevision: number;
            /** Format: uri */
            gameHttpUrl: string;
            /** Format: uri */
            gameWsUrl: string;
            isOpen: boolean;
            name: string;
            openTime: number;
            serverId: number;
            sortOrder: number;
            /** @enum {string} */
            status: "smooth" | "busy" | "maintenance";
            /** @enum {string} */
            tag: "normal" | "new" | "full" | "maintenance";
        };
        CreateMachineIdentityRequest: {
            displayName: string;
            gameIds: components["schemas"]["GameId"][];
            identityId: components["schemas"]["MachineIdentityId"];
            identityType: components["schemas"]["MachineIdentityType"];
            operationId: components["schemas"]["OperationId"];
        };
        DevLoginRequest: {
            deviceId?: string | null;
            devKey: string;
            serverId: number;
        };
        DouyinLoginRequest: {
            code: string;
            deviceId?: string | null;
            serverId: number;
        };
        /** @enum {string} */
        ErrorCode: "INVALID_PAYLOAD" | "INVALID_REQUEST" | "AUTH_REQUIRED" | "ACCOUNT_BANNED" | "NOT_FOUND" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "SERVICE_AUTH_REQUIRED" | "SERVICE_FORBIDDEN" | "OPERATION_CONFLICT" | "INTERNAL" | "GAME_NOT_FOUND" | "GAME_DISABLED" | "GAME_ACCESS_DENIED" | "SERVER_NOT_FOUND" | "SERVER_DISABLED" | "ADMIN_AUTH_REQUIRED" | "ORIGIN_FORBIDDEN" | "GAME_PROJECT_CONFLICT" | "GAME_SERVER_CONFLICT" | "ADMIN_ALREADY_INITIALIZED" | "AUTH_CODE_INVALID" | "PROVIDER_UNAVAILABLE" | "PROVIDER_CONFIGURATION_INVALID" | "IDENTITY_CONFLICT" | "IDENTITY_PROVIDER_CONFLICT";
        ErrorResponse: {
            code: components["schemas"]["ErrorCode"];
            requestId: string;
        };
        /** @enum {string} */
        GameConfigurationState: "draft" | "configured";
        GameDirectorySettings: {
            /** Format: date-time */
            createdAt: string;
            gameId: components["schemas"]["GameId"];
            isOps: boolean;
            revision: number;
            /** Format: date-time */
            updatedAt: string;
        };
        GameId: string;
        GameIntegration: {
            adminRateCapacity: number;
            adminRateRefillPerSecond: number;
            configurationState: components["schemas"]["GameConfigurationState"];
            /** Format: date-time */
            createdAt: string;
            gameId: components["schemas"]["GameId"];
            loadedRevision: number | null;
            loginRateCapacity: number;
            loginRateRefillPerSecond: number;
            providers: components["schemas"]["IdentityProviderConfiguration"][];
            revision: number;
            sessionTtlSeconds: number;
            /** Format: date-time */
            updatedAt: string;
        };
        GameProject: {
            clientVisible: boolean;
            configurationState: components["schemas"]["GameConfigurationState"];
            /** Format: date-time */
            createdAt: string;
            description: string;
            gameId: components["schemas"]["GameId"];
            name: string;
            revision: number;
            sortOrder: number;
            status: components["schemas"]["GameStatus"];
            /** Format: date-time */
            updatedAt: string;
        };
        GameProjectListResponse: {
            games: components["schemas"]["GameProject"][];
        };
        /** @enum {string} */
        GameStatus: "enabled" | "maintenance" | "disabled";
        HasCharacterResponse: {
            exists: boolean;
        };
        /** @enum {string} */
        IdentityProvider: "wechat" | "douyin";
        IdentityProviderConfiguration: {
            appId: string | null;
            breakerOpenMs: number;
            breakerThreshold: number;
            enabled: boolean;
            /** Format: uri */
            endpoint: string;
            provider: components["schemas"]["IdentityProvider"];
            secretMetadata: components["schemas"]["IdentityProviderSecretMetadata"];
            timeoutMs: number;
            /** Format: date-time */
            updatedAt: string;
            updatedBy: string | null;
            validationErrorCode: string | null;
            /** Format: date-time */
            validationFailedAt: string | null;
            validationState: components["schemas"]["IdentityProviderValidationState"];
        };
        IdentityProviderSecretMetadata: {
            configured: boolean;
            /** Format: date-time */
            updatedAt: string | null;
            version: number;
        };
        IdentityProviderSecretWriteResponse: {
            configurationState: components["schemas"]["GameConfigurationState"];
            gameId: components["schemas"]["GameId"];
            loadedRevision: number | null;
            provider: components["schemas"]["IdentityProvider"];
            replayed: boolean;
            revision: number;
            secretMetadata: components["schemas"]["IdentityProviderSecretMetadata"];
        };
        /** @enum {string} */
        IdentityProviderValidationState: "unvalidated" | "active" | "validation_failed";
        LiveResponse: {
            /** @constant */
            ok: true;
        };
        LoginResponse: {
            accessToken: string;
            isNewAccount: boolean;
            userId: string;
        };
        MachineIdentity: {
            /** Format: date-time */
            createdAt: string;
            displayName: string;
            gameIds: components["schemas"]["GameId"][];
            identityId: components["schemas"]["MachineIdentityId"];
            identityType: components["schemas"]["MachineIdentityType"];
            revision: number;
            secretVersions: components["schemas"]["MachineSecretVersion"][];
            status: components["schemas"]["MachineIdentityStatus"];
            /** Format: date-time */
            updatedAt: string;
        };
        MachineIdentityId: string;
        MachineIdentityListResponse: {
            identities: components["schemas"]["MachineIdentity"][];
        };
        /** @enum {string} */
        MachineIdentityStatus: "enabled" | "disabled";
        /** @enum {string} */
        MachineIdentityType: "service" | "machine_admin";
        MachineSecretIssuedResponse: {
            identity: components["schemas"]["MachineIdentity"];
            /** Format: date-time */
            previousExpiresAt: string | null;
            replayed: boolean;
            /** @description 仅首次成功响应返回；幂等重放时缺省且无法恢复。 */
            readonly secret?: string;
            version: number;
        };
        MachineSecretOperationStatus: {
            /** @enum {string} */
            action: "set" | "rotate" | "revoke";
            /** Format: date-time */
            createdAt: string;
            deliveryLost: boolean;
            identityId: components["schemas"]["MachineIdentityId"];
            operationId: components["schemas"]["OperationId"];
            /** @constant */
            status: "succeeded";
            version: number | null;
        };
        MachineSecretRevokedResponse: {
            identityId: components["schemas"]["MachineIdentityId"];
            identityRevision: number;
            replayed: boolean;
            /** @constant */
            state: "revoked";
            version: number;
        };
        /** @enum {string} */
        MachineSecretState: "current" | "previous" | "revoked";
        MachineSecretVersion: {
            /** Format: date-time */
            activatedAt: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            expiresAt: string | null;
            /** Format: date-time */
            lastUsedAt: string | null;
            /** Format: date-time */
            revokedAt: string | null;
            state: components["schemas"]["MachineSecretState"];
            version: number;
        };
        ManagedGameServer: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uri */
            gameHttpUrl: string;
            gameId: components["schemas"]["GameId"];
            /** Format: uri */
            gameWsUrl: string;
            isOpen: boolean;
            name: string;
            openTime: number;
            revision: number;
            serverId: number;
            sortOrder: number;
            /** @enum {string} */
            status: "smooth" | "busy" | "maintenance";
            /** @enum {string} */
            tag: "normal" | "new" | "full" | "maintenance";
            /** Format: date-time */
            updatedAt: string;
        };
        ManagedGameServerListResponse: {
            directoryRevision: number;
            servers: components["schemas"]["ManagedGameServer"][];
        };
        ManagedGameServerMutationResponse: {
            directoryRevision: number;
            server: components["schemas"]["ManagedGameServer"];
        };
        OperationId: string;
        ReadyResponse: {
            ready: boolean;
        };
        RegisterCharacterResponse: {
            /** @constant */
            registered: true;
        };
        ReplaceIdentityProviderSecretRequest: {
            appSecret: string;
            operationId: components["schemas"]["OperationId"];
            revision: number;
        };
        RevokeMachineSecretRequest: {
            operationId: components["schemas"]["OperationId"];
            reason: string;
            revision: number;
        };
        RotateMachineSecretRequest: {
            operationId: components["schemas"]["OperationId"];
            previousValiditySeconds: number;
            revision: number;
        };
        UpdateGameDirectorySettingsRequest: {
            isOps: boolean;
            revision: number;
        };
        UpdateGameIntegrationRequest: {
            adminRateCapacity: number;
            adminRateRefillPerSecond: number;
            loginRateCapacity: number;
            loginRateRefillPerSecond: number;
            revision: number;
            sessionTtlSeconds: number;
        };
        UpdateGameProjectRequest: {
            clientVisible: boolean;
            description: string;
            name: string;
            revision: number;
            sortOrder: number;
            status: components["schemas"]["GameStatus"];
        };
        UpdateGameServerRequest: {
            directoryRevision: number;
            /** Format: uri */
            gameHttpUrl: string;
            /** Format: uri */
            gameWsUrl: string;
            isOpen: boolean;
            name: string;
            openTime: number;
            revision: number;
            sortOrder: number;
            /** @enum {string} */
            status: "smooth" | "busy" | "maintenance";
            /** @enum {string} */
            tag: "normal" | "new" | "full" | "maintenance";
        };
        UpdateIdentityProviderRequest: {
            appId: string | null;
            breakerOpenMs: number;
            breakerThreshold: number;
            enabled: boolean;
            /** Format: uri */
            endpoint: string;
            revision: number;
            timeoutMs: number;
        };
        UpdateMachineIdentityRequest: {
            displayName: string;
            gameIds: components["schemas"]["GameId"][];
            revision: number;
            status: components["schemas"]["MachineIdentityStatus"];
        };
        VerifySessionRequest: {
            accessToken: string;
            serverId: number;
        };
        VerifySessionResponse: {
            expiresAtMs: number;
            issuedAtMs: number;
            userId: string;
            /** @constant */
            valid: true;
        } | {
            /** @enum {string} */
            reason: "NOT_FOUND" | "MISMATCH" | "BANNED" | "DEREGISTERED" | "EXPIRED";
            /** @constant */
            valid: false;
        };
        VersionResponse: {
            contractVersion: string;
            gitSha: string;
            schemaVersion: number;
            /** @constant */
            service: "game-manage-kit";
            serviceVersion: string;
        };
        WxLoginRequest: {
            code: string;
            deviceId?: string | null;
            serverId: number;
        };
    };
    responses: {
        /** @description 管理员凭证或会话无效 */
        AdminUnauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 入参不合法 */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 操作冲突 */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 禁止访问；可能为账号封禁、游戏停用、调用方无游戏权限或区服停用 */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 内部错误 */
        Internal: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 资源、游戏或区服不存在 */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 请求过频 */
        RateLimited: {
            headers: {
                /** @description 建议等待的秒数 */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 服务身份无效 */
        ServiceUnauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 用户身份无效 */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description 身份 Provider 不可用、未配置、熔断，或游戏处于维护状态 */
        Unavailable: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: {
        AuditGameId: components["schemas"]["GameId"];
        AuditLimit: number;
        GameId: components["schemas"]["GameId"];
        IdentityId: components["schemas"]["MachineIdentityId"];
        IdentityProvider: components["schemas"]["IdentityProvider"];
        OperationId: components["schemas"]["OperationId"];
        SecretVersion: number;
        ServerId: number;
        UserId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    livez: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 进程存活 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LiveResponse"];
                };
            };
        };
    };
    metrics: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Prometheus 文本格式指标 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            401: components["responses"]["ServiceUnauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["Internal"];
        };
    };
    readyz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 依赖就绪 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadyResponse"];
                };
            };
            /** @description 未就绪 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadyResponse"];
                };
            };
        };
    };
    adminLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminLoginRequest"];
            };
        };
        responses: {
            /** @description 登录成功；会话仅通过 HttpOnly Cookie 返回 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    adminReauthenticate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReauthenticateRequest"];
            };
        };
        responses: {
            /** @description 当前管理员会话已短期提升 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 当前管理员及实时游戏权限 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSessionResponse"];
                };
            };
            401: components["responses"]["AdminUnauthorized"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    adminLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 会话已撤销并清除 Cookie */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminBootstrapStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 是否仍需创建首个管理员 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminBootstrapStatus"];
                };
            };
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    bootstrapAdmin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminBootstrapRequest"];
            };
        };
        responses: {
            /** @description 首个管理员创建成功；会话仅通过 HttpOnly Cookie 返回 */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listAdminConfigAudit: {
        parameters: {
            query?: {
                gameId?: components["parameters"]["AuditGameId"];
                limit?: components["parameters"]["AuditLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 最近配置审计 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationAuditPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listAdminGames: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 返回全部游戏项目及其配置状态 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameProjectListResponse"];
                };
            };
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    createAdminGame: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateGameProjectRequest"];
            };
        };
        responses: {
            /** @description 游戏项目已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameProject"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminGame: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateGameProjectRequest"];
            };
        };
        responses: {
            /** @description 游戏项目已更新 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameProject"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminGameDirectorySettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 游戏目录设置 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameDirectorySettings"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminGameDirectorySettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateGameDirectorySettingsRequest"];
            };
        };
        responses: {
            /** @description 游戏目录设置已更新 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameDirectorySettings"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminIdentityProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                provider: components["parameters"]["IdentityProvider"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateIdentityProviderRequest"];
            };
        };
        responses: {
            /** @description Provider 配置已保存 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameIntegration"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    replaceAdminIdentityProviderSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                provider: components["parameters"]["IdentityProvider"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplaceIdentityProviderSecretRequest"];
            };
        };
        responses: {
            /** @description Provider AppSecret 已保存；响应不回显明文 */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdentityProviderSecretWriteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    clearAdminIdentityProviderSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                provider: components["parameters"]["IdentityProvider"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClearIdentityProviderSecretRequest"];
            };
        };
        responses: {
            /** @description Provider AppSecret 已清除；响应不回显明文 */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdentityProviderSecretWriteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminGameIntegration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 游戏接入配置 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameIntegration"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminGameIntegration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateGameIntegrationRequest"];
            };
        };
        responses: {
            /** @description 游戏接入配置已保存 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GameIntegration"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listAdminGameServers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 游戏区服列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManagedGameServerListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    createAdminGameServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateGameServerRequest"];
            };
        };
        responses: {
            /** @description 游戏区服已创建 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManagedGameServerMutationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminGameServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateGameServerRequest"];
            };
        };
        responses: {
            /** @description 游戏区服已更新 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManagedGameServerMutationResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listAdminMachineIdentities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 机器身份列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineIdentityListResponse"];
                };
            };
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    createAdminMachineIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateMachineIdentityRequest"];
            };
        };
        responses: {
            /** @description 身份已创建；首次响应含一次性 Secret，幂等重放不再返回 Secret */
            201: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineSecretIssuedResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    updateAdminMachineIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMachineIdentityRequest"];
            };
        };
        responses: {
            /** @description 机器身份已更新 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineIdentity"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    rotateAdminMachineSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RotateMachineSecretRequest"];
            };
        };
        responses: {
            /** @description Secret 已轮换；首次响应含一次性 Secret，幂等重放不再返回 Secret */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineSecretIssuedResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminMachineSecretRotationStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Secret 操作状态 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineSecretOperationStatus"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    revokeAdminMachineSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identityId: components["parameters"]["IdentityId"];
                version: components["parameters"]["SecretVersion"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RevokeMachineSecretRequest"];
            };
        };
        responses: {
            /** @description Secret 版本已撤销 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineSecretRevokedResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listClientGames: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 客户端游戏列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClientGameListResponse"];
                };
            };
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    getAdminAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 仅返回管理所需的最小账号摘要 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAccountDetailResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    banAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminAccountRequest"];
            };
        };
        responses: {
            /** @description 封号结果 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAccountResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    revokeAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminAccountRequest"];
            };
        };
        responses: {
            /** @description 撤销该游戏账号的全部现有会话；账号保留且允许重新登录 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAccountResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["AdminUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    listAreas: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 选服目录 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AreaListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    hasCharacter: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                serverId: components["parameters"]["ServerId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 是否存在角色 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HasCharacterResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["ServiceUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    registerCharacter: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
                serverId: components["parameters"]["ServerId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 幂等登记成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisterCharacterResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["ServiceUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    verifySession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerifySessionRequest"];
            };
        };
        responses: {
            /** @description 校验结果；身份失败也返回 200 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerifySessionResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["ServiceUnauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    devLogin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DevLoginRequest"];
            };
        };
        responses: {
            /** @description 登录成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    douyinLogin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DouyinLoginRequest"];
            };
        };
        responses: {
            /** @description 登录成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    wxLogin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                gameId: components["parameters"]["GameId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WxLoginRequest"];
            };
        };
        responses: {
            /** @description 登录成功 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["Internal"];
            503: components["responses"]["Unavailable"];
        };
    };
    version: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 版本信息 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VersionResponse"];
                };
            };
        };
    };
}
