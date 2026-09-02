/**
 * Mantener abierta la ventana de 24 h del asesor.
 *
 * WhatsApp solo deja mandarle avisos normales a quien te escribió en las
 * últimas 24 h, y esa cuenta la reinicia SOLO lo que el asesor manda: que el
 * bot le escriba no cuenta para nada. Por eso, en vez de esperar a que un
 * aviso rebote, se le toca el hombro ANTES de que se cierre, con un botón:
 * el toque sí cuenta como mensaje suyo y reabre otras 24 h.
 *
 * Aquí se simula el paso del tiempo (sin tocar WhatsApp) para comprobar
 * cuándo avisa, cuándo se calla, y que un toque reinicia la cuenta.
 *
 *   node scripts/verificarVentana24h.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, mal = 0;
const OK = m => { console.log('  OK    ' + m); ok++; };
const MAL = m => { console.log('  FALLA ' + m); mal++; };

const fuente = readFileSync(join(RAIZ, 'index.js'), 'utf8');

function extraerFuncion(nombre) {
  const inicio = fuente.indexOf(`async function ${nombre}(`);
  if (inicio === -1) throw new Error(`No encontré la función ${nombre}`);
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

const HORA = 3600 * 1000;

/**
 * Corre el barrido con un estado simulado.
 * @param horasDesdeQueEscribio  null = nunca escribió (o se perdió el dato)
 * @param minutoDelDia           hora de México en minutos (600 = 10:00 a.m.)
 */
async function correr({ horasDesdeQueEscribio, minutoDelDia = 600, plantillaPropia = 'ventana_tpl', pingPrevioHace = null }) {
  const enviados = [];
  const AGENT_WHATSAPP_NUMBERS = ['5219511111111'];
  const agentLastInbound = new Map();
  const agentPingSent = new Map();
  if (horasDesdeQueEscribio !== null) {
    agentLastInbound.set('5219511111111', new Date(Date.now() - horasDesdeQueEscribio * HORA).toISOString());
  }
  if (pingPrevioHace !== null) {
    agentPingSent.set('5219511111111', new Date(Date.now() - pingPrevioHace * HORA).toISOString());
  }

  const cuerpo = extraerFuncion('sweepAgentWindow');
  const fn = new Function(
    'AGENT_WHATSAPP_NUMBERS', 'agentLastInbound', 'agentPingSent', 'mexicoNow',
    'sendWhatsAppTemplate', 'schedulePersist', 'console',
    'WHATSAPP_VENTANA_TEMPLATE', 'VENTANA_MS', 'VENTANA_AVISAR_ANTES_MS',
    `${cuerpo}; return sweepAgentWindow;`
  )(
    AGENT_WHATSAPP_NUMBERS, agentLastInbound, agentPingSent,
    () => ({ minutesOfDay: minutoDelDia }),
    async (num, texto, opts = {}) => { enviados.push({ num, texto, opts }); return true; },
    () => {},
    { log() {}, warn() {}, error() {} },
    plantillaPropia, 24 * HORA, 2 * HORA
  );

  await fn();
  return { enviados, agentPingSent };
}

console.log('\n=== 1. RECIÉN ESCRIBIÓ: NO LO MOLESTA ===');
{
  const r = await correr({ horasDesdeQueEscribio: 1 });
  r.enviados.length === 0 ? OK('a 1 h de haber escrito, no le manda nada') : MAL('mandó ' + r.enviados.length);
}

console.log('\n=== 2. FALTANDO 2 H PARA QUE SE CIERRE: LE AVISA ===');
{
  const r = await correr({ horasDesdeQueEscribio: 22.5 });
  r.enviados.length === 1 ? OK('le manda el recordatorio') : MAL('mandó ' + r.enviados.length);
  r.enviados[0]?.opts?.buttonPayload === 'VENTANA_OK'
    ? OK('con el botón, que es lo único que reabre la ventana')
    : MAL('sin botón: ' + JSON.stringify(r.enviados[0]?.opts));
  /toca el botón/i.test(r.enviados[0]?.texto || '')
    ? OK('y le dice claramente qué hacer')
    : MAL('texto: ' + r.enviados[0]?.texto);
}

