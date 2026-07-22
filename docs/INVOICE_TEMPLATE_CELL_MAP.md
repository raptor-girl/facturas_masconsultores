# Mapa de celdas de solicitud de factura

La fuente ejecutable es `apps/api/src/infrastructure/excel/invoice-template-map.ts`. Renderer, validador y pruebas consumen ese mapa centralizado.

## Identidad

- plantilla base: `templates/approved/solicitud-factura-soprole-clone-v1.xlsx`;
- referencia privada: `templates/reference-private/solicitud_factura_soprole_2026_abril.xls`;
- hoja unica visible: `Hoja1`;
- version funcional: `SOLICITUD_FACTURA_CLONE_CANDIDATE_V1`;
- area de impresion: `B2:I34`;
- formulario principal: `B2:D24`;
- bloque de notas: `B26:B34`.

La plantilla base viene de una conversion fiel del `.xls` real. No se reconstruye el layout con codigo.

## Celdas visibles

| Dato                             | Celda o rango | Regla                                                              |
| -------------------------------- | ------------- | ------------------------------------------------------------------ |
| Titulo                           | `B2:C2`       | `SOLICITUD DE FACTURA GRUPO MAS`                                   |
| Facturar Por                     | `C4:D4`       | Siempre `MAS CONSULTORES S.A.`                                     |
| Cliente                          | `C5:D5`       | nombre corto congelado                                             |
| Razon Social                     | `C8:D8`       | snapshot de cliente                                                |
| RUT                              | `C9:D9`       | snapshot de cliente                                                |
| Giro                             | `C10:D10`     | snapshot de cliente                                                |
| Direccion                        | `C11:D11`     | snapshot de cliente                                                |
| Orden de Compra / Nota de Pedido | `C12:D12`     | STANDARD escribe solo OC o antecedente                             |
| OC / N° Contrato                 | `C12:D12`     | HABITAT concatena OC y contrato en la misma celda                  |
| HES                              | `C13:D13`     | vacio si no aplica                                                 |
| Glosa                            | `C14:D14`     | texto de la solicitud                                              |
| Neto                             | `C15:D15`     | entero CLP exacto de `LEGACY_V1` solo en afectas; vacio en exentas |
| Monto IVA                        | `C16:D16`     | en afectas formula `ROUNDUP((C15*19%),0)` con cache de `LEGACY_V1` |
| Total                            | `C17:D17`     | en afectas formula `C15+C16`; en exentas entero CLP exacto         |
| Receptor de Documento            | `C18:D18`     | uno o varios receptores con saltos de linea                        |
| Fecha de Solicitud               | `C20:D20`     | fecha explicita del snapshot                                       |
| Centro de Proyecto               | `C21`         | uno o varios codigos CP/MS con saltos de linea                     |
| Monto por CP/MS                  | `D21`         | uno o varios montos calculados por linea                           |
| Area                             | `C22:D22`     | Siempre `MAS Plataformas`                                          |
| Encargado de Solicitud           | `C23:D23`     | snapshot del responsable                                           |
| Observaciones                    | `C24:D24`     | texto de la solicitud                                              |
| Notas                            | `B26:B34`     | texto final solicitado por la usuaria, incluida proyeccion 2023    |

No se imprimen fecha de facturacion, periodo, fecha UF, valor UF, numero de proveedor, producto, cantidad UF ni tipo de CP/MS. Esos datos siguen en PostgreSQL, snapshots y API, pero no pertenecen al Excel visible real.

## Multiples receptores y CP/MS

No se insertan secciones nuevas. Para multiples receptores, `C18:D18` usa saltos de linea y la fila 18 aumenta su altura si hace falta.

Para multiples CP/MS, `C21` contiene una linea por codigo y `D21` una linea por monto CLP. La fila 21 aumenta su altura si hace falta. No se imprimen producto, UF ni tipo de CP/MS.

## Variantes

STANDARD:

- `B12`: `Orden de Compra/ Nota de Pedido`;
- `C12:D12`: OC o antecedente;
- no imprime contrato.

HABITAT:

- `B12`: `OC / N° Contrato`;
- `C12:D12`: `OC: {valor} / Contrato: {valor}`;
- `B13`: `HES`;
- `C13:D13`: HES.

La variante proviene solo de `client_invoice_rule.excel_template_variant`.

## Montos, formulas controladas y seguridad

Los montos principales conservan el entero CLP calculado por `LEGACY_V1`. En solicitudes afectas, `C16` usa la formula interna OpenXML `ROUNDUP((C15*19%),0)`, que Excel en español muestra como `=REDONDEAR.MAS((C15*19%);0)`, y `C17` usa `C15+C16`. Ambos valores cacheados se validan contra el backend.

En solicitudes exentas, por fidelidad a la nota original, `C15` y `C16` quedan vacias y solo se escribe `C17` con el total.

Cuando `D21` contiene multiples montos, se escriben como texto multilinea formateado porque Excel no permite varios valores numericos independientes dentro de una misma celda.

El workbook generado se rechaza si contiene formulas fuera de las celdas controladas de montos, macros, conexiones, vinculos externos, relaciones externas, objetos incrustados, hojas ocultas, contenido activo o el valor visible accidental `41`. Los textos que empiezan con `=`, `+`, `-` o `@` se guardan como strings XLSX, sin apostrofe visible y sin nodos `<f>`.
