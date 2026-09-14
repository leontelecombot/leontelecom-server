/**
 * LO QUE EL BOT LE CONTESTA A UN CLIENTE, DE VERDAD.
 *
 * Las otras pruebas miran el dinero. Esta mira la CONVERSACIÓN: levanta
 * index.js con un WhatsApp de mentira que guarda cada mensaje que el bot manda,
 * y le entra por el mismo webhook por el que entra Meta. Así se comprueba lo
 * que la persona ve en su pantalla, no lo que el código "quiso" decir.
 *
 * Tres cosas que aquí se cuidan y en ningún otro lado:
 *
 *   1. Pagar la cuenta de OTRO. La mamá que no tiene WhatsApp, el vecino, la
 *      suegra. El cobro tiene que ir a la cuenta del otro, el acuse a quien
 *      pagó, y la reconexión al dueño.
 *   2. Que NADA se reactive hasta que el dinero esté confirmado. Ni al generar
 *      el link, ni al sacar la ficha de OXXO: solo cuando Stripe avisa que se
 *      pagó.
 *   3. Que no haya callejones sin salida: que "menú" saque de cualquier paso y
 *      que lo dicho hace media hora ya no cuente.
 *
 *   node verificar-whatsapp-leon.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PUERTO = 4386;
const PUERTO_STRIPE = 4387;
const PUERTO_WISPHUB = 4388;
const PUERTO_META = 4389;
const BASE = `http://127.0.0.1:${PUERTO}`;
const SECRETO = 'whsec_prueba_whatsapp';

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };
const es = (cond, m) => (cond ? OK(m) : MAL(m));

// Los clientes de la prueba. Doce dígitos, como los guarda el bot.
const A = '529511111111';   // quien escribe; está en el piloto
const B = '529512222222';   // Ana Pérez, suspendida; la cuenta que A va a pagar
const C = '529513333333';   // Ana Pérez Gómez: comparte nombre con B a propósito
const D = '529514444444';   // fuera del piloto
const E = '529515555555';   // Elena Cruz: sin deuda y sin precio de plan (no hay nada que cobrar)

// ── WhatsApp de mentira: guarda lo que el bot manda ────────────────────────
const enviados = [];   // { a, texto, botones: [{id,title}] }
const metaFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    try {
      const m = JSON.parse(cuerpo || '{}');
      const texto = m.type === 'interactive' ? (m.interactive?.body?.text || '') : (m.text?.body || '');
      const botones = m.type === 'interactive' && m.interactive?.type === 'button'
        ? (m.interactive.action?.buttons || []).map((b) => ({ id: b.reply.id, title: b.reply.title }))
        : [];
      enviados.push({ a: String(m.to || ''), texto, botones, tipo: m.type });
    } catch (_) { /* una imagen o algo que no es mensaje */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages: [{ id: 'wamid.' + enviados.length }] }));
  });
});
await new Promise((r) => metaFalso.listen(PUERTO_META, '127.0.0.1', r));

// ── Stripe de mentira: la cuenta de León está lista y las sesiones se anotan ─
const stripe = { sesiones: [] };
const stripeFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const p = new URLSearchParams(cuerpo);
    res.setHeader('content-type', 'application/json');
    const responder = (obj, codigo = 200) => { res.statusCode = codigo; res.end(JSON.stringify(obj)); };
    if (/^\/v1\/accounts\/acct_leon/.test(req.url)) {
      return responder({ id: 'acct_leon', charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] } });
    }
    if (req.url.startsWith('/v1/checkout/sessions')) {
      const s = {
        id: 'cs_test_' + (stripe.sesiones.length + 1),
        url: `https://checkout.stripe.com/c/pay/cs_test_${stripe.sesiones.length + 1}`,
        amount_total: 0,
        telefono: p.get('metadata[telefono]'),
        pagadoPor: p.get('metadata[pagadoPor]'),
        forma: p.get('payment_method_types[0]'),
        mensualidad: p.get('metadata[mensualidad]'),
      };
      stripe.sesiones.push(s);
      return responder({ id: s.id, url: s.url });
    }
    if (req.url.startsWith('/v1/customers/search')) return responder({ data: [] });
    responder({ error: { message: 'ruta falsa no implementada: ' + req.url } }, 404);
  });
});
await new Promise((r) => stripeFalso.listen(PUERTO_STRIPE, '127.0.0.1', r));

