import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { GameManageKitError } from "../../errors.js";
import { normalizeIp } from "../../infra/security/security.js";

export type MachineIdentityType = "service" | "machine_admin";
export type MachineIdentityStatus = "enabled" | "disabled";
export type MachineSecretState = "current" | "previous" | "revoked";
export type MachineAuthorizationKind =
  | "read"
  | "write"
  | "scope"
  | "secret";

export interface MachineAuthorization {
  readonly operatorId: string;
  readonly ip: string | null;
  readonly requestId: string;
  authorize(
    connection: PoolConnection,
    kind: MachineAuthorizationKind,
  ): Promise<void>;
}

export interface MachineIdentityDatabase {
  readonly pool: Pool;
  transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
  ): Promise<T>;
}

export interface MachineSecretVersion {
  readonly version: number;
  readonly state: MachineSecretState;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly activatedAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface MachineIdentity {
  readonly identityId: string;
  readonly identityType: MachineIdentityType;
  readonly displayName: string;
  readonly status: MachineIdentityStatus;
  readonly gameIds: readonly string[];
  readonly revision: number;
  readonly secretVersions: readonly MachineSecretVersion[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MachineIdentityList {
  readonly identities: readonly MachineIdentity[];
}

export interface CreateMachineIdentityInput {
  readonly identityId: string;
  readonly identityType: MachineIdentityType;
  readonly displayName: string;
  readonly gameIds: readonly string[];
  readonly operationId: string;
}

export interface UpdateMachineIdentityInput {
  readonly displayName: string;
  readonly status: MachineIdentityStatus;
  readonly gameIds: readonly string[];
  readonly revision: number;
}

export interface RotateMachineSecretInput {
  readonly operationId: string;
  readonly revision: number;
  readonly previousValiditySeconds: number;
}

export interface RevokeMachineSecretInput {
  readonly operationId: string;
  readonly revision: number;
  readonly reason: string;
}

export interface MachineSecretIssued {
  readonly identity: MachineIdentity;
  readonly version: number;
  readonly previousExpiresAt: string | null;
  readonly replayed: boolean;
  readonly secret?: string;
}

export interface MachineSecretRevoked {
  readonly identityId: string;
  readonly version: number;
  readonly state: "revoked";
  readonly identityRevision: number;
  readonly replayed: boolean;
}

export interface MachineSecretOperationStatus {
  readonly operationId: string;
  readonly identityId: string;
  readonly action: "set" | "rotate" | "revoke";
  readonly status: "succeeded";
  readonly version: number | null;
  readonly deliveryLost: boolean;
  readonly createdAt: string;
}

export interface ConfigurationAuditRecord {
  readonly id: string;
  readonly auditType:
    | "game_configuration"
    | "machine_identity"
    | "secret";
  readonly operatorId: string;
  readonly gameId: string | null;
  readonly identityId: string | null;
  readonly action: string;
  readonly result: string;
  readonly oldVersion: number | null;
  readonly newVersion: number | null;
  readonly createdAt: string;
}

export interface ConfigurationAuditPage {
  readonly records: readonly ConfigurationAuditRecord[];
}

interface IdentityRow extends RowDataPacket {
  readonly identity_id: string;
  readonly identity_type: string;
  readonly display_name: string;
  readonly status: string;
  readonly revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface IdentityGameRow extends RowDataPacket {
  readonly identity_id: string;
  readonly game_id: string;
}

interface SecretVersionRow extends RowDataPacket {
  readonly identity_id: string;
  readonly version: number | string;
  readonly state: string;
  readonly expires_at: Date | string | null;
  readonly created_at: Date | string;
  readonly activated_at: Date | string;
  readonly last_used_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

interface SecretOperationRow extends RowDataPacket {
  readonly operation_id: string;
  readonly operator_id: string;
  readonly game_id: string | null;
  readonly identity_id: string | null;
  readonly secret_kind: string;
  readonly action: string;
  readonly old_version: number | string | null;
  readonly new_version: number | string | null;
  readonly created_at: Date | string;
}

interface AuditRow extends RowDataPacket {
  readonly id: number | string;
  readonly audit_type: string;
  readonly operator_id: string;
  readonly game_id: string | null;
  readonly identity_id: string | null;
  readonly action: string;
  readonly result: string;
  readonly old_version: number | string | null;
  readonly new_version: number | string | null;
  readonly created_at: Date | string;
}

const IDENTITY_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const IDENTITY_TYPES = new Set<MachineIdentityType>([
  "service",
  "machine_admin",
]);
const IDENTITY_STATUSES = new Set<MachineIdentityStatus>([
  "enabled",
  "disabled",
]);
const SECRET_STATES = new Set<MachineSecretState>([
  "current",
  "previous",
  "revoked",
]);
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;
const MAXIMUM_PREVIOUS_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

function invalidPayload(): never {
  throw new GameManageKitError(400, "INVALID_PAYLOAD");
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Number((error as { errno?: unknown }).errno) === 1062;
}

function isConflict(error: unknown): boolean {
  return error instanceof GameManageKitError && error.statusCode === 409;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("机器身份时间数据无效");
  }
  return date.toISOString();
}

function optionalIsoDate(value: Date | string | null): string | null {
  return value === null ? null : isoDate(value);
}

function positiveRevision(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    return invalidPayload();
  }
  return number;
}

function normalizedDisplayName(value: string): string {
  if (typeof value !== "string") {
    return invalidPayload();
  }
  const normalized = value.trim();
  if (normalized.length < 1 || [...normalized].length > 128) {
    return invalidPayload();
  }
  return normalized;
}

function normalizedGameIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) {
    return invalidPayload();
  }
  const normalized = value.map((gameId) => {
    if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) {
      return invalidPayload();
    }
    return gameId;
  });
  if (new Set(normalized).size !== normalized.length) {
    return invalidPayload();
  }
  return Object.freeze([...normalized].sort());
}

