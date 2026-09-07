/**
 * EL DINERO QUE SE ATORA, Y EL QUE SE DA LA VUELTA.
 *
 * Dos huecos que el resto de las pruebas no tocaba:
 *
 *  1. Una transferencia a la CLABE cae en el saldo del cliente DENTRO de Stripe
 *     y no le llega a León Telecom hasta que alguien la cobra. Si ese cobro
 *     falla —o si el aviso de Stripe nunca llega— el dinero se queda parado sin
 *     que nadie lo sepa: el cliente ya está reconectado y ya se le dio las
 *     gracias. Aquí se comprueba que el sistema va a buscarlo solo.
 *
 *  2. Un contracargo o una devolución deshacen un pago que ya dimos por bueno.
 *     Antes eso no se escuchaba: el dinero se iba y la factura seguía marcada
 *     como pagada. Aquí se comprueba que ahora sí se avisa.
 *
 * Levanta index.js de verdad contra un Stripe falso, y le siembra estado como
 * si viniera de un reinicio de Render.
 *
 *   node verificar-rescate-leon.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PUERTO = 4396;
const PUERTO_STRIPE = 4397;
const BASE = `http://127.0.0.1:${PUERTO}`;
const SECRETO = 'whsec_prueba_rescate';
const CLAVE_ADMIN = 'prueba-local-larga';

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };
const es = (cond, m) => (cond ? OK(m) : MAL(m));

// ── Un Stripe falso con saldos de clientes ─────────────────────────────────
const banco = {
  saldos: new Map(),       // clienteId -> centavos disponibles
  cobros: [],              // los payment_intents que se intentaron
  falla: null,             // si trae texto, todo cobro se rechaza con ese motivo
  idempotencia: new Map(),
  movimientos: new Map(),  // clienteId -> id del último depósito recibido
  duenio: new Map(),       // clienteId -> teléfono, como lo guarda Stripe en metadata
  nMovimiento: 0,
};
// Un depósito nuevo: sube el saldo y estrena id de movimiento, igual que Stripe.
const depositar = (cliente, centavos) => {
  banco.saldos.set(cliente, (banco.saldos.get(cliente) || 0) + centavos);
  banco.movimientos.set(cliente, 'ccbtxn_' + (++banco.nMovimiento));
};

const stripeFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const params = new URLSearchParams(cuerpo);
    const llaveIdem = req.headers['idempotency-key'] || '';
    res.setHeader('content-type', 'application/json');
    const responder = (obj, codigo = 200) => { res.statusCode = codigo; res.end(JSON.stringify(obj)); };

    if (llaveIdem && banco.idempotencia.has(llaveIdem)) {
      return responder(banco.idempotencia.get(llaveIdem));
    }

    const mMov = req.url.match(/^\/v1\/customers\/([^/?]+)\/cash_balance_transactions/);
    if (mMov) {
      const id = banco.movimientos.get(mMov[1]);
      return responder({ data: id ? [{ id, type: 'funded' }] : [] });
    }
    const mCash = req.url.match(/^\/v1\/customers\/([^/?]+)\/cash_balance/);
    if (mCash) {
      return responder({ object: 'cash_balance', available: { mxn: banco.saldos.get(mCash[1]) || 0 } });
    }
    const mCli = req.url.match(/^\/v1\/customers\/([^/?]+)$/);
    if (mCli) {
      return responder({ id: mCli[1], metadata: { telefono: banco.duenio.get(mCli[1]) || '' } });
    }

    if (req.url.startsWith('/v1/payment_intents')) {
      const cliente = params.get('customer');
      const monto = Number(params.get('amount')) || 0;
      banco.cobros.push({
        cliente, monto, llaveIdem,
        destino: params.get('transfer_data[destination]'),
        comision: Number(params.get('application_fee_amount')) || 0,
      });
      if (banco.falla) {
        return responder({ error: { message: banco.falla, type: 'api_error' } }, 402);
      }
      // Cobrar de verdad vacía el saldo, igual que en Stripe.
      banco.saldos.set(cliente, Math.max(0, (banco.saldos.get(cliente) || 0) - monto));
      const pi = { id: 'pi_' + banco.cobros.length, status: 'succeeded', amount: monto };
      if (llaveIdem) banco.idempotencia.set(llaveIdem, pi);
      return responder(pi);
    }

    responder({ error: { message: 'ruta falsa no implementada: ' + req.url } }, 404);
  });
});
await new Promise((r) => stripeFalso.listen(PUERTO_STRIPE, '127.0.0.1', r));

// ── Un Wisphub falso, para que la deuda se pueda saber (o no) ───────────────
const wisphub = {
  deuda: new Map(),   // usuario -> pesos pendientes
  caido: false,
  clientes: [],       // lo que devuelve la sincronización
};
const wisphubFalso = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (wisphub.caido) { res.statusCode = 502; return res.end('{"detail":"Wisphub caido"}'); }
  if (req.url.startsWith('/api/facturas/')) {
    const usuario = decodeURIComponent((req.url.match(/cliente=([^&]*)/) || [])[1] || '');
    const total = wisphub.deuda.get(usuario) || 0;
    const results = total > 0
      ? [{ id_factura: 9001, total: total.toFixed(2), estado: 'Pendiente', fecha_vencimiento: '2026-09-01' }]
      : [];
    return res.end(JSON.stringify({ results }));
  }
  if (req.url.startsWith('/api/clientes/')) {
    return res.end(JSON.stringify({ count: wisphub.clientes.length, results: wisphub.clientes }));
  }
  res.end(JSON.stringify({ results: [] }));
});
await new Promise((r) => wisphubFalso.listen(4395, '127.0.0.1', r));

// ── Estado sembrado, como si Render acabara de reiniciar ───────────────────
const TEL_A = '5219511111111';
const TEL_B = '5219512222222';
const EVENTO_YA_VISTO = 'cs_test_ya_procesado';

const RUTA_STORE = path.join(process.cwd(), 'data', 'store.json');
const respaldo = fs.existsSync(RUTA_STORE) ? fs.readFileSync(RUTA_STORE) : null;
fs.mkdirSync(path.dirname(RUTA_STORE), { recursive: true });
fs.writeFileSync(RUTA_STORE, JSON.stringify({
  stripeClientes: {
    [TEL_A]: { clienteId: 'cus_A', clabe: '646180100000000001' },
    [TEL_B]: { clienteId: 'cus_B', clabe: '646180100000000002' },
  },
  // Un aviso que YA se procesó antes del reinicio. Si esto no sobrevive,
  // el reintento de Stripe vuelve a cobrar y a escribirle al cliente.
  stripeVistos: { [EVENTO_YA_VISTO]: Date.now() },
  // La lista de clientes, como la deja la sincronización con Wisphub.
  wisphubClientes: {
    [TEL_A]: { usuario: 'clienteA', name: 'Ana Pérez', precioPlan: '440.00' },
    [TEL_B]: { usuario: 'clienteB', name: 'Beto Ruiz', precioPlan: '300.00' },
  },
  wisphubClientesAl: new Date().toISOString(),
}));

const srv = spawn('node', ['index.js'], {
  env: {
    ...process.env,
    PORT: String(PUERTO),
    MONGODB_URI: '', DATABASE_URL: '',
    COBRO_LINEA_ACTIVO: 'true',
    STRIPE_API_BASE: `http://127.0.0.1:${PUERTO_STRIPE}/v1/`,
    STRIPE_SECRET_KEY: 'sk_test_falsa',
    STRIPE_WEBHOOK_SECRET_LEON: SECRETO,
    LEON_STRIPE_CUENTA_CONECTADA: 'acct_leon',
    WHATSAPP_TOKEN: '',
    WISPHUB_API_KEY: 'llave_falsa',
    WISPHUB_API_URL: 'http://127.0.0.1:4395',
    ADMIN_PASSWORD: CLAVE_ADMIN,
    ALERT_ADMIN_NUMBER: '529990001122',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
srv.stdout.on('data', (d) => log.push(String(d)));
srv.stderr.on('data', (d) => log.push(String(d)));
const salir = (c) => {
  srv.kill('SIGKILL');
  stripeFalso.close();
  wisphubFalso.close();
  if (respaldo) fs.writeFileSync(RUTA_STORE, respaldo);
  else fs.rmSync(RUTA_STORE, { force: true });
  process.exit(c);
};

let vivo = false;
for (let i = 0; i < 60 && !vivo; i++) {
  try { await fetch(BASE + '/'); vivo = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!vivo) { console.error(log.join('')); salir(1); }

const avisar = async (evento) => {
  const cuerpo = JSON.stringify(evento);
  const t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', SECRETO).update(`${t}.${cuerpo}`, 'utf8').digest('hex');
  const r = await fetch(BASE + '/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${firma}` },
    body: cuerpo,
  });
  return { codigo: r.status, cuerpo: await r.json().catch(() => ({})) };
};

// Sesión de administrador para las rutas del panel.
const sesion = await (await fetch(BASE + '/admin/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: CLAVE_ADMIN }),
})).json();
const admin = (ruta, metodo = 'GET') => fetch(BASE + ruta, {
  method: metodo, headers: { authorization: 'Bearer ' + sesion.token },
}).then((r) => r.json());

const esperarLog = async (texto, ms = 3000) => {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (log.join('').includes(texto)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

console.log('\n=== 1. EL CANDADO ANTI-REPETIDO SOBREVIVE AL REINICIO ===');
es(!!sesion.token, 'la sesión de administrador abre');
{
  // Stripe reintenta hasta tres días. Render reinicia en cada despliegue. Si el
  // candado viviera solo en memoria, este aviso se procesaría por segunda vez.
  const r = await avisar({
    type: 'checkout.session.completed',
    data: { object: {
      id: EVENTO_YA_VISTO, payment_status: 'paid', amount_total: 47000,
      metadata: { tipo: 'mensualidad-leontelecom', telefono: TEL_A, mensualidad: '44000' },
    } },
  });
  es(r.codigo === 200, 'el aviso se acepta');
  es(r.cuerpo.repetido === true, 'y se reconoce como YA procesado antes del reinicio');
}
{
  const nuevo = 'cs_test_nuevo_' + Date.now();
  const evento = {
    type: 'checkout.session.completed',
    data: { object: {
      id: nuevo, payment_status: 'paid', amount_total: 47000, payment_intent: 'pi_tarjeta_1',
      metadata: { tipo: 'mensualidad-leontelecom', telefono: TEL_A, mensualidad: '44000' },
    } },
  };
  const a = await avisar(evento);
  const b = await avisar(evento);
  es(!a.cuerpo.repetido, 'un aviso nuevo sí se procesa');
  es(b.cuerpo.repetido === true, 'y el reintento del mismo, no');
}

console.log('\n=== 2. IR POR EL DINERO ATORADO, REPARTIÉNDOLO BIEN ===');
{
  // Debe $440 y depositó $470: los $30 de más son el cargo por pagar en línea.
  wisphub.deuda.set('clienteA', 440);
  depositar('cus_A', 47000);
  const r = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(r.rescatados === 1, 'la auditoría encuentra el depósito y lo rescata');
  const c = banco.cobros.find((x) => x.cliente === 'cus_A');
  es(!!c && c.monto === 47000, 'se cobra el saldo completo ($470)');
  es(!!c && c.destino === 'acct_leon', 'y se manda a la cuenta de León Telecom');
  es(!!c && c.comision === 3000, 'la comisión es SOLO el excedente ($30)');
  es((banco.saldos.get('cus_A') || 0) === 0, 'el saldo del cliente queda en cero');
  es(await esperarLog('nunca reportó'), 'y se avisa que ese depósito Stripe nunca lo reportó');
}
{
  const antes = banco.cobros.length;
  const r = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(r.rescatados === 0, 'la segunda pasada no rescata nada (ya no hay saldo)');
  es(banco.cobros.length === antes, 'y NO se intenta un segundo cobro: nadie paga dos veces');
}
{
  /*
   * Dos depósitos iguales el mismo día son DOS pagos. Si la llave anti-repetido
   * se armara con el monto y la fecha, el segundo se quedaría atorado para
   * siempre creyendo que ya se había cobrado.
   */
  wisphub.deuda.set('clienteA', 440);
  depositar('cus_A', 47000);
  const r = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(r.rescatados === 1, 'un segundo depósito idéntico el mismo día TAMBIÉN se cobra');
  es((banco.saldos.get('cus_A') || 0) === 0, 'sin quedarse atorado por la llave anti-repetido');
}

