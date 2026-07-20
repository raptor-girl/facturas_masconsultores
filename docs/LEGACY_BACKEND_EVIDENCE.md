# LEGACY_BACKEND_EVIDENCE — Qué contiene `back.zip` y qué prueba

**Fecha:** 2026-07-17 · **Archivo:** `back.zip` · SHA-256 `153f5a4f2ce4ca72eb629dd155600518de61b15298150a9c1546fb6832ed0d41` · 80 entradas · íntegro.

Este documento y sus tres hermanos (`UF_LEGACY_BEHAVIOR.md`, `ROUNDING_REGRESSION_CASES.md`, `EXCEL_LEGACY_BEHAVIOR.md`) existen porque **`back.zip` es el primer insumo real recibido en todo el proyecto**. Hasta ahora, cada afirmación sobre el sistema anterior venía de documentos derivados, y tres de ellas ya habían resultado falsas (C-10, C-14, C-20).

**`back.zip` no se usa como base del proyecto nuevo.** No se copió su arquitectura, ni sus migraciones, ni su código. Se inspeccionó para documentar comportamiento.

---

## 1. 🔴 RIESGOS DE SEGURIDAD ENCONTRADOS — acción requerida

| #        | Hallazgo                                                              | Evidencia                                                                                                                                                                                                                                       | Acción                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-01** | **`back/.env` versionado dentro del ZIP, con un token de Slack real** | El archivo declara **10 claves**, entre ellas `SLACK_BOT_TOKEN` y `GOOGLE_SA_JSON_PATH`. **Ningún valor se reprodujo, ni aquí ni en el chat.** El archivo fue leído sólo para enumerar nombres y eliminado del entorno de trabajo acto seguido. | **Rotar `SLACK_BOT_TOKEN` cuanto antes.** Un token que viajó por correo/chat dentro de un ZIP debe considerarse comprometido, aunque nadie lo haya mirado. Revisar también la cuenta de servicio de Google referida por `GOOGLE_SA_JSON_PATH`. |
| **S-02** | **Base SQLite de producción con datos reales, más WAL y SHM**         | `back/storage/facturapp.sqlite`, `.sqlite-wal`, `.sqlite-shm`                                                                                                                                                                                   | **No se extrajo, no se abrió, no se copió.** Los archivos `-wal`/`-shm` importan: contienen transacciones que aún no llegaron al `.sqlite`, así que borrar sólo el `.sqlite` no elimina los datos. Ya están bloqueados en `.gitignore`.        |
| **S-03** | **13 Excel de exportaciones con clientes reales**                     | `back/storage/exports/` — COPEC, ENAEX, MAGOTTEAUX, SOPROLE, TRANSELEC, y dos con folios `SF-2026-0000x`                                                                                                                                        | No se copiaron al repositorio. `*.xlsx` y `storage/` están en `.gitignore`. Su estructura sí se documentó (ver `EXCEL_LEGACY_BEHAVIOR.md`).                                                                                                    |
| **S-04** | **`seed/seed.json` con datos de personas**                            | 176 líneas                                                                                                                                                                                                                                      | No se copió. Ya bloqueado.                                                                                                                                                                                                                     |
| **S-05** | Rutinas de manejo de contraseñas en el repositorio legado             | `src/rotate-passwords.js`, `src/security/password-audit.js`                                                                                                                                                                                     | No se inspeccionaron sus valores ni se migró ningún hash. **Ningún `password_hash` del sistema anterior se migra jamás** — ya era regla, y el hallazgo la confirma.                                                                            |

**Ninguno de estos archivos entró a `/home/claude/factuflow`.** La extracción excluyó explícitamente `back/.env` y `back/storage/*`, y se verificó después de extraer.

Añadido a `.gitignore` en esta sesión: `back.zip`, `back/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db*`, `storage/`, `exports/`.

---

## 2. Qué contiene (inventario)

| Categoría       | Archivos                                   | Uso                                               |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| Código fuente   | 48 `.js`                                   | **Inspeccionado** — es la evidencia buscada       |
| Plantilla Excel | `templates/solicitud-factura-ejemplo.xlsx` | La plantilla oficial. Existe.                     |
| Exportaciones   | 13 `.xlsx` en `storage/exports/`           | Estructura documentada; archivos no copiados      |
| Configuración   | `package.json`, `.env`                     | `package.json` inspeccionado; `.env` sólo nombres |
| Datos           | `seed.json`, SQLite + WAL/SHM              | No inspeccionados                                 |

