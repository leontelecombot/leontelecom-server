/**
 * REACTIVACIÓN EN WISPHUB — contra una Wisphub falsa.
 *
 * Reproduce lo que la API real hace de verdad (comprobado el 5 sep 2026 contra
 * api.wisphub.net con la llave de León Telecom):
 *   - los teléfonos se guardan a 10 dígitos, no con el 52 de país
 *   - `estado` de la factura es de SOLO LECTURA
 *   - facturas NO acepta PATCH, solo PUT
 *   - activar es asíncrono y los ids que no encuentra van en `warnings`
 *   - activar y desactivar son endpoints separados
 *
 *   node verificar-wisphub.mjs
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const PUERTO = 4397;
process.env.WISPHUB_API_URL = `http://127.0.0.1:${PUERTO}`;
process.env.WISPHUB_API_KEY = 'llave-de-prueba';

let ok = 0, mal = 0;
const OK = (m) => { console.log('  OK    ' + m); ok++; };
const MAL = (m) => { console.log('  FALLA ' + m); mal++; };

const estado = {
  // Como la instalación real de León Telecom: `saldo` SIEMPRE 0 y
  // `total_cobrado` igual al total, aunque la factura esté pendiente.
  cliente: { id_servicio: 1472, nombre: 'Piloto', telefono: '9516549145',
             usuario: '1472piloto@redwifi', estado: 'Suspendido', estado_facturas: 'Pendiente de Pago' },
  facturas: [], extras: [],
  estadoEsEscribible: false,   // en la API real es de solo lectura
  puts: [], activaciones: [], desactivaciones: [], busquedas: [], consultasFactura: [],
};
const fac = (id, total, estadoTxt, vence) => ({
  id_factura: id, estado: estadoTxt, total, saldo: 0, saldo_nuevo: 0, total_cobrado: total,
  total_pasarela: 0, fecha_emision: vence, fecha_vencimiento: vence, fecha_pago: null, referencia: '',
});

const srv = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const responder = (o, c = 200) => { res.statusCode = c; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const body = cuerpo ? JSON.parse(cuerpo) : {};

    if (u.pathname === '/api/clientes/' && req.method === 'GET') {
      const tel = u.searchParams.get('telefono');
      estado.busquedas.push(tel);
      const hay = tel === estado.cliente.telefono;   // solo los 10 dígitos
      const lista = hay ? [estado.cliente, ...(estado.extras || [])] : [];
      return responder({ count: lista.length, results: lista });
    }

    if (u.pathname === '/api/facturas/' && req.method === 'GET') {
      const q = u.searchParams;
      estado.consultasFactura.push(Object.fromEntries(q));
      // Para probar qué pasa cuando la deuda NO se puede leer.
      if (estado.facturasCaidas) return responder({ detail: 'Error interno' }, 500);
      // El filtro `cliente` recibe el USUARIO. Con el id devuelve vacío.
      if (q.get('cliente') !== estado.cliente.usuario) return responder({ count: 0, results: [] });
      // `estado` es NUMÉRICO: 1=Pendiente, 2=Pagada. Con texto, vacío.
      const e = q.get('estado');
      if (e && !/^\d+$/.test(e)) return responder({ count: 0, results: [] });
      // Sin `desde`/`hasta` explícitos, la API real solo da el mes actual.
      const amplio = q.get('desde') && q.get('hasta');
      let r = estado.facturas.filter((f) => (e === '1' ? f.estado !== 'Pagada' : e === '2' ? f.estado === 'Pagada' : true));
      if (!amplio) r = r.filter((f) => String(f.fecha_vencimiento).startsWith('2026-09'));
      return responder({ count: r.length, results: r });
    }

    const mf = u.pathname.match(/^\/api\/facturas\/(\d+)\/$/);
    if (mf) {
      const f = estado.facturas.find((x) => String(x.id_factura) === mf[1]);
      if (!f) return responder({ detail: 'No encontrado.' }, 404);
      if (req.method === 'GET') return responder(f);
      if (req.method === 'PATCH') return responder({ detail: 'Método "PATCH" no permitido.' }, 405);
      if (req.method === 'PUT') {
        for (const k of ['fecha_emision', 'fecha_vencimiento', 'fecha_pago']) {
          if (!body[k]) return responder({ [k]: ['Este campo es requerido.'] }, 400);
        }
        estado.puts.push(body);
        const { estado: _ignorado, ...resto } = body;
        Object.assign(f, resto);
        // Como la API real: `estado` es de solo lectura y se IGNORA en silencio.
        if (estado.estadoEsEscribible && body.estado === 2) f.estado = 'Pagada';
        return responder(f);
      }
    }

    if (u.pathname === '/api/clientes/activar/' && req.method === 'POST') {
      const ids = body.servicios || [];
      if (!ids.length) return responder({ servicios: { non_field_errors: ['Esta lista no puede estar vacía.'] } }, 400);
      const faltan = ids.filter((i) => Number(i) !== estado.cliente.id_servicio);
      estado.activaciones.push(ids);
      if (!faltan.length) estado.cliente.estado = 'Activo';
      return responder({ task_id: 'tarea-' + estado.activaciones.length,
        warnings: faltan.length ? [`Los servicios [${faltan}] no fueron encontrados y no se pudo realizar la acción.`] : [] });
    }
    if (u.pathname === '/api/clientes/desactivar/' && req.method === 'POST') {
      estado.desactivaciones.push(body.servicios);
      return responder({ task_id: 'x', warnings: [] });
    }
    responder({ detail: 'no encontrado' }, 404);
  });
});
await new Promise((r) => srv.listen(PUERTO, r));

const require = createRequire(import.meta.url);
const wisp = require('/home/manuel-flores/LEON-TELECOM/leontelecom-server/utils/wisphubReactivar.js');

console.log('\n=== 1. EL INTERRUPTOR ===');
{
  process.env.WISPHUB_REACTIVAR_ACTIVO = 'false';
  wisp.activo() === false ? OK('apagado por defecto') : MAL('nació encendido');
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'x' });
  r.reactivado === false && r.buscado === false ? OK('apagado, ni siquiera consulta a Wisphub') : MAL('hizo algo estando apagado');
  estado.cliente.estado === 'Suspendido' ? OK('el cliente sigue suspendido') : MAL('lo movió');
  process.env.WISPHUB_REACTIVAR_ACTIVO = 'true';
}

console.log('\n=== 2. EL TELÉFONO: WHATSAPP DA 12 DÍGITOS, WISPHUB GUARDA 10 ===');
{
  estado.busquedas.length = 0;
  const c = await wisp.buscarPorTelefono('529516549145');
  c && c.id_servicio === 1472 ? OK('encuentra al cliente pese al formato distinto') : MAL('no lo encontró');
  estado.busquedas.includes('529516549145') && estado.busquedas.includes('9516549145')
    ? OK('probó las dos formas, con y sin el 52') : MAL('buscó: ' + estado.busquedas.join(', '));

  const nadie = await wisp.buscarPorTelefono('5219990000000');
  nadie === null ? OK('un teléfono que no existe devuelve nada, sin reventar') : MAL('devolvió algo');
}

console.log('\n=== 3. LAS TRES TRAMPAS DEL FILTRO DE FACTURAS ===');
{
  /*
   * Las tres hunden el sistema en silencio: devuelven una lista vacía, que se
   * ve idéntica a "no debe nada". Una primera versión las tenía las tres.
   */
  estado.facturas = [fac(910, 440, 'Pendiente de Pago', '2026-08-16')];
  estado.consultasFactura.length = 0;
  const d = await wisp.deudaDelCliente(estado.cliente.usuario);
  const q = estado.consultasFactura.at(-1);

  q.cliente === estado.cliente.usuario ? OK('filtra por USUARIO, no por id de servicio') : MAL('mandó ' + q.cliente);
  q.estado === '1' ? OK('el estado va como NÚMERO (1=Pendiente)') : MAL('mandó estado=' + q.estado);
  q.desde && q.hasta ? OK('manda rango de fechas amplio') : MAL('sin fechas: la API solo daría el mes actual');
  d.total === 440 ? OK('encuentra la deuda de un mes viejo (agosto)') : MAL('deuda ' + d.total);

  // La deuda sale de `total`, NO de `saldo`, que siempre es 0.
  estado.facturas[0].saldo === 0 ? OK('y lo hace pese a que saldo=0 en todas las facturas') : MAL('el escenario no reproduce la API real');
}