function normalizedOperationId(value: string): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    return invalidPayload();
  }
  return value;
}

function normalizedReason(value: string): string {
  if (typeof value !== "string") {
    return invalidPayload();
  }
  const reason = value.trim();
  if (reason.length < 1 || [...reason].length > 255) {
    return invalidPayload();
  }
  return reason;
}

function identityTypeFromRow(row: IdentityRow): MachineIdentityType {
  const value = String(row.identity_type);
  if (!IDENTITY_TYPES.has(value as MachineIdentityType)) {
    throw new Error("机器身份类型数据无效");
  }
  return value as MachineIdentityType;
}

function secretKind(identityType: MachineIdentityType):
  "service_secret" | "machine_admin_secret" {
  return identityType === "service"
    ? "service_secret"
    : "machine_admin_secret";
}

function secretVersionFromRow(row: SecretVersionRow): MachineSecretVersion {
  const state = String(row.state);
  const version = Number(row.version);
  if (
    !SECRET_STATES.has(state as MachineSecretState)
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    throw new Error("机器 Secret 版本数据无效");
  }
  return Object.freeze({
    version,
    state: state as MachineSecretState,
    expiresAt: optionalIsoDate(row.expires_at),
    createdAt: isoDate(row.created_at),
    activatedAt: isoDate(row.activated_at),
    lastUsedAt: optionalIsoDate(row.last_used_at),
    revokedAt: optionalIsoDate(row.revoked_at),
  });
}

function identityFromRows(
  row: IdentityRow,
  games: readonly IdentityGameRow[],
  versions: readonly SecretVersionRow[],
): MachineIdentity {
  const status = String(row.status);
  const revision = Number(row.revision);
  if (
    !IDENTITY_STATUSES.has(status as MachineIdentityStatus)
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw new Error("机器身份数据无效");
  }
  return Object.freeze({
    identityId: String(row.identity_id),
    identityType: identityTypeFromRow(row),
    displayName: String(row.display_name),
    status: status as MachineIdentityStatus,
    gameIds: Object.freeze(
      games
        .filter((game) => game.identity_id === row.identity_id)
        .map((game) => String(game.game_id))
        .sort(),
    ),
    revision,
    secretVersions: Object.freeze(
      versions
        .filter((version) => version.identity_id === row.identity_id)
        .map(secretVersionFromRow)
        .sort((left, right) => right.version - left.version),
    ),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  });
}

function operationVersion(row: SecretOperationRow): number | null {
  const raw = row.action === "revoke"
    ? row.old_version
    : row.new_version;
  if (raw === null) {
    return null;
  }
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("机器 Secret 操作版本数据无效");
  }
  return version;
}

export class MachineIdentityService {
  constructor(
    private readonly database: MachineIdentityDatabase,
    private readonly randomBytes: (size: number) => Buffer =
      cryptoRandomBytes,
  ) {}

