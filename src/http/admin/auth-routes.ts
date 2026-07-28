import type { FastifyInstance, FastifyReply } from "fastify";
import {
  GameManageKitPath,
  type AdminBootstrapRequest,
  type AdminBootstrapStatus,
  type AdminLoginRequest,
  type AdminReauthenticateRequest,
  type AdminSessionResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  type AdminAuthService,
  type AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type { GameRuntimeRegistry } from "../../domain/game/resolver.js";
import { GameManageKitError } from "../../errors.js";
import {
  clearAdminSessionCookies,
  requireAdminSessionCookie,
  requireAllowedAdminOrigin,
  serializeAdminSessionCookie,
} from "./browser-security.js";
import {
  errorResponseSchemas,
  fastifyPath,
  headerValue,
  schemaRef,
} from "../common.js";

export interface AdminAuthRouteServices {
  readonly games: GameRuntimeRegistry;
  readonly adminAuth: Pick<
    AdminAuthService,
    "bootstrapRequired" | "bootstrap"
    | "login" | "reauthenticate" | "authenticate" | "logout"
    | "requireAccountOperation"
    | "requireGameAccess" | "requireGameManagement"
  >;
}

function noStore(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

function sessionCookies(
  sessionToken: string,
  production: boolean,
): readonly string[] {
  return [
    ...clearAdminSessionCookies(),
    serializeAdminSessionCookie(sessionToken, {
      production,
      maxAgeSeconds: Math.floor(
        ADMIN_SESSION_ABSOLUTE_TTL_MS / 1_000,
      ),
    }),
  ];
}

const noStoreHook = async (
  _request: unknown,
  reply: FastifyReply,
): Promise<void> => {
  noStore(reply);
};

function sessionResponse(
  identity: AdminSessionIdentity,
): AdminSessionResponse {
  return {
    operator: {
      operatorId: identity.operatorId,
      displayName: identity.displayName,
    },
    games: identity.games.flatMap((access) => {
      return access.configurationState === "configured"
        ? [{
            gameId: access.gameId,
            name: access.name,
            status: access.status,
            canOperateAccounts:
              access.canOperateAccounts && access.status === "enabled",
          }]
        : [];
    }),
    canManageGames: identity.canManageGames,
    canManageIntegrations: identity.canManageIntegrations,
    canRotateSecrets: identity.canRotateSecrets,
    canManageMachineIdentities: identity.canManageMachineIdentities,
    expiresAt: identity.expiresAt,
    elevatedUntil: identity.elevatedUntil,
  };
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminAuthRouteServices,
): void {
  const production = config.nodeEnv === "production";
  const cookieReadOptions = { production } as const;
  const allowedOrigins = [config.adminOrigin] as const;

  app.get(
    fastifyPath(GameManageKitPath.GetAdminBootstrapStatus),
    {
      onRequest: noStoreHook,
      schema: {
        response: {
          200: schemaRef("AdminBootstrapStatus"),
          ...errorResponseSchemas,
        },
      },
    },
    async (_request, reply): Promise<AdminBootstrapStatus> => {
      noStore(reply);
      return {
        required: await services.adminAuth.bootstrapRequired(),
      };
    },
  );

  app.post<{ Body: AdminBootstrapRequest }>(
    fastifyPath(GameManageKitPath.BootstrapAdmin),
    {
      onRequest: noStoreHook,
      schema: {
        body: schemaRef("AdminBootstrapRequest"),
        response: {
          204: { type: "null" },
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        allowedOrigins,
      );
      const issued = await services.adminAuth.bootstrap({
        operatorId: request.body.operatorId,
        displayName: request.body.displayName,
        password: request.body.password,
        ip: request.ip,
      });
      request.log = request.log.child({ operatorId: issued.operatorId });
      return reply
        .header(
          "set-cookie",
          sessionCookies(issued.sessionToken, production),
        )
        .code(204)
        .send();
    },
  );

  app.post<{ Body: AdminLoginRequest }>(
    fastifyPath(GameManageKitPath.AdminLogin),
    {
      onRequest: noStoreHook,
      schema: {
        body: schemaRef("AdminLoginRequest"),
        response: {
          204: { type: "null" },
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        allowedOrigins,
      );
      const issued = await services.adminAuth.login({
        operatorId: request.body.operatorId,
        password: request.body.password,
        ip: request.ip,
      });
      return reply
        .header(
          "set-cookie",
          sessionCookies(issued.sessionToken, production),
        )
        .code(204)
        .send();
    },
  );

  app.get(
    fastifyPath(GameManageKitPath.GetAdminSession),
    {
      onRequest: noStoreHook,
      schema: {
        response: {
          200: schemaRef("AdminSessionResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<AdminSessionResponse> => {
      noStore(reply);
      try {
        const token = requireAdminSessionCookie(
          headerValue(request, "cookie"),
          cookieReadOptions,
        );
        const identity = await services.adminAuth.authenticate(token, request.ip);
        return sessionResponse(identity);
      } catch (error) {
        if (
          error instanceof GameManageKitError
          && error.statusCode === 401
        ) {
          void reply.header("set-cookie", clearAdminSessionCookies());
        }
        throw error;
      }
    },
  );

  app.post<{ Body: AdminReauthenticateRequest }>(
    fastifyPath(GameManageKitPath.AdminReauthenticate),
    {
      onRequest: noStoreHook,
      schema: {
        body: schemaRef("AdminReauthenticateRequest"),
        response: {
          204: { type: "null" },
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        allowedOrigins,
      );
      try {
        const token = requireAdminSessionCookie(
          headerValue(request, "cookie"),
          cookieReadOptions,
        );
        const identity = await services.adminAuth.reauthenticate(
          token,
          request.body.password,
          request.ip,
        );
        request.adminSessionIdentity = identity;
        request.log = request.log.child({ operatorId: identity.operatorId });
        return reply.code(204).send();
      } catch (error) {
        if (
          error instanceof GameManageKitError
          && error.statusCode === 401
        ) {
          void reply.header("set-cookie", clearAdminSessionCookies());
        }
        throw error;
      }
    },
  );

  app.delete(
    fastifyPath(GameManageKitPath.AdminLogout),
    {
      onRequest: noStoreHook,
      schema: {
        response: {
          204: { type: "null" },
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        allowedOrigins,
      );
      void reply.header("set-cookie", clearAdminSessionCookies());
      const token = requireAdminSessionCookie(
        headerValue(request, "cookie"),
        cookieReadOptions,
      );
      await services.adminAuth.logout(token, request.ip);
      return reply
        .code(204)
        .send();
    },
  );
}
