# Arquitectura — Fases 2 y 3

## Límites

`app_user` representa una cuenta de autenticación. `coordinator_profile` representa un responsable operativo y su vínculo con `app_user` es opcional y único. Ninguna de las dos entidades representa todavía al responsable congelado en una solicitud, porque las solicitudes siguen fuera de alcance.

La dirección de dependencias se conserva: HTTP usa el puerto `IdentityService`; PostgreSQL, Argon2id y tokens viven en infraestructura; la política de contraseña vive en dominio. Los contratos Zod compartidos generan OpenAPI y tipan la web.

## Autenticación y sesiones

- Contraseñas con Argon2id. Producción exige como mínimo 64 MiB, costo 3 y paralelismo 1 por defecto; tests sólo reducen parámetros con `NODE_ENV=test` y variables explícitas.
- El navegador recibe un token opaco aleatorio de 256 bits. PostgreSQL almacena únicamente SHA-256 del token.
- No se usa JWT. Roles y UUID nunca viajan en la cookie.
- La cookie de sesión es HttpOnly, SameSite=Lax, Path=/, sin Domain y Secure en producción.
- Cada sesión tiene expiración inactiva y absoluta. `last_seen_at` se actualiza con throttling, no en cada request.
- Cambio de contraseña conserva la sesión actual y revoca las demás. Reset, desactivación y revocación administrativa invalidan las sesiones correspondientes.

## CSRF y origen

Cada sesión tiene un token CSRF aleatorio cuyo hash se almacena junto a la sesión. El valor legible se entrega en una segunda cookie y React lo devuelve en `X-CSRF-Token` para operaciones mutables. La comparación es segura. Además se rechaza todo `Origin` explícito que no esté en `CORS_ORIGINS`. CORS no se considera protección CSRF.

## Bloqueo

Por defecto se permiten cinco fallos dentro de 15 minutos y se bloquea la cuenta por 15 minutos. Login siempre responde el mismo 401 para cuenta inexistente, contraseña incorrecta, cuenta inactiva o bloqueada. `login_attempt` conserva sólo hash del identificador, usuario cuando existe, resultado, causa acotada, request ID, IP minimizada y user agent. Retención documentada: 90 días; la purga corresponde a mantenimiento con rol owner.

## Consistencia y auditoría

Operaciones críticas de usuario, contraseña, roles y sesiones escriben `audit_event` en la misma transacción que el cambio. Si falla la auditoría, el cambio se revierte. Fallos de login también se registran transaccionalmente con el intento. La aplicación sólo puede insertar auditoría: PostgreSQL le niega UPDATE, DELETE y TRUNCATE.

La protección del último ADMIN usa un advisory lock transaccional antes de desactivar o retirar el rol. El bootstrap repite la comprobación dentro de ese mismo lock para evitar dos primeros administradores concurrentes.

No se auditan passwords, hashes de password, tokens, hashes de token, cookies, cuerpos completos ni secretos de entorno.

## Maestros de facturación

- `issuer_company` conserva RUT canónico, tratamiento sugerido y tasa IVA `NUMERIC`; la tasa cruza PostgreSQL y HTTP como `string`.
- `client` admite `COMPLETE` y `PENDING_COMPLETION`. Solo el primero exige RUT y datos legales completos. El responsable sugerido es opcional y no restringe el catálogo global.
- `client_invoice_rule` es uno-a-uno con cliente y guarda requisitos OC/HES/contrato, emisor y tratamiento sugeridos y variante `STANDARD`/`HABITAT`. Ninguna regla se infiere del nombre.
- `receiver` pertenece a un cliente; su correo activo es único dentro de ese cliente.
- `product` usa una clave normalizada para rechazar duplicados de mayúsculas, espacios, tildes y plurales regulares, sin fusionar filas.
- `project_center` enlaza directamente cliente y producto. El tipo se controla por CHECK y contrato Zod; no existe `client_product`.

Las escrituras de maestros se ejecutan en el servicio PostgreSQL dentro de la misma transacción que `audit_event`. Si la auditoría crítica falla, la operación se revierte. `factuflow_app` puede leer, insertar y actualizar maestros, pero no borrarlos ni truncarlos. ADMIN modifica; ADMIN y COORDINATOR leen; una sesión sin estos roles recibe 403.

## RUT chileno

El dominio elimina puntos, guion y espacios, normaliza `K`, calcula el dígito verificador módulo 11 y persiste cuerpo+DV. La presentación vuelve al formato con puntos y guion. La base exige forma canónica y unicidad; el dominio asegura el DV. Los clientes pendientes pueden omitir RUT, pero si lo informan debe ser válido.
