'use strict';

/**
 * MAQUETA — cobro con tarjeta/OXXO para León Telecom.
 *
 * Usa la MISMA plataforma de Stripe Connect que Aforo (mismo `STRIPE_SECRET_KEY`
 * de plataforma; León Telecom es una cuenta conectada más, como si fuera un
 * organizador). El patrón —HTTP directo a Stripe, sin SDK, firma de webhook por
 * HMAC— está copiado a propósito de aforo/cobro.js: es el mismo camino del
 * dinero, ya probado ahí, aplicado a un cobro mensual de internet en vez de un
 * boleto.
 *
 * Activo SOLO para el número de prueba (ver TELEFONO_PILOTO en index.js). No
 * toca al resto de los 1,090 clientes.
 */
const crypto = require('crypto');

/**
 * Cargo por servicio de pagar en línea. PLACEHOLDER para la propuesta —ajustar
 * cuando se decida el modelo de negocio real— pero el DISEÑO sí es a
 * propósito: igual que Aforo con los boletos, lo paga quien compra, no quien
 * vende. León Telecom recibe su precio de plan completo, sin recortes; el
 * cliente que prefiere la comodidad de tarjeta/OXXO en vez de ir a depositar
 * paga este cargo aparte, y de ahí sale tanto el costo real de Stripe (3.6% +
 * $3 MXN) como lo que le queda a Aforo.
 */
/*
 * Una tarifa por forma de pago, no una sola pareja.
 *
 * Recibir el dinero cuesta distinto según por dónde entre: una transferencia
 * SPEI le cuesta a la plataforma $8.12 fijos, una tarjeta cobra porcentaje, y
 * OXXO cobra más que la tarjeta. Con una tarifa pareja el reparto queda torcido:
 * sobra margen en la transferencia y casi no queda nada en OXXO.
 *
 * Estos son los números de la propuesta AFO-LT-003 que ya vio León Telecom, y
 * tienen que ser los mismos que cobre el sistema. Un documento que promete
 * $460 y un cobro que pide $470 es la peor forma de estrenar el servicio.
 */
const TARIFAS = {
  // Transferencia a su CLABE. Fijo, sin porcentaje: el costo de SPEI también
  // es fijo, así que cobrar porcentaje aquí sería cobrar por nada.
  clabe:   { fijo: 20, pct: 0 },
  tarjeta: { fijo: 12, pct: 0.055 },
  oxxo:    { fijo: 12, pct: 0.06 },
};
const FORMAS = Object.keys(TARIFAS);

/* ═══════════════════════════════════════════════════════════════════════════
 *  EL INTERRUPTOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mientras `COBRO_LINEA_ACTIVO` no sea exactamente 'true', todo esto está
 * apagado: no aparece el botón, no se generan links ni CLABEs, y ninguna de las
 * funciones de dinero hace nada. Así el código puede vivir desplegado sin
 * mover un peso hasta que se diga, y apagarlo es igual de rápido si algo sale
 * mal — sin tocar código ni volver a desplegar.
 *
 * `COBRO_LINEA_TELEFONOS`: a quién se le ofrece. Lista separada por comas, o
 * `*` para todos. Vacío = solo el piloto.
 *
 *   Activar solo para el piloto:  COBRO_LINEA_ACTIVO=true
 *   Ampliar a unos cuantos:       COBRO_LINEA_ACTIVO=true  COBRO_LINEA_TELEFONOS=5219511111111,5219512222222
 *   Activar para todos:           COBRO_LINEA_ACTIVO=true  COBRO_LINEA_TELEFONOS=*
 *   Apagar todo:                  COBRO_LINEA_ACTIVO=false
 *
 * El valor se lee en cada llamada, no se guarda en una constante: en Render,
 * cambiar la variable reinicia el proceso, pero en una prueba local se puede
 * apagar y encender sin levantar el servidor otra vez.
 */
function activo() {
  return String(process.env.COBRO_LINEA_ACTIVO || 'false').trim() === 'true';
}

/**
 * ¿A este teléfono se le ofrece el cobro en línea?
 *
 * Se comparan SOLO los dígitos. Un mismo número escrito como +52 951 654 9145,
 * 5219516549145 o 529516549145 tiene que dar el mismo resultado: si la
 * comparación fuera literal, el cliente vería el botón desde un formato y no
 * desde el otro, y eso es imposible de depurar desde el otro lado del teléfono.
 */
function permitido(telefono, piloto) {
  if (!activo()) return false;
  /*
   * Si la cuenta de León no está lista, NO se le ofrece al cliente.
   *
   * Sin esto, alguien ve el botón de pagar con tarjeta, lo elige, y hasta
   * entonces se topa con un error. Eso es peor que no ofrecerlo: ya se hizo
   * ilusiones, y el que queda mal es León, no nosotros. Que la opción no
   * exista mientras no pueda cumplirse.
   */
  if (!cuentaLista()) return false;
  const lista = String(process.env.COBRO_LINEA_TELEFONOS || '').trim();
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return false;
  if (!lista) return !!piloto && tel === String(piloto).replace(/\D/g, '');
  if (lista === '*') return true;

  /*
   * Abrir de a poco: `COBRO_LINEA_TELEFONOS=10%` se lo ofrece al 10% del padrón.
   *
   * Entre el teléfono piloto y `*` hay un salto de 1 a 1,430 clientes. Si algo
   * sale mal en producción —y en el primer mes de cobrar dinero de verdad algo
   * sale mal— la diferencia entre enterarse con 140 clientes o con todos es la
   * diferencia entre un mal rato y un desastre.
   *
   * Quién entra se decide con el teléfono, no al azar: el mismo cliente tiene
   * que obtener SIEMPRE la misma respuesta. Si fuera aleatorio, alguien vería el
   * botón el lunes, lo perdería el martes y llamaría a la oficina a preguntar
   * por qué. Y al subir el porcentaje solo se agrega gente, nunca se le quita a
   * quien ya lo tenía.
   */
  const pct = lista.match(/^(\d{1,3})\s*%$/);
  if (pct) {
    const porciento = Math.min(100, Number(pct[1]));
    if (porciento <= 0) return false;
    if (porciento >= 100) return true;
    return dentroDelCupo(tel, porciento * 100);
  }

  /*
   * Un número pelón son CLIENTES, no porcentaje: `COBRO_LINEA_TELEFONOS=50`.
   *
   * Los tratos se cierran en clientes, no en porcentajes. Con León se acordó
   * "empezamos con 50", y traducir eso a mano cada vez que cambie el padrón es
   * justo el tipo de cuenta que se hace mal: hoy 50 de 1,050 es 4.8%, y si él
   * crece a 1,400 ese mismo 4.8% ya son 67 clientes sin que nadie lo decidiera.
   */
  const cuantos = lista.match(/^(\d{1,6})$/);
  if (cuantos) {
    const meta = Number(cuantos[1]);
    if (meta <= 0) return false;
    const total = _padron ? Number(_padron.total()) || 0 : 0;
    if (!total) {
      /*
       * Sin saber cuántos clientes hay no se puede repartir un cupo. Se avisa
       * fuerte y se cae al piloto: es preferible ofrecérselo a una persona de
       * menos que a mil de más el día que arranca el cobro de verdad.
       */
      console.warn('[cobro] COBRO_LINEA_TELEFONOS=' + meta + ' pero todavía no se sabe cuántos clientes hay; por ahora solo el piloto.');
      return !!piloto && tel === String(piloto).replace(/\D/g, '');
    }
    if (meta >= total) return true;
    return enElPiloto(tel, meta);
  }

  return lista.split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean).includes(tel);
}

