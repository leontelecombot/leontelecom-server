'use strict';

/**
 * REACTIVACIÓN AUTOMÁTICA EN WISPHUB
 *
 * Cuando entra un pago en línea, esto hace dos cosas, en este orden:
 *   1. registra el pago en la factura del cliente
 *   2. le pide a Wisphub que reactive el servicio
 *
 * Los dos pasos hacen falta. Se comprobó contra la API real (5 sep 2026) que
 * `auto_activar_servicio` viene en `false` para TODOS los clientes, así que
 * pagar la factura por sí solo NO reconecta a nadie.
 *
 * ── Por qué se usa el endpoint dedicado y no se edita al cliente ────────────
 *
 * La forma obvia sería `PUT /api/clientes/{id}/` con `estado: "Activo"`. Es una
 * trampa: ese endpoint exige DIECISÉIS campos obligatorios, entre ellos objetos
 * anidados (`router`, `plan_internet`, `zona`, `sectorial`, `modelo_antena`).
 * Su propia documentación dice que escribe "en base de datos y en el RB", o sea
 * que empuja la configuración al router. Un PUT al que le falte un campo puede
 * dejar a un cliente real sin plan, sin zona o sin router.
 *
 * En su lugar se usa `POST /api/clientes/activar/`, que existe justo para esto,
 * recibe una lista de servicios y no toca nada más.
 *
 * ── Por qué no puede cortar a nadie por error ───────────────────────────────
 *
 * `activar` y `desactivar` son endpoints SEPARADOS (comprobado). Este archivo
 * solo conoce el de activar. Aunque se le llamara mil veces a un cliente que ya
 * está activo, lo peor que pasa es que no pase nada: no hay forma de que una
 * llamada de aquí deje a alguien sin internet.
 */
const WISPHUB_API_URL = (process.env.WISPHUB_API_URL || 'https://api.wisphub.net').replace(/\/$/, '');
const LLAVE = () => (process.env.WISPHUB_API_KEY || '').trim();

/**
 * El interruptor propio.
 *
 * Aparte de `COBRO_LINEA_ACTIVO`. Se puede tener el cobro encendido y la
 * reactivación apagada, que es justo como conviene arrancar: primero se
 * comprueba durante unos días que los pagos entran bien, y solo después se le
 * deja tocar el servicio de la gente.
 */
function activo() {
  return String(process.env.WISPHUB_REACTIVAR_ACTIVO || 'false').trim() === 'true';
}

