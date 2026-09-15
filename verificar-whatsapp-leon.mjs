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
const F = '529516666666';   // Fermín Ortiz: DOS contratos con el mismo teléfono (casa y local)
const G = '529517777777';   // Gloria Núñez: debe y le cortan mañana (sí le toca aviso)
const H = '529518888888';   // Hugo Sáenz: activa el cobro automático; su corte es pasado mañana
const I = '529510101010';   // Inés Vega: automático y corte mañana, sin haber pagado: a ella sí se le cobra
const PASADO = (() => { const d = new Date(Date.now() + 48 * 3600 * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
// Mañana, en fecha local, como la guarda Wisphub (fecha_corte).
const MANANA = (() => { const d = new Date(Date.now() + 24 * 3600 * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();

// ── WhatsApp de mentira: guarda lo que el bot manda ────────────────────────
const enviados = [];   // { a, texto, botones: [{id,title}] }
const metaFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    try {
      const m = JSON.parse(cuerpo || '{}');
      const texto = m.type === 'interactive' ? (m.interactive?.body?.text || '')
        : m.type === 'template' ? ((((m.template || {}).components || []).find((c) => c.type === 'body') || {}).parameters || []).map((x) => x.text).join(' ')
        : (m.text?.body || '');
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
const stripe = { sesiones: [], clientes: [], tarjetas: {}, cobros: [], rechazar: false };
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
        meses: p.get('metadata[meses]') || '1',
        customer: p.get('customer') || '',
        guardarTarjeta: p.get('metadata[guardarTarjeta]') || 'no',
        futuro: p.get('payment_intent_data[setup_future_usage]') || '',
      };
      stripe.sesiones.push(s);
      return responder({ id: s.id, url: s.url });
    }
    if (req.url.startsWith('/v1/customers/search')) return responder({ data: [] });
    if (/^\/v1\/customers\/[^/]+\/payment_methods/.test(req.url)) {
      const id = req.url.split('/')[3];
      const tiene = stripe.tarjetas[id];
      return responder({ data: tiene ? [{ id: 'pm_' + id, card: { last4: '4242', brand: 'visa' } }] : [] });
    }
    if (req.url === '/v1/payment_intents') {
      const pi = { id: 'pi_auto_' + (stripe.cobros.length + 1), status: stripe.rechazar ? 'requires_payment_method' : 'succeeded', amount: Number(p.get('amount')) };
      stripe.cobros.push({ customer: p.get('customer'), amount: Number(p.get('amount')), periodo: p.get('metadata[periodo]'), llave: req.headers['idempotency-key'] || '' });
      if (stripe.rechazar) return responder({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }, 402);
      return responder(pi);
    }
    if (req.url === '/v1/customers') {
      const c = { id: 'cus_' + (stripe.clientes.length + 1), metadata: { telefono: p.get('metadata[telefono]'), servicioId: p.get('metadata[servicioId]') || '' } };
      stripe.clientes.push(c);
      return responder(c);
    }
    if (/^\/v1\/customers\/[^/]+\/funding_instructions/.test(req.url)) {
      const id = req.url.split('/')[3];
      const n = Number(id.replace('cus_', '')) || 1;
      return responder({ bank_transfer: { financial_addresses: [{ spei: { clabe: String(646180100000000000 + n), bank_name: 'STP', reference: '1234' } }] } });
    }
    responder({ error: { message: 'ruta falsa no implementada: ' + req.url } }, 404);
  });
});
await new Promise((r) => stripeFalso.listen(PUERTO_STRIPE, '127.0.0.1', r));

// El padrón, como lo devuelve Wisphub. B, D y G tienen corte MAÑANA y deben.
const PADRON = [
  { id_servicio: 101, usuario: 'clienteA', nombre: 'Andrés', apellidos: 'López', estado: 'Suspendido', telefono: A, precio_plan: '300.00', fecha_corte: MANANA },
  { id_servicio: 102, usuario: 'clienteB', nombre: 'Ana', apellidos: 'Pérez', estado: 'Suspendido', telefono: B, precio_plan: '440.00', fecha_corte: MANANA },
  { id_servicio: 103, usuario: 'clienteC', nombre: 'Ana', apellidos: 'Pérez Gómez', estado: 'Activo', telefono: C, precio_plan: '350.00' },
  { id_servicio: 104, usuario: 'clienteD', nombre: 'Diego', apellidos: 'Ruiz', estado: 'Suspendido', telefono: D, precio_plan: '350.00', fecha_corte: MANANA },
  { id_servicio: 105, usuario: 'clienteE', nombre: 'Elena', apellidos: 'Cruz', estado: 'Activo', telefono: E, precio_plan: '' },
  { id_servicio: 106, usuario: 'clienteF-casa', nombre: 'Fermín', apellidos: 'Ortiz', estado: 'Activo', telefono: F, precio_plan: '300.00' },
  { id_servicio: 108, usuario: 'clienteG', nombre: 'Gloria', apellidos: 'Núñez', estado: 'Suspendido', telefono: G, precio_plan: '320.00', fecha_corte: MANANA },
  { id_servicio: 109, usuario: 'clienteH', nombre: 'Hugo', apellidos: 'Sáenz', estado: 'Activo', telefono: H, precio_plan: '340.00', fecha_corte: PASADO },
  { id_servicio: 110, usuario: 'clienteI', nombre: 'Inés', apellidos: 'Vega', estado: 'Activo', telefono: I, precio_plan: '290.00', fecha_corte: MANANA },
];

// ── Wisphub de mentira: deudas, servicios y la lista de reactivaciones ──────
const wisphub = {
  servicios: {   // teléfono -> servicio como lo devuelve /api/clientes/?telefono=
    [A]: { id_servicio: 101, usuario: 'clienteA', nombre: 'Andrés', apellidos: 'López', estado: 'Suspendido', telefono: A },
    [B]: { id_servicio: 102, usuario: 'clienteB', nombre: 'Ana', apellidos: 'Pérez', estado: 'Suspendido', telefono: B },
    [C]: { id_servicio: 103, usuario: 'clienteC', nombre: 'Ana', apellidos: 'Pérez Gómez', estado: 'Activo', telefono: C },
    [D]: { id_servicio: 104, usuario: 'clienteD', nombre: 'Diego', apellidos: 'Ruiz', estado: 'Suspendido', telefono: D },
    [G]: { id_servicio: 108, usuario: 'clienteG', nombre: 'Gloria', apellidos: 'Núñez', estado: 'Suspendido', telefono: G },
    [H]: { id_servicio: 109, usuario: 'clienteH', nombre: 'Hugo', apellidos: 'Sáenz', estado: 'Activo', telefono: H },
    [I]: { id_servicio: 110, usuario: 'clienteI', nombre: 'Inés', apellidos: 'Vega', estado: 'Activo', telefono: I },
  },
  // Un teléfono con DOS contratos: la casa (activa) y el local (suspendido).
  extras: {
    [F]: [
      { id_servicio: 106, usuario: 'clienteF-casa', nombre: 'Fermín', apellidos: 'Ortiz', estado: 'Activo', telefono: F, direccion: 'Casa, Col. Centro', plan_internet: { nombre: 'Plan 20' }, fecha_corte: PASADO },
      { id_servicio: 107, usuario: 'clienteF-local', nombre: 'Fermín', apellidos: 'Ortiz', estado: 'Suspendido', telefono: F, direccion: 'Local, Av. Juárez', plan_internet: { nombre: 'Plan 50' }, fecha_corte: MANANA },
    ],
  },
  deuda: { clienteA: 300, clienteB: 440, clienteC: 0, clienteD: 350, 'clienteF-casa': 0, 'clienteF-local': 500, clienteG: 320, clienteH: 340, clienteI: 290 },
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
      if (!tel) {
        // La sincronización completa: el mismo padrón que se sembró, con fecha de corte.
        const offset = Number(u.searchParams.get('offset') || 0);
        return res.end(JSON.stringify({ count: PADRON.length, results: offset ? [] : PADRON }));
      }
      const extra = Object.entries(wisphub.extras).find(([t]) => t.endsWith(tel.slice(-10)));
      if (extra) return res.end(JSON.stringify({ count: extra[1].length, results: extra[1] }));
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
    [F]: { usuario: 'clienteF-casa', name: 'Fermín Ortiz', precioPlan: '300.00', status: 'Activo' },
    [G]: { usuario: 'clienteG', name: 'Gloria Núñez', precioPlan: '320.00', status: 'Suspendido' },
    [H]: { usuario: 'clienteH', name: 'Hugo Sáenz', precioPlan: '340.00', status: 'Activo' },
    [I]: { usuario: 'clienteI', name: 'Inés Vega', precioPlan: '290.00', status: 'Activo' },
  },
  wisphubClientesAl: new Date().toISOString(),
}));
const restaurar = () => {
  if (respaldo) fs.writeFileSync(RUTA_STORE, respaldo);
  else if (fs.existsSync(RUTA_STORE)) fs.unlinkSync(RUTA_STORE);
};

