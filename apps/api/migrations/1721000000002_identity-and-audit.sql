-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — Identidad, sesiones y auditoría append-only
--
-- Alcance Fase 1: SOLO las tablas de fundación. Nada de solicitudes, clientes,
-- receptores, CP/MS ni productos — están fuera de la aprobación.
--
-- ⚠️ Esta migración NO inserta ningún usuario. La creación del ADMIN inicial
-- está bloqueada por D-08: los 5 coordinadores no tienen correo registrado y
-- `email` es NOT NULL. Ver DECISIONS_REQUIRED.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- Up Migration

-- ── Catálogo de roles ──────────────────────────────────────────────────────
-- Se llama `app_role` y no `role` para no chocar con el concepto de ROLE de
-- PostgreSQL, que aquí significa otra cosa (factuflow_owner / factuflow_app).
CREATE TABLE app_role (
  code  TEXT PRIMARY KEY CHECK (code IN ('ADMIN', 'COORDINATOR')),
  label TEXT NOT NULL
);

COMMENT ON TABLE app_role IS
  'Roles de aplicación. Una persona puede tener ambos (§5 de negocio).';

INSERT INTO app_role (code, label) VALUES
  ('ADMIN', 'Administrador'),
  ('COORDINATOR', 'Coordinador');

-- ── Usuarios ───────────────────────────────────────────────────────────────
CREATE TABLE app_user (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             TEXT   NOT NULL CHECK (length(btrim(full_name)) > 0),
  email                 CITEXT NOT NULL UNIQUE,
  username              CITEXT UNIQUE,
  password_hash         TEXT   NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT true,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_user IS
  'Cuentas individuales. Sin cuentas compartidas (regla de negocio confirmada). '
  'Ningún password_hash del sistema anterior se migra jamás.';
COMMENT ON COLUMN app_user.password_hash IS
  'argon2id. Nunca se expone en ninguna respuesta HTTP, ni siquiera a ADMIN.';
COMMENT ON COLUMN app_user.must_change_password IS
  'true al crear: el primer login exige cambio antes de cualquier otra acción.';

CREATE TRIGGER app_user_set_updated_at
  BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Asignación de roles ────────────────────────────────────────────────────
CREATE TABLE app_user_role (
  app_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_code   TEXT NOT NULL REFERENCES app_role(code),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_user_id, role_code)
);

-- ── Sesiones ───────────────────────────────────────────────────────────────
-- R-11: tokens opacos del servidor, NO JWT. Se guarda solo el hash del token;
-- el token en claro jamás toca la base. Ventaja concreta sobre JWT: la
-- revocación es inmediata y real, que es justo lo que la auditoría exige.
-- ⚠️ C-22: no existe ninguna «clave de firma de sesión». Si aparece una
-- variable SESSION_SIGNING_KEY en algún entorno, es un residuo: eliminarla.
CREATE TABLE app_session (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  ip          INET,
  user_agent  TEXT,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX app_session_user_idx    ON app_session (app_user_id);
CREATE INDEX app_session_expires_idx ON app_session (expires_at);

COMMENT ON COLUMN app_session.token_hash IS
  'SHA-256 del token opaco. El token reutilizable NUNCA se persiste (§7 del plan).';

-- ── Intentos de login → RETIRADA DE LA FASE 1 ──────────────────────────────
-- La tabla `login_attempt` existía en la versión anterior de esta migración,
-- pero NO está en la lista de tablas aprobadas para la Fase 1
-- (role, app_user, app_user_role, app_session, audit_event, folio_counter).
--
-- Se retira por disciplina de alcance: sólo tiene sentido junto al bloqueo por
-- N intentos fallidos, que es autenticación (Fase 2). Crearla ahora sería
-- adelantar una decisión de retención (D-11) que nadie tomó.
-- Se reintroduce en la Fase 2, junto al login real.

-- ── Auditoría (append-only) ────────────────────────────────────────────────
CREATE TABLE audit_event (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_user_id    UUID REFERENCES app_user(id),
  actor_roles    TEXT[],
  action         TEXT NOT NULL,
  entity         TEXT NOT NULL,
  entity_id      UUID,
  result         TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  request_id     TEXT,
  ip             INET,
  user_agent     TEXT,
  reason         TEXT,
  changes_before JSONB,
  changes_after  JSONB,
  metadata       JSONB
);

CREATE INDEX audit_event_occurred_idx ON audit_event (occurred_at DESC);
CREATE INDEX audit_event_entity_idx   ON audit_event (entity, entity_id);
CREATE INDEX audit_event_user_idx     ON audit_event (app_user_id);

COMMENT ON TABLE audit_event IS
  'Append-only. La propiedad NO la da esta tabla: la dan los permisos de abajo '
  '(factuflow_app sin UPDATE ni DELETE) más la prueba de guardia que lo '
  'verifica contra PostgreSQL real. Sin ambos, «append-only» es una intención.';
COMMENT ON COLUMN audit_event.app_user_id IS
  'NULL para eventos del sistema (no de una persona). Por eso no es NOT NULL.';
COMMENT ON COLUMN audit_event.changes_before IS
  'Minimizado: nunca password_hash, tokens ni datos personales innecesarios.';

-- ═══════════════════════════════════════════════════════════════════════════
-- PERMISOS — el corazón de T-13
--
-- factuflow_app NO es dueño de ninguna tabla. Sus permisos son explícitos,
-- tabla por tabla. La ausencia de UPDATE/DELETE sobre audit_event no es un
-- olvido: es el control.
-- ═══════════════════════════════════════════════════════════════════════════

-- Catálogo: solo lectura.
GRANT SELECT ON app_role TO factuflow_app;

-- Operación normal sobre identidad.
GRANT SELECT, INSERT, UPDATE          ON app_user      TO factuflow_app;
GRANT SELECT, INSERT, DELETE          ON app_user_role TO factuflow_app;
GRANT SELECT, INSERT, UPDATE          ON app_session   TO factuflow_app;

-- Auditoría: INSERT y SELECT. Nada más. Jamás.
GRANT SELECT, INSERT ON audit_event TO factuflow_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM factuflow_app;

-- Cinturón y tirantes: PUBLIC no tiene nada sobre estas tablas.
REVOKE ALL ON app_role, app_user, app_user_role, app_session, audit_event
  FROM PUBLIC;

-- Down Migration

DROP TABLE IF EXISTS audit_event;
DROP TABLE IF EXISTS app_session;
DROP TABLE IF EXISTS app_user_role;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS app_role;
