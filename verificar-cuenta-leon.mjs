/**
 * LA CUENTA A LA QUE LE CAE EL DINERO DE LEÓN.
 *
 * Antes vivía en una variable de entorno que alguien tenía que crear a mano en
 * Stripe y pegar en Render. O sea que León no podía darla de alta solo:
 * dependía de que alguien más se sentara a hacerlo, y mientras tanto TODO el
 * cobro en línea se quedaba apagado esperando.
 *
 * Lo que se cuida aquí es que no se pueda cobrar un peso hasta que su cuenta
 * exista Y Stripe la haya aprobado. Cobrarle a un cliente contra una cuenta a
 * medio verificar acaba con el cargo rechazado DESPUÉS de que la persona ya
 * metió su tarjeta, y quien da la cara es él.
 *
 *   node verificar-cuenta-leon.mjs
 */
import { createServer } from 'node:http';
import net from 'node:net';

const puertoLibre = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const PS = await puertoLibre();

process.env.STRIPE_API_BASE = `http://127.0.0.1:${PS}/v1/`;
process.env.STRIPE_API_V2 = `http://127.0.0.1:${PS}/v2/`;
process.env.STRIPE_SECRET_KEY = 'sk_test_falsa';
process.env.COBRO_LINEA_ACTIVO = 'true';
process.env.COBRO_LINEA_TELEFONOS = '*';
delete process.env.LEON_STRIPE_CUENTA_CONECTADA;   // el caso nuevo: sin variable

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };
const es = (c, m) => (c ? OK(m) : MAL(m));

// ── Stripe de mentiras ──────────────────────────────────────────────────────
const pedidos = [];
const estado = { puedeCobrar: false, faltante: ['identity.document'] };
const stripeFalso = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    pedidos.push({ ruta: req.url, metodo: req.method, crudo: cuerpo });
    res.setHeader('content-type', 'application/json');

    if (req.url.startsWith('/v2/')) {
      const j = cuerpo ? JSON.parse(cuerpo) : {};
      if (req.url.includes('core/account_links')) {
        return res.end(JSON.stringify({ url: 'https://alta.falsa/ir' }));
      }
      return res.end(JSON.stringify({ id: 'acct_leon', object: 'v2.core.account', display_name: j.display_name }));
    }
    if (req.url.includes('/accounts/')) {
      return res.end(JSON.stringify({
        id: 'acct_leon',
        charges_enabled: estado.puedeCobrar,
        payouts_enabled: estado.puedeCobrar,
        requirements: { currently_due: estado.faltante },
        external_accounts: { data: estado.puedeCobrar ? [{ last4: '4242' }] : [] },
        settings: { payouts: { schedule: { interval: 'daily', delay_days: 3 } } },
      }));
    }
    res.end(JSON.stringify({ id: 'obj_falso', url: 'https://pago.falso/ir' }));
  });
});
await new Promise((r) => stripeFalso.listen(PS, r));

const { default: mod } = await import('./utils/stripeLeon.js').then((m) => ({ default: m.default || m }));
const cobro = mod;

console.log('\n=== 1. SIN CUENTA, NO SE COBRA UN PESO ===');
{
  es(cobro.cuentaConectada() === '', 'de entrada no hay cuenta dada de alta');
  es(cobro.cuentaLista() === false, 'y por lo tanto no está lista');

  let error = null;
  try {
    await cobro.generarLinkPago({ telefono: '5219516549145', monto: 440, nombre: 'Cliente', urlBase: 'https://x.mx', forma: 'tarjeta' });
  } catch (e) { error = e.message; }
  es(!!error, 'intentar cobrar truena en vez de cobrar mal');
  es(/dado de alta la cuenta/i.test(error || ''), 'y dice que falta dar de alta la cuenta, no un error técnico');
  es(!/LEON_STRIPE_CUENTA_CONECTADA/.test(error || ''), 'sin mencionarle una variable que él no sabe qué es');
}

console.log('\n=== 2. LA CUENTA SE CREA A NOMBRE DE LEÓN ===');
{
  const id = await cobro.crearCuentaConectada({ email: 'leon@ejemplo.mx', nombre: 'León Telecom' });
  es(id === 'acct_leon', 'se crea la cuenta');

  const alta = pedidos.find((p) => p.ruta.includes('core/accounts') && !p.ruta.includes('links'));
  const j = JSON.parse(alta.crudo);
  es(j.identity?.country === 'mx', 'en México');
  es(j.identity?.entity_type === 'company', 'como empresa, que es lo que es León Telecom');
  es(j.dashboard === 'express', 'con panel propio, para que él vea sus depósitos');
  es(j.defaults?.responsibilities?.fees_collector === 'application', 'la comisión la cobra la plataforma');

  const pago = pedidos.find((p) => p.ruta.includes('/accounts/') && p.metodo === 'POST');
  const cuerpoPago = decodeURIComponent(pago ? pago.crudo : '');
  es(/\[interval\]=daily/.test(cuerpoPago), 'y se le pide a Stripe que le deposite diario');
  es(/\[delay_days\]=minimum/.test(cuerpoPago), 'lo más rápido que permita esa cuenta');

  // Pedirla otra vez NO crea una segunda: sería partirle el dinero en dos.
  const antes = pedidos.filter((p) => p.ruta.includes('core/accounts') && !p.ruta.includes('links')).length;
  await cobro.crearCuentaConectada({ nombre: 'León Telecom' });
  const despues = pedidos.filter((p) => p.ruta.includes('core/accounts') && !p.ruta.includes('links')).length;
  es(antes === despues, 'pedirla otra vez no crea una segunda cuenta');
}