console.log('\n=== 4. MARCAR PAGADA: SE INTENTA Y SE COMPRUEBA ===');
{
  estado.facturas = [fac(920, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.estadoEsEscribible = false;   // como la API real
  const r = await wisp.intentarMarcarPagada({ idFactura: 920, monto: 440, referencia: 'pi_1' });
  r.marcada === false ? OK('detecta que la factura NO quedó pagada') : MAL('dijo que sí quedó');
  /sigue en/.test(r.motivo || '') ? OK('y explica por qué') : MAL('motivo: ' + r.motivo);
  const put = estado.puts.at(-1);
  put.fecha_emision && put.fecha_vencimiento && put.fecha_pago ? OK('mandó las tres fechas obligatorias') : MAL('faltan fechas');
  put.referencia === 'pi_1' ? OK('con la referencia del pago') : MAL('sin referencia');

  // Si algún día Wisphub lo permitiera, tiene que reconocerlo.
  estado.estadoEsEscribible = true;
  estado.facturas = [fac(921, 440, 'Pendiente de Pago', '2026-09-16')];
  const r2 = await wisp.intentarMarcarPagada({ idFactura: 921, monto: 440, referencia: 'pi_2' });
  r2.marcada === true ? OK('y si sí se pudiera, lo reconoce') : MAL('no lo reconoció');
  estado.estadoEsEscribible = false;
}

console.log('\n=== 4a. PAGA COMPLETO Y LA API NO DEJA MARCAR: SE RECONECTA IGUAL ===');
{
  /*
   * ES EL CASO NORMAL, no uno raro: la API casi nunca deja marcar la factura.
   * Antes esto dejaba al cliente cortado después de pagar sus $440 completos,
   * y encima le decía que "todavía debe $440". La factura sin registrar es un
   * pendiente de la OFICINA; la reconexión es un derecho del cliente que pagó.
   */
  estado.facturas = [fac(925, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.cliente.estado = 'Suspendido';
  estado.estadoEsEscribible = false;
  estado.activaciones.length = 0;
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'pi_completo' });
  r.reactivado === true ? OK('paga sus $440 completos y SÍ se reconecta aunque Wisphub no dejara marcar la factura') : MAL('¡lo dejó cortado! ' + r.avisos.join(' | '));
  r.deudaRestante === 0 ? OK('y ya no debe nada') : MAL('dice que debe ' + r.deudaRestante);
  r.registroManual.length === 1 && r.registroManual[0].factura === 925 ? OK('la factura que no se pudo marcar queda para registrar a mano') : MAL('registroManual: ' + JSON.stringify(r.registroManual));
  estado.activaciones.length === 1 ? OK('se mandó reactivar una sola vez') : MAL('activaciones: ' + estado.activaciones.length);
  const put = estado.puts.at(-1);
  put && put.saldo === 0 && put.total_cobrado === 440 ? OK('el intento de marcar manda saldo 0 y total_cobrado, como pide Wisphub') : MAL('put: ' + JSON.stringify(put));
}

console.log('\n=== 4b. NO SE REACTIVA A QUIEN NO ALCANZÓ A PAGAR ===');
{
  estado.facturas = [fac(930, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.cliente.estado = 'Suspendido';
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 200, referencia: 'parcial' });
  r.reactivado === false ? OK('paga $200 de $440 y NO se reconecta') : MAL('¡lo reconectó!');
  r.deudaRestante === 240 ? OK('le quedan $240 por pagar, ni $440 ni $0') : MAL('deuda ' + r.deudaRestante);
  /todavía debe/.test(r.avisos.join(' ')) ? OK('y dice cuánto falta') : MAL(r.avisos.join(' | '));
}

console.log('\n=== 4c. DOS MESES DE ATRASO: SE PAGA EL MÁS VIEJO PRIMERO ===');
{
  estado.facturas = [fac(941, 440, 'Pendiente de Pago', '2026-09-16'), fac(940, 440, 'Pendiente de Pago', '2026-08-16')];
  estado.cliente.estado = 'Suspendido';
  estado.puts.length = 0;
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'un-mes' });
  r.deudaRestante === 880 || r.registroManual.length
    ? OK('reconoce que quedan facturas por registrar a mano') : MAL('deuda ' + r.deudaRestante);
  (estado.puts[0] || {}).referencia === 'un-mes' && estado.consultasFactura.length
    ? OK('intentó con la factura de agosto primero') : MAL('no intentó la vieja primero');
  r.reactivado === false ? OK('y no reconecta debiendo un mes') : MAL('reconectó debiendo');
}

