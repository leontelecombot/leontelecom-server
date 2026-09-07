/**
 * COBRO EN LÍNEA DE LEÓN TELECOM — pruebas de verdad.
 *
 * Levanta un Stripe falso que se comporta como el de verdad en lo que importa:
 *   - la búsqueda tarda en indexar (por eso existe el registro local)
 *   - los cargos repetidos con la misma llave de idempotencia NO se cobran dos veces
 *   - el banco puede pedir 3DS o rechazar la tarjeta
 *
 * Lo que más se cuida aquí es que NADIE pueda cobrar dos veces y que la CLABE
 * de un cliente NUNCA cambie: son los dos errores que no se notan el día que
 * pasan y salen carísimos meses después.
 *
 *   node verificar-cobro-leon.mjs
 */
import { createServer } from 'node:http';

const PUERTO_STRIPE = 4399;
process.env.STRIPE_API_BASE = `http://127.0.0.1:${PUERTO_STRIPE}/v1/`;
process.env.STRIPE_SECRET_KEY = 'sk_test_falsa';
process.env.LEON_STRIPE_CUENTA_CONECTADA = 'acct_leontelecom';

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };

// ── Stripe falso ────────────────────────────────────────────────────────────
const estado = {
  clientes: [],          // los creados
  indexados: new Set(),  // los que la búsqueda YA puede ver
  pedidos: [],
  idempotencia: new Map(),
  cobros: [],
  proximoError: null,
  clabePorCliente: new Map(),
  clabeRota: false,
};

const stripeFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const params = new URLSearchParams(cuerpo);
    const llaveIdem = req.headers['idempotency-key'] || '';
    estado.pedidos.push({ ruta: req.url, params, llaveIdem });
    res.setHeader('content-type', 'application/json');
    const responder = (obj, codigo = 200) => { res.statusCode = codigo; res.end(JSON.stringify(obj)); };

    // Idempotencia de verdad: misma llave = misma respuesta, sin repetir el efecto.
    if (llaveIdem && estado.idempotencia.has(llaveIdem)) {
      return responder(estado.idempotencia.get(llaveIdem));
    }

    if (req.url.startsWith('/v1/customers/search')) {
      const q = decodeURIComponent(req.url.split('query=')[1] || '');
      const tel = (q.match(/'(\d+)'/) || [])[1];
      // Solo devuelve los que ya se indexaron: así se reproduce el retraso real.
      const hallado = estado.clientes.find((c) => c.metadata.telefono === tel && estado.indexados.has(c.id));
      return responder({ data: hallado ? [hallado] : [] });
    }

    if (/^\/v1\/customers\/[^/]+\/funding_instructions/.test(req.url)) {
      const id = req.url.split('/')[3];
      if (estado.clabeRota) {
        return responder({ bank_transfer: { financial_addresses: [{ spei: { clabe: '123' } }] } });
      }
      if (!estado.clabePorCliente.has(id)) {
        estado.clabeParaContar = (estado.clabeParaContar || 0) + 1;
        estado.clabePorCliente.set(id, String(646180100000000000 + estado.clabePorCliente.size).slice(0, 18));
      }
      return responder({
        bank_transfer: { financial_addresses: [{ spei: {
          clabe: estado.clabePorCliente.get(id), bank_name: 'STP', reference: '1234',
        } }] },
      });
    }

    if (req.url === '/v1/customers') {
      const c = { id: 'cus_' + (estado.clientes.length + 1), metadata: { telefono: params.get('metadata[telefono]') } };
      estado.clientes.push(c);
      if (llaveIdem) estado.idempotencia.set(llaveIdem, c);
      return responder(c);
    }

    if (req.url === '/v1/payment_intents') {
      // Como la de verdad: customer_balance NO admite on_behalf_of.
      if (params.get('payment_method_types[0]') === 'customer_balance' && params.get('on_behalf_of')) {
        return responder({ error: { message: 'The provided payment method types (["customer_balance"]) do not support `on_behalf_of`.' } }, 400);
      }
      if (estado.proximoError) {
        const e = estado.proximoError; estado.proximoError = null;
        return responder({ error: e }, 402);
      }
      const pi = { id: 'pi_' + (estado.cobros.length + 1), status: 'succeeded', amount: Number(params.get('amount')) };
      estado.cobros.push({ ...pi, llaveIdem });
      if (llaveIdem) estado.idempotencia.set(llaveIdem, pi);
      return responder(pi);
    }

    if (req.url === '/v1/checkout/sessions') {
      const s = { id: 'cs_' + Date.now(), url: 'https://pago.falso/ir' };
      if (llaveIdem) estado.idempotencia.set(llaveIdem, s);
      return responder(s);
    }

    responder({ id: 'obj' });
  });
});
await new Promise((r) => stripeFalso.listen(PUERTO_STRIPE, r));

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const stripeLeon = require('/home/manuel-flores/LEON-TELECOM/leontelecom-server/utils/stripeLeon.js');

