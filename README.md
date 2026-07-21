# FactuFlow V1

Sistema de Solicitudes de Factura. Reemplaza el sistema anterior de MAS.

**Estado: Fase 5 — solicitudes exportadas y Excel transaccional.** Una solicitud nace únicamente al exportar un XLSX validado; queda inmutable con snapshots, folio y archivo exacto en PostgreSQL. No existen borradores. Ver `docs/PHASE_5_STATUS.md`.

---

## Cómo levantarlo (runbook)

> **Requisitos:** Node.js ≥ 22, npm ≥ 10, Docker Desktop.
> Ningún comando de aquí necesita secretos reales.

### 1 · Configuración

<details open>
<summary><b>PowerShell (Windows)</b></summary>

```powershell
Copy-Item .env.example .env
```

</details>

<details>
<summary><b>Bash (macOS / Linux)</b></summary>

```bash
cp .env.example .env
```

</details>

Abre `.env` y reemplaza los tres `cambiar-en-local` por contraseñas cualesquiera.
Son **locales**: no salen de tu equipo y `.env` está en `.gitignore`.

Genera contraseñas si prefieres:

```powershell
# PowerShell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | % {[char]$_})
```

```bash
# Bash
openssl rand -base64 24 | tr -d '/+=' | head -c 24; echo
```

> ⚠️ **Deben coincidir** entre sí: `FACTUFLOW_APP_PASSWORD` es la misma que aparece dentro de `DATABASE_URL_APP`, y `FACTUFLOW_OWNER_PASSWORD` la misma que en `DATABASE_URL_OWNER`. Si no coinciden, el API arranca y falla al conectar.

### 2 · Dependencias

```bash
npm install
```

Genera `package-lock.json`. **Commitealo** — la CI usa `npm ci` y lo necesita.

### 3 · PostgreSQL

```bash
npm run docker:up
```

Levanta PostgreSQL 16, el API y la web. Espera a que Postgres quede `healthy`:

```bash
docker compose ps
```

> El bootstrap (`infra/docker/postgres-initdb/`) crea los dos roles y la base **una sola vez**, al inicializar el volumen. Si cambias contraseñas o nombres de rol después, no se re-ejecuta: hace falta `npm run docker:reset` (borra el volumen).

### 4 · Migraciones

Se ejecutan **explícitamente**, nunca al arrancar el API:

```bash
npm run db:migrate
```

Usa `DATABASE_URL_OWNER` — el rol propietario. El API nunca la ve.

```bash
npm run db:status     # qué falta por aplicar (dry-run)
npm run db:rollback   # revierte la última migración
```

### 5 · Pruebas

```bash
npm run test:unit          # dominio, entorno, límites entre capas. Segundos, sin Docker.
npm run test:integration   # PostgreSQL 16 real vía Testcontainers. Necesita Docker.
npm test                   # todo
```

La primera corrida descarga `postgres:16-alpine` y tarda. Después, segundos.

### 5.1 · Crear el primer ADMIN

Después de aplicar migraciones, cuando aún no existe un ADMIN activo:

```bash
npm run user:bootstrap-admin
```

El comando solicita username, correo y nombre visible de forma interactiva. Genera una contraseña temporal aleatoria, guarda sólo Argon2id, la muestra una vez y exige cambiarla en el primer login. No admite contraseñas por argumentos ni crea usuarios desde migraciones. Para desarrollo use identidades ficticias con `example.invalid`.

### 6 · Comprobar que está vivo

```powershell
# PowerShell
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json -Depth 5
```

```bash
# Bash
curl -s http://localhost:3000/health | jq
```