const ENV_SERVIDOR = {
    ...process.env,
    PORT: String(PUERTO),
    PRUEBAS: '1',
    RATE_MAX: '1000',   // la prueba escribe más rápido que cualquier persona
    MONGODB_URI: '', DATABASE_URL: '',
    COBRO_LINEA_ACTIVO: 'true',
    COBRO_LINEA_TELEFONOS: `${A},${B},${C},${F},${H},${I}`,   // D queda fuera a propósito
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
    AGENT_WHATSAPP_NUMBER: '529519999999',
    CORTE_REMINDER_ENABLED: 'true',
    WHATSAPP_AVISO_TEMPLATE: 'aviso_prueba',
    SERVER_BASE_URL: BASE,
};
const srv = spawn('node', ['index.js'], { env: ENV_SERVIDOR, stdio: ['ignore', 'pipe', 'pipe'] });
const log = [];
srv.stdout.on('data', (d) => log.push(String(d)));
srv.stderr.on('data', (d) => log.push(String(d)));
let SEGUNDO = null;
const salir = (c) => { srv.kill('SIGKILL'); if (SEGUNDO) SEGUNDO.kill('SIGKILL'); restaurar(); process.exit(c); };
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
  es(b.includes('pago_con_tarjeta') && b.includes('pago_clabe') && b.includes('pago_con_oxxo'), 'en el piloto: transferencia, tarjeta y OXXO, un botón cada una');
  es(dice(r, /Tu mensualidad es de \*\$300\.00\*/), 'y antes de preguntar cómo, le dice cuánto debe');
  es(dice(r, /a nombre de quién/), 'en el piloto se le dice cómo pagar la cuenta de alguien más (a nombre de quién)');
  es(r.every((m) => m.a === A), 'todo le llegó a quien escribió');

  n = enviados.length;
  await entra(D, 'pagar');
  const rd = await respuestas(n);
  const bd = conBotones(rd).botones.map((x) => x.id);
  es(!bd.includes('pago_tarjeta') && bd.includes('pago_horario'), 'fuera del piloto: solo oficina y datos de pago');
  es(!dice(rd, /a nombre de quién/), 'fuera del piloto ni se menciona pagar por otro');

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
  es(dice(r, /Su mensualidad es de \*\$440\.00\*/), 'con la mensualidad de ella a la vista');
  const bc = conBotones(r).botones.map((x) => x.id);
  es(bc.includes('pago_clabe') && bc.includes('pago_con_tarjeta') && bc.includes('pago_con_oxxo'), 'y ofrece transferencia, tarjeta y OXXO de un toque');

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
  es(msgs.some((m) => m.a === B && m.tipo === 'template'), 'y le llega por plantilla, porque ella nunca le ha escrito al bot (ventana de 24 h)');
  es(msgs.some((m) => m.a === A && /tu pago se aplicó al servicio de \*Ana Pérez\*/.test(m.texto)), 'quien pagó recibe su acuse');
  es(msgs.some((m) => m.a === B && /reactivado/.test(m.texto)), 'y a Ana Pérez le avisan que ya quedó reactivada');
  const otraVez = await avisar(sesionPagada(s));
  es(otraVez.d && otraVez.d.repetido === true, 'el mismo aviso repetido no vuelve a abonar ni a escribir');
}

