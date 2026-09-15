# Activar el cobro en línea de León Telecom

Todo el código está puesto y **apagado**. Nada de lo que sigue se mueve hasta
que pongas `COBRO_LINEA_ACTIVO=true`. Mientras esté apagado, los 1,090 clientes
ven exactamente lo mismo de siempre: horario en oficina y datos de pago.

## El interruptor

| Variable | Qué hace |
|---|---|
| `COBRO_LINEA_ACTIVO` | `true` enciende. Cualquier otra cosa lo deja apagado. |
| `COBRO_LINEA_TELEFONOS` | A quién se le ofrece. Vacío = solo el piloto. Un número = esa cantidad de clientes. Lista con comas = esos. `NN%` = esa fracción del padrón. `*` = todos. |

```
Solo tú (piloto 529516549145):  COBRO_LINEA_ACTIVO=true
Los 50 acordados con León:      COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=50
Unos cuantos a dedo:            COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=5219511111111,5219512222222
Uno de cada diez:               COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=10%
Todo el pueblo:                 COBRO_LINEA_ACTIVO=true   COBRO_LINEA_TELEFONOS=*
Apagar de emergencia:           COBRO_LINEA_ACTIVO=false
```

**Un número pelón son CLIENTES, y es la forma recomendada de abrir.** Los tratos
se cierran en clientes, no en porcentajes: con León se acordó empezar con 50, y
`COBRO_LINEA_TELEFONOS=50` son exactamente 50, no "más o menos". Si el padrón
crece, siguen siendo 50 hasta que alguien decida otra cosa, que es justo lo que
un porcentaje NO hace: 4.8% de 1,050 son 50 clientes, pero de 1,400 son 67 sin
que nadie lo haya decidido.

Entre el teléfono piloto y `*` hay un salto de 1 a 1,430 clientes, y en el
primer mes de mover dinero de verdad conviene enterarse de los problemas con 50
personas, no con todas.

**Y los 50 no se eligen al azar: entran primero los suspendidos o con adeudo.**
Son los que de verdad van a usar el pago en línea. Un piloto hecho con clientes
que pagan puntual en la oficina mide mal, y puede hacer parecer que la cosa no
sirve cuando lo que pasa es que a esos no les hacía falta.

La lista se decide UNA vez y se guarda. Quien entró se queda, aunque pague y lo
reactiven: si dependiera de su estado, vería el botón un día y no al otro.

Quién entra se decide con el número de teléfono, no al azar, así que **el mismo
cliente obtiene siempre la misma respuesta**: nadie ve el botón un día y lo
pierde al siguiente. Y al subir el cupo solo se agrega gente, nunca se le quita
a quien ya lo tenía.

Si el padrón todavía no ha cargado (Wisphub caído, servidor recién arrancado),
un cupo por número **no se reparte a ciegas**: se queda solo el piloto y se
avisa en el registro. Preferible una persona de menos que mil de más.

Apagar no requiere tocar código ni volver a desplegar. Es una variable en Render.

## Lo que falta antes de encenderlo

1. **La cuenta a la que le cae el dinero.** Ya NO hace falta crearla a mano:
   León la da de alta desde su panel, en Cobranza → "¿A dónde te llega el
   dinero?". Necesita identificación, RFC y CLABE. `LEON_STRIPE_CUENTA_CONECTADA`
   sigue funcionando como respaldo si se prefiere ponerla a mano.
2. **`STRIPE_SECRET_KEY`** — la misma llave de plataforma que usa Aforo.
3. **`STRIPE_WEBHOOK_SECRET_LEON`** — el secreto del webhook, distinto del de
   Aforo aunque la llave de plataforma sea la misma.