// ── Wisphub de mentira: deudas, servicios y la lista de reactivaciones ──────
const wisphub = {
  servicios: {   // teléfono -> servicio como lo devuelve /api/clientes/?telefono=
    [A]: { id_servicio: 101, usuario: 'clienteA', nombre: 'Andrés', apellidos: 'López', estado: 'Suspendido', telefono: A },
    [B]: { id_servicio: 102, usuario: 'clienteB', nombre: 'Ana', apellidos: 'Pérez', estado: 'Suspendido', telefono: B },
    [C]: { id_servicio: 103, usuario: 'clienteC', nombre: 'Ana', apellidos: 'Pérez Gómez', estado: 'Activo', telefono: C },
    [D]: { id_servicio: 104, usuario: 'clienteD', nombre: 'Diego', apellidos: 'Ruiz', estado: 'Suspendido', telefono: D },
  },
  deuda: { clienteA: 300, clienteB: 440, clienteC: 0, clienteD: 350 },
  activaciones: [],   // los servicios que se mandaron reactivar
  puts: 0,
};
const wisphubFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/clientes/activar/') {
      const b = JSON.parse(cuerpo || '{}');
      wisphub.activaciones.push(...(b.servicios || []));
      return res.end(JSON.stringify({ task_id: 'tarea_' + wisphub.activaciones.length, warnings: [] }));
    }
    if (u.pathname === '/api/clientes/') {
      const tel = (u.searchParams.get('telefono') || '').replace(/\D/g, '');
      if (!tel) return res.end(JSON.stringify({ count: 0, results: [] }));   // la sincronización: se queda la lista sembrada
      const s = Object.values(wisphub.servicios).find((x) => x.telefono.endsWith(tel.slice(-10)));
      return res.end(JSON.stringify({ count: s ? 1 : 0, results: s ? [s] : [] }));
    }
    if (u.pathname === '/api/facturas/') {
      const usuario = u.searchParams.get('cliente') || '';
      const total = wisphub.deuda[usuario] || 0;
      const results = total > 0
        ? [{ id_factura: 9000 + Number(usuario.slice(-1).charCodeAt(0)), total: total.toFixed(2), estado: 'Pendiente', fecha_vencimiento: '2026-09-01' }]
        : [];
      return res.end(JSON.stringify({ results }));
    }
    if (/^\/api\/facturas\/\d+\/$/.test(u.pathname)) {
      // Como la API real: el PUT se acepta y la factura sigue Pendiente.
      wisphub.puts += req.method === 'PUT' ? 1 : 0;
      return res.end(JSON.stringify({ id_factura: 9001, total: '440.00', estado: 'Pendiente', fecha_emision: '2026-09-01', fecha_vencimiento: '2026-09-10' }));
    }
    res.end(JSON.stringify({ results: [] }));
  });
});
await new Promise((r) => wisphubFalso.listen(PUERTO_WISPHUB, '127.0.0.1', r));