/*
 * ¿Este teléfono cae dentro de los primeros `corte` de diez mil?
 *
 * Se decide con el teléfono, no al azar, para que el MISMO cliente obtenga
 * siempre la misma respuesta. Si fuera aleatorio, alguien vería el botón el
 * lunes, lo perdería el martes y llamaría a la oficina a preguntar por qué.
 *
 * Se reparte en diez mil y no en cien porque 50 de 1,050 clientes es 4.76%, y
 * con cien cajones eso se redondea a 4% o 5%: la diferencia entre 42 y 53
 * clientes. Con diez mil, el número que se acordó es el que sale.
 */
function dentroDelCupo(tel, corte) {
  if (corte <= 0) return false;
  if (corte >= 10000) return true;
  const h = crypto.createHash('sha256').update(tel).digest();
  return (h.readUInt32BE(0) % 10000) < corte;
}

/* ═══════════════════ LOS ELEGIDOS DEL PILOTO ═══════════════════
 *
 * Cuando el cupo se da por número —"empezamos con 50"— hay que decidir CUÁLES
 * 50, y esa decisión se toma una sola vez y se guarda.
 *
 * Por qué no se recalcula cada vez: si dependiera del estado del cliente,
 * alguien suspendido entraría al piloto, pagaría, lo reactivarían, y al día
 * siguiente perdería la opción de pagar en línea. Vería el botón un día y no
 * al otro, y llamaría a la oficina a preguntar por qué. Una vez dentro, dentro.
 *
 * Por qué se prefiere a los suspendidos: son los que de verdad van a usarlo.
 * Un piloto hecho con clientes que pagan puntual en la oficina mide mal, y
 * puede hacer parecer que la cosa no sirve cuando lo que pasa es que a esos no
 * les hacía falta.
 */
let _piloto = null;          // { meta, telefonos: [] }
let _guardaPiloto = null;

function usarPiloto(io) {
  if (io && typeof io.obtener === 'function' && typeof io.guardar === 'function') {
    _guardaPiloto = io;
    const g = io.obtener();
    if (g && Array.isArray(g.telefonos)) _piloto = g;
  }
}

function enElPiloto(tel, meta) {
  const yaEstan = (_piloto && Array.isArray(_piloto.telefonos)) ? _piloto.telefonos : [];
  if (yaEstan.includes(tel)) return true;
  if (yaEstan.length >= meta) return false;   // el cupo ya se llenó con otros

  /*
   * Falta gente por elegir. Se completa la lista de una sola vez, no de a uno:
   * elegir por llamada dejaría el cupo a quien mandó mensaje primero, y el
   * primero suele ser quien menos lo necesita.
   */
  const necesitan = (_padron && typeof _padron.prioritarios === 'function') ? _padron.prioritarios() : [];
  const todos = (_padron && typeof _padron.telefonos === 'function') ? _padron.telefonos() : [];
  if (!todos.length) return false;

  const limpio = (x) => String(x).replace(/\D/g, '');
  const porHuella = (a, b) => huella(limpio(a)) - huella(limpio(b));
  const pri = necesitan.map(limpio).filter(Boolean).sort(porHuella);
  const resto = todos.map(limpio).filter((t) => t && !pri.includes(t)).sort(porHuella);

  const elegidos = [...new Set([...yaEstan, ...pri, ...resto])].slice(0, meta);
  _piloto = { meta, telefonos: elegidos };
  if (_guardaPiloto) _guardaPiloto.guardar(_piloto);
  return elegidos.includes(tel);
}

/*
 * ¿Está este teléfono entre los primeros `meta` del padrón?
 *
 * Repartir por proporción daba "más o menos 50": con 1,050 clientes salían 42,
 * y un trato que dice 50 tiene que dar 50. Aquí se ordenan todos los teléfonos
 * por su huella y se toman los primeros `meta`. El orden no depende del azar ni
 * de quién pregunte primero, así que el mismo cliente obtiene siempre la misma
 * respuesta, y subir el cupo solo agrega gente.
 *
 * El corte se calcula una vez y se guarda: hacerlo en cada mensaje de WhatsApp
 * sería ordenar mil teléfonos por cada "hola".
 */
let _corte = { para: '', valor: null };
function entreLosPrimeros(tel, meta) {
  const lista = (_padron && typeof _padron.telefonos === 'function') ? _padron.telefonos() : null;
  // Sin la lista completa no se puede ser exacto: se reparte por proporción,
  // que da un número cercano, y se sigue adelante.
  if (!lista || !lista.length) {
    const total = _padron ? Number(_padron.total()) || 0 : 0;
    return total ? dentroDelCupo(tel, Math.round((meta / total) * 10000)) : false;
  }

  const clave = meta + ':' + lista.length;
  if (_corte.para !== clave) {
    const huellas = lista
      .map((t) => huella(String(t).replace(/\D/g, '')))
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);
    // El valor del que quedó en el lugar `meta`: quien tenga una huella menor
    // está dentro, y son exactamente `meta` personas.
    _corte = { para: clave, valor: meta < huellas.length ? huellas[meta] : Infinity };
  }
  return huella(tel) < _corte.valor;
}

function huella(tel) {
  if (!tel) return -1;
  return crypto.createHash('sha256').update(tel).digest().readUInt32BE(0);
}

/*
 * Quiénes son los clientes. Lo sabe el servidor (la lista de Wisphub), no este
 * módulo, así que se le presta igual que el registro de clientes.
 */
let _padron = null;
function usarPadron(p) {
  if (p && typeof p.total === 'function') { _padron = p; _corte = { para: '', valor: null }; }
}

