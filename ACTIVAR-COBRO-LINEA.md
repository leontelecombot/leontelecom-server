# Activar el cobro en línea de León Telecom

Todo el código está puesto y **apagado**. Nada de lo que sigue se mueve hasta
que pongas `COBRO_LINEA_ACTIVO=true`. Mientras esté apagado, los 1,090 clientes
ven exactamente lo mismo de siempre: horario en oficina y datos de pago.

## El interruptor

| Variable | Qué hace |
|---|---|
| `COBRO_LINEA_ACTIVO` | `true` enciende. Cualquier otra cosa lo deja apagado. |
| `COBRO_LINEA_TELEFONOS` | A quién se le ofrece. Vacío = solo el piloto. Lista con comas = esos. `*` = todos. |

```
Solo tú (piloto 529516549145):  COBRO_LINEA_ACTIVO=true
Unos cuantos:                   COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=5219511111111,5219512222222
Todo el pueblo:                 COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=*
Apagar de emergencia:           COBRO_LINEA_ACTIVO=false
```

Apagar no requiere tocar código ni volver a desplegar. Es una variable en Render.

## Lo que falta antes de encenderlo

1. **`LEON_STRIPE_CUENTA_CONECTADA`** — la cuenta de Stripe Connect de León
   Telecom. Es a donde cae su dinero. Sin esto no se genera ningún cobro.
2. **`STRIPE_SECRET_KEY`** — la misma llave de plataforma que usa Aforo.
3. **`STRIPE_WEBHOOK_SECRET_LEON`** — el secreto del webhook, distinto del de
   Aforo aunque la llave de plataforma sea la misma.
4. **Registrar el webhook en Stripe** apuntando a `POST /webhook/stripe` con
   estos eventos:
   - `checkout.session.completed`
   - `customer_cash_balance_transaction.created` ← **el de la CLABE, no se te olvide**
5. **Activar transferencias bancarias MXN** en el panel de Stripe. Sin eso, la
   CLABE no se genera.

## Las tres formas de pagar

**CLABE fija** (`🏦 Mi CLABE fija`) — Stripe le da al cliente una cuenta bancaria
suya, para siempre. La anota una vez en su banco y cada mes deposita ahí. No
caduca, no hay links, y el pago se registra solo. Es la que más le va a servir a
la gente que paga por transferencia o en ventanilla.

**Tarjeta u OXXO** (`💳 Tarjeta u OXXO`) — un link de Checkout que vence en 32
minutos.

**Otras formas** (`🏢 Otras formas`) — horario de oficina y los datos de pago de
siempre, con comprobante. Nunca desaparece: pagar como toda la vida sigue siendo
gratis.

## El dinero

León Telecom recibe **su precio de plan íntegro**. El cargo por pagar en línea
(`$8 + 5%`, ajustable en `utils/stripeLeon.js`) lo paga el cliente que elige la
comodidad, y de ahí sale tanto el costo real de Stripe como la parte de OBEX.
Es el mismo trato que un organizador en Aforo.

> Los `$8 + 5%` son un **marcador de posición**. Con Stripe MX cobrando 3.6% + $3
> más IVA, revisa el número antes de encender para todos.

## Reactivación automática en Wisphub

Verificado contra la API real el 5 de septiembre de 2026. El módulo es
`utils/wisphubReactivar.js` y tiene su **propio interruptor**, aparte del de
cobro:

```
WISPHUB_REACTIVAR_ACTIVO=true    # apagado por defecto
WISPHUB_API_KEY=<la llave>
```

Conviene arrancar con el cobro encendido y esto apagado: primero se comprueba
unos días que los pagos entran bien, y solo después se le deja tocar el servicio
de la gente.

### Lo que se descubrió y por qué importa

**No se edita al cliente.** `PUT /api/clientes/{id}/` exige **16 campos
obligatorios**, incluidos objetos anidados (`router`, `plan_internet`, `zona`,
`sectorial`, `modelo_antena`). Su documentación dice que escribe "en base de
datos y en el RB", o sea que empuja al router. Un PUT incompleto puede dejar a
un cliente real sin plan o sin router.

**Se usa el endpoint dedicado:** `POST /api/clientes/activar/` con
`{"servicios":[id_servicio]}`. Es asíncrono (devuelve `task_id`) y los ids que
no encuentra los reporta en `warnings`, no como error.

**No puede cortar a nadie.** `activar` y `desactivar` son endpoints separados.
El módulo solo conoce `activar`, y hay una prueba que falla si alguien agrega
el otro.

**La factura va aparte.** `auto_activar_servicio` está en `false` para todos los
clientes, así que pagar la factura NO reconecta solo. Hacen falta las dos
llamadas. Además: facturas **no acepta PATCH** (405), solo PUT con tres fechas
obligatorias, y su campo `estado` es de **solo lectura** (se pone `saldo: 0` y
Wisphub deduce "Pagada").

**El teléfono no coincide.** Wisphub guarda 10 dígitos (`9516549145`); WhatsApp
entrega 12 (`529516549145`). Buscar con el de WhatsApp devuelve **cero
resultados**. El módulo prueba las dos formas.

### Estados reales

`estado`: `Activo` · `Suspendido` · `Gratis`
`estado_facturas`: `Pagadas` · `Pendiente de Pago`

## Cobro automático

