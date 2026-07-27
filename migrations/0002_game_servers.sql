CREATE TABLE IF NOT EXISTS game_directory_settings (
  game_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_ops     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id),
  CONSTRAINT fk_game_directory_settings_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_game_directory_settings_is_ops CHECK (is_ops IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS game_servers (
  game_id       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_id     SMALLINT UNSIGNED NOT NULL,
  name          VARCHAR(64) NOT NULL,
  tag           ENUM('normal', 'new', 'full', 'maintenance') NOT NULL,
  status        ENUM('smooth', 'busy', 'maintenance') NOT NULL,
  open_time     BIGINT UNSIGNED NOT NULL,
  game_http_url VARCHAR(2048) NOT NULL,
  game_ws_url   VARCHAR(2048) NOT NULL,
  is_open       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sort_order    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  revision      BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id, server_id),
  KEY idx_game_servers_open_order
    (game_id, is_open, sort_order, server_id),
  CONSTRAINT fk_game_servers_directory
    FOREIGN KEY (game_id) REFERENCES game_directory_settings (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_game_servers_name
    CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 64),
  CONSTRAINT chk_game_servers_tag
    CHECK (tag IN ('normal', 'new', 'full', 'maintenance')),
  CONSTRAINT chk_game_servers_status
    CHECK (status IN ('smooth', 'busy', 'maintenance')),
  CONSTRAINT chk_game_servers_open_time
    CHECK (open_time <= 9007199254740991),
  CONSTRAINT chk_game_servers_is_open CHECK (is_open IN (0, 1)),
  CONSTRAINT chk_game_servers_revision CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE admin_game_audit
  DROP CHECK chk_admin_game_audit_action,
  MODIFY action
    ENUM('create', 'update', 'server_create', 'server_update') NOT NULL,
  ADD CONSTRAINT chk_admin_game_audit_action
    CHECK (
      action IN ('create', 'update', 'server_create', 'server_update')
    );
