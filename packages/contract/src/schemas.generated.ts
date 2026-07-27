// Generated from openapi/openapi.yaml. Do not edit.
export const GameManageKitSchemas = {
  "GameId": {
    "type": "string",
    "minLength": 2,
    "maxLength": 32,
    "pattern": "^[a-z][a-z0-9-]{1,31}$",
    "$id": "GameId"
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
  "ErrorCode": {
    "type": "string",
    "enum": [
      "INVALID_PAYLOAD",
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
      "SERVER_DISABLED"
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
          "issuedAtMs"
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
