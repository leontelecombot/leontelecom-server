/**
 * Decir QUIÉN tomó el caso, no "otro asesor".
 *
 * Con un solo asesor daba igual. Con varios, "lo tomó otro asesor" obliga a
 * preguntar por el grupo quién fue. Ahora va el número —y el nombre delante
 * si el bot lo conoce, que lo guarda solo del perfil de WhatsApp la primera
 * vez que ese asesor le escribe.
 *
 * Se comprueba también algo que importa más: que ninguno de esos mensajes
 * salga hacia un CLIENTE. Son avisos entre asesores; mandarle a un cliente el
 * teléfono interno de quien lo atiende sería filtrar un dato del equipo.
 *
 *   node scripts/verificarQuienTomoElCaso.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0, mal = 0;
const OK = m => { console.log('  OK    ' + m); ok++; };
const MAL = m => { console.log('  FALLA ' + m); mal++; };

const fuente = readFileSync(join(RAIZ, 'index.js'), 'utf8');

function extraerFuncion(nombre, tipo = 'function') {
  const inicio = fuente.indexOf(`${tipo} ${nombre}(`);
  if (inicio === -1) throw new Error(`No encontré ${nombre}`);
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
  throw new Error(`No pude cerrar ${nombre}`);
}

// ── describeAgent: cómo se nombra a un asesor ───────────────────────────────
function armarDescribeAgent(perfiles) {
  const cuerpo = extraerFuncion('describeAgent');
  return new Function('_normAgentNum', 'getProfile',
    `${cuerpo}; return describeAgent;`
  )(
    (raw) => String(raw || '').replace(/\D/g, ''),
    (num) => perfiles[num] || null
  );
}

console.log('\n=== 1. CON NOMBRE CONOCIDO: NOMBRE Y NÚMERO ===');
{
  const d = armarDescribeAgent({ '5219511697346': { name: 'Manuel' } });
  const r = d('5219511697346');
  /Manuel/.test(r) ? OK('pone el nombre') : MAL('sin nombre: ' + r);
  /5219511697346/.test(r) ? OK('y el número, que es con lo que se le marca') : MAL('sin número: ' + r);
}

console.log('\n=== 2. SIN NOMBRE: AL MENOS EL NÚMERO ===');
{
  const d = armarDescribeAgent({});
  const r = d('5219511697346');
  r === '5219511697346' ? OK('cae al número solo') : MAL('devolvió: ' + r);
}

console.log('\n=== 3. "Usuario" NO CUENTA COMO NOMBRE ===');
{
  // Es el relleno que pone WhatsApp cuando no hay nombre de perfil: mostrarlo
  // sería peor que no mostrar nada.
  const d = armarDescribeAgent({ '5219511697346': { name: 'Usuario' } });
  const r = d('5219511697346');
  !/Usuario/.test(r) ? OK('no muestra el relleno "Usuario"') : MAL('lo mostró: ' + r);
}

console.log('\n=== 4. NÚMERO INVÁLIDO: NO REVIENTA ===');
{
  const d = armarDescribeAgent({});
  const r = d('');
  r === 'otro asesor' ? OK('cae al genérico de siempre, sin romperse') : MAL('devolvió: ' + r);
}

console.log('\n=== 5. LOS MENSAJES YA NO DICEN "otro asesor" A SECAS ===');
{
  const casos = [
    ['ya lo está atendiendo', 'cuando pides un caso que otro tiene'],
    ['ya fue \\*tomado por', 'cuando alguien toma un caso (aviso a los demás)'],
    ['ya fue \\*marcado como recibido\\*', 'cuando alguien lo marca recibido'],
  ];
  for (const [patron, desc] of casos) {
    const re = new RegExp(patron + '[^`]{0,80}describeAgent');
    re.test(fuente) ? OK(desc + ': ahora nombra a quién') : MAL(desc + ': sigue genérico');
  }
}

console.log('\n=== 6. SE ANOTA QUIÉN GESTIONÓ, PARA PODER DECIRLO DESPUÉS ===');
{
  /markCases\(clientId, 'atendido', agentNumber\)/.test(fuente)
    ? OK('al atender se anota el asesor') : MAL('no se anota al atender');
  /markCases\(clientId, 'recibido', agentNumber\)/.test(fuente)
    ? OK('al marcar recibido también') : MAL('no se anota al recibir');
  /function quienGestiono/.test(fuente)
    ? OK('y hay forma de consultarlo después') : MAL('no se puede consultar');
}

console.log('\n=== 7. UN CASO VIEJO (SIN DATO) NO ROMPE NADA ===');
{
  const cuerpo = extraerFuncion('quienGestiono');
  const fn = new Function('caseLog', `${cuerpo}; return quienGestiono;`)(
    [{ clientId: '5219999999999', status: 'recibido' }] // sin porAgente
  );
  fn('5219999999999') === '' ? OK('devuelve vacío y se usa el texto genérico') : MAL('devolvió algo raro');

  const fn2 = new Function('caseLog', `${cuerpo}; return quienGestiono;`)(
    [{ clientId: '5219999999999', status: 'recibido', porAgente: '5219511697346' }]
  );
  fn2('5219999999999') === '5219511697346' ? OK('y con dato, lo encuentra') : MAL('no lo encontró');
}

console.log('\n=== 8. PRIVACIDAD: ESTOS AVISOS NUNCA VAN A UN CLIENTE ===');
{
  // Lo importante: el número de un asesor es dato interno del equipo. Todas
  // las líneas que lo muestran tienen que ir a un asesor, nunca a un cliente.
  const lineas = fuente.split('\n');
  const sospechosas = [];
  lineas.forEach((l, i) => {
    if (!l.includes('describeAgent(')) return;
    if (/function describeAgent/.test(l)) return;
    // Debe enviarse a un asesor (agentNumber) o al resto de asesores.
    const okDestino = /sendWhatsAppMessage\(agentNumber/.test(l) || /notifyOtherAgents\(/.test(l)
      || /^\s*[?:]/.test(l) || /^\s*`/.test(l); // continuación de un ternario ya validado
    if (!okDestino) sospechosas.push(`${i + 1}: ${l.trim().slice(0, 70)}`);
  });
  sospechosas.length === 0
    ? OK('todas las menciones salen hacia asesores, ninguna a un cliente')
    : MAL('revisar estas líneas:\n        ' + sospechosas.join('\n        '));
}

console.log(`\n=== ${ok} bien / ${mal} mal ===`);
process.exit(mal ? 1 : 0);
