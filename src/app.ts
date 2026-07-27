import type { FastifyInstance } from "fastify";
import type { GameManageKitConfig } from "./config.js";
import { AdminAccountService } from "./domain/account/admin.js";
import { LoginService } from "./domain/account/login.js";
import { CharacterService } from "./domain/character/service.js";
import {
  DirectoryService,
  FileDirectoryProvider,
} from "./domain/directory/service.js";
import { SessionService } from "./domain/session/service.js";
import { Database } from "./infra/mysql/database.js";
import { TokenBucketLimiter } from "./infra/security/security.js";
import { WechatClient } from "./infra/wechat/client.js";
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

export interface GameManageKitServices
  extends PublicRouteServices,
  InternalRouteServices,
  AdminRouteServices,
  SystemRouteServices {}

export interface GameManageKitApps {
  readonly publicApp: FastifyInstance;
  readonly internalApp: FastifyInstance;
}

export interface Runtime {
  readonly apps: GameManageKitApps;
  readonly database: Database;
}

export function buildApps(
  config: GameManageKitConfig,
  services: GameManageKitServices,
): GameManageKitApps {
  const publicApp = createHttpApp(config);
  registerPublicRoutes(publicApp, config, services);
  registerSystemRoutes(publicApp, config, services);

  const internalApp = createHttpApp(config);
  registerInternalRoutes(internalApp, config, services);
  registerAdminRoutes(internalApp, config, services);
  registerSystemRoutes(internalApp, config, services);

  return { publicApp, internalApp };
}

export async function createRuntime(config: GameManageKitConfig): Promise<Runtime> {
  const database = new Database(config.mysqlUrl, config.mysqlPoolSize);
  try {
    const sessions = new SessionService(database.pool);
    const characters = new CharacterService(database.pool);
    const wechat = new WechatClient({
      appId: config.wxAppId,
      secret: config.wxSecret,
      endpoint: config.wxCode2SessionUrl,
      timeoutMs: config.wxTimeoutMs,
      breakerThreshold: config.wxBreakerThreshold,
      breakerOpenMs: config.wxBreakerOpenMs,
    });
    const login = new LoginService(
      database,
      sessions,
      wechat,
      new TokenBucketLimiter(config.loginRateCapacity, config.loginRateRefillPerSecond),
    );
    const provider = await FileDirectoryProvider.load(
      config.areaConfigPath,
      config.nodeEnv === "production",
    );
    const directory = new DirectoryService(provider, sessions, characters);
    const admin = new AdminAccountService(database);
    const services: GameManageKitServices = {
      login,
      directory,
      sessions,
      characters,
      admin,
      adminLimiter: new TokenBucketLimiter(
        config.adminRateCapacity,
        config.adminRateRefillPerSecond,
      ),
      readiness: {
        ready: () => database.ready(config.schemaVersion),
      },
    };
    return { apps: buildApps(config, services), database };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
