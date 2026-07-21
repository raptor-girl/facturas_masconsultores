-- 007 — Solicitudes de factura exportadas y XLSX inmutable (Fase 5)
--
-- Una solicitud nace únicamente cuando el XLSX ya fue generado y validado en
-- memoria. No existen borradores ni estados intermedios. Solicitud, líneas,
-- receptores, archivo, auditoría y reserva de folio se confirman en una sola
-- transacción PostgreSQL.

-- Up Migration

CREATE TABLE invoice_request (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio                           TEXT NOT NULL UNIQUE
                                  CHECK (folio ~ '^SF-[0-9]{4}-[0-9]{5}$'),
  status                          TEXT NOT NULL DEFAULT 'EXPORTED'
                                  CHECK (status = 'EXPORTED'),
  source_request_id               UUID REFERENCES invoice_request(id),
  idempotency_key                 TEXT NOT NULL
                                  CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,200}$'),
  payload_hash                    TEXT NOT NULL
                                  CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

  client_id                       UUID NOT NULL REFERENCES client(id),
  issuer_company_id               UUID NOT NULL REFERENCES issuer_company(id),
  coordinator_profile_id          UUID NOT NULL REFERENCES coordinator_profile(id),
  period                          TEXT NOT NULL
                                  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  request_date                    DATE NOT NULL,
  billing_date                    DATE NOT NULL,
  uf_date                         DATE NOT NULL,
  uf_value                        NUMERIC(20,6) NOT NULL CHECK (uf_value > 0),
  uf_source                       TEXT NOT NULL CHECK (uf_source IN ('sii.cl', 'mindicador.cl')),
  tax_treatment                   TEXT NOT NULL CHECK (tax_treatment IN ('AFFECTED', 'EXEMPT')),
  iva_rate                        NUMERIC(5,4) NOT NULL CHECK (iva_rate >= 0 AND iva_rate <= 1),
  net_clp                         NUMERIC(30,0) NOT NULL CHECK (net_clp >= 0),
  iva_clp                         NUMERIC(30,0) NOT NULL CHECK (iva_clp >= 0),
  total_clp                       NUMERIC(30,0) NOT NULL CHECK (total_clp = net_clp + iva_clp),

  area                            TEXT NOT NULL DEFAULT 'Plataformas'
                                  CHECK (area = 'Plataformas'),
  purchase_order_number           TEXT CHECK (purchase_order_number IS NULL OR length(purchase_order_number) <= 200),
  contract_number                 TEXT CHECK (contract_number IS NULL OR length(contract_number) <= 200),
  hes_number                      TEXT CHECK (hes_number IS NULL OR length(hes_number) <= 200),
  supplier_number                 TEXT CHECK (supplier_number IS NULL OR length(supplier_number) <= 200),
  description                     TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  observations                    TEXT CHECK (observations IS NULL OR length(observations) <= 4000),

  calculation_algorithm_version   TEXT NOT NULL CHECK (calculation_algorithm_version = 'LEGACY_V1'),
  excel_template_variant          TEXT NOT NULL CHECK (excel_template_variant IN ('STANDARD', 'HABITAT')),
  excel_template_version          TEXT NOT NULL CHECK (length(btrim(excel_template_version)) > 0),

  client_snapshot                 JSONB NOT NULL CHECK (jsonb_typeof(client_snapshot) = 'object'),
  issuer_company_snapshot         JSONB NOT NULL CHECK (jsonb_typeof(issuer_company_snapshot) = 'object'),
  coordinator_snapshot            JSONB NOT NULL CHECK (jsonb_typeof(coordinator_snapshot) = 'object'),
  invoice_rule_snapshot           JSONB NOT NULL CHECK (jsonb_typeof(invoice_rule_snapshot) = 'object'),

  exported_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                      UUID NOT NULL REFERENCES app_user(id),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (created_by, idempotency_key),
  CHECK (exported_at >= created_at),
  CHECK (
    (tax_treatment = 'EXEMPT' AND iva_rate = 0 AND iva_clp = 0)
    OR (tax_treatment = 'AFFECTED' AND iva_rate > 0)
  )
);

CREATE INDEX invoice_request_exported_idx ON invoice_request (exported_at DESC, id DESC);
CREATE INDEX invoice_request_client_idx ON invoice_request (client_id, exported_at DESC);
CREATE INDEX invoice_request_coordinator_idx
  ON invoice_request (coordinator_profile_id, exported_at DESC);
