# EXCEL_LEGACY_BEHAVIOR — Comportamiento real del exportador Excel

**Estado: ✅ VERIFICADO CON CÓDIGO REAL.** Fuente: `back.zip` → `src/services/exportador.js` (257 líneas), `src/routes/exportaciones.js`, `templates/solicitud-factura-ejemplo.xlsx`.

**Esto resuelve D-09 / C-11**, la contradicción de AFP Habitat que arrastraba tres descripciones incompatibles.

> **Nada de esto se implementa en la Fase 1.** El Excel está fuera del alcance aprobado.

---

## 1. 🔴 AFP Habitat — resuelto, y ninguna de las tres versiones era correcta

El código, literal (`exportador.js:214-223`):

```js
if (esHabitat(cliente)) {
  setValue(ws, 'B12', 'OC / N° Contrato');
  setValue(
    ws,
    'C12',
    [
      sf.oc_numero ? `OC: ${sf.oc_numero}` : '',
      sf.contrato_numero ? `Contrato: ${sf.contrato_numero}` : '',
    ]
      .filter(Boolean)
      .join(' / '),
  );
} else {
  setValue(ws, 'B12', 'Orden de Compra/ Nota de Pedido');
  setValue(ws, 'C12', sf.oc_numero || '');
}
```

| Pregunta abierta                             | Respuesta comprobada                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ¿OC y contrato en la misma fila o separadas? | **La misma fila. La misma celda: `C12`.** Unidos por `' / '`                                                                |
| ¿Hay una fila adicional?                     | **No.** Ninguna. La única diferencia es el texto de `B12` y el contenido de `C12`                                           |
| ¿Texto exacto de la etiqueta?                | Habitat: **`OC / N° Contrato`** · Estándar: **`Orden de Compra/ Nota de Pedido`** _(con ese espaciado irregular, tal cual)_ |
| ¿Qué celdas ocupa?                           | **`B12`** (etiqueta) y **`C12`** (valor). Nada se desplaza                                                                  |
| ¿Qué pasa con HES?                           | **Nada.** `C13` en ambas variantes, con `'N/A'` si viene vacío                                                              |
| Formato del valor                            | `OC: {oc} / Contrato: {contrato}`. Si falta uno, se omite junto con el separador                                            |

**Por lo tanto: `EXCEL_CANONICAL_SPEC.md`, `OPEN_DECISIONS.md` §9 y `EXCEL_INVENTORY.md` estaban los tres equivocados** en algún punto. La variante Habitat **no es una plantilla distinta**: es la misma plantilla con otra etiqueta y dos datos concatenados en una celda.

### 🔴 Pero cómo se decide es inaceptable (L-04)

```js
function esHabitat(cliente) {
  return String(cliente?.nombre_corto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .includes('HABITAT');
}
```

**La regla se decide por el nombre del cliente.** Renombrar «AFP Habitat» a «Habitat AFP S.A.» sigue funcionando por accidente; renombrarlo a «A.F.P. Hábitat» funciona (quita tildes); llamar a otro cliente «Habitat Servicios» **le aplicaría la variante sin que nadie lo pidiera**.

**D-06 ya lo prohíbe** («No se hardcodean reglas por nombre de cliente»). V1 lo resuelve con `client_invoice_rule.excel_template_variant`, que ya existe en el diseño. La evidencia confirma que la prohibición no era teórica.

---

## 2. Mapa exacto de celdas — comprobado

`cpRows = max(nº de CP, 1)` · `offset = cpRows - 1`

| Celda        | Contenido                                                                           | Fuente                             |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| `C4`         | Razón social de la empresa emisora                                                  | `empresa_emisora.razon_social`     |
| `C5`         | Nombre corto del cliente                                                            | `cliente.nombre_corto`             |
| `C8`         | Razón social de facturación                                                         | `cliente_facturacion` o el cliente |
| `C9`         | RUT                                                                                 | idem                               |
| `C10`        | Giro                                                                                | idem                               |
| `C11`        | Dirección                                                                           | idem                               |
| `B12`        | **Etiqueta variable** — ver §1                                                      |                                    |
| `C12`        | **OC** (estándar) · **OC + Contrato** (Habitat)                                     |                                    |
| `C13`        | HES · `'N/A'` si vacío                                                              | `hes_numero`                       |
| `C14`        | Glosa                                                                               | `glosa`                            |
| `C15`        | **Neto** — fórmula o valor                                                          | ver §3                             |
| `C16`        | IVA                                                                                 | calculado                          |
| `C17`        | Total                                                                               | calculado                          |
| `C18`        | **Correos de los receptores**, separados por salto de línea, **todos en una celda** |                                    |
| `C20`        | Fecha, formato `d/m/yyyy`                                                           | `uf_fecha` o **hoy**               |
| `B21+i`      | Literal `'Centro de Proyecto'`                                                      | una fila por CP                    |
| `C21+i`      | Código del CP                                                                       | `cp.codigo`                        |
| `D21+i`      | **Siempre vacío**                                                                   |                                    |
| `C22+offset` | Área                                                                                | `sf.area`                          |
| `C23+offset` | Encargado                                                                           | `coordinador.nombre`               |
| `C24+offset` | Observaciones (+ línea `Valor UF …`)                                                | ver §4                             |