const TEL = '529516549145';

console.log('\n=== 1. EL INTERRUPTOR ===');
{
  process.env.COBRO_LINEA_ACTIVO = 'false';
  process.env.COBRO_LINEA_TELEFONOS = '';
  stripeLeon.activo() === false ? OK('apagado por defecto') : MAL('nació encendido');
  stripeLeon.permitido(TEL, TEL) === false ? OK('apagado, nadie pasa (ni el piloto)') : MAL('pasó estando apagado');

  try { await stripeLeon.clabeDelCliente({ telefono: TEL }); MAL('generó CLABE estando apagado'); }
  catch { OK('apagado, no genera CLABEs'); }
  try { await stripeLeon.cobrarGuardado({ clienteId: 'cus_1', metodoPago: 'pm_1', monto: 440, telefono: TEL }); MAL('cobró estando apagado'); }
  catch { OK('apagado, no cobra'); }

  process.env.COBRO_LINEA_ACTIVO = 'true';
  stripeLeon.permitido(TEL, TEL) === true ? OK('encendido, el piloto sí pasa') : MAL('el piloto no pasó');
  stripeLeon.permitido('5219990000000', TEL) === false ? OK('pero nadie más') : MAL('pasó alguien que no era el piloto');

  // El mismo número escrito de otra forma tiene que dar lo MISMO: si la
  // comparación fuera literal, el cliente vería el botón desde un formato y no
  // desde otro, y eso es imposible de depurar desde el otro lado del teléfono.
  stripeLeon.permitido('+52 951 654 9145', TEL) === true ? OK('el mismo número con espacios y + se reconoce igual') : MAL('confundió formatos del mismo número');
  stripeLeon.permitido('529516549146', TEL) === false ? OK('y un número parecido pero distinto NO pasa') : MAL('pasó un número que no era');
  stripeLeon.permitido('529516549145', '+52 951-654-9145') === true ? OK('el piloto se reconoce con guiones y espacios') : MAL('no reconoció el formato con guiones');

  process.env.COBRO_LINEA_TELEFONOS = '5219511111111, 5219512222222';
  stripeLeon.permitido('5219511111111', TEL) === true ? OK('la lista amplía a quien se le ponga') : MAL('la lista no funcionó');
  stripeLeon.permitido(TEL, TEL) === false ? OK('y con lista puesta, manda la lista') : MAL('el piloto se coló sin estar en la lista');

  process.env.COBRO_LINEA_TELEFONOS = '*';
  stripeLeon.permitido('5219998887777', TEL) === true ? OK('con * pasan todos') : MAL('el * no funcionó');

  process.env.COBRO_LINEA_ACTIVO = 'TRUE';
  stripeLeon.activo() === false ? OK("solo 'true' exacto enciende (ni TRUE ni 1)") : MAL('se encendió con TRUE');
  process.env.COBRO_LINEA_ACTIVO = 'true';
  process.env.COBRO_LINEA_TELEFONOS = '';
}

