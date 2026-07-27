import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  GameManageKitPath,
  type AdminAccountDetailResponse,
  type AdminAccountRequest,
  type AdminAccountResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import type {
  AdminAccountService,
  AdminAction,
} from "../../domain/account/admin.js";
import {
  requireAdminAccountCapability,
  requireAdminGameAccess,
  type AdminAuthService,
  type AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type {
  AdminIdentity,
  GameContext,
  GameRegistry,
} from "../../domain/game/registry.js";
import { GameManageKitError } from "../../errors.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import { normalizeIp } from "../../infra/security/security.js";
import {
  authenticateAdmin,
  errorResponseSchemas,
  fastifyPath,
  gameParamsSchema,
  headerValue,
  resolveGameContext,
  schemaRef,
} from "../common.js";
import {
  clearAdminSessionCookies,
  parseAdminSessionCookie,
  requireAdminSessionCookie,
  requireAllowedAdminOrigin,
} from "./browser-security.js";

export interface AdminRouteServices {
  readonly games: GameRegistry;
  readonly admin: Pick<
    AdminAccountService,
    "find" | "execute" | "auditDenied"
  >;
  readonly adminAuth: Pick<
    AdminAuthService,
    "login" | "authenticate" | "logout" | "requireAccountOperation"
    | "requireGameAccess"
  >;
  readonly metrics: MetricsRegistry;
}

interface AccountParams {
  gameId: string;
  userId: string;
}

interface AuthorizedAdmin {
  readonly game: GameContext;
  readonly operatorId: string;
  readonly caller: "admin-web" | "admin-secret";
  readonly ip: string | null;
  readonly sessionIdentity: AdminSessionIdentity | null;
}

const accountParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gameId", "userId"],
  properties: {
    gameId: gameParamsSchema.properties.gameId,
    userId: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      pattern: "^u_[0-9]+$",
    },
  },
} as const;

const noStoreHook = async (
  _request: unknown,
  reply: FastifyReply,
): Promise<void> => {
  void reply.header("cache-control", "no-store");
};

function rateLimit(
  auth: AuthorizedAdmin,
  services: AdminRouteServices,
): void {
  const ipKey = auth.ip ?? "unknown";
  if (
    !auth.game.adminLimiter.allow(
      `${auth.game.gameId}:${auth.operatorId}:${ipKey}`,
    )
  ) {
    services.metrics.recordRateLimit(auth.game.gameId, "admin");
    throw new GameManageKitError(429, "RATE_LIMITED");
  }
}

async function auditDenied(
  request: FastifyRequest<{ Params: AccountParams }>,
  services: AdminRouteServices,
  auth: Omit<AuthorizedAdmin, "game">,
  reason: "game_access_denied" | "account_capability_denied",
): Promise<void> {
  const gameId = request.params.gameId;
  if (!services.games.get(gameId)) {
    return;
  }
  await services.admin.auditDenied({
    gameId,
    userId: request.params.userId,
    operatorId: auth.operatorId,
    caller: auth.caller,
    ip: auth.ip,
    reason,
  });
}

