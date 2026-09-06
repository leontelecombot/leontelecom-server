/**
 * DEMO LOCAL del cobro en línea — no toca producción, no manda WhatsApp real,
 * no habla con el Stripe de verdad.
 *
 * Levanta un Stripe de mentiras y una página donde se ve el flujo completo:
 * el cliente pide pagar, se le genera su link con el desglose, "paga", y el
 * webhook confirma el pago solo, sin que nadie revise un comprobante.
 *
 *   node demo-cobro-leon.mjs   →   http://127.0.0.1:4310
 */
import { createServer } from 'node:http';
import crypto from 'node:crypto';

const PUERTO = 4310;
const PUERTO_STRIPE = 4311;
const SECRETO = 'whsec_demo_local';

process.env.STRIPE_API_BASE = `http://127.0.0.1:${PUERTO_STRIPE}/v1/`;
process.env.STRIPE_SECRET_KEY = 'sk_test_de_mentiras';
process.env.LEON_STRIPE_CUENTA_CONECTADA = 'acct_leon_demo';

const stripeLeon = (await import('./utils/stripeLeon.js')).default;

// Cliente de ejemplo, con los datos que hoy ya vienen de WispHub.
const CLIENTE = { telefono: '529516549145', name: 'Cliente de Prueba', saldo: 440, plan: 'PLAN FIBRA MEDIO 150MB' };
let ultimaSesion = null;
const bitacora = [];
const anotar = (quien, texto) => { bitacora.push({ quien, texto, at: new Date().toLocaleTimeString('es-MX') }); };

// ─── Stripe de mentiras ──────────────────────────────────────────────────────
createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const p = new URLSearchParams(cuerpo);
    ultimaSesion = {
      id: 'cs_demo_' + crypto.randomBytes(4).toString('hex'),
      total: (Number(p.get('line_items[0][price_data][unit_amount]')) + Number(p.get('line_items[1][price_data][unit_amount]'))) / 100,
      aLeonTelecom: (Number(p.get('line_items[0][price_data][unit_amount]')) + Number(p.get('line_items[1][price_data][unit_amount]')) - Number(p.get('payment_intent_data[application_fee_amount]'))) / 100,
      aforo: Number(p.get('payment_intent_data[application_fee_amount]')) / 100,
      telefono: p.get('metadata[telefono]'),
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: ultimaSesion.id, url: `http://127.0.0.1:${PUERTO}/stripe-de-mentiras` }));
  });
}).listen(PUERTO_STRIPE);

// ─── La misma lógica del webhook de index.js, para poder verla aquí ──────────
function procesarWebhook(cuerpoCrudo, firma) {
  if (!stripeLeon.verificarFirma(cuerpoCrudo, firma, SECRETO)) return { ok: false, motivo: 'firma inválida' };
  const evento = JSON.parse(cuerpoCrudo);
  if (evento.account) return { ok: false, motivo: 'aviso de otra cuenta conectada, ignorado' };
  const o = evento.data.object;
  if (evento.type === 'checkout.session.completed' && o.payment_status === 'paid'
      && o.metadata && o.metadata.tipo === 'mensualidad-leontelecom') {
    const tel = String(o.metadata.telefono || '').replace(/\D/g, '');
    anotar('sistema', `markCases(${tel}, 'recibido', 'stripe-auto') → el caso se cierra solo, sin asesor`);
    anotar('bot → cliente', '✅ Recibimos tu pago — quedó confirmado automáticamente, no necesitas mandar comprobante. ¡Gracias! 🙌');
    return { ok: true };
  }
  return { ok: false, motivo: 'evento que no nos toca' };
}