console.log('\n=== 1b. ABRIR DE A POCO, SIN LISTAS A MANO ===');
{
  // Un padrón de mentira del tamaño del de verdad.
  const padron = [];
  for (let i = 0; i < 1430; i++) padron.push('52951' + String(1000000 + i));
  const cuantos = (regla) => {
    process.env.COBRO_LINEA_TELEFONOS = regla;
    return padron.filter((t) => stripeLeon.permitido(t)).length;
  };

  cuantos('0%') === 0 ? OK('con 0% no pasa nadie') : MAL('el 0% dejó pasar gente');
  const diez = cuantos('10%');
  Math.abs(diez - 143) <= 30 ? OK(`con 10% pasa ~el 10% (${diez} de 1430)`) : MAL('el 10% dio ' + diez);
  cuantos('100%') === 1430 ? OK('con 100% pasan todos') : MAL('el 100% no dejó pasar a todos');

  /*
   * Lo que de verdad importa de un despliegue por porcentaje: que sea SIEMPRE
   * el mismo. Si fuera al azar, un cliente vería el botón el lunes y no el
   * martes, y llamaría a la oficina a preguntar por qué.
   */
  process.env.COBRO_LINEA_TELEFONOS = '10%';
  const a = padron.filter((t) => stripeLeon.permitido(t));
  const b = padron.filter((t) => stripeLeon.permitido(t));
  a.length === b.length && a.every((x, i) => x === b[i])
    ? OK('al mismo cliente siempre le toca lo mismo (no es al azar)')
    : MAL('el resultado cambió entre dos consultas');

  // Y al abrir más, a nadie se le quita lo que ya tenía.
  process.env.COBRO_LINEA_TELEFONOS = '25%';
  const c = new Set(padron.filter((t) => stripeLeon.permitido(t)));
  a.every((x) => c.has(x))
    ? OK('al subir de 10% a 25% nadie pierde el acceso que ya tenía')
    : MAL('alguien perdió el botón al ampliar el porcentaje');

  process.env.COBRO_LINEA_TELEFONOS = '5219511000005,5219511000009';
  stripeLeon.permitido('5219511000005') === true && stripeLeon.permitido('5219511000006') === false
    ? OK('y la lista de teléfonos de siempre sigue funcionando igual')
    : MAL('el porcentaje rompió la lista explícita');
  process.env.COBRO_LINEA_TELEFONOS = '';
}

console.log('\n=== 2. LA CLABE NUNCA CAMBIA ===');
{
  const a = await stripeLeon.clabeDelCliente({ telefono: TEL, nombre: 'Cliente Piloto' });
  /^\d{18}$/.test(a.clabe) ? OK('la primera vez entrega una CLABE de 18 dígitos') : MAL('CLABE: ' + a.clabe);
  a.clienteId ? OK('y recuerda su cliente de Stripe') : MAL('sin cliente');

  const b = await stripeLeon.clabeDelCliente({ telefono: TEL, nombre: 'Cliente Piloto' });
  b.clabe === a.clabe ? OK('la segunda vez es LA MISMA') : MAL(`cambió: ${a.clabe} → ${b.clabe}`);
  estado.clientes.length === 1 ? OK('y no creó un cliente duplicado') : MAL('creó ' + estado.clientes.length + ' clientes');

  // El caso que rompe todo: dos toques a la vez, ANTES de que Stripe indexe.
  const tel2 = '5219513333333';
  const [x, y] = await Promise.all([
    stripeLeon.clabeDelCliente({ telefono: tel2, nombre: 'Doble Toque' }),
    stripeLeon.clabeDelCliente({ telefono: tel2, nombre: 'Doble Toque' }),
  ]);
  x.clabe === y.clabe ? OK('dos toques simultáneos dan la MISMA CLABE') : MAL(`dos CLABEs: ${x.clabe} vs ${y.clabe}`);
  estado.clientes.filter((c) => c.metadata.telefono === tel2).length === 1
    ? OK('y un solo cliente, aunque la búsqueda todavía no lo indexara') : MAL('se duplicó el cliente');

  // Sin teléfono no hay cuenta que entregar.
  try { await stripeLeon.clabeDelCliente({ telefono: '' }); MAL('aceptó sin teléfono'); }
  catch { OK('sin teléfono no entrega nada'); }
}

