# Estado de Fase 5 — Solicitudes exportadas y Excel transaccional

## Alcance implementado

La migración reversible `1721000000007_invoice-requests-and-exports.sql` crea únicamente `invoice_request`, `invoice_request_line`, `invoice_request_receiver` e `invoice_export`. Una solicitud existe sólo en estado `EXPORTED`; no hay borradores, edición, borrado, aprobación/rechazo ni tablas de orden de compra.

`invoice_request` congela cliente, emisor, responsable, regla de facturación, fechas, período, UF/fuente, tratamiento/tasa, montos, área `Plataformas`, referencias documentales, versión de cálculo y plantilla. Líneas y receptores conservan sus propios snapshots. `invoice_export` guarda el XLSX exacto como `BYTEA`, su SHA-256, tamaño, MIME, nombre y versión.

## Flujo transaccional e idempotencia

El servicio valida cliente `COMPLETE` activo, regla, emisor, responsable, CP/productos, receptores, requisitos documentales y UF exacta. Reutiliza sin duplicar `LEGACY_V1`; el frontend no puede enviar montos finales. Genera y valida el XLSX en memoria antes de abrir la transacción. Dentro de ella bloquea la clave idempotente, revalida maestros/UF, reserva folio, inserta las cuatro entidades y registra `INVOICE_REQUEST_EXPORTED`. Cualquier fallo revierte todo, incluido el contador.

La combinación `(created_by, idempotency_key)` es única. La clave se vincula al hash del payload canónico: repetir clave/payload devuelve exactamente folio y bytes previos; cambiar el payload responde 409. Doble clic concurrente crea una sola solicitud y consume un solo folio.

## Excel

La variante proviene exclusivamente de `client_invoice_rule.excel_template_variant`; nunca del nombre del cliente. `STANDARD` conserva OC en `C12`; `HABITAT` combina OC/Contrato en esa celda y HES permanece en `C13`. El archivo incluye múltiples CP, receptores, neto/IVA/total exactos y no imprime el folio dentro del workbook. Formula injection, nombres inseguros, macros, vínculos externos y archivos mayores de 5 MiB se rechazan.

El repositorio no contiene la plantilla histórica `templates/solicitud-factura-ejemplo.xlsx`. Por ello se implementó una plantilla técnica claramente marcada `TECHNICAL_V1_UNAPPROVED`. Las celdas y reglas están verificadas, pero la comparación visual final y los golden files aprobados quedan pendientes; no se copiaron Excel reales.

## API, permisos y frontend

- `POST /invoice-requests/export`: ADMIN/COORDINATOR, CSRF e idempotencia; descarga y crea atómicamente.
- `GET /invoice-requests`: historial paginado y filtrable.
- `GET /invoice-requests/:id`: detalle inmutable.
- `GET /invoice-requests/:id/export`: BYTEA exacto y auditoría de descarga.
- `GET /invoice-requests/:id/duplicate-source`: precarga limpia sin persistir.

La web incorpora `/solicitudes`, `/solicitudes/nueva`, `/solicitudes/:id` y `/solicitudes/:id/duplicar`. El formulario, preview y duplicación viven sólo en memoria React; no se usa localStorage, sessionStorage ni IndexedDB. No existe botón Guardar borrador.

ADMIN y COORDINATOR pueden crear, listar, ver, descargar y duplicar. PostgreSQL conserva ownership en `factuflow_owner`; `factuflow_app` tiene sólo SELECT/INSERT sobre las tablas de solicitudes/exportaciones y no puede UPDATE, DELETE ni TRUNCATE.

## Auditoría

Se registran `INVOICE_REQUEST_EXPORTED` y `INVOICE_EXPORT_DOWNLOADED` con actor, request ID, entidad, folio, cliente, responsable, montos, variantes/versiones, hash del archivo y origen de duplicación. No se registra idempotency key, contenido del XLSX, cookies, tokens, secretos ni request completo.

## Pruebas

La cobertura agregada incluye seguridad de texto/nombre, celdas STANDARD/HABITAT, múltiples CP/receptores, regresión de redondeo, BYTEA exacto, SHA-256, requisitos documentales, roles/CSRF, idempotencia secuencial y concurrente, rollback por generador/auditoría, conflicto UF, snapshots, duplicación, historial, OpenAPI y permisos PostgreSQL. Las pruebas usan sólo datos ficticios `example.invalid` y PostgreSQL 16 aislado.

## Limitaciones y fuera de alcance

Quedan fuera borradores, edición/borrado, estados adicionales, aprobación/rechazo, correo, exportación OC, almacenamiento externo, migración histórica, proyecciones, Slack y solicitudes programadas. La fecha impresa se fija explícitamente como fecha UF; la relación definitiva entre fecha de facturación y fecha UF continúa siendo una decisión de negocio documentada.

## Validación de cierre

La migración 007 está aplicada y `db:status` no deja pendientes. `format:check`, lint, typecheck y build pasan. `test:unit` aprobó 69 pruebas (56 API + 13 web), `test:integration` aprobó 73 y `verify` aprobó el conjunto completo de 142 (129 API + 13 web). `npm audit --omit=dev` informa 0 vulnerabilidades de runtime; la instalación completa mantiene 12 avisos sólo en herramientas de desarrollo.

La primera corrida completa de integración descubrió una aserción obsoleta de Fase 4 que exigía ausencia de tablas `*request*`. Se conservó la prueba y se corrigió su intención: preview debe dejar en cero `invoice_request`, líneas, receptores y exports, además de no alterar `folio_counter`. La suite completa volvió a ejecutarse y pasó 73/73.

Docker reconstruyó las imágenes con Node.js 22. PostgreSQL y API quedaron healthy, `/health` informó API/base `ok`, web y `/docs` respondieron 200, las rutas SPA de solicitudes respondieron 200 y las cinco rutas nuevas aparecen en OpenAPI. La imagen runtime instaló 145 paquetes con 0 vulnerabilidades.

El flujo autenticado se validó contra PostgreSQL 16 efímero: login, cambio de contraseña, preview afecto/exento, STANDARD/HABITAT, múltiples CP/receptores, export, folio, historial, detalle, descarga exacta, duplicación en memoria y exportación duplicada con folio nuevo. También se forzaron fallos de generación/auditoría y doble clic concurrente. El contenedor y todos sus fixtures `example.invalid` se destruyeron al terminar. La base local persistente reporta cero solicitudes, líneas, receptores de solicitud y exports; no quedó ningún fixture de Fase 5.

PostgreSQL confirma ownership `factuflow_owner` y exactamente SELECT/INSERT para `factuflow_app` sobre las cuatro tablas. No existen tablas draft, pending ni purchase_order. `.env` sigue ignorado por `.gitignore` y `git ls-files .env` no devuelve nada. `git diff --check` pasa.

## Clasificación

**FASE 5 APROBADA CON OBSERVACIONES.** El flujo funcional, transaccional, numérico y de seguridad está aprobado. La única observación es no funcional: la fidelidad visual final del Excel sigue bloqueada hasta recibir la plantilla oficial `templates/solicitud-factura-ejemplo.xlsx` libre de datos reales. La plantilla técnica actual se identifica expresamente como no aprobada.

No se incorporaron datos reales, Excel históricos ni secretos. No se realizó commit ni push.