console.log('\n=== 4. OXXO POR OTRO: LA FICHA LA RECIBE QUIEN LA SACÓ ===');
{
  let n = enviados.length;
  await entra(A, 'Pago de internet a nombre de Ana Pérez');
  let r = await respuestas(n);
  es(!dice(r, /De quién es la cuenta/), '"pago a nombre de Ana Pérez" no pregunta de quién: ya lo dijo');
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
  es(dice(r, /OXXO puede tardar hasta un día.*el servicio de \*Ana Pérez\* quede activo hoy/s), 'y como Ana está suspendida, avisa que OXXO tarda y que tarjeta o transferencia reactivan al momento');
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
  // Un nombre demasiado común: en el padrón de prueba "clie" no aparece, pero "Pérez" da 2; se prueba con un apellido que abarca 4+ (todos los nombres tienen letras 'e'): se usa una letra que cubre a casi todos.
  n = enviados.length;
  await entra(A, 'ez');
  let r0 = await respuestas(n);
  es(dice(r0, /No encontré/) || dice(r0, /Hay varias personas/) , 'dos letras no bastan, o si hay demasiadas coincidencias pide afinar');
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

console.log('\n=== 9b. LO QUE LA GENTE ESCRIBE DE VERDAD ===');
{
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(A, 'Buen día, pago del señor Diego Ruiz');
  let r = await respuestas(n);
  if (!dice(r, /¿Es la cuenta de \*Diego Ruiz\*\?/)) console.log('    recibió:', JSON.stringify(r.map((m) => m.texto.slice(0, 100))));
  es(dice(r, /¿Es la cuenta de \*Diego Ruiz\*\?/), '"pago del señor Diego Ruiz" (así avisan de verdad) encuentra a Diego y pide confirmar');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  n = enviados.length;
  await entra(A, 'pago de servicio de Fulano Perengano');
  r = await respuestas(n);
  es(!dice(r, /¿Es la cuenta de/) && !dice(r, /No encontré/), 'pero con un nombre que no está en el padrón no se mete al flujo de pagar por otro');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);

  n = enviados.length;
  await entra(A, 'Pago de Internet a nombre de Diego Ruiz, gracias');
  r = await respuestas(n);
  es(dice(r, /¿Es la cuenta de \*Diego Ruiz\*\?/), '"pago a nombre de Diego Ruiz, gracias" encuentra a Diego y pide confirmar');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  n = enviados.length;
  await entra(A, 'a nombre de gloria nunez');
  r = await respuestas(n);
  es(dice(r, /¿Es la cuenta de \*Gloria Núñez\*\?/), 'sin acentos ni mayúsculas ("gloria nunez") también encuentra a Gloria Núñez');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  n = enviados.length;
  await entra(A, 'pago a nombre de mi mamá Gloria Núñez');
  r = await respuestas(n);
  es(dice(r, /¿Es la cuenta de \*Gloria Núñez\*\?/), '"a nombre de mi mamá Gloria Núñez" ignora el parentesco y la encuentra');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);

  n = enviados.length;
  await entra(A, 'cuánto debo');
  r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de \*\$300\.00\*/) && conBotones(r).botones.length === 3, '"cuánto debo" contesta el monto y ofrece cómo pagar');

  n = enviados.length;
  await entra(A, 'oficina');
  r = await respuestas(n, 2);
  es(dice(r, /oficina/i) && dice(r, /datos de pago/i), '"oficina" da horario y datos de pago');

  // Un toque en 💳 Tarjeta desde el menú da el link directo, sin más preguntas.
  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(A, 'pago_con_tarjeta');
  r = await respuestas(n);
  es(stripe.sesiones.length === antes + 1 && dice(r, /Total: \$/), 'un toque en Tarjeta desde el menú da el link con el total, sin otra pregunta');
}

console.log('\n=== 9c. QUIEN PAGÓ POR OTRO PREGUNTA SI YA QUEDÓ ===');
{
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  const n = enviados.length;
  await entra(A, 'ya quedó registrado el pago de mi mamá?');
  const r = await respuestas(n);
  es(dice(r, /el pago que hiciste para \*Ana Pérez\* ya está registrado/), 'Andrés pagó lo de Ana Pérez y pregunta "¿ya quedó?": se le confirma ese pago, no se le pide comprobante');
  es(!dice(r, /mándame la foto/), 'y no se le pide la foto');

  // "Quiero pagar 3 meses a nombre de Ana Pérez": los meses no se pierden al buscar la cuenta.
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n2 = enviados.length;
  await entra(A, 'Quiero pagar 3 meses a nombre de Ana Pérez');
  let r2 = await respuestas(n2);
  const bot2 = conBotones(r2);
  es(bot2 && bot2.botones.length === 2, 'con "3 meses a nombre de Ana Pérez" busca la cuenta y pregunta cuál Ana');
  n2 = enviados.length;
  await toca(A, 'pago_otro_es_' + bot2.botones.findIndex((x) => x.title === 'Ana Pérez'));
  r2 = await respuestas(n2);
  es(dice(r2, /Su mensualidad es de \*\$1320\.00\* \(3 meses\)/), 'y al elegirla cotiza los 3 meses ($440 que debe + 2 meses de $440), sin que tenga que repetirlo');
  n2 = enviados.length;
  const antes2 = stripe.sesiones.length;
  await toca(A, 'pago_con_tarjeta');
  await respuestas(n2);
  const s2 = stripe.sesiones[antes2];
  es(s2 && s2.telefono === B && s2.meses === '3' && s2.mensualidad === '132000', 'el link va a la cuenta de Ana con 3 meses y $1,320');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
}

console.log('\n=== 10. UN TELÉFONO CON DOS CONTRATOS: SE PREGUNTA CUÁL, Y SE PAGA ESE ===');
{
  let n = enviados.length;
  await entra(F, 'pagar');
  await respuestas(n);
  n = enviados.length;
  await toca(F, 'pago_tarjeta');
  let r = await respuestas(n);
  const bot = conBotones(r);
  es(dice(r, /Tienes \*2 servicios\*/), 'antes de cotizar, le dice que tiene 2 servicios y pregunta cuál');
  es(dice(r, /Local, Av\. Juárez\*: 🔴 suspendido · corte \d\d\/\d\d · debe \*\$500\.00\*/) && dice(r, /Casa, Col\. Centro\*: 🟢 activo .* al corriente/), 'y en la misma pregunta ve cuál debe y cuánto, para no tener que adivinar');
  es(bot.botones.length === 2 && bot.botones.some((b) => /Local/.test(b.title)) && bot.botones.some((b) => /Casa/.test(b.title)), 'con un botón por contrato (casa y local)');
  es(bot.botones.some((b) => /🔴/.test(b.title) && /Local/.test(b.title)), 'y el suspendido marcado en rojo');
  const cual = bot.botones.findIndex((b) => /Local/.test(b.title));

  n = enviados.length;
  await toca(F, 'pago_servicio_' + cual);
  r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de \*\$500\.00\*/), 'elige el local y se cotiza la deuda del LOCAL ($500), no la de la casa');

  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(F, 'pago_con_tarjeta');
  r = await respuestas(n);
  const s = stripe.sesiones[antes];
  es(s && s.telefono === F, 'el link sale para su teléfono');
  es(dice(r, /Servicio: Plan 50 · Local/), 'y el mensaje dice qué contrato está pagando');

  const activacionesAntes = wisphub.activaciones.length;
  await avisar({ ...sesionPagada(s), data: { object: { ...sesionPagada(s).data.object, metadata: { ...sesionPagada(s).data.object.metadata, servicioId: '107' } } } });
  await respuestas(enviados.length, 2);
  es(wisphub.activaciones.length === activacionesAntes + 1 && wisphub.activaciones.at(-1) === 107, 'al confirmarse, se reactiva el LOCAL (107) y no la casa (106)');
}