console.log('\n=== 3. SI NO SE SABE LA DEUDA, NO SE REPARTE MAL ===');
{
  // Con Wisphub caído no se puede saber cuánto de ese depósito es mensualidad y
  // cuánto excedente. Cobrar comisión aquí sería quitárselo a León Telecom.
  wisphub.caido = true;
  depositar('cus_B', 32300);   // debe $300 y deposita $323 ($300 + $23 de cargo)
  const antes = banco.cobros.length;
  const r = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(r.rescatados === 0 && r.fallidos === 1, 'el barrido se pospone, no se hace a medias');
  es(banco.cobros.length === antes, 'no se cobra nada mientras no se sepa la deuda');
  const lista = await admin('/admin/api/stripe/rezagados');
  const b = lista.rezagados.find((x) => x.telefono === TEL_B);
  es(!!b && /sin deuda/.test(b.error), 'y queda anotado diciendo por qué se pospuso');
  es((banco.saldos.get('cus_B') || 0) === 32300, 'el dinero sigue intacto en Stripe, sin riesgo');
}
{
  // Wisphub vuelve antes de agotarse la espera: se reparte como debe.
  wisphub.caido = false;
  wisphub.deuda.set('clienteB', 300);
  const r = await admin('/admin/api/stripe/barrer', 'POST');
  es(r.rescatados === 1, 'en cuanto Wisphub contesta, el dinero se rescata');
  const c = banco.cobros.find((x) => x.cliente === 'cus_B');
  // El cargo de un plan de $300 es $23 ($8 fijo + 5%), no el de $440.
  es(!!c && c.comision === 2300, 'con la comisión de SU plan ($23), no una fija');
  es(!!c && c.monto - c.comision === 30000, 'y a León Telecom le llegan sus $300 exactos');
  const lista = await admin('/admin/api/stripe/rezagados');
  es(lista.total === 0, 'y sale de la lista de pendientes');
}
{
  /*
   * Y si Wisphub NUNCA vuelve, el dinero no se puede quedar esperando: a los
   * cuatro intentos se manda completo a León, renunciando a la comisión.
   */
  wisphub.caido = true;
  depositar('cus_B', 33000);
  let ultimo = null;
  for (let i = 0; i < 5; i++) ultimo = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(ultimo.rescatados === 1, 'tras varios intentos sin Wisphub, el dinero se manda igual');
  const c = banco.cobros.filter((x) => x.cliente === 'cus_B').pop();
  es(!!c && c.monto === 33000 && c.comision === 0,
    'COMPLETO a León Telecom y sin comisión: el error caro sería cobrarle de más');
  es(await esperarLog('se barre SIN comisión'), 'y queda avisado que ese cargo se perdió');
  wisphub.caido = false;
}