console.log('\n=== 4d. EL CLIENTE ADELANTADO (pagó hasta diciembre) ===');
{
  /*
   * 11 de cada 300 clientes de León Telecom tienen saldo a favor. Si uno
   * transfiere sin deber, su dinero está en Stripe pero Wisphub no tiene dónde
   * aplicarlo: no puede desaparecer sin que nadie se entere.
   */
  estado.facturas = [];
  estado.cliente.estado = 'Activo';
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'adelantado' });
  r.aFavor === true ? OK('detecta que no debía nada') : MAL('no lo marcó como saldo a favor');
  r.sobrante === 440 ? OK('los $440 quedan identificados como saldo a favor') : MAL('sobrante ' + r.sobrante);
  /a mano/.test(r.avisos.join(' ')) ? OK('y pide que alguien los aplique a mano') : MAL(r.avisos.join(' | '));
  r.reactivado === false ? OK('sin tocar su servicio, que ya estaba activo') : MAL('lo tocó');
}

console.log('\n=== 4e. PAGA HORAS ANTES DEL CORTE (todavía activo) ===');
{
  estado.facturas = [fac(950, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.cliente.estado = 'Activo';
  estado.activaciones.length = 0;
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'antes-del-corte' });
  r.reactivado === false ? OK('no intenta reactivar a quien nunca fue cortado') : MAL('reactivó de más');
  estado.activaciones.length === 0 ? OK('ni le habla a Wisphub para activarlo') : MAL('llamó a activar sin necesidad');
  /pagó antes del corte/.test(r.avisos.join(' ')) ? OK('y lo deja anotado con esas palabras') : MAL(r.avisos.join(' | '));
  r.registroManual.length ? OK('pero sí marca que hay que registrar su pago') : MAL('no marcó el registro pendiente');
}