console.log('\n=== 3. UNA CLABE A MEDIAS NO SE ENTREGA ===');
{
  estado.clabeRota = true;
  try {
    await stripeLeon.clabeDelCliente({ telefono: '5219514444444', nombre: 'Rota' });
    MAL('entregó una CLABE inválida');
  } catch (e) {
    /CLABE válida/.test(e.message) ? OK('si Stripe devuelve basura, falla fuerte en vez de darla') : MAL('error raro: ' + e.message);
  }
  estado.clabeRota = false;
  stripeLeon.clabeValida('012345678901234567') === true ? OK('18 dígitos es válida') : MAL('rechazó una buena');
  stripeLeon.clabeValida('123') === false ? OK('3 dígitos no') : MAL('aceptó una corta');
  stripeLeon.clabeValida('') === false ? OK('vacía tampoco') : MAL('aceptó vacía');
}

console.log('\n=== 4. EL REGISTRO SOBREVIVE AL REINICIO ===');
{
  // Se simula el reinicio: registro nuevo, pero con lo que se había guardado.
  const guardado = new Map();
  stripeLeon.usarRegistro({
    obtener: (t) => guardado.get(t) || null,
    guardar: (t, d) => { guardado.set(t, d); },
  });
  const tel = '5219515555555';
  const antes = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Persistente' });
  guardado.has(tel) ? OK('la CLABE se guarda en el registro') : MAL('no se guardó');

  const clientesAntes = estado.clientes.length;
  const despues = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Persistente' });
  despues.clabe === antes.clabe ? OK('tras el reinicio devuelve la misma') : MAL('cambió tras reiniciar');
  estado.clientes.length === clientesAntes ? OK('sin hablarle a Stripe de nuevo') : MAL('creó otro cliente');
}

console.log('\n=== 5. COBRO AUTOMÁTICO: NUNCA DOS VECES ===');
{
  const pedir = () => stripeLeon.cobrarGuardado({
    clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440,
    telefono: TEL, nombre: 'Piloto', periodo: '2026-09',
  });

  const uno = await pedir();
  uno.ok === true ? OK('el cobro del mes pasa') : MAL(JSON.stringify(uno));
  uno.total === 440 + 8 + 440 * 0.05 ? OK(`total $${uno.total} (mensualidad + cargo)`) : MAL('total ' + uno.total);

  const cobrosAntes = estado.cobros.length;
  const dos = await pedir();
  estado.cobros.length === cobrosAntes
    ? OK('repetir el cobro del MISMO mes no cobra otra vez') : MAL('¡cobró dos veces!');
  dos.id === uno.id ? OK('y devuelve el mismo cobro') : MAL(`${uno.id} vs ${dos.id}`);

  const otroMes = await stripeLeon.cobrarGuardado({
    clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440,
    telefono: TEL, nombre: 'Piloto', periodo: '2026-10',
  });
  otroMes.id !== uno.id ? OK('pero el mes siguiente sí es un cobro nuevo') : MAL('no cobró octubre');
  /2026-09/.test(uno.referencia) ? OK('la llave lleva el periodo dentro') : MAL('referencia: ' + uno.referencia);
}

console.log('\n=== 6. CUANDO EL BANCO DICE QUE NO ===');
{
  estado.proximoError = { code: 'authentication_required', type: 'card_error', message: 'Tu banco pide confirmación.' };
  const r = await stripeLeon.cobrarGuardado({
    clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440, telefono: TEL, periodo: '2026-11',
  });
  r.ok === false ? OK('un 3DS no truena el programa') : MAL('debió devolver ok:false');
  r.estado === 'rechazado' ? OK('lo reporta como rechazado') : MAL('estado: ' + r.estado);
  r.necesitaAlCliente === true ? OK('y avisa que hace falta el cliente presente') : MAL('no marcó que se necesita al cliente');

  estado.proximoError = { code: 'card_declined', type: 'card_error', message: 'Tarjeta rechazada.' };
  const d = await stripeLeon.cobrarGuardado({
    clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440, telefono: TEL, periodo: '2026-12',
  });
  d.ok === false && d.motivo === 'card_declined' ? OK('una tarjeta rechazada también se maneja') : MAL(JSON.stringify(d));

  // Un error que NO es del banco sí debe tronar: es una avería de verdad.
  estado.proximoError = { code: 'api_error', type: 'api_error', message: 'Stripe se cayó.' };
  try {
    await stripeLeon.cobrarGuardado({ clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440, telefono: TEL, periodo: '2027-01' });
    MAL('se tragó una avería de Stripe');
  } catch { OK('una avería de verdad sí se levanta, no se disimula'); }
}

