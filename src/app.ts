import type { FastifyInstance } from "fastify";
import type { GameManageKitConfig } from "./config.js";
import { AdminAccountService } from "./domain/account/admin.js";
import { LoginService } from "./domain/account/login.js";
import { CharacterService } from "./domain/character/service.js";
import {
  DirectoryService,
} from "./domain/directory/service.js";
import { GameRegistry } from "./domain/game/registry.js";
import { SessionService } from "./domain/session/service.js";
import { Database } from "./infra/mysql/database.js";
import { MetricsRegistry } from "./infra/observability/metrics.js";
import {
  createHttpApp,
} from "./http/common.js";
import {
  registerAdminRoutes,
  type AdminRouteServices,
} from "./http/admin/routes.js";
import {
  registerInternalRoutes,
  type InternalRouteServices,
} from "./http/internal/routes.js";
import {
  registerPublicRoutes,
  type PublicRouteServices,
} from "./http/public/routes.js";
import {
  registerSystemRoutes,
  type SystemRouteServices,
} from "./http/system/routes.js";
import {
  registerMetricsRoutes,
  type MetricsRouteServices,
} from "./http/metrics/routes.js";

export interface GameManageKitServices
  extends PublicRouteServices,
  InternalRouteServices,
  AdminRouteServices,
  SystemRouteServices,
  MetricsRouteServices {}

export interface GameManageKitApps {
  readonly publicApp: FastifyInstance;
  readonly internalApp: FastifyInstance;
}

export interface Runtime {
  readonly apps: GameManageKitApps;
  readonly database: Database;
  readonly games: GameRegistry;
  readonly metrics: MetricsRegistry;
}

export function buildApps(
  config: GameManageKitConfig,
  services: GameManageKitServices,
): GameManageKitApps {
  const publicApp = createHttpApp(config);
  registerPublicRoutes(publicApp, config, services);
  registerSystemRoutes(publicApp, config, services);

  const internalApp = createHttpApp(config);
  registerInternalRoutes(internalApp, services);
  registerAdminRoutes(internalApp, services);
  registerMetricsRoutes(internalApp, services);
  registerSystemRoutes(internalApp, config, services);

  return { publicApp, internalApp };
}

export interface RuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly games?: GameRegistry;
}

export async function createRuntime(
  config: GameManageKitConfig,
  options: RuntimeOptions = {},
): Promise<Runtime> {
  const games = options.games ?? await GameRegistry.load(config.gamesConfigPath, {
    production: config.nodeEnv === "production",
    ...(options.env ? { env: options.env } : {}),
  });
  const database = new Database(config.mysqlUrl, config.mysqlPoolSize);
  try {
    await games.sync(database.pool);
    const gameIds = games.list().map((game) => game.gameId);
    const metrics = new MetricsRegistry(gameIds);
    const sessions = new SessionService(database.pool, metrics);
    const characters = new CharacterService(database.pool, metrics);
    const login = new LoginService(
      database,
      sessions,
      metrics,
    );
    const directory = new DirectoryService(sessions, characters);
    const admin = new AdminAccountService(database, metrics);
    const services: GameManageKitServices = {
      games,
      metrics,
      login,
      directory,
      sessions,
      characters,
      admin,
      readiness: {
        ready: async () => (
          games.ready()
          && await database.ready(config.schemaVersion, gameIds)
        ),
      },
    };
    return {
      apps: buildApps(config, services),
      database,
      games,
      metrics,
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
