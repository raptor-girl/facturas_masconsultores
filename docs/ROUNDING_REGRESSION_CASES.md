# ROUNDING_REGRESSION_CASES — Reglas de cálculo del legado y casos de regresión

**Estado: ✅ VERIFICADO CON CÓDIGO REAL.** Fuente: `back.zip` → `src/routes/solicitudes.js`, `src/services/exportador.js`, `src/postgres-migrations.js`, `src/seed.js`.

**Esto resuelve D-07**, que era el mayor bloqueo de negocio del proyecto. Toda la aritmética de este documento fue **recalculada y verificada**, no copiada.

> **Nada de esto se implementa en la Fase 1.** El motor de cálculo está fuera del alcance aprobado. Son casos de regresión para la fase que corresponda.

---

## 1. Las reglas, tal como están en el código

```js
// src/routes/solicitudes.js:172
function redondearIvaCLP(valor) {
  return Math.ceil((Number(valor) || 0) / 10) * 10;
}

// src/routes/solicitudes.js:202  — conversión por CP
if (montoUF > 0 && ufValor) return Math.round(montoUF * Number(ufValor));

// src/routes/solicitudes.js:232-237  — totales
const netoAutomatico = cps.reduce((sum, cp) => sum + montoClpDesdeCP(cp, ufValor), 0);
const ivaPct = (empresa && empresa.iva_pct) || 0.19;
const ivaCLP = afectoIva ? redondearIvaCLP(netoCLP * ivaPct) : 0;
const total = netoCLP + ivaCLP;
```

| Regla                 | Comportamiento comprobado                                                | ¿Se conserva?                                                   |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Conversión UF→CLP** | Cada CP por separado: `round(montoUF × valorUF)`, medio hacia arriba     | ✅ **Sí** — confirmado por negocio y por código                 |
| **Neto**              | Suma de los CP **ya redondeados** (cascada)                              | ✅ **Sí**                                                       |
| **Tasa de IVA**       | `empresa_emisora.iva_pct`, por defecto **0.19**                          | ✅ **Sí**                                                       |
| **Afecto / exento**   | `empresa_emisora.afecto_iva`                                             | ⚠️ **Cambia por D-06**: pasa a ser atributo de la **solicitud** |
| **IVA**               | `ceil(neto × tasa / 10) × 10` — **al alza al siguiente múltiplo de $10** | ✅ **Sí**                                                       |
| **Total**             | `neto + IVA`                                                             | ✅ **Sí**                                                       |
| **Exento**            | `afecto_iva = 0` ⇒ `iva_pct = 0` ⇒ IVA = 0                               | ✅ **Sí**                                                       |

> **`NORMALIZATION_PLAN.md` §2 estaba equivocado.** Decía «nunca en cascada por cada CP» y acto seguido especificaba una cascada. La contradicción que la revisión había marcado se resuelve **a favor de la cascada**: es lo que el sistema hace y lo que negocio confirmó.

### La tasa de IVA sí existía

`DATABASE_DESIGN.md` afirmaba que la tasa «no está en ninguna parte: ni columna, ni tabla, ni constante» (T-09). **Era inexacto respecto del legado:** existe como `empresa_emisora.iva_pct REAL NOT NULL DEFAULT 0.19`, y `MAS_CAPACITACION` se siembra con `afecto_iva=0, iva_pct=0`. Lo que faltaba era en el **diseño de V1**, y ya está corregido (`invoice_request.iva_rate`, congelada).

---

## 2. Casos de regresión — aritmética verificada

Valor de referencia: **UF = 40 543,07**

### R-01 · Un CP, afecto

|                     |                                          |
| ------------------- | ---------------------------------------- |
| Entrada             | 1 CP = 150,5 UF · empresa afecta (19 %)  |
| `150,5 × 40 543,07` | `6 101 732,035`                          |
| **Neto**            | `round(…)` → **6 101 732**               |
| IVA bruto           | `6 101 732 × 0,19` = `1 159 329,08`      |
| **IVA**             | `ceil(115 932,908) × 10` → **1 159 330** |
| **Total**           | **7 261 062**                            |

