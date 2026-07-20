# PHASE_1_STATUS — Qué está hecho, qué está verificado y qué no

**Fecha:** 2026-07-17 · **Fase 1 — fundaciones técnicas**

Este documento existe para una sola cosa: **que nadie confunda «escrito» con «probado».** El entorno donde se construyó esta fase no tiene red, ni Docker, ni PostgreSQL. Todo el código está completo; **ninguna prueba se ejecutó**. Lo que sigue lo dice sin adornos.

---

## 1. 🔴 Limitación del entorno de construcción

| Recurso                   | Estado                      | Consecuencia                                                                  |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| Node 22.22.2 / npm 10.9.7 | ✅ Disponible               | Se usó para validaciones estáticas                                            |
| **Registro npm**          | ❌ **Bloqueado (HTTP 403)** | **No se ejecutó `npm install`.** No hay `node_modules` ni `package-lock.json` |
| **Docker**                | ❌ No instalado             | **No se ejecutó `docker compose`** ni Testcontainers                          |
| **PostgreSQL**            | ❌ No instalado             | **No se aplicó ninguna migración**                                            |

**Consecuencias que hay que aceptar antes de leer nada más:**

- **No se afirma que TypeScript compile.** No se ejecutó `tsc`.
- **No se afirma que las pruebas pasen.** No se ejecutó Vitest.
- **No se afirma que las migraciones apliquen.** No hubo PostgreSQL contra el cual aplicarlas.
- **No se afirma que Compose levante.** No hubo Docker.
- **No se fabricó ningún `package-lock.json`.** Un lockfile inventado es peor que ninguno: mentiría sobre árboles de dependencias que nadie resolvió.

**Los 12 criterios de término de la Fase 1 se verifican en tu máquina, no aquí.** El runbook del `README.md` está escrito para eso.

---

## 2. Verificado en este entorno

Esto sí se ejecutó, con estos resultados:

| #   | Validación                                                                                       | Resultado                           |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 1   | Los **13 archivos JSON** parsean                                                                 | ✅ 13/13                            |
| 2   | Sintaxis de `00-bootstrap-roles.sh` (`bash -n`)                                                  | ✅                                  |
| 3   | YAML de `docker-compose.yml` y `.github/workflows/ci.yml`                                        | ✅ ambos parsean                    |
| 4   | Los 3 workspaces resuelven; las 3 referencias de TypeScript apuntan a `tsconfig.json` existentes | ✅                                  |
| 5   | **24 imports relativos**, todos apuntan a archivos existentes                                    | ✅ 0 rotos                          |
| 6   | Todo paquete importado está declarado como dependencia                                           | ✅ en los 3 workspaces              |
| 7   | **Ningún `setTypeParser`** fuera del guard                                                       | ✅                                  |
| 8   | **Ninguna columna `REAL`/`FLOAT`/`DOUBLE`/`MONEY`** en las migraciones                           | ✅ verificado ignorando comentarios |
| 9   | Ningún `.env`, `back.zip`, `.sqlite*`, `.xlsx`, `bdmaster*`, `seed.json` dentro del repositorio  | ✅                                  |
| 10  | Ningún token en el repositorio                                                                   | ✅                                  |
| 11  | Las tablas creadas coinciden con la lista aprobada                                               | ✅ 6/6                              |
| 12  | `audit_event` sólo otorga `SELECT, INSERT` a `factuflow_app`                                     | ✅ leído en la migración            |

**Aritmética verificada** (con Python, recalculada — no copiada de ningún documento): los casos R-01 a R-06 de `ROUNDING_REGRESSION_CASES.md`. Un primer intento del helper de redondeo estuvo **mal** (la división entera de `Decimal` trunca en vez de hacer floor); se detectó, se corrigió y se volvió a verificar contra la semántica de `Math.ceil` de JavaScript.

---

## 3. Preparado, pero NO ejecutado