const pagina = () => `<!doctype html><meta charset="utf-8"><title>Demo cobro León Telecom</title>
<style>
body{font-family:system-ui;background:#faf7f2;margin:0;padding:32px;color:#1a1a1a}
.caja{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5ded4;border-radius:14px;padding:26px;margin-bottom:18px}
h1{font-size:1.3rem;margin:0 0 4px} .sub{color:#7a7268;font-size:.9rem;margin:0 0 20px}
button{background:#6b3fa0;color:#fff;border:0;padding:12px 20px;border-radius:9px;font-size:.95rem;cursor:pointer;font-weight:600}
button.gris{background:#e9e3da;color:#3a3a3a}
.chat{background:#efe7dd;border-radius:12px;padding:14px;min-height:60px}
.msg{background:#fff;border-radius:9px;padding:9px 12px;margin-bottom:8px;font-size:.9rem;white-space:pre-wrap}
.msg b{display:block;font-size:.72rem;color:#7a7268;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.msg.sis{background:#fff6d9}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:.92rem}
td{padding:7px 0;border-bottom:1px dashed #e5ded4} td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.tot{font-weight:700}
</style>
<div class="caja">
  <h1>Demo local — cobro en línea de León Telecom</h1>
  <p class="sub">Stripe de mentiras · no manda WhatsApp real · no toca producción</p>
  <p style="font-size:.92rem">Cliente: <b>${CLIENTE.name}</b> · ${CLIENTE.plan} · adeudo <b>$${CLIENTE.saldo.toFixed(2)}</b></p>
  <form method="POST" action="/pagar" style="display:inline"><button>1 · El cliente escribe "PAGAR"</button></form>
  ${ultimaSesion ? `<form method="POST" action="/confirmar" style="display:inline;margin-left:8px"><button>2 · El cliente paga (Stripe avisa)</button></form>` : ''}
  <form method="POST" action="/reiniciar" style="display:inline;margin-left:8px"><button class="gris">Reiniciar</button></form>
</div>
${ultimaSesion ? `<div class="caja"><h1 style="font-size:1.05rem">Cómo se reparte el dinero</h1>
<table>
<tr><td>Mensualidad (la ve el cliente, no cambia)</td><td>$${(ultimaSesion.total - ultimaSesion.aforo).toFixed(2)}</td></tr>
<tr><td>Cargo por pagar en línea (lo paga el cliente)</td><td>$${ultimaSesion.aforo.toFixed(2)}</td></tr>
<tr class="tot"><td>Total que cobra Stripe</td><td>$${ultimaSesion.total.toFixed(2)}</td></tr>
<tr><td>→ A León Telecom (íntegro, sin recortes)</td><td>$${ultimaSesion.aLeonTelecom.toFixed(2)}</td></tr>
<tr><td>→ A Aforo (de ahí sale el costo real de Stripe)</td><td>$${ultimaSesion.aforo.toFixed(2)}</td></tr>
</table></div>` : ''}
<div class="caja"><h1 style="font-size:1.05rem">Lo que pasa en el chat</h1>
<div class="chat">${bitacora.length ? bitacora.map((b) => `<div class="msg ${b.quien === 'sistema' ? 'sis' : ''}"><b>${b.quien} · ${b.at}</b>${b.texto}</div>`).join('') : '<p style="color:#7a7268;font-size:.9rem;margin:0">Todavía nada. Dale al botón 1.</p>'}</div></div>`;


