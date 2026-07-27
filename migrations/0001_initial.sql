CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT UNSIGNED NOT NULL,
  name       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS games (
  game_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status     ENUM('enabled', 'maintenance', 'disabled') NOT NULL DEFAULT 'enabled',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id),
  CONSTRAINT chk_games_game_id
    CHECK (REGEXP_LIKE(game_id, '^[a-z][a-z0-9-]{1,31}$', 'c')),
  CONSTRAINT chk_games_status
    CHECK (status IN ('enabled', 'maintenance', 'disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS accounts (
  game_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  unionid       VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  nickname      VARCHAR(64) NULL,
  avatar_url    VARCHAR(256) NULL,
  phone         VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (game_id, user_id),
  UNIQUE KEY uk_openid (game_id, openid),
  UNIQUE KEY uk_unionid (game_id, unionid),
  CONSTRAINT fk_accounts_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_accounts_status CHECK (status IN (0, 1, 2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
  game_id        VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id         VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_id       SMALLINT UNSIGNED NOT NULL,
  token_hash      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_issued_at DATETIME(3) NOT NULL,
  PRIMARY KEY (game_id, user_id, server_id),
  CONSTRAINT fk_account_sessions_account
    FOREIGN KEY (game_id, user_id) REFERENCES accounts (game_id, user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS char_registry (
  game_id   VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_id  SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id, user_id, server_id),
  KEY idx_user_time (game_id, user_id, created_at),
  CONSTRAINT fk_char_registry_account
    FOREIGN KEY (game_id, user_id) REFERENCES accounts (game_id, user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS login_audit (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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
  PRIMARY KEY (id, game_id),
  UNIQUE KEY uk_operation (game_id, operation_id),
  KEY idx_user_time (game_id, user_id, created_at),
  CONSTRAINT fk_login_audit_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_login_audit_target_exists
    CHECK (target_exists IS NULL OR target_exists IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS seq (
  game_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  val     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (game_id, name),
  CONSTRAINT fk_seq_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
