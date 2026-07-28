export * from "./paths.generated.js";
export { GameManageKitSchemas } from "./schemas.generated.js";
export type { components, operations, paths } from "./types.generated.js";

import type { components } from "./types.generated.js";

export type GameId = components["schemas"]["GameId"];
export type GameStatus = components["schemas"]["GameStatus"];
export type GameManageKitErrorCode = components["schemas"]["ErrorCode"];
export type ErrorResponse = components["schemas"]["ErrorResponse"];
export type WxLoginRequest = components["schemas"]["WxLoginRequest"];
export type DevLoginRequest = components["schemas"]["DevLoginRequest"];
export type LoginResponse = components["schemas"]["LoginResponse"];
export type AreaServer = components["schemas"]["AreaServer"];
export type AreaListResponse = components["schemas"]["AreaListResponse"];
export type VerifySessionRequest = components["schemas"]["VerifySessionRequest"];
export type VerifySessionResponse = components["schemas"]["VerifySessionResponse"];
export type RegisterCharacterResponse = components["schemas"]["RegisterCharacterResponse"];
export type HasCharacterResponse = components["schemas"]["HasCharacterResponse"];
export type AdminAccountRequest = components["schemas"]["AdminAccountRequest"];
export type AdminAccountResponse = components["schemas"]["AdminAccountResponse"];
export type AdminLoginRequest = components["schemas"]["AdminLoginRequest"];
export type AdminReauthenticateRequest =
  components["schemas"]["AdminReauthenticateRequest"];
export type AdminOperator = components["schemas"]["AdminOperator"];
export type AdminGameAccess = components["schemas"]["AdminGameAccess"];
export type AdminSessionResponse = components["schemas"]["AdminSessionResponse"];
export type GameConfigurationState =
  components["schemas"]["GameConfigurationState"];
export type GameProject = components["schemas"]["GameProject"];
export type GameProjectListResponse =
  components["schemas"]["GameProjectListResponse"];
export type CreateGameProjectRequest =
  components["schemas"]["CreateGameProjectRequest"];
export type UpdateGameProjectRequest =
  components["schemas"]["UpdateGameProjectRequest"];
export type GameDirectorySettings =
  components["schemas"]["GameDirectorySettings"];
export type UpdateGameDirectorySettingsRequest =
  components["schemas"]["UpdateGameDirectorySettingsRequest"];
export type ManagedGameServer =
  components["schemas"]["ManagedGameServer"];
export type ManagedGameServerListResponse =
  components["schemas"]["ManagedGameServerListResponse"];
export type ManagedGameServerMutationResponse =
  components["schemas"]["ManagedGameServerMutationResponse"];
export type CreateGameServerRequest =
  components["schemas"]["CreateGameServerRequest"];
export type UpdateGameServerRequest =
  components["schemas"]["UpdateGameServerRequest"];
export type WechatSecretMetadata =
  components["schemas"]["WechatSecretMetadata"];
export type GameIntegration = components["schemas"]["GameIntegration"];
export type UpdateGameIntegrationRequest =
  components["schemas"]["UpdateGameIntegrationRequest"];
export type ReplaceWechatAppSecretRequest =
  components["schemas"]["ReplaceWechatAppSecretRequest"];
export type WechatSecretWriteResponse =
  components["schemas"]["WechatSecretWriteResponse"];
export type MachineIdentityType =
  components["schemas"]["MachineIdentityType"];
export type MachineIdentityStatus =
  components["schemas"]["MachineIdentityStatus"];
export type MachineSecretState =
  components["schemas"]["MachineSecretState"];
export type MachineSecretVersion =
  components["schemas"]["MachineSecretVersion"];
export type MachineIdentity = components["schemas"]["MachineIdentity"];
export type MachineIdentityListResponse =
  components["schemas"]["MachineIdentityListResponse"];
export type CreateMachineIdentityRequest =
  components["schemas"]["CreateMachineIdentityRequest"];
export type UpdateMachineIdentityRequest =
  components["schemas"]["UpdateMachineIdentityRequest"];
export type RotateMachineSecretRequest =
  components["schemas"]["RotateMachineSecretRequest"];
export type RevokeMachineSecretRequest =
  components["schemas"]["RevokeMachineSecretRequest"];
export type MachineSecretIssuedResponse =
  components["schemas"]["MachineSecretIssuedResponse"];
export type MachineSecretRevokedResponse =
  components["schemas"]["MachineSecretRevokedResponse"];
export type MachineSecretOperationStatus =
  components["schemas"]["MachineSecretOperationStatus"];
export type ConfigurationAuditRecord =
  components["schemas"]["ConfigurationAuditRecord"];
export type ConfigurationAuditPage =
  components["schemas"]["ConfigurationAuditPage"];
export type ClientGameSummary = components["schemas"]["ClientGameSummary"];
export type ClientGameListResponse =
  components["schemas"]["ClientGameListResponse"];
export type AdminAccountDetailResponse =
  components["schemas"]["AdminAccountDetailResponse"];
export type LiveResponse = components["schemas"]["LiveResponse"];
export type ReadyResponse = components["schemas"]["ReadyResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];

// Consumer-facing aliases are prefixed so they can coexist with a game's own
// HTTP contracts when this package is mirrored into a shared protocol barrel.
export type GameManageKitLoginResponse = LoginResponse;
export type GameManageKitAreaServer = AreaServer;
export type GameManageKitAreaListResponse = AreaListResponse;
