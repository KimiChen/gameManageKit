import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  type ConfigurationAuditPage,
  type CreateMachineIdentityRequest,
  GameManageKitPath,
  type MachineIdentity,
  type MachineIdentityListResponse,
  type MachineSecretIssuedResponse,
  type MachineSecretOperationStatus,
  type MachineSecretRevokedResponse,
  type RevokeMachineSecretRequest,
  type RotateMachineSecretRequest,
  type UpdateMachineIdentityRequest,
} from "@gono/game-manage-kit-contract";
import type { GameManageKitConfig } from "../../config.js";
import type {
  AdminAuthService,
  AdminSessionIdentity,
} from "../../domain/admin/auth.js";
import type {
  ConfigurationAuditPage as DomainConfigurationAuditPage,
  MachineAuthorization,
  MachineAuthorizationKind,
  MachineIdentity as DomainMachineIdentity,
  MachineIdentityService,
  MachineSecretIssued as DomainMachineSecretIssued,
} from "../../domain/admin/machine-identities.js";
import { GameManageKitError } from "../../errors.js";
import {
  normalizeIp,
  TokenBucketLimiter,
} from "../../infra/security/security.js";
import {
  errorResponseSchemas,
  fastifyPath,
  headerValue,
  schemaRef,
} from "../common.js";
import {
  clearAdminSessionCookies,
  requireAdminSessionCookie,
  requireAllowedAdminOrigin,
} from "./browser-security.js";

export interface AdminMachineIdentityRouteServices {
  readonly adminAuth: Pick<
    AdminAuthService,
    "authenticate" | "requireIntegrationManagement"
    | "requireMachineIdentityManagement" | "requireSecretRotation"
    | "requireElevatedSession"
  >;
  readonly machineIdentities: Pick<
    MachineIdentityService,
    "list" | "create" | "update" | "rotate" | "revoke"
    | "rotationStatus" | "listAudit"
  >;
}

interface IdentityParams {
  readonly identityId: string;
}

interface SecretVersionParams extends IdentityParams {
  readonly version: number;
}

interface RotationStatusParams extends IdentityParams {
  readonly operationId: string;
}

interface AuditQuery {
  readonly gameId?: string;
  readonly limit?: number;
}

interface AuthorizedAdmin {
  readonly identity: AdminSessionIdentity;
  readonly sessionToken: string;
}

const identityParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["identityId"],
  properties: {
    identityId: schemaRef("MachineIdentityId"),
  },
} as const;

const secretVersionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["identityId", "version"],
  properties: {
    identityId: schemaRef("MachineIdentityId"),
    version: {
      type: "integer",
      minimum: 1,
    },
  },
} as const;

const rotationStatusParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["identityId", "operationId"],
  properties: {
    identityId: schemaRef("MachineIdentityId"),
    operationId: schemaRef("OperationId"),
  },
} as const;

const auditQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    gameId: schemaRef("GameId"),
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 50,
    },
  },
} as const;

const noStoreHook = async (
  _request: unknown,
  reply: FastifyReply,
): Promise<void> => {
  void reply.header("cache-control", "no-store");
};

function identityResponse(identity: DomainMachineIdentity): MachineIdentity {
  return {
    ...identity,
    gameIds: [...identity.gameIds],
    secretVersions: identity.secretVersions.map((version) => ({ ...version })),
  };
}

function issuedResponse(
  issued: DomainMachineSecretIssued,
): MachineSecretIssuedResponse {
  return {
    identity: identityResponse(issued.identity),
    version: issued.version,
    previousExpiresAt: issued.previousExpiresAt,
    replayed: issued.replayed,
    ...(issued.secret === undefined ? {} : { secret: issued.secret }),
  };
}

function auditPageResponse(
  page: DomainConfigurationAuditPage,
): ConfigurationAuditPage {
  return {
    records: page.records.map((record) => ({ ...record })),
  };
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  config: GameManageKitConfig,
  services: AdminMachineIdentityRouteServices,
  requireOrigin: boolean,
): Promise<AuthorizedAdmin> {
  try {
    if (requireOrigin) {
      requireAllowedAdminOrigin(
        headerValue(request, "origin"),
        [config.adminOrigin],
      );
    }
    const sessionToken = requireAdminSessionCookie(
      headerValue(request, "cookie"),
      { production: config.nodeEnv === "production" },
    );
    const identity = await services.adminAuth.authenticate(
      sessionToken,
      request.ip,
    );
    request.adminSessionIdentity = identity;
    request.log = request.log.child({ operatorId: identity.operatorId });
    return { identity, sessionToken };
  } catch (error) {
    if (
      error instanceof GameManageKitError
      && error.statusCode === 401
    ) {
      void reply.header("set-cookie", clearAdminSessionCookies());
    }
    throw error;
  }
}

function machineAuthorization(
  request: FastifyRequest,
  auth: AuthorizedAdmin,
  services: AdminMachineIdentityRouteServices,
): MachineAuthorization {
  return {
    operatorId: auth.identity.operatorId,
    ip: request.ip,
    requestId: request.id,
    authorize: async (connection, kind: MachineAuthorizationKind) => {
      await services.adminAuth.requireMachineIdentityManagement(
        connection,
        auth.identity,
      );
      if (kind === "scope") {
        await services.adminAuth.requireElevatedSession(
          connection,
          auth.identity,
          auth.sessionToken,
        );
      } else if (kind === "secret") {
        await services.adminAuth.requireSecretRotation(
          connection,
          auth.identity,
          auth.sessionToken,
        );
      }
    },
  };
}

