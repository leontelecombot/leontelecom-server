/**
 * Que un aviso al asesor NUNCA se pierda en silencio.
 *
 * Lo que pasó de verdad: un cliente escribió a las 5 de la tarde y el asesor
 * no se enteró hasta las 10 de la mañana siguiente. La causa fue la "ventana
 * de 24 horas" de WhatsApp: Meta solo deja mandar mensajes normales a quien
 * te escribió en las últimas 24 h. Como el asesor llevaba más de un día sin
 * hablarle al bot, Meta rechazó el aviso, el error se quedó escrito en la
 * consola, y nadie lo vio. El caso se rescató hasta el resumen matutino,
 * porque ESE sí reintentaba con plantilla.
 *
 * Esta prueba reproduce ese rechazo (sin tocar WhatsApp de verdad) y comprueba
 * que ahora el aviso inmediato también se rescata con plantilla.
 *
 *   node scripts/verificarAvisoAsesor.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, mal = 0;
const OK = m => { console.log('  OK    ' + m); ok++; };
const MAL = m => { console.log('  FALLA ' + m); mal++; };

const fuente = readFileSync(join(RAIZ, 'index.js'), 'utf8');

/**
 * Saca el cuerpo de una función del archivo, para poder ejecutarla aislada.
 * Se lee del archivo real en vez de copiar el código aquí: si alguien cambia
 * la función y le quita el plan B, esta prueba se entera.
 */
function extraerFuncion(nombre) {
  const inicio = fuente.indexOf(`async function ${nombre}(`);
  if (inicio === -1) throw new Error(`No encontré la función ${nombre}`);
  // El `{` del CUERPO, no el de un parámetro por defecto (`opts = {}`): se
  // busca después de cerrar el paréntesis de la lista de parámetros.
  let p = fuente.indexOf('(', inicio), par = 0, finParams = -1;
  for (let j = p; j < fuente.length; j++) {
    if (fuente[j] === '(') par++;
    else if (fuente[j] === ')') { par--; if (par === 0) { finParams = j; break; } }
  }
  let i = fuente.indexOf('{', finParams), nivel = 0;
  for (let j = i; j < fuente.length; j++) {
    if (fuente[j] === '{') nivel++;
    else if (fuente[j] === '}') { nivel--; if (nivel === 0) return fuente.slice(inicio, j + 1); }
  }
  throw new Error(`No pude cerrar la función ${nombre}`);
}

// ── Escenario: Meta rechaza el envío normal (ventana de 24 h cerrada) ────────
async function correrEscenario({ plantillaFunciona }) {
  const registro = { normales: 0, plantillas: 0, alertas: [], textoPlantilla: '' };

  const AGENT_WHATSAPP_NUMBERS = ['5219511111111'];
  const agentQueue = (_num, fn) => fn();
  const sendWhatsAppMessage = async () => {
    registro.normales++;
    // Esto es lo que contesta Meta cuando la ventana de 24 h está cerrada.
    throw new Error('WhatsApp send failed (400): {"error":{"code":131047,"message":"Re-engagement message"}}');
  };
  const sendWhatsAppTemplate = async (_num, texto) => {
    registro.plantillas++;
    registro.textoPlantilla = texto;
    if (!plantillaFunciona) throw new Error('Plantilla no configurada');
    return true;
  };
  const alertAdmin = async (tipo, msg) => { registro.alertas.push({ tipo, msg }); };
  const console_ = { log() {}, warn() {}, error() {} };

  const cuerpo = extraerFuncion('sendToAllAgents');
  const fn = new Function(
    'AGENT_WHATSAPP_NUMBERS', 'agentQueue', 'sendWhatsAppMessage',
    'sendWhatsAppTemplate', 'alertAdmin', 'console',
    `${cuerpo}; return sendToAllAgents;`
  )(AGENT_WHATSAPP_NUMBERS, agentQueue, sendWhatsAppMessage, sendWhatsAppTemplate, alertAdmin, console_);

  await fn('🙋 Un cliente pide asesor', [], { buttons: [{ id: 'X', title: 'Y' }] });
  return registro;
}

console.log('\n=== 1. CON LA VENTANA CERRADA, EL AVISO SE RESCATA CON PLANTILLA ===');
{
  const r = await correrEscenario({ plantillaFunciona: true });
  r.normales === 1 ? OK('intentó primero el envío normal') : MAL('envíos normales: ' + r.normales);
  r.plantillas === 1 ? OK('al ser rechazado, reintentó con plantilla') : MAL('plantillas: ' + r.plantillas);
  r.alertas.length === 0 ? OK('y no alarmó de más: se entregó bien') : MAL('alertó sin necesidad');
  /RECIBIDO/.test(r.textoPlantilla)
    ? OK('la plantilla explica cómo responder (no lleva botones)')
    : MAL('no explica cómo responder: ' + r.textoPlantilla.slice(0, 80));
}

console.log('\n=== 2. SI NI LA PLANTILLA SIRVE, DEJA DE SER INVISIBLE ===');
{
  // Es el peor caso: WHATSAPP_AVISO_TEMPLATE sin configurar en Render. Antes
  // el aviso moría en la consola; ahora al menos avisa al admin.
  const r = await correrEscenario({ plantillaFunciona: false });
  r.plantillas === 1 ? OK('intentó la plantilla') : MAL('plantillas: ' + r.plantillas);
  r.alertas.length === 1 ? OK('y al fallar también, alerta al admin') : MAL('alertas: ' + r.alertas.length);
  /WHATSAPP_AVISO_TEMPLATE/.test(r.alertas[0]?.msg || '')
    ? OK('la alerta dice exactamente qué revisar')
    : MAL('alerta poco útil: ' + (r.alertas[0]?.msg || ''));
  /NO se perdió/.test(r.alertas[0]?.msg || '')
    ? OK('y aclara que el caso no se perdió (sigue en el panel)')
    : MAL('no aclara que el caso está a salvo');
}

console.log('\n=== 3. EL RESUMEN MATUTINO CONSERVA SU PLAN B ===');
{
  // Este es el que rescató el caso de ayer. Que no se pierda al tocar el otro.
  const cuerpo = extraerFuncion('sendAgentMessageSafe');
  /sendWhatsAppTemplate/.test(cuerpo)
    ? OK('sendAgentMessageSafe sigue reintentando con plantilla')
    : MAL('se le quitó el plan B al resumen matutino');
}

console.log('\n=== 4. AVISAR A LOS DEMÁS ASESORES TAMBIÉN QUEDÓ PROTEGIDO ===');
{
  const cuerpo = extraerFuncion('notifyOtherAgents');
  /sendWhatsAppTemplate/.test(cuerpo)
    ? OK('notifyOtherAgents también reintenta con plantilla')
    : MAL('notifyOtherAgents sigue sin plan B');
}

console.log(`\n=== ${ok} bien / ${mal} mal ===`);
process.exit(mal ? 1 : 0);
