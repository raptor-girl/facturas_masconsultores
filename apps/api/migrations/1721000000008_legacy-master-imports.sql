-- 008 — Importador controlado de maestros legacy (Fase 6)
-- No importa solicitudes, folios, usuarios, sesiones, contraseñas ni archivos.
-- Estas tablas registran corridas, decisiones por fila y mapeos legacy→V1.

-- Up Migration

CREATE TABLE legacy_master_import_run (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  idempotency_key   TEXT NOT NULL CHECK (length(btrim(idempotency_key)) >= 16),
  mode              TEXT NOT NULL CHECK (mode IN ('PREVIEW', 'APPLY')),
  status            TEXT NOT NULL CHECK (status IN ('PREVIEWED', 'APPLIED', 'REJECTED')),
  source_name       TEXT NOT NULL CHECK (length(btrim(source_name)) > 0),
  source_sha256     TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  payload_hash      TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  summary           JSONB NOT NULL,
  request_id        TEXT,
  ip                TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX legacy_master_import_run_created_idx
  ON legacy_master_import_run (created_at DESC);
CREATE INDEX legacy_master_import_run_source_idx
  ON legacy_master_import_run (source_name, source_sha256);

CREATE TABLE legacy_master_import_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES legacy_master_import_run(id) ON DELETE CASCADE,
  entity        TEXT NOT NULL CHECK (entity IN (
    'issuer_company',
    'coordinator_profile',
    'client',
    'client_invoice_rule',
    'receiver',
    'product',
    'project_center'
  )),
  row_number    INTEGER NOT NULL CHECK (row_number > 0),
  external_id   TEXT,
  operation     TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'NOOP', 'ERROR')),
  target_id     UUID,
  issues        JSONB NOT NULL DEFAULT '[]'::jsonb,
  changes_before JSONB,
  changes_after  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX legacy_master_import_item_run_idx
  ON legacy_master_import_item (run_id, entity, row_number);
CREATE INDEX legacy_master_import_item_target_idx
  ON legacy_master_import_item (entity, target_id);

CREATE TABLE legacy_master_import_mapping (
  entity       TEXT NOT NULL CHECK (entity IN (
    'issuer_company',
    'coordinator_profile',
    'client',
    'receiver',
    'product',
    'project_center'
  )),
  source_name  TEXT NOT NULL CHECK (length(btrim(source_name)) > 0),
  external_id  TEXT NOT NULL CHECK (length(btrim(external_id)) > 0),
  target_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, source_name, external_id)
);

CREATE INDEX legacy_master_import_mapping_target_idx
  ON legacy_master_import_mapping (entity, target_id);

COMMENT ON TABLE legacy_master_import_run IS
  'Corridas idempotentes de preview/apply del importador controlado de maestros legacy.';
COMMENT ON TABLE legacy_master_import_item IS
  'Decisiones por fila del importador; no almacena archivos fuente completos.';
COMMENT ON TABLE legacy_master_import_mapping IS
  'Relación estable entre IDs legacy y maestros V1. No aplica a usuarios ni solicitudes.';

GRANT SELECT, INSERT ON
  legacy_master_import_run, legacy_master_import_item, legacy_master_import_mapping
TO factuflow_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  legacy_master_import_run, legacy_master_import_item, legacy_master_import_mapping
FROM factuflow_app;

REVOKE ALL ON
  legacy_master_import_run, legacy_master_import_item, legacy_master_import_mapping
FROM PUBLIC;

-- Down Migration

DROP TABLE IF EXISTS legacy_master_import_mapping;
DROP TABLE IF EXISTS legacy_master_import_item;
DROP TABLE IF EXISTS legacy_master_import_run;