function auditAuthorization(
  request: FastifyRequest,
  auth: AuthorizedAdmin,
  services: AdminMachineIdentityRouteServices,
): MachineAuthorization {
  return {
    operatorId: auth.identity.operatorId,
    ip: request.ip,
    requestId: request.id,
    authorize: async (connection) => {
      if (auth.identity.canManageMachineIdentities) {
        await services.adminAuth.requireMachineIdentityManagement(
          connection,
          auth.identity,
        );
        return;
      }
      await services.adminAuth.requireIntegrationManagement(
        connection,
        auth.identity,
      );
    },
  };
}

export function registerAdminMachineIdentityRoutes(
  app: FastifyInstance,
  config: GameManageKitConfig,
  services: AdminMachineIdentityRouteServices,
): void {
  const mutationLimiter = new TokenBucketLimiter(20, 1, undefined, 10_000);
  const requireMutationCapacity = (
    request: FastifyRequest,
    identity: AdminSessionIdentity,
  ): void => {
    const ip = normalizeIp(request.ip) ?? "unknown";
    if (!mutationLimiter.allow(`${identity.operatorId}\0${ip}`)) {
      throw new GameManageKitError(429, "RATE_LIMITED");
    }
  };

  app.get(
    fastifyPath(GameManageKitPath.ListAdminMachineIdentities),
    {
      onRequest: noStoreHook,
      schema: {
        response: {
          200: schemaRef("MachineIdentityListResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineIdentityListResponse> => {
      const auth = await authorize(request, reply, config, services, false);
      const result = await services.machineIdentities.list(
        machineAuthorization(request, auth, services),
      );
      return {
        identities: result.identities.map(identityResponse),
      };
    },
  );

  app.post<{ Body: CreateMachineIdentityRequest }>(
    fastifyPath(GameManageKitPath.CreateAdminMachineIdentity),
    {
      onRequest: noStoreHook,
      schema: {
        body: schemaRef("CreateMachineIdentityRequest"),
        response: {
          201: schemaRef("MachineSecretIssuedResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineSecretIssuedResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      const issued = await services.machineIdentities.create(
        request.body,
        machineAuthorization(request, auth, services),
      );
      return reply.code(201).send(issuedResponse(issued));
    },
  );

  app.patch<{
    Params: IdentityParams;
    Body: UpdateMachineIdentityRequest;
  }>(
    fastifyPath(GameManageKitPath.UpdateAdminMachineIdentity),
    {
      onRequest: noStoreHook,
      schema: {
        params: identityParamsSchema,
        body: schemaRef("UpdateMachineIdentityRequest"),
        response: {
          200: schemaRef("MachineIdentity"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineIdentity> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      const identity = await services.machineIdentities.update(
        request.params.identityId,
        request.body,
        machineAuthorization(request, auth, services),
      );
      return identityResponse(identity);
    },
  );

  app.post<{
    Params: IdentityParams;
    Body: RotateMachineSecretRequest;
  }>(
    fastifyPath(GameManageKitPath.RotateAdminMachineSecret),
    {
      onRequest: noStoreHook,
      schema: {
        params: identityParamsSchema,
        body: schemaRef("RotateMachineSecretRequest"),
        response: {
          200: schemaRef("MachineSecretIssuedResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineSecretIssuedResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      const issued = await services.machineIdentities.rotate(
        request.params.identityId,
        request.body,
        machineAuthorization(request, auth, services),
      );
      return issuedResponse(issued);
    },
  );

  app.post<{
    Params: SecretVersionParams;
    Body: RevokeMachineSecretRequest;
  }>(
    fastifyPath(GameManageKitPath.RevokeAdminMachineSecret),
    {
      onRequest: noStoreHook,
      schema: {
        params: secretVersionParamsSchema,
        body: schemaRef("RevokeMachineSecretRequest"),
        response: {
          200: schemaRef("MachineSecretRevokedResponse"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineSecretRevokedResponse> => {
      const auth = await authorize(request, reply, config, services, true);
      requireMutationCapacity(request, auth.identity);
      return services.machineIdentities.revoke(
        request.params.identityId,
        request.params.version,
        request.body,
        machineAuthorization(request, auth, services),
      );
    },
  );

  app.get<{ Params: RotationStatusParams }>(
    fastifyPath(GameManageKitPath.GetAdminMachineSecretRotationStatus),
    {
      onRequest: noStoreHook,
      schema: {
        params: rotationStatusParamsSchema,
        response: {
          200: schemaRef("MachineSecretOperationStatus"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<MachineSecretOperationStatus> => {
      const auth = await authorize(request, reply, config, services, false);
      return services.machineIdentities.rotationStatus(
        request.params.identityId,
        request.params.operationId,
        machineAuthorization(request, auth, services),
      );
    },
  );

  app.get<{ Querystring: AuditQuery }>(
    fastifyPath(GameManageKitPath.ListAdminConfigAudit),
    {
      onRequest: noStoreHook,
      schema: {
        querystring: auditQuerySchema,
        response: {
          200: schemaRef("ConfigurationAuditPage"),
          ...errorResponseSchemas,
        },
      },
    },
    async (request, reply): Promise<ConfigurationAuditPage> => {
      const auth = await authorize(request, reply, config, services, false);
      const page = await services.machineIdentities.listAudit(
        request.query.gameId ?? null,
        request.query.limit ?? 50,
        auditAuthorization(request, auth, services),
      );
      return auditPageResponse(page);
    },
  );
}
