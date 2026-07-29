// Generated from openapi/openapi.yaml. Do not edit.
export const GameManageKitSchemas = {
  "GameId": {
    "type": "string",
    "minLength": 2,
    "maxLength": 32,
    "pattern": "^[a-z][a-z0-9-]{1,31}$",
    "$id": "GameId"
  },
  "IdentityProvider": {
    "type": "string",
    "enum": [
      "wechat",
      "douyin"
    ],
    "$id": "IdentityProvider"
  },
  "OperationId": {
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[a-zA-Z0-9_.:-]+$",
    "$id": "OperationId"
  },
  "MachineIdentityId": {
    "type": "string",
    "minLength": 3,
    "maxLength": 64,
    "pattern": "^[a-z][a-z0-9_.-]{2,63}$",
    "$id": "MachineIdentityId"
  },
  "GameStatus": {
    "type": "string",
    "enum": [
      "enabled",
      "maintenance",
      "disabled"
    ],
    "$id": "GameStatus"
  },
  "GameConfigurationState": {
    "type": "string",
    "enum": [
      "draft",
      "configured"
    ],
    "$id": "GameConfigurationState"
  },
  "ErrorCode": {
    "type": "string",
    "enum": [
      "INVALID_PAYLOAD",
      "INVALID_REQUEST",
      "AUTH_REQUIRED",
      "ACCOUNT_BANNED",
      "NOT_FOUND",
      "RATE_LIMITED",
      "UPSTREAM_UNAVAILABLE",
      "SERVICE_AUTH_REQUIRED",
      "SERVICE_FORBIDDEN",
      "OPERATION_CONFLICT",
      "INTERNAL",
      "GAME_NOT_FOUND",
      "GAME_DISABLED",
      "GAME_ACCESS_DENIED",
      "SERVER_NOT_FOUND",
      "SERVER_DISABLED",
      "ADMIN_AUTH_REQUIRED",
      "ORIGIN_FORBIDDEN",
      "GAME_PROJECT_CONFLICT",
      "GAME_SERVER_CONFLICT",
      "ADMIN_ALREADY_INITIALIZED",
      "AUTH_CODE_INVALID",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_CONFIGURATION_INVALID",
      "IDENTITY_CONFLICT",
      "IDENTITY_PROVIDER_CONFLICT"
    ],
    "$id": "ErrorCode"
  },
  "ErrorResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "code",
      "requestId"
    ],
    "properties": {
      "code": {
        "$ref": "ErrorCode#"
      },
      "requestId": {
        "type": "string"
      }
    },
    "$id": "ErrorResponse"
  },
  "WxLoginRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "code",
      "serverId"
    ],
    "properties": {
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "deviceId": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 64
      }
    },
    "$id": "WxLoginRequest"
  },
  "DouyinLoginRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "code",
      "serverId"
    ],
    "properties": {
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "deviceId": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 64
      }
    },
    "$id": "DouyinLoginRequest"
  },
  "DevLoginRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "devKey",
      "serverId"
    ],
    "properties": {
      "devKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 32,
        "pattern": "^[a-zA-Z0-9_-]+$"
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "deviceId": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 64
      }
    },
    "$id": "DevLoginRequest"
  },
  "LoginResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "userId",
      "accessToken",
      "isNewAccount"
    ],
    "properties": {
      "userId": {
        "type": "string"
      },
      "accessToken": {
        "type": "string"
      },
      "isNewAccount": {
        "type": "boolean"
      }
    },
    "$id": "LoginResponse"
  },
  "AreaServer": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "serverId",
      "name",
      "tag",
      "status",
      "openTime",
      "gameHttpUrl",
      "gameWsUrl"
    ],
    "properties": {
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "tag": {
        "type": "string",
        "enum": [
          "normal",
          "new",
          "full",
          "maintenance"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "smooth",
          "busy",
          "maintenance"
        ]
      },
      "openTime": {
        "type": "integer",
        "minimum": 0
      },
      "gameHttpUrl": {
        "type": "string"
      },
      "gameWsUrl": {
        "type": "string"
      }
    },
    "$id": "AreaServer"
  },
  "AreaListResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "isOps",
      "hash",
      "servers",
      "myServerIds"
    ],
    "properties": {
      "isOps": {
        "type": "boolean"
      },
      "hash": {
        "type": "string"
      },
      "servers": {
        "type": "array",
        "items": {
          "$ref": "AreaServer#"
        }
      },
      "myServerIds": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 0,
          "maximum": 65535
        }
      }
    },
    "$id": "AreaListResponse"
  },
  "VerifySessionRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "accessToken",
      "serverId"
    ],
    "properties": {
      "accessToken": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      }
    },
    "$id": "VerifySessionRequest"
  },
  "VerifySessionResponse": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "valid",
          "userId",
          "issuedAtMs",
          "expiresAtMs"
        ],
        "properties": {
          "valid": {
            "const": true
          },
          "userId": {
            "type": "string"
          },
          "issuedAtMs": {
            "type": "integer",
            "minimum": 0
          },
          "expiresAtMs": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "valid",
          "reason"
        ],
        "properties": {
          "valid": {
            "const": false
          },
          "reason": {
            "type": "string",
            "enum": [
              "NOT_FOUND",
              "MISMATCH",
              "BANNED",
              "DEREGISTERED",
              "EXPIRED"
            ]
          }
        }
      }
    ],
    "$id": "VerifySessionResponse"
  },
  "RegisterCharacterResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "registered"
    ],
    "properties": {
      "registered": {
        "const": true
      }
    },
    "$id": "RegisterCharacterResponse"
  },
  "HasCharacterResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "exists"
    ],
    "properties": {
      "exists": {
        "type": "boolean"
      }
    },
    "$id": "HasCharacterResponse"
  },
  "AdminAccountRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operationId",
      "reason"
    ],
    "properties": {
      "operationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[a-zA-Z0-9_.:-]+$"
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      }
    },
    "$id": "AdminAccountRequest"
  },
  "AdminBootstrapRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operatorId",
      "displayName",
      "password"
    ],
    "properties": {
      "operatorId": {
        "type": "string",
        "minLength": 3,
        "maxLength": 64,
        "pattern": "^[a-z][a-z0-9_.-]{2,63}$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "password": {
        "type": "string",
        "minLength": 12,
        "maxLength": 256,
        "writeOnly": true
      }
    },
    "$id": "AdminBootstrapRequest"
  },
  "AdminBootstrapStatus": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "required"
    ],
    "properties": {
      "required": {
        "type": "boolean"
      }
    },
    "$id": "AdminBootstrapStatus"
  },
  "AdminLoginRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operatorId",
      "password"
    ],
    "properties": {
      "operatorId": {
        "type": "string",
        "maxLength": 64
      },
      "password": {
        "type": "string",
        "maxLength": 1024,
        "writeOnly": true
      }
    },
    "$id": "AdminLoginRequest"
  },
  "AdminReauthenticateRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "password"
    ],
    "properties": {
      "password": {
        "type": "string",
        "maxLength": 1024,
        "writeOnly": true
      }
    },
    "$id": "AdminReauthenticateRequest"
  },
  "AdminOperator": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operatorId",
      "displayName"
    ],
    "properties": {
      "operatorId": {
        "type": "string",
        "minLength": 3,
        "maxLength": 64,
        "pattern": "^[a-z][a-z0-9_.-]{2,63}$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "$id": "AdminOperator"
  },
  "AdminGameAccess": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "name",
      "status",
      "canOperateAccounts"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "status": {
        "$ref": "GameStatus#"
      },
      "canOperateAccounts": {
        "type": "boolean"
      }
    },
    "$id": "AdminGameAccess"
  },
  "AdminSessionResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operator",
      "games",
      "canManageGames",
      "canManageIntegrations",
      "canRotateSecrets",
      "canManageMachineIdentities",
      "expiresAt",
      "elevatedUntil"
    ],
    "properties": {
      "operator": {
        "$ref": "AdminOperator#"
      },
      "games": {
        "type": "array",
        "items": {
          "$ref": "AdminGameAccess#"
        }
      },
      "canManageGames": {
        "type": "boolean"
      },
      "canManageIntegrations": {
        "type": "boolean"
      },
      "canRotateSecrets": {
        "type": "boolean"
      },
      "canManageMachineIdentities": {
        "type": "boolean"
      },
      "expiresAt": {
        "type": "string",
        "format": "date-time"
      },
      "elevatedUntil": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      }
    },
    "$id": "AdminSessionResponse"
  },
  "GameProject": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "name",
      "description",
      "status",
      "configurationState",
      "clientVisible",
      "sortOrder",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "description": {
        "type": "string",
        "maxLength": 500
      },
      "status": {
        "$ref": "GameStatus#"
      },
      "configurationState": {
        "$ref": "GameConfigurationState#"
      },
      "clientVisible": {
        "type": "boolean"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "GameProject"
  },
  "GameProjectListResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "games"
    ],
    "properties": {
      "games": {
        "type": "array",
        "items": {
          "$ref": "GameProject#"
        }
      }
    },
    "$id": "GameProjectListResponse"
  },
  "CreateGameProjectRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "name",
      "description"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "description": {
        "type": "string",
        "maxLength": 500
      }
    },
    "$id": "CreateGameProjectRequest"
  },
  "UpdateGameProjectRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "description",
      "status",
      "clientVisible",
      "sortOrder",
      "revision"
    ],
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "description": {
        "type": "string",
        "maxLength": 500
      },
      "status": {
        "$ref": "GameStatus#"
      },
      "clientVisible": {
        "type": "boolean"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateGameProjectRequest"
  },
  "GameDirectorySettings": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "isOps",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "isOps": {
        "type": "boolean"
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "GameDirectorySettings"
  },
  "UpdateGameDirectorySettingsRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "isOps",
      "revision"
    ],
    "properties": {
      "isOps": {
        "type": "boolean"
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateGameDirectorySettingsRequest"
  },
  "ManagedGameServer": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "serverId",
      "name",
      "tag",
      "status",
      "openTime",
      "gameHttpUrl",
      "gameWsUrl",
      "isOpen",
      "sortOrder",
      "revision",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "tag": {
        "type": "string",
        "enum": [
          "normal",
          "new",
          "full",
          "maintenance"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "smooth",
          "busy",
          "maintenance"
        ]
      },
      "openTime": {
        "type": "integer",
        "minimum": 0
      },
      "gameHttpUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "gameWsUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "isOpen": {
        "type": "boolean"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "ManagedGameServer"
  },
  "ManagedGameServerListResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "directoryRevision",
      "servers"
    ],
    "properties": {
      "directoryRevision": {
        "type": "integer",
        "minimum": 1
      },
      "servers": {
        "type": "array",
        "maxItems": 65536,
        "items": {
          "$ref": "ManagedGameServer#"
        }
      }
    },
    "$id": "ManagedGameServerListResponse"
  },
  "ManagedGameServerMutationResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "directoryRevision",
      "server"
    ],
    "properties": {
      "directoryRevision": {
        "type": "integer",
        "minimum": 1
      },
      "server": {
        "$ref": "ManagedGameServer#"
      }
    },
    "$id": "ManagedGameServerMutationResponse"
  },
  "CreateGameServerRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "directoryRevision",
      "serverId",
      "name",
      "tag",
      "status",
      "openTime",
      "gameHttpUrl",
      "gameWsUrl",
      "isOpen",
      "sortOrder"
    ],
    "properties": {
      "directoryRevision": {
        "type": "integer",
        "minimum": 1
      },
      "serverId": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "tag": {
        "type": "string",
        "enum": [
          "normal",
          "new",
          "full",
          "maintenance"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "smooth",
          "busy",
          "maintenance"
        ]
      },
      "openTime": {
        "type": "integer",
        "minimum": 0
      },
      "gameHttpUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "gameWsUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "isOpen": {
        "type": "boolean"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      }
    },
    "$id": "CreateGameServerRequest"
  },
  "UpdateGameServerRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "directoryRevision",
      "name",
      "tag",
      "status",
      "openTime",
      "gameHttpUrl",
      "gameWsUrl",
      "isOpen",
      "sortOrder",
      "revision"
    ],
    "properties": {
      "directoryRevision": {
        "type": "integer",
        "minimum": 1
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "tag": {
        "type": "string",
        "enum": [
          "normal",
          "new",
          "full",
          "maintenance"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "smooth",
          "busy",
          "maintenance"
        ]
      },
      "openTime": {
        "type": "integer",
        "minimum": 0
      },
      "gameHttpUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "gameWsUrl": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "isOpen": {
        "type": "boolean"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "maximum": 65535
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateGameServerRequest"
  },
  "IdentityProviderValidationState": {
    "type": "string",
    "enum": [
      "unvalidated",
      "active",
      "validation_failed"
    ],
    "$id": "IdentityProviderValidationState"
  },
  "IdentityProviderSecretMetadata": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "configured",
      "version",
      "updatedAt"
    ],
    "properties": {
      "configured": {
        "type": "boolean"
      },
      "version": {
        "type": "integer",
        "minimum": 0
      },
      "updatedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      }
    },
    "$id": "IdentityProviderSecretMetadata"
  },
  "IdentityProviderConfiguration": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "provider",
      "enabled",
      "appId",
      "secretMetadata",
      "endpoint",
      "timeoutMs",
      "breakerThreshold",
      "breakerOpenMs",
      "validationState",
      "validationFailedAt",
      "validationErrorCode",
      "updatedBy",
      "updatedAt"
    ],
    "properties": {
      "provider": {
        "$ref": "IdentityProvider#"
      },
      "enabled": {
        "type": "boolean"
      },
      "appId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 128
      },
      "secretMetadata": {
        "$ref": "IdentityProviderSecretMetadata#"
      },
      "endpoint": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "timeoutMs": {
        "type": "integer",
        "minimum": 100,
        "maximum": 30000
      },
      "breakerThreshold": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      },
      "breakerOpenMs": {
        "type": "integer",
        "minimum": 100,
        "maximum": 600000
      },
      "validationState": {
        "$ref": "IdentityProviderValidationState#"
      },
      "validationFailedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "validationErrorCode": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 64
      },
      "updatedBy": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 3,
        "maxLength": 64,
        "pattern": "^[a-z][a-z0-9_.-]{2,63}$"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "IdentityProviderConfiguration"
  },
  "GameIntegration": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "configurationState",
      "providers",
      "sessionTtlSeconds",
      "loginRateCapacity",
      "loginRateRefillPerSecond",
      "adminRateCapacity",
      "adminRateRefillPerSecond",
      "revision",
      "loadedRevision",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "configurationState": {
        "$ref": "GameConfigurationState#"
      },
      "providers": {
        "type": "array",
        "minItems": 2,
        "maxItems": 2,
        "uniqueItems": true,
        "items": {
          "$ref": "IdentityProviderConfiguration#"
        }
      },
      "sessionTtlSeconds": {
        "type": "integer",
        "minimum": 60,
        "maximum": 31536000
      },
      "loginRateCapacity": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "loginRateRefillPerSecond": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "adminRateCapacity": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "adminRateRefillPerSecond": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "loadedRevision": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "GameIntegration"
  },
  "UpdateGameIntegrationRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sessionTtlSeconds",
      "loginRateCapacity",
      "loginRateRefillPerSecond",
      "adminRateCapacity",
      "adminRateRefillPerSecond",
      "revision"
    ],
    "properties": {
      "sessionTtlSeconds": {
        "type": "integer",
        "minimum": 60,
        "maximum": 31536000
      },
      "loginRateCapacity": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "loginRateRefillPerSecond": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "adminRateCapacity": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "adminRateRefillPerSecond": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 1000000
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateGameIntegrationRequest"
  },
  "UpdateIdentityProviderRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "enabled",
      "appId",
      "endpoint",
      "timeoutMs",
      "breakerThreshold",
      "breakerOpenMs",
      "revision"
    ],
    "properties": {
      "enabled": {
        "type": "boolean"
      },
      "appId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 128
      },
      "endpoint": {
        "type": "string",
        "format": "uri",
        "maxLength": 2048
      },
      "timeoutMs": {
        "type": "integer",
        "minimum": 100,
        "maximum": 30000
      },
      "breakerThreshold": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      },
      "breakerOpenMs": {
        "type": "integer",
        "minimum": 100,
        "maximum": 600000
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateIdentityProviderRequest"
  },
  "ReplaceIdentityProviderSecretRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "appSecret",
      "revision",
      "operationId"
    ],
    "properties": {
      "appSecret": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512,
        "writeOnly": true
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "operationId": {
        "$ref": "OperationId#"
      }
    },
    "$id": "ReplaceIdentityProviderSecretRequest"
  },
  "ClearIdentityProviderSecretRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "revision",
      "operationId"
    ],
    "properties": {
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "operationId": {
        "$ref": "OperationId#"
      }
    },
    "$id": "ClearIdentityProviderSecretRequest"
  },
  "IdentityProviderSecretWriteResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "provider",
      "configurationState",
      "secretMetadata",
      "revision",
      "loadedRevision",
      "replayed"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "provider": {
        "$ref": "IdentityProvider#"
      },
      "configurationState": {
        "$ref": "GameConfigurationState#"
      },
      "secretMetadata": {
        "$ref": "IdentityProviderSecretMetadata#"
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "loadedRevision": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "replayed": {
        "type": "boolean"
      }
    },
    "$id": "IdentityProviderSecretWriteResponse"
  },
  "MachineIdentityType": {
    "type": "string",
    "enum": [
      "service",
      "machine_admin"
    ],
    "$id": "MachineIdentityType"
  },
  "MachineIdentityStatus": {
    "type": "string",
    "enum": [
      "enabled",
      "disabled"
    ],
    "$id": "MachineIdentityStatus"
  },
  "MachineSecretState": {
    "type": "string",
    "enum": [
      "current",
      "previous",
      "revoked"
    ],
    "$id": "MachineSecretState"
  },
  "MachineSecretVersion": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "version",
      "state",
      "expiresAt",
      "createdAt",
      "activatedAt",
      "lastUsedAt",
      "revokedAt"
    ],
    "properties": {
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "state": {
        "$ref": "MachineSecretState#"
      },
      "expiresAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "activatedAt": {
        "type": "string",
        "format": "date-time"
      },
      "lastUsedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "revokedAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      }
    },
    "$id": "MachineSecretVersion"
  },
  "MachineIdentity": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "identityId",
      "identityType",
      "displayName",
      "status",
      "gameIds",
      "revision",
      "secretVersions",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "identityId": {
        "$ref": "MachineIdentityId#"
      },
      "identityType": {
        "$ref": "MachineIdentityType#"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "status": {
        "$ref": "MachineIdentityStatus#"
      },
      "gameIds": {
        "type": "array",
        "uniqueItems": true,
        "items": {
          "$ref": "GameId#"
        }
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "secretVersions": {
        "type": "array",
        "items": {
          "$ref": "MachineSecretVersion#"
        }
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "updatedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "MachineIdentity"
  },
  "MachineIdentityListResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "identities"
    ],
    "properties": {
      "identities": {
        "type": "array",
        "items": {
          "$ref": "MachineIdentity#"
        }
      }
    },
    "$id": "MachineIdentityListResponse"
  },
  "CreateMachineIdentityRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "identityId",
      "identityType",
      "displayName",
      "gameIds",
      "operationId"
    ],
    "properties": {
      "identityId": {
        "$ref": "MachineIdentityId#"
      },
      "identityType": {
        "$ref": "MachineIdentityType#"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "gameIds": {
        "type": "array",
        "uniqueItems": true,
        "items": {
          "$ref": "GameId#"
        }
      },
      "operationId": {
        "$ref": "OperationId#"
      }
    },
    "$id": "CreateMachineIdentityRequest"
  },
  "UpdateMachineIdentityRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "displayName",
      "status",
      "gameIds",
      "revision"
    ],
    "properties": {
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "status": {
        "$ref": "MachineIdentityStatus#"
      },
      "gameIds": {
        "type": "array",
        "uniqueItems": true,
        "items": {
          "$ref": "GameId#"
        }
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "$id": "UpdateMachineIdentityRequest"
  },
  "RotateMachineSecretRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operationId",
      "revision",
      "previousValiditySeconds"
    ],
    "properties": {
      "operationId": {
        "$ref": "OperationId#"
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "previousValiditySeconds": {
        "type": "integer",
        "minimum": 60,
        "maximum": 604800
      }
    },
    "$id": "RotateMachineSecretRequest"
  },
  "RevokeMachineSecretRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operationId",
      "revision",
      "reason"
    ],
    "properties": {
      "operationId": {
        "$ref": "OperationId#"
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      }
    },
    "$id": "RevokeMachineSecretRequest"
  },
  "MachineSecretIssuedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "identity",
      "version",
      "previousExpiresAt",
      "replayed"
    ],
    "properties": {
      "identity": {
        "$ref": "MachineIdentity#"
      },
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "secret": {
        "type": "string",
        "minLength": 43,
        "maxLength": 43,
        "pattern": "^[A-Za-z0-9_-]+$",
        "readOnly": true,
        "description": "仅首次成功响应返回；幂等重放时缺省且无法恢复。"
      },
      "previousExpiresAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "replayed": {
        "type": "boolean"
      }
    },
    "$id": "MachineSecretIssuedResponse"
  },
  "MachineSecretRevokedResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "identityId",
      "version",
      "state",
      "identityRevision",
      "replayed"
    ],
    "properties": {
      "identityId": {
        "$ref": "MachineIdentityId#"
      },
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "state": {
        "const": "revoked"
      },
      "identityRevision": {
        "type": "integer",
        "minimum": 1
      },
      "replayed": {
        "type": "boolean"
      }
    },
    "$id": "MachineSecretRevokedResponse"
  },
  "MachineSecretOperationStatus": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operationId",
      "identityId",
      "action",
      "status",
      "version",
      "deliveryLost",
      "createdAt"
    ],
    "properties": {
      "operationId": {
        "$ref": "OperationId#"
      },
      "identityId": {
        "$ref": "MachineIdentityId#"
      },
      "action": {
        "type": "string",
        "enum": [
          "set",
          "rotate",
          "revoke"
        ]
      },
      "status": {
        "const": "succeeded"
      },
      "version": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "deliveryLost": {
        "type": "boolean"
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "MachineSecretOperationStatus"
  },
  "ConfigurationAuditRecord": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "auditType",
      "operatorId",
      "gameId",
      "provider",
      "identityId",
      "action",
      "result",
      "oldVersion",
      "newVersion",
      "revision",
      "requestId",
      "operationId",
      "beforeMetadata",
      "afterMetadata",
      "createdAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "auditType": {
        "type": "string",
        "enum": [
          "game_configuration",
          "machine_identity",
          "secret"
        ]
      },
      "operatorId": {
        "type": "string",
        "minLength": 3,
        "maxLength": 64
      },
      "gameId": {
        "oneOf": [
          {
            "$ref": "GameId#"
          },
          {
            "type": "null"
          }
        ]
      },
      "provider": {
        "oneOf": [
          {
            "$ref": "IdentityProvider#"
          },
          {
            "type": "null"
          }
        ]
      },
      "identityId": {
        "oneOf": [
          {
            "$ref": "MachineIdentityId#"
          },
          {
            "type": "null"
          }
        ]
      },
      "action": {
        "type": "string",
        "maxLength": 64
      },
      "result": {
        "type": "string",
        "maxLength": 64
      },
      "oldVersion": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 0
      },
      "newVersion": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 0
      },
      "revision": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "requestId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 64
      },
      "operationId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9_.:-]+$"
      },
      "beforeMetadata": {
        "type": [
          "object",
          "null"
        ],
        "additionalProperties": true
      },
      "afterMetadata": {
        "type": [
          "object",
          "null"
        ],
        "additionalProperties": true
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "$id": "ConfigurationAuditRecord"
  },
  "ConfigurationAuditPage": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "records"
    ],
    "properties": {
      "records": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "$ref": "ConfigurationAuditRecord#"
        }
      }
    },
    "$id": "ConfigurationAuditPage"
  },
  "ClientGameSummary": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "gameId",
      "name",
      "description",
      "status"
    ],
    "properties": {
      "gameId": {
        "$ref": "GameId#"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "description": {
        "type": "string",
        "maxLength": 500
      },
      "status": {
        "type": "string",
        "enum": [
          "enabled",
          "maintenance"
        ]
      }
    },
    "$id": "ClientGameSummary"
  },
  "ClientGameListResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "games"
    ],
    "properties": {
      "games": {
        "type": "array",
        "items": {
          "$ref": "ClientGameSummary#"
        }
      }
    },
    "$id": "ClientGameListResponse"
  },
  "AdminAccountDetailResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "userId",
      "status",
      "lastLoginAt",
      "activeSessionCount"
    ],
    "properties": {
      "userId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 32,
        "pattern": "^u_[0-9]+$"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "banned",
          "deregistered"
        ]
      },
      "lastLoginAt": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time"
      },
      "activeSessionCount": {
        "type": "integer",
        "minimum": 0
      }
    },
    "$id": "AdminAccountDetailResponse"
  },
  "AdminAccountResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "accountExists",
      "status"
    ],
    "properties": {
      "accountExists": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "banned",
          "revoked",
          "not_found"
        ]
      }
    },
    "$id": "AdminAccountResponse"
  },
  "LiveResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok"
    ],
    "properties": {
      "ok": {
        "const": true
      }
    },
    "$id": "LiveResponse"
  },
  "ReadyResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ready"
    ],
    "properties": {
      "ready": {
        "type": "boolean"
      }
    },
    "$id": "ReadyResponse"
  },
  "VersionResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "service",
      "serviceVersion",
      "contractVersion",
      "schemaVersion",
      "gitSha"
    ],
    "properties": {
      "service": {
        "const": "game-manage-kit"
      },
      "serviceVersion": {
        "type": "string"
      },
      "contractVersion": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "integer"
      },
      "gitSha": {
        "type": "string"
      }
    },
    "$id": "VersionResponse"
  }
} as const;
