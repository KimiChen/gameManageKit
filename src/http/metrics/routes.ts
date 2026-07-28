import type { FastifyInstance } from "fastify";
import { GameManageKitPath } from "@gono/game-manage-kit-contract";
import type { GameRuntimeRegistry } from "../../domain/game/resolver.js";
import type { MetricsRegistry } from "../../infra/observability/metrics.js";
import {
  authenticateService,
  errorResponseSchemas,
} from "../common.js";

export interface MetricsRouteServices {
  readonly games: GameRuntimeRegistry;
  readonly metrics: MetricsRegistry;
}

export function registerMetricsRoutes(
  app: FastifyInstance,
  services: MetricsRouteServices,
): void {
  app.get(
    GameManageKitPath.Metrics,
    {
      preHandler: async (request) => {
        await authenticateService(request, services.games);
      },
      schema: {
        response: {
          200: { type: "string" },
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<string> => {
      void reply.type("text/plain; version=0.0.4; charset=utf-8");
      return services.metrics.renderPrometheus(request.serviceIdentity!.gameIds);
    },
  );
}
