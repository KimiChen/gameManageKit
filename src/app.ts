import type { FastifyInstance } from "fastify";
import type { GameManageKitConfig } from "./config.js";
import { AdminAccountService } from "./domain/account/admin.js";
import { AdminAuthService } from "./domain/admin/auth.js";
import { MachineIdentityService } from "./domain/admin/machine-identities.js";
import { LoginService } from "./domain/account/login.js";
import { CharacterService } from "./domain/character/service.js";
import {
  DirectoryService,
} from "./domain/directory/service.js";
import { GameProjectService } from "./domain/game/projects.js";
import { GameIntegrationService } from "./domain/game/integrations.js";
import {
  GameConfigResolver,
  type GameRuntimeRegistry,
} from "./domain/game/resolver.js";
import { GameServerService } from "./domain/game/servers.js";
import { SessionService } from "./domain/session/service.js";
import { Database } from "./infra/mysql/database.js";
import { MetricsRegistry } from "./infra/observability/metrics.js";
import {
  createHttpApp,
} from "./http/common.js";
import {
  registerAdminAuthRoutes,
  type AdminAuthRouteServices,
} from "./http/admin/auth-routes.js";
import {
  registerAdminRoutes,
  type AdminRouteServices,
} from "./http/admin/routes.js";
import {
  registerAdminGameRoutes,
  type AdminGameRouteServices,
} from "./http/admin/game-routes.js";
import {
  registerAdminIntegrationRoutes,
  type AdminIntegrationRouteServices,
} from "./http/admin/integration-routes.js";
import {
  registerAdminMachineIdentityRoutes,
  type AdminMachineIdentityRouteServices,
} from "./http/admin/machine-identity-routes.js";
import { registerAdminWebRoutes } from "./http/admin/web.js";
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

export type GameManageKitServices =
  & PublicRouteServices
  & InternalRouteServices
  & AdminAuthRouteServices
  & AdminGameRouteServices
  & AdminIntegrationRouteServices
  & AdminMachineIdentityRouteServices
  & AdminRouteServices
  & SystemRouteServices
  & MetricsRouteServices;

export interface GameManageKitApps {
  readonly publicApp: FastifyInstance;
  readonly internalApp: FastifyInstance;
}

export interface Runtime {
  readonly apps: GameManageKitApps;
  readonly adminAuth: AdminAuthService;
  readonly database: Database;
  readonly games: GameRuntimeRegistry;
  readonly configResolver: GameConfigResolver;
  readonly integrations: GameIntegrationService;
  readonly machineIdentities: MachineIdentityService;
  readonly gameProjects: GameProjectService;
  readonly gameServers: GameServerService;
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
  registerAdminAuthRoutes(internalApp, config, services);
  registerAdminGameRoutes(internalApp, config, services);
  registerAdminIntegrationRoutes(internalApp, config, services);
  registerAdminMachineIdentityRoutes(internalApp, config, services);
  registerAdminRoutes(internalApp, config, services);
  registerAdminWebRoutes(internalApp);
  registerMetricsRoutes(internalApp, services);
  registerSystemRoutes(internalApp, config, services);

  return { publicApp, internalApp };
}

export interface RuntimeOptions {
  readonly resolver?: GameConfigResolver;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

export async function createRuntime(
  config: GameManageKitConfig,
  options: RuntimeOptions = {},
): Promise<Runtime> {
  const database = new Database(
    config.mysqlUrl,
    config.mysqlPoolSize,
    config.nodeEnv === "production",
  );
  try {
    if (!await database.ready(config.schemaVersion)) {
      throw new Error(
        "数据库 schema 未就绪；请先运行 migration，旧开发库需按文档重建",
      );
    }
    const metrics = new MetricsRegistry();
    const configResolver = options.resolver
      ?? new GameConfigResolver(database.pool, {
        production: config.nodeEnv === "production",
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.cacheTtlMs
          ? { cacheTtlMs: options.cacheTtlMs }
          : {}),
        onGameLoaded: (gameId) => metrics.registerGame(gameId),
      });
    const games: GameRuntimeRegistry = configResolver;
    await configResolver.initialize();
    for (const game of games.list()) {
      metrics.registerGame(game.gameId);
    }
    const gameProjects = new GameProjectService(database, games);
    const gameServers = new GameServerService(
      database,
      config.nodeEnv === "production",
    );
    const integrations = new GameIntegrationService(
      database,
      configResolver,
      config.nodeEnv === "production",
      metrics,
    );
    const machineIdentities = new MachineIdentityService(database);
    const sessions = new SessionService(database.pool, metrics);
    const characters = new CharacterService(database.pool, metrics);
    const login = new LoginService(
      database,
      sessions,
      metrics,
    );
    const directory = new DirectoryService(sessions, characters);
    const admin = new AdminAccountService(database, metrics);
    const adminAuth = new AdminAuthService(database);
    const services: GameManageKitServices = {
      games,
      gameProjects,
      gameServers,
      integrations,
      machineIdentities,
      metrics,
      login,
      directory,
      sessions,
      characters,
      admin,
      adminAuth,
      readiness: {
        ready: async () => (
          await games.ready()
          && await database.ready(config.schemaVersion)
        ),
      },
    };
    return {
      apps: buildApps(config, services),
      adminAuth,
      database,
      games,
      configResolver,
      integrations,
      machineIdentities,
      gameProjects,
      gameServers,
      metrics,
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