console.log('\n=== 3. CREADA NO ES LO MISMO QUE LISTA ===');
{
  /*
   * Stripe crea la cuenta al instante y la habilita para cobrar solo cuando
   * termina de revisar los papeles. Entre esos dos momentos hay días, y en
   * esos días el cobro TIENE que seguir apagado.
   */
  const est = await cobro.estadoCuenta();
  es(est.existe === true, 'la cuenta ya existe');
  es(est.puedeCobrar === false, 'pero Stripe todavía no la aprueba');
  es(est.faltante.includes('identity.document'), 'y dice qué le falta');
  es(cobro.cuentaLista() === false, 'así que el sistema la considera no lista');

  let error = null;
  try {
    await cobro.generarLinkPago({ telefono: '5219516549145', monto: 440, nombre: 'Cliente', urlBase: 'https://x.mx', forma: 'tarjeta' });
  } catch (e) { error = e.message; }
  es(/no está aprobada/i.test(error || ''), 'y sigue sin cobrarle a nadie');
}

console.log('\n=== 4. EL ENLACE DONDE LLENA SUS DATOS ===');
{
  const url = await cobro.enlaceOnboarding({ urlBase: 'https://leontelecom.mx/' });
  es(url === 'https://alta.falsa/ir', 'se genera el enlace del alta');

  const l = pedidos.filter((p) => p.ruta.includes('core/account_links')).pop();
  const j = JSON.parse(l.crudo);
  const conf = j.use_case?.account_onboarding || {};
  es(conf.return_url === 'https://leontelecom.mx/cuenta-cobro?estado=listo',
     'al terminar lo regresa a una pantalla que se entiende');
  es(conf.refresh_url === 'https://leontelecom.mx/cuenta-cobro?estado=reintentar',
     'y a otra distinta si el enlace se venció');
  es(!/\/\//.test(conf.return_url.replace('https://', '')), 'sin doble diagonal aunque la dirección venga con una al final');
}

console.log('\n=== 5. CUANDO STRIPE LA APRUEBA, COBRA SOLA ===');
{
  estado.puedeCobrar = true;
  estado.faltante = [];
  const est = await cobro.estadoCuenta();
  es(est.puedeCobrar === true, 'Stripe ya la aprobó');
  es(est.banco === '4242', 'y se ve a qué banco le va a depositar');
  es(est.demora === 3, 'y en cuántos días hábiles');
  es(cobro.cuentaLista() === true, 'el sistema la da por lista');

  const pago = await cobro.generarLinkPago({
    telefono: '5219516549145', monto: 440, nombre: 'Cliente', urlBase: 'https://x.mx', forma: 'tarjeta' });
  es(!!pago, 'y ahora sí se puede generar un cobro');

  const sesion = pedidos.filter((p) => p.ruta.includes('checkout/sessions')).pop();
  const cuerpoSesion = decodeURIComponent(sesion.crudo);
  es(/\[transfer_data\]\[destination\]=acct_leon/.test(cuerpoSesion),
     'con el dinero yendo a la cuenta de León, no a la nuestra');
  es(/\[application_fee_amount\]=\d+/.test(cuerpoSesion),
     'y el cargo por servicio quedándose en la plataforma');
  es(/\[on_behalf_of\]=acct_leon/.test(cuerpoSesion),
     'y el cargo saliendo a nombre de León en el estado de cuenta del cliente');
}

console.log('\n=== 6. LA VARIABLE DE SIEMPRE SIGUE SIRVIENDO ===');
{
  /*
   * Quien ya tenga la cuenta puesta a mano en Render no debe notar nada. Si
   * esto se rompiera, el cobro de producción se caería el día del despliegue.
   */
  const { execFileSync } = await import('node:child_process');
  const salida = execFileSync(process.execPath, ['-e', `
    const c = require('./utils/stripeLeon.js');
    console.log(JSON.stringify({ id: c.cuentaConectada(), lista: c.cuentaLista() }));
  `], { env: { ...process.env, LEON_STRIPE_CUENTA_CONECTADA: 'acct_puesta_a_mano' }, encoding: 'utf8' });
  const r = JSON.parse(salida.trim());
  es(r.id === 'acct_puesta_a_mano', 'toma la cuenta de la variable de entorno');
  es(r.lista === true, 'y la da por buena, porque la puso una persona a propósito');
}

if (process.env.VER_PEDIDOS === '1') {
  console.log('\n--- lo que se le pidió a Stripe ---');
  for (const p of pedidos) console.log(' ', p.metodo, p.ruta, '·', decodeURIComponent(p.crudo || ''));
}
console.log(`\n=== ${ok} bien / ${mal} mal ===`);
try { stripeFalso.close(); } catch {}
process.exit(mal ? 1 : 0);
