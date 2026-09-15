/**
 * REVISIÓN DE LA CUENTA DE STRIPE — solo lectura, no mueve un peso.
 *
 * Antes de cobrarle a nadie, comprueba que la cuenta esté lista de verdad:
 * Connect encendido, transferencias bancarias activas (son las que generan las
 * CLABEs), el webhook registrado y —lo que más se olvida— que escuche los
 * cuatro eventos que hacen falta.
 *
 * Faltar un evento no da error en ningún lado: simplemente el pago entra y
 * nadie se entera. Por eso esto existe.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node revisar-stripe.mjs
 *
 * La llave se lee del entorno a propósito: no se teclea en el comando, para que
 * no quede guardada en el historial de la terminal.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * La llave se lee de un ARCHIVO, no del comando.
 *
 * Escribirla en la línea de comandos la deja guardada en el historial de la
 * terminal (~/.zsh_history), donde se queda para siempre y a la vista de
 * cualquiera que abra ese archivo. Una llave de Stripe mueve dinero: no puede
 * andar de recuerdo en el historial.
 *
 * El archivo `.stripe-key` está en .gitignore, así que tampoco se sube por
 * accidente.
 */
const AQUI = dirname(fileURLToPath(import.meta.url));
const ARCHIVO = join(AQUI, '.stripe-key');

let LLAVE = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!LLAVE && existsSync(ARCHIVO)) {
  LLAVE = readFileSync(ARCHIVO, 'utf8').split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#')) || '';
}
if (!LLAVE) {
  console.error(`
  No encontré la llave.

  Pon tu llave en un archivo (NO en el comando, para que no quede en el
  historial de la terminal):

      cd ${AQUI}
      nano .stripe-key          ← pegas la llave, guardas con Ctrl+O y Ctrl+X
      node revisar-stripe.mjs

  Empieza con la de PRUEBA (sk_test_...). La real va directo a Render.
`);
  process.exit(1);
}
const MODO = LLAVE.startsWith('sk_live_') ? 'REAL' : 'PRUEBA';
const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1/').replace(/\/?$/, '/');

let bien = 0, mal = 0, ojo = 0;
const OK = (m) => { console.log('  ✅ ' + m); bien++; };
const NO = (m) => { console.log('  ❌ ' + m); mal++; };
const OJO = (m) => { console.log('  ⚠️  ' + m); ojo++; };