4. **Registrar el webhook en Stripe** apuntando a `POST /webhook/stripe` con
   estos eventos:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded` ← cuando pagan la ficha de OXXO
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired` (el link venció sin abrirse: se le avisa al cliente)
   - `customer_cash_balance_transaction.created` ← **el de la CLABE, no se te olvide**
   - `charge.dispute.created` y `charge.dispute.closed` ← los contracargos
   - `charge.refunded`
   - `payment_intent.payment_failed`

   `node revisar-listo.mjs` los revisa uno por uno y dice cuál falta.
5. **Activar transferencias bancarias MXN** en el panel de Stripe. Sin eso, la
   CLABE no se genera.

## Las tres formas de pagar

**CLABE fija** (`🏦 Mi CLABE fija`) — Stripe le da al cliente una cuenta bancaria
suya, para siempre. La anota una vez en su banco y cada mes deposita ahí. No
caduca, no hay links, y el pago se registra solo. Es la que más le va a servir a
la gente que paga por transferencia o en ventanilla.

**Tarjeta u OXXO** (`💳 Tarjeta u OXXO`) — **primero cotiza las dos y pregunta
cuál**, porque cada una tiene su tarifa. Al elegir, sale un link de Checkout
amarrado a esa forma (`payment_method_types` de una sola), que vence en 32
minutos. Antes era un solo link donde el cliente elegía dentro de Stripe; con
tarifas distintas eso significaba cotizarle una forma y cobrarle la otra.

**Otras formas** (`🏢 Otras formas`) — horario de oficina y los datos de pago de
siempre, con comprobante. Nunca desaparece: pagar como toda la vida sigue siendo
gratis.

## El dinero

León Telecom recibe **su precio de plan íntegro**. El cargo por pagar en línea lo
paga el cliente que elige la comodidad, y de ahí sale tanto el costo real de
Stripe como la parte de OBEX. Es el mismo trato que un organizador en Aforo.

**Hay una tarifa por forma de pago**, en `TARIFAS` dentro de `utils/stripeLeon.js`.
Son los números de la propuesta **AFO-LT-003** que León Telecom ya tiene en la
mano, y tienen que seguir coincidiendo: un documento que promete $460 y un cobro
que pide $470 es la peor forma de estrenar el servicio.

| Forma | Cargo | Con un plan de $440 | Cuesta procesar | Queda |
|---|---|---|---|---|
| Transferencia (CLABE) | `$20` fijo | Paga $460.00 | $8.12 | $11.88 |
| Tarjeta | `$12 + 5.5%` | Paga $476.20 | $23.37 | $12.83 |
| OXXO | `$12 + 6%` | Paga $478.40 | $25.68 | $12.72 |
| Efectivo en oficina | `$0` | Paga $440.00 | — | — |

Recibir cada forma cuesta distinto, por eso la tarifa es distinta: con una tarifa
pareja sobraba margen en la transferencia y casi no quedaba nada en OXXO. La de
transferencia es **fija** porque el costo de SPEI también lo es; cobrar
porcentaje ahí sería cobrar por nada.

`calcularCargo(monto, forma)` **exige la forma** y truena si no la reconoce. Un
valor por omisión ahí significaría cobrar la tarifa equivocada en silencio el día
que alguien agregue una vía nueva y olvide pasarla, y eso no se nota hasta que no
cuadra la caja.

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

**Paga completo pero Wisphub no deja marcar la factura.** Es el caso NORMAL, no
uno raro: la API casi nunca deja marcar. La reconexión se decide con el dinero
que entró, no con lo que Wisphub alcanzó a registrar: si pagó lo que debía, se
reconecta, y la factura sin marcar le llega a la oficina como pendiente con su
número. Antes de este arreglo el cliente pagaba sus $440 y se quedaba cortado.

**Pagar la cuenta de otro.** La mamá sin WhatsApp, el vecino, la suegra. Quien
escribe manda *OTRO*, dice de quién es (teléfono o nombre como está en el
contrato), confirma con un botón y de ahí paga con tarjeta u OXXO como siempre.
El cobro va a la cuenta del otro, el acuse a quien pagó, la reconexión al dueño
y el aviso a los dos. Lo dicho vale media hora: después, PAGAR vuelve a ser para
la propia cuenta. "menú" saca del paso en cualquier momento.