console.log('\n=== 4. SI STRIPE FALLA, SE REINTENTA SOLO ===');
{
  wisphub.deuda.set('clienteA', 440);
  depositar('cus_A', 47000);
  banco.falla = 'Stripe no está disponible';
  const r = await admin('/admin/api/stripe/barrer?auditar=1', 'POST');
  es(r.fallidos >= 1, 'el fallo se cuenta, no se traga');
  const lista = await admin('/admin/api/stripe/rezagados');
  const a = lista.rezagados.find((x) => x.telefono === TEL_A);
  es(!!a && /no está disponible/.test(a.error), 'y guarda por qué falló');
  es(!!a && !a.agotado, 'todavía se va a reintentar solo');
}
{
  banco.falla = null;
  const r = await admin('/admin/api/stripe/barrer', 'POST');
  es(r.rescatados === 1, 'en cuanto Stripe vuelve, el dinero se rescata solo');
  es((banco.saldos.get('cus_A') || 0) === 0, 'sin dejar saldo atrás');
  const lista = await admin('/admin/api/stripe/rezagados');
  es(lista.total === 0, 'y la lista queda limpia');
}

console.log('\n=== 4b. UN DEPÓSITO DE UN CLIENTE QUE EL REGISTRO PERDIÓ ===');
{
  /*
   * El registro local dice qué Customer es cada teléfono. Si se perdiera, el
   * dinero llegaría de alguien "desconocido". No hace falta rendirse: Stripe
   * guarda el teléfono en el metadata del cliente.
   */
  banco.duenio.set('cus_C', TEL_A);
  const r = await avisar({
    type: 'customer_cash_balance_transaction.created',
    data: { object: { id: 'ccbtxn_perdido', type: 'funded', customer: 'cus_C', net_amount: 44000 } },
  });
  es(r.codigo === 200, 'el depósito se acepta');
  es(await esperarLog('cliente recuperado de Stripe'), 'y se le pregunta a Stripe de quién era');
}