async function sp(ruta) {
  const r = await fetch(API + ruta, { headers: { Authorization: 'Bearer ' + LLAVE } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((d.error && d.error.message) || r.status); e.status = r.status; throw e; }
  return d;
}

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  REVISIÓN DE STRIPE — modo ${MODO.padEnd(30)}║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

console.log('── LA CUENTA ──────────────────────────────────────────────');
let cuenta = null;
try {
  cuenta = await sp('account');
  OK(`Conectado a "${cuenta.settings?.dashboard?.display_name || cuenta.id}" (${cuenta.country})`);
  cuenta.charges_enabled ? OK('Puede cobrar') : NO('NO puede cobrar todavía: Stripe pide completar la activación');
  cuenta.payouts_enabled ? OK('Puede recibir depósitos a su banco') : NO('NO puede recibir depósitos: falta la cuenta bancaria');
  if (cuenta.default_currency !== 'mxn') OJO(`La moneda por defecto es ${String(cuenta.default_currency).toUpperCase()}, no MXN`);
} catch (e) {
  NO(`No se pudo leer la cuenta: ${e.message}`);
  console.log('\n  La llave no sirve o no tiene permisos. Revísala antes de seguir.\n');
  process.exit(1);
}

console.log('\n── CONNECT (para que el dinero le llegue a León Telecom) ──');
try {
  const c = await sp('accounts?limit=1');
  OK(`Connect está activo (${c.data.length ? 'ya hay cuentas conectadas' : 'todavía sin cuentas'})`);
  if (c.data.length) {
    for (const a of c.data) {
      const est = a.charges_enabled ? 'lista' : 'a medio verificar';
      (a.charges_enabled ? OK : OJO)(`Cuenta ${a.id} — ${est}`);
      if (!a.charges_enabled && a.requirements?.currently_due?.length) {
        console.log(`       le falta: ${a.requirements.currently_due.slice(0, 5).join(', ')}`);
      }
    }
  }
} catch (e) {
  NO(`Connect NO está activado: ${e.message}`);
  console.log('       Actívalo en el panel: Connect → Empezar. Sin esto el dinero cae en TU cuenta.');
}

console.log('\n── MÉTODOS DE PAGO ────────────────────────────────────────');
try {
  const pm = await sp('payment_method_configurations?limit=5');
  const cfg = (pm.data || [])[0];
  if (!cfg) { OJO('No hay configuración de métodos de pago que leer'); }
  else {
    const activo = (k) => cfg[k] && cfg[k].available && cfg[k].display_preference?.value !== 'off';
    activo('card') ? OK('Tarjeta activa') : NO('Tarjeta NO activa');
    activo('oxxo') ? OK('OXXO activo') : OJO('OXXO NO activo — el botón lo ofrece, actívalo o quítalo del menú');
    activo('customer_balance')
      ? OK('Transferencias bancarias activas (son las que generan las CLABEs)')
      : NO('Transferencias bancarias NO activas — SIN ESTO NO HAY CLABE FIJA');
  }
} catch (e) { OJO(`No se pudieron leer los métodos de pago: ${e.message}`); }

console.log('\n── WEBHOOK ────────────────────────────────────────────────');
const NECESARIOS = [
  ['checkout.session.completed', 'el pago con tarjeta y la ficha de OXXO'],
  ['checkout.session.async_payment_succeeded', 'cuando pagan la ficha en OXXO'],
  ['checkout.session.async_payment_failed', 'cuando la ficha de OXXO vence'],
  ['customer_cash_balance_transaction.created', 'las transferencias a la CLABE'],
];
try {
  const w = await sp('webhook_endpoints?limit=10');
  const activos = (w.data || []).filter((x) => x.status === 'enabled');
  if (!activos.length) {
    NO('No hay ningún webhook registrado — los pagos entrarían y nadie se enteraría');
  } else {
    for (const e of activos) {
      console.log(`\n  📍 ${e.url}`);
      const suyos = e.enabled_events || [];
      const todo = suyos.includes('*');
      for (const [ev, para] of NECESARIOS) {
        (todo || suyos.includes(ev))
          ? OK(`${ev}\n       → ${para}`)
          : NO(`FALTA ${ev}\n       → sin esto NO funciona: ${para}`);
      }
    }
  }
} catch (e) { OJO(`No se pudo leer el webhook: ${e.message}`); }

console.log('\n── LO QUE FALTA EN EL SERVIDOR ────────────────────────────');
for (const [v, para] of [
  ['STRIPE_WEBHOOK_SECRET_LEON', 'verificar que los avisos vengan de Stripe'],
  ['LEON_STRIPE_CUENTA_CONECTADA', 'a qué cuenta se le manda el dinero'],
  ['WISPHUB_API_KEY', 'reactivar el servicio'],
  ['SERVER_BASE_URL', 'las direcciones de regreso tras pagar'],
]) {
  (process.env[v] || '').trim() ? OK(`${v} está puesta`) : OJO(`${v} sin definir — hace falta para ${para}`);
}

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  ${String(bien).padStart(3)} bien   ${String(mal).padStart(3)} bloqueando   ${String(ojo).padStart(3)} por revisar`.padEnd(59) + '║');
console.log(`╚══════════════════════════════════════════════════════════╝`);
if (mal) console.log('\n  ❌ NO enciendas el cobro todavía: hay cosas que lo romperían en silencio.\n');
else if (MODO === 'PRUEBA') console.log('\n  ✅ En prueba está listo. Corre el flujo completo antes de pasar a real.\n');
else console.log('\n  ✅ Listo. Aun así: primer cobro de $10 a tu propio servicio antes de abrirlo a nadie.\n');
process.exit(mal ? 1 : 0);
