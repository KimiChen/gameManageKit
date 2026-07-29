-- v5 removes the ambiguous account-level openid/unionid namespace.  MySQL
-- DDL commits implicitly, so all data checks happen before either target
-- table is created.  Run v5 only after every v4 writer has stopped.  On a
-- late failure, target tables are deliberately preserved: rerunning must
-- never delete already-backfilled identities or Provider credentials.
-- The diagnostic table intentionally contains no external identity values.
CREATE TABLE IF NOT EXISTS schema_v5_identity_migration_state (
  singleton  TINYINT UNSIGNED NOT NULL,
  phase      ENUM('backfill_verified', 'complete') NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (singleton),
  CONSTRAINT chk_schema_v5_identity_migration_state_singleton
    CHECK (singleton = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS schema_v5_apply_identity_providers;
CREATE PROCEDURE schema_v5_apply_identity_providers()
SQL SECURITY INVOKER
BEGIN
  DECLARE v_accounts_legacy_columns BIGINT UNSIGNED DEFAULT 0;
  DECLARE v_integrations_legacy_columns BIGINT UNSIGNED DEFAULT 0;
  DECLARE v_checkpoint_count BIGINT UNSIGNED DEFAULT 0;
  DECLARE v_schema_count BIGINT UNSIGNED DEFAULT 0;
  DECLARE v_invalid_count BIGINT UNSIGNED DEFAULT 0;

  SELECT COUNT(*)
    INTO v_accounts_legacy_columns
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'accounts'
     AND column_name IN ('openid', 'unionid');

  SELECT COUNT(*)
    INTO v_integrations_legacy_columns
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'game_integrations'
     AND column_name IN (
       'wechat_app_id',
       'wechat_app_secret',
       'wechat_secret_version',
       'wechat_secret_updated_by',
       'wechat_secret_updated_at',
       'wechat_validation_failed_at',
       'wechat_endpoint',
       'wechat_timeout_ms',
       'wechat_breaker_threshold',
       'wechat_breaker_open_ms'
     );

  IF v_accounts_legacy_columns = 2
     AND v_integrations_legacy_columns = 10 THEN
DROP TABLE IF EXISTS schema_v5_identity_migration_gate;
DROP TABLE IF EXISTS schema_v5_identity_backfill_gate;
DROP TABLE IF EXISTS schema_v5_identity_migration_errors;

CREATE TABLE schema_v5_identity_migration_errors (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id    VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (id),
  KEY idx_schema_v5_identity_errors_game (game_id, user_id, error_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, user_id, 'ACCOUNT_WITHOUT_IDENTITY'
  FROM accounts
 WHERE openid IS NULL
   AND unionid IS NULL;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, user_id, 'DEV_IDENTITY_HAS_UNIONID'
  FROM accounts
 WHERE LEFT(openid, 4) = 'dev_'
   AND unionid IS NOT NULL;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, user_id, 'DEV_KEY_EMPTY'
  FROM accounts
 WHERE openid = 'dev_';

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, user_id, 'INVALID_IDENTITY_LOGIN_TIME'
  FROM accounts
 WHERE last_login_at IS NOT NULL
   AND last_login_at < created_at;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, user_id, 'IDENTITY_SUBJECT_EMPTY'
  FROM accounts
 WHERE openid = ''
    OR unionid = '';

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT game_id, NULL, 'WECHAT_APP_ID_RESERVED'
  FROM game_integrations
 WHERE wechat_app_id = 'local';

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT a.game_id, a.user_id, 'WECHAT_APP_ID_MISSING'
  FROM accounts AS a
  LEFT JOIN game_integrations AS i ON i.game_id = a.game_id
 WHERE (
         (a.openid IS NOT NULL AND LEFT(a.openid, 4) <> 'dev_')
         OR a.unionid IS NOT NULL
       )
   AND (
     i.wechat_app_id IS NULL
     OR CHAR_LENGTH(i.wechat_app_id) = 0
   );

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT a.game_id, a.user_id, 'DUPLICATE_WECHAT_OPENID'
  FROM accounts AS a
  JOIN (
    SELECT game_id, openid
      FROM accounts
     WHERE openid IS NOT NULL
       AND LEFT(openid, 4) <> 'dev_'
     GROUP BY game_id, openid
    HAVING COUNT(*) > 1
  ) AS duplicate_identity
    ON duplicate_identity.game_id = a.game_id
   AND duplicate_identity.openid = a.openid;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT a.game_id, a.user_id, 'DUPLICATE_WECHAT_UNIONID'
  FROM accounts AS a
  JOIN (
    SELECT game_id, unionid
      FROM accounts
     WHERE unionid IS NOT NULL
     GROUP BY game_id, unionid
    HAVING COUNT(*) > 1
  ) AS duplicate_identity
    ON duplicate_identity.game_id = a.game_id
   AND duplicate_identity.unionid = a.unionid;

INSERT INTO schema_v5_identity_migration_errors
  (game_id, user_id, error_code)
SELECT DISTINCT game_id, user_id, 'LEGACY_IDENTITY_CONFLICT'
  FROM login_audit
 WHERE event = 'login_dual_account';

CREATE TABLE schema_v5_identity_migration_gate (
  error_count BIGINT UNSIGNED NOT NULL,
  CONSTRAINT chk_schema_v5_identity_migration_gate
    CHECK (error_count = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A failed CHECK aborts before the target schema is touched.  Correct the
-- rows listed above and rerun the same migration.
INSERT INTO schema_v5_identity_migration_gate (error_count)
SELECT COUNT(*) FROM schema_v5_identity_migration_errors;

DROP TABLE schema_v5_identity_migration_gate;

CREATE TABLE IF NOT EXISTS game_identity_providers (
  game_id               VARCHAR(32)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider              ENUM('wechat', 'douyin') NOT NULL,
  enabled               TINYINT UNSIGNED NOT NULL DEFAULT 0,
  app_id                VARCHAR(128)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  app_secret            VARCHAR(512)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  secret_version        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  secret_updated_at     DATETIME(3) NULL,
  endpoint              VARCHAR(2048) NOT NULL,
  timeout_ms            INT UNSIGNED NOT NULL DEFAULT 3000,
  breaker_threshold     SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  breaker_open_ms       INT UNSIGNED NOT NULL DEFAULT 10000,
  validation_state      ENUM(
    'unvalidated',
    'active',
    'validation_failed'
  ) NOT NULL DEFAULT 'unvalidated',
  validation_failed_at  DATETIME(3) NULL,
  validation_error_code VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by            VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (game_id, provider),
  KEY idx_game_identity_providers_operator (updated_by, updated_at),
  CONSTRAINT fk_game_identity_providers_game
    FOREIGN KEY (game_id) REFERENCES games (game_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_game_identity_providers_operator
    FOREIGN KEY (updated_by) REFERENCES admin_operators (operator_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_game_identity_providers_provider
    CHECK (provider IN ('wechat', 'douyin')),
  CONSTRAINT chk_game_identity_providers_enabled
    CHECK (enabled IN (0, 1)),
  CONSTRAINT chk_game_identity_providers_enabled_configuration
    CHECK (
      enabled = 0
      OR (app_id IS NOT NULL AND app_secret IS NOT NULL)
    ),
  CONSTRAINT chk_game_identity_providers_app_id
    CHECK (
      app_id IS NULL
      OR (
        CHAR_LENGTH(app_id) BETWEEN 1 AND 128
        AND app_id <> 'local'
      )
    ),
  CONSTRAINT chk_game_identity_providers_secret
    CHECK (
      (
        app_secret IS NULL
        AND secret_version = 0
        AND secret_updated_at IS NULL
      )
      OR (
        app_secret IS NOT NULL
        AND CHAR_LENGTH(app_secret) BETWEEN 1 AND 512
        AND secret_version > 0
        AND secret_updated_at IS NOT NULL
      )
    ),
  CONSTRAINT chk_game_identity_providers_endpoint
    CHECK (CHAR_LENGTH(endpoint) BETWEEN 1 AND 2048),
  CONSTRAINT chk_game_identity_providers_timeout
    CHECK (timeout_ms BETWEEN 100 AND 30000),
  CONSTRAINT chk_game_identity_providers_breaker_threshold
    CHECK (breaker_threshold BETWEEN 1 AND 1000),
  CONSTRAINT chk_game_identity_providers_breaker_open
    CHECK (breaker_open_ms BETWEEN 100 AND 600000),
  CONSTRAINT chk_game_identity_providers_validation
    CHECK (
      (
        validation_state IN ('unvalidated', 'active')
        AND validation_failed_at IS NULL
        AND validation_error_code IS NULL
      )
      OR (
        validation_state = 'validation_failed'
        AND validation_failed_at IS NOT NULL
        AND CHAR_LENGTH(validation_error_code) BETWEEN 1 AND 64
      )
    ),
  CONSTRAINT chk_game_identity_providers_validated_configuration
    CHECK (
      validation_state = 'unvalidated'
      OR (app_id IS NOT NULL AND app_secret IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS account_identities (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  game_id         VARCHAR(32)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id         VARCHAR(32)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider        ENUM('wechat', 'douyin', 'dev') NOT NULL,
  provider_app_id VARCHAR(128)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject_type    ENUM('openid', 'unionid', 'dev_key') NOT NULL,
  subject         VARCHAR(256)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at   DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_account_identities_namespace
    (game_id, provider, provider_app_id, subject_type, subject),
  KEY idx_account_identities_account (game_id, user_id),
  CONSTRAINT fk_account_identities_account
    FOREIGN KEY (game_id, user_id) REFERENCES accounts (game_id, user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_account_identities_provider
    CHECK (provider IN ('wechat', 'douyin', 'dev')),
  CONSTRAINT chk_account_identities_app_id
    CHECK (CHAR_LENGTH(provider_app_id) BETWEEN 1 AND 128),
  CONSTRAINT chk_account_identities_subject
    CHECK (CHAR_LENGTH(subject) BETWEEN 1 AND 256),
  CONSTRAINT chk_account_identities_namespace
    CHECK (
      (
        provider = 'dev'
        AND provider_app_id = 'local'
        AND subject_type = 'dev_key'
      )
      OR (
        provider IN ('wechat', 'douyin')
        AND provider_app_id <> 'local'
        AND subject_type IN ('openid', 'unionid')
      )
    ),
  CONSTRAINT chk_account_identities_login_time
    CHECK (last_login_at IS NULL OR last_login_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Existing complete WeChat configurations stay enabled.  Legacy validation
-- failure timestamps are deliberately not trusted: v4 also set them for an
-- ordinary invalid player code, so v5 starts the credentials unvalidated.
INSERT INTO game_identity_providers (
  game_id, provider, enabled, app_id, app_secret, secret_version,
  secret_updated_at,
  endpoint, timeout_ms, breaker_threshold, breaker_open_ms,
  validation_state, validation_failed_at, validation_error_code,
  updated_by, updated_at
)
SELECT
  game_id,
  'wechat',
  IF(wechat_app_id IS NOT NULL AND wechat_app_secret IS NOT NULL, 1, 0),
  wechat_app_id,
  wechat_app_secret,
  wechat_secret_version,
  wechat_secret_updated_at,
  CASE
    WHEN LOWER(wechat_endpoint) REGEXP
      '^https://api[.]weixin[.]qq[.]com(:443)?/sns/jscode2session([?]#?|#)?$'
    THEN 'https://api.weixin.qq.com/sns/jscode2session'
    ELSE wechat_endpoint
  END,
  wechat_timeout_ms,
  wechat_breaker_threshold,
  wechat_breaker_open_ms,
  'unvalidated',
  NULL,
  NULL,
  wechat_secret_updated_by,
  COALESCE(wechat_secret_updated_at, updated_at)
FROM game_integrations AS integration
WHERE NOT EXISTS (
  SELECT 1
    FROM game_identity_providers AS provider
   WHERE provider.game_id = integration.game_id
     AND provider.provider = 'wechat'
);

INSERT INTO game_identity_providers (
  game_id, provider, enabled, app_id, app_secret, secret_version,
  secret_updated_at,
  endpoint, timeout_ms, breaker_threshold, breaker_open_ms,
  validation_state, validation_failed_at, validation_error_code,
  updated_by, updated_at
)
SELECT
  game_id,
  'douyin',
  0,
  NULL,
  NULL,
  0,
  NULL,
  'https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session',
  3000,
  5,
  10000,
  'unvalidated',
  NULL,
  NULL,
  NULL,
  updated_at
FROM game_integrations AS integration
WHERE NOT EXISTS (
  SELECT 1
    FROM game_identity_providers AS provider
   WHERE provider.game_id = integration.game_id
     AND provider.provider = 'douyin'
);

INSERT INTO account_identities (
  game_id, user_id, provider, provider_app_id, subject_type, subject,
  created_at, last_login_at
)
SELECT
  game_id,
  user_id,
  'dev',
  'local',
  'dev_key',
  SUBSTRING(openid, 5),
  created_at,
  last_login_at
FROM accounts AS account
WHERE LEFT(account.openid, 4) = 'dev_'
  AND account.unionid IS NULL
  AND NOT EXISTS (
    SELECT 1
      FROM account_identities AS identity
     WHERE identity.game_id = account.game_id
       AND identity.provider = 'dev'
       AND identity.provider_app_id = 'local'
       AND identity.subject_type = 'dev_key'
       AND identity.subject = SUBSTRING(account.openid, 5)
  );

INSERT INTO account_identities (
  game_id, user_id, provider, provider_app_id, subject_type, subject,
  created_at, last_login_at
)
SELECT
  a.game_id,
  a.user_id,
  'wechat',
  i.wechat_app_id,
  'openid',
  a.openid,
  a.created_at,
  a.last_login_at
FROM accounts AS a
JOIN game_integrations AS i ON i.game_id = a.game_id
WHERE a.openid IS NOT NULL
  AND LEFT(a.openid, 4) <> 'dev_'
  AND NOT EXISTS (
    SELECT 1
      FROM account_identities AS identity
     WHERE identity.game_id = a.game_id
       AND identity.provider = 'wechat'
       AND identity.provider_app_id = i.wechat_app_id
       AND identity.subject_type = 'openid'
       AND identity.subject = a.openid
  );

INSERT INTO account_identities (
  game_id, user_id, provider, provider_app_id, subject_type, subject,
  created_at, last_login_at
)
SELECT
  a.game_id,
  a.user_id,
  'wechat',
  i.wechat_app_id,
  'unionid',
  a.unionid,
  a.created_at,
  a.last_login_at
FROM accounts AS a
JOIN game_integrations AS i ON i.game_id = a.game_id
WHERE a.unionid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM account_identities AS identity
     WHERE identity.game_id = a.game_id
       AND identity.provider = 'wechat'
       AND identity.provider_app_id = i.wechat_app_id
       AND identity.subject_type = 'unionid'
       AND identity.subject = a.unionid
  );

CREATE TABLE schema_v5_identity_backfill_gate (
  invalid_count BIGINT UNSIGNED NOT NULL,
  CONSTRAINT chk_schema_v5_identity_backfill_gate
    CHECK (invalid_count = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO schema_v5_identity_backfill_gate (invalid_count)
SELECT
  IF(
    (
      SELECT COUNT(*)
        FROM account_identities
    )
    =
    (
      SELECT
        COALESCE(
          SUM(
            IF(LEFT(openid, 4) = 'dev_', 1, 0)
            + IF(openid IS NOT NULL AND LEFT(openid, 4) <> 'dev_', 1, 0)
            + IF(unionid IS NOT NULL, 1, 0)
          ),
          0
        )
        FROM accounts
    ),
    0,
    1
  )
  + (
      SELECT COUNT(*)
        FROM accounts AS a
       WHERE NOT EXISTS (
         SELECT 1
           FROM account_identities AS identity
          WHERE identity.game_id = a.game_id
            AND identity.user_id = a.user_id
       )
    )
  + (
      SELECT COUNT(*)
        FROM accounts AS a
       WHERE LEFT(a.openid, 4) = 'dev_'
         AND NOT EXISTS (
           SELECT 1
             FROM account_identities AS identity
            WHERE identity.game_id = a.game_id
              AND identity.user_id = a.user_id
              AND identity.provider = 'dev'
              AND identity.provider_app_id = 'local'
              AND identity.subject_type = 'dev_key'
              AND identity.subject = SUBSTRING(a.openid, 5)
         )
    )
  + (
      SELECT COUNT(*)
        FROM accounts AS a
        JOIN game_integrations AS integration
          ON integration.game_id = a.game_id
       WHERE a.openid IS NOT NULL
         AND LEFT(a.openid, 4) <> 'dev_'
         AND NOT EXISTS (
           SELECT 1
             FROM account_identities AS identity
            WHERE identity.game_id = a.game_id
              AND identity.user_id = a.user_id
              AND identity.provider = 'wechat'
              AND identity.provider_app_id = integration.wechat_app_id
              AND identity.subject_type = 'openid'
              AND identity.subject = a.openid
         )
    )
  + (
      SELECT COUNT(*)
        FROM accounts AS a
        JOIN game_integrations AS integration
          ON integration.game_id = a.game_id
       WHERE a.unionid IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM account_identities AS identity
            WHERE identity.game_id = a.game_id
              AND identity.user_id = a.user_id
              AND identity.provider = 'wechat'
              AND identity.provider_app_id = integration.wechat_app_id
              AND identity.subject_type = 'unionid'
              AND identity.subject = a.unionid
         )
    )
  + IF(
      (SELECT COUNT(*) FROM game_identity_providers)
        = (SELECT COUNT(*) * 2 FROM games),
      0,
      1
    )
  + (
      SELECT COUNT(*)
        FROM games AS game
       WHERE NOT EXISTS (
         SELECT 1
           FROM game_identity_providers AS provider
          WHERE provider.game_id = game.game_id
            AND provider.provider = 'wechat'
       )
          OR NOT EXISTS (
         SELECT 1
           FROM game_identity_providers AS provider
          WHERE provider.game_id = game.game_id
            AND provider.provider = 'douyin'
       )
    )
  + (
      SELECT COUNT(*)
        FROM game_integrations AS integration
        LEFT JOIN game_identity_providers AS provider
          ON provider.game_id = integration.game_id
         AND provider.provider = 'wechat'
       WHERE provider.game_id IS NULL
          OR NOT (
            provider.enabled
              <=> IF(
                integration.wechat_app_id IS NOT NULL
                  AND integration.wechat_app_secret IS NOT NULL,
                1,
                0
              )
            AND provider.app_id <=> integration.wechat_app_id
            AND provider.app_secret <=> integration.wechat_app_secret
            AND provider.secret_version
              <=> integration.wechat_secret_version
            AND provider.secret_updated_at
              <=> integration.wechat_secret_updated_at
            AND provider.endpoint <=> CASE
              WHEN LOWER(integration.wechat_endpoint) REGEXP
                '^https://api[.]weixin[.]qq[.]com(:443)?/sns/jscode2session([?]#?|#)?$'
              THEN 'https://api.weixin.qq.com/sns/jscode2session'
              ELSE integration.wechat_endpoint
            END
            AND provider.timeout_ms <=> integration.wechat_timeout_ms
            AND provider.breaker_threshold
              <=> integration.wechat_breaker_threshold
            AND provider.breaker_open_ms
              <=> integration.wechat_breaker_open_ms
            AND provider.validation_state <=> 'unvalidated'
            AND provider.validation_failed_at IS NULL
            AND provider.validation_error_code IS NULL
            AND provider.updated_by
              <=> integration.wechat_secret_updated_by
          )
    )
  + (
      SELECT COUNT(*)
        FROM game_integrations AS integration
        LEFT JOIN game_identity_providers AS provider
          ON provider.game_id = integration.game_id
         AND provider.provider = 'douyin'
       WHERE provider.game_id IS NULL
          OR NOT (
            provider.enabled <=> 0
            AND provider.app_id IS NULL
            AND provider.app_secret IS NULL
            AND provider.secret_version <=> 0
            AND provider.secret_updated_at IS NULL
            AND provider.endpoint
              <=> 'https://minigame.zijieapi.com/mgplatform/api/apps/jscode2session'
            AND provider.timeout_ms <=> 3000
            AND provider.breaker_threshold <=> 5
            AND provider.breaker_open_ms <=> 10000
            AND provider.validation_state <=> 'unvalidated'
            AND provider.validation_failed_at IS NULL
            AND provider.validation_error_code IS NULL
            AND provider.updated_by IS NULL
          )
    );

DROP TABLE schema_v5_identity_backfill_gate;

INSERT INTO schema_v5_identity_migration_state (singleton, phase)
VALUES (1, 'backfill_verified')
ON DUPLICATE KEY UPDATE
  phase = IF(
    schema_v5_identity_migration_state.phase = 'complete',
    'complete',
    'backfill_verified'
  );
  ELSE
    SELECT COUNT(*)
      INTO v_checkpoint_count
      FROM schema_v5_identity_migration_state
     WHERE singleton = 1
       AND phase IN ('backfill_verified', 'complete');
    IF v_checkpoint_count <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT =
          'v5 legacy columns are incomplete without a verified backfill';
    END IF;
    IF v_accounts_legacy_columns NOT IN (0, 2)
       OR v_integrations_legacy_columns NOT IN (0, 10) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'v5 legacy schema is only partially present';
    END IF;
  END IF;

-- Generic provider configuration and secret audit metadata.
SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'admin_game_audit'
   AND column_name = 'provider';
IF v_schema_count = 0 THEN
ALTER TABLE admin_game_audit
  DROP CHECK chk_admin_game_audit_action,
  ADD COLUMN provider ENUM('wechat', 'douyin') NULL
    AFTER operator_id,
  ADD COLUMN revision BIGINT UNSIGNED NULL
    AFTER provider,
  ADD COLUMN request_id VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER revision,
  ADD COLUMN result ENUM('succeeded', 'failed') NOT NULL
    DEFAULT 'succeeded' AFTER action,
  MODIFY action ENUM(
    'create',
    'update',
    'server_create',
    'server_update',
    'directory_update',
    'integration_update',
    'identity_provider_update',
    'identity_provider_enable',
    'identity_provider_disable'
  ) NOT NULL,
  ADD KEY idx_admin_game_audit_provider_time
    (game_id, provider, created_at),
  ADD CONSTRAINT chk_admin_game_audit_action
    CHECK (
      action IN (
        'create',
        'update',
        'server_create',
        'server_update',
        'directory_update',
        'integration_update',
        'identity_provider_update',
        'identity_provider_enable',
        'identity_provider_disable'
      )
    ),
  ADD CONSTRAINT chk_admin_game_audit_provider
    CHECK (
      (
        action IN (
          'identity_provider_update',
          'identity_provider_enable',
          'identity_provider_disable'
        )
        AND provider IS NOT NULL
      )
      OR (
        action NOT IN (
          'identity_provider_update',
          'identity_provider_enable',
          'identity_provider_disable'
        )
        AND provider IS NULL
      )
    ),
  ADD CONSTRAINT chk_admin_game_audit_revision
    CHECK (revision IS NULL OR revision > 0),
  ADD CONSTRAINT chk_admin_game_audit_request
    CHECK (
      request_id IS NULL
      OR CHAR_LENGTH(request_id) BETWEEN 1 AND 64
    ),
  ADD CONSTRAINT chk_admin_game_audit_result
    CHECK (result IN ('succeeded', 'failed'));
END IF;

-- The first late ALTER is durable here.  Recovery must recognize it from the
-- resulting schema rather than assuming the migration starts from v4.
SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'admin_secret_operations'
   AND column_name = 'provider';
IF v_schema_count = 0 THEN
ALTER TABLE admin_secret_operations
  DROP CHECK chk_admin_secret_operations_kind,
  DROP CHECK chk_admin_secret_operations_action,
  DROP CHECK chk_admin_secret_operations_target,
  DROP CHECK chk_admin_secret_operations_versions,
  ADD COLUMN provider ENUM('wechat', 'douyin') NULL
    AFTER game_id,
  ADD COLUMN revision BIGINT UNSIGNED NULL
    AFTER provider,
  ADD COLUMN request_digest BINARY(32) NULL
    AFTER revision,
  ADD COLUMN result_configuration_state
    ENUM('draft', 'configured') NULL
    AFTER request_digest,
  ADD COLUMN result_revision BIGINT UNSIGNED NULL
    AFTER result_configuration_state,
  ADD COLUMN result_secret_updated_at DATETIME(3) NULL
    AFTER result_revision,
  MODIFY secret_kind ENUM(
    'wechat_app_secret',
    'identity_provider_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  MODIFY action ENUM('set', 'rotate', 'revoke', 'clear') NOT NULL,
  ADD KEY idx_admin_secret_operations_provider
    (game_id, provider, created_at);
END IF;

UPDATE admin_secret_operations
   SET old_version = NULL
 WHERE old_version = 0;

UPDATE admin_secret_operations
   SET provider = 'wechat',
       secret_kind = 'identity_provider_secret'
 WHERE secret_kind = 'wechat_app_secret';

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.table_constraints
 WHERE constraint_schema = DATABASE()
   AND table_name = 'admin_secret_operations'
   AND constraint_name = 'chk_admin_secret_operations_kind';
IF v_schema_count = 0 THEN
ALTER TABLE admin_secret_operations
  MODIFY secret_kind ENUM(
    'identity_provider_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  ADD CONSTRAINT chk_admin_secret_operations_kind
    CHECK (
      secret_kind IN (
        'identity_provider_secret',
        'service_secret',
        'machine_admin_secret'
      )
    ),
  ADD CONSTRAINT chk_admin_secret_operations_action
    CHECK (action IN ('set', 'rotate', 'revoke', 'clear')),
  ADD CONSTRAINT chk_admin_secret_operations_request_digest
    CHECK (
      request_digest IS NULL
      OR OCTET_LENGTH(request_digest) = 32
    ),
  ADD CONSTRAINT chk_admin_secret_operations_provider_result
    CHECK (
      (
        secret_kind = 'identity_provider_secret'
        AND (
          (
            revision IS NULL
            AND request_digest IS NULL
            AND result_configuration_state IS NULL
            AND result_revision IS NULL
            AND result_secret_updated_at IS NULL
          )
          OR (
            revision > 0
            AND request_digest IS NOT NULL
            AND result_configuration_state IS NOT NULL
            AND result_revision > 0
            AND (
              (
                action IN ('set', 'rotate')
                AND result_secret_updated_at IS NOT NULL
              )
              OR (
                action = 'clear'
                AND result_secret_updated_at IS NULL
              )
            )
          )
        )
      )
      OR (
        secret_kind IN ('service_secret', 'machine_admin_secret')
        AND revision IS NULL
        AND request_digest IS NULL
        AND result_configuration_state IS NULL
        AND result_revision IS NULL
        AND result_secret_updated_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_admin_secret_operations_target
    CHECK (
      (
        secret_kind = 'identity_provider_secret'
        AND game_id IS NOT NULL
        AND provider IS NOT NULL
        AND identity_id IS NULL
        AND action IN ('set', 'rotate', 'clear')
      )
      OR (
        secret_kind IN ('service_secret', 'machine_admin_secret')
        AND game_id IS NULL
        AND provider IS NULL
        AND identity_id IS NOT NULL
        AND action IN ('set', 'rotate', 'revoke')
      )
    ),
  ADD CONSTRAINT chk_admin_secret_operations_versions
    CHECK (
      (old_version IS NULL OR old_version > 0)
      AND (new_version IS NULL OR new_version > 0)
      AND (revision IS NULL OR revision > 0)
      AND (result_revision IS NULL OR result_revision > 0)
      AND (
        (action = 'set' AND new_version IS NOT NULL)
        OR (action = 'rotate' AND new_version IS NOT NULL)
        OR (
          action IN ('revoke', 'clear')
          AND old_version IS NOT NULL
          AND new_version IS NULL
        )
      )
    );
END IF;

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'admin_secret_audit'
   AND column_name = 'provider';
IF v_schema_count = 0 THEN
ALTER TABLE admin_secret_audit
  DROP CHECK chk_admin_secret_audit_kind,
  DROP CHECK chk_admin_secret_audit_action,
  DROP CHECK chk_admin_secret_audit_target,
  DROP CHECK chk_admin_secret_audit_versions,
  ADD COLUMN provider ENUM('wechat', 'douyin') NULL
    AFTER game_id,
  ADD COLUMN operation_id VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER request_id,
  ADD COLUMN revision BIGINT UNSIGNED NULL
    AFTER operation_id,
  MODIFY secret_kind ENUM(
    'wechat_app_secret',
    'identity_provider_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  MODIFY action ENUM('set', 'rotate', 'revoke', 'clear') NOT NULL,
  ADD KEY idx_admin_secret_audit_provider
    (game_id, provider, created_at),
  ADD KEY idx_admin_secret_audit_operation (operation_id);
END IF;

UPDATE admin_secret_audit
   SET old_version = NULL
 WHERE old_version = 0;

UPDATE admin_secret_audit
   SET provider = 'wechat',
       secret_kind = 'identity_provider_secret'
 WHERE secret_kind = 'wechat_app_secret';

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.table_constraints
 WHERE constraint_schema = DATABASE()
   AND table_name = 'admin_secret_audit'
   AND constraint_name = 'chk_admin_secret_audit_kind';
IF v_schema_count = 0 THEN
ALTER TABLE admin_secret_audit
  MODIFY secret_kind ENUM(
    'identity_provider_secret',
    'service_secret',
    'machine_admin_secret'
  ) NOT NULL,
  ADD CONSTRAINT chk_admin_secret_audit_kind
    CHECK (
      secret_kind IN (
        'identity_provider_secret',
        'service_secret',
        'machine_admin_secret'
      )
    ),
  ADD CONSTRAINT chk_admin_secret_audit_action
    CHECK (action IN ('set', 'rotate', 'revoke', 'clear')),
  ADD CONSTRAINT chk_admin_secret_audit_operation_id
    CHECK (
      operation_id IS NULL
      OR CHAR_LENGTH(operation_id) BETWEEN 1 AND 64
    ),
  ADD CONSTRAINT chk_admin_secret_audit_target
    CHECK (
      (
        secret_kind = 'identity_provider_secret'
        AND game_id IS NOT NULL
        AND provider IS NOT NULL
        AND identity_id IS NULL
        AND action IN ('set', 'rotate', 'clear')
      )
      OR (
        secret_kind IN ('service_secret', 'machine_admin_secret')
        AND game_id IS NULL
        AND provider IS NULL
        AND identity_id IS NOT NULL
        AND action IN ('set', 'rotate', 'revoke')
      )
    ),
  ADD CONSTRAINT chk_admin_secret_audit_versions
    CHECK (
      (old_version IS NULL OR old_version > 0)
      AND (new_version IS NULL OR new_version > 0)
      AND (revision IS NULL OR revision > 0)
      AND (
        result = 'failed'
        OR (action = 'set' AND new_version IS NOT NULL)
        OR (action = 'rotate' AND new_version IS NOT NULL)
        OR (
          action IN ('revoke', 'clear')
          AND old_version IS NOT NULL
          AND new_version IS NULL
        )
      )
    );
END IF;

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'login_audit'
   AND column_name = 'provider';
IF v_schema_count = 0 THEN
ALTER TABLE login_audit
  ADD COLUMN provider ENUM('wechat', 'douyin', 'dev') NULL
    AFTER user_id,
  ADD COLUMN request_id VARCHAR(64)
    CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER provider,
  ADD COLUMN server_id SMALLINT UNSIGNED NULL
    AFTER request_id,
  ADD COLUMN outcome ENUM(
    'success',
    'invalid_code',
    'invalid_credentials',
    'rate_limited',
    'timeout',
    'circuit_open',
    'provider_unavailable',
    'identity_conflict',
    'admission_denied',
    'banned',
    'internal_error'
  ) NULL
    AFTER server_id,
  ADD COLUMN provider_latency_ms INT UNSIGNED NULL
    AFTER outcome,
  ADD COLUMN provider_version BIGINT UNSIGNED NULL
    AFTER provider_latency_ms,
  ADD KEY idx_login_audit_provider_time
    (game_id, provider, created_at),
  ADD KEY idx_login_audit_request (request_id),
  ADD CONSTRAINT chk_login_audit_provider
    CHECK (
      provider IS NULL
      OR provider IN ('wechat', 'douyin', 'dev')
    ),
  ADD CONSTRAINT chk_login_audit_request
    CHECK (
      request_id IS NULL
      OR CHAR_LENGTH(request_id) BETWEEN 1 AND 64
    ),
  ADD CONSTRAINT chk_login_audit_outcome
    CHECK (
      outcome IS NULL
      OR outcome IN (
        'success',
        'invalid_code',
        'invalid_credentials',
        'rate_limited',
        'timeout',
        'circuit_open',
        'provider_unavailable',
        'identity_conflict',
        'admission_denied',
        'banned',
        'internal_error'
      )
    ),
  ADD CONSTRAINT chk_login_audit_provider_latency
    CHECK (
      provider_latency_ms IS NULL
      OR provider_latency_ms <= 2147483647
    ),
  ADD CONSTRAINT chk_login_audit_provider_version
    CHECK (
      provider_version IS NULL
      OR provider_version > 0
    );
END IF;

-- At least one complete, enabled provider defines a configured game.
UPDATE games AS g
   SET g.configuration_state = 'configured',
       g.revision = g.revision + 1
 WHERE g.configuration_state <> 'configured'
   AND EXISTS (
     SELECT 1
       FROM game_identity_providers AS p
      WHERE p.game_id = g.game_id
        AND p.enabled = 1
        AND p.app_id IS NOT NULL
        AND p.app_secret IS NOT NULL
   );

UPDATE games AS g
   SET g.configuration_state = 'draft',
       g.status = CASE
         WHEN g.status = 'disabled' THEN 'disabled'
         ELSE 'maintenance'
       END,
       g.client_visible = 0,
       g.revision = g.revision + 1
 WHERE g.configuration_state <> 'draft'
   AND NOT EXISTS (
     SELECT 1
       FROM game_identity_providers AS p
      WHERE p.game_id = g.game_id
        AND p.enabled = 1
        AND p.app_id IS NOT NULL
        AND p.app_secret IS NOT NULL
   );

-- v4 writers must already be stopped.  The verified checkpoint proves that
-- every legacy identity was copied before either destructive ALTER begins.
SELECT COUNT(*)
  INTO v_accounts_legacy_columns
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'accounts'
   AND column_name IN ('openid', 'unionid');
IF v_accounts_legacy_columns = 2 THEN
  ALTER TABLE accounts
    DROP INDEX uk_openid,
    DROP INDEX uk_unionid,
    DROP COLUMN openid,
    DROP COLUMN unionid;
ELSEIF v_accounts_legacy_columns <> 0 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'v5 accounts legacy schema is partially present';
END IF;

-- The accounts cutover is durable here; game_integrations may still be v4.
SELECT COUNT(*)
  INTO v_integrations_legacy_columns
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'game_integrations'
   AND column_name IN (
     'wechat_app_id',
     'wechat_app_secret',
     'wechat_secret_version',
     'wechat_secret_updated_by',
     'wechat_secret_updated_at',
     'wechat_validation_failed_at',
     'wechat_endpoint',
     'wechat_timeout_ms',
     'wechat_breaker_threshold',
     'wechat_breaker_open_ms'
   );
IF v_integrations_legacy_columns = 10 THEN
  ALTER TABLE game_integrations
    DROP FOREIGN KEY fk_game_integrations_secret_operator,
    DROP INDEX idx_game_integrations_secret_operator,
    DROP CHECK chk_game_integrations_wechat_app_id,
    DROP CHECK chk_game_integrations_wechat_secret,
    DROP CHECK chk_game_integrations_wechat_endpoint,
    DROP CHECK chk_game_integrations_wechat_timeout,
    DROP CHECK chk_game_integrations_wechat_breaker_threshold,
    DROP CHECK chk_game_integrations_wechat_breaker_open,
    DROP COLUMN wechat_app_id,
    DROP COLUMN wechat_app_secret,
    DROP COLUMN wechat_secret_version,
    DROP COLUMN wechat_secret_updated_by,
    DROP COLUMN wechat_secret_updated_at,
    DROP COLUMN wechat_validation_failed_at,
    DROP COLUMN wechat_endpoint,
    DROP COLUMN wechat_timeout_ms,
    DROP COLUMN wechat_breaker_threshold,
    DROP COLUMN wechat_breaker_open_ms;
ELSEIF v_integrations_legacy_columns <> 0 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT =
      'v5 game_integrations legacy schema is partially present';
END IF;

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND (
     (table_name = 'game_identity_providers'
       AND column_name IN (
         'app_secret',
         'secret_version',
         'secret_updated_at',
         'validation_state'
       ))
     OR (table_name = 'account_identities'
       AND column_name IN ('provider_app_id', 'subject'))
     OR (table_name = 'admin_game_audit'
       AND column_name IN ('provider', 'revision', 'request_id', 'result'))
     OR (table_name = 'admin_secret_operations'
       AND column_name IN (
         'provider',
         'revision',
         'request_digest',
         'result_configuration_state',
         'result_revision',
         'result_secret_updated_at'
       ))
     OR (table_name = 'admin_secret_audit'
       AND column_name IN ('provider', 'operation_id', 'revision'))
     OR (table_name = 'login_audit'
       AND column_name IN (
         'provider',
         'request_id',
         'server_id',
         'outcome',
         'provider_latency_ms',
         'provider_version'
       ))
   );
IF v_schema_count <> 25 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'v5 required columns are incomplete';
END IF;

SELECT COUNT(*)
  INTO v_schema_count
  FROM information_schema.table_constraints
 WHERE constraint_schema = DATABASE()
   AND (
     (table_name = 'game_identity_providers'
       AND constraint_name IN (
         'chk_game_identity_providers_secret',
         'chk_game_identity_providers_app_id'
       ))
     OR (table_name = 'account_identities'
       AND constraint_name = 'chk_account_identities_namespace')
     OR (table_name = 'admin_game_audit'
       AND constraint_name IN (
         'chk_admin_game_audit_provider',
         'chk_admin_game_audit_revision',
         'chk_admin_game_audit_request',
         'chk_admin_game_audit_result'
       ))
     OR (table_name = 'admin_secret_operations'
       AND constraint_name IN (
         'chk_admin_secret_operations_kind',
         'chk_admin_secret_operations_action',
         'chk_admin_secret_operations_request_digest',
         'chk_admin_secret_operations_provider_result',
         'chk_admin_secret_operations_target',
         'chk_admin_secret_operations_versions'
       ))
     OR (table_name = 'admin_secret_audit'
       AND constraint_name IN (
         'chk_admin_secret_audit_kind',
         'chk_admin_secret_audit_action',
         'chk_admin_secret_audit_operation_id',
         'chk_admin_secret_audit_target',
         'chk_admin_secret_audit_versions'
       ))
     OR (table_name = 'login_audit'
       AND constraint_name IN (
         'chk_login_audit_provider',
         'chk_login_audit_request',
         'chk_login_audit_outcome',
         'chk_login_audit_provider_latency',
         'chk_login_audit_provider_version'
       ))
   );
IF v_schema_count <> 23 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'v5 required constraints are incomplete';
END IF;

SELECT COUNT(*)
  INTO v_invalid_count
  FROM accounts AS account
 WHERE NOT EXISTS (
   SELECT 1
     FROM account_identities AS identity
    WHERE identity.game_id = account.game_id
      AND identity.user_id = account.user_id
 );
SET v_invalid_count = v_invalid_count
  + IF(
      (SELECT COUNT(*) FROM game_identity_providers)
        = (SELECT COUNT(*) * 2 FROM games),
      0,
      1
    )
  + (
      SELECT COUNT(*)
        FROM games AS game
       WHERE NOT EXISTS (
         SELECT 1
           FROM game_identity_providers AS provider
          WHERE provider.game_id = game.game_id
            AND provider.provider = 'wechat'
       )
          OR NOT EXISTS (
         SELECT 1
           FROM game_identity_providers AS provider
          WHERE provider.game_id = game.game_id
            AND provider.provider = 'douyin'
       )
    );
IF v_invalid_count <> 0 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'v5 final data verification failed';
END IF;

UPDATE schema_v5_identity_migration_state
   SET phase = 'complete'
 WHERE singleton = 1
   AND phase IN ('backfill_verified', 'complete');
SELECT COUNT(*)
  INTO v_checkpoint_count
  FROM schema_v5_identity_migration_state
 WHERE singleton = 1
   AND phase = 'complete';
IF v_checkpoint_count <> 1 THEN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'v5 completion checkpoint is missing';
END IF;

DROP TABLE IF EXISTS schema_v5_identity_migration_errors;
END;

CALL schema_v5_apply_identity_providers();
DROP PROCEDURE schema_v5_apply_identity_providers;
