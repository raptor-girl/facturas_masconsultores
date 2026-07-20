-- ═══════════════════════════════════════════════════════════════════════════
-- 001 — Extensiones, permisos de esquema y utilidades
--
-- Se ejecuta con el rol `factuflow_owner`, NUNCA con `factuflow_app`.
-- Ver DATABASE_DESIGN.md §0 y SECURITY_AND_TRACEABILITY.md §6 (T-12, T-13).
--
-- Los roles `factuflow_owner` y `factuflow_app` NO se crean aquí: los crea el
-- bootstrap del contenedor de PostgreSQL (infra/docker/postgres-initdb), que
-- corre como superusuario. Una migración no debería necesitar superusuario.
-- ═══════════════════════════════════════════════════════════════════════════

-- Up Migration

-- citext: comparación insensible a mayúsculas para correos y códigos.
-- ⚠️ ACLARACIÓN (C-20): citext NO normaliza tildes ('é' ≠ 'e'). No sirve como
-- control de duplicados por acento. El control real contra duplicados de
-- empresa emisora es UNIQUE (tax_id) sobre el RUT, no el código.
-- En PostgreSQL 13+ citext es una extensión «trusted»: el dueño de la base
-- puede crearla sin ser superusuario.
CREATE EXTENSION IF NOT EXISTS citext;

-- gen_random_uuid() es parte del core desde PostgreSQL 13. No se requiere pgcrypto.

-- ── Permisos de esquema ────────────────────────────────────────────────────
-- Explícito aunque PostgreSQL 15+ ya restringe `public` por defecto: el
-- objetivo es que el permiso quede escrito, no heredado de un default que
-- podría cambiar entre versiones.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO factuflow_app;

-- factuflow_app puede LEER y ESCRIBIR filas, pero nunca CREAR objetos.
-- Sin esto, un `CREATE TABLE` desde la aplicación sería posible.
REVOKE CREATE ON SCHEMA public FROM factuflow_app;

-- ── Utilidad: updated_at automático (T-11) ─────────────────────────────────
-- El diseño declaraba `updated_at` en varias tablas pero no definía qué lo
-- actualizaba. Una columna que promete algo que nadie cumple es peor que no
-- tenerla: parece auditable y no lo es.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger BEFORE UPDATE: mantiene updated_at. Ver DATABASE_DESIGN.md (T-11).';

-- Down Migration

DROP FUNCTION IF EXISTS set_updated_at();
REVOKE USAGE ON SCHEMA public FROM factuflow_app;
-- La extensión citext NO se elimina: otras migraciones dependen de ella y
-- quitarla rompería columnas existentes. Un `down` no debe ser destructivo
-- con algo compartido.