console.log('\n=== 11. Y LA CLABE ES DE UN CONTRATO, NO DEL TELÉFONO ===');
{
  await entra(F, 'menú'); await respuestas(enviados.length, 1, 1500);   // olvida el contrato que eligió antes
  let n = enviados.length;
  await entra(F, 'pagar');
  await respuestas(n);
  n = enviados.length;
  await toca(F, 'pago_clabe');
  let r = await respuestas(n);
  es(dice(r, /Tienes \*2 servicios\*/), 'al pedir la transferencia con dos contratos, primero pregunta cuál');
  const cual = conBotones(r).botones.findIndex((b) => /Local/.test(b.title));
  n = enviados.length;
  await toca(F, 'pago_servicio_' + cual);
  r = await respuestas(n);
  es(dice(r, /6461801/), 'y sale la CLABE');
  es(dice(r, /Tu mensualidad: \$500\.00/), 'con la deuda del LOCAL ($500), no la de la casa');
  const cli = stripe.clientes.find((c) => c.metadata.telefono === F);
  es(cli && cli.metadata.servicioId === '107', 'el cliente de Stripe de esa CLABE lleva el contrato (107): lo que caiga ahí es del local');

  // Fermín transfiere $1,000 a la CLABE del local (que debe $500): son dos meses, y queda anotado.
  const n2 = enviados.length;
  const dep = await avisar({ type: 'customer_cash_balance_transaction.created', data: { object: { id: 'ccbt_local_2m', type: 'funded', customer: cli.id, net_amount: 100000 } } });
  const r2 = await respuestas(n2, 1, 5000);
  es(dep.st === 200, 'Stripe avisa que cayó una transferencia en la CLABE del local');
  es(r2.some((m) => m.a === F && m.tipo === 'template' && /Recibimos tu transferencia por \$1000\.00/.test(m.texto) && /Cubre 2 meses: quedas pagado hasta el \d\d\/\d\d\/\d{4}/.test(m.texto)), 'a Fermín le llega por plantilla que su transferencia cubre 2 meses y hasta cuándo');
}

console.log('\n=== 11b. SEIS MESES DE JALÓN ===');
{
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  // Como lo escriben de verdad, con signos y todo: no hay que saberse una fórmula.
  await entra(A, '¿Puedo pagar dos meses de internet?');
  let r0 = await respuestas(n);
  es(dice(r0, /\(2 meses\)/), '"¿Puedo pagar dos meses de internet?" cotiza 2 meses');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  n = enviados.length;
  await entra(A, 'cuánto por 3 meses');
  r0 = await respuestas(n);
  es(dice(r0, /\(3 meses\)/), '"cuánto por 3 meses" también cotiza');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  n = enviados.length;
  await entra(A, 'quiero pagar 6 meses');
  let r = await respuestas(n);
  es(dice(r, /Tu mensualidad es de \*\$1800\.00\* \(6 meses\)/), '"quiero pagar 6 meses" cotiza $1,800 (lo que debe + 5 meses de su plan de $300)');
  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(A, 'pago_con_tarjeta');
  r = await respuestas(n);
  const s = stripe.sesiones[antes];
  es(s && s.mensualidad === '180000', 'el link lleva los $1,800 como mensualidad (sin el cargo)');
  es(dice(r, /Mensualidad: \$1800\.00 \(6 meses\)/), 'y el mensaje lo dice claro');
  // Se confirma el pago: queda cubierto y la oficina se entera.
  const ev = sesionPagada(s); ev.data.object.metadata.meses = '6'; ev.data.object.amount_total = 180000 + 14400;
  await avisar(ev);
  await respuestas(enviados.length, 1, 3000);
  // Que quedó cubierto se comprueba abajo: aunque su corte sea mañana, no le llega aviso.
}