// ── Estado sembrado: la lista de clientes como la deja Wisphub ─────────────
const RUTA_STORE = path.join(process.cwd(), 'data', 'store.json');
const respaldo = fs.existsSync(RUTA_STORE) ? fs.readFileSync(RUTA_STORE) : null;
fs.mkdirSync(path.dirname(RUTA_STORE), { recursive: true });
fs.writeFileSync(RUTA_STORE, JSON.stringify({
  wisphubClientes: {
    [A]: { usuario: 'clienteA', name: 'Andrés López', precioPlan: '300.00', status: 'Suspendido' },
    [B]: { usuario: 'clienteB', name: 'Ana Pérez', precioPlan: '440.00', status: 'Suspendido' },
    [C]: { usuario: 'clienteC', name: 'Ana Pérez Gómez', precioPlan: '350.00', status: 'Activo' },
    [D]: { usuario: 'clienteD', name: 'Diego Ruiz', precioPlan: '350.00', status: 'Suspendido' },
    [E]: { usuario: 'clienteE', name: 'Elena Cruz', precioPlan: '', status: 'Activo' },
  },
  wisphubClientesAl: new Date().toISOString(),
}));
const restaurar = () => {
  if (respaldo) fs.writeFileSync(RUTA_STORE, respaldo);
  else if (fs.existsSync(RUTA_STORE)) fs.unlinkSync(RUTA_STORE);
};

const srv = spawn('node', ['index.js'], {
  env: {
    ...process.env,
    PORT: String(PUERTO),
    PRUEBAS: '1',
    RATE_MAX: '1000',   // la prueba escribe más rápido que cualquier persona
    MONGODB_URI: '', DATABASE_URL: '',
    COBRO_LINEA_ACTIVO: 'true',
    COBRO_LINEA_TELEFONOS: `${A},${B},${C}`,   // D queda fuera a propósito
    STRIPE_API_BASE: `http://127.0.0.1:${PUERTO_STRIPE}/v1/`,
    STRIPE_SECRET_KEY: 'sk_test_falsa',
    STRIPE_WEBHOOK_SECRET_LEON: SECRETO,
    LEON_STRIPE_CUENTA_CONECTADA: 'acct_leon',
    WHATSAPP_API_BASE: `http://127.0.0.1:${PUERTO_META}`,
    WHATSAPP_PHONE_NUMBER_ID: '111', WHATSAPP_ACCESS_TOKEN: 'token_falso',
    WISPHUB_API_KEY: 'llave_falsa',
    WISPHUB_API_URL: `http://127.0.0.1:${PUERTO_WISPHUB}`,
    WISPHUB_REACTIVAR_ACTIVO: 'true',
    ADMIN_PASSWORD: 'prueba-local-larga',
    ALERT_ADMIN_NUMBER: '',
    SERVER_BASE_URL: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
srv.stdout.on('data', (d) => log.push(String(d)));
srv.stderr.on('data', (d) => log.push(String(d)));
const salir = (c) => { srv.kill('SIGKILL'); restaurar(); process.exit(c); };
process.on('uncaughtException', (e) => { console.error(e); console.log(log.join('').split('\n').filter((l) => /wisphub|stripe-leon|rror|Incoming/.test(l)).slice(-40).join('\n')); salir(1); });

let vivo = false;
for (let i = 0; i < 60 && !vivo; i++) {
  try { await fetch(BASE + '/'); vivo = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!vivo) { console.error(log.join('')); salir(1); }
await new Promise((r) => setTimeout(r, 800));   // que termine de arrancar (sync, cuenta)

// ── Cómo se le habla al bot ─────────────────────────────────────────────────
/** Un mensaje entrando por el webhook de Meta, como lo manda WhatsApp. */
async function entra(de, texto, esBoton = false) {
  const raw = '521' + de.slice(2);   // Meta manda 521..., el bot lo normaliza
  const msg = esBoton
    ? { from: raw, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: texto, title: texto } } }
    : { from: raw, type: 'text', text: { body: texto } };
  await fetch(BASE + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [msg], contacts: [{ profile: { name: 'Prueba' } }] } }] }] }),
  });
}
/** Espera a que el bot haya mandado al menos `n` mensajes nuevos, y los devuelve. */
async function respuestas(desde, n = 1, ms = 4000) {
  const t0 = Date.now();
  while (enviados.length < desde + n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 60));
  await new Promise((r) => setTimeout(r, 150));   // por si venía otro pegado
  return enviados.slice(desde);
}
const dice = (lista, re) => lista.some((m) => re.test(m.texto));
const conBotones = (lista) => lista.find((m) => m.botones.length) || { botones: [] };
const toca = (de, id) => entra(de, id, true);