console.log('\n=== 7. LA TARJETA SOLO SE GUARDA SI LA PIDIERON ===');
{
  const normal = await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, nombre: 'Piloto', urlBase: 'https://x.mx' });
  const p1 = estado.pedidos.filter((p) => p.ruta.includes('checkout/sessions')).pop();
  !p1.params.get('payment_intent_data[setup_future_usage]')
    ? OK('un pago normal NO guarda la tarjeta') : MAL('guardó la tarjeta sin permiso');
  p1.params.get('metadata[guardarTarjeta]') === 'no' ? OK('y así queda marcado') : MAL('marca: ' + p1.params.get('metadata[guardarTarjeta]'));

  await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, urlBase: 'https://x.mx', guardarTarjeta: true, clienteId: 'cus_1' });
  const p2 = estado.pedidos.filter((p) => p.ruta.includes('checkout/sessions')).pop();
  p2.params.get('payment_intent_data[setup_future_usage]') === 'off_session'
    ? OK('si el cliente lo pidió, sí la guarda') : MAL('no la guardó habiéndola pedido');
  p2.params.get('customer') === 'cus_1' ? OK('con su cliente, para poder cobrarle después') : MAL('sin customer');

  try {
    await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, urlBase: 'https://x.mx', guardarTarjeta: true });
    MAL('dejó guardar la tarjeta sin cliente (no serviría el mes que viene)');
  } catch { OK('sin cliente NO deja guardar: fallaría en silencio dentro de 30 días'); }
}

console.log('\n=== 8. EL DINERO VA A LEÓN TELECOM, NO A LA PLATAFORMA ===');
{
  await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, urlBase: 'https://x.mx' });
  const p = estado.pedidos.filter((x) => x.ruta.includes('checkout/sessions')).pop();
  p.params.get('payment_intent_data[transfer_data][destination]') === 'acct_leontelecom'
    ? OK('el dinero se transfiere a la cuenta de León Telecom') : MAL('destino equivocado');

  const c = stripeLeon.calcularCargo(440);
  p.params.get('payment_intent_data[application_fee_amount]') === String(c.cargoCentavos)
    ? OK('y aquí solo se queda el cargo por servicio') : MAL('comisión mal calculada');

  // León Telecom debe recibir su plan ÍNTEGRO.
  const recibe = (c.totalCentavos - c.cargoCentavos) / 100;
  recibe === 440 ? OK('León Telecom recibe sus $440 completos') : MAL('recibiría ' + recibe);
  p.params.get('line_items[0][price_data][unit_amount]') === String(c.baseCentavos)
    ? OK('y el cliente ve los dos renglones por separado') : MAL('renglones mal');
}

console.log('\n=== 8b. QUIÉN RESPONDE POR UN CONTRACARGO ===');
{
  /*
   * Sin `on_behalf_of`, la plataforma es el comercio ante el banco y paga las
   * disputas de un servicio que no presta. Con 872 pagos al mes eso deja de
   * ser teórico. Esta prueba existe para que nadie lo quite sin darse cuenta.
   */
  await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, urlBase: 'https://x.mx' });
  const p = estado.pedidos.filter((x) => x.ruta.includes('checkout/sessions')).pop();
  p.params.get('payment_intent_data[on_behalf_of]') === 'acct_leontelecom'
    ? OK('el comercio ante el banco es León Telecom, no la plataforma') : MAL('falta on_behalf_of: los contracargos los pagarías tú');

  await stripeLeon.cobrarGuardado({ clienteId: 'cus_1', metodoPago: 'pm_x', monto: 440, telefono: TEL, periodo: '2027-06' });
  const a = estado.pedidos.filter((x) => x.ruta.includes('payment_intents')).pop();
  a.params.get('on_behalf_of') === 'acct_leontelecom'
    ? OK('y también en el cobro automático') : MAL('el cobro automático no lo lleva');
}