**Cobro automático cada mes.** El cliente escribe *AUTOMÁTICO*, confirma con un
botón y paga una vez con tarjeta (queda guardada). Después, cada mes: dos días
antes de su fecha de corte se le avisa cuánto se va a cobrar; un día antes se
cobra lo que Wisphub diga que debe (si está al corriente, no se cobra nada) y
se le confirma a qué tarjeta. Rechazos: se le pide pagar por otra vía y se
avisa a la oficina. *CANCELAR AUTOMÁTICO* lo quita al instante. Una sola vez
por periodo aunque el servidor se reinicie (`autoCobros`), y el barrido corre
cada hora entre 9 y 20.

**Varios meses de jalón.** "quiero pagar 6 meses": lo que debe más los meses
siguientes al precio de su plan. Queda anotado hasta cuándo está cubierto
(sin avisos de corte) y la oficina recibe el aviso de registrar los meses que
Wisphub no tiene.

**Prórrogas.** El asesor escribe `PRORROGA 9511234567 3` (días) y el cliente
recibe hasta cuándo tiene; el aviso de corte se calla hasta que venza. También
desde el panel (`/admin/api/prorrogas`).

**El aviso de corte no le llega a quien ya pagó.** Ni por el bot (tarjeta,
OXXO, CLABE, automático) ni con comprobante ya aceptado por la oficina, aunque
Wisphub siga marcando la factura pendiente.

**Un teléfono con varios contratos.** Se pregunta cuál antes de cobrar por
cualquier vía; el link y la CLABE llevan el id del servicio y el webhook abona
y reactiva exactamente ese.

**Nada se reactiva antes de tiempo.** Ni al generar el link ni al sacar la ficha
de OXXO se toca el servicio. Solo cuando Stripe avisa que el dinero entró
(`checkout.session.completed` pagado o `async_payment_succeeded`), y solo a
través del webhook firmado.

**OXXO.** Llega en dos avisos separados por días (`async_payment_succeeded`), no
como un pago normal. Sin escuchar ese evento, quien paga en la tienda nunca
recibe confirmación.

**Si Wisphub se cae.** El pago no se pierde: se confirma al cliente igual y la
reactivación se reporta como fallida en vez de tronar.

**Si no se puede leer la deuda.** NO se reactiva. Reconectar sin saber si pagó lo
suficiente es regalar servicio. Y tampoco se reparte el dinero: sin saber cuánto
debía, no se puede saber cuánto de su depósito es excedente, y cobrar comisión a
ciegas sería quitársela a la mensualidad de León. El depósito se queda en Stripe
(a salvo, a nombre del cliente) y se reintenta cada 10 minutos. Si Wisphub no
vuelve en 40 minutos, el dinero se manda **completo a León Telecom, sin cobrar
comisión**: perder el cargo es mucho más barato que cobrarle de más.

**El dinero que se atora en Stripe.** Una transferencia a la CLABE cae en el
saldo del cliente *dentro* de Stripe y no llega a León hasta que alguien la
cobra. Ese cobro puede fallar, y antes solo salía una alerta esperando a que una
persona lo moviera a mano. Ahora hay dos redes:

- **Reintento** cada 10 minutos de los depósitos que se sabe que fallaron.
- **Auditoría** cada 6 horas de **todos** los clientes con CLABE, por si el aviso
  de Stripe nunca llegó y entonces nadie sabía siquiera que había dinero.

Cuando la auditoría encuentra dinero del que nadie estaba enterado, además de
moverlo le avisa al cliente y aplica el pago, porque para él ya había pagado y
no había pasado nada.