const avisar = async (evento) => {
  const cuerpo = JSON.stringify(evento);
  const t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', SECRETO).update(`${t}.${cuerpo}`).digest('hex');
  const r = await fetch(BASE + '/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${firma}` },
    body: cuerpo,
  });
  return { st: r.status, d: await r.json().catch(() => null) };
};
const sesionPagada = (s, extra = {}) => ({
  id: 'evt_' + s.id + '_' + (extra.type || 'ok'), type: extra.type || 'checkout.session.completed',
  data: { object: {
    id: s.id, payment_status: extra.payment_status || 'paid', amount_total: Number(s.mensualidad) + 1000,
    payment_intent: 'pi_' + s.id,
    metadata: { telefono: s.telefono, pagadoPor: s.pagadoPor, tipo: 'mensualidad-leontelecom', forma: s.forma, mensualidad: s.mensualidad },
  } },
});

console.log('\n=== 1. EL MENÚ DE PAGAR: A QUIÉN SE LE OFRECE QUÉ ===');
{
  let n = enviados.length;
  await entra(A, 'pagar');
  const r = await respuestas(n);
  const b = conBotones(r).botones.map((x) => x.id);
  es(b.includes('pago_tarjeta') && b.includes('pago_clabe'), 'en el piloto: tarjeta/OXXO y CLABE en el menú');
  es(dice(r, /OTRO/), 'en el piloto se le dice que puede pagar la cuenta de alguien más (OTRO)');
  es(r.every((m) => m.a === A), 'todo le llegó a quien escribió');

  n = enviados.length;
  await entra(D, 'pagar');
  const rd = await respuestas(n);
  const bd = conBotones(rd).botones.map((x) => x.id);
  es(!bd.includes('pago_tarjeta') && bd.includes('pago_horario'), 'fuera del piloto: solo oficina y datos de pago');
  es(!dice(rd, /OTRO/), 'fuera del piloto ni se menciona OTRO');

  n = enviados.length;
  await entra(D, 'otro');
  const ro = await respuestas(n, 1, 1500);
  es(!dice(ro, /De quién es la cuenta/), 'fuera del piloto, OTRO no abre el flujo de pagar por otro');
}

console.log('\n=== 2. PAGAR LA CUENTA DE OTRO, POR TELÉFONO ===');
{
  let n = enviados.length;
  await entra(A, 'OTRO');
  let r = await respuestas(n);
  es(dice(r, /De quién es la cuenta/), 'OTRO pregunta de quién es la cuenta');

  n = enviados.length;
  await entra(A, '951 222 2222');
  r = await respuestas(n);
  const bot = conBotones(r);
  es(dice(r, /¿Es la cuenta de \*Ana Pérez\*\?/), 'con el teléfono encuentra a Ana Pérez y pide confirmar');
  es(bot.botones.length === 1 && bot.botones[0].id === 'pago_otro_es_0', 'un solo botón de confirmación');

  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  r = await respuestas(n);
  es(dice(r, /vas a pagar la cuenta de \*Ana Pérez\*/), 'al confirmar, dice de quién es la cuenta que va a pagar');
  es(conBotones(r).botones.some((x) => x.id === 'pago_tarjeta'), 'y ofrece tarjeta u OXXO');

  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /La mensualidad de \*Ana Pérez\* es de \*\$440\.00\*/), 'cotiza la mensualidad de ELLA ($440), no la de quien escribe ($300)');
  const bb = conBotones(r).botones.map((x) => x.id);
  es(bb.includes('pago_con_tarjeta') && bb.includes('pago_con_oxxo'), 'con los dos precios: tarjeta y OXXO');

  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(A, 'pago_con_tarjeta');
  r = await respuestas(n);
  const s = stripe.sesiones[antes];
  es(!!s, 'se generó el link de pago');
  es(s && s.telefono === B, 'el cobro va a la cuenta de Ana Pérez');
  es(s && s.pagadoPor === A, 'y queda anotado quién lo pagó');
  es(s && s.forma === 'card', 'amarrado a tarjeta');
  es(dice(r, /Cuenta de: \*Ana Pérez\*/), 'el mensaje dice de quién es la cuenta');
  es(dice(r, /Mensualidad: \$440\.00/), 'con la mensualidad de ella');
  es(dice(r, /el servicio de \*Ana Pérez\* se reactiva solo/), 'y aclara que el que se reactiva es el de ella, no "tu servicio"');
  es(!dice(r, /tu servicio se reactiva/), 'no le promete reactivarle SU servicio a quien pagó por otro');
  es(r.every((m) => m.a === A), 'Ana Pérez todavía no recibe nada: no ha pasado nada con su cuenta');

  // Y la sesión se limpió: si vuelve a pagar, paga lo suyo.
  n = enviados.length;
  await entra(A, 'pagar');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de \*\$300\.00\*/), 'después del link, PAGAR vuelve a ser para su propia cuenta ($300)');
}