| Qué                                                 | Cómo comprobarlo                          |
| --------------------------------------------------- | ----------------------------------------- |
| Instalación de dependencias                         | `npm install`                             |
| Compilación de TypeScript                           | `npm run typecheck`                       |
| ESLint y Prettier                                   | `npm run lint` · `npm run format:check`   |
| Migraciones sobre base vacía                        | `npm run db:migrate`                      |
| Reversión                                           | `npm run db:rollback`                     |
| `docker compose` levanta los 3 servicios            | `npm run docker:up`                       |
| Bootstrap de los dos roles                          | `npm run docker:up` y luego `\du` en psql |
| `/health` responde y verifica PostgreSQL            | `curl localhost:3000/health`              |
| **Guardia NUMERIC**                                 | `npm run test:integration`                |
| **Guardia append-only**                             | idem                                      |
| **Guardia de concurrencia de folios** (50 reservas) | idem                                      |
| Guardia de límites entre capas                      | `npm run test:unit`                       |
| Pruebas de entorno y de dominio                     | `npm run test:unit`                       |
| CI                                                  | Al abrir el primer PR                     |

### Riesgo real de esta situación

**Las versiones de las dependencias no están verificadas.** Se declararon por conocimiento, no resolviendo el árbol:

| Paquete                                   | Versión declarada                 | Riesgo                                                                                                                                       |
| ----------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastify`                                 | `^5.1.0`                          | Bajo                                                                                                                                         |
| `fastify-type-provider-zod`               | `^4.0.2`                          | ⚠️ **Medio** — la compatibilidad con Fastify 5 y con Zod 3 es la más frágil del conjunto                                                     |
| `@fastify/swagger` / `swagger-ui`         | `^9.2.0` / `^5.1.0`               | ⚠️ Medio — deben ser las de Fastify 5                                                                                                        |
| `@fastify/cors` / `helmet` / `rate-limit` | `^10.0.1` / `^12.0.1` / `^10.1.1` | ⚠️ Medio — idem                                                                                                                              |
| `kysely`                                  | `^0.27.4`                         | Bajo                                                                                                                                         |
| `node-pg-migrate`                         | `^7.6.1`                          | ⚠️ **Medio** — se invoca por **CLI** (`npx node-pg-migrate up`) justamente para no depender de su API programática, que cambió entre v6 y v7 |
| `@testcontainers/postgresql`              | `^10.13.2`                        | Bajo                                                                                                                                         |

**Es la primera cosa que puede fallar en tu `npm install`.** Si algo no resuelve, es un ajuste de versiones, no un problema de diseño.

---

## 4. Desviaciones respecto de lo aprobado

Tres, todas deliberadas y todas reportadas:

### 4.1 · La tabla `role` se llama `app_role`

**Aprobado:** `role` · **Implementado:** `app_role`

`ROLE` en PostgreSQL ya significa otra cosa, y en este proyecto significa exactamente lo que está al lado: `factuflow_owner` y `factuflow_app`. Una tabla `role` que contiene `ADMIN` y `COORDINATOR`, junto a roles de PostgreSQL llamados igual, es una confusión garantizada en cada revisión de código. Es el mismo concepto con un nombre que no colisiona.

**Reversible en un renombre si prefieres `role`.**

### 4.2 · `login_attempt` fue retirada

Existía en la versión anterior de la migración 002. **No está en la lista de tablas aprobadas** y se retiró.

Sólo tiene sentido junto al bloqueo por N intentos fallidos, que es autenticación —Fase 2—, y crearla ahora obligaba a fijar una retención (D-11) que nadie decidió. Se reintroduce con el login real.

### 4.3 · Argon2id está preparado, no implementado

La columna `app_user.password_hash` existe y está documentada como `argon2id`. **No hay ninguna dependencia de hashing instalada ni ninguna función de verificación.** Hashear sin login es código muerto.

**Además: la migración no inserta ningún usuario.** Ni siquiera un ADMIN inicial — está bloqueado por **D-08** (los coordinadores no tienen correo registrado y `email` es `NOT NULL`). La primera cuenta se creará cuando esa decisión se resuelva.

---

## 5. Alcance: qué se construyó

| Área                                                                              | Estado      |
| --------------------------------------------------------------------------------- | ----------- |
| Monorepo, npm workspaces, referencias de TypeScript                               | ✅          |
| TypeScript estricto (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, …) | ✅          |
| API Fastify + Zod + OpenAPI desde los esquemas                                    | ✅          |
| `GET /health` con verificación real de PostgreSQL (200 / 503)                     | ✅          |
| Errores centralizados, request ID, logs redactados, cierre ordenado               | ✅          |
| CORS con orígenes explícitos, helmet, rate limiting                               | ✅          |
| Web: scaffold React + Vite que comprueba `/health`                                | ✅          |
| PostgreSQL 16, `citext`, dos roles, permisos mínimos                              | ✅          |
| 3 migraciones SQL con `Up` y `Down`                                               | ✅          |
| Auditoría append-only por permisos                                                | ✅          |
| `folio_counter` + `reserve_folio()` atómico + `seed_folio_counter()`              | ✅          |
| 4 guardias: NUMERIC, append-only, concurrencia de folios, límites entre capas     | ✅ escritas |
| Docker Compose único, Dockerfiles, `.dockerignore`                                | ✅          |
| CI con instalación, lint, tipos, pruebas, build e higiene de secretos             | ✅          |
| README con runbook (PowerShell y Bash)                                            | ✅          |

## 6. Fuera de alcance — no implementado a propósito

Login funcional · usuarios reales · CRUD de clientes, receptores, responsables, productos, CP/MS · creación de solicitudes · duplicación · UF · motor de cálculos · Excel · migración del master · frontend real.

`invoice_request` **no existe**. Ninguna tabla de negocio se creó.

---

## 7. Decisiones abiertas que bloquean fases posteriores

| #               | Decisión                                                                                                                                                                  | Decide       | Bloquea                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------- |
| **D-00**        | `bdmaster.sql` nunca fue entregado (falló 3 veces). `back.zip` trae el **código**, no el dump. Los conteos (82, 54, 56, 270) siguen sin verificar                         | Cliente      | Migración de datos          |
| **D-04b**       | ¿Existe el estado `ANULADA`?                                                                                                                                              | Negocio      | Modelo de estados           |
| **D-08**        | Correos de los 5 coordinadores                                                                                                                                            | Negocio      | **Crear el primer usuario** |
| **R-02**        | El Excel escribe `=sumaUF*valorUF` pero guarda la suma de CP redondeados. **Difieren en 1 peso.** El legado se contradice a sí mismo: no hay comportamiento que preservar | **Finanzas** | Excel                       |
| **R-07 / R-08** | El legado permite fijar el neto y el CLP de cada CP **a mano**. Ningún documento de V1 lo menciona                                                                        | Negocio      | Cálculos                    |
| **UF §6**       | El «endpoint del SII» es un **scrape de HTML**. ¿Se conserva, o `mindicador.cl` pasa a principal?                                                                         | Negocio      | UF                          |
| **UF §4**       | La UF sale de `uf_fecha`, y si falta, de **hoy**. La inducción dice «el día de la facturación». No coinciden                                                              | Negocio      | UF                          |
| **D-09b**       | ¿El nombre del archivo lleva el folio? Hoy no, y dos solicitudes del mismo cliente y mes **se pisan**                                                                     | Negocio      | Excel                       |
| **D-09**        | No existe **ningún** Excel exportado de AFP Habitat ni **ningún** caso exento entre los 13 archivos reales                                                                | Negocio      | Golden files                |

---

## 8. 🔴 Riesgo de seguridad abierto

**El `.env` dentro de `back.zip` contiene un `SLACK_BOT_TOKEN` real**, más rutas a credenciales de Google.

Su valor **no se reprodujo en ninguna parte** —ni en el chat, ni en un archivo, ni en un log— y el archivo se eliminó del entorno de trabajo tras leer sólo los nombres de las claves. Pero el token viajó dentro de un ZIP por un canal no cifrado.

**Acción: rotar el token.** Un secreto que salió de su bóveda está comprometido, aunque nadie lo haya mirado.

Detalle completo en `LEGACY_BACKEND_EVIDENCE.md` §1.

---

## 9. Qué hacer ahora

1. `npm install` — y **commitear `package-lock.json`**.
2. `npm run verify` — formato, lint, tipos y pruebas. **Aquí es donde aparecerán los desajustes de versiones**, si los hay.
3. `npm run docker:up && npm run db:migrate` — y recorrer los 12 criterios de término.
4. **Rotar el `SLACK_BOT_TOKEN`.**
5. Llevar a negocio las decisiones de §7. **R-02 y D-08 son las que más bloquean.**

**La Fase 2 no empieza sin aprobación explícita.**