Respuesta esperada:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 12,
  "checks": [{ "name": "postgres", "status": "ok", "latencyMs": 2 }]
}
```

`503` con `"status": "degraded"` significa que el API responde pero PostgreSQL no. Es correcto que lo diga.

| URL                          | Qué es                                   |
| ---------------------------- | ---------------------------------------- |
| http://localhost:5173/login  | Inicio de sesión                         |
| http://localhost:3000/health | Estado                                   |
| http://localhost:3000/docs   | OpenAPI, generado desde los esquemas Zod |

### 7 · Logs

```bash
npm run docker:logs                 # todo
docker compose logs -f api          # solo el API
docker compose logs -f postgres     # solo la base
```

### 8 · Detener

```bash
npm run docker:down    # detiene, conserva los datos
npm run docker:reset   # detiene y BORRA el volumen (re-ejecuta el bootstrap)
```

### Desarrollo sin Docker para el código

Con PostgreSQL en Docker y el código en tu máquina (recarga en caliente):

```bash
npm run docker:up      # y luego detén api y web:
docker compose stop api web
npm run dev            # levanta API y web localmente
```

---

## Todos los comandos

| Comando                                         | Qué hace                         |
| ----------------------------------------------- | -------------------------------- |
| `npm run dev`                                   | API y web en local, con recarga  |
| `npm run build`                                 | Compila todo                     |
| `npm run typecheck`                             | Tipos, incluidos los tests       |
| `npm run lint` / `lint:fix`                     | ESLint                           |
| `npm run format` / `format:check`               | Prettier                         |
| `npm test`                                      | Todas las pruebas                |
| `npm run test:unit`                             | Sin Docker                       |
| `npm run test:integration`                      | PostgreSQL real                  |
| `npm run db:migrate`                            | Aplica migraciones (rol owner)   |
| `npm run db:rollback`                           | Revierte la última               |
| `npm run db:status`                             | Qué falta (dry-run)              |
| `npm run user:bootstrap-admin`                  | Crea el primer ADMIN             |
| `npm run docker:up` / `down` / `logs` / `reset` | Entorno                          |
| `npm run verify`                                | Formato + lint + tipos + pruebas |

---

## Arquitectura

```
factuflow/
├── apps/
│   ├── api/                    Fastify + Kysely + PostgreSQL
│   │   ├── migrations/         SQL, node-pg-migrate
│   │   └── src/
│   │       ├── domain/         Reglas puras. No importa NADA.
│   │       ├── application/    Puertos y casos de uso
│   │       ├── infrastructure/ PostgreSQL, drivers
│   │       └── presentation/   HTTP
│   └── web/                    React + Vite
├── packages/shared-schemas/    Contratos Zod compartidos API ↔ web
├── infra/docker/               Dockerfiles y bootstrap de PostgreSQL
└── docs/                       Evidencia del sistema anterior
```

**Dirección de dependencias.** `presentation → application → domain` · `infrastructure → domain` · **`domain → nada`**.

No es una convención: ESLint la impone (`eslint.config.js`) y una prueba de guardia la verifica (`tests/guards/layer-boundaries.test.ts`). La prueba existe porque una regla de lint se silencia con un comentario y nadie lo nota en un diff grande.

---

## 🔴 La regla del dinero

**`NUMERIC` en la base · `string` en el transporte · `Decimal` en el cálculo. Nunca `number`, `REAL` ni `FLOAT`.**

No es purismo. El sistema anterior guardaba **todo** el dinero y la UF en `REAL` (float4):

```sql
uf_valor REAL,  monto_neto_clp REAL,  iva_pct REAL NOT NULL DEFAULT 0.19
```

`float4(40543.07)` = `40543.0703125`. El error se multiplica por el monto en UF: **+16 CLP en una solicitud de 50 000 UF**. Medido, no supuesto — ver `docs/ROUNDING_REGRESSION_CASES.md` R-06.

`node-postgres` ya entrega `NUMERIC` como `string` por defecto. El riesgo no es el default: es que alguien escriba `pg.types.setTypeParser(1700, parseFloat)` para «arreglar» un tipo incómodo. Por eso:

- `infrastructure/postgres/numeric-guard.ts` lo verifica **al arrancar**. Si la regla está rota, el API no se conecta.
- `tests/guards/numeric.test.ts` lo verifica contra PostgreSQL real, y falla a propósito cuando se registra un parser que devuelve `number`.

Conversión: **sólo** `toDecimal()` / `fromDecimal()`.

---

## Los dos roles de PostgreSQL

| Rol               | Quién lo usa             | Puede                                                                                                        |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `factuflow_owner` | **Sólo** las migraciones | Dueño del esquema                                                                                            |
| `factuflow_app`   | El API                   | Leer/escribir filas. **Ni `UPDATE` ni `DELETE` sobre `audit_event`.** No es dueño de nada. No puede `CREATE` |

**Esta separación es lo único que hace real el append-only.** Con una sola `DATABASE_URL`, la aplicación sería dueña de la tabla y podría reescribir su propia auditoría: «append-only» sería una intención, no un control.

Por eso el API recibe **únicamente** `DATABASE_URL_APP`, y `loadEnv` **rechaza el arranque en producción** si detecta `DATABASE_URL_OWNER` en su entorno.

Verificado por `tests/guards/audit-append-only.test.ts`: inserta como `factuflow_app`, intenta `UPDATE` y `DELETE`, y exige que PostgreSQL devuelva `42501`.

---

## Folios

`SF-AAAA-00001`. Un contador por año, con reserva atómica (`reserve_folio()`).

Dos defectos del sistema anterior que aquí no existen:

- **Sin bloqueo.** El legado traía todos los folios del año a memoria y hacía `MAX+1` en JavaScript. Dos exportaciones simultáneas obtenían el mismo folio.
- **Contador que arranca en 0.** Los folios `SF-2026-000xx` ya existen. `seed_folio_counter()` lo siembra desde el máximo histórico, y nunca retrocede.

`reserve_folio` es `SECURITY DEFINER`: la aplicación reserva folios pero **no puede tocar el contador** directamente.

La Fase 5 lo invoca sólo dentro de la transacción final de exportación. Abrir el formulario, previsualizar o duplicar en memoria no reserva nada. Un fallo de persistencia o auditoría revierte también el contador.

---

## UF y cálculo tributario

La Fase 4 incorpora una caché PostgreSQL por fecha y la cadena `caché → SII → mindicador.cl`. La fecha siempre es explícita: si el valor exacto no existe o aún no fue publicado, FactuFlow no inventa ni sustituye otro día.

El motor puro `LEGACY_V1` aplica esta secuencia:

1. cada CP/MS calcula `cantidad UF × valor UF` y redondea `ROUND_HALF_UP` a CLP;
2. suma los CLP ya redondeados para obtener el neto;
3. para `AFFECTED`, calcula IVA `0.19` y lo eleva al siguiente múltiplo de $10;
4. para `EXEMPT`, IVA es `0`;
5. total = neto + IVA.

Todos los decimales cruzan API y PostgreSQL como `string`; el dominio usa `decimal.js`. La herramienta protegida `/herramientas/calculo` sólo previsualiza: no persiste solicitudes ni reserva folios.

## Solicitudes exportadas y Excel

No hay estado borrador. `POST /invoice-requests/export` exige sesión ADMIN/COORDINATOR, CSRF e `Idempotency-Key`; revalida maestros y UF, reutiliza `LEGACY_V1`, genera y valida el XLSX en memoria y recién entonces abre la transacción que reserva folio, inserta snapshots/líneas/receptores, almacena el `BYTEA` con SHA-256 y audita. Si algo falla, no existe solicitud y el folio no se consume.

El historial está en `/solicitudes`; `/solicitudes/nueva` crea y descarga, el detalle es inmutable y duplicar sólo precarga un formulario nuevo en memoria. El archivo almacenado se descarga byte por byte, sin regenerarlo. La plantilla disponible es `TECHNICAL_V1_UNAPPROVED`: reproduce el mapa de celdas y las variantes `STANDARD`/`HABITAT`, pero la comparación visual final queda pendiente porque la plantilla histórica aprobada no está en este repositorio.

---

## Documentación

| Documento                           | Qué contiene                                        |
| ----------------------------------- | --------------------------------------------------- |
| `docs/PHASE_1_STATUS.md`            | **Qué está verificado y qué no.** Empieza por aquí  |
| `docs/PHASE_2_STATUS.md`            | Estado, pruebas y límites de autenticación          |
| `docs/PHASE_3_STATUS.md`            | Estado y límites de maestros de facturación         |
| `docs/PHASE_4_STATUS.md`            | Estado y límites de UF y motor tributario           |
| `docs/PHASE_5_STATUS.md`            | Solicitudes inmutables, transacción y XLSX          |
| `docs/ARCHITECTURE.md`              | Identidad, sesiones, maestros y auditoría           |
| `docs/RUNBOOK.md`                   | Operación segura de usuarios y maestros             |
| `docs/LEGACY_BACKEND_EVIDENCE.md`   | Qué prueba `back.zip`. Incluye riesgos de seguridad |
| `docs/UF_LEGACY_BEHAVIOR.md`        | UF real: el «endpoint del SII» es un scrape de HTML |
| `docs/ROUNDING_REGRESSION_CASES.md` | IVA y redondeos, con aritmética verificada          |
| `docs/EXCEL_LEGACY_BEHAVIOR.md`     | Celdas exactas y la variante AFP Habitat            |

---

## Seguridad

`.gitignore` es una barrera, no una comodidad. **Nunca** se versionan: `.env`, `back.zip`, `bdmaster.sql`, `seed.json`, `*.sqlite*` (incluidos `-wal` y `-shm`, que contienen datos aunque el `.sqlite` parezca limpio), `*.xlsx`, `storage/`.

La CI lo verifica en cada PR (`secrets-hygiene`).

> 🔴 **Riesgo abierto:** el `.env` dentro de `back.zip` contiene un **`SLACK_BOT_TOKEN` real**. Su valor no se reprodujo en ninguna parte, pero el token viajó dentro de un ZIP: **debe rotarse**. Ver `docs/LEGACY_BACKEND_EVIDENCE.md` §1.

Ningún `password_hash` del sistema anterior se migra. Nunca.

---

## Qué NO hay todavía

Borradores, edición o eliminación de solicitudes, estados distintos de `EXPORTED`, aprobación/rechazo, envío de correos, exportación de órdenes de compra, almacenamiento externo, importación de `bdmaster.sql`, datos históricos, proyecciones, Slack ni solicitudes programadas.

Todo eso llega en fases posteriores, **con aprobación explícita**. Ver `docs/PHASE_1_STATUS.md`.