console.log('\n=== 5. CUANDO EL DINERO SE DA LA VUELTA ===');
{
  const r = await avisar({
    type: 'charge.dispute.created',
    data: { object: {
      id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_tarjeta_1', amount: 47000,
      reason: 'fraudulent', status: 'needs_response',
    } },
  });
  es(r.cuerpo.disputa === true, 'un contracargo se atiende (antes ni se escuchaba)');
  es(await esperarLog('contracargo'), 'y queda avisado');
  // El objeto de la disputa NO trae el teléfono: se encuentra por la referencia
  // del pago que ya estaba registrado.
  es(log.join('').includes(TEL_A), 'se identifica de QUIÉN es, por la referencia del pago');
}
{
  const r = await avisar({
    type: 'charge.refunded',
    data: { object: { id: 'ch_2', payment_intent: 'pi_tarjeta_1', amount: 47000, amount_refunded: 47000 } },
  });
  es(r.cuerpo.devolucion === true, 'una devolución también');
}
{
  const r = await avisar({
    type: 'charge.dispute.closed',
    data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_tarjeta_1', amount: 47000, status: 'won' } },
  });
  es(r.cuerpo.disputa === true, 'y el cierre del contracargo');
  es(await esperarLog('disputa cerrada'), 'diciendo cómo terminó');
}
{
  // Lo que NO debe pasar: cortarle el internet a alguien por una disputa.
  const texto = log.join('');
  es(!/desactivar|suspender/i.test(texto.split('contracargo')[1] || ''),
    'nadie se queda sin internet automáticamente por un contracargo');
}

