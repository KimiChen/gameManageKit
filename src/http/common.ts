import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { GameManageKitSchemas } from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../config.js";
import type {
  AdminIdentity,
  GameContext,
  GameRegistry,
  ServiceIdentity,
} from "../domain/game/registry.js";
import { GameManageKitError } from "../errors.js";
import { safeErrorDetails } from "../infra/security/security.js";

declare module "fastify" {
  interface FastifyRequest {
    gameContext: GameContext | null;
    serviceIdentity: ServiceIdentity | null;
    adminIdentity: AdminIdentity | null;
  }
}

export interface RegisteredHttpRoute {
  readonly method: string;
  readonly path: string;
}

const registeredRoutes = new WeakMap<FastifyInstance, RegisteredHttpRoute[]>();
interface RequestDrainState {
  readonly active: Set<FastifyRequest>;
  readonly waiters: Set<() => void>;
}
const requestDrainStates = new WeakMap<FastifyInstance, RequestDrainState>();

export interface LogStream {
  write(message: string): void;
}

function finishRequest(state: RequestDrainState, request: FastifyRequest): void {
  if (!state.active.delete(request) || state.active.size > 0) {
    return;
  }
  for (const resolve of state.waiters) {
    resolve();
  }
  state.waiters.clear();
}

export const schemaRef = (name: keyof typeof GameManageKitSchemas): { $ref: string } => ({
  $ref: `${name}#`,
});

export const fastifyPath = (openApiPath: string): string => (
  openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1")
);

export const gameParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gameId"],
  properties: {
    gameId: schemaRef("GameId"),
  },
} as const;

export const errorResponseSchemas = {
  400: schemaRef("ErrorResponse"),
  401: schemaRef("ErrorResponse"),
  403: schemaRef("ErrorResponse"),
  404: schemaRef("ErrorResponse"),
  409: schemaRef("ErrorResponse"),
  429: schemaRef("ErrorResponse"),
  500: schemaRef("ErrorResponse"),
  503: schemaRef("ErrorResponse"),
} as const;

export function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return null;
}

export function authenticateService(
  request: FastifyRequest,
  registry: GameRegistry,
): ServiceIdentity {
  const serviceId = headerValue(request, "x-service-id")?.trim() ?? "";
  const secret = headerValue(request, "x-service-secret");
  const identity = serviceId.length <= 64
    ? registry.authenticateService(serviceId, secret)
    : null;
  if (!identity) {
    throw new GameManageKitError(401, "SERVICE_AUTH_REQUIRED");
  }
  request.serviceIdentity = identity;
  request.log = request.log.child({ serviceId: identity.serviceId });
  return identity;
}

export function authenticateAdmin(
  request: FastifyRequest,
  registry: GameRegistry,
): AdminIdentity {
  const operatorId = headerValue(request, "x-operator-id")?.trim() ?? "";
  const secret = headerValue(request, "x-admin-secret");
  const identity = operatorId.length <= 64
    ? registry.authenticateAdmin(operatorId, secret)
    : null;
  if (!identity) {
    throw new GameManageKitError(401, "SERVICE_AUTH_REQUIRED");
  }
  request.adminIdentity = identity;
  request.log = request.log.child({ operatorId: identity.operatorId });
  return identity;
}

export function resolveGameContext(
  request: FastifyRequest,
  registry: GameRegistry,
): GameContext {
  const gameId = (request.params as { gameId?: unknown }).gameId;
  if (typeof gameId !== "string") {
    throw new GameManageKitError(404, "GAME_NOT_FOUND");
  }
  const knownGame = registry.get(gameId);
  if (knownGame) {
    request.gameContext = knownGame;
    request.log = request.log.child({ gameId: knownGame.gameId });
  }
  return registry.resolve(gameId);
}

export function authorizeServiceGame(
  request: FastifyRequest,
  registry: GameRegistry,
): void {
  const game = resolveGameContext(request, registry);
  const identity = authenticateService(request, registry);
  if (!registry.canAccess(identity, game.gameId)) {
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
}

export function authorizeAdminGame(
  request: FastifyRequest,
  registry: GameRegistry,
): void {
  const game = resolveGameContext(request, registry);
  const identity = authenticateAdmin(request, registry);
  if (!registry.canAccess(identity, game.gameId)) {
    throw new GameManageKitError(403, "GAME_ACCESS_DENIED");
  }
}

export function createHttpApp(
  config: GameManageKitConfig,
  logStream?: LogStream,
): FastifyInstance {
  const logger = config.logEnabled
    ? {
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.x-service-secret",
            "req.headers.x-admin-secret",
            "request.headers.authorization",
            "request.headers.x-service-secret",
            "request.headers.x-admin-secret",
            "req.body.accessToken",
            "request.body.accessToken",
            "accessToken",
            "token",
            "secret",
          ],
          censor: "[REDACTED]",
        },
        ...(logStream ? { stream: logStream } : {}),
      }
    : false;
  const app = Fastify({
    logger,
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.requestTimeoutMs,
    logController: new LogController({ disableRequestLogging: true }),
    // closeWithDeadline tracks in-flight requests, then closes keep-alive
    // sockets after the active set reaches zero.
    forceCloseConnections: false,
    trustProxy: config.trustedProxyCidrs.length > 0 ? [...config.trustedProxyCidrs] : false,
  });
  app.decorateRequest("gameContext", null);
  app.decorateRequest("serviceIdentity", null);
  app.decorateRequest("adminIdentity", null);
  const routes: RegisteredHttpRoute[] = [];
  const drainState: RequestDrainState = {
    active: new Set(),
    waiters: new Set(),
  };
  registeredRoutes.set(app, routes);
  requestDrainStates.set(app, drainState);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method !== "HEAD") {
        routes.push({ method, path: route.url });
      }
    }
  });
  app.addHook("onRequest", async (request) => {
    drainState.active.add(request);
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "[gameManageKit] request completed",
    );
    finishRequest(drainState, request);
  });
  app.addHook("onRequestAbort", async (request) => {
    request.log.warn("[gameManageKit] request aborted");
    finishRequest(drainState, request);
  });

  for (const schema of Object.values(GameManageKitSchemas)) {
    app.addSchema(schema as unknown as Record<string, unknown>);
  }

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({ code: "NOT_FOUND", requestId: request.id });
  });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof GameManageKitError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        requestId: request.id,
      });
    }
    const candidate = error as { statusCode?: unknown; validation?: unknown };
    if (candidate.validation || candidate.statusCode === 400 || candidate.statusCode === 415) {
      return reply.code(400).send({
        code: "INVALID_PAYLOAD",
        requestId: request.id,
      });
    }
    request.log.error(safeErrorDetails(error), "[gameManageKit] 未映射异常");
    return reply.code(500).send({
      code: "INTERNAL",
      requestId: request.id,
    });
  });

  return app;
}

export function listRegisteredRoutes(app: FastifyInstance): readonly RegisteredHttpRoute[] {
  return (registeredRoutes.get(app) ?? []).map((route) => ({ ...route }));
}

export async function waitForRequestsDrained(app: FastifyInstance): Promise<void> {
  const state = requestDrainStates.get(app);
  if (!state || state.active.size === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    state.waiters.add(resolve);
  });
}
