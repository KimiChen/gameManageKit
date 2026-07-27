// Generated from openapi/openapi.yaml. Do not edit.
export const GAME_MANAGE_KIT_CONTRACT_VERSION = "1.0.0";

export const GameManageKitPath = {
  BanAccount: "/v1/games/{gameId}/admin/accounts/{userId}/ban",
  DevLogin: "/v1/games/{gameId}/sessions/dev",
  HasCharacter: "/v1/games/{gameId}/internal/characters/{userId}/{serverId}",
  ListAreas: "/v1/games/{gameId}/areas",
  Livez: "/livez",
  Metrics: "/metrics",
  Readyz: "/readyz",
  RegisterCharacter: "/v1/games/{gameId}/internal/characters/{userId}/{serverId}",
  RevokeAccount: "/v1/games/{gameId}/admin/accounts/{userId}/revoke",
  VerifySession: "/v1/games/{gameId}/internal/sessions/verify",
  Version: "/version",
  WxLogin: "/v1/games/{gameId}/sessions/wechat",
} as const;

export const GameManageKitMethod = {
  BanAccount: "POST",
  DevLogin: "POST",
  HasCharacter: "GET",
  ListAreas: "GET",
  Livez: "GET",
  Metrics: "GET",
  Readyz: "GET",
  RegisterCharacter: "PUT",
  RevokeAccount: "POST",
  VerifySession: "POST",
  Version: "GET",
  WxLogin: "POST",
} as const;