console.log('\n=== 8c. SI PIERDE SU CLABE, ES LA MISMA SIEMPRE ===');
{
  /*
   * El caso más común de todos: "se me perdió el número de cuenta". Vuelve a
   * pedirla y tiene que ser LA MISMA, aunque hayan pasado meses y aunque el
   * servidor se haya reiniciado veinte veces. Si cambiara, el cliente tendría
   * dos cuentas dadas de alta en su banco y depositaría en la que ya no se
   * consulta.
   */
  const tel = '5219517778888';
  const primera = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Olvidadizo' });
  const clientesAntes = estado.clientes.length;

  let iguales = true;
  for (let i = 0; i < 5; i++) {
    const otra = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Olvidadizo' });
    if (otra.clabe !== primera.clabe) iguales = false;
  }
  iguales ? OK('la pide 5 veces más y siempre es la misma') : MAL('cambió al volver a pedirla');
  estado.clientes.length === clientesAntes ? OK('sin crear clientes de más en Stripe') : MAL('creó clientes nuevos');

  // Y escrita de otra forma sigue siendo el mismo cliente.
  const conFormato = await stripeLeon.clabeDelCliente({ telefono: '+52 951 777 8888', nombre: 'Olvidadizo' });
  conFormato.clabe === primera.clabe ? OK('y con el teléfono escrito distinto, también') : MAL('otro formato dio otra CLABE');
}

console.log('\n=== 8d. MEZCLAR MÉTODOS NO CAMBIA SU CLABE ===');
{
  /*
   * Hoy paga en OXXO, mañana por depósito, pasado con tarjeta. La CLABE es
   * suya y no depende de cómo pagó la última vez.
   */
  const tel = '5219519990000';
  const antes = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Mezclador' });
  await stripeLeon.generarLinkPago({ telefono: tel, monto: 440, urlBase: 'https://x.mx' });
  await stripeLeon.generarLinkPago({ telefono: tel, monto: 440, urlBase: 'https://x.mx' });
  const despues = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: 'Mezclador' });
  despues.clabe === antes.clabe ? OK('generar links de pago no le mueve la CLABE') : MAL('la CLABE cambió');
  despues.clienteId === antes.clienteId ? OK('ni su cliente de Stripe') : MAL('cambió el cliente');
}

console.log('\n=== 8e. EL CARGO NO SE ABONA A LA FACTURA ===');
{
  /*
   * Stripe manda `amount_total` con los dos renglones sumados. Si el webhook
   * abonara eso a la factura, el cargo por servicio —que es nuestro— entraría
   * como si fuera pago del internet, y cada cobro marcaría "pagó de más".
   */
  await stripeLeon.generarLinkPago({ telefono: TEL, monto: 440, urlBase: 'https://x.mx' });
  const p = estado.pedidos.filter((x) => x.ruta.includes('checkout/sessions')).pop();
  p.params.get('metadata[mensualidad]') === '44000'
    ? OK('la mensualidad viaja aparte del cargo ($440)') : MAL('metadata: ' + p.params.get('metadata[mensualidad]'));
  const c = stripeLeon.calcularCargo(440);
  String(c.totalCentavos) !== p.params.get('metadata[mensualidad]')
    ? OK('y NO es el total con cargo incluido') : MAL('mandó el total');
}