console.log('\n=== 11c. COBRO AUTOMÁTICO CADA MES ===');
{
  let n = enviados.length;
  await entra(H, 'automático');
  let r = await respuestas(n);
  es(dice(r, /Cobro automático cada mes/) && conBotones(r).botones.some((b) => b.id === 'auto_si'), '"automático" explica en dos líneas y pide confirmar con un botón');

  n = enviados.length;
  const antes = stripe.sesiones.length;
  await toca(H, 'auto_si');
  r = await respuestas(n);
  const s = stripe.sesiones[antes];
  es(s && s.guardarTarjeta === 'si' && s.customer && s.futuro === 'off_session', 'al aceptar, el link guarda la tarjeta para cobros futuros');
  es(dice(r, /queda guardada para los meses que vienen/), 'y se le dice que esta vez paga y de ahí en adelante es solo');

  // Paga: el webhook activa el automático.
  stripe.tarjetas[s.customer] = true;
  const ev = sesionPagada(s); ev.data.object.metadata.guardarTarjeta = 'si'; ev.data.object.customer = s.customer;
  n = enviados.length;
  await avisar(ev);
  r = await respuestas(n, 2);
  es(r.some((m) => m.a === H && /cobro automático quedó activo/.test(m.texto)), 'al confirmarse el pago, le avisa que el automático quedó activo');

  // Andrés (corte MAÑANA, pero ya pagó 6 meses) e Inés (corte MAÑANA, sin pagar) también lo activan.
  for (const tel of [A, I]) {
    n = enviados.length;
    await toca(tel, 'auto_si');
    await respuestas(n);
    const sx = stripe.sesiones.at(-1);
    stripe.tarjetas[sx.customer] = true;
    const evx = sesionPagada(sx); evx.data.object.metadata.guardarTarjeta = 'si'; evx.data.object.customer = sx.customer;
    await avisar(evx);
    await respuestas(enviados.length, 2, 2500);
  }
  // Para Inés y Hugo pasa un mes: su pago de activación ya es del mes pasado, así que este mes les toca el automático.
  for (const tel of [I, H]) await fetch(BASE + '/api/pruebas/olvidar-pagos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono: tel }) });

  // El barrido: a Hugo (corte pasado mañana) le toca AVISO; a Inés (corte mañana) COBRO; a Andrés nada, ya pagó.
  n = enviados.length;
  const cobrosAntes = stripe.cobros.length;
  const h1 = await fetch(BASE + '/api/pruebas/cobro-automatico', { method: 'POST' }).then((x) => x.json());
  r = await respuestas(n, 3);
  es(h1.avisados === 1 && r.some((m) => m.a === H && /Mañana se cobrará \$340\.00 a tu tarjeta guardada/.test(m.texto)), 'dos días antes: a Hugo le avisa que mañana se cobran $340 y cómo cancelar');
  es(h1.cobrados === 1 && stripe.cobros.length === cobrosAntes + 1, `un día antes: a Inés se le cobra lo que Wisphub dice que debe · ${JSON.stringify(h1)}`);
  es(stripe.cobros.at(-1).amount === 29000 + Math.round(29000 * 0.08 + 1200) || stripe.cobros.at(-1).periodo === MANANA, 'con el periodo como llave (no se puede cobrar dos veces el mismo mes)');
  es(r.some((m) => m.a === I && /Se cobró tu mensualidad de \*\$290\.00\*.*terminación 4242/.test(m.texto)), 'e Inés recibe el aviso de qué se cobró y a qué tarjeta');
  es(r.some((m) => m.a === A && /Este mes ya pagaste por tu cuenta/.test(m.texto)) && !stripe.cobros.some((c) => c.customer && c.periodo === MANANA && c.amount === 32850), 'a Andrés NO se le cobra: ya pagó este mes por su cuenta, y se le dice');

  // Segunda pasada el mismo día: no repite nada.
  n = enviados.length;
  const h2 = await fetch(BASE + '/api/pruebas/cobro-automatico', { method: 'POST' }).then((x) => x.json());
  await respuestas(n, 1, 1200);
  es(h2.avisados === 0 && h2.cobrados === 0 && stripe.cobros.length === cobrosAntes + 1, 'si el barrido corre otra vez el mismo día, no avisa ni cobra de nuevo');

  // Con el automático activo, PAGAR le recuerda que no tiene que hacer nada.
  n = enviados.length;
  await entra(H, 'pagar');
  r = await respuestas(n);
  es(dice(r, /Tienes \*cobro automático\*.*No tienes que hacer nada/s), 'con el automático activo, "pagar" le dice que se cobra solo y no tiene que hacer nada');

  // Cancelar es una frase, dicha como sea.
  n = enviados.length;
  await entra(H, 'Ya no quiero el cobro automático, por favor');
  r = await respuestas(n);
  es(dice(r, /quité el cobro automático/), '"ya no quiero el cobro automático" lo quita al instante');
  n = enviados.length;
  await entra(H, 'cancelar automático');
  r = await respuestas(n);
  es(dice(r, /No tienes cobro automático activo/), 'y si lo pide otra vez, le dice que ya no lo tiene');
}

console.log('\n=== 11d. PAGAR POR OTRO QUE TIENE DOS CONTRATOS ===');
{
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(A, 'a nombre de Fermín Ortiz');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  let r = await respuestas(n);
  es(dice(r, /Tiene \*2 servicios\*; al pagar te pregunto cuál/), 'al confirmar a alguien con dos contratos, no se adelanta un monto que podría ser del otro');
  n = enviados.length;
  await toca(A, 'pago_con_tarjeta');
  r = await respuestas(n);
  es(dice(r, /tiene \*2 servicios\*/) && conBotones(r).botones.length === 2, 'y al pagar pregunta cuál de los dos');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
}

console.log('\n=== 11e. EL LINK QUE VENCIÓ SIN ABRIRSE ===');
{
  const s = stripe.sesiones.find((x) => x.telefono === A && x.pagadoPor === A && x.forma === 'card');
  let n = enviados.length;
  const r0 = await avisar({ ...sesionPagada(s, { type: 'checkout.session.expired', payment_status: 'unpaid' }) });
  const r = await respuestas(n, 1);
  es(r0.d && r0.d.vencido === true, 'Stripe avisa que el link venció');
  es(r.some((m) => m.a === A && /El link de pago venció/.test(m.texto) && /escribe \*pagar\*/.test(m.texto)), 'y al cliente se le dice que no se cobró nada y cómo pedir otro');
}

console.log('\n=== 11f. LA CLABE DE LA CUENTA DE OTRO DICE DE QUIÉN ES ===');
{
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(A, 'a nombre de Diego Ruiz');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_clabe');
  const r = await respuestas(n);
  es(dice(r, /la cuenta para pagar el internet de \*Diego Ruiz\*/), 'la CLABE de otro dice de quién es la cuenta');
  es(dice(r, /se le abona a \*Diego Ruiz\*, lo mandes tú o quien sea/), 'y aclara que lo que caiga ahí es de él');
  es(!dice(r, /tu cuenta personal|Tu mensualidad/), 'sin hablarle de "tu cuenta" ni "tu mensualidad"');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
}

console.log('\n=== 12. EL AVISO DE CORTE NO LE LLEGA A QUIEN YA PAGÓ NI A QUIEN TIENE PRÓRROGA ===');
{
  const ASESOR = '529519999999';
  // El asesor le da 3 días a Diego con un solo mensaje.
  let n = enviados.length;
  await entra(ASESOR, 'PRORROGA 951 444 4444 3 se le descompuso el carro');
  let r = await respuestas(n, 2);
  es(r.some((m) => m.a === ASESOR && /Prórroga registrada para \*Diego Ruiz\*/.test(m.texto)), 'el asesor registra una prórroga con "PRORROGA <tel> 3"');
  es(r.some((m) => m.a === D && /te dimos hasta el/.test(m.texto)), 'y a Diego le llega hasta cuándo tiene');
  // Diego pregunta por su corte y vuelve a pedir tiempo: el bot le recuerda su fecha, sin abrir otro caso.
  n = enviados.length;
  await entra(D, '¿cuándo es mi corte?');
  r = await respuestas(n);
  es(dice(r, /Tienes prórroga hasta el \*\d\d\/\d\d\/\d{4}\*/), '"¿cuándo es mi corte?" le dice hasta cuándo tiene prórroga');
  n = enviados.length;
  await entra(D, 'me dan chance de pagar hasta el lunes?');
  r = await respuestas(n);
  es(dice(r, /Ya tienes una prórroga hasta el/), 'si vuelve a pedir tiempo, se le recuerda la que ya tiene');
  es(!r.some((m) => m.a === ASESOR), 'y al asesor no le llega otro caso por lo mismo');

  // Sesión de dueño para forzar el barrido de avisos de corte.
  const login = await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'prueba-local-larga' }) }).then((x) => x.json());
  es(!!login.token, 'el dueño entra al panel');
  const lista = await fetch(BASE + '/admin/api/prorrogas', { headers: { Authorization: 'Bearer ' + login.token } }).then((x) => x.json());
  es(lista.total === 1 && lista.prorrogas[0].telefono === D && lista.prorrogas[0].nombre === 'Diego Ruiz', 'y la ve en el panel, con nombre y fecha');

  n = enviados.length;
  const corrida = await fetch(BASE + '/admin/api/corte-reminders/run', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
  r = await respuestas(n, 1, 6000);
  const c = corrida.result || corrida;
  if (c.sent !== 1) console.log('    corrida:', JSON.stringify(corrida).slice(0, 300));
  es(c.sent === 1, `se manda UN aviso de corte (a Gloria, que sí debe) · enviados ${c.sent}`);
  es(!r.some((m) => m.a === A), 'Andrés NO: pagó seis meses adelantados y está cubierto');
  es(r.some((m) => m.a === G), 'Gloria recibe el aviso');
  es(!r.some((m) => m.a === B), 'Ana Pérez NO: pagó por el bot hace un rato, aunque Wisphub todavía la tenga como deudora');
  es(!r.some((m) => m.a === D), 'Diego NO: tiene prórroga');
  es(c.yaPagaron === 2 && c.conProrroga === 1, `y la corrida lo cuenta: ${c.yaPagaron} ya pagaron, ${c.conProrroga} con prórroga`);
  es(!r.some((m) => m.a === H), 'Hugo NO: su corte es pasado mañana, y además ya está al corriente');
  es(!r.some((m) => m.a === I), 'Inés NO: tiene cobro automático (y ya se le cobró hoy)');
  es(c.prorrogaVence === 0, 'y a Diego no se le avisa nada: su prórroga vence en 3 días');

  // La prórroga de Diego se acorta a 1 día desde el panel: mañana vence, hoy se le recuerda.
  const acorta = await fetch(BASE + '/admin/api/prorrogas', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono: D, dias: 1 }) }).then((x) => x.json());
  es(acorta.ok && acorta.dias === 1, 'desde el panel se le deja la prórroga en 1 día');
  n = enviados.length;
  const corrida2 = await fetch(BASE + '/admin/api/corte-reminders/run', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
  r = await respuestas(n, 1, 6000);
  const c2 = corrida2.result || corrida2;
  es(c2.sent === 0 && c2.yaEnviados === 1, 'en la segunda corrida a Gloria no se le repite el aviso');
  es(c2.prorrogaVence === 1 && r.some((m) => m.a === D && m.tipo === 'template' && /mañana .* vence la prórroga/.test(m.texto)), 'a Diego le llega por plantilla que mañana vence su prórroga, con cómo pagar');
  es(!r.some((m) => m.a !== D), 'y a nadie más');
  n = enviados.length;
  const corrida3 = await fetch(BASE + '/admin/api/corte-reminders/run', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
  await respuestas(n, 1, 1500);
  es((corrida3.result || corrida3).prorrogaVence === 0 && !enviados.slice(n).some((m) => m.a === D), 'si la corrida se repite, el aviso de la prórroga no se duplica');
  // A Inés se le rechaza la tarjeta del automático: entonces el aviso de corte SÍ le toca, con la razón.
  await fetch(BASE + '/api/pruebas/olvidar-pagos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono: I }) });
  await fetch(BASE + '/api/pruebas/auto-estado', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono: I, estado: 'rechazado' }) });
  PADRON.find((x) => x.id_servicio === 110).saldo = '290.00';   // Wisphub la tiene como deudora: el cobro no entró
  n = enviados.length;
  const corrida4 = await fetch(BASE + '/admin/api/corte-reminders/run', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
  r = await respuestas(n, 1, 6000);
  const c4 = corrida4.result || corrida4;
  es(c4.sent === 1 && r.some((m) => m.a === I && m.tipo === 'template' && /cobro automático de este mes no pasó: la tarjeta fue rechazada/.test(m.texto)), 'si el automático fue rechazado, a Inés sí le llega el aviso de corte y dice por qué');
  es(c4.conAutomatico === 0, 'y ya no cuenta como "cubierta por el automático"');
  n = enviados.length;
  await entra(I, 'pagar');
  r = await respuestas(n);
  es(dice(r, /cobro automático\* no pasó: la tarjeta fue rechazada/) && !dice(r, /No tienes que hacer nada/), 'y si Inés escribe "pagar", no se le dice "no tienes que hacer nada": se le dice que el automático no pasó y que pague de otra forma');
  const lista2 = await fetch(BASE + '/admin/api/prorrogas', { headers: { Authorization: 'Bearer ' + login.token } }).then((x) => x.json());
  const pD = (lista2.prorrogas || []).find((p) => p.telefono === D) || {};
  es(pD.restan === 1 && pD.avisado === true && pD.yaPago === false, `el panel lo dice de un vistazo: vence mañana, ya avisado, no ha pagado (${pD.restan}/${pD.avisado}/${pD.yaPago})`);
}