/**
 * Cuánto cobrarle al cliente por pagar `monto` por `forma`, en centavos.
 *
 * La forma es obligatoria a propósito. Un valor por omisión aquí significaría
 * cobrar la tarifa equivocada en silencio el día que alguien agregue una vía
 * nueva y olvide pasarla, y eso no se nota hasta que no cuadra la caja.
 */
function calcularCargo(monto, forma) {
  const t = TARIFAS[forma];
  if (!t) throw new Error(`Forma de pago desconocida: ${forma} (esperaba ${FORMAS.join(', ')})`);
  const base = Math.round(Number(monto) * 100);
  if (!Number.isFinite(base) || base <= 0) return null;
  const cargo = Math.round(t.fijo * 100 + t.pct * base);
  return { baseCentavos: base, cargoCentavos: cargo, totalCentavos: base + cargo, forma };
}

function hayLlave() {
  return !!(process.env.STRIPE_SECRET_KEY || '').trim();
}

/* ═══════════════ LA CUENTA A LA QUE LE CAE EL DINERO ═══════════════
 *
 * Hasta aquí, la cuenta de León vivía en una variable de entorno que alguien
 * tenía que crear a mano en el panel de Stripe y pegar en Render. O sea que él
 * no podía darla de alta solo: dependía de que alguien más se sentara a hacerlo
 * por él, y mientras tanto el cobro completo se quedaba apagado.
 *
 * Ahora puede hacerlo desde su panel. Lo que se guarda aquí manda; la variable
 * de entorno sigue funcionando igual, para no romper lo que ya esté puesto.
 */
let _cuenta = null;          // { id, puedeCobrar, revisadaEn }
let _guardaCuenta = null;

/** Le dice al módulo dónde guardar y leer la cuenta, igual que con el registro. */
function usarCuenta(io) {
  if (io && typeof io.obtener === 'function' && typeof io.guardar === 'function') {
    _guardaCuenta = io;
    const g = io.obtener();
    if (g && g.id) _cuenta = g;
  }
}

/** El id de la cuenta conectada: la del panel, o la de la variable de siempre. */
function cuentaConectada() {
  if (_cuenta && _cuenta.id) return _cuenta.id;
  return (process.env.LEON_STRIPE_CUENTA_CONECTADA || '').trim();
}

/**
 * ¿Ya PUEDE cobrar esa cuenta?
 *
 * Es distinto de que exista. Stripe la crea al instante y la habilita para
 * cobrar solo cuando termina de revisar los papeles. Cobrarle a un cliente
 * contra una cuenta a medio verificar acaba con el cargo rechazado DESPUÉS de
 * que la persona ya metió su tarjeta, y quien da la cara es León.
 */
function cuentaLista() {
  if (_cuenta && _cuenta.id) return !!_cuenta.puedeCobrar;
  // Con la variable de siempre se confía en quien la puso: es configuración
  // manual, no un alta de autoservicio.
  return !!(process.env.LEON_STRIPE_CUENTA_CONECTADA || '').trim();
}

/*
 * LA API v2, NO LA v1. Stripe dejó de aceptar `POST /v1/accounts` para
 * integraciones nuevas. La v2 pide JSON y una cabecera de versión obligatoria.
 */
const VERSION_V2 = process.env.STRIPE_VERSION_V2 || '2025-08-27.preview';
const API_V2 = (process.env.STRIPE_API_V2 || 'https://api.stripe.com/v2/').replace(/\/?$/, '/');

async function stripeV2(ruta, cuerpo, metodo = 'POST') {
  const llave = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!llave) throw new Error('Falta STRIPE_SECRET_KEY');
  const r = await fetch(API_V2 + ruta, {
    method: metodo,
    headers: {
      Authorization: 'Bearer ' + llave,
      'Content-Type': 'application/json',
      'Stripe-Version': VERSION_V2,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((datos.error && datos.error.message) || `Stripe respondió ${r.status}`);
    e.stripe = datos.error || null; e.status = r.status;
    throw e;
  }
  return datos;
}

/** Crea la cuenta de León en Stripe. Una sola vez: después solo se consulta. */
async function crearCuentaConectada({ email, nombre } = {}) {
  if (_cuenta && _cuenta.id) return _cuenta.id;
  const cuenta = await stripeV2('core/accounts', {
    contact_email: email || undefined,
    display_name: nombre || 'León Telecom',
    identity: { country: 'mx', entity_type: 'company' },
    include: ['configuration.merchant'],
    dashboard: 'express',
    defaults: {
      responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      currency: 'mxn',
    },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
  });
  _cuenta = { id: cuenta.id, puedeCobrar: false, revisadaEn: Date.now() };
  if (_guardaCuenta) _guardaCuenta.guardar(_cuenta);

  /*
   * Que Stripe le pague lo antes que pueda. Retiene unos días como ventana
   * contra contracargos y eso no se quita, pero pagar DIARIO en vez de semanal
   * es la diferencia entre que su dinero salga el día que se libera o que
   * espere al corte. Va aparte y sin romper nada: una cuenta creada vale más
   * que un calendario perfecto.
   */
  try {
    await stripe('accounts/' + encodeURIComponent(cuenta.id), {
      settings: { payouts: { schedule: { interval: 'daily', delay_days: 'minimum' } } },
    });
  } catch (e) { console.warn('[cobro] no se pudo poner el pago diario:', e.message); }

  return cuenta.id;
}

/** El enlace donde él llena sus datos y su banco, en el sitio de Stripe. */
async function enlaceOnboarding({ urlBase } = {}) {
  const id = cuentaConectada();
  if (!id) throw new Error('Todavía no hay cuenta que dar de alta');
  const base = String(urlBase || '').replace(/\/$/, '');
  const enlace = await stripeV2('core/account_links', {
    account: id,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant'],
        refresh_url: `${base}/cuenta-cobro?estado=reintentar`,
        return_url: `${base}/cuenta-cobro?estado=listo`,
      },
    },
  });
  return enlace.url;
}

/*
 * Dejar de dar por buena la cuenta.
 *
 * Se usa cuando Stripe contesta que ya no la reconoce. No se borra el id: se
 * marca como no lista, para que no se cobre contra ella pero siga a la vista
 * en el panel con su estado real. Borrarla haría que el sistema le pidiera dar
 * de alta otra, y acabaría con dos cuentas y el dinero partido.
 */
function olvidarCuenta() {
  if (_cuenta && _cuenta.id) {
    _cuenta = { ..._cuenta, puedeCobrar: false, revisadaEn: Date.now() };
    if (_guardaCuenta) _guardaCuenta.guardar(_cuenta);
  }
}

