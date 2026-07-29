import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  type GameIntegration,
  GameManageKitPath,
  type ClearIdentityProviderSecretRequest,
  type IdentityProvider,
  type IdentityProviderSecretWriteResponse,
  type ReplaceIdentityProviderSecretRequest,
  type UpdateGameIntegrationRequest,
  type UpdateIdentityProviderRequest,
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
    "get" | "updateShared" | "updateProvider"
    | "replaceProviderSecret" | "clearProviderSecret"
  >;
}

interface GameParams {
  readonly gameId: string;
}

interface IdentityProviderParams extends GameParams {
  readonly provider: IdentityProvider;
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

const identityProviderParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gameId", "provider"],
  properties: {
    gameId: schemaRef("GameId"),
    provider: schemaRef("IdentityProvider"),
  },
} as const;

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
      return services.integrations.updateShared(
        request.params.gameId,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );

  app.patch<{
    Params: IdentityProviderParams;
    Body: UpdateIdentityProviderRequest;
  }>(
    fastifyPath(GameManageKitPath.UpdateAdminIdentityProvider),
    {
      onRequest: noStoreHook,
      schema: {
        params: identityProviderParamsSchema,
        body: schemaRef("UpdateIdentityProviderRequest"),
        response: {
          200: schemaRef("GameIntegration"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameIntegration> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.integrations.updateProvider(
        request.params.gameId,
        request.params.provider,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );

  app.put<{
    Params: IdentityProviderParams;
    Body: ReplaceIdentityProviderSecretRequest;
  }>(
    fastifyPath(GameManageKitPath.ReplaceAdminIdentityProviderSecret),
    {
      onRequest: noStoreHook,
      schema: {
        params: identityProviderParamsSchema,
        body: schemaRef("ReplaceIdentityProviderSecretRequest"),
        response: {
          200: schemaRef("IdentityProviderSecretWriteResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<IdentityProviderSecretWriteResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.integrations.replaceProviderSecret(
        request.params.gameId,
        request.params.provider,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );

  app.delete<{
    Params: IdentityProviderParams;
    Body: ClearIdentityProviderSecretRequest;
  }>(
    fastifyPath(GameManageKitPath.ClearAdminIdentityProviderSecret),
    {
      onRequest: noStoreHook,
      schema: {
        params: identityProviderParamsSchema,
        body: schemaRef("ClearIdentityProviderSecretRequest"),
        response: {
          200: schemaRef("IdentityProviderSecretWriteResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<IdentityProviderSecretWriteResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.integrations.clearProviderSecret(
        request.params.gameId,
        request.params.provider,
        request.body,
        configurationAuthorization(request, auth, services),
      );
    },
  );
}
