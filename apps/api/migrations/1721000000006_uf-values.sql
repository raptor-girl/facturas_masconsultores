-- 006 — Valores UF y caché controlada (Fase 4)
-- Un valor corresponde exactamente a una fecha. No se crean solicitudes ni
-- se relaciona la UF con folios en esta fase.

-- Up Migration

CREATE TABLE uf_value (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value_date       DATE NOT NULL UNIQUE,
  value            NUMERIC(20,6) NOT NULL CHECK (value > 0),
  source           TEXT NOT NULL CHECK (source IN ('sii.cl', 'mindicador.cl')),
  fetched_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_reference TEXT CHECK (
    source_reference IS NULL OR length(source_reference) <= 500
  ),
  metadata         JSONB CHECK (
    metadata IS NULL OR jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX uf_value_fetched_at_idx ON uf_value (fetched_at DESC);

CREATE TRIGGER uf_value_set_updated_at
  BEFORE UPDATE ON uf_value
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN uf_value.value IS
  'Valor decimal exacto; PostgreSQL y los contratos lo transportan como string.';
COMMENT ON COLUMN uf_value.source_reference IS
  'Referencia pública minimizada. Nunca contiene HTML ni respuestas externas completas.';

GRANT SELECT, INSERT, UPDATE ON uf_value TO factuflow_app;
REVOKE DELETE, TRUNCATE ON uf_value FROM factuflow_app;
REVOKE ALL ON uf_value FROM PUBLIC;

-- Down Migration

DROP TABLE IF EXISTS uf_value;