En el panel de administración, dentro de **Cobranza**, hay una tarjeta *Cobro en
línea* que enseña cuánto dinero está atorado, de quién, desde cuándo y por qué,
con un botón para buscarlo y moverlo al momento sin esperar los 10 minutos
(cuando alguien llama diciendo "ya transferí"). Por API son
`GET /admin/api/stripe/estado`, `GET /admin/api/stripe/rezagados` y
`POST /admin/api/stripe/barrer` (con `?auditar=1` para revisar a todos).

**Contracargos y devoluciones.** Antes no se escuchaban: el banco se llevaba el
dinero y el sistema seguía creyendo que ese mes estaba pagado. Ahora llegan al
webhook y se avisan con nombre y monto. **A nadie se le corta el internet
automáticamente** por un contracargo: la mayoría nacen de no reconocer el nombre
del cargo en el estado de cuenta, no de un fraude. La decisión es de una persona.
En el resumen matutino van en su propio bloque, separados de los pagos por
registrar, con la advertencia de no marcar esas facturas como pagadas.

**Un depósito de un cliente que el registro no reconoce.** Pasa si el registro
local se pierde (base nueva, migración). No hace falta rendirse: cada cliente se
creó con su teléfono en el metadata de Stripe, así que se le pregunta a Stripe de
quién era y se vuelve a anotar.

**Un aviso que Stripe reintenta después de un reinicio de Render.** Stripe
reintenta hasta tres días y Render reinicia en cada despliegue. El candado de
"esto ya se procesó" ahora se guarda con el estado, así que el reintento no
vuelve a cobrar ni manda un segundo "ya quedó".

**Wisphub contestando con la lista vacía.** Lo más peligroso que le puede pasar
al bot: dejaría de reconocer a los 1,430 clientes de golpe, nadie podría pedir su
CLABE, y el respaldo se sobrescribiría vacío. Ahora la lista nueva se arma aparte
y solo sustituye a la buena si llegó entera; una lista vacía o cortada a la mitad
se rechaza, se conserva la anterior y se avisa.

### El monto que se le pide al cliente NO es su plan

Es la parte del sistema donde más fácil se pierde dinero, y no se nota.

El cargo por pagar en línea sale del **excedente** sobre lo que el cliente
debía. Si transfiere justo su mensualidad, el excedente es cero y no se cobra
nada. Y recibir esa transferencia le cuesta a la plataforma **$8.12**
(comprobado contra la API de Stripe con un cargo real: entraron $440, quedaron
$431.88). O sea que un pago sin cargo no es "ganar cero", es **perder $8.12**.

Por eso el mensaje de la CLABE trae el **total exacto** con el cargo ya sumado,
sacado de sus facturas pendientes. Si dijera "transfiere el monto de tu plan",
todo el mundo transferiría justo eso y con el padrón entero serían más de once
mil pesos al mes de pérdida, en silencio.

Los pagos que aun así entran sin cargo (alguien que transfiere de memoria) se
cuentan y se ven en el panel, en la tarjeta de Cobro en línea, con lo que
costaron.

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
node verificar-cobro-leon.mjs     #  94 comprobaciones del módulo de cobro
node verificar-webhook-leon.mjs   #  53 del cableado en index.js
node verificar-wisphub.mjs        #  51 de la reactivación
node verificar-rescate-leon.mjs   #  62 del dinero atorado y los contracargos
node verificar-cuenta-leon.mjs    # 110 de la cuenta de León y el piloto
node verificar-whatsapp-leon.mjs  # 115 de la conversación: pagar por otro, contratos, meses, automático, corte, reinicio
node revisar-stripe.mjs           # la cuenta de Stripe a detalle
node revisar-listo.mjs            # TODO junto: ¿ya puedo encender?
node demo-cobro-leon.mjs          # demo visual en :4310
```

**485 comprobaciones en total.** Ninguna toca Stripe, Wisphub ni WhatsApp de verdad: hay un
Stripe falso que reproduce el retraso de indexado, la idempotencia y los rechazos
del banco, y un Wisphub falso que se puede tirar a voluntad para ver qué hace el
sistema cuando no contesta.

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
