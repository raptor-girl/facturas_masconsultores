# Fase 5.1 - clon visual Soprole corregido

## Estado

La candidata anterior fue rechazada visualmente por no parecerse al Excel real. La version vigente sigue siendo:

`SOLICITUD_FACTURA_CLONE_CANDIDATE_V1`

No se clasifica como aprobada visualmente. La aprobacion debe realizarla la usuaria abriendo los archivos de `tmp/template-review/`.

## Referencia privada

El adjunto real se copio byte a byte a:

`templates/reference-private/solicitud_factura_soprole_2026_abril.xls`

SHA-256 del adjunto y de la copia privada:

`4b47d4a68c5b83ad16950e86374075ef158c06d7d88e0bffc608489023eb0c36`

La carpeta `templates/reference-private/` esta ignorada por Git y Docker. El `.xls` no se versiona, no entra a la imagen runtime y no se lee en produccion.

## Conversion, limpieza y correccion puntual

La plantilla versionable se creo convirtiendo el `.xls` real con Microsoft Excel COM a:

`templates/approved/solicitud-factura-soprole-clone-v1.xlsx`

SHA-256 actual de la plantilla clonada:

`b89b466160831b80da696acf80fa3d50791f41ef5043e7128ed36e931fb05102`

La limpieza elimino valores reales y metadatos personales, pero conservo el diseno convertido: una hoja visible `Hoja1`, estructura `B2:I34`, formulario principal `B2:D24`, celdas combinadas, anchos, altos, bordes, verdes, fuentes, orientacion vertical, escala 100%, area de impresion `B2:I34` y bloque de notas en su zona original.

La correccion final no redisenó la plantilla. Solo ajusto contenido controlado:

- `C4:D4` imprime siempre `MAS CONSULTORES S.A.` como valor visible de Facturar Por.
- `C22:D22` imprime siempre `MAS Plataformas`.
- En solicitudes afectas, `C16:D16` contiene la formula controlada `ROUNDUP((C15*19%),0)` con valor cacheado desde `LEGACY_V1`.
- En solicitudes afectas, `C17:D17` contiene la formula controlada `C15+C16` con valor cacheado desde `LEGACY_V1`.
- En solicitudes exentas, se respeta la nota legacy: solo queda visible el total en `C17:D17`; `C15:D15` y `C16:D16` quedan vacias.

## Notas finales

El bloque de notas queda en `B26:B34`, en la zona original bajo el formulario, con este texto exacto:

```text
NOTAS:
*Si la solicitud es exenta de IVA, solo completar el monto total.
*Si la factura es con IVA, solo debes agregar el monto neto y automáticamente
  dará el valor de IVA y bruto.
*Para efecto de las proyecciones del 2023, deberá agregarse una columna al lado
  de cada CP, indicando si el proyecto está afecto, exento de IVA o mixto.
*En las proyecciones debe incluirse el valor total de proyecto, incluyendo el IVA,
  si este está afecto a IVA, ya que ese es el valor que se facturará y corresponderá a la
  caja que se percibirá por el cobro de esa factura.
```

## Mapeo productivo

El runtime carga solo `templates/approved/solicitud-factura-soprole-clone-v1.xlsx`, crea una copia en memoria y completa celdas existentes:

- `C4:D4`: Facturar Por, siempre `MAS CONSULTORES S.A.`.
- `C5:D5`: Cliente.
- `C8:D8`: Razon Social.
- `C9:D9`: RUT.
- `C10:D10`: Giro.
- `C11:D11`: Direccion.
- `C12:D12`: OC / antecedente documental.
- `C13:D13`: HES.
- `C14:D14`: Glosa.
- `C15:D15`: Neto, solo en afectas.
- `C16:D16`: Monto IVA, formula controlada solo en afectas.
- `C17:D17`: Total.
- `C18:D18`: Receptor de Documento, con multiples receptores separados por saltos de linea.
- `C20:D20`: Fecha de Solicitud.
- `C21`: CP/MS, con multiples codigos separados por saltos de linea.
- `D21`: montos CP/MS, con multiples montos separados por saltos de linea.
- `C22:D22`: Area, siempre `MAS Plataformas`.
- `C23:D23`: Encargado de Solicitud.
- `C24:D24`: Observaciones.

`STANDARD` no imprime contrato. `HABITAT` usa solo la variante de datos y escribe `B12 = OC / N° Contrato` y `C12:D12 = OC: {valor} / Contrato: {valor}`. No existe deteccion por nombre de cliente.

## Seguridad y calculo

Los montos CP/MS, neto, IVA y total siguen proviniendo de `LEGACY_V1`; la formula de IVA en `C16` es solo una representacion controlada del valor ya calculado por backend y usa `C15` como base visual. En Excel en español se visualiza como `=REDONDEAR.MAS((C15*19%);0)`. La regresion obligatoria conserva `425702 + 823024 = 1248726`, nunca `1248727`.

Formula injection se neutraliza escribiendo textos de usuario como strings XLSX. Solo se permiten nodos `<f>` generados por la aplicacion en celdas controladas de montos (`C16` y `C17` en afectas). Se rechazan macros, conexiones, vinculos externos, relaciones externas, objetos incrustados, rutas locales, formulas no autorizadas y archivos mayores de 5 MiB.

Los documentos historicos no se regeneran. La descarga sigue devolviendo el `BYTEA` exacto persistido.

## Archivos de revision

`npm run template:review` genera datos ficticios en `tmp/template-review/`:

1. `01-standard-un-cp-un-receptor.xlsx` - `8545330e89bae1f8ef921218e39d61b5424ef2941d8a1d7eb037a0565c11202a`
2. `02-standard-varios-cp-varios-receptores.xlsx` - `bca4f66562ff1a7e38bc5023ea7633349be0ac60e1e54f79cc70b3a2f506a3c4`
3. `03-standard-exento.xlsx` - `ba01dbca1d5e93cb288f789354068332ec66047425d3a69965931121dae9e07e`
4. `04-habitat-oc-contrato-hes.xlsx` - `20f46e5e06d4a3a3be8738bcd964887be9ed5e94756b0923c3782973ec829014`
5. `05-afecto-regresion-un-peso.xlsx` - `3ee5c92ceba1f486d2f4fbecdd774df31ca2f14d7160f2814236309ec853035e`
6. `06-formula-injection-neutralizada.xlsx` - `e1b28037abf65e013bc876d1f4e45b790473a1002a4e137e32c00c8e09d563d4`

La carpeta esta ignorada y no contiene datos reales.

## Validacion actual

Las pruebas estructurales verifican que se use el clon, que la hoja sea `Hoja1`, que no haya hojas ocultas, macros, conexiones, vinculos externos, campos tecnicos visibles, secciones nuevas, contrato STANDARD visible, valor accidental `41` ni apostrofe visible en formula injection. Tambien verifican que solo existan formulas controladas de montos y que el caso exento no muestre IVA afecto.

La validacion visual final sigue pendiente de revision humana.

## Clasificacion

**CLON CORREGIDO PARA REVISION VISUAL.**