console.log('\n=== 4f. SI NO SE PUEDE LEER LA DEUDA, NO SE REGALA SERVICIO ===');
{
  /*
   * Antes esto "pasaba" por el bug que arregló 4a: la deuda sí se leía, y lo
   * que impedía reconectar era que la factura no se dejaba marcar. Ahora la
   * consulta de facturas de verdad falla, que es lo que se quería probar.
   */
  estado.facturas = [fac(960, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.cliente.estado = 'Suspendido';
  estado.facturasCaidas = true;
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'ciego' });
  r.reactivado === false ? OK('sin poder confirmar la deuda, NO reactiva') : MAL('¡reactivó a ciegas! ' + JSON.stringify(r));
  r.deudaRestante === null ? OK('y deja claro que la deuda no se supo, no que sea cero') : MAL('deudaRestante ' + r.deudaRestante);
  /No se pudo confirmar la deuda/.test(r.avisos.join(' ')) ? OK('con el motivo en los avisos') : MAL(r.avisos.join(' | '));
  estado.facturasCaidas = false;
}

console.log('\n=== 4g. UN TELÉFONO CON VARIOS SERVICIOS ===');
{
  /*
   * 26 teléfonos del padrón tienen más de un servicio; uno tiene tres. Elegir
   * "el primero" es una moneda al aire: se reactivaría uno que ya estaba activo
   * y el cortado seguiría cortado, con el dinero abonado a la cuenta que no era.
   */
  estado.facturas = [fac(970, 440, 'Pendiente de Pago', '2026-09-16')];
  estado.cliente.estado = 'Activo';
  estado.extras = [{ id_servicio: 501, nombre: 'Mismo Titular', telefono: '9516549145',
    usuario: '501otro@redwifi', estado: 'Suspendido', estado_facturas: 'Pendiente de Pago' }];

  const uno = await wisp.serviciosDe('529516549145');
  uno.total === 2 ? OK('encuentra los dos servicios') : MAL('encontró ' + uno.total);
  uno.servicios[0].id_servicio === 501
    ? OK('y pone primero el SUSPENDIDO, que es el que están pagando') : MAL('eligió el ' + uno.servicios[0].id_servicio);
  uno.ambiguo === false ? OK('con un solo suspendido no hay duda') : MAL('lo marcó ambiguo');

  // Dos suspendidos: aquí sí no se puede adivinar.
  estado.extras.push({ id_servicio: 502, nombre: 'Otro Más', telefono: '9516549145',
    usuario: '502otro@redwifi', estado: 'Suspendido', estado_facturas: 'Pendiente de Pago' });
  estado.cliente.estado = 'Activo';
  const dos = await wisp.serviciosDe('529516549145');
  dos.ambiguo === true ? OK('con dos suspendidos lo marca ambiguo') : MAL('adivinó');

  estado.activaciones.length = 0;
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'ambiguo' });
  r.ambiguo === true ? OK('el pago NO se aplica a ciegas') : MAL('lo aplicó');
  estado.activaciones.length === 0 ? OK('y no reactiva nada por adivinanza') : MAL('¡reactivó a ciegas!');
  r.serviciosPosibles.length === 3 ? OK('deja la lista de servicios para que un humano elija') : MAL('sin lista');

  estado.extras = [];
}