console.log('\n=== 3. YA SE CERRÓ: TAMBIÉN LE AVISA, CON OTRO TONO ===');
{
  const r = await correr({ horasDesdeQueEscribio: 30 });
  r.enviados.length === 1 ? OK('le avisa aunque ya se haya pasado') : MAL('mandó ' + r.enviados.length);
  /se cerró/i.test(r.enviados[0]?.texto || '')
    ? OK('le dice que ya se cerró, no que "faltan 0 h"')
    : MAL('texto confuso: ' + r.enviados[0]?.texto);
}

console.log('\n=== 4. DE MADRUGADA NO MOLESTA ===');
{
  const r = await correr({ horasDesdeQueEscribio: 23, minutoDelDia: 180 }); // 3:00 a.m.
  r.enviados.length === 0 ? OK('a las 3 a.m. no manda nada') : MAL('despertó a alguien');
  const r2 = await correr({ horasDesdeQueEscribio: 23, minutoDelDia: 1380 }); // 11:00 p.m.
  r2.enviados.length === 0 ? OK('a las 11 p.m. tampoco') : MAL('mandó de noche');
  const r3 = await correr({ horasDesdeQueEscribio: 23, minutoDelDia: 540 }); // 9:00 a.m.
  r3.enviados.length === 1 ? OK('pero a las 9 a.m. sí') : MAL('no mandó en horario bueno');
}

console.log('\n=== 5. NO REPITE: MÁXIMO UNO AL DÍA ===');
{
  const r = await correr({ horasDesdeQueEscribio: 30, pingPrevioHace: 3 });
  r.enviados.length === 0 ? OK('si ya le avisó hace 3 h, no vuelve a insistir') : MAL('insistió de más');
  const r2 = await correr({ horasDesdeQueEscribio: 40, pingPrevioHace: 26 });
  r2.enviados.length === 1 ? OK('pero al día siguiente sí le recuerda otra vez') : MAL('dejó de recordarle');
}

console.log('\n=== 6. SIN DATO (REINICIO DE RENDER): ASUME LO PEOR Y AVISA ===');
{
  // Si Render reinició y se perdió el dato, no se puede saber si la ventana
  // está abierta. Equivocarse avisando de más cuesta un mensaje; equivocarse
  // al revés cuesta perder el aviso de un cliente.
  const r = await correr({ horasDesdeQueEscribio: null });
  r.enviados.length === 1 ? OK('sin dato, prefiere avisar') : MAL('se quedó callado sin saber');
}

console.log('\n=== 7. SIN PLANTILLA PROPIA, SIGUE FUNCIONANDO ===');
{
  // Si no se creó la plantilla con botón en Meta, usa la de avisos: llega
  // igual, sin botón, pidiéndole que conteste (que vale lo mismo).
  const r = await correr({ horasDesdeQueEscribio: 23, plantillaPropia: '' });
  r.enviados.length === 1 ? OK('manda el recordatorio igual') : MAL('no mandó nada');
  !r.enviados[0]?.opts?.buttonPayload ? OK('sin botón, porque esa plantilla no lo tiene') : MAL('mandó botón inválido');
  /Responde cualquier cosa/i.test(r.enviados[0]?.texto || '')
    ? OK('y le pide que conteste, que reabre la ventana igual')
    : MAL('no le dice cómo reabrirla: ' + r.enviados[0]?.texto);
}

console.log('\n=== 8. EL TOQUE DEL BOTÓN QUEDA MANEJADO ===');
{
  // Los botones de plantilla llegan como type:'button', no como 'interactive'.
  // Antes no había manejador y el toque se ignoraba por completo.
  /msg\.type === 'button'/.test(fuente) ? OK("el webhook atiende type:'button' (plantillas)") : MAL('sigue sin manejar botones de plantilla');
  /VENTANA_OK/.test(fuente) ? OK('y reconoce el pago del recordatorio de ventana') : MAL('no reconoce VENTANA_OK');
  /agentLastInbound\.set/.test(fuente) ? OK('cualquier mensaje del asesor reinicia la cuenta') : MAL('no anota cuándo escribió el asesor');
  /agentPingSent\.delete/.test(fuente) ? OK('y limpia el recordatorio pendiente') : MAL('no limpia el recordatorio');
}

console.log(`\n=== ${ok} bien / ${mal} mal ===`);
process.exit(mal ? 1 : 0);
