import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type HasCharacterResponse,
  type RegisterCharacterResponse,
  type VerifySessionRequest,
  type VerifySessionResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import type { CharacterService } from "../../domain/character/service.js";
import type { SessionService } from "../../domain/session/service.js";
import {
  authenticateService,
  errorResponseSchemas,
  fastifyPath,
  schemaRef,
} from "../common.js";

export interface InternalRouteServices {
  readonly sessions: Pick<SessionService, "verify">;
  readonly characters: Pick<CharacterService, "register" | "has">;
}

interface CharacterParams {
  userId: string;
  serverId: number;
}

const characterParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "serverId"],
  properties: {
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
  config: GameManageKitConfig,
  services: InternalRouteServices,
): void {
  const preHandler = async (request: Parameters<typeof authenticateService>[0]): Promise<void> => {
    authenticateService(request, config);
  };

  app.post<{ Body: VerifySessionRequest }>(
    GameManageKitPath.VerifySession,
    {
      preHandler,
      schema: {
        body: schemaRef("VerifySessionRequest"),
        response: {
          200: schemaRef("VerifySessionResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<VerifySessionResponse> => {
      return services.sessions.verify(request.body.accessToken, request.body.serverId);
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
      await services.characters.register(request.params.userId, request.params.serverId);
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
      return {
        exists: await services.characters.has(request.params.userId, request.params.serverId),
      };
    },
  );
}
