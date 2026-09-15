/**
 * ¿ESTÁ LISTO PARA ENCENDER? — solo lectura, no mueve un peso ni escribe nada.
 *
 * `revisar-stripe.mjs` mira la cuenta de Stripe. Esto mira TODO lo demás y lo
 * junta en una sola respuesta: las variables, Wisphub, el webhook, y si el
 * servidor desplegado ya trae el código del cobro.
 *
 * Existe porque "encender" depende de seis cosas que viven en lugares
 * distintos, y olvidar una no da error en ningún lado: simplemente el dinero
 * entra y nadie se entera, o el cliente paga y sigue cortado.
 *
 *   node revisar-listo.mjs
 *
 * Las llaves salen del entorno o de los archivos .stripe-key / .wisphub-key,
 * nunca del comando: escribirlas ahí las deja en el historial de la terminal.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const leerLlave = (archivo, variable) => {
  const v = (process.env[variable] || '').trim();
  if (v) return v;
  const f = join(AQUI, archivo);
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#')) || '';
};

const STRIPE = leerLlave('.stripe-key', 'STRIPE_SECRET_KEY');
const WISPHUB = leerLlave('.wisphub-key', 'WISPHUB_API_KEY');
const URL_SERVIDOR = (process.env.SERVER_BASE_URL || 'https://leontelecom-server.onrender.com').replace(/\/$/, '');

let bien = 0, falta = 0, ojo = 0;
const OK = (m) => { console.log('  ✅ ' + m); bien++; };
const NO = (m) => { console.log('  ❌ ' + m); falta++; };
const OJO = (m) => { console.log('  ⚠️  ' + m); ojo++; };

console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║  LEÓN TELECOM · ¿listo para encender el cobro en línea?       ║');
console.log('╚═══════════════════════════════════════════════════════════════╝');

// ── 1. El código, en el servidor de verdad ──────────────────────────────────
console.log('\n── EL SERVIDOR DESPLEGADO ──────────────────────────────────────');
try {
  const r = await fetch(URL_SERVIDOR + '/webhook/stripe', { method: 'POST', signal: AbortSignal.timeout(25000) });
  if (r.status === 404) {
    NO('La ruta /webhook/stripe NO existe en el servidor: falta desplegar el cobro');
    console.log('       Los pagos entrarían a Stripe y el bot no se enteraría de ninguno.');
  } else if (r.status === 500) {
    OK('La ruta existe');
    OJO('Contesta 500: probablemente falta STRIPE_WEBHOOK_SECRET_LEON en Render');
  } else if (r.status === 400) {
    OK('La ruta existe y ya está rechazando lo que no viene firmado');
  } else {
    OJO(`La ruta contestó ${r.status}, que no es de los esperados`);
  }
} catch (e) {
  NO(`No se pudo hablar con ${URL_SERVIDOR}: ${e.message}`);
}

// ── 2. Wisphub ──────────────────────────────────────────────────────────────
console.log('\n── WISPHUB (para reactivar el servicio) ────────────────────────');
if (!WISPHUB) {
  OJO('Sin llave de Wisphub aquí: no se puede revisar (ponla en .wisphub-key)');
} else {
  try {
    const r = await fetch('https://api.wisphub.net/api/clientes/?format=json&limit=1', {
      headers: { Authorization: 'Api-Key ' + WISPHUB }, signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) { NO(`Wisphub rechazó la llave (${r.status})`); }
    else {
      const d = await r.json();
      OK(`Conectado · ${d.count} clientes`);

      // El endpoint de activar tiene que existir, o la reactivación no ocurre.
      const a = await fetch('https://api.wisphub.net/api/clientes/activar/?format=json', {
        method: 'POST',
        headers: { Authorization: 'Api-Key ' + WISPHUB, 'Content-Type': 'application/json' },
        body: JSON.stringify({ servicios: [999999999] }),   // id que no existe: no toca a nadie
        signal: AbortSignal.timeout(25000),
      });
      const ad = await a.json().catch(() => ({}));
      (a.ok && ad.task_id)
        ? OK('El endpoint de reactivación responde')
        : NO('El endpoint de reactivación NO responde como se espera');
      (ad.warnings || []).length
        ? OK('Y reporta los servicios que no encuentra (no falla en silencio)')
        : OJO('No reportó el servicio inexistente: revisar antes de confiar en él');
    }
  } catch (e) { NO(`No se pudo hablar con Wisphub: ${e.message}`); }
}

// ── 3. Stripe ───────────────────────────────────────────────────────────────
console.log('\n── STRIPE ──────────────────────────────────────────────────────');
if (!STRIPE) {
  OJO('Sin llave de Stripe aquí: corre `node revisar-stripe.mjs` aparte');
} else {
  const modo = STRIPE.startsWith('sk_live_') ? 'REAL' : 'PRUEBA';
  console.log(`  (modo ${modo})`);
  const sp = async (ruta) => {
    const r = await fetch('https://api.stripe.com/v1/' + ruta, {
      headers: { Authorization: 'Bearer ' + STRIPE }, signal: AbortSignal.timeout(25000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || r.status);
    return d;
  };
  try {
    const cuenta = await sp('account');
    cuenta.charges_enabled ? OK('La cuenta puede cobrar') : NO('La cuenta NO puede cobrar todavía');

    const pm = await sp('payment_method_configurations?limit=1').catch(() => null);
    const cfg = pm && (pm.data || [])[0];
    if (cfg) {
      const on = (k) => cfg[k] && cfg[k].available && cfg[k].display_preference?.value !== 'off';
      on('customer_balance')
        ? OK('Transferencias bancarias activas (las que generan la CLABE)')
        : NO('Transferencias bancarias APAGADAS · sin esto no hay CLABE fija');
      on('card') ? OK('Tarjeta activa') : NO('Tarjeta apagada');
      on('oxxo') ? OK('OXXO activo') : OJO('OXXO apagado y el menú del bot lo ofrece');
    }

    const w = await sp('webhook_endpoints?limit=10');
    const mio = (w.data || []).find((x) => x.status === 'enabled' && x.url.includes('/webhook/stripe'));
    if (!mio) { NO('No hay webhook apuntando a /webhook/stripe'); }
    else {
      OK(`Webhook registrado · ${mio.url}`);
      for (const [ev, para] of [
        ['checkout.session.completed', 'tarjeta y la ficha de OXXO'],
        ['checkout.session.async_payment_succeeded', 'cuando pagan la ficha en OXXO'],
        ['checkout.session.async_payment_failed', 'cuando la ficha vence'],
        ['customer_cash_balance_transaction.created', 'las transferencias a la CLABE'],
      ]) {
        (mio.enabled_events.includes('*') || mio.enabled_events.includes(ev))
          ? OK(`  ${ev}`)
          : NO(`  FALTA ${ev} → sin esto no funciona: ${para}`);
      }
    }
  } catch (e) { NO(`Stripe: ${e.message}`); }
}

// ── 4. Las variables del servidor ───────────────────────────────────────────
console.log('\n── VARIABLES EN RENDER ─────────────────────────────────────────');
const VARS = [
  ['STRIPE_SECRET_KEY', true, 'cobrar'],
  ['STRIPE_WEBHOOK_SECRET_LEON', true, 'verificar que los avisos vengan de Stripe'],
  ['LEON_STRIPE_CUENTA_CONECTADA', true, 'que el dinero le llegue a León Telecom'],
  ['WISPHUB_API_KEY', true, 'reactivar el servicio'],
  ['SERVER_BASE_URL', true, 'las direcciones de regreso tras pagar'],
  ['COBRO_LINEA_ACTIVO', false, 'encender el cobro (déjalo en false hasta el final)'],
  ['WISPHUB_REACTIVAR_ACTIVO', false, 'encender la reactivación automática'],
];
for (const [v, obligatoria, para] of VARS) {
  const puesta = (process.env[v] || '').trim();
  if (puesta) OK(`${v} está puesta`);
  else if (obligatoria) OJO(`${v} sin definir AQUÍ · hace falta en Render para ${para}`);
  else console.log(`  ·  ${v} sin definir (es el interruptor: ${para})`);
}
console.log('\n  Nota: esto lee TU terminal, no Render. Que falten aquí no significa');
console.log('  que falten allá; compruébalas en el panel de Render.');

// ── Resumen ─────────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log(`║   ${String(bien).padStart(3)} listo   ${String(falta).padStart(3)} bloqueando   ${String(ojo).padStart(3)} por revisar`.padEnd(64) + '║');
console.log('╚═══════════════════════════════════════════════════════════════╝');
if (falta) {
  console.log('\n  ❌ NO enciendas todavía. Lo marcado con ❌ rompe el cobro en silencio:');
  console.log('     el dinero entra y nadie se entera, o el cliente paga y sigue cortado.\n');
} else {
  console.log('\n  ✅ Todo lo revisable está en su lugar.');
  console.log('     Falta lo único que no se puede automatizar: un cobro real de $10');
  console.log('     a tu propio servicio (el 1472) antes de abrirlo a nadie más.\n');
}
process.exit(falta ? 1 : 0);