CREATE INDEX invoice_request_source_idx
  ON invoice_request (source_request_id) WHERE source_request_id IS NOT NULL;

CREATE TABLE invoice_request_line (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_request_id    UUID NOT NULL REFERENCES invoice_request(id),
  position              INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  project_center_id     UUID NOT NULL REFERENCES project_center(id),
  project_center_code   TEXT NOT NULL CHECK (length(btrim(project_center_code)) > 0),
  project_name          TEXT NOT NULL CHECK (length(btrim(project_name)) > 0),
  project_center_type   TEXT NOT NULL CHECK (project_center_type IN (
    'ADMINISTRATION_OPERATION', 'DEVELOPMENT_HOURS', 'CONSTRUCTION'
  )),
  product_id            UUID NOT NULL REFERENCES product(id),
  product_code          TEXT,
  product_name          TEXT NOT NULL CHECK (length(btrim(product_name)) > 0),
  uf_amount             NUMERIC(30,6) NOT NULL CHECK (uf_amount > 0),
  uf_value              NUMERIC(20,6) NOT NULL CHECK (uf_value > 0),
  clp_amount            NUMERIC(30,0) NOT NULL CHECK (clp_amount >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_request_id, position),
  UNIQUE (invoice_request_id, project_center_id)
);

CREATE INDEX invoice_request_line_request_idx
  ON invoice_request_line (invoice_request_id, position);

CREATE TABLE invoice_request_receiver (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_request_id    UUID NOT NULL REFERENCES invoice_request(id),
  position              INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  receiver_id           UUID REFERENCES receiver(id),
  display_name          TEXT CHECK (display_name IS NULL OR length(display_name) <= 200),
  email                 CITEXT NOT NULL CHECK (length(btrim(email::text)) BETWEEN 3 AND 320),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_request_id, position),
  UNIQUE (invoice_request_id, email)
);

CREATE INDEX invoice_request_receiver_request_idx
  ON invoice_request_receiver (invoice_request_id, position);

CREATE TABLE invoice_export (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_request_id    UUID NOT NULL UNIQUE REFERENCES invoice_request(id),
  content               BYTEA NOT NULL CHECK (octet_length(content) > 0),
  filename              TEXT NOT NULL CHECK (
    length(filename) BETWEEN 6 AND 240
    AND filename !~ '[\r\n]'
    AND filename ~ '\.xlsx$'
  ),
  mime_type             TEXT NOT NULL
                        CHECK (mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  size_bytes            BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256                TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  template_variant      TEXT NOT NULL CHECK (template_variant IN ('STANDARD', 'HABITAT')),
  template_version      TEXT NOT NULL CHECK (length(btrim(template_version)) > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (size_bytes = octet_length(content))
);

CREATE INDEX invoice_export_sha_idx ON invoice_export (sha256);

COMMENT ON TABLE invoice_request IS
  'Registro inmutable que existe sólo después de exportar. Estado único: EXPORTED.';
COMMENT ON COLUMN invoice_request.idempotency_key IS
  'Clave opaca por usuario. No contiene cookie, CSRF ni datos de sesión.';
COMMENT ON COLUMN invoice_request.client_snapshot IS
  'Snapshot JSONB versionado y validado por contrato; los maestros posteriores no alteran historia.';
COMMENT ON COLUMN invoice_request.uf_value IS
  'Valor exacto transportado como string por PostgreSQL y por la API.';
COMMENT ON TABLE invoice_export IS
  'Bytes XLSX exactos devueltos al crear y en cada descarga posterior; nunca una ruta local.';

GRANT SELECT, INSERT ON
  invoice_request, invoice_request_line, invoice_request_receiver, invoice_export
TO factuflow_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  invoice_request, invoice_request_line, invoice_request_receiver, invoice_export
FROM factuflow_app;

REVOKE ALL ON
  invoice_request, invoice_request_line, invoice_request_receiver, invoice_export
FROM PUBLIC;

-- Down Migration

DROP TABLE IF EXISTS invoice_export;
DROP TABLE IF EXISTS invoice_request_receiver;
DROP TABLE IF EXISTS invoice_request_line;
DROP TABLE IF EXISTS invoice_request;