console.log('\n=== 13. LA FICHA DEL CLIENTE EN EL PANEL LO DICE DE UN VISTAZO ===');
{
  const login = await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'prueba-local-larga' }) }).then((x) => x.json());
  const H = { Authorization: 'Bearer ' + login.token };
  const buscar = async (q) => (await fetch(BASE + '/admin/api/client-lookup?q=' + encodeURIComponent(q), { headers: H }).then((x) => x.json()));
  const a = await buscar(A); const fa = (a.results || a.clients || a.clientes || [a])[0] || a;
  es(!!fa.ultimoPagoEnLinea, 'Andrés: se ve que pagó por el bot');

  es(!!fa.adelantadoHasta, 'y hasta cuándo está pagado por adelantado');
  es(fa.cobroAutomatico === true, 'y que tiene el cobro automático activo');
  const d = await buscar(D); const fd = (d.results || d.clients || d.clientes || [d])[0] || d;
  es(fd.prorroga && /carro/.test(fd.prorroga.motivo), 'Diego: se ve su prórroga con el motivo');
  const g = await buscar(G); const fg = (g.results || g.clients || g.clientes || [g])[0] || g;
  es(!fg.ultimoPagoEnLinea && !fg.prorroga && !fg.adelantadoHasta && !fg.cobroAutomatico, 'Gloria: nada de eso, porque no ha pasado nada con ella');
  const i = await buscar(I); const fi = (i.results || i.clients || i.clientes || [i])[0] || i;
  es(fi.cobroAutomatico && fi.autoEstado && fi.autoEstado.estado === 'rechazado' && /rechazada/.test(fi.autoEstado.texto), 'Inés: se ve que su automático de este mes fue rechazado, para no decirle "no te preocupes"');
}

