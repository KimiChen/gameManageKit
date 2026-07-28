CREATE TABLE admin_bootstrap_latch (
  latch_id       TINYINT UNSIGNED NOT NULL,
  initialized    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  initialized_by VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  initialized_at DATETIME(3) NULL,
  PRIMARY KEY (latch_id),
  CONSTRAINT chk_admin_bootstrap_latch_singleton
    CHECK (latch_id = 1),
  CONSTRAINT chk_admin_bootstrap_latch_initialized
    CHECK (initialized IN (0, 1)),
  CONSTRAINT chk_admin_bootstrap_latch_state
    CHECK (
      (
        initialized = 0
        AND initialized_by IS NULL
        AND initialized_at IS NULL
      )
      OR (
        initialized = 1
        AND initialized_by IS NOT NULL
        AND initialized_at IS NOT NULL
      )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO admin_bootstrap_latch
  (latch_id, initialized, initialized_by, initialized_at)
SELECT
  1,
  IF(COUNT(*) = 0, 0, 1),
  MIN(operator_id),
  IF(COUNT(*) = 0, NULL, CURRENT_TIMESTAMP(3))
FROM admin_operators;
