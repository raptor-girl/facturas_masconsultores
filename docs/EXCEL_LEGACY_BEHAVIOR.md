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

**Los golden files de V1 no pueden salir de estos archivos**: contienen razones sociales, RUT y montos reales. Deben generarse con **datos ficticios** y aprobarse formalmente. La plantilla (`templates/solicitud-factura-ejemplo.xlsx`) sí es reutilizable como **estructura** — no contiene datos de clientes.

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

La Fase 5 automatiza el mapa funcional conocido con `@excel.js/exceljs`, pero **no declara equivalencia visual final**. El archivo `templates/solicitud-factura-ejemplo.xlsx` mencionado por la evidencia legacy no está presente en este repositorio, por lo que se genera `TECHNICAL_V1_UNAPPROVED` con una advertencia visible y datos ficticios en pruebas.

Se conservan y prueban `C4`, `C5`, `C8:C18`, `C20`, líneas CP desde fila 21, offsets, múltiples receptores, HES `N/A` y las variantes `STANDARD`/`HABITAT`. Los montos provienen de `LEGACY_V1` y se escriben como fórmulas constantes con resultado exacto; no se recalcula ni consulta UF durante la descarga. El folio no se imprime dentro del workbook ni en el nombre; un sufijo derivado del ID de exportación evita colisiones sin alterar la planilla.

El XLSX se genera/reabre en memoria antes de la transacción y se rechaza si excede 5 MiB, no es un ZIP XLSX válido, cambia las celdas críticas, contiene macros, conexiones o vínculos externos. Todo texto de usuario que comienza con `=`, `+`, `-` o `@` se neutraliza para evitar formula injection. El BYTEA validado se almacena con SHA-256 y toda descarga posterior devuelve exactamente esos bytes.

Pendiente para aprobación visual: obtener una plantilla oficial libre de datos reales, definir si el estilo es contractual y resolver E-01/E-02. Hasta entonces, la funcionalidad transaccional es verificable, pero el arte final debe considerarse observado.