**Múltiples CP** (`exportador.js:198-204`): inserta filas en la posición 22, copia el estilo de la fila 21 y combina `B21:B{20+cpRows}`. Las filas de abajo se desplazan — de ahí el `offset`.

**Al final:** `deleteRowPreservingMerges(ws, 6)` — **borra la fila 6** y rehace las combinaciones. Sin evidencia de por qué; probablemente una fila de la plantilla que no debe salir.

---

## 3. 🔴 El folio NO aparece en el Excel

Búsqueda exhaustiva de `folio` en `exportador.js`: **cero coincidencias.** No hay ninguna celda con el folio.

Y en el nombre del archivo (`exportaciones.js:30-36`):

```js
function nombreArchivoSolicitud(sol) {
  const cliente = limpiarParteArchivo(sol.cliente_nombre || 'CLIENTE');
  const mes = nombreMesDesdePeriodo(sol.periodo);
  return `Solicitud_factura_${cliente}_${mes}.xlsx`; // ← sin folio
}
```

**Tampoco.** `Solicitud_factura_COPEC_MAYO.xlsx`.

### Esto corrige un error mío

La migración `1721000000003_folio-counter.sql` justificaba el orden «reservar folio antes de generar el Excel» con que _«va impreso en el documento»_. **Era falso, y lo di por cierto sin evidencia.** Ya está corregido en el comentario de la migración.

**El orden sigue siendo el correcto, por otra razón:** por D-03 la solicitud existe sólo si el Excel se generó bien, así que reserva y generación deben ir en **la misma transacción**. Si la generación falla, `ROLLBACK` y el folio no se consume. La conclusión no cambia; la justificación sí.

### Consecuencia adicional (L-09)

Dos solicitudes del mismo cliente y mes **generan el mismo nombre de archivo y se pisan en disco**. La evidencia está en el propio ZIP: conviven `SF-2026-00001_1777853440405.xlsx` (nombre viejo, con folio y timestamp) y `Solicitud_factura_COPEC_MAYO.xlsx` (nombre nuevo, sin folio). **Alguien quitó el folio del nombre en algún momento.**

> **Pendiente de negocio (D-09b):** ¿el nombre del archivo debe llevar el folio? Los coordinadores adjuntan estos archivos a correos. `Solicitud_factura_COPEC_MAYO.xlsx` es legible pero ambiguo; `SF-2026-00081_COPEC_MAYO.xlsx` es único y rastreable. **No lo decide el equipo técnico.**

---

## 4. Comportamientos que no deben copiarse

| #        | Qué hace                                                                                                                                         | Por qué está mal                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-05** | **Exportar escribe en la base**: `UPDATE solicitud_cp SET monto_clp`, `UPDATE solicitud_factura SET uf_valor, montos…` (`exportador.js:150-165`) | «Descargar un documento» **recalcula y reescribe montos**. Descargar dos veces el mismo Excel en días distintos puede dar cifras distintas si la UF cambió. Un documento tributario no puede depender de cuándo se descargó |
| **L-06** | Fórmula `=sumaUF*valorUF` con `result` = neto en cascada (`exportador.js:118-124,244`)                                                           | **La fórmula y el valor no coinciden.** Ver `ROUNDING_REGRESSION_CASES.md` R-02                                                                                                                                             |
| **L-10** | El `.xlsx` se escribe en `storage/exports/` y la base guarda **la ruta** (`exportaciones.js:56-62`)                                              | El archivo vive fuera de la base. Un contenedor efímero lo pierde. **T-05**: V1 lo guarda en `BYTEA`                                                                                                                        |
| **L-11** | `getUF()` se llama **dentro** del exportador si falta el valor (`exportador.js:137`)                                                             | Generar un documento hace una llamada de red a un tercero. Si mindicador tarda 5 s, la descarga tarda 5 s. **R-06**: los montos se congelan antes                                                                           |
| **L-12** | La fecha del Excel es `uf_fecha \|\| hoy` (`exportador.js:100`)                                                                                  | La fecha impresa depende de cuándo se exportó. Ver `UF_LEGACY_BEHAVIOR.md` §4                                                                                                                                               |

---

## 5. Comportamientos que SÍ se conservan

| Regla                                                                                          | Evidencia               |
| ---------------------------------------------------------------------------------------------- | ----------------------- |
| Una plantilla oficial única, leída del `.xlsx`, no generada por código                         | `exportador.js:6,196`   |
| Estilos, bordes y combinaciones vienen de la plantilla; el código sólo rellena celdas          | `setValue`              |
| Filas por CP con estilo copiado de la fila modelo                                              | `exportador.js:198-204` |
| HES = `'N/A'` cuando está vacío                                                                | `exportador.js:224`     |
| Receptores múltiples en una celda, separados por salto de línea                                | `exportador.js:229`     |
| Línea `Valor UF {fecha}: {valor}` añadida a observaciones, reemplazando la anterior si existía | `exportador.js:24-35`   |
| Fecha con formato `d/m/yyyy`                                                                   | `exportador.js:232`     |

