import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  type GameIntegration,
  GameManageKitPath,
  type ReplaceWechatAppSecretRequest,
  type UpdateGameIntegrationRequest,
  type WechatSecretWriteResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import type {
  AdminAuthService,
  AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type {
  ConfigurationAuthorization,
  ConfigurationAuthorizationKind,
  GameIntegrationService,
} from "../../domain/game/integrations.js";
import { GameManageKitError } from "../../errors.js";
import {
  normalizeIp,
  TokenBucketLimiter,
} from "../../infra/security/security.js";
import {
  errorResponseSchemas,
  fastifyPath,
  gameParamsSchema,
  headerValue,
  schemaRef,
} from "../common.js";
import {
  clearAdminSessionCookies,
  requireAdminSessionCookie,
  requireAllowedAdminOrigin,
} from "./browser-security.js";

export interface AdminIntegrationRouteServices {
  readonly adminAuth: Pick<
    AdminAuthService,
    "authenticate" | "requireIntegrationManagement"
    | "requireSecretRotation"
  >;
  readonly integrations: Pick<
    GameIntegrationService,
    "get" | "update" | "replaceWechatSecret"
  >;
}

interface GameParams {
  readonly gameId: string;
}

interface AuthorizedAdmin {
  readonly identity: AdminSessionIdentity;
  readonly sessionToken: string;
}

const noStoreHook = async (
  _request: unknown,
  reply: FastifyReply,
): Promise<void> => {
  void reply.header("cache-control", "no-store");
};

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  config: GameManageKitConfig,
  services: AdminIntegrationRouteServices,
  requireOrigin: boolean,
): Promise<AuthorizedAdmin> {
  try {
    if (requireOrigin) {
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        [config.adminOrigin],
      );
    }
    const sessionToken = requireAdminSessionCookie(
      headerValue(request, "cookie"),
      { production: config.nodeEnv === "production" },
    );
    const identity = await services.adminAuth.authenticate(
      sessionToken,
      request.ip,
    );
    request.adminSessionIdentity = identity;
    request.log = request.log.child({ operatorId: identity.operatorId });
    return { identity, sessionToken };
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

function configurationAuthorization(
  request: FastifyRequest,
  auth: AuthorizedAdmin,
  services: AdminIntegrationRouteServices,
): ConfigurationAuthorization {
  return {
    operatorId: auth.identity.operatorId,
    ip: request.ip,
    requestId: request.id,
    authorize: async (connection, kind: ConfigurationAuthorizationKind) => {
      await services.adminAuth.requireIntegrationManagement(
        connection,
        auth.identity,
      );
      if (kind === "secret") {
        await services.adminAuth.requireSecretRotation(
          connection,
          auth.identity,
          auth.sessionToken,
        );
      }
    },
  };
}

export function registerAdminIntegrationRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminIntegrationRouteServices,
): void {
  const mutationLimiter = new TokenBucketLimiter(20, 1, undefined, 10_000);
  const requireMutationCapacity = (
    request: FastifyRequest,
    identity: AdminSessionIdentity,
  ): void => {
    const ip = normalizeIp(request.ip) ?? "unknown";
    if (!mutationLimiter.allow(`${identity.operatorId}\0${ip}`)) {
      throw new GameManageKitError(429, "RATE_LIMITED");
    }
  };

  app.get<{ Params: GameParams }>(
    fastifyPath(GameManageKitPath.GetAdminGameIntegration),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        response: {
          200: schemaRef("GameIntegration"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameIntegration> => {
      const auth = await authorize(request, reply, config, services, false);
      return services.integrations.get(
        request.params.gameId,
        configurationAuthorization(request, auth, services),
      );
    },
  );

  app.patch<{
    Params: GameParams;
    Body: UpdateGameIntegrationRequest;
  }>(
    fastifyPath(GameManageKitPath.UpdateAdminGameIntegration),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("UpdateGameIntegrationRequest"),
        response: {
          200: schemaRef("GameIntegration"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameIntegration> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.integrations.update(
        request.params.gameId,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );

  app.put<{
    Params: GameParams;
    Body: ReplaceWechatAppSecretRequest;
  }>(
    fastifyPath(GameManageKitPath.ReplaceAdminWechatAppSecret),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("ReplaceWechatAppSecretRequest"),
        response: {
          200: schemaRef("WechatSecretWriteResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<WechatSecretWriteResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.integrations.replaceWechatSecret(
        request.params.gameId,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );
}
