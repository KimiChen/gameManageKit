ALTER TABLE game_directory_settings
  ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1
    AFTER is_ops,
  ADD CONSTRAINT chk_game_directory_settings_revision
    CHECK (revision > 0);

ALTER TABLE admin_operators
  ADD COLUMN can_manage_integrations TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER can_manage_games,
  ADD COLUMN can_rotate_secrets TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER can_manage_integrations,
  ADD COLUMN can_manage_machine_identities TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER can_rotate_secrets,
  ADD CONSTRAINT chk_admin_operator_manage_integrations
    CHECK (can_manage_integrations IN (0, 1)),
  ADD CONSTRAINT chk_admin_operator_rotate_secrets
    CHECK (can_rotate_secrets IN (0, 1)),
  ADD CONSTRAINT chk_admin_operator_manage_machine_identities
    CHECK (can_manage_machine_identities IN (0, 1));

ALTER TABLE admin_sessions
  ADD COLUMN elevated_until DATETIME(3) NULL
    AFTER expires_at,
  ADD CONSTRAINT chk_admin_session_elevated_until
    CHECK (
      elevated_until IS NULL
      OR (
        elevated_until >= created_at
        AND elevated_until <= expires_at
      )
    );

CREATE TABLE game_integrations (
  game_id                          VARCHAR(32)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wechat_app_id                    VARCHAR(128)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  wechat_app_secret                VARCHAR(512)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  wechat_secret_version            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  wechat_secret_updated_by         VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  wechat_secret_updated_at         DATETIME(3) NULL,
  wechat_validation_failed_at      DATETIME(3) NULL,
  wechat_endpoint                  VARCHAR(2048) NOT NULL
    DEFAULT 'https://api.weixin.qq.com/sns/jscode2session',
  wechat_timeout_ms                INT UNSIGNED NOT NULL DEFAULT 3000,
  wechat_breaker_threshold         SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  wechat_breaker_open_ms           INT UNSIGNED NOT NULL DEFAULT 10000,
  session_ttl_seconds              INT UNSIGNED NOT NULL DEFAULT 259200,
  login_rate_capacity              DECIMAL(13, 6) UNSIGNED NOT NULL
    DEFAULT 5.000000,
  login_rate_refill_per_second     DECIMAL(13, 6) UNSIGNED NOT NULL
    DEFAULT 0.200000,
  admin_rate_capacity              DECIMAL(13, 6) UNSIGNED NOT NULL
    DEFAULT 10.000000,
  admin_rate_refill_per_second     DECIMAL(13, 6) UNSIGNED NOT NULL
    DEFAULT 1.000000,
  revision                         BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at                       DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                       DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id),
  KEY idx_game_integrations_secret_operator
    (wechat_secret_updated_by, wechat_secret_updated_at),
  CONSTRAINT fk_game_integrations_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_game_integrations_secret_operator
    FOREIGN KEY (wechat_secret_updated_by)
    REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_game_integrations_wechat_app_id
    CHECK (
      wechat_app_id IS NULL
      OR CHAR_LENGTH(wechat_app_id) BETWEEN 1 AND 128
    ),
  CONSTRAINT chk_game_integrations_wechat_secret
    CHECK (
      (
        wechat_app_secret IS NULL
        AND wechat_secret_version = 0
        AND wechat_secret_updated_by IS NULL
        AND wechat_secret_updated_at IS NULL
      )
      OR (
        CHAR_LENGTH(wechat_app_secret) BETWEEN 1 AND 512
        AND wechat_secret_version > 0
        AND wechat_secret_updated_by IS NOT NULL
        AND wechat_secret_updated_at IS NOT NULL
      )
    ),
  CONSTRAINT chk_game_integrations_wechat_endpoint
    CHECK (CHAR_LENGTH(wechat_endpoint) BETWEEN 1 AND 2048),
  CONSTRAINT chk_game_integrations_wechat_timeout
    CHECK (wechat_timeout_ms BETWEEN 100 AND 30000),
  CONSTRAINT chk_game_integrations_wechat_breaker_threshold
    CHECK (wechat_breaker_threshold BETWEEN 1 AND 1000),
  CONSTRAINT chk_game_integrations_wechat_breaker_open
    CHECK (wechat_breaker_open_ms BETWEEN 100 AND 600000),
  CONSTRAINT chk_game_integrations_session_ttl
    CHECK (session_ttl_seconds BETWEEN 60 AND 31536000),
  CONSTRAINT chk_game_integrations_login_rate
    CHECK (
      login_rate_capacity BETWEEN 1 AND 1000000
      AND login_rate_refill_per_second > 0
      AND login_rate_refill_per_second <= 1000000
    ),
  CONSTRAINT chk_game_integrations_admin_rate
    CHECK (
      admin_rate_capacity BETWEEN 1 AND 1000000
      AND admin_rate_refill_per_second > 0
      AND admin_rate_refill_per_second <= 1000000
    ),
  CONSTRAINT chk_game_integrations_revision
    CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE machine_identities (
  identity_id   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_type ENUM('service', 'machine_admin') NOT NULL,
  display_name  VARCHAR(128) NOT NULL,
  status        ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',
  revision      BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (identity_id),
  CONSTRAINT chk_machine_identities_id
    CHECK (
      REGEXP_LIKE(identity_id, '^[a-z][a-z0-9_.-]{2,63}$', 'c')
    ),
  CONSTRAINT chk_machine_identities_type
    CHECK (identity_type IN ('service', 'machine_admin')),
  CONSTRAINT chk_machine_identities_display_name
    CHECK (CHAR_LENGTH(display_name) BETWEEN 1 AND 128),
  CONSTRAINT chk_machine_identities_status
    CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT chk_machine_identities_revision
    CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE machine_identity_games (
  identity_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  game_id     VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (identity_id, game_id),
  KEY idx_machine_identity_games_game (game_id, identity_id),
  CONSTRAINT fk_machine_identity_games_identity
    FOREIGN KEY (identity_id) REFERENCES machine_identities (identity_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_machine_identity_games_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admin_machine_identity_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identity_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action      ENUM('create', 'update') NOT NULL,
  before_data JSON NULL,
  after_data  JSON NOT NULL,
  ip          VARBINARY(16) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_machine_identity_audit_identity_time
    (identity_id, created_at),
  KEY idx_admin_machine_identity_audit_operator_time
    (operator_id, created_at),
  CONSTRAINT fk_admin_machine_identity_audit_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_machine_identity_audit_identity
    FOREIGN KEY (identity_id) REFERENCES machine_identities (identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_admin_machine_identity_audit_action
    CHECK (action IN ('create', 'update')),
  CONSTRAINT chk_admin_machine_identity_audit_before
    CHECK (
      (action = 'create' AND before_data IS NULL)
      OR (action = 'update' AND before_data IS NOT NULL)
    ),
  CONSTRAINT chk_admin_machine_identity_audit_ip
    CHECK (
      ip IS NULL
      OR OCTET_LENGTH(ip) IN (4, 16)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE machine_secret_versions (
  identity_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version      BIGINT UNSIGNED NOT NULL,
  secret_digest BINARY(32) NOT NULL,
  state        ENUM('current', 'previous', 'revoked') NOT NULL,
  expires_at   DATETIME(3) NULL,
  created_by   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  revoked_at   DATETIME(3) NULL,
  current_slot TINYINT UNSIGNED
    GENERATED ALWAYS AS (
      CASE WHEN state = 'current' THEN 1 ELSE NULL END
    ) STORED,
  previous_slot TINYINT UNSIGNED
    GENERATED ALWAYS AS (
      CASE WHEN state = 'previous' THEN 1 ELSE NULL END
    ) STORED,
  PRIMARY KEY (identity_id, version),
  UNIQUE KEY uk_machine_secret_versions_digest (secret_digest),
  UNIQUE KEY uk_machine_secret_versions_current
    (identity_id, current_slot),
  UNIQUE KEY uk_machine_secret_versions_previous
    (identity_id, previous_slot),
  KEY idx_machine_secret_versions_auth
    (identity_id, state, expires_at),
  KEY idx_machine_secret_versions_creator
    (created_by, created_at),
  CONSTRAINT fk_machine_secret_versions_identity
    FOREIGN KEY (identity_id) REFERENCES machine_identities (identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_machine_secret_versions_creator
    FOREIGN KEY (created_by) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_machine_secret_versions_version
    CHECK (version > 0),
  CONSTRAINT chk_machine_secret_versions_state
    CHECK (state IN ('current', 'previous', 'revoked')),
  CONSTRAINT chk_machine_secret_versions_expiry
    CHECK (
      expires_at IS NULL
      OR expires_at > activated_at
    ),
  CONSTRAINT chk_machine_secret_versions_previous_expiry
    CHECK (state <> 'previous' OR expires_at IS NOT NULL),
  CONSTRAINT chk_machine_secret_versions_activation
    CHECK (activated_at >= created_at),
  CONSTRAINT chk_machine_secret_versions_last_used
    CHECK (
      last_used_at IS NULL
      OR last_used_at >= activated_at
    ),
  CONSTRAINT chk_machine_secret_versions_revocation
    CHECK (
      (state = 'revoked' AND revoked_at IS NOT NULL)
      OR (state <> 'revoked' AND revoked_at IS NULL)
    ),
  CONSTRAINT chk_machine_secret_versions_revoked_at
    CHECK (
      revoked_at IS NULL
      OR revoked_at >= activated_at
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admin_secret_operations (
  operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operator_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  game_id      VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  identity_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  secret_kind  ENUM(
    'wechat_app_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  action        ENUM('set', 'rotate', 'revoke') NOT NULL,
  old_version   BIGINT UNSIGNED NULL,
  new_version   BIGINT UNSIGNED NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operation_id),
  KEY idx_admin_secret_operations_operator
    (operator_id, created_at),
  KEY idx_admin_secret_operations_game
    (game_id, created_at),
  KEY idx_admin_secret_operations_identity
    (identity_id, created_at),
  CONSTRAINT fk_admin_secret_operations_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_secret_operations_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_secret_operations_identity
    FOREIGN KEY (identity_id) REFERENCES machine_identities (identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_admin_secret_operations_id
    CHECK (
      REGEXP_LIKE(operation_id, '^[A-Za-z0-9_.:-]{1,64}$', 'c')
    ),
  CONSTRAINT chk_admin_secret_operations_kind
    CHECK (
      secret_kind IN (
        'wechat_app_secret',
        'service_secret',
        'machine_admin_secret'
      )
    ),
  CONSTRAINT chk_admin_secret_operations_action
    CHECK (action IN ('set', 'rotate', 'revoke')),
  CONSTRAINT chk_admin_secret_operations_target
    CHECK (
      (
        secret_kind = 'wechat_app_secret'
        AND game_id IS NOT NULL
        AND identity_id IS NULL
        AND action = 'set'
      )
      OR (
        secret_kind IN ('service_secret', 'machine_admin_secret')
        AND game_id IS NULL
        AND identity_id IS NOT NULL
        AND action IN ('set', 'rotate', 'revoke')
      )
    ),
  CONSTRAINT chk_admin_secret_operations_versions
    CHECK (
      (new_version IS NULL OR new_version > 0)
      AND (
        (action = 'set' AND new_version IS NOT NULL)
        OR (
          action = 'rotate'
          AND (old_version IS NULL OR old_version > 0)
          AND new_version IS NOT NULL
        )
        OR (
          action = 'revoke'
          AND old_version > 0
          AND new_version IS NULL
        )
      )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admin_secret_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  game_id     VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  identity_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  secret_kind ENUM(
    'wechat_app_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  action      ENUM('set', 'rotate', 'revoke') NOT NULL,
  old_version BIGINT UNSIGNED NULL,
  new_version BIGINT UNSIGNED NULL,
  result      ENUM('succeeded', 'failed') NOT NULL,
  reason      VARCHAR(255) NULL,
  request_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip          VARBINARY(16) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_secret_audit_operator_time
    (operator_id, created_at),
  KEY idx_admin_secret_audit_game_time
    (game_id, created_at),
  KEY idx_admin_secret_audit_identity_time
    (identity_id, created_at),
  KEY idx_admin_secret_audit_request (request_id),
  CONSTRAINT fk_admin_secret_audit_operator
    FOREIGN KEY (operator_id) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_secret_audit_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_admin_secret_audit_identity
    FOREIGN KEY (identity_id) REFERENCES machine_identities (identity_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_admin_secret_audit_kind
    CHECK (
      secret_kind IN (
        'wechat_app_secret',
        'service_secret',
        'machine_admin_secret'
      )
    ),
  CONSTRAINT chk_admin_secret_audit_action
    CHECK (action IN ('set', 'rotate', 'revoke')),
  CONSTRAINT chk_admin_secret_audit_target
    CHECK (
      (
        secret_kind = 'wechat_app_secret'
        AND game_id IS NOT NULL
        AND identity_id IS NULL
        AND action = 'set'
      )
      OR (
        secret_kind IN ('service_secret', 'machine_admin_secret')
        AND game_id IS NULL
        AND identity_id IS NOT NULL
        AND action IN ('set', 'rotate', 'revoke')
      )
    ),
  CONSTRAINT chk_admin_secret_audit_versions
    CHECK (
      (new_version IS NULL OR new_version > 0)
      AND (
        result = 'failed'
        OR (
          action = 'set'
          AND new_version IS NOT NULL
        )
        OR (
          action = 'rotate'
          AND (old_version IS NULL OR old_version > 0)
          AND new_version IS NOT NULL
        )
        OR (
          action = 'revoke'
          AND old_version > 0
          AND new_version IS NULL
        )
      )
    ),
  CONSTRAINT chk_admin_secret_audit_result_reason
    CHECK (
      reason IS NULL
      OR CHAR_LENGTH(reason) BETWEEN 1 AND 255
    ),
  CONSTRAINT chk_admin_secret_audit_request
    CHECK (CHAR_LENGTH(request_id) BETWEEN 1 AND 64),
  CONSTRAINT chk_admin_secret_audit_ip
    CHECK (
      ip IS NULL
      OR OCTET_LENGTH(ip) IN (4, 16)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE admin_game_audit
  DROP CHECK chk_admin_game_audit_action,
  MODIFY action ENUM(
    'create',
    'update',
    'server_create',
    'server_update',
    'directory_update',
    'integration_update'
  ) NOT NULL,
  ADD CONSTRAINT chk_admin_game_audit_action
    CHECK (
      action IN (
        'create',
        'update',
        'server_create',
        'server_update',
        'directory_update',
        'integration_update'
      )
    );

INSERT INTO game_directory_settings (game_id, is_ops, revision)
SELECT games.game_id, 0, 1
  FROM games
  LEFT JOIN game_directory_settings
    ON game_directory_settings.game_id = games.game_id
 WHERE game_directory_settings.game_id IS NULL;

INSERT INTO game_integrations (game_id)
SELECT games.game_id
  FROM games
  LEFT JOIN game_integrations
    ON game_integrations.game_id = games.game_id
 WHERE game_integrations.game_id IS NULL;

UPDATE games
JOIN game_integrations
  ON game_integrations.game_id = games.game_id
SET games.configuration_state = 'draft',
    games.status = CASE
      WHEN games.status = 'disabled' THEN 'disabled'
      ELSE 'maintenance'
    END,
    games.client_visible = 0,
    games.revision = games.revision + 1
WHERE games.configuration_state = 'configured'
  AND (
    game_integrations.wechat_app_id IS NULL
    OR game_integrations.wechat_app_secret IS NULL
  );

INSERT INTO seq (game_id, name, val)
SELECT games.game_id, 'user_id', 0
  FROM games
  LEFT JOIN seq
    ON seq.game_id = games.game_id
   AND seq.name = 'user_id'
 WHERE seq.game_id IS NULL;
