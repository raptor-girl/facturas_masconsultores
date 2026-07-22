-- 009 — Producto opcional en CP/MS (ajuste Fase 6.1)
--
-- CP/MS es la entidad principal de facturación. Producto queda como
-- clasificación administrativa opcional, especialmente para cargas legacy donde
-- el CP/MS no trae producto directo.

-- Up Migration

ALTER TABLE project_center
  ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE invoice_request_line
  ALTER COLUMN product_id DROP NOT NULL,
  ALTER COLUMN product_name DROP NOT NULL;

COMMENT ON COLUMN project_center.product_id IS
  'Clasificación administrativa opcional. CP/MS puede facturarse sin producto directo.';
COMMENT ON COLUMN invoice_request_line.product_id IS
  'Snapshot opcional del producto si existía al exportar; CP/MS es la entidad facturable.';
COMMENT ON COLUMN invoice_request_line.product_name IS
  'Snapshot opcional del producto si existía al exportar.';

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_center WHERE product_id IS NULL) THEN
    RAISE EXCEPTION 'No se puede revertir: existen CP/MS sin producto.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM invoice_request_line
    WHERE product_id IS NULL OR product_name IS NULL
  ) THEN
    RAISE EXCEPTION 'No se puede revertir: existen líneas exportadas sin producto.';
  END IF;
END $$;

ALTER TABLE invoice_request_line
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN product_id SET NOT NULL;

ALTER TABLE project_center
  ALTER COLUMN product_id SET NOT NULL;