console.log('\n=== 14. SI EL SERVIDOR SE REINICIA A MEDIA CONVERSACIÓN, NO SE PIERDE A QUIÉN LE PAGA ===');
{
  // A dice que va a pagar la de Ana Pérez y se queda a punto de elegir cómo.
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(A, 'a nombre de Ana Pérez');
  await respuestas(n);
  n = enviados.length;
  await toca(A, 'pago_otro_es_0');
  await respuestas(n);
  // Se espera a que se guarde el estado y se reinicia el servidor.
  await new Promise((r) => setTimeout(r, 2500));
  srv.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  const srv2 = spawn('node', ['index.js'], { env: ENV_SERVIDOR, stdio: ['ignore', 'pipe', 'pipe'] });
  srv2.stdout.on('data', (d) => log.push(String(d))); srv2.stderr.on('data', (d) => log.push(String(d)));
  let vivo2 = false;
  for (let i = 0; i < 60 && !vivo2; i++) { try { await fetch(BASE + '/'); vivo2 = true; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  es(vivo2, 'el servidor volvió a levantar');
  await new Promise((r) => setTimeout(r, 1200));
  n = enviados.length;
  await toca(A, 'pago_tarjeta');
  const r = await respuestas(n);
  es(dice(r, /La mensualidad de \*Ana Pérez\* es de/), 'después del reinicio, sigue cotizando la cuenta de Ana Pérez, no la suya');
  SEGUNDO = srv2;   // sigue vivo para las secciones que faltan
}

console.log('\n=== 15. TRES DÍAS DESPUÉS DE UNA FALLA, EL BOT PREGUNTA SI YA QUEDÓ ===');
{
  // Gloria reporta una falla con todo (síntoma, nombre, ubicación) hasta que sale el folio.
  await entra(G, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(G, 'no tengo internet desde ayer, se me va la señal');
  let r = await respuestas(n, 1, 3000);
  for (const paso of ['Gloria Núñez', 'Calle Hidalgo 12, centro', 'sí']) {
    if ((await respuestas(enviados.length, 0, 300)) && enviados.slice(n).some((m) => /SOP-/.test(m.texto))) break;
    n = enviados.length; await entra(G, paso); r = await respuestas(n, 1, 3000);
  }
  const folio = (enviados.map((m) => m.texto).join(' ').match(/SOP-[A-Z0-9]+/) || [])[0];
  es(!!folio, `el reporte quedó con folio (${folio || 'sin folio'})`);
  // Pasan tres días.
  n = enviados.length;
  const h = await fetch(BASE + '/api/pruebas/ya-quedo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dias":4}' }).then((x) => x.json());
  r = await respuestas(n, 1);
  const pregunta = r.find((m) => m.a === G && /¿Ya quedó tu servicio\?/.test(m.texto));
  es(h.preguntados >= 1 && !!pregunta, 'a los tres días le pregunta a Gloria si ya quedó');
  es(pregunta && pregunta.tipo === 'template', 'y va por la plantilla aprobada: fuera de las 24 h el texto libre no llega');
  n = enviados.length;
  await entra(G, 'sí');
  r = await respuestas(n, 1);
  es(dice(r, /Cierro tu reporte/), 'contestar "sí" cierra el reporte solo');
  const login = await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'prueba-local-larga' }) }).then((x) => x.json());
  const tk = await fetch(BASE + '/admin/api/tickets', { headers: { Authorization: 'Bearer ' + login.token } }).then((x) => x.json());
  const mio = (tk.tickets || []).find((t) => t.folio === folio);
  es(mio && mio.estado === 'resuelto' && mio.cerradoPor === 'cliente', 'y en el panel aparece resuelto, cerrado por el cliente');
  const h2 = await fetch(BASE + '/api/pruebas/ya-quedo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dias":4}' }).then((x) => x.json());
  es(h2.preguntados === 0, 'y no se vuelve a preguntar');
}

console.log('\n=== 16. "¿CUÁNDO ES MI CORTE?" ===');
{
  await entra(G, 'menú'); await respuestas(enviados.length, 1, 1500);
  let n = enviados.length;
  await entra(G, 'cuándo es mi fecha de corte?');
  let r = await respuestas(n);
  es(dice(r, /suspendido|fecha de corte es el \*\d\d\/\d\d\/\d{4}\*/), 'contesta con su estado o su fecha de corte, con el dato de Wisphub');
  es(dice(r, /Tienes pendiente \*\$320\.00\*/), 'y cuánto debe');
  n = enviados.length;
  await entra(C, 'que dia me toca pagar');
  r = await respuestas(n);
  es(dice(r, /al corriente|fecha de corte/), 'a quien está al corriente se lo dice');
  n = enviados.length;
  await entra(B, 'cuándo es mi corte');
  r = await respuestas(n);
  es(dice(r, /Ya tenemos tu pago de este mes/) && !dice(r, /Tienes pendiente/), 'a Ana, que pagó por el bot, no se le dice que debe: "ya tenemos tu pago"');
  n = enviados.length;
  await entra(B, 'cuánto debo');
  r = await respuestas(n);
  es(dice(r, /Ya tenemos tu pago de este mes/) && dice(r, /No tienes que pagar nada ahora/), 'y "cuánto debo" le avisa antes de que pague dos veces');
  await entra(A, 'menú'); await respuestas(enviados.length, 1, 1500);   // cierra su pago por Ana de la sección 14
  n = enviados.length;
  await entra(A, 'cuánto debo');
  r = await respuestas(n);
  es(dice(r, /Ya estás pagado hasta el \*\d\d\/\d\d\/\d{4}\*/), 'Andrés, que adelantó 6 meses, ve hasta cuándo está pagado');
  n = enviados.length;
  await entra(F, 'cuando me cortan');
  r = await respuestas(n);
  es(dice(r, /Tienes \*2 servicios\*/) && dice(r, /🔴 suspendido/) && dice(r, /🟢 activo/), 'con dos contratos, dice cómo va cada uno');
  es(dice(r, /Local, Av\. Juárez\*: 🔴 suspendido · corte \d\d\/\d\d · debe \*\$500\.00\*/), 'y de cada uno su fecha de corte y lo que debe (el local: $500)');
  es(dice(r, /Casa, Col\. Centro\*: 🟢 activo · corte \d\d\/\d\d · al corriente/), 'la casa: activa, con su fecha, al corriente');
}

