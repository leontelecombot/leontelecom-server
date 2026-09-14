/**
 * EL WEBHOOK DE LEÓN TELECOM, contra el servidor de verdad.
 *
 * Las pruebas de `verificar-cobro-leon.mjs` cubren el módulo; estas cubren el
 * cableado dentro de index.js, que es donde vive lo que de verdad le escribe al
 * cliente. Un webhook que se cae en silencio deja a alguien que YA pagó sin su
 * confirmación, y eso solo se descubre cuando reclama.
 *
 * Levanta index.js de verdad, sin WhatsApp ni Wisphub, y le manda avisos
 * firmados igual que Stripe.
 *
 *   node verificar-webhook-leon.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PUERTO = 4398;
const BASE = `http://127.0.0.1:${PUERTO}`;
const SECRETO = 'whsec_prueba_local';

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };

const srv = spawn('node', ['index.js'], {
  env: {
    ...process.env,
    PORT: String(PUERTO),
    MONGODB_URI: '', DATABASE_URL: '',
    COBRO_LINEA_ACTIVO: 'true',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET_LEON: SECRETO,
    LEON_STRIPE_CUENTA_CONECTADA: 'acct_leon',
    WHATSAPP_TOKEN: '', WISPHUB_API_KEY: '',
    ADMIN_PASSWORD: 'prueba-local-larga',
    // Hace falta para que `alertAdmin` llegue a intentar el envío: sin número
    // de admin sale temprano y la prueba no podría ver que se avisó a nadie.
    ALERT_ADMIN_NUMBER: '529990001122',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
srv.stdout.on('data', (d) => log.push(String(d)));
srv.stderr.on('data', (d) => log.push(String(d)));
const salir = (c) => { srv.kill('SIGKILL'); process.exit(c); };

let vivo = false;
for (let i = 0; i < 60 && !vivo; i++) {
  try { await fetch(BASE + '/'); vivo = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!vivo) { console.error(log.join('')); salir(1); }

/** Manda un aviso firmado igual que lo haría Stripe. */
const avisar = async (evento, secreto = SECRETO) => {
  const cuerpo = JSON.stringify(evento);
  const t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex');
  const r = await fetch(BASE + '/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${firma}` },
    body: cuerpo,
  });
  return { st: r.status, d: await r.json().catch(() => null) };
};
const registro = () => log.join('');
const esperar = () => new Promise((r) => setTimeout(r, 350));

console.log('\n=== 1. NADIE ENTRA SIN FIRMA BUENA ===');
{
  const r = await fetch(BASE + '/webhook/stripe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed' }),
  });
  r.status === 400 ? OK('sin firma, 400') : MAL('dio ' + r.status);

  const mala = await avisar({ type: 'checkout.session.completed' }, 'whsec_otro');
  mala.st === 400 ? OK('con secreto equivocado, 400') : MAL('dio ' + mala.st);

  // Es LA puerta del dinero: un "ya pagó" falso abonaría un mes que nadie pagó.
  const falso = await fetch(BASE + '/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=' + '0'.repeat(64) },
    body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', metadata: { tipo: 'mensualidad-leontelecom', telefono: '521999' } } } }),
  });
  falso.status === 400 ? OK('un "ya pagó" inventado se rechaza') : MAL('¡pasó un pago falso! ' + falso.status);
}

console.log('\n=== 2. UN DEPÓSITO A LA CLABE SE AVISA ===');
{
  const antes = registro().length;
  const r = await avisar({
    type: 'customer_cash_balance_transaction.created',
    data: { object: { id: 'ccbt_1', type: 'funded', customer: 'cus_desconocido', net_amount: 44000 } },
  });
  await esperar();
  r.st === 200 ? OK('el aviso se acepta') : MAL('dio ' + r.st);
  const nuevo = registro().slice(antes);
  /cliente desconocido/.test(nuevo)
    ? OK('un depósito de alguien fuera del registro NO se pierde en silencio') : MAL('no avisó del desconocido');
  /*
   * El texto de `alertAdmin` sale por WhatsApp, no por consola. Sin
   * credenciales el envío falla y deja su huella: eso es la prueba de que se
   * intentó avisarle a un humano. Si algún día no apareciera, querría decir que
   * el dinero de un desconocido entra y nadie se entera nunca.
   */
  /Missing credentials|WhatsApp/i.test(nuevo)
    ? OK('y se le avisa a un humano para que lo revise') : MAL('nadie se entera');
}