  async list(
    authorization: MachineAuthorization,
  ): Promise<MachineIdentityList> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "read");
      const [identities] = await connection.query<IdentityRow[]>(
        `SELECT identity_id, identity_type, display_name, status, revision,
                created_at, updated_at
           FROM machine_identities
          ORDER BY identity_id`,
      );
      const [games] = await connection.query<IdentityGameRow[]>(
        `SELECT identity_id, game_id
           FROM machine_identity_games
          ORDER BY identity_id, game_id`,
      );
      const [versions] = await connection.query<SecretVersionRow[]>(
        `SELECT identity_id, version, state, expires_at, created_at,
                activated_at, last_used_at, revoked_at
           FROM machine_secret_versions
          ORDER BY identity_id, version DESC`,
      );
      return Object.freeze({
        identities: Object.freeze(
          identities.map((identity) => identityFromRows(
            identity,
            games,
            versions,
          )),
        ),
      });
    });
  }

  async create(
    input: CreateMachineIdentityInput,
    authorization: MachineAuthorization,
  ): Promise<MachineSecretIssued> {
    const normalized = this.normalizeCreate(input);
    let replay: MachineSecretIssued | null;
    try {
      replay = await this.findIssuedReplay(
        normalized.identityId,
        normalized.operationId,
        "set",
        authorization,
      );
    } catch (error) {
      await this.auditSecretFailure(
        normalized.identityId,
        "set",
        null,
        authorization,
        error,
      );
      throw error;
    }
    if (replay) {
      return replay;
    }
    const secret = this.generateSecret();
    const digest = createHash("sha256").update(secret, "utf8").digest();
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "secret");
        await this.requireGames(connection, normalized.gameIds);
        await connection.execute(
          `INSERT INTO machine_identities
             (identity_id, identity_type, display_name, status, revision)
           VALUES (?, ?, ?, 'enabled', 1)`,
          [
            normalized.identityId,
            normalized.identityType,
            normalized.displayName,
          ],
        );
        await this.replaceGameScope(
          connection,
          normalized.identityId,
          normalized.gameIds,
        );
        await connection.execute(
          `INSERT INTO machine_secret_versions
             (identity_id, version, secret_digest, state, expires_at,
              created_by, activated_at)
           VALUES (?, 1, ?, 'current', NULL, ?, NOW(3))`,
          [normalized.identityId, digest, authorization.operatorId],
        );
        await this.insertOperation(
          connection,
          normalized.operationId,
          authorization.operatorId,
          normalized.identityId,
          secretKind(normalized.identityType),
          "set",
          null,
          1,
        );
        await this.insertSecretAudit(
          connection,
          authorization,
          normalized.identityId,
          secretKind(normalized.identityType),
          "set",
          null,
          1,
          null,
        );
        const identity = await this.requireIdentity(
          connection,
          normalized.identityId,
          false,
        );
        await this.insertIdentityAudit(
          connection,
          authorization,
          "create",
          null,
          identity,
        );
        return Object.freeze({
          identity,
          version: 1,
          secret,
          previousExpiresAt: null,
          replayed: false,
        });
      });
    } catch (error) {
      let finalError = error;
      if (isDuplicate(error) || isConflict(error)) {
        try {
          const replayed = await this.findIssuedReplay(
            normalized.identityId,
            normalized.operationId,
            "set",
            authorization,
          );
          if (replayed) {
            return replayed;
          }
        } catch (replayError) {
          finalError = replayError;
        }
        if (isDuplicate(finalError)) {
          finalError = new GameManageKitError(
            409,
            "OPERATION_CONFLICT",
          );
        }
      }
      await this.auditSecretFailure(
        normalized.identityId,
        "set",
        null,
        authorization,
        finalError,
      );
      throw finalError;
    }
  }

  async update(
    identityId: string,
    input: UpdateMachineIdentityInput,
    authorization: MachineAuthorization,
  ): Promise<MachineIdentity> {
    this.validateIdentityId(identityId);
    const normalized = this.normalizeUpdate(input);
    const scopeRequiresElevation = await this.scopeWouldChange(
      identityId,
      normalized.gameIds,
    );
    return this.database.transaction(async (connection) => {
      await authorization.authorize(
        connection,
        scopeRequiresElevation ? "scope" : "write",
      );
      const current = await this.requireIdentity(
        connection,
        identityId,
        true,
      );
      if (current.revision !== normalized.revision) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      const scopeChanged = current.gameIds.length !== normalized.gameIds.length
        || current.gameIds.some(
          (gameId, index) => normalized.gameIds[index] !== gameId,
        );
      if (scopeChanged !== scopeRequiresElevation) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      await this.requireGames(connection, normalized.gameIds);
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE machine_identities
            SET display_name = ?,
                status = ?,
                revision = revision + 1
          WHERE identity_id = ? AND revision = ?`,
        [
          normalized.displayName,
          normalized.status,
          identityId,
          normalized.revision,
        ],
      );
      if (updated.affectedRows !== 1) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      if (scopeChanged) {
        await this.replaceGameScope(
          connection,
          identityId,
          normalized.gameIds,
        );
      }
      const identity = await this.requireIdentity(
        connection,
        identityId,
        false,
      );
      await this.insertIdentityAudit(
        connection,
        authorization,
        "update",
        current,
        identity,
      );
      return identity;
    });
  }

  async rotate(
    identityId: string,
    input: RotateMachineSecretInput,
    authorization: MachineAuthorization,
  ): Promise<MachineSecretIssued> {
    this.validateIdentityId(identityId);
    const normalized = this.normalizeRotate(input);
    let replay: MachineSecretIssued | null;
    try {
      replay = await this.findIssuedReplay(
        identityId,
        normalized.operationId,
        "rotate",
        authorization,
      );
    } catch (error) {
      await this.auditSecretFailure(
        identityId,
        "rotate",
        null,
        authorization,
        error,
      );
      throw error;
    }
    if (replay) {
      return replay;
    }
    const secret = this.generateSecret();
    const digest = createHash("sha256").update(secret, "utf8").digest();
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "secret");
        const currentIdentity = await this.requireIdentity(
          connection,
          identityId,
          true,
        );
        if (currentIdentity.revision !== normalized.revision) {
          throw new GameManageKitError(409, "OPERATION_CONFLICT");
        }
        const currentVersion = currentIdentity.secretVersions.find(
          (version) => version.state === "current",
        );
        if (!currentVersion) {
          throw new GameManageKitError(409, "OPERATION_CONFLICT");
        }
        await connection.execute(
          `UPDATE machine_secret_versions
              SET state = 'revoked',
                  revoked_at = NOW(3)
            WHERE identity_id = ? AND state = 'previous'`,
          [identityId],
        );
        await connection.execute(
          `UPDATE machine_secret_versions
              SET state = 'previous',
                  expires_at = TIMESTAMPADD(SECOND, ?, NOW(3))
            WHERE identity_id = ? AND version = ? AND state = 'current'`,
          [
            normalized.previousValiditySeconds,
            identityId,
            currentVersion.version,
          ],
        );
        const newVersion = Math.max(
          0,
          ...currentIdentity.secretVersions.map((version) => version.version),
        ) + 1;
        await connection.execute(
          `INSERT INTO machine_secret_versions
             (identity_id, version, secret_digest, state, expires_at,
              created_by, activated_at)
           VALUES (?, ?, ?, 'current', NULL, ?, NOW(3))`,
          [
            identityId,
            newVersion,
            digest,
            authorization.operatorId,
          ],
        );
        await this.bumpIdentityRevision(
          connection,
          identityId,
          normalized.revision,
        );
        const kind = secretKind(currentIdentity.identityType);
        await this.insertOperation(
          connection,
          normalized.operationId,
          authorization.operatorId,
          identityId,
          kind,
          "rotate",
          currentVersion.version,
          newVersion,
        );
        await this.insertSecretAudit(
          connection,
          authorization,
          identityId,
          kind,
          "rotate",
          currentVersion.version,
          newVersion,
          null,
        );
        const identity = await this.requireIdentity(
          connection,
          identityId,
          false,
        );
        const previous = identity.secretVersions.find(
          (version) => version.version === currentVersion.version,
        );
        return Object.freeze({
          identity,
          version: newVersion,
          secret,
          previousExpiresAt: previous?.expiresAt ?? null,
          replayed: false,
        });
      });
    } catch (error) {
      let finalError = error;
      if (isDuplicate(error) || isConflict(error)) {
        try {
          const replayed = await this.findIssuedReplay(
            identityId,
            normalized.operationId,
            "rotate",
            authorization,
          );
          if (replayed) {
            return replayed;
          }
        } catch (replayError) {
          finalError = replayError;
        }
      }
      if (isDuplicate(finalError)) {
        finalError = new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      await this.auditSecretFailure(
        identityId,
        "rotate",
        null,
        authorization,
        finalError,
      );
      throw finalError;
    }
  }

  async revoke(
    identityId: string,
    version: number,
    input: RevokeMachineSecretInput,
    authorization: MachineAuthorization,
  ): Promise<MachineSecretRevoked> {
    this.validateIdentityId(identityId);
    const normalizedVersion = positiveRevision(version);
    const normalized = this.normalizeRevoke(input);
    let replay: MachineSecretRevoked | null;
    try {
      replay = await this.findRevokedReplay(
        identityId,
        normalizedVersion,
        normalized.operationId,
        authorization,
      );
    } catch (error) {
      await this.auditSecretFailure(
        identityId,
        "revoke",
        normalizedVersion,
        authorization,
        error,
      );
      throw error;
    }
    if (replay) {
      return replay;
    }
    try {
      return await this.database.transaction(async (connection) => {
        await authorization.authorize(connection, "secret");
        const identity = await this.requireIdentity(
          connection,
          identityId,
          true,
        );
        if (identity.revision !== normalized.revision) {
          throw new GameManageKitError(409, "OPERATION_CONFLICT");
        }
        const target = identity.secretVersions.find(
          (candidate) => candidate.version === normalizedVersion,
        );
        if (!target) {
          throw new GameManageKitError(404, "NOT_FOUND");
        }
        if (target.state === "revoked") {
          throw new GameManageKitError(409, "OPERATION_CONFLICT");
        }
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE machine_secret_versions
              SET state = 'revoked',
                  revoked_at = NOW(3)
            WHERE identity_id = ? AND version = ? AND state <> 'revoked'`,
          [identityId, normalizedVersion],
        );
        if (updated.affectedRows !== 1) {
          throw new GameManageKitError(409, "OPERATION_CONFLICT");
        }
        const identityRevision = await this.bumpIdentityRevision(
          connection,
          identityId,
          normalized.revision,
        );
        const kind = secretKind(identity.identityType);
        await this.insertOperation(
          connection,
          normalized.operationId,
          authorization.operatorId,
          identityId,
          kind,
          "revoke",
          normalizedVersion,
          null,
        );
        await this.insertSecretAudit(
          connection,
          authorization,
          identityId,
          kind,
          "revoke",
          normalizedVersion,
          null,
          normalized.reason,
        );
        return Object.freeze({
          identityId,
          version: normalizedVersion,
          state: "revoked",
          identityRevision,
          replayed: false,
        });
      });
    } catch (error) {
      let finalError = error;
      if (isDuplicate(error) || isConflict(error)) {
        try {
          const replayed = await this.findRevokedReplay(
            identityId,
            normalizedVersion,
            normalized.operationId,
            authorization,
          );
          if (replayed) {
            return replayed;
          }
        } catch (replayError) {
          finalError = replayError;
        }
      }
      if (isDuplicate(finalError)) {
        finalError = new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      await this.auditSecretFailure(
        identityId,
        "revoke",
        normalizedVersion,
        authorization,
        finalError,
      );
      throw finalError;
    }
  }

  async rotationStatus(
    identityId: string,
    operationId: string,
    authorization: MachineAuthorization,
  ): Promise<MachineSecretOperationStatus> {
    this.validateIdentityId(identityId);
    const normalizedOperation = normalizedOperationId(operationId);
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "read");
      const operation = await this.requireOperation(
        connection,
        normalizedOperation,
      );
      this.assertMachineOperation(operation, identityId);
      return this.operationStatus(operation);
    });
  }

  async listAudit(
    gameId: string | null,
    limit: number,
    authorization: MachineAuthorization,
  ): Promise<ConfigurationAuditPage> {
    if (
      gameId !== null
      && (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId))
    ) {
      invalidPayload();
    }
    const normalizedLimit = Number(limit);
    if (
      !Number.isSafeInteger(normalizedLimit)
      || normalizedLimit < 1
      || normalizedLimit > 100
    ) {
      invalidPayload();
    }
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "read");
      const [rows] = await connection.query<AuditRow[]>(
        `SELECT *
           FROM (
             SELECT CONCAT('s:', id) AS id, 'secret' AS audit_type,
                    operator_id, game_id, identity_id, action, result,
                    old_version, new_version, created_at
               FROM admin_secret_audit
              WHERE (
                ? IS NULL
                OR game_id = ?
                OR EXISTS (
                  SELECT 1
                    FROM machine_identity_games AS secret_scope
                   WHERE secret_scope.identity_id =
                         admin_secret_audit.identity_id
                     AND secret_scope.game_id = ?
                )
              )
             UNION ALL
             SELECT CONCAT('m:', id) AS id,
                    'machine_identity' AS audit_type,
                    operator_id, NULL AS game_id, identity_id, action,
                    'succeeded' AS result, NULL AS old_version,
                    NULL AS new_version, created_at
               FROM admin_machine_identity_audit
              WHERE (
                ? IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM machine_identity_games AS identity_scope
                   WHERE identity_scope.identity_id =
                         admin_machine_identity_audit.identity_id
                     AND identity_scope.game_id = ?
                )
              )
             UNION ALL
             SELECT CONCAT('g:', id) AS id,
                    'game_configuration' AS audit_type,
                    operator_id, game_id, NULL AS identity_id, action,
                    'succeeded' AS result, NULL AS old_version,
                    NULL AS new_version, created_at
               FROM admin_game_audit
              WHERE (? IS NULL OR game_id = ?)
           ) AS audit
          ORDER BY created_at DESC
          LIMIT ?`,
        [
          gameId,
          gameId,
          gameId,
          gameId,
          gameId,
          gameId,
          gameId,
          normalizedLimit,
        ],
      );
      return Object.freeze({
        records: Object.freeze(rows.map((row) => ({
          id: String(row.id),
          auditType: row.audit_type as ConfigurationAuditRecord["auditType"],
          operatorId: String(row.operator_id),
          gameId: row.game_id === null ? null : String(row.game_id),
          identityId: row.identity_id === null
            ? null
            : String(row.identity_id),
          action: String(row.action),
          result: String(row.result),
          oldVersion: row.old_version === null
            ? null
            : Number(row.old_version),
          newVersion: row.new_version === null
            ? null
            : Number(row.new_version),
          createdAt: isoDate(row.created_at),
        }))),
      });
    });
  }

  private normalizeCreate(
    input: CreateMachineIdentityInput,
  ): CreateMachineIdentityInput {
    if (
      !input
      || typeof input !== "object"
      || !IDENTITY_ID_PATTERN.test(input.identityId)
      || !IDENTITY_TYPES.has(input.identityType)
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      identityId: input.identityId,
      identityType: input.identityType,
      displayName: normalizedDisplayName(input.displayName),
      gameIds: normalizedGameIds(input.gameIds),
      operationId: normalizedOperationId(input.operationId),
    });
  }

  private normalizeUpdate(
    input: UpdateMachineIdentityInput,
  ): UpdateMachineIdentityInput {
    if (
      !input
      || typeof input !== "object"
      || !IDENTITY_STATUSES.has(input.status)
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      displayName: normalizedDisplayName(input.displayName),
      status: input.status,
      gameIds: normalizedGameIds(input.gameIds),
      revision: positiveRevision(input.revision),
    });
  }

  private normalizeRotate(
    input: RotateMachineSecretInput,
  ): RotateMachineSecretInput {
    if (!input || typeof input !== "object") {
      return invalidPayload();
    }
    const previousValiditySeconds = Number(input.previousValiditySeconds);
    if (
      !Number.isSafeInteger(previousValiditySeconds)
      || previousValiditySeconds < 60
      || previousValiditySeconds > MAXIMUM_PREVIOUS_VALIDITY_SECONDS
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      operationId: normalizedOperationId(input.operationId),
      revision: positiveRevision(input.revision),
      previousValiditySeconds,
    });
  }

  private normalizeRevoke(
    input: RevokeMachineSecretInput,
  ): RevokeMachineSecretInput {
    if (!input || typeof input !== "object") {
      return invalidPayload();
    }
    return Object.freeze({
      operationId: normalizedOperationId(input.operationId),
      revision: positiveRevision(input.revision),
      reason: normalizedReason(input.reason),
    });
  }

  private validateIdentityId(identityId: string): void {
    if (
      typeof identityId !== "string"
      || !IDENTITY_ID_PATTERN.test(identityId)
    ) {
      invalidPayload();
    }
  }

  private generateSecret(): string {
    const entropy = this.randomBytes(SECRET_BYTES);
    if (!Buffer.isBuffer(entropy) || entropy.length !== SECRET_BYTES) {
      throw new TypeError("机器 Secret 随机源必须返回 32 字节 Buffer");
    }
    const secret = entropy.toString("base64url");
    if (
      secret.length !== SECRET_LENGTH
      || !/^[A-Za-z0-9_-]+$/u.test(secret)
    ) {
      throw new Error("机器 Secret 生成失败");
    }
    return secret;
  }

  private async requireGames(
    connection: PoolConnection,
    gameIds: readonly string[],
  ): Promise<void> {
    if (gameIds.length === 0) {
      return;
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT game_id
         FROM games
        WHERE game_id IN (?)
        FOR SHARE`,
      [[...gameIds]],
    );
    if (new Set(rows.map((row) => String(row.game_id))).size !== gameIds.length) {
      throw new GameManageKitError(404, "GAME_NOT_FOUND");
    }
  }

  private async replaceGameScope(
    connection: PoolConnection,
    identityId: string,
    gameIds: readonly string[],
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM machine_identity_games WHERE identity_id = ?",
      [identityId],
    );
    for (const gameId of gameIds) {
      await connection.execute(
        `INSERT INTO machine_identity_games (identity_id, game_id)
         VALUES (?, ?)`,
        [identityId, gameId],
      );
    }
  }

  private async scopeWouldChange(
    identityId: string,
    gameIds: readonly string[],
  ): Promise<boolean> {
    const [rows] = await this.database.pool.query<IdentityGameRow[]>(
      `SELECT identity_id, game_id
         FROM machine_identity_games
        WHERE identity_id = ?
        ORDER BY game_id`,
      [identityId],
    );
    const current = rows.map((row) => String(row.game_id));
    return current.length !== gameIds.length
      || current.some((gameId, index) => gameIds[index] !== gameId);
  }

  private async requireIdentity(
    connection: PoolConnection,
    identityId: string,
    lock: boolean,
  ): Promise<MachineIdentity> {
    const [rows] = await connection.query<IdentityRow[]>(
      `SELECT identity_id, identity_type, display_name, status, revision,
              created_at, updated_at
         FROM machine_identities
        WHERE identity_id = ?${lock ? " FOR UPDATE" : ""}`,
      [identityId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "NOT_FOUND");
    }
    const [games] = await connection.query<IdentityGameRow[]>(
      `SELECT identity_id, game_id
         FROM machine_identity_games
        WHERE identity_id = ?
        ORDER BY game_id${lock ? " FOR SHARE" : ""}`,
      [identityId],
    );
    const [versions] = await connection.query<SecretVersionRow[]>(
      `SELECT identity_id, version, state, expires_at, created_at,
              activated_at, last_used_at, revoked_at
         FROM machine_secret_versions
        WHERE identity_id = ?
        ORDER BY version DESC${lock ? " FOR UPDATE" : ""}`,
      [identityId],
    );
    return identityFromRows(row, games, versions);
  }

  private async bumpIdentityRevision(
    connection: PoolConnection,
    identityId: string,
    revision: number,
  ): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE machine_identities
          SET revision = revision + 1
        WHERE identity_id = ? AND revision = ?`,
      [identityId, revision],
    );
    if (result.affectedRows !== 1) {
      throw new GameManageKitError(409, "OPERATION_CONFLICT");
    }
    return revision + 1;
  }

  private async insertOperation(
    connection: PoolConnection,
    operationId: string,
    operatorId: string,
    identityId: string,
    kind: "service_secret" | "machine_admin_secret",
    action: "set" | "rotate" | "revoke",
    oldVersion: number | null,
    newVersion: number | null,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO admin_secret_operations
         (operation_id, operator_id, game_id, identity_id, secret_kind,
          action, old_version, new_version)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        operationId,
        operatorId,
        identityId,
        kind,
        action,
        oldVersion,
        newVersion,
      ],
    );
  }

  private async insertSecretAudit(
    connection: PoolConnection,
    authorization: MachineAuthorization,
    identityId: string,
    kind: "service_secret" | "machine_admin_secret",
    action: "set" | "rotate" | "revoke",
    oldVersion: number | null,
    newVersion: number | null,
    reason: string | null,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO admin_secret_audit
         (operator_id, game_id, identity_id, secret_kind, action,
          old_version, new_version, result, reason, request_id, ip)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'succeeded', ?, ?,
               INET6_ATON(?))`,
      [
        authorization.operatorId,
        identityId,
        kind,
        action,
        oldVersion,
        newVersion,
        reason,
        authorization.requestId,
        normalizeIp(authorization.ip),
      ],
    );
  }

  private async auditSecretFailure(
    identityId: string,
    action: "set" | "rotate" | "revoke",
    oldVersion: number | null,
    authorization: MachineAuthorization,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof GameManageKitError
      ? error.code
      : "INTERNAL";
    await this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT identity_type
           FROM machine_identities
          WHERE identity_id = ?
          FOR SHARE`,
        [identityId],
      );
      const identityType = String(rows[0]?.identity_type ?? "");
      if (!IDENTITY_TYPES.has(identityType as MachineIdentityType)) {
        return;
      }
      await connection.execute(
        `INSERT INTO admin_secret_audit
           (operator_id, game_id, identity_id, secret_kind, action,
            old_version, new_version, result, reason, request_id, ip)
         VALUES (?, NULL, ?, ?, ?, ?, NULL, 'failed', ?, ?,
                 INET6_ATON(?))`,
        [
          authorization.operatorId,
          identityId,
          secretKind(identityType as MachineIdentityType),
          action,
          oldVersion,
          reason,
          authorization.requestId,
          normalizeIp(authorization.ip),
        ],
      );
    }).catch(() => undefined);
  }

  private async insertIdentityAudit(
    connection: PoolConnection,
    authorization: MachineAuthorization,
    action: "create" | "update",
    before: MachineIdentity | null,
    after: MachineIdentity,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO admin_machine_identity_audit
         (operator_id, identity_id, action, before_data, after_data, ip)
       VALUES (?, ?, ?, ?, ?, INET6_ATON(?))`,
      [
        authorization.operatorId,
        after.identityId,
        action,
        before === null ? null : JSON.stringify(before),
        JSON.stringify(after),
        normalizeIp(authorization.ip),
      ],
    );
  }

  private async requireOperation(
    connection: PoolConnection,
    operationId: string,
  ): Promise<SecretOperationRow> {
    const [rows] = await connection.query<SecretOperationRow[]>(
      `SELECT operation_id, operator_id, game_id, identity_id,
              secret_kind, action, old_version, new_version, created_at
         FROM admin_secret_operations
        WHERE operation_id = ?
        FOR SHARE`,
      [operationId],
    );
    const row = rows[0];
    if (!row) {
      throw new GameManageKitError(404, "NOT_FOUND");
    }
    return row;
  }

  private assertMachineOperation(
    operation: SecretOperationRow,
    identityId: string,
    action?: "set" | "rotate" | "revoke",
    operatorId?: string,
  ): void {
    if (
      operation.identity_id !== identityId
      || operation.game_id !== null
      || !["service_secret", "machine_admin_secret"].includes(
        operation.secret_kind,
      )
      || (action !== undefined && operation.action !== action)
      || (operatorId !== undefined && operation.operator_id !== operatorId)
    ) {
      throw new GameManageKitError(409, "OPERATION_CONFLICT");
    }
  }

  private operationStatus(
    operation: SecretOperationRow,
  ): MachineSecretOperationStatus {
    if (!["set", "rotate", "revoke"].includes(operation.action)) {
      throw new Error("机器 Secret 操作类型数据无效");
    }
    return Object.freeze({
      operationId: operation.operation_id,
      identityId: String(operation.identity_id),
      action: operation.action as MachineSecretOperationStatus["action"],
      status: "succeeded",
      version: operationVersion(operation),
      deliveryLost: true,
      createdAt: isoDate(operation.created_at),
    });
  }

  private async findIssuedReplay(
    identityId: string,
    operationId: string,
    action: "set" | "rotate",
    authorization: MachineAuthorization,
  ): Promise<MachineSecretIssued | null> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "secret");
      const [rows] = await connection.query<SecretOperationRow[]>(
        `SELECT operation_id, operator_id, game_id, identity_id,
                secret_kind, action, old_version, new_version, created_at
           FROM admin_secret_operations
          WHERE operation_id = ?
          FOR SHARE`,
        [operationId],
      );
      const operation = rows[0];
      if (!operation) {
        return null;
      }
      this.assertMachineOperation(
        operation,
        identityId,
        action,
        authorization.operatorId,
      );
      const version = operationVersion(operation);
      if (version === null) {
        throw new Error("机器 Secret 签发操作缺少版本");
      }
      const identity = await this.requireIdentity(
        connection,
        identityId,
        false,
      );
      const previousExpiresAt = action === "rotate"
        ? identity.secretVersions.find(
            (candidate) => candidate.version === Number(operation.old_version),
          )?.expiresAt ?? null
        : null;
      return Object.freeze({
        identity,
        version,
        previousExpiresAt,
        replayed: true,
      });
    });
  }

  private async findRevokedReplay(
    identityId: string,
    version: number,
    operationId: string,
    authorization: MachineAuthorization,
  ): Promise<MachineSecretRevoked | null> {
    return this.database.transaction(async (connection) => {
      await authorization.authorize(connection, "secret");
      const [rows] = await connection.query<SecretOperationRow[]>(
        `SELECT operation_id, operator_id, game_id, identity_id,
                secret_kind, action, old_version, new_version, created_at
           FROM admin_secret_operations
          WHERE operation_id = ?
          FOR SHARE`,
        [operationId],
      );
      const operation = rows[0];
      if (!operation) {
        return null;
      }
      this.assertMachineOperation(
        operation,
        identityId,
        "revoke",
        authorization.operatorId,
      );
      if (Number(operation.old_version) !== version) {
        throw new GameManageKitError(409, "OPERATION_CONFLICT");
      }
      const identity = await this.requireIdentity(
        connection,
        identityId,
        false,
      );
      return Object.freeze({
        identityId,
        version,
        state: "revoked",
        identityRevision: identity.revision,
        replayed: true,
      });
    });
  }
}