### R-02 · 🔴 Dos CP — la inconsistencia interna del legado (L-06)

|                                        |                                                             |
| -------------------------------------- | ----------------------------------------------------------- |
| Entrada                                | CP1 = 10,5 UF · CP2 = 20,3 UF                               |
| CP1                                    | `425 702,235` → **425 702**                                 |
| CP2                                    | `823 024,321` → **823 024**                                 |
| **Neto guardado (cascada)**            | **1 248 726**                                               |
| **Fórmula que se escribe en el Excel** | `=30.8*40543.07` → evalúa a `1 248 726,556` → **1 248 727** |
| **Diferencia**                         | **1 peso**                                                  |

El exportador escribe en `C15` una **fórmula** (`sumaUF × valorUF`) cuyo `result` precalculado es el neto en cascada. **La fórmula y el valor no coinciden.** Mientras nadie recalcule el libro, se ve `1 248 726`; al recalcular, Excel muestra `1 248 726,556`.

Y hay un segundo efecto: el **IVA** se calcula sobre el neto en cascada, así que un Excel recalculado puede mostrar un neto que no cuadra con su propio IVA.

> **🔴 PENDIENTE DE FINANZAS.** Aquí **no hay «comportamiento actual» que preservar**: el legado se contradice a sí mismo. Hay que elegir:
>
> **(A)** El Excel lleva el **valor** de la cascada, sin fórmula. Coherente con el neto y con el IVA. Se pierde la fórmula visible.
> **(B)** El Excel lleva una fórmula que **reproduzca la cascada** (`=ROUND(uf1*v,0)+ROUND(uf2*v,0)`). Coherente y visible; más larga.
> **(C)** Se cambia la regla a «sumar UF y multiplicar una vez». **Cambia montos facturados.** No se hace sin autorización expresa.
>
> **Recomendación técnica:** **(B)**. Conserva la transparencia que la fórmula buscaba y elimina la contradicción, sin tocar ningún monto.

### R-03 · IVA al alza al múltiplo de $10

| Neto      | IVA bruto    | IVA final                            | Total     |
| --------- | ------------ | ------------------------------------ | --------- |
| 1 000     | 190,00       | **190** _(múltiplo exacto: no sube)_ | 1 190     |
| 1 001     | 190,19       | **200** _(sube $9,81)_               | 1 201     |
| 1 248 726 | 237 257,94   | **237 260**                          | 1 485 986 |
| 6 101 732 | 1 159 329,08 | **1 159 330**                        | 7 261 062 |

El salto de 1 000 → 1 001 (IVA 190 → 200) no es un error: es exactamente lo que `Math.ceil(x/10)*10` hace, y negocio lo confirmó.

### R-04 · Exento

|           |                                                      |
| --------- | ---------------------------------------------------- |
| Entrada   | Neto 1 248 726 · Más Capacitación (`afecto_iva = 0`) |
| **IVA**   | **0**                                                |
| **Total** | **1 248 726**                                        |

### R-05 · `iva_pct REAL` — defecto latente, **no** material

`float4(0.19)` = `0,189999997615814208984375` — la tasa **no** está almacenada exactamente.

| Neto          | IVA exacto  | IVA con float4 |       |
| ------------- | ----------- | -------------- | ----- |
| 1 000         | 190         | 190            | igual |
| 1 001         | 200         | 200            | igual |
| 1 248 726     | 237 260     | 237 260        | igual |
| 6 101 732     | 1 159 330   | 1 159 330      | igual |
| 1 000 000 000 | 190 000 000 | 190 000 000    | igual |

**Ningún caso difiere.** El redondeo al alza a $10 es lo bastante grueso como para absorber un error relativo de ~1,3 × 10⁻⁸. **Es honesto decirlo:** almacenar la tasa en `REAL` está mal, pero **no ha corrompido ninguna factura por esta vía**. Se corrige igual (`NUMERIC(5,4)`), porque depender de que el redondeo tape el error es frágil, no correcto.

