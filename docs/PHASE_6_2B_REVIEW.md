# Fase 6.2B - Revision humana legacy antes del apply

Fecha de revision: 2026-07-23

## Estado

Fase 6.2B queda lista para revision humana final. No se ejecuto `--apply`.

El preview real sobre `legacy-private/bdmaster.sql` queda:

- Estado: `READY_FOR_REVIEW`
- Modo: `DRY_RUN`
- SHA-256 fuente: `067dd661340cc532af90af88d309a18b17bfaec46f6f4f92dccffe59d7739778`
- Bloqueantes: 0
- Warnings: 8
- `project_center` warnings: 0
- `client_invoice_rule` warnings: 2
- `projectCenterTypeOverrides`: vacio
- `habitatClientOverrides`: 1 decision real
- `documentRuleOverrides`: 2 decisiones reales

## Falsos positivos corregidos

- `tipo_cp` acepta etiquetas legacy desde `catalogo_tipo_cp.nombre`.
- Las etiquetas legacy quedan homologadas a los codigos V1:
  - Administracion y Operacion, con o sin tildes -> `ADMINISTRATION_OPERATION`
  - Construccion, con o sin tilde -> `CONSTRUCTION`
  - Horas de Desarrollo -> `DEVELOPMENT_HOURS`
- CP/MS sigue siendo la entidad principal facturable.
- Producto sigue siendo una clasificacion opcional.
- La ausencia de producto directo en CP/MS no genera bloqueantes.
- Habitat no se infiere por nombre para ejecutar comportamiento runtime; solo queda como decision de importacion por override.
- Las apariciones de AFP Habitat en receptores no duplican decisiones de override.

## Decisiones humanas pendientes

### 1. Variante Excel para AFP Habitat

Fuente revisada:

- `cliente` fila 5, `nombre_corto` sugiere AFP Habitat.
- Receptores asociados existen, pero son multiples receptores del mismo cliente; no son decisiones independientes.
- No se detecto una segunda configuracion de facturacion en `cliente_facturacion` para ese cliente.

Propuesta:

- `excel_template_variant`: `HABITAT`

Estado:

- Requiere aprobacion humana antes de apply.

### 2. Reglas documentales

La fuente legacy permite inferir `requiere_hes`, pero no define de forma completa OC ni contrato para todos los clientes.

Evidencia minimizada:

- Solo un cliente tiene `requiere_hes = 1`: Transelec.
- AFP Habitat tiene `requiere_hes = 0`.
- OC y contrato no tienen catalogo maestro equivalente en legacy.

Propuesta operativa conservadora:

- Regla general: `purchase_order_requirement = OPTIONAL`
- Regla general: `hes_requirement = NOT_APPLICABLE`
- Regla general: `contract_requirement = OPTIONAL`
- Excepcion Transelec: `hes_requirement = REQUIRED`
- Excepcion AFP Habitat: `excel_template_variant = HABITAT`; mantener HES `NOT_APPLICABLE` salvo decision humana contraria.

Estado:

- Requiere aprobacion humana antes de apply.

### 3. Clientes con RUT ausente o datos incompletos

Warnings reales:

- 2 clientes sin RUT.
- 8 clientes con razon social, giro o direccion incompletos.

Propuesta:

- Cargar estos clientes como `PENDING_COMPLETION` si se aprueba preservar el maestro legacy.
- Mantener `is_active = true` solo si siguen siendo necesarios para CP/MS o facturacion futura.
- Completar datos legales antes de pasarlos a `COMPLETE`.

Estado:

- Requiere aprobacion humana antes de apply.

### 4. RUT duplicado en empresas emisoras

Warnings reales:

- Hay 2 pares de RUT duplicado en `empresa_emisora`.

Propuesta:

- Consolidar el par `INSTITUTO_ROY` / `INSTITUTO_ROI` usando `INSTITUTO_ROI` como codigo canonico.
- Consolidar el par `MAS_CAPACITACIONES` / `MAS_CAPACITACION` usando `MAS_CAPACITACION` como codigo canonico.

Estado:

- Requiere aprobacion humana antes de apply.

## Override propuesto

Se dejo un borrador privado, no versionado, en:

- `legacy-private/import-overrides.proposed.json`

Ese archivo es una propuesta de decisiones. No fue aplicado a la base ni consumido por `--apply`.

## Confirmacion de no mutacion

Durante Fase 6.2B:

- No se ejecuto `--apply`.
- No se importaron datos reales definitivamente.
- No se modificaron maestros productivos.
- No se crearon solicitudes.
- No se consumieron folios.
- No se crearon usuarios reales.
- No se hizo commit ni push.

Los artefactos regenerados son reportes locales/dry-run:

- `tmp/legacy-import/summary.md`
- `tmp/legacy-import/issues.csv`
- `tmp/legacy-import/preview.json`
- `legacy-private/import-overrides.draft.json`
- `legacy-private/import-overrides.proposed.json`
