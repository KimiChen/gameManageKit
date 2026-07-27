CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT UNSIGNED NOT NULL,
  name       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS accounts (
  user_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  unionid       VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  session_key   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  nickname      VARCHAR(64) NULL,
  avatar_url    VARCHAR(256) NULL,
  phone         VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (user_id),
  UNIQUE KEY uk_openid (openid),
  UNIQUE KEY uk_unionid (unionid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
  user_id         VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_id       INT UNSIGNED NOT NULL,
  token_hash      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_issued_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, server_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS char_registry (
  user_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_id  SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, server_id),
  KEY idx_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS login_audit (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event         VARCHAR(24) NOT NULL,
  operator      VARCHAR(64) NULL,
  caller        VARCHAR(64) NULL,
  target_exists TINYINT UNSIGNED NULL,
  reason        VARCHAR(255) NULL,
  ip            VARBINARY(16) NULL,
  device_id     VARCHAR(64) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_operation (operation_id),
  KEY idx_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS seq (
  name VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  val  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO seq (name, val) VALUES ('user_id', 0)
ON DUPLICATE KEY UPDATE name = name;
