import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type AdminAccountRequest,
  type AdminAccountResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import type {
  AdminAccountService,
  AdminAction,
} from "../../domain/account/admin.js";
import { GameManageKitError } from "../../errors.js";
import type { TokenBucketLimiter } from "../../infra/security/security.js";
import { normalizeIp } from "../../infra/security/security.js";
import {
  authenticateAdmin,
  errorResponseSchemas,
  fastifyPath,
  schemaRef,
} from "../common.js";

export interface AdminRouteServices {
  readonly admin: Pick<AdminAccountService, "execute">;
  readonly adminLimiter: Pick<TokenBucketLimiter, "allow">;
}

interface AccountParams {
  userId: string;
}

const accountParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: {
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
  config: GameManageKitConfig,
  services: AdminRouteServices,
  action: AdminAction,
  path: string,
): void {
  app.post<{ Params: AccountParams; Body: AdminAccountRequest }>(
    fastifyPath(path),
    {
      preHandler: async (request) => {
        authenticateAdmin(request, config);
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
      const operatorId = authenticateAdmin(request, config);
      const ip = normalizeIp(request.ip);
      if (!services.adminLimiter.allow(`${operatorId}:${ip ?? request.ip}`)) {
        throw new GameManageKitError(429, "RATE_LIMITED");
      }
      return services.admin.execute({
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
  config: GameManageKitConfig,
  services: AdminRouteServices,
): void {
  registerAction(app, config, services, "ban", GameManageKitPath.BanAccount);
  registerAction(app, config, services, "revoke", GameManageKitPath.RevokeAccount);
}
