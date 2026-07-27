import type { FastifyInstance } from "fastify";
import {
  GameManageKitPath,
  type AreaListResponse,
  type DevLoginRequest,
  type LoginResponse,
  type WxLoginRequest,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";
import type { LoginResult, LoginService } from "../../domain/account/login.js";
import type { DirectoryService } from "../../domain/directory/service.js";
import { errorResponseSchemas, headerValue, schemaRef } from "../common.js";

export interface PublicRouteServices {
  readonly login: Pick<LoginService, "loginWechat" | "loginDev">;
  readonly directory: Pick<DirectoryService, "list">;
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
  app.post<{ Body: WxLoginRequest }>(
    GameManageKitPath.WxLogin,
    {
      schema: {
        body: schemaRef("WxLoginRequest"),
        response: {
          200: schemaRef("LoginResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<LoginResponse> => {
      const ip = normalizeIp(request.ip);
      return loginResponse(await services.login.loginWechat(request.body.code, {
        rateKey: ip ?? request.ip,
        ip,
        deviceId: request.body.deviceId ?? null,
        serverId: request.body.serverId,
      }));
    },
  );

  if (config.authDevEnabled) {
    app.post<{ Body: DevLoginRequest }>(
      GameManageKitPath.DevLogin,
      {
        schema: {
          body: schemaRef("DevLoginRequest"),
          response: {
            200: schemaRef("LoginResponse"),
            ...errorResponseSchemas,
          },
        },
      },
      async (request): Promise<LoginResponse> => {
        const ip = normalizeIp(request.ip);
        return loginResponse(await services.login.loginDev(request.body.devKey, {
          rateKey: ip ?? request.ip,
          ip,
          deviceId: request.body.deviceId ?? null,
          serverId: request.body.serverId,
        }));
      },
    );
  }

  app.get(
    GameManageKitPath.ListAreas,
    {
      schema: {
        response: {
          200: schemaRef("AreaListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request): Promise<AreaListResponse> => {
      const token = bearerToken(headerValue(request, "authorization"));
      return services.directory.list(token);
    },
  );
}
