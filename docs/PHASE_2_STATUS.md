# Estado de Fase 2

## Alcance implementado

- Cuentas personales con roles ADMIN y COORDINATOR; ambos roles pueden coexistir.
- Argon2id, política de contraseña, temporales de un solo uso y bootstrap seguro del primer ADMIN.
- Sesiones opacas de servidor, cookies seguras, expiración, actividad limitada y revocación.
- CSRF asociado a sesión, CORS/orígenes explícitos, rate limit, request ID y logs redactados.
- Login, logout, cuenta propia, cambio obligatorio, sesiones y administración completa de usuarios.
- Auditoría transaccional append-only e intentos de login con retención documentada.
- Interfaz responsive para `/login`, `/cambiar-contrasena`, `/`, `/mi-cuenta` y `/admin/usuarios`.

## Migración

`1721000000004_authentication-and-sessions.sql` amplía `app_user` y `app_session`, crea `login_attempt` e inserta idempotentemente ADMIN/COORDINATOR. No crea usuarios. Tiene sección Down y no modifica migraciones aplicadas.

## Eventos

`AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGIN_FAILED`, `AUTH_LOGOUT`, `AUTH_SESSION_EXPIRED`, `AUTH_SESSION_REVOKED`, `AUTH_PASSWORD_CHANGED`, `AUTH_PASSWORD_RESET`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_UNLOCKED`, `USER_CREATED`, `USER_UPDATED`, `USER_ACTIVATED`, `USER_DEACTIVATED`, `USER_ROLES_CHANGED` y `USER_SESSIONS_REVOKED`.

## Pruebas

Las suites cubren Argon2id/política; equivalencia de login; bloqueo/desbloqueo; cookies, hash de token y CSRF; expiración, logout y revocación; ADMIN/COORDINATOR/sin rol; último ADMIN; CRUD, duplicados, roles, reset y no exposición del hash; auditoría sin secretos y rollback crítico; además de login y guards del frontend.

Se conservan todas las guardias de Fase 1: PostgreSQL owner/app, auditoría append-only, NUMERIC como string y folios concurrentes sin `COUNT(*)` ni `MAX+1` en aplicación.

## Limitaciones deliberadas

- La purga de `login_attempt` a 90 días está documentada, pero su scheduler operativo no pertenece al proceso API.
- No se envían correos; ADMIN entrega la temporal por un canal externo seguro.
- No existe recuperación automática, MFA ni SSO en esta fase.
- `npm audit --omit=dev` informa 0 vulnerabilidades de ejecución. El audit completo conserva 12 avisos en herramientas de desarrollo (Vite/Vitest, Testcontainers y node-pg-migrate); resolverlos exige actualizaciones mayores y se difiere para una actualización técnica aislada.
- No existen clientes, responsables, receptores, CP/MS, productos, UF, solicitudes, cálculos, Excel, histórico ni proyecciones.
