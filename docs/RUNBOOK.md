# Runbook operativo — Fases 2 a 5

## Puesta en marcha

1. Configure `.env` desde `.env.example` sin usar credenciales reales.
2. Ejecute `npm ci`, `npm run docker:up`, `npm run db:migrate` y `npm run db:status`.
3. Confirme PostgreSQL y API healthy, web 200, `/health` con `status=ok` y `/docs` 200.
4. Si no existe un ADMIN activo, ejecute `npm run user:bootstrap-admin`.

El bootstrap es interactivo. No pase passwords en argumentos ni en PowerShell. La contraseña temporal aparece una vez; no queda en base, logs ni auditoría. El primer acceso queda limitado a cambiar contraseña o cerrar sesión.

## Variables

| Variable                          |                   Default | Uso                                                         |
| --------------------------------- | ------------------------: | ----------------------------------------------------------- |
| `SESSION_COOKIE_NAME`             |       `factuflow_session` | Cookie HttpOnly; sincronizar con `VITE_SESSION_COOKIE_NAME` |
| `SESSION_IDLE_MINUTES`            |                     `480` | Expiración por inactividad                                  |
| `SESSION_ABSOLUTE_MINUTES`        |                    `1440` | Límite absoluto                                             |
| `SESSION_ACTIVITY_UPDATE_MINUTES` |                       `5` | Throttling de actividad                                     |
| `LOGIN_MAX_ATTEMPTS`              |                       `5` | Fallos por ventana                                          |
| `LOGIN_ATTEMPT_WINDOW_MINUTES`    |                      `15` | Ventana de fallos                                           |
| `LOGIN_LOCK_MINUTES`              |                      `15` | Bloqueo                                                     |
| `LOGIN_ATTEMPT_RETENTION_DAYS`    |                      `90` | Retención documentada                                       |
| `PASSWORD_HASH_MEMORY_KIB`        |                   `65536` | Memoria Argon2id                                            |
| `PASSWORD_HASH_TIME_COST`         |                       `3` | Costo Argon2id                                              |
| `PASSWORD_HASH_PARALLELISM`       |                       `1` | Paralelismo Argon2id                                        |
| `UF_SII_BASE_URL`                 |       URL oficial del SII | Tabla anual HTML                                            |
| `UF_MINDICADOR_BASE_URL`          |         URL mindicador.cl | Fuente alternativa JSON                                     |
| `UF_REQUEST_TIMEOUT_MS`           |                   `10000` | Timeout por intento                                         |
| `UF_REQUEST_RETRIES`              |                       `2` | Reintentos después del intento inicial                      |
| `UF_CACHE_ENABLED`                |                    `true` | Consulta PostgreSQL antes de las fuentes                    |
| `UF_USER_AGENT`                   | `FactuFlow/0.1 UF lookup` | Identificación HTTP sin secretos                            |

`SESSION_IDLE_MINUTES` no puede superar la duración absoluta. Producción rechaza memoria Argon2 inferior a 65536 KiB.

## Operación

- Crear, editar, activar, desactivar, asignar roles, resetear contraseña o revocar sesiones: `/admin/usuarios` con ADMIN.
- Un usuario se desactiva; nunca se elimina físicamente.
- Desactivar o resetear revoca sesiones. No se puede desactivar ni quitar el rol al último ADMIN activo.
- El reset muestra una nueva contraseña temporal una vez. No existe envío de correo en esta fase.
- Sesiones propias: `/mi-cuenta`. La fuente de verdad siempre es `/auth/me`; no hay token en localStorage ni sessionStorage.

## Diagnóstico

- 401: sesión inexistente, expirada o usuario desactivado; volver a login.
- 403 `PASSWORD_CHANGE_REQUIRED`: cambiar la contraseña temporal.
- 403 `CSRF_INVALID`: revisar cookie CSRF, header y origen permitido.
- 409 `USER_DUPLICATE`: username o correo ya existe; CITEXT hace la comparación sin distinguir mayúsculas.
- 409 `LAST_ACTIVE_ADMIN`: primero cree o active otro ADMIN.
- Login siempre usa mensaje genérico; investigue con `requestId` y auditoría, nunca revelando existencia de cuenta.

No edite `audit_event` ni `login_attempt` con el rol de aplicación. La purga de intentos antiguos se programa fuera del API y sólo con owner.

## Operación de maestros

Después de `npm run db:migrate`, la migración 005 deja vacíos todos los maestros. No inserta empresas, personas, clientes, correos, productos ni CP reales.

En la web, un ADMIN usa:

- `/admin/empresas-emisoras` para emisoras y sugerencias tributarias;
- `/admin/responsables` para perfiles operativos y su vínculo opcional con cuenta;
- `/admin/clientes` para datos legales, responsable sugerido, regla, receptores y detalle de CP/MS;
- `/admin/productos` para nombres canónicos;
- `/admin/cp-ms` para seleccionar cliente y administrar la relación directa con producto.

Los registros se desactivan; no se borran. Un cliente `PENDING_COMPLETION` admite datos legales ausentes para preservar historia, mientras `COMPLETE` exige RUT válido, razón social, giro y dirección. Un cliente inactivo no admite CP/MS nuevos. La variante `HABITAT` debe elegirse explícitamente: nunca se deduce del nombre.