### R-06 · `uf_valor REAL` — **este sí es material**

`float4(40 543,07)` = `40 543,0703125`

| Monto UF | Neto exacto   | Neto con float4 | Δ           |
| -------- | ------------- | --------------- | ----------- |
| 150,5    | 6 101 732     | 6 101 732       | **0**       |
| 1 000    | 40 543 070    | 40 543 070      | **0**       |
| 10 000   | 405 430 700   | 405 430 703     | **+3 CLP**  |
| 50 000   | 2 027 153 500 | 2 027 153 516   | **+16 CLP** |

**Aquí está el daño real de C-14, y con la magnitud correcta:** aparece cuando el monto en UF es grande. En una solicitud típica (cientos de UF) la diferencia es **cero**. En una de 50 000 UF son **16 pesos**.

**No es catastrófico y no conviene presentarlo como tal.** Es la justificación suficiente de la regla `NUMERIC` + `Decimal`: el error es sistemático, crece con el monto, y no existe ninguna razón para tolerarlo cuando eliminarlo es gratis.

---

## 3. Casos para la suite de regresión (fase posterior)

| #     | Caso                                  | Verificado                                                                                                                                         |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01  | Un CP afecto                          | ✅ neto 6 101 732 · IVA 1 159 330 · total 7 261 062                                                                                                |
| R-02  | Dos CP: cascada ≠ fórmula             | ✅ 1 248 726 vs 1 248 727 — **bloqueado por decisión**                                                                                             |
| R-03a | IVA en múltiplo exacto de 10          | ✅ neto 1 000 → IVA 190                                                                                                                            |
| R-03b | IVA que sube al múltiplo              | ✅ neto 1 001 → IVA 200                                                                                                                            |
| R-04  | Exento                                | ✅ IVA 0                                                                                                                                           |
| R-05  | Tasa float4 vs exacta                 | ✅ el ceil la absorbe                                                                                                                              |
| R-06  | UF float4 con monto grande            | ✅ Δ +16 CLP a 50 000 UF                                                                                                                           |
| R-07  | Neto manual (`monto_neto_clp_manual`) | ⚠️ **Sin verificar.** El legado lo respeta y omite la cascada (`solicitudes.js:233`). **¿Existe en V1?** No aparece en ningún documento de alcance |
| R-08  | CP con `monto_clp_es_manual`          | ⚠️ **Sin verificar.** El legado permite fijar el CLP de un CP a mano (`exportador.js:105`) y entonces **no escribe fórmula**. ¿Se conserva?        |
| R-09  | Cero CP                               | ⚠️ El legado exporta con `C21` vacío. ¿Debe permitirse?                                                                                            |

**R-07 y R-08 son alcance no documentado.** El legado tiene dos vías de anulación manual del cálculo que **ningún documento de V1 menciona**. Si existen hoy y desaparecen en V1, alguien las va a echar de menos; si se conservan, hay que diseñarlas. **Decide negocio.**

---

## 4. Cambios respecto del legado — y su autorización

| Cambio                                                               | Autorización                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `NUMERIC` + `Decimal` en vez de `REAL` + `number`                    | ✅ **No requiere autorización.** No cambia ninguna regla: corrige la representación. Razón aritmética, demostrada en R-06         |
| Tratamiento tributario en la **solicitud**, no en la empresa emisora | ✅ **D-06**, confirmada por negocio                                                                                               |
| `iva_rate` **congelada por solicitud**                               | ✅ **D-06.** El legado lee `empresa.iva_pct` en cada cálculo: si la tasa cambiara, las facturas antiguas dejarían de reproducirse |
| Resolver R-02 (fórmula vs cascada)                                   | 🔴 **Requiere Finanzas**                                                                                                          |
| R-07 / R-08 (montos manuales)                                        | 🔴 **Requiere negocio**                                                                                                           |