Existe pero **no está enganchado a ningún botón todavía**, a propósito. El código
(`cobrarGuardado`) solo cobra si el cliente aceptó explícitamente, y la tarjeta
solo se guarda si `generarLinkPago` recibe `guardarTarjeta: true`.

Antes de encenderlo, el texto que ve el cliente tiene que decir con esas palabras
que se le va a cobrar cada mes y cómo se cancela.

## Casos raros que ya están cubiertos

Todos salieron de datos reales del padrón, no de imaginarlos:

**El teléfono con varios servicios.** 26 teléfonos tienen más de un contrato; uno
tiene tres, y hay uno compartido por dos personas distintas. Se prefiere el
SUSPENDIDO (es el que están pagando). Si hay dos suspendidos no se adivina: el
pago queda sin aplicar, se avisa a la oficina con la lista, y al cliente se le
dice que un asesor lo va a aplicar.

**El cliente adelantado.** 11 de cada 300 tienen saldo a favor. Si transfiere sin
deber, el dinero se identifica como saldo a favor y se avisa para aplicarlo a
mano: no puede desaparecer.

**El que paga horas antes del corte.** Sigue Activo, así que no se le toca el
servicio. Solo se registra el pago.

**El pago parcial.** Si paga menos de lo que debe, NO se reconecta (sería regalar
el resto) y se le dice cuánto falta. Se puede cambiar con
`WISPHUB_REACTIVAR_CON_SALDO=true` si León prefiere reconectar por buena voluntad.

**El pago doble entre canales.** Saca ficha de OXXO y además transfiere: los dos
pagos entran de verdad. No se bloquea (hay razones legítimas), pero se detecta
dentro de 20 días y se avisa el mismo día para poder devolverle.

**OXXO.** Llega en dos avisos separados por días (`async_payment_succeeded`), no
como un pago normal. Sin escuchar ese evento, quien paga en la tienda nunca
recibe confirmación.

**Si Wisphub se cae.** El pago no se pierde: se confirma al cliente igual y la
reactivación se reporta como fallida en vez de tronar.

**Si no se puede leer la deuda.** NO se reactiva. Reconectar sin saber si pagó lo
suficiente es regalar servicio.

## Lo que sigue siendo manual

La API de Wisphub **no permite marcar una factura como pagada**: `estado` es de
solo lectura y no existe endpoint de pagos (se buscaron nueve nombres). El pago
entra, el cliente se reconecta solo, pero la factura sigue apareciendo como
deuda hasta que alguien la marque.

Eso importa: con la factura pendiente le siguen llegando recordatorios de corte
y en el siguiente ciclo lo pueden volver a suspender. Por eso el resumen
matutino trae la lista de facturas por marcar, con número y monto, y se depura
sola contra Wisphub para no repetir lo ya hecho.

## El chequeo de "¿ya puedo encender?"

```
node revisar-listo.mjs
```

Junta en una sola respuesta todo lo que hace falta y te dice qué falta: si el
servidor desplegado ya trae la ruta del webhook, si Wisphub contesta y su
endpoint de reactivación existe, si Stripe puede cobrar, si **transferencias
bancarias** está encendido (sin eso no hay CLABE), y si el webhook escucha los
cuatro eventos.

Las llaves las lee de `.stripe-key` y `.wisphub-key` (los dos en `.gitignore`),
nunca del comando: escribirlas ahí las deja en el historial de la terminal.

Existe porque encender depende de seis cosas que viven en lugares distintos, y
olvidar una **no da error en ningún lado**: simplemente el dinero entra y nadie
se entera, o el cliente paga y sigue cortado.

## Pruebas

```
node verificar-cobro-leon.mjs     # 53 comprobaciones del módulo de cobro
node verificar-webhook-leon.mjs   # 17 del cableado en index.js
node verificar-wisphub.mjs        # 44 de la reactivación
node revisar-stripe.mjs          # la cuenta de Stripe a detalle
node revisar-listo.mjs           # TODO junto: ¿ya puedo encender?
node demo-cobro-leon.mjs          # demo visual en :4310
```

Ninguna toca Stripe de verdad: hay un Stripe falso que reproduce el retraso de
indexado, la idempotencia y los rechazos del banco.

## Lo que está blindado, y por qué

**La CLABE no puede cambiar nunca.** El cliente ya la anotó en su banco. Hay un
registro local persistente (`stripeClientes`) que manda sobre la búsqueda de
Stripe, porque esa búsqueda tarda hasta un minuto en indexar y dos peticiones
seguidas crearían dos clientes con dos CLABEs. Hay además un candado para dos
toques simultáneos. Si Stripe devuelve una CLABE que no son 18 dígitos, se falla
en vez de entregarla.

**Nadie puede cobrar dos veces.** El cobro automático lleva llave de idempotencia
con el mes dentro (`leon-auto-<tel>-2026-09`), así que reintentar el cobro de
septiembre es siempre el mismo cobro. Los avisos repetidos de Stripe se ignoran
con el candado `stripeVistos`.

**El dinero que entra sin dueño no se pierde en silencio.** Un pago sin teléfono
o un depósito de un cliente fuera del registro llama a `alertAdmin` para que un
humano lo revise.

**Un rechazo del banco no truena nada.** `authentication_required` y
`card_declined` devuelven un resultado, no una excepción: son la respuesta normal
de un cobro que no pasó.
