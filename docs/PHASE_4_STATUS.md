# Estado de Fase 4 — Valores UF y cálculo tributario

## Alcance implementado

La migración reversible `1721000000006_uf-values.sql` crea únicamente `uf_value`: fecha única, valor `NUMERIC(20,6)` positivo, fuente controlada, timestamps, referencia pública y metadata minimizada opcional. No crea solicitudes, documentos ni relaciones con folios.

La consulta sigue `caché PostgreSQL → SII → mindicador.cl`. SII usa la tabla anual HTML y mindicador su respuesta JSON anual; ambos quedan detrás del puerto `UfProvider`. Timeout, reintentos, backoff, content type, tamaño, redirecciones y SSRF se controlan en un cliente HTTP común. CI usa fixtures y servidores simulados, nunca Internet.

## Motor LEGACY_V1

- Entradas y salidas monetarias/decimales son string.
- Cada CP/MS multiplica cantidad UF por valor UF y redondea `ROUND_HALF_UP` a cero decimales.
- El neto suma los CP ya redondeados.
- `AFFECTED` usa tasa string `0.19` y eleva el IVA al siguiente múltiplo de $10 con Decimal.
- `EXEMPT` usa tasa `0` e IVA `0`.
- La fecha UF es obligatoria y explícita; no existe reemplazo silencioso por otra fecha.

El motor es puro: no accede a PostgreSQL, proveedores, reloj ni folios. La capa de aplicación valida que todos los CP/MS existan, estén activos y pertenezcan al mismo cliente.

## API y frontend

- `GET /uf-values/:date`: ADMIN/COORDINATOR, caché y fallback.
- `POST /admin/uf-values/:date/refresh`: ADMIN + CSRF, recarga auditada.
- `POST /calculations/invoice-preview`: ADMIN/COORDINATOR + CSRF, cálculo no persistente.
- `/herramientas/calculo`: fecha, fuente/caché, cliente, autocomplete CP/MS, múltiples líneas, tratamiento y desglose responsive.

La web acepta coma o punto como separador de entrada y normaliza a punto. Los CLP se formatean desde strings; no hay conversión binaria, botón de guardado, exportación, folio ni estado de solicitud.

## Auditoría y permisos

Se registran `UF_VALUE_FETCHED`, `UF_VALUE_REFRESHED`, `UF_VALUE_CHANGED` y `UF_PROVIDER_FAILED`. Los fallos sólo conservan proveedor, fecha y clasificación; nunca HTML o cuerpos externos. Actualización y auditoría crítica comparten transacción y una prueba fuerza el fallo de auditoría para verificar rollback.

`factuflow_owner` es propietario. `factuflow_app` puede SELECT/INSERT/UPDATE sobre `uf_value`, pero PostgreSQL le niega DELETE y TRUNCATE. La protección append-only de `audit_event` permanece sin cambios.

## Evidencia de regresión

Los casos R01/R02 y de valor grande de `ROUNDING_REGRESSION_CASES.md` están automatizados. En R02, 10.5 y 20.3 UF a 40543.07 producen CP de 425702 y 823024, neto correcto 1248726; redondear el agregado produciría 1248727 y se rechaza como algoritmo incorrecto.

## Fuera de alcance

No existen solicitudes persistidas, estados, duplicación, folios aplicados, Excel, documentos, importación histórica, proyecciones, Slack ni procesos programados. La decisión sobre qué fecha UF usará una futura solicitud sigue abierta y debe resolverse explícitamente en esa fase.

## Validación de cierre

La migración 006 se aplicó y `db:status` no deja pendientes. Formato, lint, typecheck y build pasan. `test:unit` aprobó 59 pruebas (49 API + 10 web), `test:integration` aprobó 58 y `verify` aprobó el conjunto completo de 117 (107 API + 10 web). `npm audit --omit=dev` informa 0 vulnerabilidades de runtime.

El smoke Docker confirmó PostgreSQL y API healthy, `/health` con API/base `ok`, web 200, `/docs` 200 y las tres rutas nuevas en OpenAPI. Login, `/auth/me` y logout respondieron 200 con un fixture ficticio temporal que se eliminó después de la prueba. PostgreSQL confirmó ownership `factuflow_owner`, privilegios SELECT/INSERT/UPDATE y ausencia de DELETE/TRUNCATE para `factuflow_app`, cero tablas `*request*` y cero valores UF reales cargados.

No se incorporaron datos reales ni secretos. La instalación completa informa 13 avisos sólo en herramientas de desarrollo; resolverlos requiere revisar actualizaciones mayores y no se aplicó `npm audit fix --force`.