Diagnóstico de API:

- 401: no hay sesión válida;
- 403: rol insuficiente, cambio de contraseña pendiente o CSRF inválido;
- 404: UUID válido, registro inexistente;
- 409 `MASTER_DUPLICATE`: clave o relación única duplicada;
- 422 `INVALID_RUT`, `CLIENT_INCOMPLETE` o relación inactiva/inválida.

OpenAPI en `/docs` es la referencia de cuerpos, paginación, búsqueda y orden. `COORDINATOR` puede consultar endpoints de maestros, pero toda escritura bajo `/admin` exige ADMIN y CSRF.

## Operación UF y cálculo

- `GET /uf-values/:date`: ADMIN y COORDINATOR; fecha exacta `YYYY-MM-DD`.
- `POST /admin/uf-values/:date/refresh`: sólo ADMIN y CSRF. Una diferencia se conserva en auditoría con antes/después y fuente.
- `POST /calculations/invoice-preview`: ADMIN y COORDINATOR, con CSRF; valida CP/MS activos del mismo cliente y no persiste nada.
- `/herramientas/calculo`: fecha explícita, cliente, autocomplete CP/MS, cantidades UF textuales y tratamiento afecto/exento.

La entrada decimal web acepta coma o punto, pero no ambos; se normaliza a string canónico con punto. No use `input type=number`, `parseFloat`, `Number` ni `Intl.NumberFormat` sobre montos. El formateador CLP agrupa el string entero directamente.

Diagnóstico:

- 400 `UF_DATE_INVALID`: fecha inexistente o fuera del rango soportado;
- 404 `UF_NOT_PUBLISHED`: ninguno de los proveedores publicó exactamente esa fecha;
- 502 `UF_PROVIDER_INVALID_RESPONSE`: contrato, content type o contenido externo inválido;
- 503 `UF_PROVIDER_UNAVAILABLE`: timeout, red, 429 o 5xx después de los reintentos;
- 422 `PROJECT_CENTER_INACTIVE`/`PROJECT_CENTER_CLIENT_MISMATCH`: input de previsualización no utilizable.

Nunca cambie manualmente una UF con el rol de aplicación. Para investigar, correlacione `requestId` con `UF_VALUE_FETCHED`, `UF_VALUE_REFRESHED`, `UF_VALUE_CHANGED` y `UF_PROVIDER_FAILED`; la auditoría no guarda HTML ni respuestas externas completas.

## Operación de solicitudes exportadas

- `/solicitudes/nueva`: prepara en memoria y sólo crea al pulsar **Exportar Excel y guardar solicitud**.
- `/solicitudes`: historial paginado y filtros por texto, cliente, responsable, período y fecha.
- `/solicitudes/:id`: detalle inmutable, descarga del BYTEA exacto y acción Duplicar.
- `/solicitudes/:id/duplicar`: precarga un formulario nuevo; no reutiliza folio, id, exportación ni montos finales.

La exportación requiere `Idempotency-Key`. El frontend genera una clave por intento lógico y la conserva durante reintentos/doble clic. Si llega la misma clave con el mismo payload, el API devuelve el mismo folio y los mismos bytes; con un payload distinto responde 409 `IDEMPOTENCY_KEY_REUSED`.

Diagnóstico:

- 409 `UF_VALUE_CHANGED` o `MASTER_DATA_CHANGED`: recargar el formulario y confirmar los datos vigentes;
- 422 por OC/HES/contrato: completar el documento obligatorio indicado por la regla del cliente;
- 422 por maestro inactivo/incompleto: activar/corregir el maestro antes de exportar;
- 500 durante XLSX, persistencia o auditoría: no rearmar manualmente el folio; repetir con la misma idempotency key después de corregir la causa;
- descarga histórica: validar el header `X-Export-Sha256` si se requiere comprobar integridad.

No hay archivos temporales en disco ni directorio `storage/exports`; el XLSX vive en PostgreSQL. Para investigar use `requestId`, `INVOICE_REQUEST_EXPORTED` e `INVOICE_EXPORT_DOWNLOADED`. Nunca registre el body completo, la idempotency key ni el BYTEA.

Las exportaciones nuevas usan la candidata clonada `SOLICITUD_FACTURA_CLONE_CANDIDATE_V1`. La base se carga desde `templates/approved/solicitud-factura-soprole-clone-v1.xlsx`; no se modifica y nunca se escribe el resultado productivo en disco. Los documentos históricos conservan su versión y BYTEA originales.

Para verificar la base clonada y generar los seis casos ficticios de revisión:

```bash
npm run template:build
npm run template:review
```

Antes de revisar, confirme el hash de la referencia privada sin abrirla en runtime:

```powershell
Get-FileHash templates/reference-private/solicitud_factura_soprole_2026_abril.xls -Algorithm SHA256
```

Debe ser `4b47d4a68c5b83ad16950e86374075ef158c06d7d88e0bffc608489023eb0c36`. Los resultados quedan en `tmp/template-review/`, ruta ignorada por Git. No copie datos reales a esa carpeta, no use los Excel históricos como golden files y no cambie la versión a `APPROVED` antes de la revisión visual de la usuaria.
