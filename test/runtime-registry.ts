import type { AreaServer } from "@gono/game-manage-kit-contract";
import {
  type GameConfigurationState,
  type GameContext,
  type GameRuntimeRegistry,
  type GameStatus,
} from "../src/domain/game/resolver.js";
import { GameManageKitError } from "../src/errors.js";
import { TokenBucketLimiter } from "../src/infra/security/security.js";

export const TEST_SERVICE_SECRET = "game-a-service-secret";
export const TEST_ADMIN_SECRET = "game-a-admin-secret";

const SERVER: AreaServer = {
  serverId: 1,
  name: "一区",
  tag: "normal",
  status: "smooth",
  openTime: 1_700_000_000,
  gameHttpUrl: "https://game-a.example.invalid",
  gameWsUrl: "wss://game-a.example.invalid",
};

export interface TestRuntimeGame {
  readonly gameId: string;
  readonly status?: GameStatus;
  readonly configurationState?: GameConfigurationState;
}

function context(game: TestRuntimeGame): GameContext {
  const directory = {
    async listAreas() {
      return { isOps: false, servers: [SERVER], hash: "hash" };
    },
    async findServer(serverId: number) {
      return serverId === SERVER.serverId ? SERVER : undefined;
    },
    async isServerUsable(serverId: number) {
      return serverId === SERVER.serverId;
    },
    async serverAdmission(serverId: number) {
      const server = serverId === SERVER.serverId ? SERVER : undefined;
      return { server, usable: server !== undefined };
    },
  };
  return {
    gameId: game.gameId,
    name: game.gameId === "game-a" ? "示例游戏 A" : "示例游戏 B",
    status: game.status ?? "enabled",
    configurationState: game.configurationState ?? "configured",
    directory,
    wechat: {
      async exchange() {
        return {
          ok: true,
          openid: "openid",
          unionid: null,
          sessionKey: "session-key",
        };
      },
    },
    sessionTtlSeconds: 86_400,
    loginRate: { capacity: 100, refillPerSecond: 100 },
    adminRate: { capacity: 10, refillPerSecond: 1 },
    loginLimiter: new TokenBucketLimiter(100, 100),
    adminLimiter: new TokenBucketLimiter(10, 1),
    revision: { game: 1, integration: 1, directory: 1 },
  };
}

function publicContext(game: GameContext | undefined): GameContext {
  if (!game) {
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  }
  if (game.configurationState !== "configured") {
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  }
  if (game.status === "maintenance") {
    throw new GameManageKitError(503, "GAME_DISABLED");
  }
  if (game.status === "disabled") {
    throw new GameManageKitError(403, "GAME_DISABLED");
  }
  return game;
}

export function createTestRuntimeRegistry(
  definitions: readonly TestRuntimeGame[] = [
    { gameId: "game-a" },
    { gameId: "game-b" },
  ],
): GameRuntimeRegistry {
  const games = new Map(
    definitions.map((definition) => {
      const game = context(definition);
      return [game.gameId, game] as const;
    }),
  );
  return {
    ready: () => true,
    list: () => [...games.values()],
    get: (gameId) => games.get(gameId),
    resolve: async (gameId) => publicContext(games.get(gameId)),
    requireServer: async (game, serverId) => {
      const resolved = publicContext(
        typeof game === "string" ? games.get(game) : game,
      );
      const admission = await resolved.directory.serverAdmission(serverId);
      if (!admission.server) {
        throw new GameManageKitError(404, "SERVER_NOT_FOUND");
      }
      if (!admission.usable) {
        throw new GameManageKitError(403, "SERVER_DISABLED");
      }
      return admission.server;
    },
    authenticateService: async (serviceId, secret) => (
      serviceId === "game-a-service" && secret === TEST_SERVICE_SECRET
        ? { serviceId, gameIds: ["game-a"] }
        : null
    ),
    authenticateAdmin: async (operatorId, secret) => (
      operatorId === "game-a-admin" && secret === TEST_ADMIN_SECRET
        ? { operatorId, gameIds: ["game-a"] }
        : null
    ),
    canAccess: (identity, gameId) => identity.gameIds.includes(gameId),
    invalidate() {},
    loadedRevision: (gameId) => (
      games.get(gameId)?.revision ?? null
    ),
  };
}
