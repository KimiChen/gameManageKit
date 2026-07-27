CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT UNSIGNED NOT NULL,
  name       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS games (
  game_id            VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name               VARCHAR(128) NOT NULL,
  description        VARCHAR(500) NOT NULL DEFAULT '',
  status             ENUM('enabled', 'maintenance', 'disabled')
    NOT NULL DEFAULT 'maintenance',
  configuration_state ENUM('draft', 'configured') NOT NULL DEFAULT 'draft',
  client_visible     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sort_order         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  revision           BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id),
  CONSTRAINT chk_games_game_id
    CHECK (REGEXP_LIKE(game_id, '^[a-z][a-z0-9-]{1,31}$', 'c')),
  CONSTRAINT chk_games_name
    CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 128),
  CONSTRAINT chk_games_description
    CHECK (CHAR_LENGTH(description) <= 500),
  CONSTRAINT chk_games_status
    CHECK (status IN ('enabled', 'maintenance', 'disabled')),
  CONSTRAINT chk_games_configuration_state
    CHECK (configuration_state IN ('draft', 'configured')),
  CONSTRAINT chk_games_draft_status
    CHECK (configuration_state <> 'draft' OR status <> 'enabled'),
  CONSTRAINT chk_games_client_visible
    CHECK (client_visible IN (0, 1)),
  CONSTRAINT chk_games_client_visibility
    CHECK (
      client_visible = 0
      OR (configuration_state = 'configured' AND status <> 'disabled')
    ),
  CONSTRAINT chk_games_revision
    CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_operators (
  operator_id      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name     VARCHAR(128) NOT NULL,
  password_hash    VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status           ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  auth_version     BIGINT UNSIGNED NOT NULL DEFAULT 1,
  can_manage_games TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operator_id),
  CONSTRAINT chk_admin_operator_id
    CHECK (REGEXP_LIKE(operator_id, '^[a-z][a-z0-9_.-]{2,63}$', 'c')),
  CONSTRAINT chk_admin_operator_auth_version CHECK (auth_version > 0),
  CONSTRAINT chk_admin_operator_manage_games
    CHECK (can_manage_games IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_game_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_id     VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operator_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action      ENUM('create', 'update') NOT NULL,
  before_data JSON NULL,
  after_data  JSON NOT NULL,
  ip          VARBINARY(16) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_game_audit_game_time (game_id, created_at),
  KEY idx_admin_game_audit_operator_time (operator_id, created_at),
  CONSTRAINT fk_admin_game_audit_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_game_audit_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_admin_game_audit_action
    CHECK (action IN ('create', 'update'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_game_access (
  operator_id         VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  game_id             VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  can_operate_accounts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operator_id, game_id),
  KEY idx_admin_game_access_game (game_id, operator_id),
  CONSTRAINT fk_admin_game_access_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_admin_game_access_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_admin_game_access_operate
    CHECK (can_operate_accounts IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash   BINARY(32) NOT NULL,
  operator_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth_version BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  expires_at   DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_admin_sessions_operator (operator_id, expires_at),
  KEY idx_admin_sessions_expires (expires_at),
  KEY idx_admin_sessions_idle (last_seen_at),
  CONSTRAINT fk_admin_sessions_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT chk_admin_session_times CHECK (
    last_seen_at >= created_at
    AND expires_at > created_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_auth_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ip          VARBINARY(16) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_auth_operator_time (operator_id, created_at),
  KEY idx_admin_auth_event_time (event, created_at)
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