console.log('\n=== 17. "YA PAGUÉ" SIN COMPROBANTE ===');
{
  let n = enviados.length;
  await entra(G, 'ya deposité los 320');
  let r = await respuestas(n);
  es(dice(r, /mándame la foto o el PDF de tu comprobante/), 'si el bot no ha visto el pago, pide el comprobante en vez de dejarlo esperando');
  n = enviados.length;
  await entra(B, 'ya pagué');
  r = await respuestas(n);
  es(dice(r, /tu pago ya está registrado/), 'si el pago ya entró por el bot, se lo confirma y no le pide nada');
  n = enviados.length;
  await entra(B, 'Solo para saber si fue registrado ya el pago del Internet');
  r = await respuestas(n);
  es(dice(r, /tu pago ya está registrado/), '"¿ya quedó registrado mi pago?" también se contesta');
  n = enviados.length;
  await entra(D, 'Sea depositado 350');
  r = await respuestas(n);
  es(dice(r, /comprobante|ya está registrado|revisando/), '"Sea depositado 350" (frase real) también se entiende como aviso de pago');
}

console.log('\n=== 18. PEDIR LOS DATOS DE PAGO COMO LO PIDE LA GENTE ===');
{
  let n = enviados.length;
  await entra(A, 'Proporcionarme los números de cuenta para depositar');
  let r = await respuestas(n);
  es(conBotones(r).botones.some((b) => b.id === 'pago_clabe'), '"los números de cuenta para depositar" abre el menú de pago (con la transferencia primero)');
  n = enviados.length;
  await entra(D, 'Para pagar en transferencia?');
  r = await respuestas(n);
  es(conBotones(r).botones.some((b) => b.id === 'pago_datos'), 'fuera del piloto, "para pagar en transferencia?" da los datos de pago de siempre');
}

console.log('\n=== 19. CUANDO LA OFICINA DA POR BUENO UN COMPROBANTE, EL CLIENTE LO SABE ===');
{
  // Gloria (suspendida) manda su comprobante como PDF y dice a nombre de quién.
  let n = enviados.length;
  await fetch(BASE + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '521' + G.slice(2), type: 'document', document: { id: 'doc1', filename: 'pago.pdf', mime_type: 'application/pdf' } }], contacts: [{ profile: { name: 'Gloria' } }] } }] }] }) });
  await respuestas(n, 1, 4000);
  n = enviados.length;
  await entra(G, 'Gloria Núñez');
  await respuestas(n, 1, 4000);
  // La oficina lo da por bueno.
  n = enviados.length;
  await entra('529519999999', 'RECIBIDO 951 777 7777');
  const r = await respuestas(n, 2);
  const aG = r.find((m) => m.a === G);
  es(!!aG && /Tu pago quedó registrado/.test(aG.texto), 'a Gloria le llega "tu pago quedó registrado" (no un "recibido" genérico)');
  es(!!aG && /se reactiva en unos minutos/.test(aG.texto), 'y como estaba suspendida, le dice que se reactiva');
  es(!!aG && aG.tipo === 'template', 'por plantilla, porque el comprobante pudo ser de hace días');

  // Ahora Andrés manda el comprobante de la cuenta de Diego: al dar por bueno, Diego también se entera.
  n = enviados.length;
  await fetch(BASE + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '521' + A.slice(2), type: 'document', document: { id: 'doc2', filename: 'pago-diego.pdf', mime_type: 'application/pdf' } }], contacts: [{ profile: { name: 'Andrés' } }] } }] }] }) });
  await respuestas(n, 1, 4000);
  n = enviados.length;
  await entra(A, 'Diego Ruiz');
  await respuestas(n, 1, 4000);
  n = enviados.length;
  await entra('529519999999', 'RECIBIDO 951 111 1111');
  const r2 = await respuestas(n, 3);
  es(r2.some((m) => m.a === D && /lo mandó otra persona por ti/.test(m.texto)), 'Diego (el titular) se entera de que su pago quedó registrado aunque el comprobante lo mandó Andrés');
  es(r2.some((m) => m.a === '529519999999' && /y al titular/.test(m.texto)), 'y al asesor se le dice que también se le avisó al titular');
}

console.log('\n=== 20. DESDE EL PANEL: COMPROBANTES POR REVISAR Y "PAGO RECIBIDO" ===');
{
  // Hugo manda un comprobante; la oficina lo ve en el panel y lo da por bueno desde ahí.
  let n = enviados.length;
  await fetch(BASE + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '521' + H.slice(2), type: 'document', document: { id: 'doc3', filename: 'pago-hugo.pdf', mime_type: 'application/pdf' } }], contacts: [{ profile: { name: 'Hugo' } }] } }] }] }) });
  await respuestas(n, 1, 4000);
  n = enviados.length; await entra(H, 'Hugo Sáenz'); await respuestas(n, 1, 4000);
  const login = await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'prueba-local-larga' }) }).then((x) => x.json());
  const H_ = { Authorization: 'Bearer ' + login.token };
  const lista = await fetch(BASE + '/admin/api/comprobantes', { headers: H_ }).then((x) => x.json());
  const mio = (lista.comprobantes || []).find((c) => c.telefono === H);
  es(!!mio && /Coincide: Hugo Sáenz/.test(mio.resumen), 'el panel lista el comprobante de Hugo con la coincidencia del padrón');
  n = enviados.length;
  const r = await fetch(BASE + '/admin/api/comprobantes/' + encodeURIComponent(mio.id) + '/recibido', { method: 'POST', headers: H_ }).then((x) => x.json());
  const msgs = await respuestas(n, 1);
  es(r.ok && r.marcados >= 1, 'se da por bueno desde el panel');
  es(msgs.some((m) => m.a === H && /Tu pago quedó registrado/.test(m.texto)), 'y Hugo recibe "tu pago quedó registrado"');
  const despues = await fetch(BASE + '/admin/api/comprobantes', { headers: H_ }).then((x) => x.json());
  es(!(despues.comprobantes || []).some((c) => c.telefono === H), 'y desaparece de la lista por revisar');
}

console.log(`\n${ok} bien, ${mal} mal`);
if (mal) { console.log('\n--- registro del servidor (últimas líneas) ---\n' + log.join('').split('\n').slice(-40).join('\n')); }
salir(mal ? 1 : 0);
