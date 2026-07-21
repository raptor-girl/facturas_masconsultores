# Estado de Fase 3 — Maestros de facturación

## Alcance implementado

La migración reversible `1721000000005_billing-masters.sql` crea, sin datos reales:

- `issuer_company`;
- `coordinator_profile`;
- `client`;
- `client_invoice_rule`;
- `receiver`;
- `product`;
- `project_center`.

No crea `client_product` ni tablas de UF, solicitudes, cálculos, Excel, documentos o migración histórica.

## Decisiones

- Cuenta de acceso y responsable operativo son entidades distintas, con vínculo opcional único.
- Responsable sugerido se guarda en cliente y no limita responsables disponibles.
- Reglas documentales y plantilla Excel son datos explícitos. `HABITAT` no depende de nombres.
- RUT se valida en dominio, se persiste canónico y se presenta formateado. Un cliente pendiente puede omitirlo.
- `default_iva_rate` es `NUMERIC(5,4)` y `string`; se valida con Decimal y no existe parser a Number.
- Producto usa clave canónica para rechazar duplicados sin fusionar datos.
- CP/MS relaciona cliente y producto directamente y usa un CHECK técnico para sus tres tipos.
- Todos los maestros se desactivan; el rol de aplicación carece de DELETE y TRUNCATE.

## API y permisos

Las listas paginan, buscan, filtran activos y ordenan. Los endpoints aparecen en OpenAPI. ADMIN puede crear, editar, activar y desactivar. COORDINATOR puede leer. Sesión ausente devuelve 401 y sesión sin rol devuelve 403. Las escrituras requieren CSRF y cambio obligatorio de contraseña resuelto.

## Auditoría

Se registran los eventos `ISSUER_COMPANY_*`, `COORDINATOR_*`, `CLIENT_*`, `RECEIVER_*`, `PRODUCT_*` y `PROJECT_CENTER_*` definidos para la fase. Cada escritura comparte transacción con auditoría e incluye actor, roles, request ID, IP minimizada, user agent y antes/después. Un fallo de INSERT en `audit_event` revierte el cambio.

## Frontend

ADMIN dispone de navegación y pantallas responsive para emisoras, responsables, clientes, productos y CP/MS. Receptores y regla se muestran dentro del detalle del cliente. La tabla principal de clientes no muestra responsable. El autocomplete reutilizable de cliente incluye debounce, aborto de solicitud anterior, teclado, Escape, ARIA y capa flotante.

## Pruebas

La evidencia automatizada cubre RUT, normalización de productos, constraints, relaciones, RUT ausente solo en pendiente, duplicados, receptores por cliente, CP por cliente/producto, cliente inactivo, permisos, paginación/búsqueda, OpenAPI, NUMERIC string, auditoría transaccional y ausencia de DELETE. Las guardias previas de autenticación, último ADMIN, CSRF, auditoría append-only, NUMERIC y folios concurrentes se conservan.

Validación de cierre: 86/86 pruebas (`79 API + 7 web`) en `npm run verify`; format, lint, typecheck y build aprobados; migración aplicada sin pendientes; PostgreSQL/API healthy; web, `/health` y `/docs` responden; `npm audit --omit=dev` informa 0 vulnerabilidades de runtime.

## Fuera de alcance

UF, conversión UF–CLP, motor de cálculos, solicitudes, duplicación, folios aplicados, Excel, documentos exportados, `bdmaster.sql`, datos históricos, proyecciones, Slack y solicitudes programadas.

No se agregaron datos reales ni variables de entorno nuevas. `.env.example` no requiere cambios para esta fase.

## Observación técnica

El audit completo conserva 12 avisos en herramientas de desarrollo ya documentados en Fase 2. Resolverlos exige actualizaciones mayores independientes. No afectan la imagen de runtime, cuyo audit es 0, y no se aplicó `npm audit fix --force`.