console.log('\n=== 3. UN DEPÓSITO REPETIDO NO SE CUENTA DOS VECES ===');
{
  // Stripe reintenta el MISMO aviso si tardamos en contestar. Sin candado, el
  // cliente recibiría dos "ya quedó" por un solo depósito.
  const r = await avisar({
    type: 'customer_cash_balance_transaction.created',
    data: { object: { id: 'ccbt_1', type: 'funded', customer: 'cus_desconocido', net_amount: 44000 } },
  });
  await esperar();
  r.d && r.d.repetido === true ? OK('el segundo aviso del mismo depósito se ignora') : MAL('lo procesó otra vez: ' + JSON.stringify(r.d));
}

console.log('\n=== 4. LOS AVISOS QUE NO SON PARA NOSOTROS ===');
{
  const otra = await avisar({ account: 'acct_de_otro', type: 'checkout.session.completed', data: { object: {} } });
  otra.d && otra.d.ignorado === 'cuenta-conectada' ? OK('un aviso de otra cuenta conectada se ignora') : MAL(JSON.stringify(otra.d));

  const ajeno = await avisar({ type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  ajeno.st === 200 ? OK('un evento que no nos toca contesta 200 sin hacer nada') : MAL('dio ' + ajeno.st);

  // Un checkout que NO es de León Telecom (ej. de Aforo) no debe tocarse.
  const deAforo = await avisar({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_aforo', payment_status: 'paid', metadata: { tipo: 'boletos-aforo', ordenId: 'x' } } },
  });
  await esperar();
  deAforo.st === 200 && !/pago confirmado/.test(registro().slice(-600))
    ? OK('un pago de Aforo no se confunde con una mensualidad') : MAL('procesó un pago ajeno');
}

console.log('\n=== 5. UN PAGO SIN TELÉFONO NO SE PIERDE ===');
{
  const antes = registro().length;
  await avisar({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_sin_tel', payment_status: 'paid', metadata: { tipo: 'mensualidad-leontelecom' } } },
  });
  await esperar();
  /pago sin teléfono/.test(registro().slice(antes))
    ? OK('un pago sin teléfono se reporta en vez de desaparecer') : MAL('se perdió en silencio');
}

console.log('\n=== 6. EL CUERPO CRUDO LLEGA INTACTO ===');
{
  /*
   * La firma se calcula sobre los BYTES exactos. Si Express reserializara el
   * JSON, el orden de las llaves cambiaría el hash y NINGUNA firma coincidiría.
   * Es el error clásico de esta integración, y solo se ve con un cuerpo cuyo
   * orden de llaves no sea el "natural".
   */
  const cuerpo = '{"data":{"object":{"id":"ccbt_orden","type":"funded","customer":"cus_z","net_amount":100}},"type":"customer_cash_balance_transaction.created"}';
  const t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', SECRETO).update(`${t}.${cuerpo}`).digest('hex');
  const r = await fetch(BASE + '/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${firma}` },
    body: cuerpo,
  });
  r.status === 200 ? OK('un cuerpo con las llaves en otro orden valida igual') : MAL('dio ' + r.status + ': el cuerpo crudo se está perdiendo');
}

console.log('\n=== 6b. OXXO: LA FICHA Y EL PAGO SON DOS AVISOS DISTINTOS ===');
{
  /*
   * OXXO no llega como un checkout pagado. Llega la ficha primero y el pago
   * días después, como `async_payment_succeeded`. Sin escuchar ese segundo
   * aviso, quien paga en la tienda nunca recibe confirmación y sigue cortado
   * con su ticket en la mano.
   */
  const meta = { tipo: 'mensualidad-leontelecom', telefono: '529990001111' };
  const ficha = await avisar({ type: 'checkout.session.completed',
    data: { object: { id: 'cs_oxxo_1', payment_status: 'unpaid', metadata: meta } } });
  await esperar();
  ficha.d && ficha.d.ficha === true ? OK('la ficha generada se reconoce (no se toma como pago)') : MAL(JSON.stringify(ficha.d));

  const pagado = await avisar({ type: 'checkout.session.async_payment_succeeded',
    data: { object: { id: 'cs_oxxo_1', payment_intent: 'pi_oxxo_1', amount_total: 47000, metadata: meta } } });
  await esperar();
  pagado.st === 200 ? OK('el pago en la tienda sí se procesa') : MAL('dio ' + pagado.st);
  /pago confirmado/.test(registro().slice(-1200)) ? OK('y queda registrado como pago confirmado') : MAL('no lo procesó');

  const vencida = await avisar({ type: 'checkout.session.async_payment_failed',
    data: { object: { id: 'cs_oxxo_2', metadata: meta } } });
  await esperar();
  vencida.d && vencida.d.fichaVencida === true ? OK('una ficha vencida también se avisa') : MAL(JSON.stringify(vencida.d));
}

console.log('\n=== 6c. PAGO DOBLE ENTRE CANALES ===');
{
  /*
   * El cliente saca ficha de OXXO, se impacienta y transfiere a su CLABE.
   * Los dos pagos entran de verdad. No se bloquea (hay razones legítimas para
   * pagar dos veces), pero alguien tiene que enterarse el mismo día.
   */
  const tel = '529990002222';
  const antes = registro().length;
  await avisar({ type: 'checkout.session.completed',
    data: { object: { id: 'cs_d1', payment_status: 'paid', payment_intent: 'pi_d1', amount_total: 47000,
      metadata: { tipo: 'mensualidad-leontelecom', telefono: tel } } } });
  await esperar();
  !/POSIBLE PAGO DOBLE/.test(registro().slice(antes)) ? OK('un primer pago no dispara la alarma') : MAL('avisó con uno solo');

  const marca = registro().length;
  await avisar({ type: 'checkout.session.completed',
    data: { object: { id: 'cs_d2', payment_status: 'paid', payment_intent: 'pi_d2', amount_total: 47000,
      metadata: { tipo: 'mensualidad-leontelecom', telefono: tel } } } });
  await esperar();
  /Missing credentials|WhatsApp/i.test(registro().slice(marca))
    ? OK('un segundo pago del mismo cliente sí avisa a un humano') : MAL('nadie se enteró del pago doble');

  // El MISMO aviso repetido de Stripe no es un pago doble: lo para el candado.
  const marca2 = registro().length;
  const rep = await avisar({ type: 'checkout.session.completed',
    data: { object: { id: 'cs_d2', payment_status: 'paid', payment_intent: 'pi_d2', amount_total: 47000,
      metadata: { tipo: 'mensualidad-leontelecom', telefono: tel } } } });
  rep.d && rep.d.repetido === true ? OK('y un reintento de Stripe NO cuenta como pago doble') : MAL('lo contó como doble');
}

console.log('\n=== 6d. LA LISTA DE FACTURAS POR MARCAR ===');
{
  /*
   * La API de Wisphub no deja marcar una factura como pagada, así que alguien
   * tiene que hacerlo. Si esa lista se pierde, el cliente que YA pagó sigue
   * apareciendo con deuda, le llegan avisos de corte y lo vuelven a suspender.
   * Por eso se junta y se entrega en el resumen matutino.
   */
  const fuente = await import('node:fs').then((fs) => fs.readFileSync('index.js', 'utf8'));

  /anotarRegistroPendiente\(\{ tipo: 'factura'/.test(fuente)
    ? OK('un pago que no se pudo registrar entra a la lista') : MAL('no se anota la factura');
  /anotarRegistroPendiente\(\{ tipo: 'afavor'/.test(fuente)
    ? OK('y el saldo a favor del que pagó adelantado, también') : MAL('no se anota el saldo a favor');

  // Sin depuración, la lista repetiría lo ya hecho y nadie la leería.
  /async function depurarRegistrosPendientes/.test(fuente)
    ? OK('antes de pedirlo se comprueba qué ya se marcó en Wisphub') : MAL('no depura contra Wisphub');
  /if \(!res\.ok\) \{ vivos\.push\(r\); continue; \}/.test(fuente)
    ? OK('y si Wisphub no contesta, NO se borra nada de la lista') : MAL('podría perder pagos si Wisphub falla');

  // El resumen tiene que salir aunque no haya casos de clientes.
  /if \(!pend\.length && !registros\.length\) return;/.test(fuente)
    ? OK('el resumen sale aunque solo haya pagos por registrar') : MAL('se calla si no hay casos');

  /siguen apareciendo con deuda y les pueden volver a cortar/.test(fuente)
    ? OK('y el mensaje explica por qué urge marcarlas') : MAL('no dice por qué importa');

  // Sin duplicados: el mismo pago llega por dos avisos de Stripe.
  /if \(stripeRegistrosPendientes\.some/.test(fuente)
    ? OK('el mismo pago no se anota dos veces') : MAL('se puede duplicar en la lista');
  /stripeRegistrosPendientes: stripeRegistrosPendientes\.slice/.test(fuente)
    ? OK('y la lista sobrevive a un reinicio de Render') : MAL('no se persiste');
}

console.log('\n=== 6e. LA CLABE SOLO PARA CLIENTES DE VERDAD ===');
{
  /*
   * Con la lista abierta a todos (`COBRO_LINEA_TELEFONOS=*`), antes bastaba
   * escribirle "pagar" al bot para obtener una cuenta bancaria permanente.
   * Cualquiera podía transferirle dinero a León Telecom que no se puede aplicar
   * a ningún servicio: entra, no tiene dueño, y alguien lo devuelve a mano.
   */
  const fuente = await import('node:fs').then((fs) => fs.readFileSync('index.js', 'utf8'));
  const bloque = (fuente.match(/_pt === 'pago_clabe'[\s\S]{0,6000}?\n    \}/) || [])[0] || '';
  bloque ? OK('se encuentra el manejador de la CLABE') : MAL('no se encontró');

  /if \(!c \|\| !c\.name\)/.test(bloque)
    ? OK('exige que el teléfono sea de un cliente de Wisphub') : MAL('le da CLABE a cualquiera');
  /!wisphubClients\.size/.test(bloque)
    ? OK('y si la lista está vacía (Wisphub caído) tampoco entrega nada') : MAL('entregaría con la lista vacía');

  // El nombre del beneficiario no se puede inventar.
  !/A nombre de:\* León Telecom/.test(bloque)
    ? OK('ya NO afirma que la cuenta va a nombre de León Telecom') : MAL('sigue afirmando un nombre sin confirmar');
  /datos\.beneficiario/.test(bloque)
    ? OK('enseña el beneficiario REAL que devuelve Stripe, si lo devuelve') : MAL('no usa el beneficiario real');
  /ventanilla/.test(bloque)
    ? OK('y le dice qué hacer si en ventanilla le preguntan a nombre de quién') : MAL('sin guía para la ventanilla');

  /*
   * ── LO QUE CUESTA DINERO SI FALTA ────────────────────────────────────────
   *
   * La comisión sale del EXCEDENTE sobre lo que el cliente debía. Si el mensaje
   * le dice "transfiere el monto de tu plan", va a transferir justo eso, el
   * excedente será cero y no se cobrará nada. Y recibir esa transferencia le
   * cuesta $8.12 a la plataforma (comprobado contra la API de Stripe), así que
   * cada uno de esos pagos deja a OBEX en rojo. Con el padrón entero son más de
   * once mil pesos al mes, perdidos en silencio.
   *
   * Por eso el mensaje TIENE que traer el monto con el cargo ya sumado.
   */
  /deudaDelCliente/.test(bloque)
    ? OK('el monto sale de sus facturas pendientes, no de un supuesto') : MAL('no consulta la deuda real');
  /calcularCargo/.test(bloque)
    ? OK('y le suma el cargo por pagar en línea') : MAL('¡no suma el cargo! cada pago costaría $8.12 sin cobrar nada');
  /Transfiere: \*?\$/.test(bloque)
    ? OK('le dice el TOTAL exacto que tiene que transferir') : MAL('no le dice cuánto transferir');
  /precioPlan/.test(bloque)
    ? OK('y si Wisphub no contesta, cae al precio de su plan') : MAL('sin respaldo si Wisphub no contesta');
  !/transfiere ahí el monto de tu plan/.test(bloque)
    ? OK('ya NO le dice que transfiera solo su plan (era la fuga)') : MAL('sigue pidiendo solo el plan, sin el cargo');
}

console.log('\n=== 7. EL MENÚ DE PAGO CABE EN WHATSAPP ===');
{
  /*
   * WhatsApp muestra TRES botones y corta el resto sin avisar. Esta prueba
   * existe porque al agregar la CLABE quedaron cuatro por un rato: el cuarto no
   * habría aparecido nunca y el fallo habría sido invisible desde el código.
   */
  const fuente = await import('node:fs').then((fs) => fs.readFileSync('index.js', 'utf8'));
  const bloque = (fuente.match(/const botonesPago = [\s\S]{0,900}?\];/) || [])[0] || '';
  bloque ? OK('se encuentra el armado del menú') : MAL('no se encontró botonesPago');

  const conCobro = (bloque.match(/id: 'pago_(clabe|tarjeta|otras)'/g) || []).length;
  conCobro === 3 ? OK('con cobro en línea son exactamente 3 botones') : MAL('son ' + conCobro);

  const sinCobro = (bloque.match(/id: 'pago_(horario|datos)'/g) || []).length;
  sinCobro === 2 ? OK('sin cobro en línea, los 2 de siempre (nada cambia para los 1,090)') : MAL('son ' + sinCobro);

  // Los títulos se cortan a 20 caracteres: uno más largo sale mutilado.
  const titulos = [...bloque.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
  const largos = titulos.filter((t) => [...t].length > 20);
  !largos.length ? OK('ningún título pasa de 20 caracteres') : MAL('se cortarían: ' + largos.join(', '));

  // Y cada botón necesita su manejador, o el cliente le pica y no pasa nada.
  const ids = [...bloque.matchAll(/id: '(pago_[a-z]+)'/g)].map((m) => m[1]);
  const huerfanos = [...new Set(ids)].filter((id) => !fuente.includes(`_pt === '${id}'`));
  !huerfanos.length ? OK('todos los botones tienen quien los atienda') : MAL('sin manejador: ' + huerfanos.join(', '));
}

console.log('\n=== 8. TARJETA Y OXXO SE COTIZAN POR SEPARADO ===');
{
  /*
   * Cada forma tiene su tarifa (propuesta AFO-LT-003), así que ya no se puede
   * entregar un link donde el cliente elija adentro de Stripe: le cotizaríamos
   * una y podría pagar por la otra. Se le pregunta antes, en WhatsApp.
   */
  const fuente = await import('node:fs').then((fs) => fs.readFileSync('index.js', 'utf8'));

  const cotiza = (fuente.match(/_pt === 'pago_tarjeta'[\s\S]{0,3000}?\n    \}/) || [])[0] || '';
  cotiza ? OK('se encuentra el paso que cotiza las dos formas') : MAL('no se encontró');

  /calcularCargo\(cobro\.monto, 'tarjeta'\)/.test(cotiza) && /calcularCargo\(cobro\.monto, 'oxxo'\)/.test(cotiza)
    ? OK('le enseña los DOS precios antes de que elija') : MAL('no cotiza las dos formas');
  /pago_con_tarjeta/.test(cotiza) && /pago_con_oxxo/.test(cotiza)
    ? OK('con un botón para cada una') : MAL('faltan los botones');
  !/generarLinkPago/.test(cotiza)
    ? OK('y todavía NO genera ningún link: primero elige') : MAL('generó el link antes de preguntar');

  const genera = (fuente.match(/_pt === 'pago_con_tarjeta' \|\| _pt === 'pago_con_oxxo'[\s\S]{0,5200}?\n    \}/) || [])[0] || '';
  genera ? OK('se encuentra el paso que genera el link') : MAL('no se encontró');
  /forma = _pt === 'pago_con_oxxo' \? 'oxxo' : 'tarjeta'/.test(genera)
    ? OK('el link sale amarrado a lo que el cliente escogió') : MAL('no amarra la forma');
  /generarLinkPago\(\{[\s\S]{0,200}?forma,/.test(genera)
    ? OK('y esa forma es la que se le manda a Stripe') : MAL('no le pasa la forma a Stripe');

  // Los dos botones nuevos también necesitan manejador.
  const huerfanos = ['pago_con_tarjeta', 'pago_con_oxxo']
    .filter((id) => !fuente.includes(`_pt === '${id}'`));
  !huerfanos.length ? OK('los dos botones nuevos tienen quien los atienda')
                    : MAL('sin manejador: ' + huerfanos.join(', '));

  // Y ningún camino puede pedir un link sin decir con qué tarifa.
  const sinForma = [...fuente.matchAll(/generarLinkPago\(\{([\s\S]{0,300}?)\}\)/g)]
    .filter((m) => !/forma/.test(m[1]));
  !sinForma.length ? OK('ninguna llamada pide un link sin tarifa')
                   : MAL(sinForma.length + ' llamada(s) sin forma');

  // La tarifa de la CLABE también tiene que ser la suya, no la de tarjeta.
  const clabe = (fuente.match(/_pt === 'pago_clabe'[\s\S]{0,6000}?\n    \}/) || [])[0] || '';
  /calcularCargo\(deuda, 'clabe'\)/.test(clabe)
    ? OK('y el mensaje de la CLABE cobra la tarifa de transferencia') : MAL('la CLABE no usa su tarifa');
}

console.log(`\n═══ ${ok} bien / ${mal} mal ═══`);
if (mal) console.log('\n--- registro ---\n' + registro().slice(-2000));
salir(mal ? 1 : 0);