**Stack legado:** Express + SQLite → PostgreSQL (migración a medias: hay `db-async.js`, `postgres.js` y `migrate-data-sqlite-to-postgres.js` conviviendo).

---

## 3. Lo que esta evidencia RESUELVE

| Decisión                                | Estado anterior                                             | Ahora                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-05** — UF: endpoint, formato, fecha | 🔴 Bloqueada, «nada puede inventarse»                       | ✅ **RESUELTA con evidencia.** Ver `UF_LEGACY_BEHAVIOR.md`                                                                                            |
| **D-07** — tasa de IVA y redondeos      | 🔴 El mayor bloqueo de negocio                              | ✅ **RESUELTA con evidencia.** 19 %, IVA al alza a múltiplo de $10, neto por CP en cascada. Ver `ROUNDING_REGRESSION_CASES.md`                        |
| **D-09 / C-11** — variante AFP Habitat  | 🔴 Tres descripciones incompatibles                         | ✅ **RESUELTA.** Ninguna de las tres era del todo correcta. Ver `EXCEL_LEGACY_BEHAVIOR.md`                                                            |
| **T-07** — folio con `COUNT(*)`         | Documentado como `COUNT(*)`                                 | ⚠️ **La documentación estaba equivocada.** Era `MAX+1` calculado en memoria de JavaScript, sin bloqueo. Peor de lo descrito, y el arreglo es el mismo |
| **T-08** — folio impreso en el Excel    | Se asumía que sí                                            | ❌ **FALSO. El folio no aparece en el Excel ni en el nombre del archivo.** Mi propia justificación era errónea; corregida en la migración 003         |
| **C-14** — corrupción por `float4`      | Refutada como «confirmada en producción», riesgo real en UF | ✅ **CONFIRMADA la causa raíz.** Todas las columnas de dinero y UF son `REAL` en el esquema legado                                                    |

---

## 4. 🔴 Confirmación de la causa raíz de C-14

Del esquema legado (`src/postgres-migrations.js`):

```
uf_valor        REAL
monto_neto_clp  REAL DEFAULT 0
monto_iva_clp   REAL DEFAULT 0
monto_total_clp REAL DEFAULT 0
monto_uf        REAL
subtotal_clp    REAL DEFAULT 0
iva_pct         REAL NOT NULL DEFAULT 0.19
```

**`REAL` en PostgreSQL es `float4`.** Esto confirma exactamente lo que la revisión de documentación había deducido por aritmética, y que `DATA_QUALITY_ISSUES.md` había «confirmado» con ejemplos equivocados:

- El daño **no** estaba en los montos CLP: un entero hasta 16.777.216 se representa exacto en `float4`. Los cuatro ejemplos que el documento citaba como corruptos eran exactos.
- El daño está en **`uf_valor`**: `40543.07` se almacena como `40543.0703125`, y ese error **se multiplica por el monto en UF**.
- Y en **`iva_pct REAL DEFAULT 0.19`**: `0.19` tampoco es representable en `float4`. La tasa de IVA misma está almacenada con error.

**Regla que se conserva y ahora tiene demostración:** `NUMERIC` en la base, `string` en el transporte, `Decimal` en el cálculo. Nunca `number`, `REAL` ni `FLOAT`. Ver `apps/api/src/infrastructure/postgres/numeric-guard.ts` y su prueba de guardia.

---

## 5. Problemas del sistema anterior que NO deben replicarse

