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
        AdminSessionResponse: {
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
        DevLoginRequest: {
            deviceId?: string | null;
            devKey: string;
            serverId: number;
        };
        /** @enum {string} */
        ErrorCode: "INVALID_PAYLOAD" | "AUTH_REQUIRED" | "ACCOUNT_BANNED" | "NOT_FOUND" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "SERVICE_AUTH_REQUIRED" | "SERVICE_FORBIDDEN" | "OPERATION_CONFLICT" | "INTERNAL" | "GAME_NOT_FOUND" | "GAME_DISABLED" | "GAME_ACCESS_DENIED" | "SERVER_NOT_FOUND" | "SERVER_DISABLED" | "ADMIN_AUTH_REQUIRED" | "ORIGIN_FORBIDDEN";
        ErrorResponse: {
            code: components["schemas"]["ErrorCode"];
            requestId: string;
        };
        GameId: string;
        /** @enum {string} */
        GameStatus: "enabled" | "maintenance" | "disabled";
        HasCharacterResponse: {
            exists: boolean;
        };
        LiveResponse: {
            /** @constant */
            ok: true;
        };
        LoginResponse: {
            accessToken: string;
            isNewAccount: boolean;
            userId: string;
        };
        ReadyResponse: {
            ready: boolean;
        };
        RegisterCharacterResponse: {
            /** @constant */
            registered: true;
        };
        VerifySessionRequest: {
            accessToken: string;
            serverId: number;
        };
        VerifySessionResponse: {
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
        /** @description 微信上游不可用，或游戏处于维护状态 */
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
        GameId: components["schemas"]["GameId"];
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
