import type { FastifyInstance, FastifyReply } from "fastify";
import {
  GameManageKitPath,
  type AdminLoginRequest,
  type AdminSessionResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  type AdminAuthService,
  type AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type { GameRegistry } from "../../domain/game/registry.js";
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
  readonly games: GameRegistry;
  readonly adminAuth: Pick<
    AdminAuthService,
    "login" | "authenticate" | "logout" | "requireAccountOperation"
    | "requireGameAccess"
  >;
}

function noStore(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

const noStoreHook = async (
  _request: unknown,
  reply: FastifyReply,
): Promise<void> => {
  noStore(reply);
};

function sessionResponse(
  identity: AdminSessionIdentity,
  games: GameRegistry,
): AdminSessionResponse {
  return {
    operator: {
      operatorId: identity.operatorId,
      displayName: identity.displayName,
    },
    games: identity.games.flatMap((access) => {
      const game = games.get(access.gameId);
      return game
        ? [{
            gameId: game.gameId,
            name: game.name,
            status: game.status,
            canOperateAccounts:
              access.canOperateAccounts && game.status === "enabled",
          }]
        : [];
    }),
    expiresAt: identity.expiresAt,
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
          [
            ...clearAdminSessionCookies(),
            serializeAdminSessionCookie(issued.sessionToken, {
              production,
              maxAgeSeconds: Math.floor(
                ADMIN_SESSION_ABSOLUTE_TTL_MS / 1_000,
              ),
            }),
          ],
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
        return sessionResponse(identity, services.games);
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