| #        | Problema                                                                                                                                                                                                                   | Evidencia                                                 | V1                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **L-01** | **Folio sin bloqueo.** `generarFolio()` trae todos los folios del año a memoria y calcula `MAX+1` en JavaScript. Dos exportaciones concurrentes obtienen el mismo folio.                                                   | `src/utils/folio.js`                                      | `reserve_folio()` atómico con bloqueo de fila                                        |
| **L-02** | **Folio con el año del reloj**, no el de la solicitud: `new Date().getFullYear()`. Una solicitud de diciembre creada en enero recibe folio del año equivocado.                                                             | `src/utils/folio.js:4`                                    | `reserve_folio(p_year)` recibe el año explícito                                      |
| **L-03** | **Dos implementaciones distintas de `generarFolio`** conviviendo.                                                                                                                                                          | `utils/folio.js` y `routes/solicitudes-programadas.js:11` | Una sola, en la base                                                                 |
| **L-04** | **Regla de negocio hardcodeada por nombre de cliente**: `esHabitat()` hace `nombre_corto.includes('HABITAT')`. Renombrar el cliente cambia la factura.                                                                     | `src/services/exportador.js:41`                           | Prohibido por D-06. La variante sale de `client_invoice_rule.excel_template_variant` |
| **L-05** | **Exportar MUTA la base.** Generar el Excel hace `UPDATE solicitud_cp` y `UPDATE solicitud_factura`. «Descargar un documento» reescribe montos.                                                                            | `exportador.js:150-165`                                   | Excel en memoria; los montos se congelan al crear, no al descargar (R-06)            |
| **L-06** | **La fórmula del Excel y el neto guardado no coinciden.** El Excel escribe `=sumaUF*valorUF`, pero el neto guardado es la suma de CP **ya redondeados** uno a uno. Con varios CP, ambos difieren.                          | `exportador.js:118-124` vs `:141`                         | Ver `ROUNDING_REGRESSION_CASES.md` — **requiere decisión de Finanzas**               |
| **L-07** | **Duplicar crea la solicitud de inmediato**, con folio, en estado `PENDIENTE OC / HES`.                                                                                                                                    | `routes/solicitudes.js:794-845`                           | D-03: nada se persiste hasta exportar                                                |
| **L-08** | **Duplicar pierde fechas y montos.** No copia `uf_fecha`, `uf_valor`, `monto_neto_clp`, `monto_iva_clp` ni `monto_total_clp`; pone `fecha_solicitud = hoy`. Pero sí copia `subtotal_clp` de los ítems, que queda obsoleto. | `routes/solicitudes.js:808-825`                           | La duplicación trabaja en memoria y recalcula                                        |
| **L-09** | **Nombre de archivo sin folio y colisionable.** `Solicitud_factura_{CLIENTE}_{MES}.xlsx`: dos solicitudes del mismo cliente y mes se pisan en disco.                                                                       | `routes/exportaciones.js:34`                              | Ver `EXCEL_LEGACY_BEHAVIOR.md` — pendiente de decisión                               |
| **L-10** | **Excel guardado en disco local** (`storage/exports/`), con la BD guardando sólo la ruta. Un contenedor efímero pierde el documento.                                                                                       | `routes/exportaciones.js:10`                              | T-05: `BYTEA` en la base                                                             |

---

## 6. Reglas del legado que SÍ se conservan

| Regla                                                                         | Evidencia                                   | Por qué se conserva                                |
| ----------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Ante fallo total de UF, **no se inventa un valor**: se lanza `UF_UNAVAILABLE` | `services/uf.js:69`                         | Correcto. Es preferible no facturar a facturar mal |
| **Caché de UF por fecha**, con `source` y `obtenido_at`                       | `services/uf.js:23,72`                      | Trazabilidad de qué valor se usó y de dónde salió  |
| **Formato de folio** `SF-AAAA-00001`                                          | `utils/folio.js:17`                         | Ya implementado en `domain/folio/folio.ts`         |
| **IVA al alza al múltiplo de $10**                                            | `solicitudes.js:172`                        | Confirmado por negocio y por código                |
| **Neto = suma de CP convertidos y redondeados uno a uno**                     | `solicitudes.js:202,232`                    | Confirmado por negocio y por código                |
| **Empresa exenta ⇒ IVA 0**                                                    | `seed.js:186`, `postgres-migrations.js:545` | Coherente con D-06                                 |

---

## 7. Lo que esta evidencia NO resuelve

| Sigue abierto                              | Por qué                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-00 — `bdmaster.sql`**                  | `back.zip` trae el **código**, no el dump del master. Los conteos (82, 54, 56, 270) siguen sin poder verificarse. La SQLite adjunta **no** es el master y no se abrió |
| **D-01 / D-02** — FLESAN, Salmones Austral | Requieren el master                                                                                                                                                   |
| **D-04b** — estado `ANULADA`               | Decisión de negocio                                                                                                                                                   |
| **L-06** — fórmula vs. neto                | El legado es **internamente inconsistente**. No hay «comportamiento actual» que preservar: hay que elegir. Decide Finanzas                                            |
| **D-09** — golden file de AFP Habitat      | El código está claro, pero **no existe ningún Excel exportado de Habitat** entre los 13                                                                               |
| **D-10** — ¿el estilo es contractual?      | Decisión de negocio                                                                                                                                                   |
