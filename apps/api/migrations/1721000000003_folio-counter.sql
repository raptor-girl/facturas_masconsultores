-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — Contador de folios
--
-- Alcance Fase 1: el contador queda TÉCNICAMENTE PREPARADO. No se crea ninguna
-- solicitud: `invoice_request` no existe todavía y está fuera de esta fase.
--
-- Dos defectos conocidos que esta migración deja resueltos de raíz:
--
--   T-07 — CORREGIDO CON EVIDENCIA (back.zip, src/utils/folio.js). El legado
--          NO usaba COUNT(*) como decía la documentación: hacía
--          `SELECT folio ... LIKE 'SF-2026-%'`, traía TODOS los folios del año
--          a memoria y calculaba MAX+1 en JavaScript, sin bloqueo alguno. Dos
--          exportaciones concurrentes leen el mismo máximo y generan el mismo
--          folio. Además usaba `new Date().getFullYear()` — el año ACTUAL, no
--          el de la solicitud. Ambos defectos desaparecen con un contador con
--          bloqueo de fila.
--
--   T-01 — el contador arranca en 0 para 2026, pero los folios legados
--          SF-2026-000xx ya existen y migran con UNIQUE. La primera
--          exportación nueva colisionaría. Por eso existe seed_folio_counter(),
--          que la migración de datos (Fase 6) debe invocar. Nunca retrocede.
-- ═══════════════════════════════════════════════════════════════════════════

-- Up Migration

CREATE TABLE folio_counter (
  year       INTEGER PRIMARY KEY CHECK (year BETWEEN 2000 AND 2999),
  last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE folio_counter IS
  'Un contador por año. Formato del folio: SF-AAAA-00001 (ver domain/folio). '
  'Los folios de solicitudes anuladas NO se liberan ni se reutilizan (§7 de negocio).';
COMMENT ON COLUMN folio_counter.last_value IS
  'Último correlativo entregado. Se siembra desde MAX(folio) legado por año '
  'durante la migración de datos (T-01), no en esta fase.';

-- ── Reserva atómica ────────────────────────────────────────────────────────
-- SECURITY DEFINER: corre con los permisos del owner. Así factuflow_app puede
-- reservar un folio sin tener UPDATE sobre folio_counter — es decir, no puede
-- manipular el contador por fuera de esta función.
--
-- El ON CONFLICT DO UPDATE toma un bloqueo de fila: dos transacciones
-- concurrentes se serializan y ninguna obtiene el mismo número. Devuelve 1 en
-- la primera reserva del año y sigue desde ahí.
--
-- ⚠️ ORDEN DE USO (T-08/R-06) — JUSTIFICACIÓN CORREGIDA CON EVIDENCIA.
-- La versión anterior de este comentario afirmaba que el folio se reserva antes
-- de generar el Excel «porque va impreso en el documento». **Eso era falso.**
-- La inspección de back.zip (src/services/exportador.js y routes/exportaciones.js)
-- demuestra que el folio NO aparece en el contenido del Excel ni en el nombre
-- del archivo (`Solicitud_factura_{CLIENTE}_{MES}.xlsx`).
--
-- La razón correcta, que sigue siendo válida, es transaccional: por D-03 la
-- solicitud existe sólo si el Excel se generó bien, así que reserva y
-- generación deben ocurrir en la MISMA transacción. Si la generación falla,
-- ROLLBACK y el folio no se consume. Ver docs/EXCEL_LEGACY_BEHAVIOR.md.
CREATE FUNCTION reserve_folio(p_year INTEGER)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO folio_counter AS fc (year, last_value)
  VALUES (p_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_value = fc.last_value + 1,
        updated_at = now()
  RETURNING fc.last_value;
$$;

COMMENT ON FUNCTION reserve_folio(INTEGER) IS
  'Reserva atómica del siguiente correlativo del año. Nunca produce huecos ni '
  'duplicados bajo concurrencia. Reservar ANTES de generar el Excel (T-08).';

-- ── Siembra desde el legado (T-01) ─────────────────────────────────────────
-- GREATEST() hace que el contador nunca retroceda: ejecutarla dos veces, o con
-- un valor menor al actual, es inofensivo. Idempotente a propósito, porque una
-- migración de datos se reintenta.
--
-- NO se otorga EXECUTE a factuflow_app: sembrar es una operación de migración,
-- no de aplicación.
CREATE FUNCTION seed_folio_counter(p_year INTEGER, p_last_value INTEGER)
RETURNS INTEGER
LANGUAGE sql
AS $$
  INSERT INTO folio_counter AS fc (year, last_value)
  VALUES (p_year, p_last_value)
  ON CONFLICT (year) DO UPDATE
    SET last_value = GREATEST(fc.last_value, EXCLUDED.last_value),
        updated_at = now()
  RETURNING fc.last_value;
$$;

COMMENT ON FUNCTION seed_folio_counter(INTEGER, INTEGER) IS
  'Siembra el contador desde MAX(folio) legado por año (T-01). Idempotente y '
  'monótona: nunca retrocede. La invoca la migración de datos (Fase 6), en la '
  'misma transacción que importa las solicitudes. Solo factuflow_owner.';

-- ── Permisos ───────────────────────────────────────────────────────────────
-- La aplicación LEE el contador y EJECUTA la reserva. No lo escribe directamente.
GRANT SELECT ON folio_counter TO factuflow_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON folio_counter FROM factuflow_app;

REVOKE ALL ON FUNCTION reserve_folio(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_folio(INTEGER) TO factuflow_app;

-- Sembrar es privilegio del owner: la aplicación no puede mover el contador.
REVOKE ALL ON FUNCTION seed_folio_counter(INTEGER, INTEGER) FROM PUBLIC;

REVOKE ALL ON folio_counter FROM PUBLIC;

-- Down Migration

DROP FUNCTION IF EXISTS seed_folio_counter(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS reserve_folio(INTEGER);
DROP TABLE IF EXISTS folio_counter;