console.log('\n=== 6. EL RESUMEN DE LA MAÑANA NO CONFUNDE LAS DOS COSAS ===');
{
  const fuente = fs.readFileSync('index.js', 'utf-8');
  es(/porRegistrar\.length\} pago/.test(fuente),
    'el conteo de "pagos por registrar" excluye los que se revirtieron');
  es(/que se revirtió/.test(fuente) && /no marques estas facturas como pagadas/.test(fuente),
    'y los contracargos van en su propio bloque, con la advertencia');
}

if (process.env.VER_LOG) console.error('\n---- LOG DEL SERVIDOR ----\n' + log.join(''));
console.log('\n=== 7. UNA LISTA PEOR NUNCA SUSTITUYE A LA BUENA ===');
{
  /*
   * Wisphub contestando 200 con la lista vacía es lo más peligroso que puede
   * pasarle al bot: dejaría de reconocer a los 1,430 clientes de golpe, nadie
   * podría pedir su CLABE, y el respaldo se sobrescribiría vacío. Tiene que
   * rechazarse y conservarse la lista anterior.
   */
  wisphub.clientes = [];
  const r = await admin('/admin/api/wisphub-sync', 'POST');
  es(r.synced === 0 && !!r.error, 'una sincronización vacía se rechaza');
  es(r.conservados >= 2, 'y se conserva la lista que ya había');
}
{
  wisphub.clientes = [
    { id_servicio: 1, nombre: 'Ana', apellidos: 'Pérez', telefono: '9511111111', usuario: 'clienteA', estado: 'Activo', precio_plan: '440.00' },
    { id_servicio: 2, nombre: 'Beto', apellidos: 'Ruiz', telefono: '9512222222', usuario: 'clienteB', estado: 'Activo', precio_plan: '300.00' },
    { id_servicio: 3, nombre: 'Caro', apellidos: 'Díaz', telefono: '9513333333', usuario: 'clienteC', estado: 'Suspendido', precio_plan: '440.00' },
  ];
  const r = await admin('/admin/api/wisphub-sync', 'POST');
  es(r.synced === 3, 'una lista completa sí entra');
}
{
  wisphub.caido = true;
  const r = await admin('/admin/api/wisphub-sync', 'POST');
  es(!!r.error && r.synced === 0, 'y si Wisphub se cae, tampoco se pierde a nadie');
  wisphub.caido = false;
}

console.log(`\n═══ ${ok} bien / ${mal} mal ═══`);
salir(mal ? 1 : 0);
