import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  type CreateGameServerRequest,
  type GameDirectorySettings,
  GameManageKitPath,
  type CreateGameProjectRequest,
  type GameProject,
  type GameProjectListResponse,
  type ManagedGameServerListResponse,
  type ManagedGameServerMutationResponse,
  type UpdateGameDirectorySettingsRequest,
  type UpdateGameServerRequest,
  type UpdateGameProjectRequest,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import {
  requireAdminGameManagement,
  type AdminAuthService,
  type AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type { GameProjectService } from "../../domain/game/projects.js";
import type { GameServerService } from "../../domain/game/servers.js";
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

export interface AdminGameRouteServices {
  readonly adminAuth: Pick<
    AdminAuthService,
    "authenticate" | "requireGameManagement"
  >;
  readonly gameProjects: Pick<
    GameProjectService,
    "list" | "create" | "update"
  >;
  readonly gameServers: Pick<
    GameServerService,
    "getDirectorySettings" | "updateDirectorySettings"
    | "list" | "create" | "update"
  >;
}

interface GameParams {
  gameId: string;
}

interface GameServerParams extends GameParams {
  serverId: number;
}

const gameServerParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gameId", "serverId"],
  properties: {
    gameId: gameParamsSchema.properties.gameId,
    serverId: {
      type: "integer",
      minimum: 0,
      maximum: 65_535,
    },
  },
} as const;

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
  services: AdminGameRouteServices,
  requireOrigin: boolean,
): Promise<AdminSessionIdentity> {
  try {
    if (requireOrigin) {
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        [config.adminOrigin],
      );
    }
    const token = requireAdminSessionCookie(
      headerValue(request, "cookie"),
      { production: config.nodeEnv === "production" },
    );
    const identity = await services.adminAuth.authenticate(token, request.ip);
    requireAdminGameManagement(identity);
    request.adminSessionIdentity = identity;
    request.log = request.log.child({ operatorId: identity.operatorId });
    return identity;
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

function projectAuthorization(
  request: FastifyRequest,
  identity: AdminSessionIdentity,
  services: AdminGameRouteServices,
) {
  return {
    operatorId: identity.operatorId,
    ip: request.ip,
    authorize: async (connection: Parameters<
      AdminAuthService["requireGameManagement"]
    >[0]) => {
      await services.adminAuth.requireGameManagement(
        connection,
        identity,
      );
    },
  };
}

export function registerAdminGameRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminGameRouteServices,
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

  app.get(
    GameManageKitPath.ListAdminGames,
    {
      onRequest: noStoreHook,
      schema: {
        response: {
          200: schemaRef("GameProjectListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameProjectListResponse> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        false,
      );
      return {
        games: [
          ...await services.gameProjects.list(
            projectAuthorization(request, identity, services),
          ),
        ],
      };
    },
  );

  app.post<{ Body: CreateGameProjectRequest }>(
    GameManageKitPath.CreateAdminGame,
    {
      onRequest: noStoreHook,
      schema: {
        body: schemaRef("CreateGameProjectRequest"),
        response: {
          201: schemaRef("GameProject"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameProject> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        true,
      );
      requireMutationCapacity(request, identity);
      const project = await services.gameProjects.create(
        request.body,
        projectAuthorization(request, identity, services),
      );
      return reply.code(201).send(project);
    },
  );

  app.patch<{ Params: GameParams; Body: UpdateGameProjectRequest }>(
    fastifyPath(GameManageKitPath.UpdateAdminGame),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("UpdateGameProjectRequest"),
        response: {
          200: schemaRef("GameProject"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameProject> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        true,
      );
      requireMutationCapacity(request, identity);
      return services.gameProjects.update(
        request.params.gameId,
        request.body,
        projectAuthorization(request, identity, services),
      );
    },
  );

  app.get<{ Params: GameParams }>(
    fastifyPath(GameManageKitPath.GetAdminGameDirectorySettings),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        response: {
          200: schemaRef("GameDirectorySettings"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameDirectorySettings> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        false,
      );
      return services.gameServers.getDirectorySettings(
        request.params.gameId,
        projectAuthorization(request, identity, services),
      );
    },
  );

  app.patch<{
    Params: GameParams;
    Body: UpdateGameDirectorySettingsRequest;
  }>(
    fastifyPath(GameManageKitPath.UpdateAdminGameDirectorySettings),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("UpdateGameDirectorySettingsRequest"),
        response: {
          200: schemaRef("GameDirectorySettings"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<GameDirectorySettings> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        true,
      );
      requireMutationCapacity(request, identity);
      return services.gameServers.updateDirectorySettings(
        request.params.gameId,
        request.body,
        projectAuthorization(request, identity, services),
      );
    },
  );

  app.get<{ Params: GameParams }>(
    fastifyPath(GameManageKitPath.ListAdminGameServers),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        response: {
          200: schemaRef("ManagedGameServerListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<ManagedGameServerListResponse> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        false,
      );
      const result = await services.gameServers.list(
        request.params.gameId,
        projectAuthorization(request, identity, services),
      );
      return {
        directoryRevision: result.directoryRevision,
        servers: [...result.servers],
      };
    },
  );

  app.post<{ Params: GameParams; Body: CreateGameServerRequest }>(
    fastifyPath(GameManageKitPath.CreateAdminGameServer),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("CreateGameServerRequest"),
        response: {
          201: schemaRef("ManagedGameServerMutationResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<ManagedGameServerMutationResponse> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        true,
      );
      requireMutationCapacity(request, identity);
      const server = await services.gameServers.create(
        request.params.gameId,
        request.body,
        projectAuthorization(request, identity, services),
      );
      return reply.code(201).send(server);
    },
  );

  app.patch<{
    Params: GameServerParams;
    Body: UpdateGameServerRequest;
  }>(
    fastifyPath(GameManageKitPath.UpdateAdminGameServer),
    {
      onRequest: noStoreHook,
      schema: {
        params: gameServerParamsSchema,
        body: schemaRef("UpdateGameServerRequest"),
        response: {
          200: schemaRef("ManagedGameServerMutationResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<ManagedGameServerMutationResponse> => {
      const identity = await authorize(
        request,
        reply,
        config,
        services,
        true,
      );
      requireMutationCapacity(request, identity);
      return services.gameServers.update(
        request.params.gameId,
        request.params.serverId,
        request.body,
        projectAuthorization(request, identity, services),
      );
    },
  );
}