console.log('\n=== 3. NADA SE REACTIVA HASTA QUE EL DINERO ESTÁ CONFIRMADO ===');
{
  es(wisphub.activaciones.length === 0, 'generar el link NO reactivó a nadie');
  const s = stripe.sesiones[0];
  const n = enviados.length;
  const r = await avisar(sesionPagada(s));
  es(r.st === 200, 'Stripe avisa que se pagó con tarjeta');
  const msgs = await respuestas(n, 3);
  es(wisphub.activaciones.includes(102), 'con el pago confirmado se reactiva el servicio de Ana Pérez (102)');
  es(!wisphub.activaciones.includes(101), 'y NO el de quien pagó');
  es(msgs.some((m) => m.a === B && /Recibimos el pago.*Lo pagó otra persona por ti/s.test(m.texto)), 'Ana Pérez se entera de que alguien pagó por ella');
  es(msgs.some((m) => m.a === A && /tu pago se aplicó al servicio de \*Ana Pérez\*/.test(m.texto)), 'quien pagó recibe su acuse');
  es(msgs.some((m) => m.a === B && /reactivado/.test(m.texto)), 'y a Ana Pérez le avisan que ya quedó reactivada');
  const otraVez = await avisar(sesionPagada(s));
  es(otraVez.d && otraVez.d.repetido === true, 'el mismo aviso repetido no vuelve a abonar ni a escribir');
}