async function wh(ruta, opciones = {}) {
  const llave = LLAVE();
  if (!llave) throw new Error('Falta WISPHUB_API_KEY');
  const r = await fetch(`${WISPHUB_API_URL}/api/${ruta}`, {
    method: opciones.metodo || 'GET',
    headers: {
      Authorization: 'Api-Key ' + llave,
      'Content-Type': 'application/json',
    },
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
    signal: AbortSignal.timeout(opciones.msLimite || 20000),
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((datos.detail || JSON.stringify(datos)).slice(0, 200));
    e.status = r.status; e.datos = datos;
    throw e;
  }
  return datos;
}

/**
 * Busca los servicios de un teléfono.
 *
 * ── El formato ──────────────────────────────────────────────────────────────
 *
 * Wisphub guarda los teléfonos a DIEZ dígitos (`9516549145`); WhatsApp los
 * entrega con el país (`529516549145`). Buscar con el de WhatsApp devuelve CERO
 * resultados, comprobado. Por eso se prueban las dos formas.
 *
 * ── Un teléfono puede tener VARIOS servicios ────────────────────────────────
 *
 * En el padrón de León Telecom hay 26 teléfonos con más de un servicio: 53
 * contratos en total. A veces es la misma persona con dos casas, y a veces son
 * dos personas distintas compartiendo un teléfono (hay un caso con dos nombres
 * diferentes).
 *
 * Devolver "el primero" era una moneda al aire. Con Yaretzi, que tiene tres
 * servicios y uno suspendido, se habría reactivado uno que YA estaba activo y
 * el cortado seguiría cortado: la persona paga, no le vuelve el internet, y en
 * el sistema todo se ve bien.
 */
async function buscarPorTelefono(telefono) {
  const s = await serviciosDe(telefono);
  return s.servicios[0] || null;
}

async function serviciosDe(telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return { servicios: [], ambiguo: false };
  const formas = [tel];
  if (tel.length === 12 && tel.startsWith('52')) formas.push(tel.slice(2));
  if (tel.length === 13 && tel.startsWith('521')) formas.push(tel.slice(3));

  let encontrados = [];
  for (const f of formas) {
    try {
      const d = await wh(`clientes/?format=json&limit=10&telefono=${encodeURIComponent(f)}`);
      if ((d.results || []).length) { encontrados = d.results; break; }
    } catch (e) {
      console.warn('[wisphub] buscando', f, '·', e.message);
    }
  }
  if (!encontrados.length) return { servicios: [], ambiguo: false };

  /*
   * Con varios servicios manda el SUSPENDIDO: es el que la persona está
   * pagando para recuperar. Nadie paga con prisa por un servicio que ya
   * funciona.
   *
   * Si hay más de uno suspendido no se adivina: se marca ambiguo y lo resuelve
   * una persona. Reactivar el equivocado deja al cliente igual de cortado y
   * además abona su dinero a la cuenta que no era.
   */
  const cortado = (c) => c.estado !== 'Activo' && c.estado !== 'Gratis';
  const suspendidos = encontrados.filter(cortado);

  /*
   * Se devuelven TODOS, con los suspendidos primero. `servicios[0]` sigue
   * siendo el mejor candidato, y quien tenga que decidir a mano ve el panorama
   * completo: saber que además hay uno activo es justo lo que le falta para
   * elegir bien.
   */
  const orden = [...suspendidos, ...encontrados.filter((c) => !cortado(c))];
  return {
    servicios: orden,
    ambiguo: encontrados.length > 1 && suspendidos.length !== 1,
    total: encontrados.length,
  };
}

/**
 * Lo que el cliente debe, según Wisphub.
 *
 * ── Por qué NO se usa el campo `saldo` ──────────────────────────────────────
 *
 * Parece el campo obvio y es una trampa. En la instalación de León Telecom
 * `saldo` viene en **0.00 en TODAS las facturas**, pagadas y pendientes por
 * igual, y `total_cobrado` ya viene igual a `total` aunque nadie haya pagado.
 * Comprobado el 5 sep 2026 contra la API real.
 *
 * O sea que filtrar por `saldo > 0` no encuentra NUNCA una factura, y una
 * primera versión de este archivo hacía justo eso: no habría cobrado nada y
 * —peor— habría reactivado a todo el mundo, porque una deuda de cero se ve
 * igual que estar al corriente.
 *
 * Lo único que dice la verdad es `estado`, y la deuda es la suma de `total` de
 * las facturas pendientes.
 *
 * ── Las dos trampas del filtro ─────────────────────────────────────────────
 *
 *   `cliente` recibe el USUARIO (`1493lunamejia@redwifi`), no el id de
 *   servicio. Con el id devuelve cero, sin avisar de nada.
 *
 *   `estado` recibe un NÚMERO: 1=Pendiente, 2=Pagada, 3=Cancelada,
 *   4=Revisión, 5=Transferida. Con texto devuelve cero.
 *
 *   `desde`/`hasta` traen por omisión el MES ACTUAL. Se mandan explícitos y
 *   amplios porque quien está suspendido debe justamente de meses anteriores:
 *   sin eso, el cliente que más necesita reconectarse es el único que no
 *   aparecería.
 */
async function deudaDelCliente(usuario) {
  const d = await wh('facturas/?format=json&limit=100'
    + `&cliente=${encodeURIComponent(usuario)}&estado=1&desde=2015-01-01&hasta=2035-12-31`);
  const pendientes = (d.results || []).sort(
    (a, b) => String(a.fecha_vencimiento || '').localeCompare(String(b.fecha_vencimiento || '')));
  return {
    facturas: pendientes,
    total: +pendientes.reduce((a, f) => a + (Number(f.total) || 0), 0).toFixed(2),
  };
}

/**
 * Intenta marcar una factura como pagada, y COMPRUEBA si de verdad quedó.
 *
 * En la API, `estado` de la factura está declarado de solo lectura y no existe
 * ningún endpoint de pagos (se buscaron nueve nombres distintos). O sea que
 * probablemente NO se pueda marcar desde aquí.
 *
 * Aun así se intenta, y después se vuelve a leer la factura para ver qué pasó.
 * Devuelve la verdad, no la intención: si el estado no cambió, lo dice, y quien
 * llama avisa a la oficina para que lo registren a mano. Dar por hecho que
 * quedó pagada sin comprobarlo sería dejar facturas cobradas apareciendo como
 * deuda, y a un cliente que ya pagó recibiendo recordatorios de corte.
 */
async function intentarMarcarPagada({ idFactura, monto, referencia }) {
  const f = await wh(`facturas/${idFactura}/?format=json`);
  try {
    await wh(`facturas/${idFactura}/?format=json`, {
      metodo: 'PUT',
      cuerpo: {
        ...f,
        fecha_emision: f.fecha_emision,
        fecha_vencimiento: f.fecha_vencimiento,
        fecha_pago: new Date().toISOString(),
        estado: 2,                     // 2 = Pagada. Puede ser ignorado.
        total_cobrado: Number(monto) || Number(f.total) || 0,
        total_pasarela: Number(monto) || 0,
        referencia: String(referencia || '').slice(0, 100),
      },
    });
  } catch (e) {
    return { marcada: false, motivo: 'La API rechazó el cambio: ' + e.message };
  }

  // La comprobación es el punto de todo esto.
  const despues = await wh(`facturas/${idFactura}/?format=json`).catch(() => null);
  const quedo = despues && String(despues.estado || '').toLowerCase().includes('pagada');
  return quedo
    ? { marcada: true }
    : { marcada: false, motivo: `La API aceptó la petición pero la factura sigue en "${despues ? despues.estado : '?'}"` };
}

/**
 * Reactiva el servicio.
 *
 * Es ASÍNCRONO: Wisphub devuelve un `task_id` y hace el trabajo por su cuenta.
 * O sea que un 200 aquí significa "lo encolé", no "ya quedó". Los servicios que
 * no encontró vienen en `warnings`, y hay que mirarlos: sin eso, un id
 * equivocado se vería igual que un éxito.
 */
async function reactivarServicio(idServicio) {
  const r = await wh('clientes/activar/?format=json', {
    metodo: 'POST',
    cuerpo: { servicios: [Number(idServicio)] },
  });
  const avisos = r.warnings || [];
  if (avisos.length) {
    const e = new Error('Wisphub no reactivó el servicio: ' + avisos.join(' · '));
    e.avisos = avisos;
    throw e;
  }
  return { tareaId: r.task_id || '', encolado: true };
}

/**
 * Todo junto: del pago confirmado al cliente reconectado.
 *
 * Nunca lanza. Devuelve qué se pudo hacer y qué no, porque quien llama a esto
 * es el webhook de Stripe: el dinero YA entró y el aviso al cliente tiene que
 * salir aunque Wisphub esté caído. Que falle la reconexión es un problema; que
 * además se pierda el aviso del pago sería el doble de problema.
 */
async function aplicarPago({ telefono, monto, referencia }) {
  const salida = { buscado: false, cliente: null, ambiguo: false, serviciosPosibles: [],
    facturasPendientes: 0, facturasSaldadas: 0,
    registroManual: [], deudaRestante: null, sobrante: 0, aFavor: false,
    reactivado: false, avisos: [] };
  if (!activo()) { salida.avisos.push('La reactivación automática está apagada'); return salida; }
  if (!LLAVE()) { salida.avisos.push('Falta WISPHUB_API_KEY'); return salida; }

  try {
    const hallazgo = await serviciosDe(telefono);
    salida.buscado = true;
    const c = hallazgo.servicios[0];
    if (!c) { salida.avisos.push(`No se encontró un cliente con el teléfono ${telefono}`); return salida; }

    /*
     * Varios servicios y ninguno claramente el que se está pagando. NO se
     * adivina: se registra el pago para que una persona lo aplique. Elegir mal
     * deja al cliente cortado igual y su dinero abonado a otra cuenta, y eso no
     * se nota hasta que reclama.
     */
    if (hallazgo.ambiguo) {
      salida.ambiguo = true;
      salida.serviciosPosibles = hallazgo.servicios.map((x) => ({
        idServicio: x.id_servicio, nombre: x.nombre, estado: x.estado,
      }));
      salida.cliente = { idServicio: c.id_servicio, nombre: c.nombre, estado: c.estado, usuario: c.usuario };
      salida.avisos.push(`Ese teléfono tiene ${hallazgo.total} servicios y no está claro cuál se está pagando: lo tiene que aplicar una persona`);
      return salida;
    }
    salida.cliente = { idServicio: c.id_servicio, nombre: c.nombre, estado: c.estado, usuario: c.usuario };

    /*
     * La deuda real, y qué se pudo registrar de ella.
     *
     * Registrar el pago en Wisphub puede no ser posible desde la API (ver
     * `intentarMarcarPagada`). Eso NO impide reconectar al cliente: lo que le
     * importa es volver a navegar. Lo que no puede pasar es que nadie se entere
     * de que quedó un pago sin registrar.
     */
    let deuda = null;
    try {
      deuda = await deudaDelCliente(c.usuario);
      salida.deudaRestante = deuda.total;
      salida.facturasPendientes = deuda.facturas.length;
    } catch (e) {
      salida.avisos.push('No se pudo confirmar la deuda: ' + e.message);
      salida.deudaRestante = null;
    }

    if (deuda && deuda.facturas.length) {
      let restante = Number(monto) || 0;
      for (const f of deuda.facturas) {
        const debe = Number(f.total) || 0;
        if (restante + 0.01 < debe) break;      // no alcanza para esta factura
        const r = await intentarMarcarPagada({ idFactura: f.id_factura, monto: debe, referencia })
          .catch((e) => ({ marcada: false, motivo: e.message }));
        if (r.marcada) {
          salida.facturasSaldadas += 1;
          salida.deudaRestante = +(salida.deudaRestante - debe).toFixed(2);
        } else {
          salida.registroManual.push({ factura: f.id_factura, total: debe, motivo: r.motivo });
        }
        restante = +(restante - debe).toFixed(2);
      }
      salida.sobrante = Math.max(0, restante);
      if (salida.sobrante > 0.01) {
        salida.avisos.push(`Sobraron $${salida.sobrante.toFixed(2)}: no alcanzaba para la siguiente factura o pagó de más`);
      }
    } else if (deuda) {
      /*
       * Pagó y no debía nada: es el cliente adelantado. Su dinero está en
       * Stripe pero Wisphub no tiene dónde aplicarlo, así que queda a favor y
       * hay que registrarlo a mano. Se avisa: si no, sería dinero recibido que
       * no aparece por ningún lado.
       */
      salida.sobrante = Number(monto) || 0;
      salida.aFavor = true;
      salida.avisos.push(`No debía nada: los $${salida.sobrante.toFixed(2)} quedan a su favor y hay que aplicarlos a mano`);
    }

    /*
     * Reactivar. Solo si ya no debe, salvo que se pida lo contrario.
     *
     * `deudaRestante === null` significa que no se pudo leer la deuda. Ahí NO se
     * reactiva: reconectar sin saber si pagó lo suficiente es regalar servicio,
     * y prefiero que alguien lo revise a que se escape en silencio.
     */
    const conSaldo = String(process.env.WISPHUB_REACTIVAR_CON_SALDO || 'false').trim() === 'true';
    const debeAlgo = salida.deudaRestante === null ? true : salida.deudaRestante > 0.01;

    if (c.estado === 'Activo') {
      // Pagó antes de que lo cortaran. No hay nada que reactivar y está bien.
      salida.avisos.push('El servicio ya estaba activo: pagó antes del corte');
    } else if (debeAlgo && !conSaldo) {
      salida.avisos.push(salida.deudaRestante === null
        ? 'No se reactivó: no se pudo confirmar la deuda'
        : `No se reactivó: todavía debe $${salida.deudaRestante.toFixed(2)}`);
    } else {
      try {
        const r = await reactivarServicio(c.id_servicio);
        salida.reactivado = true;
        salida.tareaId = r.tareaId;
      } catch (e) {
        salida.avisos.push('No se pudo reactivar: ' + e.message);
      }
    }

  } catch (e) {
    salida.avisos.push('Error hablando con Wisphub: ' + e.message);
  }
  return salida;
}

module.exports = {
  activo, buscarPorTelefono, serviciosDe, deudaDelCliente, intentarMarcarPagada, reactivarServicio, aplicarPago,
};
