import type { FastifyInstance } from "fastify";
import {
  GAME_MANAGE_KIT_CONTRACT_VERSION,
  GameManageKitPath,
  type LiveResponse,
  type ReadyResponse,
  type VersionResponse,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import { schemaRef } from "../common.js";

export interface Readiness {
  ready(): Promise<boolean>;
}

export interface SystemRouteServices {
  readonly readiness: Readiness;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: SystemRouteServices,
): void {
  app.get(
    GameManageKitPath.Livez,
    {
      schema: {
        response: { 200: schemaRef("LiveResponse") },
      },
    },
    async (): Promise<LiveResponse> => ({ ok: true }),
  );

  app.get(
    GameManageKitPath.Readyz,
    {
      schema: {
        response: {
          200: schemaRef("ReadyResponse"),
          503: schemaRef("ReadyResponse"),
        },
      },
    },
    async (_request, reply): Promise<ReadyResponse> => {
      const ready = await services.readiness.ready().catch(() => false);
      if (!ready) {
        void reply.code(503);
      }
      return { ready };
    },
  );

  app.get(
    GameManageKitPath.Version,
    {
      schema: {
        response: { 200: schemaRef("VersionResponse") },
      },
    },
    async (): Promise<VersionResponse> => ({
      service: "game-manage-kit",
      serviceVersion: config.serviceVersion,
      contractVersion: GAME_MANAGE_KIT_CONTRACT_VERSION,
      schemaVersion: config.schemaVersion,
      gitSha: config.gitSha,
    }),
  );
}
