# UF_LEGACY_BEHAVIOR — Comportamiento real de UF en el sistema anterior

**Estado: ✅ VERIFICADO CON CÓDIGO REAL** · Fuente: `back.zip` → `src/services/uf.js` (338 líneas), `src/routes/uf.js`.

Reemplaza a `/mnt/user-data/outputs/UF_LEGACY_BEHAVIOR.md`, que era una **especificación de inspección** porque el código no existía. Ahora existe. **D-05 queda resuelta.**

> **Nada de esto se implementa en la Fase 1.** La UF está fuera del alcance aprobado. Este documento es evidencia para la fase que corresponda.

---

## 1. Proveedores — comprobado

| #      | Proveedor                     | Endpoint real                                         | Timeout  | Reintentos                                  |
| ------ | ----------------------------- | ----------------------------------------------------- | -------- | ------------------------------------------- |
| **1º** | **Caché local**               | tabla `uf_cache`, por fecha exacta                    | —        | —                                           |
| **2º** | **SII**                       | `https://www.sii.cl/valores_y_fechas/uf/uf{AAAA}.htm` | **15 s** | **Ninguno**                                 |
| **3º** | **mindicador.cl (por año)**   | `https://mindicador.cl/api/uf/{AAAA}`                 | **15 s** | Ninguno                                     |
| **4º** | **mindicador.cl (por fecha)** | `https://mindicador.cl/api/uf/{DD-MM-AAAA}`           | **5 s**  | **3 intentos**, espera 500 / 1000 / 1500 ms |

Configurables por entorno: `UF_API_BASE`, `UF_SII_BASE`, `UF_CACHE_FROM_YEAR` (2026), `UF_CACHE_TO_YEAR` (2026).

### 🔴 El hallazgo que importa: el SII **no** es una API

```js
const SII_BASE = 'https://www.sii.cl/valores_y_fechas/uf';
await axios.get(`${SII_BASE}/uf${anio}.htm`, { responseType: 'text', timeout: 15000 });
```

**Es una página `.htm` que se descarga y se parsea con expresiones regulares.** El parser (`parseSIIUFYear`) depende de la maquetación exacta del sitio:

- corta el HTML por `<div class='meses' id='mes_...'>`
- lee el nombre del mes desde `<h2>`
- extrae pares con `<th><strong>DÍA</strong></th><td>VALOR</td>`
- convierte formato chileno: quita los puntos de miles, cambia la coma por punto

**Consecuencia:** el «proveedor principal» se rompe **el día que el SII cambie una clase CSS o una etiqueta**, sin aviso y sin error de red. Lo que confirma la sospecha registrada en la revisión anterior: _el SII no publica una API REST pública y estable de UF_. Nunca la hubo.

**Esto es una decisión de arquitectura, no un detalle.** Ver §6.

---

## 2. Orden de resolución — comprobado (`getUF(fecha)`)

```
1. ¿Está en uf_cache para esa fecha exacta?  → devolver (source = el guardado)
2. ¿El año de la fecha ≥ UF_CACHE_FROM_YEAR (2026)?
      → cacheUFYear(año): SII (scrape) → si falla, mindicador por año
      → guarda TODO el año en uf_cache y reintenta la lectura
3. Si nada de lo anterior dio resultado:
      → mindicador.cl por fecha, 3 intentos con espera creciente
4. Si todo falla → lanza UF_UNAVAILABLE.  ⚠️ NO inventa un valor.
```

**Detalle no evidente:** una consulta por **una** fecha de 2026 dispara la descarga y el guardado del **año completo**. Por eso `uf_cache` tiene huecos: no es un histórico, es el residuo de qué años y fechas alguien consultó alguna vez. **Confirma G-05.**

**Fechas anteriores a 2026** nunca pasan por el SII: van directo a mindicador.cl por fecha. Es decir, **para todo el histórico de 2025 el proveedor real es mindicador.cl**, no el SII, aunque `uf_cache.source` diga otra cosa en filas viejas.

---

## 3. Precisión — comprobado

| Punto      | Qué hace                                                 | Consecuencia                                     |
| ---------- | -------------------------------------------------------- | ------------------------------------------------ |
| Parser SII | `Number("40.543,07".replace(/\./g,'').replace(',','.'))` | `number` (float64) desde el primer instante      |
| Columna    | `uf_cache.valor REAL`                                    | **float4**: `40543.07` → `40543.0703125`         |
| Cálculo    | `Math.round(montoUF * Number(ufValor))`                  | El error de la UF **se multiplica por el monto** |

**Este es el mecanismo exacto de C-14, ahora demostrado y no deducido.**

**Único cambio deliberado respecto del legado:** `NUMERIC` + `string` + `Decimal`. Se justifica sin necesidad de permiso porque la razón es **aritmética, no de proceso**: no cambia ninguna regla de negocio, corrige la representación. Todo lo demás de este documento se conserva tal cual.

---

## 4. Qué fecha determina la UF — comprobado

`invoice_request` tiene tres fechas y la documentación no decía cuál manda. El código sí:

