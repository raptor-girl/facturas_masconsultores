# Estado de Fase 6 — Importador controlado de maestros legacy

## Alcance implementado

Fase 6 agrega una carga controlada para maestros existentes de FactuFlow:

- empresas emisoras;
- responsables/coordinadores operativos;
- clientes;
- configuración de facturación por cliente;
- receptores;
- productos;
- CP/MS.

Quedan fuera solicitudes históricas, Excel históricos, documentos exportados, folios históricos, estados antiguos, proyecciones, Slack, correos, usuarios reales de acceso, contraseñas, sesiones y archivos adjuntos.

## Migración

La migración reversible `1721000000008_legacy-master-imports.sql` crea:

- `legacy_master_import_run`: corridas idempotentes `PREVIEW`/`APPLY`, actor, hashes, resumen, request ID e información minimizada de origen.
- `legacy_master_import_item`: decisión por fila (`CREATE`, `UPDATE`, `NOOP`, `ERROR`), issues y antes/después minimizados.
- `legacy_master_import_mapping`: vínculo estable entre `externalId` legacy y el ID V1 del maestro.

`factuflow_owner` conserva ownership. `factuflow_app` tiene sólo `SELECT`/`INSERT` sobre estas tablas y no puede `UPDATE`, `DELETE` ni `TRUNCATE`.

El ajuste reversible `1721000000009_optional-project-center-product.sql` deja `project_center.product_id` como opcional. La regla vigente es que CP/MS es la entidad principal de facturación; `product` queda como clasificación derivada o administrativa. La importación legacy no se bloquea por ausencia de producto directo, aunque si se informa un producto éste debe existir y estar activo para operaciones posteriores.

## API

Endpoints ADMIN:

- `POST /admin/imports/masters/preview`
- `POST /admin/imports/masters/apply`
- `GET /admin/imports/masters/:id`

Los `POST` requieren sesión ADMIN, contraseña ya cambiada, CSRF e `Idempotency-Key`. Todos aparecen en OpenAPI y usan contratos Zod compartidos desde `packages/shared-schemas/src/master-imports.ts`.

## Contrato de entrada

El payload es JSON normalizado. Cada entidad importable usa un `externalId` técnico para idempotencia y mapeo; las reglas de facturación se vinculan por `clientExternalId`. No se aceptan campos de usuario de acceso, password, hash, token, sesión ni archivos.

El importador reutiliza validaciones existentes:

- RUT chileno canónico;
- tasas IVA como string decimal;
- emails normalizados;
- nombres de producto normalizados;
- catálogos técnicos de tratamiento, requisitos documentales, variante Excel y tipo CP/MS.

Por defecto `allowUpdates=false`: si una clave natural o mapping apunta a un maestro existente con diferencias, la fila queda en `ERROR` con `UPDATE_NOT_ALLOWED`. Con `allowUpdates=true` se permite actualizar maestros dentro de la transacción de apply.

## Flujo

`preview` calcula el plan, guarda corrida e items y audita `LEGACY_MASTER_IMPORT_PREVIEWED`, pero no modifica maestros, solicitudes ni folios.

`apply` calcula el plan antes de escribir. Si existe cualquier `ERROR`, guarda corrida `REJECTED`, items y auditoría `LEGACY_MASTER_IMPORT_REJECTED` sin tocar maestros. Si no hay errores, crea/actualiza/no-op los maestros en orden seguro, registra mapeos, guarda corrida `APPLIED` y audita `LEGACY_MASTER_IMPORT_APPLIED`.

La auditoría crítica y la corrida comparten transacción. Un fallo de auditoría revierte la carga. Las tablas del importador serializan JSONB explícitamente para conservar arrays de issues como JSON real y no como arrays PostgreSQL.

## Idempotencia

La combinación `(actor_user_id, idempotency_key)` es única. Repetir la misma clave con el mismo payload y modo devuelve la corrida anterior. Reutilizar la clave con otro payload o modo responde 409 `IMPORT_IDEMPOTENCY_CONFLICT`.

El hash del payload canónico y el SHA-256 de fuente quedan registrados. Cuando `sourceSha256` no viene informado, se calcula un hash estable del payload recibido para mantener trazabilidad sin almacenar archivos fuente completos.

## Auditoría

Eventos agregados:

- `LEGACY_MASTER_IMPORT_PREVIEWED`
- `LEGACY_MASTER_IMPORT_APPLIED`
- `LEGACY_MASTER_IMPORT_REJECTED`

Incluyen actor, roles, request ID, entidad `legacy_master_import_run`, resultado y resumen minimizado. No se registra archivo completo, payload completo, Excel, contraseñas, tokens, cookies ni datos secretos.

## Pruebas

Se agregó `apps/api/tests/master-imports.integration.test.ts`, incorporado al script `test:integration`. Cubre:

- autenticación ADMIN, CSRF e idempotency key;
- publicación OpenAPI;
- preview sin mutar maestros, solicitudes ni folios;
- apply transaccional de todos los maestros admitidos;
- mapeos legacy a V1;
- idempotencia y conflicto de idempotencia;
- CP/MS legacy sin producto directo, manteniendo `product_id = null`;
- rechazo por referencia inválida sin crear maestros ni usuarios;
- auditoría de preview, apply y rejected.

Las pruebas usan sólo datos ficticios `example.invalid`.

## Corrección detectada durante validación

La primera integración de Fase 6 detectó que arrays JavaScript insertados en JSONB podían ser interpretados por `pg` como arrays PostgreSQL. Se corrigió serializando explícitamente los JSONB del importador y deserializando de forma defensiva al responder. No se relajó la prueba.

## Límites y fuera de alcance

No hay frontend específico para importación en esta fase. La operación se realiza por API/OpenAPI o clientes administrativos controlados.

No se importó `bdmaster.sql` ni se cargaron datos reales. La migración sólo crea estructura técnica. La carga real queda para una ejecución operacional posterior con archivos validados, preview revisado y aprobación explícita.

## Clasificación

**FASE 6 APROBADA.**

Validación final ejecutada:

- `npm ci`: instalación limpia OK; conserva avisos de vulnerabilidades sólo en dependencias dev.
- `npm run db:migrate`: aplicó `1721000000008_legacy-master-imports`.
- `npm run db:status`: no quedan migraciones pendientes.
- `npm run format:check`: OK.
- `npm run lint`: OK.
- `npm run typecheck`: OK.
- `npm run test:unit`: 60/60 API y 13/13 web.
- `npm run test:integration`: 78/78 API con PostgreSQL 16 real.
- `npm run build`: OK.
- `npm run verify`: OK; 138/138 API y 13/13 web.
- `npm audit --omit=dev`: 0 vulnerabilidades runtime.
- Docker reconstruido: PostgreSQL healthy, API healthy, web HTTP 200 y OpenAPI HTTP 200 con rutas del importador.
- `git diff --check`: OK, sólo avisos de CRLF propios de Windows.
- `.env`: ignorado por `.gitignore` y no versionado.

No se importaron datos reales y no se realizó commit ni push.