console.log('\n=== 4. OXXO POR OTRO: LA FICHA LA RECIBE QUIEN LA SACÓ ===');
{
  let n = enviados.length;
  await entra(A, 'pagar el de mi mamá');
  const r0 = await respuestas(n);
  es(dice(r0, /De quién es la cuenta/), '"pagar el de mi mamá" también abre el flujo de pagar por otro');
  if (!dice(r0, /De quién es la cuenta/)) console.log('    recibió:', JSON.stringify(r0.map((m) => m.texto.slice(0, 80))));
  n = enviados.length;
  await entra(A, 'Ana Pérez');
  let r = await respuestas(n);
  const bot = conBotones(r);
  es(dice(r, /Encontré estas cuentas/) && bot.botones.length === 2, 'por nombre encuentra a las dos Ana Pérez y pregunta cuál');
  es(bot.botones.map((x) => x.title).includes('Ana Pérez') && bot.botones.some((x) => /Gómez/.test(x.title)), 'con el nombre de cada una en su botón');
  const cual = bot.botones.findIndex((x) => x.title === 'Ana Pérez');

  n = enviados.length;
  await toca(A, 'pago_otro_es_' + cual);
  r = await respuestas(n);
  es(dice(r, /vas a pagar la cuenta de \*Ana Pérez\*/), 'elige a la Ana Pérez correcta');
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /La mensualidad de \*Ana Pérez\* es de/), 'y cotiza la de ella');
  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(A, 'pago_con_oxxo');
  r = await respuestas(n);
  const s = stripe.sesiones[antes];
  if (!s) console.log('    recibió:', JSON.stringify(r.map((m) => m.texto.slice(0, 120))));
  es(s && s.forma === 'oxxo' && s.telefono === B && s.pagadoPor === A, 'la ficha de OXXO va a la cuenta de Ana Pérez, sacada por A');
  es(dice(r, /la ficha para pagar en OXXO/), 'el mensaje habla de "la ficha", no de "tu ficha"');
  const activacionesAntes = wisphub.activaciones.length;

  // Stripe avisa que la ficha se generó (completed + unpaid). Eso NO es un pago.
  n = enviados.length;
  await avisar(sesionPagada(s, { payment_status: 'unpaid' }));
  r = await respuestas(n, 1);
  es(wisphub.activaciones.length === activacionesAntes, 'generar la ficha no reactiva nada');
  es(r.some((m) => m.a === A && /Ya se generó la ficha para pagar el servicio de \*Ana Pérez\*/.test(m.texto)), 'el "ya está tu ficha" le llega a quien la sacó, nombrando a la dueña');
  es(!r.some((m) => m.a === B), 'a la dueña no le llega un aviso de una ficha que no sacó');

  // Pagó en la tienda.
  n = enviados.length;
  await avisar(sesionPagada(s, { type: 'checkout.session.async_payment_succeeded', payment_status: 'unpaid' }));
  r = await respuestas(n, 3);
  es(wisphub.activaciones.length === activacionesAntes + 1 && wisphub.activaciones.at(-1) === 102, 'cuando OXXO reporta el pago, se reactiva el de Ana Pérez');
  es(r.some((m) => m.a === A && /se aplicó al servicio de \*Ana Pérez\*/.test(m.texto)), 'quien pagó en OXXO recibe su acuse');
  es(r.some((m) => m.a === B && /Recibimos el pago/.test(m.texto)), 'y la dueña se entera');

  // Otra ficha que venció sin pagarse.
  const s2 = { ...s, id: 'cs_test_vencida' };
  n = enviados.length;
  await avisar(sesionPagada(s2, { type: 'checkout.session.async_payment_failed', payment_status: 'unpaid' }));
  r = await respuestas(n, 1);
  es(r.some((m) => m.a === A && /venció sin pagarse/.test(m.texto) && /Ana Pérez/.test(m.texto) && /OTRO/.test(m.texto)), 'si la ficha vence, se le dice a quien la sacó y cómo sacar otra (OTRO)');
  es(!r.some((m) => m.a === B), 'sin molestar a la dueña por una ficha que no sacó');
}

console.log('\n=== 5. SIN CALLEJONES SIN SALIDA ===');
{
  let n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  n = enviados.length;
  await entra(A, '951 111 1111');   // su propio número
  let r = await respuestas(n);
  es(dice(r, /No encontré una cuenta con eso/), 'su propio número no cuenta como "otro"');

  n = enviados.length;
  await entra(A, 'ana');
  r = await respuestas(n);
  es(dice(r, /No encontré una cuenta con eso/), 'tres letras no bastan para buscar por nombre');
  es(dice(r, /escribe \*menú\*/), 'y se le dice cómo salir');

  n = enviados.length;
  await entra(A, 'menú');
  r = await respuestas(n);
  es(dice(r, /lo dejamos ahí/), '"menú" lo saca del paso de buscar');

  n = enviados.length;
  await entra(A, 'pagar');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de/), 'y después de salir, PAGAR es para su propia cuenta');

  // Un botón de confirmación viejo, sin sesión, no hace nada raro.
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  r = await respuestas(n, 1, 1500);
  es(!stripe.sesiones.some((s) => s.telefono === C), 'un botón viejo de confirmación no elige a nadie');
  es(!log.join('').includes('TypeError'), 'ni tira el servidor');
}