```js
function fechaSolicitudExportacion(sf) {
  return sf.uf_fecha || todayISO();
}

// en recalcularMontosParaExportacion:
if (usaUF && ufValor && !ufFecha) ufFecha = todayISO();
if (usaUF && !ufValor) {
  ufFecha = ufFecha || todayISO();
  ufValor = (await getUF(ufFecha)).valor;
}
```

**Manda `uf_fecha`. Si es nula, se usa HOY** — el día en que alguien apretó exportar.

⚠️ **Y esto contradice la inducción**, que dice «al valor de la UF **del día de la facturación**». En el código, `billing_date` **no participa**. Si `uf_fecha` está vacía, el valor depende de cuándo se exportó, no de cuándo se facturó.

> **Pendiente de aprobación:** ¿se conserva «`uf_fecha`, y si falta, hoy» (lo que el sistema hace) o se implementa «el día de la facturación» (lo que la inducción dice)? **No lo decide el equipo técnico.** El comportamiento actual es defendible —la UF suele fijarse al facturar— pero no es lo que la inducción declara.

---

## 5. Reglas que se conservan

| Regla                                                             | Evidencia                      |
| ----------------------------------------------------------------- | ------------------------------ |
| Caché por fecha con `source` y `obtenido_at`                      | `uf.js:23,72`                  |
| Ante fallo total, `UF_UNAVAILABLE` — **jamás un valor inventado** | `uf.js:69`                     |
| Respaldo automático y silencioso SII → mindicador                 | `uf.js:203`                    |
| Reintentos con espera creciente en la ruta por fecha              | `uf.js:64`                     |
| La fecha de UF actualiza el valor sola, sin botón «Buscar UF»     | Coherente con `UX_FLOWS.md` §2 |

---

## 6. 🔴 Decisión de arquitectura que esta evidencia fuerza

**El diseño de `UF_INTEGRATION.md` daba por hecho un «endpoint del SII». No existe: es un scrape de HTML.** Con eso sobre la mesa, hay tres caminos, y **decide negocio**:

| Opción                                                    | A favor                                                                                                     | En contra                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A — Conservar el scrape del SII como principal**        | Idéntico al comportamiento actual; el SII es la fuente oficial                                              | Se rompe con cualquier rediseño del sitio del SII. Frágil por construcción |
| **B — `mindicador.cl` como principal, SII como respaldo** | Contrato JSON estable; el respaldo ya está probado en el legado                                             | Depende de un tercero no oficial para un valor tributario                  |
| **C — Carga histórica + `mindicador.cl` bajo demanda**    | Elimina los huecos de `uf_cache`; reconstruir una solicitud antigua deja de depender de una llamada en vivo | Requiere una pasada inicial                                                |

**Recomendación técnica (no decisión):** **C**, con **B** dentro. El scrape del SII puede conservarse como verificación asíncrona que registre discrepancias, sin bloquear una exportación. Pero el fondo es de negocio: **¿acepta Finanzas que el valor UF de una factura provenga de `mindicador.cl` y no del SII?** Esa pregunta, hoy, ya está contestada de hecho —para todo 2025 el proveedor real fue mindicador— sólo que nadie la había formulado.

---

## 7. Casos de regresión de UF (para la fase que corresponda)

| #    | Caso                                        | Esperado (legado)                                                          |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------- |
| U-01 | Fecha en caché                              | Devuelve el valor cacheado; no sale a la red                               |
| U-02 | Fecha de 2026 sin caché, SII responde       | Guarda el año completo; `source='sii.cl'`                                  |
| U-03 | Fecha de 2026, SII cae                      | Respaldo mindicador por año; `source='mindicador.cl'`                      |
| U-04 | Fecha de 2025 sin caché                     | Directo a mindicador por fecha; **nunca** pasa por el SII                  |
| U-05 | mindicador falla 2 veces y responde a la 3ª | Éxito tras esperar 500 y 1000 ms                                           |
| U-06 | Todos los proveedores caen                  | `UF_UNAVAILABLE`. **No se factura.**                                       |
| U-07 | `uf_fecha` nula y hay montos en UF          | Usa la fecha de hoy ⚠️ ver §4                                              |
| U-08 | Fecha futura fuera del horizonte publicado  | Sin datos → `UF_UNAVAILABLE`                                               |
| U-09 | Precisión: `40543.07` ida y vuelta          | **V1 debe devolver `40543.07` exacto.** El legado devuelve `40543.0703125` |

---

## 8. Implementación aprobada en Fase 4

La reconstrucción conserva la prioridad solicitada `PostgreSQL → SII → mindicador.cl`, pero no propaga la fecha implícita de U-07: el llamador siempre entrega `YYYY-MM-DD` y ninguna fuente puede reemplazar ese día por el anterior o posterior.

SII se consume como HTML anual controlado y mindicador como JSON anual. Ambos adaptadores validan contenido, fecha y decimal antes de persistir solamente el valor solicitado. El HTTP compartido limita tamaño, tiempo, reintentos y redirecciones y aplica allowlist/validación DNS contra SSRF. Los tests usan fixtures y servidores locales sólo bajo `NODE_ENV=test`; CI no depende de Internet.

`uf_value` conserva un único valor por fecha, fuente, instante de obtención y referencia pública minimizada. No almacena HTML ni respuestas completas. Una recarga con valor distinto registra antes/después dentro de la misma transacción.
