// Generated from openapi/openapi.yaml. Do not edit.
export const GAME_MANAGE_KIT_CONTRACT_VERSION = "1.0.0";

export const GameManageKitPath = {
  BanAccount: "/v1/admin/accounts/{userId}/ban",
  DevLogin: "/v1/sessions/dev",
  HasCharacter: "/v1/internal/characters/{userId}/{serverId}",
  ListAreas: "/v1/areas",
  Livez: "/livez",
  Readyz: "/readyz",
  RegisterCharacter: "/v1/internal/characters/{userId}/{serverId}",
  RevokeAccount: "/v1/admin/accounts/{userId}/revoke",
  VerifySession: "/v1/internal/sessions/verify",
  Version: "/version",
  WxLogin: "/v1/sessions/wechat",
} as const;

export const GameManageKitMethod = {
  BanAccount: "POST",
  DevLogin: "POST",
  HasCharacter: "GET",
  ListAreas: "GET",
  Livez: "GET",
  Readyz: "GET",
  RegisterCharacter: "PUT",
  RevokeAccount: "POST",
  VerifySession: "POST",
  Version: "GET",
  WxLogin: "POST",
} as const;