console.log('\n=== 6. LO DICHO HACE MEDIA HORA YA NO CUENTA ===');
{
  let n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  n = enviados.length;
  await entra(A, 'Diego Ruiz');   // fuera del piloto, pero su cuenta sí se puede pagar
  let r = await respuestas(n);
  es(dice(r, /¿Es la cuenta de \*Diego Ruiz\*\?/), 'se puede pagar la cuenta de alguien que no está en el piloto');
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  await respuestas(n);

  // Pasa media hora y un minuto.
  const env = await fetch(BASE + '/api/pruebas/envejecer-sesion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono: A, ms: 31 * 60 * 1000 }),
  }).then((x) => x.json());
  es(env.ok && env.estado === 'pago_otro_listo', 'estaba a punto de pagar la de Diego');

  n = enviados.length;
  await entra(A, 'pagar');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de \*\$300\.00\*/), 'media hora después, PAGAR cotiza SU cuenta, no la de Diego');
  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(A, 'pago_con_tarjeta');
  await respuestas(n);
  const s = stripe.sesiones[antes];
  es(s && s.telefono === A && s.pagadoPor === A, 'y el link sale para su propia cuenta');

  // También el paso de buscar caduca: al día siguiente "hola" no se busca como nombre.
  n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  await fetch(BASE + '/api/pruebas/envejecer-sesion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono: A, ms: 31 * 60 * 1000 }),
  });
  n = enviados.length;
  await entra(A, 'buenas tardes');
  r = await respuestas(n, 1, 2500);
  es(!dice(r, /No encontré una cuenta/), 'al día siguiente, un saludo no se busca como si fuera un nombre');
}

console.log('\n=== 7. UNA EMERGENCIA SIEMPRE GANA ===');
{
  let n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  n = enviados.length;
  await entra(A, 'se está quemando el poste de la esquina');
  const r = await respuestas(n, 1, 3000);
  es(!dice(r, /No encontré una cuenta/), 'en medio de buscar, un "se está quemando" no se toma como nombre');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
}

console.log('\n=== 8. LA CUENTA AJENA QUE NO DEBE ===');
{
  // Sin deuda pero con plan: se puede adelantar la mensualidad, y se cotiza la de ELLA.
  let n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  n = enviados.length;
  await entra(A, 'Pérez Gómez');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  let r = await respuestas(n);
  es(dice(r, /La mensualidad de \*Ana Pérez Gómez\* es de \*\$350\.00\*/), 'si la cuenta ajena está al corriente, se le cotiza SU plan ($350) para adelantar');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);

  // Sin deuda y sin precio de plan: no hay nada que cobrar, y se dice de ESA cuenta.
  n = enviados.length;
  await entra(A, 'OTRO');
  await respuestas(n);
  n = enviados.length;
  await entra(A, 'Elena Cruz');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  r = await respuestas(n);
  es(dice(r, /No veo un saldo pendiente en la cuenta de \*Elena Cruz\*/), 'si no hay nada que cobrar, lo dice de ESA cuenta, no de "tu cuenta"');
  es(!stripe.sesiones.some((s) => s.telefono === E), 'y no genera ningún cobro');
}

console.log('\n=== 9. "OTRO" NO SE ROBA LAS RESPUESTAS DE OTRA CONVERSACIÓN ===');
{
  // A está a media conversación de reportar una falla. Ahí "otro" es una
  // respuesta a esa pregunta, no una orden de pagar por alguien.
  let n = enviados.length;
  await entra(A, 'quiero reportar algo');
  await respuestas(n);
  n = enviados.length;
  await entra(A, 'otro');
  const r = await respuestas(n, 1, 2500);
  es(!dice(r, /De quién es la cuenta/), 'a media conversación de un reporte, "otro" no abre el flujo de pagar por otro');
}

console.log(`\n${ok} bien, ${mal} mal`);
if (mal) { console.log('\n--- registro del servidor (últimas líneas) ---\n' + log.join('').split('\n').slice(-40).join('\n')); }
salir(mal ? 1 : 0);