/** Le pregunta a Stripe cómo va esa cuenta, y lo recuerda. */
async function estadoCuenta() {
  const id = cuentaConectada();
  if (!id) return { id: '', existe: false, puedeCobrar: false, faltante: [] };
  const c = await stripe('accounts/' + encodeURIComponent(id));
  const est = {
    id,
    existe: true,
    puedeCobrar: !!c.charges_enabled,
    puedeRecibir: !!c.payouts_enabled,
    faltante: (c.requirements && c.requirements.currently_due) || [],
    banco: (((c.external_accounts || {}).data || [])[0] || {}).last4 || null,
    demora: ((c.settings || {}).payouts || {}).schedule?.delay_days ?? null,
  };
  if (_cuenta && _cuenta.id === id) {
    _cuenta = { ..._cuenta, puedeCobrar: est.puedeCobrar, revisadaEn: Date.now() };
    if (_guardaCuenta) _guardaCuenta.guardar(_cuenta);
  }
  return est;
}

async function aplanar(obj, prefijo = '', destino = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const llave = prefijo ? `${prefijo}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') aplanar(item, `${llave}[${i}]`, destino);
        else destino.append(`${llave}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      aplanar(v, llave, destino);
    } else {
      destino.append(llave, String(v));
    }
  }
  return destino;
}

