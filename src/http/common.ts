import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { GameManageKitSchemas } from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../config.js";
import { GameManageKitError } from "../errors.js";
import { matchesAnySecret } from "../infra/security/security.js";

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

export function authenticateService(request: FastifyRequest, config: GameManageKitConfig): string {
  const serviceId = headerValue(request, "x-service-id")?.trim() ?? "";
  const secret = headerValue(request, "x-service-secret");
  if (
    !serviceId
    || serviceId.length > 64
    || !matchesAnySecret(secret, config.serviceSecrets)
  ) {
    throw new GameManageKitError(401, "SERVICE_AUTH_REQUIRED");
  }
  return serviceId;
}

export function authenticateAdmin(request: FastifyRequest, config: GameManageKitConfig): string {
  const operatorId = headerValue(request, "x-operator-id")?.trim() ?? "";
  const secret = headerValue(request, "x-admin-secret");
  if (
    !operatorId
    || operatorId.length > 64
    || !matchesAnySecret(secret, config.adminSecrets)
  ) {
    throw new GameManageKitError(401, "SERVICE_AUTH_REQUIRED");
  }
  return operatorId;
}

export function createHttpApp(config: GameManageKitConfig): FastifyInstance {
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
          ],
          censor: "[REDACTED]",
        },
      }
    : false;
  const app = Fastify({
    logger,
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.requestTimeoutMs,
    // closeWithDeadline tracks in-flight requests, then closes keep-alive
    // sockets after the active set reaches zero.
    forceCloseConnections: false,
    trustProxy: config.trustedProxyCidrs.length > 0 ? [...config.trustedProxyCidrs] : false,
  });
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
  app.addHook("onResponse", async (request) => {
    finishRequest(drainState, request);
  });
  app.addHook("onRequestAbort", async (request) => {
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
    request.log.error({ err: error }, "[gameManageKit] 未映射异常");
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
