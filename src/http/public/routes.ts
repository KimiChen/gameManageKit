import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type AreaListResponse,
  type ClientGameListResponse,
  type DevLoginRequest,
  type LoginResponse,
  type WxLoginRequest,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import type { LoginResult, LoginService } from "../../domain/account/login.js";
import type { DirectoryService } from "../../domain/directory/service.js";
import type { GameRuntimeRegistry } from "../../domain/game/resolver.js";
import type { GameProjectService } from "../../domain/game/projects.js";
import {
  errorResponseSchemas,
  fastifyPath,
  gameParamsSchema,
  headerValue,
  resolveGameContext,
  schemaRef,
} from "../common.js";

export interface PublicRouteServices {
  readonly games: GameRuntimeRegistry;
  readonly gameProjects: Pick<
    GameProjectService,
    "listForClient" | "resolve"
  >;
  readonly login: Pick<LoginService, "loginWechat" | "loginDev">;
  readonly directory: Pick<DirectoryService, "list">;
}

interface GameParams {
  gameId: string;
}

function loginResponse(result: LoginResult): LoginResponse {
  if (result.ok) {
    return result.response;
  }
  switch (result.reason) {
    case "banned":
      throw new GameManageKitError(403, "ACCOUNT_BANNED");
    case "rate_limited":
    case "wx_rate_limited":
      throw new GameManageKitError(429, "RATE_LIMITED");
    case "wx_invalid":
      throw new GameManageKitError(401, "AUTH_REQUIRED");
    case "wx_unavailable":
      throw new GameManageKitError(503, "UPSTREAM_UNAVAILABLE");
  }
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export function registerPublicRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: PublicRouteServices,
): void {
  const preHandler = async (request: Parameters<typeof resolveGameContext>[0]): Promise<void> => {
    await resolveGameContext(request, services.gameProjects);
  };

  app.get(
    GameManageKitPath.ListClientGames,
    {
      schema: {
        response: {
          200: schemaRef("ClientGameListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (_request, reply): Promise<ClientGameListResponse> => {
      void reply.header("cache-control", "no-store");
      return { games: [...await services.gameProjects.listForClient()] };
    },
  );

  app.post<{ Params: GameParams; Body: WxLoginRequest }>(
    fastifyPath(GameManageKitPath.WxLogin),
    {
      preHandler,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("WxLoginRequest"),
        response: {
          200: schemaRef("LoginResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<LoginResponse> => {
      const game = request.gameContext!;
      await services.games.requireServer(game, request.body.serverId);
      const ip = normalizeIp(request.ip);
      return loginResponse(await services.login.loginWechat(game, request.body.code, {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        serverId: request.body.serverId,
      }));
    },
  );

  app.post<{ Params: GameParams; Body: DevLoginRequest }>(
    fastifyPath(GameManageKitPath.DevLogin),
    {
      onRequest: async () => {
        if (!config.authDevEnabled) {
          throw new GameManageKitError(404, "NOT_FOUND");
        }
      },
      preHandler,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("DevLoginRequest"),
        response: {
          200: schemaRef("LoginResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<LoginResponse> => {
      const game = request.gameContext!;
      await services.games.requireServer(game, request.body.serverId);
      const ip = normalizeIp(request.ip);
      return loginResponse(await services.login.loginDev(game, request.body.devKey, {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        serverId: request.body.serverId,
      }));
    },
  );

  app.get<{ Params: GameParams }>(
    fastifyPath(GameManageKitPath.ListAreas),
    {
      preHandler,
      schema: {
        params: gameParamsSchema,
        response: {
          200: schemaRef("AreaListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<AreaListResponse> => {
      void reply.header("cache-control", "private, no-store");
      void reply.header("vary", "Authorization");
      const token = bearerToken(headerValue(request, "authorization"));
      return services.directory.list(request.gameContext!, token);
    },
  );
}