// ─── Cómo se vería la pantalla de pago de Stripe ─────────────────────────────
const pantallaCheckout = () => {
  const mensualidad = ultimaSesion ? (ultimaSesion.total - ultimaSesion.aforo) : CLIENTE.saldo;
  const cargo = ultimaSesion ? ultimaSesion.aforo : 0;
  const total = ultimaSesion ? ultimaSesion.total : CLIENTE.saldo;
  const p = (n) => '$' + n.toFixed(2);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagar · León Telecom</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f9fc;color:#1a1f36}
.aviso{background:#fff6d9;border-bottom:1px solid #f0e0a8;padding:9px 16px;font-size:12.5px;text-align:center;color:#6b5a1a}
.wrap{display:flex;flex-wrap:wrap;min-height:calc(100vh - 36px)}
.izq{flex:1 1 380px;background:#fff;padding:34px 28px;border-right:1px solid #e6ebf1}
.der{flex:1 1 380px;padding:34px 28px}
.marca{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo{width:34px;height:34px;border-radius:8px;background:#6b3fa0;color:#fff;display:grid;place-items:center;font-weight:700;font-size:15px}
.marca span{font-size:15px;font-weight:600;color:#3c4257}
.monto{font-size:34px;font-weight:700;letter-spacing:-.5px;margin:0 0 4px}
.monto small{font-size:15px;color:#697386;font-weight:500;margin-left:4px}
.rengs{margin-top:24px;border-top:1px solid #e6ebf1}
.r{display:flex;justify-content:space-between;padding:13px 0;border-bottom:1px solid #e6ebf1;font-size:14px}
.r .d{color:#697386;font-size:12.5px;margin-top:2px}
.r .v{font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:14px}
.tot{display:flex;justify-content:space-between;padding:15px 0;font-weight:700;font-size:15px}
h2{font-size:15px;font-weight:600;margin:0 0 14px;color:#3c4257}
.btns{display:grid;gap:9px;margin-bottom:20px}
.bp{border:1px solid #e6ebf1;background:#fff;border-radius:8px;padding:13px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.bp.apple{background:#000;color:#fff;border-color:#000}.bp.link{background:#00d66f;color:#0a2540;border-color:#00d66f}
.sep{display:flex;align-items:center;gap:12px;color:#8792a2;font-size:12px;margin:18px 0}
.sep::before,.sep::after{content:"";flex:1;height:1px;background:#e6ebf1}
.campo{margin-bottom:13px}.campo label{display:block;font-size:12.5px;color:#3c4257;margin-bottom:5px;font-weight:500}
.inp{border:1px solid #e6ebf1;border-radius:7px;padding:11px;font-size:14px;color:#8792a2;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.fila{display:flex;gap:10px}.fila .campo{flex:1}
.otro{border:1px solid #e6ebf1;border-radius:8px;padding:12px 13px;display:flex;align-items:center;gap:11px;font-size:13.5px;background:#fff;margin-bottom:9px}
.ico{width:32px;height:22px;border-radius:4px;display:grid;place-items:center;font-size:9.5px;font-weight:800;color:#fff;flex:none}
.pagar{width:100%;background:#6b3fa0;color:#fff;border:0;border-radius:8px;padding:14px;font-size:15px;font-weight:600;margin-top:18px;cursor:pointer}
.pie{text-align:center;font-size:11.5px;color:#8792a2;margin-top:14px}
.nota{background:#eef4ff;border:1px solid #cddffb;border-radius:9px;padding:13px;font-size:13px;color:#25396f;margin-top:20px;line-height:1.5}
a.volver{display:inline-block;margin-top:18px;font-size:13px;color:#6b3fa0}
</style>
<div class="aviso">Maqueta de la pantalla de Stripe · así la verían los clientes de León Telecom · no cobra nada</div>
<div class="wrap">
 <div class="izq">
  <div class="marca"><div class="logo">LT</div><span>León Telecom</span></div>
  <p style="font-size:14px;color:#697386;margin:0 0 6px">Pagar mensualidad de internet</p>
  <p class="monto">${p(total)}<small>MXN</small></p>
  <div class="rengs">
   <div class="r"><div><div>Mensualidad de internet</div><div class="d">${CLIENTE.plan} · ${CLIENTE.name}</div></div><div class="v">${p(mensualidad)}</div></div>
   <div class="r"><div><div>Cargo por pagar en línea</div><div class="d">Solo si pagas por aquí. Depositar sigue siendo gratis.</div></div><div class="v">${p(cargo)}</div></div>
   <div class="tot"><span>Total a pagar hoy</span><span>${p(total)}</span></div>
  </div>
  <div class="nota"><b>El reparto:</b><br>León Telecom recibe sus <b>${p(mensualidad)} completos</b>, sin recortes — lo mismo que cobra hoy.<br>El cargo de ${p(cargo)} cubre el costo real de Stripe y la comisión de la pasarela.</div>
  <a class="volver" href="/">← Volver al demo</a>
 </div>
 <div class="der">
  <h2>Pagar con</h2>
  <div class="btns"><div class="bp apple">&#63743; Pay</div><div class="bp link">Pagar con Link</div></div>
  <div class="sep">o con tarjeta</div>
  <div class="campo"><label>Información de la tarjeta</label><div class="inp">1234 1234 1234 1234 &nbsp; 💳</div></div>
  <div class="fila"><div class="campo"><div class="inp">MM / AA</div></div><div class="campo"><div class="inp">CVC</div></div></div>
  <div class="campo"><label>Nombre en la tarjeta</label><div class="inp">&nbsp;</div></div>
  <div class="sep">otras formas de pago</div>
  <div class="otro"><div class="ico" style="background:#e6203c">OXXO</div><div><b>OXXO</b> · efectivo en cualquier tienda<br><span style="color:#8792a2;font-size:12px">Se genera un voucher con referencia</span></div></div>
  <div class="otro"><div class="ico" style="background:#0a7d34">SPEI</div><div><b>Transferencia SPEI</b> · desde tu banco<br><span style="color:#8792a2;font-size:12px">CLABE única; al llegar el dinero se confirma solo</span></div></div>
  <button class="pagar" onclick="location.href='/'">Pagar ${p(total)}</button>
  <p class="pie">Pago procesado de forma segura por Stripe</p>
 </div>
</div>`;
};

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/pagar') {
    anotar('cliente → bot', 'PAGAR');
    const pago = await stripeLeon.generarLinkPago({ telefono: CLIENTE.telefono, monto: CLIENTE.saldo, nombre: CLIENTE.name, urlBase: `http://127.0.0.1:${PUERTO}` });
    anotar('bot → cliente', `💳 Aquí puedes pagar en línea, sin salir de tu casa:\n\n• Mensualidad: $${pago.mensualidad.toFixed(2)}\n• Cargo por pagar en línea: $${pago.cargo.toFixed(2)}\n• Total: $${pago.total.toFixed(2)}\n\n${pago.url}\n\nPuedes pagar con tarjeta, OXXO o transferencia. En cuanto se confirme te avisamos por aquí — no hace falta que mandes comprobante.`);
  } else if (req.method === 'POST' && req.url === '/confirmar') {
    const cuerpo = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: ultimaSesion.id, payment_status: 'paid', metadata: { telefono: CLIENTE.telefono, tipo: 'mensualidad-leontelecom' } } },
    });
    const t = Math.floor(Date.now() / 1000);
    const firma = `t=${t},v1=${crypto.createHmac('sha256', SECRETO).update(`${t}.${cuerpo}`).digest('hex')}`;
    anotar('stripe → servidor', 'POST /webhook/stripe (firmado)');
    const r = procesarWebhook(cuerpo, firma);
    if (!r.ok) anotar('sistema', '⚠️ ' + r.motivo);
  } else if (req.method === 'POST' && req.url === '/reiniciar') {
    bitacora.length = 0; ultimaSesion = null;
  } else if (req.url === '/stripe-de-mentiras') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(pantallaCheckout());
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('location', '/');
  res.statusCode = req.method === 'POST' ? 303 : 200;
  res.end(req.method === 'POST' ? '' : pagina());
}).listen(PUERTO, () => console.log(`\n  Demo listo → http://127.0.0.1:${PUERTO}\n`));
