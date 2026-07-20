-- 004 — Autenticación, bloqueo, sesiones opacas e intentos de acceso
--
-- Esta migración es exclusivamente de Fase 2. No crea usuarios ni incorpora
-- datos del sistema anterior. Las sesiones anteriores al nuevo contrato se
-- revocan porque no tenían token CSRF ni expiración por inactividad.

-- Up Migration

INSERT INTO app_role (code, label) VALUES
  ('ADMIN', 'Administrador'),
  ('COORDINATOR', 'Coordinador')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

ALTER TABLE app_user RENAME COLUMN full_name TO display_name;
ALTER TABLE app_user
  ALTER COLUMN username SET NOT NULL,
  ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN failed_login_window_started_at TIMESTAMPTZ,
  ADD COLUMN locked_until TIMESTAMPTZ,
  ADD COLUMN last_login_at TIMESTAMPTZ,
  ADD COLUMN password_changed_at TIMESTAMPTZ,
  ADD COLUMN created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT app_user_failed_login_count_check CHECK (failed_login_count >= 0),
  ADD CONSTRAINT app_user_username_not_blank_check CHECK (length(btrim(username::text)) > 0),
  ADD CONSTRAINT app_user_email_not_blank_check CHECK (length(btrim(email::text)) > 0);

COMMENT ON COLUMN app_user.display_name IS 'Nombre visible de la cuenta; no es un perfil operativo.';
COMMENT ON COLUMN app_user.created_by IS 'ADMIN que creó la cuenta. NULL sólo para el bootstrap inicial.';
COMMENT ON COLUMN app_user.password_changed_at IS
  'NULL mientras la contraseña sea temporal y must_change_password permanezca true.';

ALTER TABLE app_session DROP CONSTRAINT app_session_check;
ALTER TABLE app_session DROP CONSTRAINT app_session_check1;
ALTER TABLE app_session RENAME COLUMN issued_at TO created_at;
ALTER TABLE app_session RENAME COLUMN expires_at TO absolute_expires_at;
ALTER TABLE app_session
  ADD COLUMN csrf_token_hash TEXT,
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN idle_expires_at TIMESTAMPTZ,
  ADD COLUMN revoked_reason TEXT;

UPDATE app_session
SET csrf_token_hash = encode(sha256((id::text || random()::text)::bytea), 'hex'),
    last_seen_at = created_at,
    idle_expires_at = LEAST(absolute_expires_at, created_at + interval '8 hours'),
    revoked_at = COALESCE(revoked_at, now()),
    revoked_reason = COALESCE(revoked_reason, 'SCHEMA_UPGRADE');

ALTER TABLE app_session
  ALTER COLUMN csrf_token_hash SET NOT NULL,
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN idle_expires_at SET NOT NULL,
  ADD CONSTRAINT app_session_csrf_hash_format_check CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT app_session_token_hash_format_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT app_session_absolute_expiry_check CHECK (absolute_expires_at > created_at),
  ADD CONSTRAINT app_session_idle_expiry_check CHECK (idle_expires_at > created_at),
  ADD CONSTRAINT app_session_idle_before_absolute_check CHECK (idle_expires_at <= absolute_expires_at),
  ADD CONSTRAINT app_session_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  ADD CONSTRAINT app_session_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'LOGOUT', 'SESSION_REVOKED', 'REVOKE_OTHERS', 'PASSWORD_CHANGED',
      'PASSWORD_RESET', 'USER_DEACTIVATED', 'EXPIRED', 'ADMIN_REVOKED',
      'SCHEMA_UPGRADE'
    )
  ),
  ADD CONSTRAINT app_session_revocation_consistency_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  );