console.log('\n=== 5. NUNCA PUEDE CORTAR A NADIE ===');console.log('\n=== 5. NUNCA PUEDE CORTAR A NADIE ===');
{
  /*
   * Es lo más importante del archivo. `activar` y `desactivar` son endpoints
   * separados en la API real; este módulo solo conoce el primero. Si algún día
   * alguien agrega el otro por conveniencia, esta prueba se cae.
   */
  const fuente = await import('node:fs').then((fs) => fs.readFileSync('utils/wisphubReactivar.js', 'utf8'));
  !/desactivar|suspender|cortar/i.test(fuente.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''))
    ? OK('el módulo no sabe desactivar: imposible cortar a alguien desde aquí') : MAL('¡hay código que puede desactivar!');
  estado.desactivaciones.length === 0 ? OK('en toda la corrida no se desactivó a nadie') : MAL('¡desactivó!');

  // Llamarlo sobre alguien ya activo no lo apaga.
  estado.cliente.estado = 'Activo';
  await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'y' });
  estado.cliente.estado === 'Activo' ? OK('pagar dos veces no apaga a un cliente activo') : MAL('¡lo apagó!');
}

console.log('\n=== 6. SI WISPHUB SE CAE, EL PAGO NO SE PIERDE ===');
{
  /*
   * Quien llama a esto es el webhook de Stripe. El dinero YA entró: si Wisphub
   * está caído, esto tiene que devolver el problema, no lanzarlo, para que el
   * aviso al cliente salga igual.
   */
  srv.close();
  await new Promise((r) => setTimeout(r, 200));
  const r = await wisp.aplicarPago({ telefono: '529516549145', monto: 440, referencia: 'z' });
  r && typeof r === 'object' ? OK('con Wisphub caído devuelve un resultado, no una excepción') : MAL('lanzó');
  r.avisos.length ? OK('y explica qué falló: ' + r.avisos[0].slice(0, 50)) : MAL('sin avisos');
  r.reactivado === false ? OK('sin mentir diciendo que reactivó') : MAL('dijo que reactivó');
}

console.log(`\n═══ ${ok} bien / ${mal} mal ═══`);
try { srv.close(); } catch {}
process.exit(mal ? 1 : 0);
