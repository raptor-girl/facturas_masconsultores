-- 005 — Maestros de facturación (Fase 3)
-- No inserta datos reales ni catálogos de negocio. Los valores técnicos se
-- controlan mediante CHECK para que backend y OpenAPI compartan el contrato.

-- Up Migration

CREATE TABLE issuer_company (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  CITEXT NOT NULL UNIQUE CHECK (length(btrim(code::text)) > 0),
  legal_name            TEXT NOT NULL CHECK (length(btrim(legal_name)) > 0),
  tax_id                TEXT NOT NULL UNIQUE CHECK (tax_id ~ '^[0-9]{7,8}[0-9K]$'),
  business_activity     TEXT NOT NULL CHECK (length(btrim(business_activity)) > 0),
  address               TEXT NOT NULL CHECK (length(btrim(address)) > 0),
  is_active             BOOLEAN NOT NULL DEFAULT true,
  default_tax_treatment TEXT NOT NULL CHECK (default_tax_treatment IN ('AFFECTED', 'EXEMPT')),
  default_iva_rate      NUMERIC(5,4) NOT NULL CHECK (default_iva_rate >= 0 AND default_iva_rate <= 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE TRIGGER issuer_company_set_updated_at
  BEFORE UPDATE ON issuer_company
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE coordinator_profile (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id  UUID UNIQUE REFERENCES app_user(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  email        CITEXT CHECK (email IS NULL OR length(btrim(email::text)) > 0),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE INDEX coordinator_profile_active_name_idx
  ON coordinator_profile (is_active, display_name);
CREATE TRIGGER coordinator_profile_set_updated_at
  BEFORE UPDATE ON coordinator_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_name                     CITEXT NOT NULL UNIQUE CHECK (length(btrim(short_name::text)) > 0),
  legal_name                     TEXT,
  tax_id                         TEXT UNIQUE CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{7,8}[0-9K]$'),
  business_activity              TEXT,
  address                        TEXT,
  default_coordinator_profile_id UUID REFERENCES coordinator_profile(id) ON DELETE SET NULL,
  data_status                    TEXT NOT NULL CHECK (data_status IN ('COMPLETE', 'PENDING_COMPLETION')),
  is_active                     BOOLEAN NOT NULL DEFAULT true,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by                    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT client_complete_data_check CHECK (
    data_status = 'PENDING_COMPLETION'
    OR (
      tax_id IS NOT NULL
      AND legal_name IS NOT NULL AND length(btrim(legal_name)) > 0
      AND business_activity IS NOT NULL AND length(btrim(business_activity)) > 0
      AND address IS NOT NULL AND length(btrim(address)) > 0
    )
  )
);

CREATE INDEX client_search_idx ON client (short_name, legal_name, tax_id);
CREATE INDEX client_active_idx ON client (is_active, data_status);
CREATE TRIGGER client_set_updated_at
  BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client_invoice_rule (
  client_id                   UUID PRIMARY KEY REFERENCES client(id) ON DELETE CASCADE,
  purchase_order_requirement  TEXT NOT NULL CHECK (purchase_order_requirement IN ('REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE')),
  hes_requirement             TEXT NOT NULL CHECK (hes_requirement IN ('REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE')),
  contract_requirement        TEXT NOT NULL CHECK (contract_requirement IN ('REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE')),
  supplier_number             TEXT,
  default_issuer_company_id   UUID REFERENCES issuer_company(id) ON DELETE SET NULL,
  default_tax_treatment       TEXT CHECK (default_tax_treatment IS NULL OR default_tax_treatment IN ('AFFECTED', 'EXEMPT')),
  excel_template_variant      TEXT NOT NULL CHECK (excel_template_variant IN ('STANDARD', 'HABITAT')),
  billing_notes               TEXT,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by                  UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE TRIGGER client_invoice_rule_set_updated_at
  BEFORE UPDATE ON client_invoice_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE receiver (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES client(id),
  display_name TEXT,
  email        CITEXT NOT NULL CHECK (length(btrim(email::text)) > 0),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX receiver_active_client_email_idx
  ON receiver (client_id, email) WHERE is_active;
CREATE INDEX receiver_client_idx ON receiver (client_id, is_active, email);
CREATE TRIGGER receiver_set_updated_at
  BEFORE UPDATE ON receiver
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            CITEXT,
  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  normalized_name TEXT NOT NULL UNIQUE CHECK (length(btrim(normalized_name)) > 0),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX product_code_idx ON product (code) WHERE code IS NOT NULL;
CREATE INDEX product_active_name_idx ON product (is_active, name);
CREATE TRIGGER product_set_updated_at
  BEFORE UPDATE ON product
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_center (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES client(id),
  product_id          UUID NOT NULL REFERENCES product(id),
  code                CITEXT NOT NULL CHECK (length(btrim(code::text)) > 0),
  project_name        TEXT NOT NULL CHECK (length(btrim(project_name)) > 0),
  project_center_type TEXT NOT NULL CHECK (project_center_type IN (
    'ADMINISTRATION_OPERATION', 'DEVELOPMENT_HOURS', 'CONSTRUCTION'
  )),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES app_user(id) ON DELETE SET NULL,
  UNIQUE (client_id, code)
);

CREATE INDEX project_center_client_idx ON project_center (client_id, is_active, code);
CREATE INDEX project_center_product_idx ON project_center (product_id);
CREATE TRIGGER project_center_set_updated_at
  BEFORE UPDATE ON project_center
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN issuer_company.default_iva_rate IS
  'Sugerencia decimal exacta. El driver PostgreSQL debe entregarla como string.';
COMMENT ON COLUMN client.default_coordinator_profile_id IS
  'Responsable sugerido; no restringe los responsables disponibles ni modifica historia.';
COMMENT ON COLUMN client_invoice_rule.excel_template_variant IS
  'Regla explícita; nunca se infiere del nombre del cliente.';
COMMENT ON COLUMN product.normalized_name IS
  'Clave canónica calculada por dominio; detecta duplicados sin fusionarlos.';

GRANT SELECT, INSERT, UPDATE ON
  issuer_company, coordinator_profile, client, client_invoice_rule,
  receiver, product, project_center
TO factuflow_app;

REVOKE DELETE, TRUNCATE ON
  issuer_company, coordinator_profile, client, client_invoice_rule,
  receiver, product, project_center
FROM factuflow_app;

REVOKE ALL ON
  issuer_company, coordinator_profile, client, client_invoice_rule,
  receiver, product, project_center
FROM PUBLIC;

-- Down Migration

DROP TABLE IF EXISTS project_center;
DROP TABLE IF EXISTS product;
DROP TABLE IF EXISTS receiver;
DROP TABLE IF EXISTS client_invoice_rule;
DROP TABLE IF EXISTS client;
DROP TABLE IF EXISTS coordinator_profile;
DROP TABLE IF EXISTS issuer_company;
