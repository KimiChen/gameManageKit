import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type HasCharacterResponse,
  type RegisterCharacterResponse,
  type VerifySessionRequest,
  type VerifySessionResponse,
} from "@gono/game-manage-kit-contract";
import type { CharacterService } from "../../domain/character/service.js";
import type { GameRegistry } from "../../domain/game/registry.js";
import type { SessionService } from "../../domain/session/service.js";
import {
  authorizeServiceGame,
  errorResponseSchemas,
  fastifyPath,
  gameParamsSchema,
  schemaRef,
} from "../common.js";

export interface InternalRouteServices {
  readonly games: GameRegistry;
  readonly sessions: Pick<SessionService, "verify">;
  readonly characters: Pick<CharacterService, "register" | "has">;
}

interface CharacterParams {
  gameId: string;
  userId: string;
  serverId: number;
}

const characterParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gameId", "userId", "serverId"],
  properties: {
    gameId: gameParamsSchema.properties.gameId,
    userId: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      pattern: "^u_[0-9]+$",
    },
    serverId: {
      type: "integer",
      minimum: 0,
      maximum: 65_535,
    },
  },
} as const;

export function registerInternalRoutes(
  app: FastifyInstance,
  services: InternalRouteServices,
): void {
  const preHandler = async (request: Parameters<typeof authorizeServiceGame>[0]): Promise<void> => {
    authorizeServiceGame(request, services.games);
  };

  app.post<{ Params: Pick<CharacterParams, "gameId">; Body: VerifySessionRequest }>(
    fastifyPath(GameManageKitPath.VerifySession),
    {
      preHandler,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["gameId"],
          properties: {
            gameId: characterParamsSchema.properties.gameId,
          },
        },
        body: schemaRef("VerifySessionRequest"),
        response: {
          200: schemaRef("VerifySessionResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<VerifySessionResponse> => {
      const game = request.gameContext!;
      await services.games.requireServer(game, request.body.serverId);
      return services.sessions.verify(
        game.gameId,
        game.sessionTtlSeconds,
        request.body.accessToken,
        request.body.serverId,
      );
    },
  );

  app.put<{ Params: CharacterParams }>(
    fastifyPath(GameManageKitPath.RegisterCharacter),
    {
      preHandler,
      schema: {
        params: characterParamsSchema,
        response: {
          200: schemaRef("RegisterCharacterResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<RegisterCharacterResponse> => {
      const game = request.gameContext!;
      await services.games.requireServer(game, request.params.serverId);
      await services.characters.register(
        game.gameId,
        request.params.userId,
        request.params.serverId,
      );
      return { registered: true };
    },
  );

  app.get<{ Params: CharacterParams }>(
    fastifyPath(GameManageKitPath.HasCharacter),
    {
      preHandler,
      schema: {
        params: characterParamsSchema,
        response: {
          200: schemaRef("HasCharacterResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<HasCharacterResponse> => {
      const game = request.gameContext!;
      await services.games.requireServer(game, request.params.serverId);
      return {
        exists: await services.characters.has(
          game.gameId,
          request.params.userId,
          request.params.serverId,
        ),
      };
    },
  );
}
