import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type AreaListResponse,
  type ClientGameListResponse,
  type DevLoginRequest,
  type DouyinLoginRequest,
  type LoginResponse,
  type WxLoginRequest,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import type {
  LoginAttempt,
  LoginResult,
  LoginService,
} from "../../domain/account/login.js";
import type { AuthProvider } from "../../domain/account/auth-provider.js";
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
  readonly login: Pick<
    LoginService,
    "loginWechat" | "loginDouyin" | "loginDev"
  > & Partial<Pick<LoginService, "auditAdmissionDenied">>;
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
      throw new GameManageKitError(429, "RATE_LIMITED");
    case "invalid_code":
      throw new GameManageKitError(401, "AUTH_CODE_INVALID");
    case "invalid_credentials":
      throw new GameManageKitError(
        503,
        "PROVIDER_CONFIGURATION_INVALID",
      );
    case "identity_conflict":
      throw new GameManageKitError(409, "IDENTITY_CONFLICT");
    case "timeout":
    case "unavailable":
    case "circuit_open":
    case "invalid_response":
      throw new GameManageKitError(503, "PROVIDER_UNAVAILABLE");
  }
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

async function requireLoginServer(
  services: PublicRouteServices,
  game: Parameters<GameRuntimeRegistry["requireServer"]>[0],
  provider: AuthProvider,
  attempt: LoginAttempt,
): Promise<void> {
  try {
    await services.games.requireServer(game, attempt.serverId);
  } catch (error) {
    if (
      error instanceof GameManageKitError
      && (error.statusCode === 403 || error.statusCode === 404)
    ) {
      await services.login.auditAdmissionDenied?.(
        typeof game === "string" ? game : game.gameId,
        provider,
        attempt,
        error.code,
      ).catch(() => undefined);
    }
    throw error;
  }
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
      const ip = normalizeIp(request.ip);
      const attempt = {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        requestId: request.id,
        serverId: request.body.serverId,
      };
      await requireLoginServer(services, game, "wechat", attempt);
      return loginResponse(
        await services.login.loginWechat(game, request.body.code, attempt),
      );
    },
  );

  app.post<{ Params: GameParams; Body: DouyinLoginRequest }>(
    fastifyPath(GameManageKitPath.DouyinLogin),
    {
      preHandler,
      schema: {
        params: gameParamsSchema,
        body: schemaRef("DouyinLoginRequest"),
        response: {
          200: schemaRef("LoginResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<LoginResponse> => {
      const game = request.gameContext!;
      const ip = normalizeIp(request.ip);
      const attempt = {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        requestId: request.id,
        serverId: request.body.serverId,
      };
      await requireLoginServer(services, game, "douyin", attempt);
      return loginResponse(
        await services.login.loginDouyin(game, request.body.code, attempt),
      );
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
      const ip = normalizeIp(request.ip);
      const attempt = {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        requestId: request.id,
        serverId: request.body.serverId,
      };
      await requireLoginServer(services, game, "dev", attempt);
      return loginResponse(
        await services.login.loginDev(game, request.body.devKey, attempt),
      );
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
