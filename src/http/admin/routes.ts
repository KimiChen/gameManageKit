import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type AdminAccountRequest,
  type AdminAccountResponse,
} from "@gono/game-manage-kit-contract";
import type {
  AdminAccountService,
  AdminAction,
} from "../../domain/account/admin.js";
import type { GameRegistry } from "../../domain/game/registry.js";
import { GameManageKitError } from "../../errors.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import { normalizeIp } from "../../infra/security/security.js";
import {
  authorizeAdminGame,
  errorResponseSchemas,
  fastifyPath,
  gameParamsSchema,
  schemaRef,
} from "../common.js";

export interface AdminRouteServices {
  readonly games: GameRegistry;
  readonly admin: Pick<AdminAccountService, "execute">;
  readonly metrics: MetricsRegistry;
}

interface AccountParams {
  gameId: string;
  userId: string;
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

function registerAction(
  app: FastifyInstance,
  services: AdminRouteServices,
  action: AdminAction,
  path: string,
): void {
  app.post<{ Params: AccountParams; Body: AdminAccountRequest }>(
    fastifyPath(path),
    {
      preHandler: async (request) => {
        authorizeAdminGame(request, services.games);
      },
      schema: {
        params: accountParamsSchema,
        body: schemaRef("AdminAccountRequest"),
        response: {
          200: schemaRef("AdminAccountResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<AdminAccountResponse> => {
      const game = request.gameContext!;
      const operatorId = request.adminIdentity!.operatorId;
      const ip = normalizeIp(request.ip);
      if (!game.adminLimiter.allow(`${game.gameId}:${operatorId}:${ip ?? request.ip}`)) {
        services.metrics.recordRateLimit(game.gameId, "admin");
        throw new GameManageKitError(429, "RATE_LIMITED");
      }
      return services.admin.execute({
        gameId: game.gameId,
        action,
        userId: request.params.userId,
        operationId: request.body.operationId,
        operatorId,
        caller: "admin-api",
        reason: request.body.reason,
        ip,
      });
    },
  );
}

export function registerAdminRoutes(
  app: FastifyInstance,
  services: AdminRouteServices,
): void {
  registerAction(app, services, "ban", GameManageKitPath.BanAccount);
  registerAction(app, services, "revoke", GameManageKitPath.RevokeAccount);
}