/** Se puede apuntar a otro lado con `STRIPE_API_BASE` para pruebas (igual que aforo/cobro.js). */
const API_BASE = (process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1/').replace(/\/?$/, '/');

/*
 * `opciones.idempotencia` es lo que impide cobrar dos veces.
 *
 * Si la red se corta DESPUÉS de que Stripe cobró pero ANTES de que llegue su
 * respuesta, no hay forma de saber desde aquí si el cargo pasó o no. Sin esta
 * llave, el reintento es un segundo cargo real al cliente. Con ella, Stripe
 * reconoce la repetición y devuelve el MISMO cobro en vez de hacer otro.
 *
 * Importa sobre todo en `cobrarGuardado`, que confirma el cargo en la misma
 * llamada: ahí un reintento a ciegas le saca el dinero dos veces a alguien que
 * ni siquiera está frente al teléfono. Copiado de aforo/cobro.js, donde ya
 * estaba; este archivo lo había perdido al adaptarse.
 */
async function stripe(ruta, cuerpo, opciones = {}) {
  const llave = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!llave) throw new Error('Falta STRIPE_SECRET_KEY');
  const cabeceras = {
    Authorization: 'Bearer ' + llave,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (opciones.idempotencia) cabeceras['Idempotency-Key'] = String(opciones.idempotencia);
  const r = await fetch(API_BASE + ruta, {
    method: cuerpo ? 'POST' : 'GET',
    headers: cabeceras,
    body: cuerpo ? (await aplanar(cuerpo)).toString() : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((datos.error && datos.error.message) || `Stripe respondió ${r.status}`);
    e.stripe = datos.error || null;
    e.status = r.status;
    throw e;
  }
  return datos;
}

/**
 * Genera el link de pago de la mensualidad de un cliente.
 *
 * `monto` en PESOS (no centavos). La cuenta conectada de León Telecom recibe
 * el monto completo menos la comisión de Aforo — igual que un organizador de
 * Aforo recibe el precio del boleto íntegro y el cargo por servicio se separa
 * solo.
 *
 * Sin llave de idempotencia a propósito: hoy no hay un registro persistente de
 * "intento de pago" al que colgársela (a diferencia de una orden de Aforo, que
 * ya existe en la base antes de cobrar). Pedir el link dos veces por accidente
 * genera dos sesiones de Checkout distintas, no un cobro doble — el cliente
 * solo pagaría una. Si esto pasa a producción de verdad, vale la pena un
 * registro propio para tener la misma protección que `crearPago` en Aforo.
 */
/*
 * `telefono` es SIEMPRE el del dueño del servicio que se está pagando, no el
 * de quien saca la tarjeta. En un pueblo la gente paga el recibo del vecino,
 * del suegro o del changarro de al lado todo el tiempo, y quien paga suele
 * hacerlo desde SU propio celular. Si se abonara al que paga, el vecino se
 * queda cortado y al que pagó se le acredita un mes que no debía: el error
 * sería silencioso y del peor tipo, porque los dos creerían que ya quedó.
 * `pagadoPor` es solo para el registro y para avisarle a quien pagó.
 */
async function generarLinkPago({ telefono, monto, nombre, urlBase, pagadoPor, guardarTarjeta, clienteId, forma, servicioId, meses }) {
  const cuenta = cuentaConectada();
  if (!cuenta) throw new Error('Todavía no se ha dado de alta la cuenta a la que le cae el dinero');
  if (!cuentaLista()) throw new Error('La cuenta de cobro todavía no está aprobada por Stripe');

  /*
   * UNA forma por link, no las dos en el mismo.
   *
   * Antes el link dejaba elegir tarjeta u OXXO dentro de Stripe, y con una
   * tarifa pareja daba igual. Ya no: OXXO cuesta más que la tarjeta, así que
   * si el cliente eligiera adentro, el cargo cobrado no sería el de la forma
   * que usó. Se le pregunta ANTES, en WhatsApp, y el link ya viene amarrado.
   */
  if (forma !== 'tarjeta' && forma !== 'oxxo') {
    throw new Error(`generarLinkPago espera forma 'tarjeta' u 'oxxo', llegó: ${forma}`);
  }

  /*
   * Guardar la tarjeta exige un cliente de Stripe al cual pegársela.
   *
   * Sin `customer`, Stripe acepta la sesión y cobra igual, pero la tarjeta
   * queda suelta y NO sirve para cobrar el mes que viene. El fallo sería
   * invisible hoy y aparecería dentro de treinta días, cuando el cobro
   * automático que el cliente aceptó simplemente no ocurra y nadie sepa por
   * qué. Mejor no dejar salir el link.
   */
  if (guardarTarjeta && !clienteId) {
    throw new Error('Para guardar la tarjeta hace falta el cliente de Stripe (clienteId)');
  }

  const c = calcularCargo(monto, forma);
  if (!c) throw new Error('Monto inválido: ' + monto);

  const sesion = await stripe('checkout/sessions', {
    mode: 'payment',
    // Solo la forma que el cliente ya eligió: es la que se le cotizó.
    payment_method_types: [forma === 'oxxo' ? 'oxxo' : 'card'],
    /*
     * Dos renglones separados a propósito: el cliente VE cuánto es su
     * mensualidad y cuánto el cargo por pagar en línea. Sin letras chiquitas,
     * igual que en la página de Aforo.
     */
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: c.baseCentavos,
          product_data: {
            name: (Number(meses) || 1) > 1 ? `Internet · ${Number(meses)} meses · León Telecom` : 'Mensualidad de internet · León Telecom',
            description: nombre ? `A nombre de ${nombre}` : undefined,
          },
        },
      },
      {
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: c.cargoCentavos,
          product_data: {
            name: forma === 'oxxo' ? 'Cargo por pagar en OXXO' : 'Cargo por pagar con tarjeta',
          },
        },
      },
    ],
    customer: clienteId || undefined,
    metadata: {
      telefono: String(telefono), pagadoPor: String(pagadoPor || telefono),
      tipo: 'mensualidad-leontelecom',
      // El contrato exacto que se paga, cuando el teléfono tiene varios.
      ...(servicioId ? { servicioId: String(servicioId) } : {}),
      // Con qué tarifa se cotizó, para poder cuadrar después.
      forma,
      // Para que el webhook sepa que hay que recordar la tarjeta de este cliente.
      guardarTarjeta: guardarTarjeta ? 'si' : 'no',
      /*
       * La mensualidad SIN el cargo por servicio.
       *
       * Stripe manda `amount_total`, que trae los dos renglones sumados. Si el
       * webhook aplicara eso a la factura, abonaría el cargo como si fuera
       * parte del pago del internet: la factura recibiría de más y cada pago
       * dispararía una falsa alerta de "pagó de más". El cargo es nuestro, no
       * de León Telecom.
       */
      mensualidad: String(c.baseCentavos),
      // Cuántos meses cubre este pago (1 = solo el que toca).
      meses: String(Math.max(1, Number(meses) || 1)),
    },
    payment_intent_data: {
      metadata: { telefono: String(telefono), pagadoPor: String(pagadoPor || telefono), tipo: 'mensualidad-leontelecom', forma, ...(servicioId ? { servicioId: String(servicioId) } : {}) },
      description: `Mensualidad León Telecom · ${nombre || telefono}`,
      /*
       * Stripe transfiere a la cuenta conectada el total MENOS la comisión de
       * plataforma. Como el total ya trae el cargo sumado, León Telecom acaba
       * recibiendo exactamente su precio de plan, íntegro. El costo real de
       * Stripe se descuenta del lado de la plataforma —del cargo—, no de su
       * dinero: mismo trato que un organizador en Aforo.
       */
      application_fee_amount: c.cargoCentavos,
      transfer_data: { destination: cuenta },
      /*
       * QUIÉN RESPONDE POR UN CONTRACARGO.
       *
       * Sin `on_behalf_of`, la plataforma es el comercio ante el banco y se
       * come las disputas: si un cliente desconoce el cargo de SU internet,
       * el dinero y la penalización salen de la cuenta de OBEX, por un
       * servicio que ni siquiera presta.
       *
       * Con esto, el comercio ante el banco es León Telecom, que es quien de
       * verdad vendió el servicio. Además el cargo aparece a su nombre en el
       * estado de cuenta del cliente, y eso mismo evita disputas: la mayoría
       * nace de no reconocer el nombre que salió en la tarjeta.
       */
      on_behalf_of: cuenta,
      /*
       * Guardar la tarjeta para cobrarle solo los meses siguientes. Va SOLO si
       * el cliente lo pidió: `guardarTarjeta` llega en true únicamente desde el
       * camino donde ya aceptó el cobro automático, con el aviso enfrente.
       * Ponerlo siempre "por si acaso" sería guardar la tarjeta de gente que
       * nunca dijo que sí.
       */
      // Solo con tarjeta: una ficha de OXXO no se puede volver a cobrar, y
      // mandarlo en ese caso hace que Stripe rechace la sesión entera.
      setup_future_usage: (guardarTarjeta && forma === 'tarjeta') ? 'off_session' : undefined,
    },
    // 32 min, no 30: entre que se calcula aquí y llega a Stripe pasan segundos,
    // y pedir justo el mínimo puede quedar por debajo y ser rechazado.
    expires_at: Math.floor(Date.now() / 1000) + 32 * 60,
    success_url: `${urlBase || 'https://leontelecom.com'}/pago-exitoso.html`,
    cancel_url: `${urlBase || 'https://leontelecom.com'}/pago-cancelado.html`,
    locale: 'es-419',
  });

  return {
    url: sesion.url, sesionId: sesion.id, forma,
    // Lo que ve el cliente desglosado, en pesos, para poder decírselo por WhatsApp.
    mensualidad: c.baseCentavos / 100,
    cargo: c.cargoCentavos / 100,
    total: c.totalCentavos / 100,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  LA CLABE DE POR VIDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stripe genera UNA cuenta bancaria virtual por cliente la primera vez, y TODAS
 * sus transferencias futuras llegan ahí. Eso es justo lo que necesita un ISP: el
 * cliente la guarda una vez en su banco —o la lleva anotada a la ventanilla— y
 * cada mes deposita al mismo lugar, sin links que caduquen. Stripe reconoce de
 * quién viene el dinero por la CLABE misma y lo concilia solo.
 *
 * ── Por qué hay un registro local y no basta con `customers/search` ──────────
 *
 * La búsqueda de Stripe NO es inmediata: un cliente recién creado tarda en
 * aparecer en el índice (Stripe documenta hasta ~1 minuto). Si dos peticiones
 * caen dentro de esa ventana —el cliente le picó dos veces al botón, o Render
 * levantó una segunda instancia— la segunda no encuentra al primero y crea OTRO
 * cliente, con OTRA CLABE.
 *
 * Y ese es el peor error posible aquí, porque es silencioso y tardío: el cliente
 * ya anotó la primera CLABE en su banco, sigue depositando ahí durante meses, y
 * el dinero entra a un Customer distinto del que el sistema consulta. Nadie se
 * entera hasta que alguien reclama que pagó y aparece como moroso.
 *
 * Por eso el registro local manda y la búsqueda es solo el respaldo:
 *
 *   1. registro local  → instantáneo y confiable (se persiste con el estado)
 *   2. customers/search → por si el registro se perdió (base nueva, migración)
 *   3. crear el cliente → solo si de verdad no existe en ningún lado
 *
 * El registro se inyecta desde index.js para que este archivo no sepa nada de
 * cómo se guardan las cosas, y se pueda probar sin base de datos.
 */

/*
 * Dónde se recuerda qué Customer de Stripe es cada teléfono.
 *
 * Arranca en memoria para que el módulo funcione solo (y en pruebas). index.js
 * le pasa uno persistente con `usarRegistro`, y entonces sobrevive a los
 * reinicios de Render, que es lo que de verdad hace falta.
 */
let _registro = {
  obtener: (tel) => _memoria.get(tel) || null,
  guardar: (tel, datos) => { _memoria.set(tel, datos); },
};
const _memoria = new Map();

function usarRegistro(reg) {
  if (reg && typeof reg.obtener === 'function' && typeof reg.guardar === 'function') _registro = reg;
}

/*
 * Candado por teléfono mientras se le crea su cliente.
 *
 * Sin esto, dos toques seguidos al botón entran a la vez, los dos ven "no
 * existe" y los dos crean un Customer. El segundo pisa al primero en el
 * registro y la CLABE que ya se le enseñó al cliente queda huérfana. Con el
 * candado, el segundo espera al primero y los dos devuelven la misma.
 */
const _enVuelo = new Map();

/** Una CLABE mexicana son 18 dígitos, ni uno más ni uno menos. */
function clabeValida(c) {
  return /^\d{18}$/.test(String(c || ''));
}

/*
 * UNA CLABE POR SERVICIO, NO POR TELÉFONO.
 *
 * 26 teléfonos del padrón tienen más de un contrato. Con una sola CLABE por
 * teléfono, un depósito no dice cuál de los dos se está pagando y alguien lo
 * tiene que adivinar. Con `servicioId`, la CLABE es de ESE servicio: quien
 * deposite ahí está pagando ese contrato y ningún otro, aunque lo pague la
 * abuela desde otro banco. La clave del registro y el cliente de Stripe llevan
 * el servicio; sin `servicioId` todo sigue igual que antes (una por teléfono).
 */
function claveDeRegistro(tel, servicioId) {
  return servicioId ? `${tel}~${String(servicioId).replace(/\D/g, '')}` : tel;
}
function partirClave(clave) {
  const [tel, servicioId] = String(clave || '').split('~');
  return { tel: tel || '', servicioId: servicioId || '' };
}

async function clabeDelCliente({ telefono, nombre, servicioId }) {
  if (!activo()) throw new Error('El cobro en línea está apagado');
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) throw new Error('Falta el teléfono');
  const clave = claveDeRegistro(tel, servicioId);

  if (_enVuelo.has(clave)) return _enVuelo.get(clave);
  const trabajo = (async () => {
    const guardado = await _registro.obtener(clave);

    /*
     * Si ya se le había entregado una CLABE, se devuelve ESA y no se le vuelve
     * a preguntar nada a Stripe. Es el caso normal a partir del segundo mes, y
     * es también el que garantiza que nunca cambie: mientras el registro la
     * tenga, no hay camino de código que pueda darle otra.
     */
    if (guardado && guardado.clienteId && clabeValida(guardado.clabe)) return guardado;

    let clienteId = guardado && guardado.clienteId;

    if (!clienteId) {
      // Respaldo: quizá el cliente ya existe en Stripe y lo que se perdió fue
      // el registro. Buscarlo evita crear un duplicado.
      try {
        const consulta = servicioId
          ? `metadata['telefono']:'${tel}' AND metadata['servicioId']:'${String(servicioId).replace(/\D/g, '')}'`
          : `metadata['telefono']:'${tel}'`;
        const busca = await stripe(`customers/search?query=${encodeURIComponent(consulta)}`);
        // Sin servicio, solo sirve un cliente que tampoco tenga servicio: el de
        // un servicio concreto no es "el del teléfono".
        const candidatos = (busca.data || []).filter((c) => servicioId || !((c.metadata || {}).servicioId));
        clienteId = (candidatos[0] || {}).id || null;
      } catch (e) {
        // Que la búsqueda falle no debe impedir cobrar: se sigue al alta.
        console.warn('[stripe-leon] no se pudo buscar el cliente', tel, '·', e.message);
      }
    }

    if (!clienteId) {
      const creado = await stripe('customers', {
        name: nombre || tel,
        metadata: { telefono: tel, origen: 'leontelecom', ...(servicioId ? { servicioId: String(servicioId).replace(/\D/g, '') } : {}) },
      }, {
        // Mismo teléfono (y servicio) = mismo cliente, aunque la petición se repita.
        idempotencia: 'leon-cliente-' + clave,
      });
      clienteId = creado.id;
    }

    const fondeo = await stripe(`customers/${clienteId}/funding_instructions`, {
      currency: 'mxn',
      funding_type: 'bank_transfer',
      bank_transfer: { type: 'mx_bank_transfer' },
    });

    const banco = (fondeo.bank_transfer && fondeo.bank_transfer.financial_addresses
      && fondeo.bank_transfer.financial_addresses[0]) || {};
    const spei = banco.spei || {};
    const datos = {
      clienteId,
      clabe: String(spei.clabe || ''),
      banco: String(spei.bank_name || ''),
      referencia: String(spei.reference || ''),
      /*
       * A nombre de quién sale la cuenta.
       *
       * La CLABE la emite el banco socio de Stripe (normalmente STP), así que
       * el beneficiario NO tiene por qué decir "León Telecom". Y eso importa:
       * en ventanilla varios cajeros piden que el nombre coincida con a quién
       * dices que le pagas, y si no coincide se niegan.
       *
       * Se guarda lo que Stripe devuelva, sea lo que sea, y el bot enseña ESO.
       * Inventar el nombre sería mandar a la gente al banco a que la rechacen.
       */
      beneficiario: String(spei.account_holder_name || banco.account_holder_name || ''),
    };

    /*
     * Una CLABE incompleta NO se entrega.
     *
     * Darle al cliente una cuenta a medias es peor que decirle "ahorita no
     * puedo": se va al banco, la transferencia rebota o —peor— cae en una
     * cuenta que no es, y el dinero anda perdido semanas. Si Stripe no
     * devolvió los 18 dígitos, esto falla fuerte y el bot le dice que pague
     * como siempre.
     */
    if (!clabeValida(datos.clabe)) {
      throw new Error('Stripe no devolvió una CLABE válida para ' + tel);
    }

    if (servicioId) datos.servicioId = String(servicioId).replace(/\D/g, '');
    await _registro.guardar(clave, datos);
    return datos;
  })().finally(() => _enVuelo.delete(clave));

  _enVuelo.set(clave, trabajo);
  return trabajo;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  COBRO AUTOMÁTICO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Guardar la tarjeta hoy para cobrarle solo el mes que viene.
 *
 * NO se activa a escondidas: el cliente tiene que pedirlo, y el texto que ve
 * antes de aceptar debe decir con esas palabras que se le va a cobrar cada mes
 * y cómo se cancela. Cobrarle a alguien sin que lo haya pedido es la forma más
 * rápida de perder la confianza de un pueblo, y aquí todos se conocen.
 *
 * Por eso `generarLinkPago` solo guarda la tarjeta si se le pasa
 * `guardarTarjeta: true`, y eso solo pasa por el camino donde el cliente ya
 * aceptó.
 */

/**
 * Le cobra a una tarjeta ya guardada, sin que el cliente esté presente.
 *
 * `referencia` es lo que hace segura la reintentabilidad: dos llamadas con la
 * misma referencia son UN cobro para Stripe. Se arma con el teléfono y el
 * periodo (`2026-09`), así que reintentar el cobro de septiembre —porque se
 * cayó la red, porque el proceso se reinició a medias— nunca puede cobrar dos
 * veces ese mes. Sin esto, un timeout de red le saca el dinero dos veces a
 * alguien que ni está viendo el teléfono, y de eso se entera hasta el estado
 * de cuenta.
 *
 * Devuelve `{ ok, estado, ... }` en vez de lanzar cuando el banco rechaza:
 * `authentication_required` (el banco pide 3DS) y `card_declined` no son
 * errores del programa, son el resultado normal de un cobro que no pasó, y hay
 * que poder avisarle al cliente con calma en vez de tronar.
 */
async function cobrarGuardado({ clienteId, metodoPago, monto, telefono, nombre, periodo }) {
  if (!activo()) throw new Error('El cobro en línea está apagado');
  const cuenta = cuentaConectada();
  if (!cuenta) throw new Error('Todavía no se ha dado de alta la cuenta a la que le cae el dinero');
  if (!cuentaLista()) throw new Error('La cuenta de cobro todavía no está aprobada por Stripe');
  if (!clienteId) throw new Error('Falta el cliente de Stripe');
  if (!metodoPago) throw new Error('Falta la tarjeta guardada');
  const c = calcularCargo(monto, 'tarjeta');   // se cobra a una tarjeta guardada
  if (!c) throw new Error('Monto inválido: ' + monto);

  const tel = String(telefono || '').replace(/\D/g, '');
  // El periodo por defecto es el mes en curso: un cobro mensual, una llave.
  const per = String(periodo || new Date().toISOString().slice(0, 7));
  const referencia = `leon-auto-${tel}-${per}`;

  try {
    const pi = await stripe('payment_intents', {
      amount: c.totalCentavos,
      currency: 'mxn',
      customer: clienteId,
      payment_method: metodoPago,
      off_session: true,
      confirm: true,
      description: `Mensualidad León Telecom (automático) · ${nombre || tel}`,
      metadata: {
        telefono: tel, pagadoPor: tel,
        tipo: 'mensualidad-leontelecom', automatico: 'si', periodo: per,
      },
      application_fee_amount: c.cargoCentavos,
      transfer_data: { destination: cuenta },
      /*
       * QUIÉN RESPONDE POR UN CONTRACARGO.
       *
       * Sin `on_behalf_of`, la plataforma es el comercio ante el banco y se
       * come las disputas: si un cliente desconoce el cargo de SU internet,
       * el dinero y la penalización salen de la cuenta de OBEX, por un
       * servicio que ni siquiera presta.
       *
       * Con esto, el comercio ante el banco es León Telecom, que es quien de
       * verdad vendió el servicio. Además el cargo aparece a su nombre en el
       * estado de cuenta del cliente, y eso mismo evita disputas: la mayoría
       * nace de no reconocer el nombre que salió en la tarjeta.
       */
      on_behalf_of: cuenta,
    }, { idempotencia: referencia });

    return {
      ok: pi.status === 'succeeded',
      estado: pi.status,
      id: pi.id,
      referencia,
      mensualidad: c.baseCentavos / 100,
      cargo: c.cargoCentavos / 100,
      total: c.totalCentavos / 100,
    };
  } catch (e) {
    /*
     * El banco pidió que el cliente confirme (3DS) o rechazó la tarjeta. No es
     * una avería: es la respuesta. Se devuelve para que el bot le escriba
     * "no pasó tu tarjeta, paga por aquí" con un link normal, en vez de que el
     * cobro se caiga en silencio y el cliente amanezca cortado.
     */
    const codigo = (e.stripe && e.stripe.code) || '';
    if (codigo === 'authentication_required' || codigo === 'card_declined'
        || (e.stripe && e.stripe.type === 'card_error')) {
      return {
        ok: false,
        estado: 'rechazado',
        motivo: codigo || 'card_error',
        necesitaAlCliente: codigo === 'authentication_required',
        mensaje: (e.stripe && e.stripe.message) || e.message,
        referencia,
      };
    }
    throw e;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  BARRER EL SALDO DE LA CLABE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una transferencia SPEI a la CLABE NO le llega a León Telecom por sí sola: cae
 * en el saldo del cliente dentro de Stripe y ahí se queda. Hay que cobrarla,
 * y ese cobro es el que la parte.
 *
 * Comprobado contra la API real (6 sep 2026) con un depósito de $470:
 *
 *   cobrado            $470.00
 *   comisión de OBEX    $30.00   (se queda en la plataforma)
 *   comisión de Stripe   $8.12   (el fijo de SPEI)
 *   a León Telecom     $440.00   (su plan íntegro)
 *
 * ── De dónde sale la comisión ───────────────────────────────────────────────
 *
 * SOLO de lo que el cliente depositó DE MÁS sobre su deuda. Si transfirió justo
 * el precio de su plan porque se le olvidó el cargo, la comisión es cero y León
 * recibe todo: quedarnos $20 de ahí sería cobrarle al ISP una comodidad que su
 * cliente no pagó, y eso descuadra su cobranza sin que él lo sepa.
 *
 * ── Lo que NO se puede ──────────────────────────────────────────────────────
 *
 * `on_behalf_of` no lo admite este método de pago (Stripe lo rechaza con ese
 * mensaje exacto). O sea que en las transferencias la plataforma queda como
 * comercio. No preocupa como en tarjeta: un SPEI no se puede contracargar,
 * es irreversible por diseño.
 */
async function cobrarDelSaldo({ clienteId, deposito, deuda, telefono, nombre, referencia }) {
  if (!activo()) throw new Error('El cobro en línea está apagado');
  const cuenta = cuentaConectada();
  if (!cuenta) throw new Error('Todavía no se ha dado de alta la cuenta a la que le cae el dinero');
  if (!cuentaLista()) throw new Error('La cuenta de cobro todavía no está aprobada por Stripe');
  if (!clienteId) throw new Error('Falta el cliente de Stripe');

  const depositoCent = Math.round(Number(deposito) * 100);
  if (!Number.isFinite(depositoCent) || depositoCent <= 0) throw new Error('Depósito inválido');

  /*
   * La comisión sale del excedente, nunca de lo que el cliente quiso pagarle a
   * León. Si depositó justo su plan, la comisión es cero.
   */
  const deudaCent = Math.max(0, Math.round((Number(deuda) || 0) * 100));
  const cargoIdeal = calcularCargo(deuda || 0, 'clabe');
  const excedente = deudaCent > 0 ? Math.max(0, depositoCent - deudaCent) : 0;
  const comision = deudaCent > 0
    ? Math.min(cargoIdeal ? cargoIdeal.cargoCentavos : 0, excedente)
    : 0;

  const pi = await stripe('payment_intents', {
    amount: depositoCent,
    currency: 'mxn',
    customer: clienteId,
    payment_method_types: ['customer_balance'],
    payment_method_data: { type: 'customer_balance' },
    confirm: true,
    description: `Mensualidad León Telecom (transferencia) · ${nombre || telefono}`,
    metadata: {
      telefono: String(telefono || ''), pagadoPor: String(telefono || ''),
      tipo: 'mensualidad-leontelecom', via: 'clabe',
      mensualidad: String(Math.max(0, depositoCent - comision)),
    },
    ...(comision > 0 ? { application_fee_amount: comision } : {}),
    transfer_data: { destination: cuenta },
  }, {
    // La llave es el movimiento de saldo: si Stripe reenvía el mismo aviso, el
    // barrido no se hace dos veces.
    idempotencia: 'saldo-' + String(referencia || clienteId),
  });

  return {
    ok: pi.status === 'succeeded',
    estado: pi.status,
    id: pi.id,
    cobrado: depositoCent / 100,
    comision: comision / 100,
    aLeonTelecom: (depositoCent - comision) / 100,
    // Se avisa cuando no se pudo cobrar comisión: no es un error, pero el
    // dueño querrá saber por qué ese pago no dejó nada.
    sinComision: comision === 0,
  };
}

/*
 * De vuelta del cliente de Stripe al teléfono, preguntándole a Stripe.
 *
 * El registro local es quien dice qué Customer es cada teléfono, y se persiste.
 * Pero si ese registro se perdiera —una base nueva, una migración a medias— un
 * depósito a la CLABE llegaría de un Customer que el sistema ya no reconoce, y
 * el dinero se quedaría sin poder abonárselo a nadie.
 *
 * No hace falta que sea así: cada Customer se creó con el teléfono en su
 * metadata, así que Stripe SIEMPRE sabe de quién es. Esto lo va a preguntar.
 */
async function obtenerCliente(clienteId) {
  if (!clienteId) throw new Error('Falta el cliente de Stripe');
  return stripe(`customers/${encodeURIComponent(clienteId)}`);
}

/*
 * ¿Cuánto dinero de este cliente sigue guardado DENTRO de Stripe?
 *
 * Una transferencia a la CLABE no le llega a León Telecom sola: cae en el saldo
 * del cliente dentro de Stripe y ahí se queda hasta que alguien la cobre. Lo
 * normal es que la cobre el webhook en cuanto entra, pero ese barrido puede
 * fallar —Stripe intermitente, Render reiniciando, un aviso que se perdió— y
 * entonces el dinero se queda ahí: no se pierde, pero tampoco llega, y nadie
 * se entera hasta que el cliente reclama que ya pagó.
 *
 * Esto es lo que permite ir a buscarlo después. Devuelve PESOS, no centavos.
 */
async function saldoDisponible(clienteId) {
  if (!clienteId) throw new Error('Falta el cliente de Stripe');
  const cb = await stripe(`customers/${encodeURIComponent(clienteId)}/cash_balance`);
  const centavos = (cb && cb.available && cb.available.mxn) || 0;
  return (Number(centavos) || 0) / 100;
}

/*
 * El identificador del último movimiento del saldo de un cliente.
 *
 * Sirve para ponerle nombre propio a un depósito cuando se rescata a
 * destiempo. Cuando el aviso llega bien, ese nombre es el id del movimiento
 * que trae el propio aviso; cuando hay que ir a buscar el dinero después, el
 * aviso no está y hace falta preguntarlo.
 *
 * Importa porque ese nombre es la llave que impide cobrar dos veces. Una llave
 * armada con el monto y la fecha parecería suficiente y NO lo es: si el mismo
 * cliente deposita dos veces la misma cantidad el mismo día —dos meses que
 * paga por separado, o un familiar que paga sin avisar— las dos veces darían
 * la misma llave, Stripe devolvería el primer cobro como si fuera el segundo, y
 * el segundo depósito se quedaría atorado sin que nadie lo notara. El id del
 * movimiento es distinto para cada depósito, siempre.
 */
async function ultimoMovimientoSaldo(clienteId) {
  if (!clienteId) throw new Error('Falta el cliente de Stripe');
  const r = await stripe(`customers/${encodeURIComponent(clienteId)}/cash_balance_transactions?limit=1`);
  return (r && r.data && r.data[0] && r.data[0].id) || '';
}

/** Firma del webhook de Stripe — mismo HMAC que aforo/cobro.js, comparación en tiempo constante. */
function verificarFirma(cuerpoCrudo, cabecera, secreto, toleranciaSeg = 300) {
  if (!cuerpoCrudo || !cabecera || !secreto) return false;
  const partes = String(cabecera).split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k === 't') acc.t = v;
    if (k === 'v1') (acc.v1 = acc.v1 || []).push(v);
    return acc;
  }, {});
  if (!partes.t || !partes.v1) return false;

  const edad = Math.abs(Math.floor(Date.now() / 1000) - Number(partes.t));
  if (!Number.isFinite(edad) || edad > toleranciaSeg) return false;

  const esperado = crypto
    .createHmac('sha256', secreto)
    .update(`${partes.t}.${cuerpoCrudo}`, 'utf8')
    .digest('hex');

  return partes.v1.some((firma) => {
    const a = Buffer.from(esperado, 'utf8');
    const b = Buffer.from(String(firma), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = {
  claveDeRegistro, partirClave,
  hayLlave, activo, permitido, usarRegistro, usarCuenta, usarPadron, usarPiloto,
  cuentaConectada, cuentaLista, crearCuentaConectada, enlaceOnboarding, estadoCuenta, olvidarCuenta,
  generarLinkPago, clabeDelCliente, cobrarGuardado, cobrarDelSaldo, saldoDisponible, obtenerCliente, ultimoMovimientoSaldo,
  verificarFirma, calcularCargo, clabeValida,
  TARIFAS, FORMAS,
};