console.log('\n=== 8f. BARRER EL SALDO DE LA CLABE HACIA LEÓN ===');
{
  /*
   * Comprobado contra Stripe de verdad el 6 sep 2026: una transferencia a la
   * CLABE NO le llega a León sola. Cae en el saldo del cliente dentro de Stripe
   * y ahí se queda hasta que se cobra, y ese cobro es el que la parte.
   *
   * Con un depósito de $470 sobre un plan de $440, la API real devolvió:
   * comisión de OBEX $30, comisión de Stripe $8.12, a León $440.
   */
  const r = await stripeLeon.cobrarDelSaldo({
    clienteId: 'cus_1', deposito: 470, deuda: 440, telefono: TEL, nombre: 'Piloto', referencia: 'ccbt_1',
  });
  r.ok ? OK('el saldo se cobra') : MAL('no se cobró: ' + JSON.stringify(r));
  r.aLeonTelecom === 440 ? OK('a León Telecom le llegan sus $440 íntegros') : MAL('le llegan ' + r.aLeonTelecom);
  r.comision === 30 ? OK('y la comisión de $30 se queda en la plataforma') : MAL('comisión ' + r.comision);

  const p = estado.pedidos.filter((x) => x.ruta.includes('payment_intents')).pop();
  p.params.get('transfer_data[destination]') === 'acct_leontelecom'
    ? OK('con el reparto apuntando a la cuenta de León') : MAL('destino: ' + p.params.get('transfer_data[destination]'));
  !p.params.get('on_behalf_of')
    ? OK('y SIN on_behalf_of, que este método no admite') : MAL('mandó on_behalf_of: Stripe lo rechazaría');

  // La comisión sale del excedente, nunca del dinero de León.
  const justo = await stripeLeon.cobrarDelSaldo({
    clienteId: 'cus_1', deposito: 440, deuda: 440, telefono: TEL, referencia: 'ccbt_2',
  });
  justo.comision === 0 ? OK('si depositó justo su plan, la comisión es CERO') : MAL('cobró ' + justo.comision);
  justo.aLeonTelecom === 440 ? OK('y León recibe los $440 completos') : MAL('recibió ' + justo.aLeonTelecom);
  justo.sinComision === true ? OK('quedando marcado que ese pago no dejó nada') : MAL('sin la marca');

  // A medias: solo alcanza para parte del cargo.
  const medias = await stripeLeon.cobrarDelSaldo({
    clienteId: 'cus_1', deposito: 450, deuda: 440, telefono: TEL, referencia: 'ccbt_3',
  });
  medias.comision === 10 ? OK('si depositó $10 de más, la comisión es esos $10') : MAL('cobró ' + medias.comision);
  medias.aLeonTelecom === 440 ? OK('sin tocar el dinero de León') : MAL('le llegaron ' + medias.aLeonTelecom);

  // Y el mismo aviso repetido no barre dos veces.
  const antes = estado.cobros.length;
  await stripeLeon.cobrarDelSaldo({
    clienteId: 'cus_1', deposito: 470, deuda: 440, telefono: TEL, referencia: 'ccbt_1',
  });
  estado.cobros.length === antes ? OK('el mismo depósito no se barre dos veces') : MAL('lo barrió otra vez');
}

console.log('\n=== 9. LA FIRMA DEL WEBHOOK ===');
{
  const crypto = await import('node:crypto');
  const cuerpo = JSON.stringify({ type: 'checkout.session.completed' });
  const secreto = 'whsec_prueba';
  const t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex');

  stripeLeon.verificarFirma(cuerpo, `t=${t},v1=${firma}`, secreto) === true ? OK('una firma buena pasa') : MAL('rechazó una firma buena');
  stripeLeon.verificarFirma(cuerpo, `t=${t},v1=${'0'.repeat(64)}`, secreto) === false ? OK('una inventada no') : MAL('¡pasó una firma falsa!');
  stripeLeon.verificarFirma(cuerpo, `t=${t},v1=${firma}`, 'otro_secreto') === false ? OK('ni con otro secreto') : MAL('pasó con secreto equivocado');

  const viejo = t - 3600;
  const firmaVieja = crypto.createHmac('sha256', secreto).update(`${viejo}.${cuerpo}`).digest('hex');
  stripeLeon.verificarFirma(cuerpo, `t=${viejo},v1=${firmaVieja}`, secreto) === false
    ? OK('una firma de hace una hora tampoco (no se puede repetir mañana)') : MAL('aceptó una firma vieja');

  stripeLeon.verificarFirma('', '', secreto) === false ? OK('sin cuerpo ni cabecera, no') : MAL('pasó vacío');
  stripeLeon.verificarFirma(cuerpo + ' ', `t=${t},v1=${firma}`, secreto) === false
    ? OK('y si el cuerpo cambió un solo espacio, tampoco') : MAL('¡el cuerpo alterado pasó!');
}

console.log(`\n═══ ${ok} bien / ${mal} mal ═══`);
stripeFalso.close();
process.exit(mal ? 1 : 0);