---

## 6. Golden files — qué hay y qué falta

De los **13 Excel** en `back/storage/exports/` (**no copiados** al repositorio: llevan datos reales):

| Caso requerido                        | ¿Existe?                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Estándar afecto                       | ✅ COPEC, ENAEX, MAGOTTEAUX, SOPROLE, MAYO                                    |
| Con HES                               | ✅ TRANSELEC _(único cliente con `requiere_hes`)_                             |
| **Exento (SENCE / Más Capacitación)** | ❌ **No hay ninguno**                                                         |
| **AFP Habitat**                       | ❌ **No hay ninguno** — sigue sin golden file pese a que el código está claro |
| Múltiples CP                          | ⚠️ Por confirmar abriendo los archivos                                        |
| Múltiples receptores                  | ⚠️ Por confirmar                                                              |
| QA / basura                           | ⚠️ `test-proyecciones.xlsx`, `..._QA_PG_CLIENTE_...` — **no son referencia**  |

**El caso exento sigue siendo el vacío más grave:** es la mitad de la regla tributaria (D-06) y no existe ningún archivo real contra el cual probar.

**Los golden files de V1 no pueden salir de estos archivos**: contienen razones sociales, RUT y montos reales. Deben generarse con **datos ficticios** y aprobarse formalmente. La referencia privada se usa sólo para inspección visual local; la plantilla versionable se reconstruye limpia en `templates/approved/`.

---

## 7. Pendientes que esta evidencia deja sobre la mesa

| #         | Pregunta                                                                     | Decide                                   |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| **D-09b** | ¿El nombre del archivo lleva el folio?                                       | Negocio                                  |
| **R-02**  | Fórmula vs. cascada en `C15`                                                 | Finanzas                                 |
| **D-10**  | ¿El estilo es contractual o cosmético?                                       | Negocio                                  |
| **E-01**  | ¿Por qué se borra la fila 6?                                                 | Requiere abrir la plantilla              |
| **E-02**  | ¿La fecha del Excel debe ser `uf_fecha`, `billing_date` o la de exportación? | Negocio — ver `UF_LEGACY_BEHAVIOR.md` §4 |

---

## 8. Implementación de Fase 5

Fase 5.1C usa como referencia privada `templates/reference-private/solicitud_factura_soprole_2026_abril.xls`, cuyo SHA-256 es `4b47d4a68c5b83ad16950e86374075ef158c06d7d88e0bffc608489023eb0c36`. La referencia no se versiona, no entra a Docker y no se abre en runtime.

La plantilla productiva se convirtió fielmente desde ese `.xls` con Microsoft Excel COM y se limpió en `templates/approved/solicitud-factura-soprole-clone-v1.xlsx`. Se identifica como `SOLICITUD_FACTURA_CLONE_CANDIDATE_V1` hasta aprobación visual.

La conversión conserva la hoja `Hoja1`, el formulario principal `B2:D24`, las combinaciones, anchos, altos, bordes, colores, fuentes, orientación vertical y área de impresión `B2:I34`. El renderer sólo completa celdas existentes. No imprime fecha de facturación, período, fecha UF, valor UF, número de proveedor, producto, cantidad UF ni tipo de CP/MS. Múltiples receptores usan saltos de línea en `C18:D18`; múltiples CP/MS usan saltos de línea en `C21` y `D21`.

Corrección final solicitada por usuaria: `C4:D4` imprime siempre `MAS CONSULTORES S.A.`, `C22:D22` imprime siempre `MAS Plataformas`, y el bloque de notas `B26:B34` conserva el texto manual solicitado, incluida la referencia a proyecciones 2023.

Neto, IVA, total y cada CP provienen de `LEGACY_V1`. Para afectas, `C16` usa la fórmula controlada `ROUNDUP((C15*19%),0)` con caché igual al IVA calculado por backend, y `C17` usa `C15+C16` con caché igual al total. En Excel en español se visualiza como `=REDONDEAR.MAS((C15*19%);0)`. Para exentas, por fidelidad a la nota original, `C15` y `C16` quedan vacías y solo se escribe `C17`. El caso de regresión conserva `425702 + 823024 = 1248726`; no se obtiene el valor incorrecto `1248727`.

El XLSX se genera/reabre en memoria antes de la transacción y se rechaza si excede 5 MiB, no es un ZIP XLSX válido, contiene fórmulas fuera de las celdas controladas de montos, macros, conexiones, vínculos externos, objetos incrustados, hojas ocultas, campos técnicos visibles o el valor accidental `41`. Los textos que empiezan con `=`, `+`, `-` o `@` se guardan como strings XLSX sin apóstrofo visible y se valida que no creen nodos `<f>`. El BYTEA validado se almacena con SHA-256 y toda descarga posterior devuelve exactamente esos bytes.

Pendiente para aprobación visual: abrir los seis archivos ficticios de `tmp/template-review/` y confirmar la apariencia.