async function authorizeSecret(
  request: FastifyRequest<{ Params: AccountParams }>,
  services: AdminRouteServices,
): Promise<AuthorizedAdmin> {
  const identity: AdminIdentity = authenticateAdmin(request, services.games);
  if (!services.games.canAccess(identity, request.params.gameId)) {
    await auditDenied(request, services, {
      operatorId: identity.operatorId,
      caller: "admin-secret",
      ip: normalizeIp(request.ip),
      sessionIdentity: null,
    }, "game_access_denied");
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
  const game = resolveGameContext(request, services.games);
  return {
    game,
    operatorId: identity.operatorId,
    caller: "admin-secret",
    ip: normalizeIp(request.ip),
    sessionIdentity: null,
  };
}

async function authorizeRequest(
  request: FastifyRequest<{ Params: AccountParams }>,
  config: GameManageKitConfig,
  services: AdminRouteServices,
  requireOperate: boolean,
): Promise<AuthorizedAdmin> {
  const production = config.nodeEnv === "production";
  const cookieHeader = headerValue(request, "cookie");
  const cookie = parseAdminSessionCookie(cookieHeader, { production });
  const hasCookieCredential = cookie.ok || cookie.reason !== "missing";
  const hasHeaderCredential =
    headerValue(request, "x-operator-id") !== null
    || headerValue(request, "x-admin-secret") !== null;
  if (hasCookieCredential && hasHeaderCredential) {
    throw new GameManageKitError(401, "ADMIN_AUTH_REQUIRED");
  }
  if (!hasCookieCredential) {
    return authorizeSecret(request, services);
  }

  if (requireOperate) {
    requireAllowedAdminOrigin(
      headerValue(request, "origin"),
      [config.adminOrigin],
    );
  }
  const token = requireAdminSessionCookie(cookieHeader, { production });
  const identity = await services.adminAuth.authenticate(token, request.ip);
  request.adminSessionIdentity = identity;
  request.log = request.log.child({ operatorId: identity.operatorId });
  const base = {
    operatorId: identity.operatorId,
    caller: "admin-web" as const,
    ip: normalizeIp(request.ip),
    sessionIdentity: identity,
  };
  try {
    requireAdminGameAccess(identity, request.params.gameId);
  } catch (error) {
    if (error instanceof GameManageKitError && error.statusCode === 403) {
      await auditDenied(request, services, base, "game_access_denied");
    }
    throw error;
  }
  const game = resolveGameContext(request, services.games);
  if (requireOperate) {
    try {
      requireAdminAccountCapability(identity, game.gameId);
    } catch (error) {
      if (error instanceof GameManageKitError && error.statusCode === 403) {
        await auditDenied(
          request,
          services,
          base,
          "account_capability_denied",
        );
      }
      throw error;
    }
  }
  return { game, ...base };
}

async function authorizeWithCookieCleanup(
  request: FastifyRequest<{ Params: AccountParams }>,
  reply: FastifyReply,
  config: GameManageKitConfig,
  services: AdminRouteServices,
  requireOperate: boolean,
): Promise<AuthorizedAdmin> {
  try {
    return await authorizeRequest(
      request,
      config,
      services,
      requireOperate,
    );
  } catch (error) {
    if (
      error instanceof GameManageKitError
      && error.statusCode === 401
    ) {
      void reply.header("set-cookie", clearAdminSessionCookies());
    }
    throw error;
  }
}

function registerAction(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminRouteServices,
  action: AdminAction,
  path: string,
): void {
  app.post<{ Params: AccountParams; Body: AdminAccountRequest }>(
    fastifyPath(path),
    {
      onRequest: noStoreHook,
      schema: {
        params: accountParamsSchema,
        body: schemaRef("AdminAccountRequest"),
        response: {
          200: schemaRef("AdminAccountResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<AdminAccountResponse> => {
      void reply.header("cache-control", "no-store");
      const auth = await authorizeWithCookieCleanup(
        request,
        reply,
        config,
        services,
        true,
      );
      rateLimit(auth, services);
      try {
        return await services.admin.execute({
          gameId: auth.game.gameId,
          action,
          userId: request.params.userId,
          operationId: request.body.operationId,
          operatorId: auth.operatorId,
          caller: auth.caller,
          reason: request.body.reason,
          ip: auth.ip,
          ...(auth.sessionIdentity
            ? {
                authorize: async (connection) => (
                  services.adminAuth.requireAccountOperation(
                    connection,
                    auth.sessionIdentity!,
                    auth.game.gameId,
                  )
                ),
              }
            : {}),
        });
      } catch (error) {
        if (
          auth.sessionIdentity
          && error instanceof GameManageKitError
          && error.statusCode === 403
        ) {
          await auditDenied(
            request,
            services,
            auth,
            "account_capability_denied",
          );
        }
        throw error;
      }
    },
  );
}

export function registerAdminRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminRouteServices,
): void {
  app.get<{ Params: AccountParams }>(
    fastifyPath(GameManageKitPath.GetAdminAccount),
    {
      onRequest: noStoreHook,
      schema: {
        params: accountParamsSchema,
        response: {
          200: schemaRef("AdminAccountDetailResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<AdminAccountDetailResponse> => {
      void reply.header("cache-control", "no-store");
      const auth = await authorizeWithCookieCleanup(
        request,
        reply,
        config,
        services,
        false,
      );
      rateLimit(auth, services);
      const account = await services.admin.find({
        gameId: auth.game.gameId,
        userId: request.params.userId,
        sessionTtlSeconds: auth.game.sessionTtlSeconds,
        operatorId: auth.operatorId,
        caller: auth.caller,
        ip: auth.ip,
        ...(auth.sessionIdentity
          ? {
              authorize: async (connection) => (
                services.adminAuth.requireGameAccess(
                  connection,
                  auth.sessionIdentity!,
                  auth.game.gameId,
                )
              ),
            }
          : {}),
      });
      if (!account) {
        throw new GameManageKitError(404, "NOT_FOUND");
      }
      return account;
    },
  );

  registerAction(
    app,
    config,
    services,
    "ban",
    GameManageKitPath.BanAccount,
  );
  registerAction(
    app,
    config,
    services,
    "revoke",
    GameManageKitPath.RevokeAccount,
  );
}