DROP INDEX app_session_expires_idx;
CREATE INDEX app_session_active_user_idx
  ON app_session (app_user_id, idle_expires_at, absolute_expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX app_session_expiry_idx
  ON app_session (LEAST(idle_expires_at, absolute_expires_at))
  WHERE revoked_at IS NULL;

COMMENT ON COLUMN app_session.token_hash IS 'SHA-256 del token opaco. El token nunca se persiste.';
COMMENT ON COLUMN app_session.csrf_token_hash IS 'SHA-256 del token CSRF asociado a la sesión.';
COMMENT ON COLUMN app_session.last_seen_at IS
  'Actividad persistida con throttling; no se actualiza en cada request.';

CREATE TABLE login_attempt (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  identifier_hash TEXT NOT NULL CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),
  app_user_id     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  succeeded       BOOLEAN NOT NULL,
  failure_reason  TEXT,
  request_id      TEXT,
  ip              INET,
  user_agent      TEXT,
  CHECK (
    (succeeded AND failure_reason IS NULL)
    OR (NOT succeeded AND failure_reason IN (
      'INVALID_CREDENTIALS', 'INACTIVE', 'LOCKED'
    ))
  )
);

CREATE INDEX login_attempt_identifier_idx ON login_attempt (identifier_hash, attempted_at DESC);
CREATE INDEX login_attempt_user_idx ON login_attempt (app_user_id, attempted_at DESC)
  WHERE app_user_id IS NOT NULL;
CREATE INDEX login_attempt_retention_idx ON login_attempt (attempted_at);

COMMENT ON TABLE login_attempt IS
  'Intentos mínimos de autenticación. No guarda contraseña ni request body. '
  'Retención operativa: 90 días; la purga la ejecuta mantenimiento con el rol owner.';

GRANT SELECT, INSERT ON login_attempt TO factuflow_app;
REVOKE UPDATE, DELETE, TRUNCATE ON login_attempt FROM factuflow_app;
REVOKE ALL ON login_attempt FROM PUBLIC;

-- Down Migration

REVOKE ALL ON login_attempt FROM factuflow_app;
DROP TABLE IF EXISTS login_attempt;

DROP INDEX IF EXISTS app_session_expiry_idx;
DROP INDEX IF EXISTS app_session_active_user_idx;

ALTER TABLE app_session
  DROP CONSTRAINT app_session_revocation_consistency_check,
  DROP CONSTRAINT app_session_revoked_reason_check,
  DROP CONSTRAINT app_session_revoked_at_check,
  DROP CONSTRAINT app_session_idle_before_absolute_check,
  DROP CONSTRAINT app_session_idle_expiry_check,
  DROP CONSTRAINT app_session_absolute_expiry_check,
  DROP CONSTRAINT app_session_token_hash_format_check,
  DROP CONSTRAINT app_session_csrf_hash_format_check,
  DROP COLUMN revoked_reason,
  DROP COLUMN idle_expires_at,
  DROP COLUMN last_seen_at,
  DROP COLUMN csrf_token_hash;

ALTER TABLE app_session RENAME COLUMN absolute_expires_at TO expires_at;
ALTER TABLE app_session RENAME COLUMN created_at TO issued_at;
ALTER TABLE app_session
  ADD CONSTRAINT app_session_check CHECK (expires_at > issued_at),
  ADD CONSTRAINT app_session_check1 CHECK (revoked_at IS NULL OR revoked_at >= issued_at);
CREATE INDEX app_session_expires_idx ON app_session (expires_at);

ALTER TABLE app_user
  DROP CONSTRAINT app_user_email_not_blank_check,
  DROP CONSTRAINT app_user_username_not_blank_check,
  DROP CONSTRAINT app_user_failed_login_count_check,
  DROP COLUMN created_by,
  DROP COLUMN password_changed_at,
  DROP COLUMN last_login_at,
  DROP COLUMN locked_until,
  DROP COLUMN failed_login_window_started_at,
  DROP COLUMN failed_login_count,
  ALTER COLUMN username DROP NOT NULL;
ALTER TABLE app_user RENAME COLUMN display_name TO full_name;
