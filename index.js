require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { analyzePaymentReceipt } = require('./utils/imageAnalysis');
const dataManager = require('./utils/dataManager');
const persistence = require('./utils/persistence');
const stripeLeon = require('./utils/stripeLeon');
const wisphubReactivar = require('./utils/wisphubReactivar');

/*
 * MAQUETA — cobro automático con tarjeta/OXXO.
 *
 * Solo este número ve el botón de pagar con tarjeta y puede usarlo; para todos
 * los demás clientes el flujo sigue siendo exactamente el de siempre
 * (transferencia/depósito + comprobante por foto, revisado por un asesor).
 * ⚠️ Quitar este candado —o convertirlo en una lista— cuando se decida abrir
 * el cobro con tarjeta a más clientes.
 */
const TELEFONO_PILOTO_STRIPE = '529516549145';

// Compresión de imágenes: se carga PEREZOSAMENTE (solo al primer upload), para no
// pesar en el arranque ni en la memoria del servidor cuando no se usa.
let _sharp; // undefined = aún no intentado; null = no disponible
function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = require('sharp'); } catch (e) { _sharp = null; console.warn('[upload] sharp no disponible; imágenes sin comprimir'); }
  return _sharp;
}

// File upload config — imágenes en memoria; se comprimen y se guardan en MongoDB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) return cb(new Error('El archivo debe ser una imagen (jpg, png, etc.)'));
  cb(null, true);
}});

const app = express();
app.set('trust proxy', true); // Render está detrás de proxy → req.ip = IP real del cliente
app.disable('x-powered-by'); // no revelar que es Express

// Cabeceras de seguridad en todas las respuestas (sin CSP estricta para no romper el panel/CDNs)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// Guarda el cuerpo crudo (para verificar la firma del webhook de Meta) y baja el límite de 50mb→10mb
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));
// Bitácora del panel: registra cada acción que modifica algo (definida más abajo).
app.use('/admin/api', (req, res, next) => auditar(req, res, next));

// ── BLINDAJE: la red de seguridad para que el bot NUNCA se caiga ──
// Un error no manejado (en cualquier parte) se registra pero NO tumba el proceso.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

const SYSTEM_PROMPT = [
  'Eres Leo, asistente virtual de León Telecom.',
  'León Telecom SOLO ofrece servicio de internet. NO ofrece telefonía, televisión, cable ni otros servicios.',
  'Tono: profesional, amable y directo. Como un buen agente de atención al cliente.',
  'Nunca uses slang, groserías ni expresiones muy informales.',
  'Responde en español, máximo 2 oraciones, sin rodeos ni frases de relleno.',
  'Si no puedes resolver algo, indica que un asesor se pondrá en contacto.'
].join(' ');

const AI_PROVIDER = process.env.AI_PROVIDER || 'openai-compatible';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || 'llama-3.1-8b-instant';
const AI_API_KEY = process.env.AI_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : '';

const SERVER_BASE_URL = (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
const FIBER_PLAN_MEDIA_URL = process.env.FIBER_PLAN_MEDIA_URL ||
  (SERVER_BASE_URL ? `${SERVER_BASE_URL}/images/planesfibraoptica.jpeg` : '');
const WIRELESS_PLAN_MEDIA_URL = process.env.WIRELESS_PLAN_MEDIA_URL ||
  (SERVER_BASE_URL ? `${SERVER_BASE_URL}/images/planesinalambrico.jpeg` : '');
const LEON_CONTACT_NUMBER = process.env.LEON_CONTACT_NUMBER || '951 169 7346';
// Dirección física real de la oficina. Antes NO existía en el código y el bot la
// inventaba; ahora es la única verdad que puede dar.
const OFFICE_ADDRESS = process.env.OFFICE_ADDRESS || 'Carretera Internacional, San Pablo Huitzo, a un costado del Oxxo, pasando el puente';
const STORE_URL = process.env.STORE_URL || 'https://tienda.leontelecom.com';
const AGENT_NOTIFY_CHAT_ID = process.env.AGENT_NOTIFY_CHAT_ID || '';
const AGENT_NOTIFY_WEBHOOK_URL = process.env.AGENT_NOTIFY_WEBHOOK_URL || '';
// Asesor(es): admite VARIOS números (coma/espacio en AGENT_WHATSAPP_NUMBER) y un
// 2º opcional en AGENT_WHATSAPP_NUMBER_2. Todos reciben avisos y pueden dar comandos.
function _normAgentNum(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.length === 10) n = '52' + n;
  if (n.startsWith('521') && n.length === 13) n = '52' + n.slice(3);
  return n.length >= 12 ? n : '';
}
const AGENT_WHATSAPP_NUMBERS = [...new Set(
  // Separamos SOLO por coma/;/salto de línea (NO por espacios: un número puede venir
  // formateado como "+52 1 951 169 7346"). _normAgentNum se queda solo con los dígitos.
  [process.env.AGENT_WHATSAPP_NUMBER, process.env.AGENT_WHATSAPP_NUMBER_2]
    .filter(Boolean).join(';').split(/[,;\n]+/).map(_normAgentNum).filter(Boolean)
)];
const AGENT_WHATSAPP_NUMBER = AGENT_WHATSAPP_NUMBERS[0] || '';
function isAgentNumber(n) { const x = _normAgentNum(n); return !!x && AGENT_WHATSAPP_NUMBERS.includes(x); }
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'leon123'; // Change in production!
// Secreto para firmar los tokens del panel. Si no se define, se deriva de la
// contraseña (estable entre reinicios). Definir ADMIN_SECRET en Render es lo ideal.
const ADMIN_SECRET = process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('leontelecom::' + ADMIN_PASSWORD).digest('hex');
const ADMIN_TOKEN_TTL_MS = 12 * 3600 * 1000; // los tokens del panel expiran en 12 horas
const WISPHUB_API_URL = process.env.WISPHUB_API_URL || 'https://api.wisphub.net'; // Optional

// ==================== USUARIOS DEL PANEL (roles y permisos) ====================
const ADMIN_PERMISSIONS = ['broadcast', 'clients', 'reports', 'status', 'wisphub', 'products', 'users'];
const ADMIN_PERM_LABELS = {
  broadcast: 'Avisos y mensajes',
  clients: 'Base de clientes',
  reports: 'Soporte y reportes',
  status: 'Estado del servicio',
  wisphub: 'Sincronizar Wisphub',
  products: 'Productos (web y bot)',
  users: 'Gestionar usuarios'
};
const adminUsers = new Map(); // username(min) → { username, name, role, salt, hash, permissions[], active, createdAt }

function hashAdminPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyAdminPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(h), b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function getAdminUser(username) { return adminUsers.get(String(username || '').trim().toLowerCase()) || null; }
function permsOf(user) { return user.role === 'superadmin' ? ADMIN_PERMISSIONS.slice() : (user.permissions || []); }

// Crea el superadmin la primera vez (usuario "admin" con ADMIN_PASSWORD).
function ensureSuperAdmin() {
  if ([...adminUsers.values()].some(u => u.role === 'superadmin' && u.active !== false)) return;
  const { salt, hash } = hashAdminPassword(ADMIN_PASSWORD);
  adminUsers.set('admin', { username: 'admin', name: 'Administrador', role: 'superadmin', salt, hash, permissions: ADMIN_PERMISSIONS.slice(), active: true, createdAt: new Date().toISOString() });
  console.log('[admin] Superadmin creado (usuario: admin / contraseña: ADMIN_PASSWORD)');
  schedulePersist();
}

// Rescate de acceso al panel. Con ADMIN_RESET=1 en el entorno, al arrancar se
// restaura el usuario "admin" (lo crea si no existe, o le repone la contraseña y
// lo reactiva) usando ADMIN_PASSWORD. Sirve para recuperar el panel si se borró el
// usuario o se perdió la contraseña. Solo lo puede activar quien entra a Render.
function rescatarAdmin() {
  if (process.env.ADMIN_RESET !== '1') return;
  const prev = adminUsers.get('admin') || {};
  const { salt, hash } = hashAdminPassword(ADMIN_PASSWORD);
  adminUsers.set('admin', {
    ...prev, username: 'admin', name: prev.name || 'Administrador', role: 'superadmin',
    salt, hash, permissions: ADMIN_PERMISSIONS.slice(), active: true,
    createdAt: prev.createdAt || new Date().toISOString()
  });
  console.log('[admin] ⚠️ ADMIN_RESET activo → usuario "admin" restaurado con ADMIN_PASSWORD.');
  console.log('[admin] ⚠️ QUITA la variable ADMIN_RESET de Render en cuanto puedas entrar.');
  schedulePersist();
}

if (ADMIN_PASSWORD === 'leon123') {
  console.warn('[seguridad] ⚠️ ADMIN_PASSWORD usa el valor por defecto. Define una contraseña fuerte en Render → Environment.');
}

// ==================== WHATSAPP CLOUD API ====================
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'leontelecom-verify';
const WHATSAPP_API_VERSION = 'v22.0';
/*
 * A dónde se le habla a Meta. En producción no se toca. Las pruebas lo apuntan
 * a un WhatsApp de mentira en la misma máquina para LEER lo que el bot le
 * contestaría a un cliente, que es lo único que de verdad importa comprobar.
 */
const WHATSAPP_GRAPH = (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
// Plantilla aprobada para avisos masivos (corte/reparación/reactivado) — permite
// enviar a TODOS aunque hayan pasado +24h sin chatear. Cuerpo con un parámetro {{1}}.
const WHATSAPP_AVISO_TEMPLATE = process.env.WHATSAPP_AVISO_TEMPLATE || '';
// Plantilla de Marketing con ENCABEZADO de imagen + cuerpo {{1}}, para promos a todos.
const WHATSAPP_PROMO_TEMPLATE = process.env.WHATSAPP_PROMO_TEMPLATE || '';
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX';

const LOCATIONS = {
  huitzo: 'Huitzo',
  telixtlahuaca: 'Telixtlahuaca',
  suchilquitongo: 'Suchilquitongo'
};

// Zonas con FIBRA ÓPTICA en Huitzo — instalación $800, primer mes gratis
// El resto de Huitzo se atiende con antena inalámbrica
const HUITZO_FIBER_ZONES = [
  'Primera Sección', 'Segunda Sección', 'Tercera Sección',
  'La Guadalupe', 'La Cantera', 'Santa María Tenéxpam', 'Agua Blanca',
  'Colonia Esmeralda', 'Cañada del Chisme', 'Privada del Laurel',
  'Ojo de Agua', 'El Llano', 'Por la Gasolinera', 'Loma los Pinos'
];

const INSTALLATION_COSTS = {
  huitzoFibra: { costo: '$800', promo: 'primer mes gratis' },
  huitzoAntena: { costo: 'a cotizar con técnico', promo: '' },
  telixtlahuacaCentro: { costo: '$800', promo: '' },     // centro/cabecera de Telixtlahuaca
  telixtlahuacaAgencias: { costo: '$1,200', promo: '' }, // agencias/alrededores
  suchilquitongo: { costo: 'a cotizar con técnico', promo: '' }
};

// Centro/cabecera de Telixtlahuaca → instalación $800. El resto (agencias y
// localidades de los alrededores) → $1,200.
const TELIXTLAHUACA_CENTRO_ZONES = [
  'Colonia Centro', 'Barrio Bajo', 'Colonia Y Griega', 'Colonia Yuquenchi',
  'Colonia Independencia', 'Camino Nacional'
];
const TELIXTLAHUACA_AGENCIAS = [
  'San Sebastián Sedas', 'Faustino G. Olivera', 'Plan Seco', 'Ojo de Agua',
  'Santa Cruz el Salto', 'Las Trancas', 'La Carbonera', 'El Nuevo Manzanito',
  'Cañada las Sedas', 'Boca de León', 'Tierra Colorada', 'El Moral'
];

const NEIGHBORHOODS = {
  huitzo: [
    // Zonas con fibra óptica
    'Primera Sección', 'Segunda Sección', 'Tercera Sección',
    'Colonia Primera Sección', 'Centro de la Segunda Sección', 'Centro de la Tercera Sección',
    'La Guadalupe', 'La Cantera', 'Colonia Esmeralda', 'Col Esmeralda',
    'Privada del Laurel', 'El Llano', 'Por la Gasolinera', 'Loma los Pinos',
    // Otras zonas (antena)
    'Colonia San Pablo', 'San Pablo Huitzo', 'Cabecera Municipal',
    'Santa María Tenéxpam', 'Agua Blanca', 'Cañada del Chisme',
    'Ojo de Agua', 'Yutetoto', 'Cañada Guayabal', 'Joyas de Río Blanco'
  ],
  telixtlahuaca: [
    'Colonia Centro', 'Barrio Bajo', 'Colonia Y Griega', 'Colonia Yuquenchi',
    'Colonia Independencia', 'San Sebastián Sedas', 'Plan Seco', 'Ojo de Agua',
    'Santa Cruz el Salto', 'Las Trancas', 'La Carbonera', 'El Nuevo Manzanito',
    'Cañada las Sedas', 'Faustino G. Olivera', 'Boca de León', 'Tierra Colorada', 'El Moral',
    'Camino Nacional'
  ],
  suchilquitongo: [
    'Santiago Suchilquitongo Centro', 'Cabecera Municipal', 'Barrio de La Santa Cruz',
    'Barrio de Tetiche', 'Colonia del Sol', 'Colonia Las Torres', 'Santa Cruz Lachixolana',
    'Santo Domingo Tlaltinango', 'El Pocito', 'El Zapotal', 'El Llano Grande',
    'El Guajal', 'La Pila', 'El Pedregal'
  ]
};

// ==================== HORARIO DE ATENCIÓN ====================
// El asistente (Leo) responde 24/7. Estos horarios definen cuándo hay un ASESOR
// HUMANO disponible, para avisarle al cliente a qué hora aproximada lo atenderán.
// Zona horaria de Oaxaca: America/Mexico_City. Valores en minutos desde medianoche.
const BUSINESS_TZ = 'America/Mexico_City';
const BUSINESS_HOURS = {
  0: [[600, 840]],               // Domingo   10:00–14:00
  1: [[600, 900], [960, 1200]],  // Lunes     10:00–15:00 y 16:00–20:00
  2: [[600, 900], [960, 1200]],  // Martes
  3: [[600, 900], [960, 1200]],  // Miércoles
  4: [[600, 900], [960, 1200]],  // Jueves
  5: [[600, 900], [960, 1200]],  // Viernes
  6: [[600, 900], [960, 1080]]   // Sábado    10:00–15:00 y 16:00–18:00
};
const BUSINESS_HOURS_SUMMARY = 'Lunes a Viernes de 10:00 a.m. a 3:00 p.m. y de 4:00 a 8:00 p.m., Sábado de 10:00 a.m. a 3:00 p.m. y de 4:00 a 6:00 p.m., Domingo de 10:00 a.m. a 2:00 p.m.';
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Hora actual en la zona de Oaxaca (Render corre en UTC, por eso lo calculamos así)
function mexicoNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { dow: wd ?? date.getDay(), hour, minute, minutesOfDay: hour * 60 + minute };
}

function isWithinBusinessHours(date = new Date()) {
  const { dow, minutesOfDay } = mexicoNow(date);
  return (BUSINESS_HOURS[dow] || []).some(([s, e]) => minutesOfDay >= s && minutesOfDay < e);
}

function formatHour12(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// "hoy a las 4:00 pm", "mañana a las 10:00 am" o "el lunes a las 10:00 am"
function describeNextOpening(date = new Date()) {
  const { dow, minutesOfDay } = mexicoNow(date);
  for (let i = 0; i < 8; i++) {
    const d = (dow + i) % 7;
    for (const [start] of (BUSINESS_HOURS[d] || [])) {
      if (i === 0 && minutesOfDay >= start) continue;
      const when = i === 0 ? 'hoy' : i === 1 ? 'mañana' : `el ${DAY_NAMES[d]}`;
      return `${when} a las ${formatHour12(start)}`;
    }
  }
  return 'en nuestro próximo horario de atención';
}

// ¿El cliente está preguntando por el horario de atención?
function isHoursRequest(text) {
  const v = normalizeText(text);
  return /\b(horario|horarios|que hora|a que hora|a q hora|que dias|dias atienden|dias abren|cuando abren|cuando atienden|estan abiertos|estan abierto|siguen abiertos|ya cerraron|a que hora abren|a que hora cierran|hora de atencion)\b/.test(v)
    || (/\b(abren|cierran|atienden)\b/.test(v) && /\?|hora|dia/.test(v));
}

// ¿El cliente pide el TELÉFONO / número de CONTACTO de la oficina? (NO su propio número)
// Igual que isHoursRequest: se resuelve con el dato REAL sin pasar por el modelo chico
// (que inventa números). Guarda contra falsos positivos como "mi número de cliente" o
// "cambié de número".
function isContactoRequest(text) {
  const v = normalizeText(text);
  // GUARDAS: estos NO piden el teléfono de la oficina aunque mencionen "numero"/"tel".
  if (isTechnicalIssue(v) || isOutageReport(v) || isPlanRequest(v) || isCoverageRequest(v)) return false;
  if (/\btelcel|movistar|at&?t|att|bait|unefon|izzi|totalplay|megacable|dish|sky|television|tv\b/.test(v)) return false;
  // Se refiere al número DEL CLIENTE, no al de la oficina.
  if (/\bnum(?:ero)?\s+de\s+(cliente|contrato|cuenta|folio|referencia|servicio|medidor)\b/.test(v)) return false;
  if (/\bmi\s+(numero|telefono|tel|celular|cel|whats\w*|linea)\b/.test(v)) return false;
  if (/\b(cambi\w*|actualiz\w*|equivoc\w*|erron\w*|registr\w*)\b[\s\w]*\b(numero|telefono|celular)\b/.test(v)) return false;
  // Token de teléfono ANCLADO (no 'tel\w*' que caía con telcel/television).
  const TEL = '(numero|telefono|telefonos|whats\\w*|celular)';
  // "a dónde / a qué número llamo / marco / me comunico"
  if (/\b(a donde|a que numero|a que telefono)\b[\s\w]*\b(llamo|llamar|marco|marcar|le llamo|los llamo|me comunico|comunicarme)\b/.test(v)) return true;
  // número/teléfono/whatsapp PARA llamar/marcar/contactar/comunicarme
  if (new RegExp('\\b' + TEL + '\\b[\\s\\w]*\\b(para|de)\\b[\\s\\w]*\\b(llamar|marcar|contact\\w*|comunicar\\w*|atencion)\\b').test(v)) return true;
  // número/teléfono/whatsapp DE la oficina/ustedes/contacto (frase adyacente, no suelta)
  if (new RegExp('\\b' + TEL + '\\b\\s+(de\\s+)?(la\\s+)?(oficina|contacto|atencion|ustedes|leon\\s*telecom)\\b').test(v)) return true;
  if (/\b(oficina|contacto|atencion|ustedes|leon\s*telecom)\b\s+(numero|telefono|whats\w*)\b/.test(v)) return true;
  // "me pasas / me das / cuál es su número/teléfono/whatsapp/contacto", "tienen whatsapp"
  if (new RegExp('\\b(me\\s+(pas\\w*|d[aá]s?|compart\\w*|proporcion\\w*|facilit\\w*)|puedes?\\s+(pasar\\w*|dar\\w*|compartir\\w*)|cual\\s+es\\s+(su|tu)|tienen|cuentan\\s+con)\\b[\\s\\w]*\\b(' + TEL + '|contacto)\\b').test(v)) return true;
  return false;
}

// ¿El cliente pregunta DÓNDE está / la DIRECCIÓN de la oficina? La dirección NO existe
// en el código: JAMÁS inventarla. Respondemos con el TELÉFONO REAL para confirmarla.
// Guarda contra reportes técnicos, pagos y solicitudes de migración/cambio de domicilio.
function isUbicacionRequest(text) {
  const v = normalizeText(text);
  // GUARDAS: cobertura, instalación, falla, pago, migración y datos del propio cliente
  // NO son "dónde está la oficina", aunque digan "domicilio/direccion".
  if (isTechnicalIssue(v) || isCoverageRequest(v) || isMigrationRequest(text)) return false;
  if (/\b(pago|pagar|comprobante|deposito|transferencia|recibo)\b/.test(v)) return false;
  if (/\b(instal\w*|agend\w*|contrat\w*|cubre|cubren|cobertura|llega|servicio)\b/.test(v)) return false;
  if (/\ba\s+domicilio\b/.test(v)) return false;                       // "instalación a domicilio"
  if (/\bmi\s+(direccion|domicilio|casa)\b/.test(v)) return false;     // el cliente DANDO su domicilio
  if (/\bdireccion\s+ip\b/.test(v)) return false;                      // dato técnico
  if (/\b(cambi\w*|mover|mudar\w*|mudanza|migr\w*|traslad\w*)\b/.test(v) && /\b(domicilio|direccion|casa|servicio)\b/.test(v)) return false;
  const OFI = '(oficina|oficinas|local|sucursal|ustedes|empresa|negocio|leon\\s*telecom)';
  // dirección/domicilio/ubicación DE la oficina (exige el contexto de oficina)
  if (new RegExp('\\b(direccion|domicilio|ubicacion|ubicad\\w*)\\b[\\s\\w]*\\b' + OFI + '\\b').test(v)) return true;
  if (new RegExp('\\b' + OFI + '\\b[\\s\\w]*\\b(direccion|domicilio|ubicacion|ubicad\\w*)\\b').test(v)) return true;
  // "cuál es su dirección/ubicación", "su domicilio" (posesivo hacia la empresa)
  if (/\bcual\s+es\s+(su|la)\s+(direccion|ubicacion|domicilio)\b/.test(v)) return true;
  if (/\bsu\s+(direccion|domicilio|ubicacion)\b/.test(v)) return true;
  // "cómo llego/llegar", "mapa", "google maps", "croquis" a la oficina/ustedes
  if (/\b(como llego|como llegar|mapa|google maps|croquis|ubicacion de la oficina)\b/.test(v)) return true;
  // "dónde están ubicados / se localizan" (sin objeto técnico) = dónde está la oficina
  if (/\bdonde\b/.test(v) && /\b(ubicad\w*|localizad\w*)\b/.test(v)
      && !/\b(modem|router|antena|cable|poste|equipo|caja|nap|roseta|ip|medidor)\b/.test(v)) return true;
  // "dónde están / queda / se encuentran / se ubican" + oficina/ustedes/sucursal
  if (/\b(donde|en donde|adonde)\b[\s\w]*\b(estan|esta|queda|quedan|se encuentran|se ubican|los encuentro)\b/.test(v)
      && new RegExp('\\b' + OFI + '\\b').test(v)) return true;
  return false;
}

// ¿El cliente pide una PRÓRROGA / más tiempo o plazo para pagar? Es una decisión
// que solo puede tomar una persona, así que lo mandamos directo con un asesor.
// Preciso a propósito: exige contexto de PAGO + señal de aplazamiento (evita falsos
// positivos como "llevo unos días sin internet", que NO es de pago).
function isProrrogaRequest(text) {
  const v = normalizeText(text);
  if (/\bprorrog\w*/.test(v)) return true;                       // "prórroga", "prorrogar"
  const pago = /\b(pag\w*|abon\w*|recibo|mensualidad|adeudo|deuda)\b/;
  if (!pago.test(v)) return false;
  // pedir chance / más tiempo / que lo esperen / quincena / otra semana
  if (/\b(chance|plazo|mas tiempo|mas dias?|unos dias?|un dia mas|otro dia|otros dias?|otra semana|proxima semana|me espera\w*|esper\w*me|aguant\w*|tiempito|quincena|(el mes|la semana) que (entra|viene))\b/.test(v)) return true;
  // "para/hasta" + un día futuro / semana
  if (/\b(para|hasta)\b[\s\w]*\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|semana|quincena|fin de semana|proxim\w+)\b/.test(v)) return true;
  // "no puedo pagar hoy/ahorita/ahora…"
  if (/\bno (puedo|voy a poder|alcanzo|tengo (con que|para))\b/.test(v) && /\b(hoy|ahorita|ahora|por ahora|por el momento|este momento|esta semana)\b/.test(v)) return true;
  return false;
}

// Mensaje con el horario de atención en formato de lista.
function buildBusinessHoursMessage() {
  const abierto = isWithinBusinessHours();
  return [
    abierto ? '🟢 Ahorita estamos ABIERTOS para atención con un asesor.' : `🔴 Ahorita estamos fuera de horario. Volvemos ${describeNextOpening()}.`,
    '',
    '🕒 Horario de atención (asesores):',
    `• ${BUSINESS_HOURS_SUMMARY}`,
    '',
    'Yo, el asistente virtual, te atiendo las 24 horas. 🤖'
  ].join('\n');
}

// Client profiles — remembers name, location across messages (persisted)
const clientProfiles = new Map();

function getProfile(chatId) {
  return clientProfiles.get(String(chatId)) || null;
}

function updateProfile(chatId, updates) {
  const id = String(chatId);
  const existing = clientProfiles.get(id) || { firstSeen: new Date() };
  clientProfiles.set(id, { ...existing, ...updates, lastSeen: new Date() });
  schedulePersist();
}

// Agent takeover — pauses bot for a specific client chat
const pausedChats = new Map(); // Map<chatId, { pausedUntil: Date }>

// Active relay: which client the agent is currently chatting through the bot
const agentActiveCases = new Map(); // Map<agentNumber, clientId>

// Clientes que pidieron un asesor y siguen esperando — para enviar recordatorio
// si nadie los atiende en cierto tiempo. clientId → { since, name, type, stage }
const pendingAgentRequests = new Map();
const pendingImage = new Map(); // confirmación de comprobante: chatId -> { url, analysis, userName, ts, stage }
const pendingDoc = new Map();   // documento/PDF: chatId -> { docUrl, fname, userName, ts }
const statedTitular = new Map(); // cliente dijo "a nombre de X" -> chatId -> { name, ts }

// ==================== REGISTRO DE CASOS (persistente en Mongo) ====================
// Cada aviso al asesor queda registrado aquí para que NO se pierda nada
// (comprobantes, documentos, emergencias, solicitudes de asesor, etc.).
let caseLog = []; // [{id, ts, clientId, name, type, resumen, imageUrl, docUrl, offHours, status}]
const CASE_LOG_MAX = 400;
let lastDigestDate = '';    // 'YYYY-MM-DD' (México) del último resumen matutino enviado
/*
 * Última vez que CADA asesor le escribió al bot (número → ISO).
 *
 * WhatsApp solo deja mandarle mensajes normales a quien te escribió en las
 * últimas 24 h. Esa cuenta la reinicia SOLO lo que el asesor manda: que el bot
 * le escriba no sirve de nada. Por eso hay que saber cuándo fue la última vez,
 * para poder tocarle el hombro ANTES de que se cierre la ventana en vez de
 * descubrirlo cuando ya se perdió un aviso.
 *
 * Se persiste: Render reinicia seguido, y si esto se perdiera el bot no sabría
 * si la ventana está por cerrarse.
 */
let agentLastInbound = new Map(); // num → ISO del último mensaje del asesor
let agentPingSent = new Map();    // num → ISO del último recordatorio enviado (uno por ventana)
let corteReminders = {};    // "telefono|fecha" → ISO de cuándo se envió (evita duplicados)
/*
 * PRÓRROGAS. "Dame chance hasta el viernes" es de las cosas que más se piden,
 * y hasta ahora vivía en la cabeza del asesor: el bot le seguía mandando el
 * aviso de corte al cliente al que ya le habían dado plazo. Ahora el asesor
 * la registra con un mensaje (PRORROGA 9511234567 3) y el aviso se calla
 * hasta que venza.
 */
let prorrogas = {};         // telefono → { hasta: 'YYYY-MM-DD', por, cuando, motivo }
/*
 * COBRO AUTOMÁTICO MENSUAL. El cliente que lo acepta paga una vez con
 * tarjeta y la deja guardada; de ahí en adelante, dos días antes de su fecha
 * de pago se le avisa y un día antes se le cobra lo que Wisphub diga que
 * debe. Aquí se anota qué se hizo en cada periodo, para no avisar ni cobrar
 * dos veces aunque el servidor se reinicie a media mañana.
 */
let autoCobros = {};        // telefono → { 'YYYY-MM-DD': { avisado, estado, cuando, ref, motivo } }
let lastCorteRunDate = '';  // 'YYYY-MM-DD' (México) de la última corrida de recordatorios de corte
// Bitácora de corridas del aviso de corte: una línea por día, para ver de un vistazo
// qué días SÍ salieron los avisos y cuáles se saltaron. Hace falta porque en Render
// gratis la instancia duerme: si nadie la despertaba a las 10:00, ese día nadie recibía
// nada y no quedaba ni un error. [{fecha, at, ok, sent, failed, alCorriente, motivo}]
let corteRunLog = [];
const CORTE_RUN_LOG_MAX = 90; // ~3 meses: alcanza para ver huecos sin inflar el estado
// Cuándo pidió el barrido el último refresco de Wisphub. NO se persiste a propósito: si
// el servidor reinicia queremos que lo reintente de inmediato.
let _corteLastSyncTry = 0;

// --- Modo Incidencia (falla masiva) ---
// Cuando el admin lo activa desde el panel, el bot AVISA a quien reporte una falla y
// NO crea ticket ni pinga al asesor (evita que 80 reportes saturen todo). Apagado
// (default) = el bot se comporta EXACTAMENTE igual que hoy.
// testNumber: si trae un número, el Modo Incidencia SOLO responde a ese número (para
// probar sin afectar a los clientes reales). Vacío = aplica a TODOS (falla real).
let incident = { active: false, zona: '', since: null, testNumber: '' };
let incidentAffected = new Set(); // chatIds que reportaron durante la incidencia (para avisar al restablecer)
function _last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

// --- Alertas al admin cuando algo falla (throttle por tipo, para no spamear) ---
const ALERT_ADMIN_NUMBER = process.env.ALERT_ADMIN_NUMBER || '9511603125';
const _alertLast = new Map(); // tipo -> ts del último aviso

// --- Anti-flood por número (rate-limit ligero del webhook) ---
const _msgRate = new Map();     // chatId -> [timestamps]
const RATE_MAX = Number(process.env.RATE_MAX) || 12;   // máx mensajes por ventana y número (las pruebas lo suben)
const RATE_WINDOW_MS = 30000;   // ventana de 30 s

// --- Bienvenida automática a NUEVOS clientes de Wisphub ---
// welcomedClients = teléfonos ya conocidos (no se les vuelve a saludar).
// welcomeSeeded = ya se hizo el "baseline" para NO saludar a los clientes existentes.
// welcomeReady = true tras hidratar (evita actuar con estado a medias / en arranque).
const NEW_CLIENT_WELCOME_ENABLED = String(process.env.NEW_CLIENT_WELCOME_ENABLED || 'true') === 'true';
const WELCOME_MAX_AGE_DAYS = Number(process.env.WELCOME_MAX_AGE_DAYS || 4); // solo saluda si la instalación es de los últimos N días
let welcomedClients = new Set();
let welcomeSeeded = false;
let welcomeReady = false;
let _wisphubSyncing = false;    // evita sincronizaciones/lecturas traslapadas de Wisphub

// Rate-limit por número: true si este chatId está mandando demasiado en la ventana.
function isFlooding(chatId) {
  try {
    const id = String(chatId);
    const now = Date.now();
    const arr = (_msgRate.get(id) || []).filter(t => now - t < RATE_WINDOW_MS);
    arr.push(now);
    _msgRate.set(id, arr);
    if (_msgRate.size > 4000) { // limpieza para no crecer sin límite
      for (const [k, v] of _msgRate) { if (now - (v[v.length - 1] || 0) > RATE_WINDOW_MS) _msgRate.delete(k); }
    }
    return arr.length > RATE_MAX;
  } catch (_) { return false; }
}

// ---- Plantilla EDITABLE del aviso de corte (con variables) -----------------
// Plantilla PREDETERMINADA (la de siempre). No se puede borrar ni editar; si no
// hay ninguna personalizada activa, se usa esta. Variables disponibles abajo.
const CORTE_MSG_DEFAULT =
  'Hola {nombre} 👋 Te recordamos que mañana {fecha} tu servicio de internet ' +
  'a nombre de {titular} está por vencer. Realiza tu pago a tiempo para evitar la suspensión del servicio. ' +
  '💳 Responde *PAGAR* y te muestro cómo y dónde pagar (efectivo o tarjeta en oficina, o transferencia). ' +
  'Si ya realizaste tu pago, por favor ignora este mensaje. — León Telecom 💙';
// Variables que se reemplazan por los datos de cada cliente (también las muestra el panel).
const CORTE_VARS = ['nombre', 'titular', 'fecha', 'plan'];
let corteTemplates = [];        // personalizadas: [{id, name, text, createdAt, updatedAt}]
let corteActiveId = 'default';  // 'default' o el id de UNA personalizada (nunca dos activas)

// Reemplaza {nombre}, {fecha}, etc. por su valor. Lo que no sea una variable
// conocida se deja tal cual (así un typo como {nombres} se nota en vez de borrarse).
function renderCorteVars(text, vars) {
  return String(text || '').replace(/\{\s*(\w+)\s*\}/g, (m, k) => {
    const key = k.toLowerCase();
    if (!CORTE_VARS.includes(key)) return m;
    const v = vars[key];
    return (v == null || v === '') ? '' : String(v);
  });
}
// Plantilla activa (o la predeterminada si la activa no existe / es 'default').
function activeCorteTemplate() {
  if (corteActiveId && corteActiveId !== 'default') {
    const t = corteTemplates.find(x => x.id === corteActiveId);
    if (t) return { id: t.id, name: t.name, text: t.text, isDefault: false };
  }
  return { id: 'default', name: 'Predeterminada', text: CORTE_MSG_DEFAULT, isDefault: true };
}
// Payload uniforme para el panel (predeterminada + personalizadas, marca la activa).
function corteTemplatesPayload() {
  const active = activeCorteTemplate();
  return {
    activeId: active.id,
    variables: CORTE_VARS,
    default: { id: 'default', name: 'Predeterminada', text: CORTE_MSG_DEFAULT, isDefault: true, active: active.id === 'default' },
    templates: corteTemplates.map(t => ({ ...t, isDefault: false, active: t.id === corteActiveId }))
  };
}

function logCase(clientId, name, type, resumen, extra = {}) {
  try {
    const num = String(clientId).replace(/\D/g, '');
    const c = {
      id: `caso-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      clientId: num,
      name: name || 'Sin nombre',
      type: type || 'otro',
      resumen: String(resumen || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      imageUrl: extra.imageUrl || '',
      docUrl: extra.docUrl || '',
      offHours: !isWithinBusinessHours(),
      status: 'pendiente'
    };
    caseLog.unshift(c);
    if (caseLog.length > CASE_LOG_MAX) caseLog.length = CASE_LOG_MAX;
    schedulePersist();
    return c;
  } catch (e) { console.error('[casos] log error:', e.message); return null; }
}

// Actualiza campos de un caso ya registrado (por id).
function updateCase(caseId, fields) {
  if (!caseId) return false;
  const c = caseLog.find(x => x.id === caseId);
  if (!c) return false;
  Object.assign(c, fields || {});
  if (fields && typeof fields.resumen === 'string') c.resumen = fields.resumen.replace(/\s+/g, ' ').trim().slice(0, 300);
  schedulePersist();
  return true;
}

// Marca como atendidos/recibidos los casos pendientes de un cliente.
// `agente` queda anotado para poder decir DESPUÉS quién atendió el caso, en vez
// de un "otro asesor" que obliga a preguntar por el grupo. Es opcional: los
// casos marcados antes de esto simplemente no lo traen.
function markCases(clientId, status, agente = '') {
  try {
    const num = String(clientId).replace(/\D/g, '');
    let n = 0;
    for (const c of caseLog) {
      if (c.clientId === num && c.status === 'pendiente') {
        c.status = status;
        if (agente) c.porAgente = String(agente).replace(/\D/g, '');
        n++;
      }
    }
    if (n) schedulePersist();
    return n;
  } catch (e) { return 0; }
}

// Quién gestionó por última vez el caso de este cliente ('' si no se sabe).
function quienGestiono(clientId) {
  const num = String(clientId).replace(/\D/g, '');
  for (const c of caseLog) if (c.clientId === num && c.porAgente) return c.porAgente;
  return '';
}

// Fecha 'YYYY-MM-DD' en zona horaria de Oaxaca (el server corre en UTC).
function mexicoDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// ===== PROMO DE AGOSTO 2026 — se enciende y se APAGA SOLA por fecha =====
// Hasta el 31/ago/2026 (hora de México): instalación a $600 (fibra Huitzo y
// centro de Telixtlahuaca) y el menú NO muestra "Migrar mi servicio".
// Desde el 1/sep/2026 todo regresa solo a la normalidad ($800 y menú completo)
// sin tocar nada ni redesplegar: estas funciones se evalúan en cada mensaje.
function promoAgostoActiva() { return mexicoDateStr() <= '2026-08-31'; }
function costoInstalacion() { return promoAgostoActiva() ? '$600' : '$800'; }
function notaPromoInstalacion() { return promoAgostoActiva() ? ' 🎉 ¡PROMO DE AGOSTO! (precio normal $800)' : ''; }

function isPaused(chatId) {
  const p = pausedChats.get(String(chatId));
  if (!p) return false;
  if (new Date() > p.pausedUntil) { pausedChats.delete(String(chatId)); return false; }
  return true;
}

function pauseChat(chatId, hours = 2) {
  pausedChats.set(String(chatId), { pausedUntil: new Date(Date.now() + hours * 3600000) });
  schedulePersist();
}

function unpauseChat(chatId) {
  pausedChats.delete(String(chatId));
  schedulePersist();
}

// ==================== WISPHUB INTEGRATION ====================
const WISPHUB_API_KEY = process.env.WISPHUB_API_KEY || '';
let wisphubClients = new Map(); // phone → { name, phone, status, wisphubId }
let lastWisphubSync = null;
let wisphubSyncError = null;
let lastWisphubTotal = null;      // activos revisados en el último sync
let lastWisphubSinTel = null;     // activos sin teléfono válido
let lastWisphubComplete = false;  // true SOLO si el último sync paginó COMPLETO (sin cortarse)

async function syncWisphubClients() {
  if (!WISPHUB_API_KEY) {
    return { synced: 0, error: 'WISPHUB_API_KEY no configurado' };
  }
  if (_wisphubSyncing) return { synced: 0, skipped: true }; // evita sincronizaciones traslapadas
  _wisphubSyncing = true;
  try {
    const base = (WISPHUB_API_URL || 'https://api.wisphub.net').replace(/\/$/, '');
    const schemes = ['Api-Key', 'Token', 'Bearer'];

    // 1ª página: detectamos el esquema de Authorization correcto.
    let authHeader = null, lastTxt = '';
    let data = null;
    const firstUrl = `${base}/api/clientes/?format=json&limit=500&estado=1`;
    for (const scheme of schemes) {
      const res = await wisphubFetch(firstUrl, { headers: { 'Authorization': `${scheme} ${WISPHUB_API_KEY}` } }, 'sync: primera página');
      if (res.ok) { authHeader = `${scheme} ${WISPHUB_API_KEY}`; data = await res.json(); console.log(`[Wisphub] Autenticado con esquema "${scheme}"`); break; }
      lastTxt = await res.text().catch(() => '');
      if (res.status !== 401 && res.status !== 403) {
        // 5xx o similar: el servidor de WISPHUB está fallando. No es la llave.
        const esHtml = /<!DOCTYPE|<html/i.test(lastTxt);
        throw new Error(`Wisphub respondió error ${res.status}${esHtml ? ' (página de error de su servidor)' : ': ' + lastTxt.slice(0, 120)}. La llave está bien; es una falla del lado de Wisphub y se reintenta solo.`);
      }
    }
    if (!authHeader) throw new Error('Wisphub rechazó la llave de API (401/403). Hay que revisar WISPHUB_API_KEY en Render.');

    /*
     * La lista nueva se arma APARTE y solo sustituye a la buena si sale entera.
     *
     * Antes se vaciaba aquí mismo, antes de leer nada. Con eso, un Wisphub que
     * contestara 200 con la lista vacía —una llave sin permisos, un filtro que
     * les cambia, un mal día de su API— dejaba al bot con CERO clientes: no
     * reconocía a nadie, nadie podía pedir su CLABE, y el respaldo que existe
     * justo para eso se sobrescribía vacío en el siguiente guardado. Lo mismo si
     * la paginación se cortaba a la mitad: se quedaba con 500 de 1,430 y los
     * otros 930 dejaban de existir hasta la siguiente sincronización, seis
     * horas después.
     *
     * Ahora una lista peor que la que ya se tiene se rechaza y se conserva la
     * anterior, que es vieja pero completa.
     */
    const nuevos = new Map();
    const teniamos = wisphubClients.size;
    let synced = 0, revisados = 0, pages = 0, offset = 0;
    const count = (data && data.count) || null;

    // Paginación MANUAL por offset (siempre https). Los "next" de Wisphub vienen
    // en http:// y al seguirlos se pierde la autenticación, por eso no los usamos.
    // Tope alto (pages < 2000 ≈ 600,000 clientes) para crecer sin límite práctico.
    const PAGE = 500;
    let complete = false; // ¿paginó todo sin cortarse? (clave para la bienvenida a nuevos)
    while (data && pages < 2000) {
      const items = Array.isArray(data) ? data : (data.results || []);
      if (!items.length) { complete = true; break; } // ya no hay más datos
      revisados += items.length;
      for (const c of items) {
        const rawPhone = c.telefono || c.celular || c.phone || '';
        if (!rawPhone) continue;
        let phone = String(rawPhone).replace(/\D/g, '');
        if (phone.length === 10) phone = '52' + phone;
        if (phone.startsWith('521') && phone.length === 13) phone = '52' + phone.slice(3);
        if (phone.length < 12) continue; // teléfono inválido
        const name = [c.nombre, c.apellidos].filter(Boolean).join(' ') || c.razon_social || c.usuario || rawPhone;
        nuevos.set(phone, {
          name, phone, status: c.estado, wisphubId: c.id_servicio || c.id, source: 'wisphub',
          // Datos de cuenta para la búsqueda/estado de cuenta en el panel:
          saldo: c.saldo, fechaCorte: c.fecha_corte,
          fechaInstalacion: c.fecha_instalacion, // para distinguir cliente NUEVO de reactivado
          plan: (c.plan_internet && c.plan_internet.nombre) || c.plan_internet || '',
          precioPlan: c.precio_plan, estadoFacturas: c.estado_facturas, usuario: c.usuario
        });
        synced++;
      }
      offset += items.length;
      pages++;
      if (count && offset >= count) { complete = true; break; } // llegamos al total
      const res = await wisphubFetch(`${base}/api/clientes/?format=json&limit=${PAGE}&offset=${offset}&estado=1`, { headers: { 'Authorization': authHeader } }, 'sync: clientes (offset ' + offset + ')');
      if (!res.ok) break; // ⚠️ se cortó a media paginación → NO es un sync completo
      data = await res.json();
    }

    /*
     * ¿Esta lista está en condiciones de sustituir a la que ya tenemos?
     *
     * La primera sincronización de todas entra siempre: algo es mejor que nada.
     * Después, solo se acepta si llegó completa o si al menos no encogió.
     */
    let rechazo = '';
    if (teniamos) {
      if (!nuevos.size) rechazo = 'Wisphub contestó bien pero no devolvió ni un cliente';
      else if (!complete && nuevos.size < teniamos) rechazo = `la lista llegó cortada (${nuevos.size} de ${teniamos})`;
    }
    if (rechazo) {
      wisphubSyncError = rechazo;
      console.error('[Wisphub] Sync RECHAZADO:', rechazo, '— se conserva la lista anterior de', teniamos);
      alertAdmin('wisphub', [
        'La sincronización con Wisphub trajo una lista peor que la que ya teníamos.',
        `Motivo: ${rechazo}.`,
        `El bot sigue trabajando con la última lista buena (${teniamos} clientes).`,
        'Se reintenta solo cada 6 horas. Si se repite todo el día, hay que revisar la llave o los permisos en Wisphub.',
      ].join('\n'));
      return { synced: 0, error: rechazo, conservados: teniamos };
    }

    wisphubClients.clear();
    for (const [k, v] of nuevos) wisphubClients.set(k, v);

    const unicos = wisphubClients.size;       // números de WhatsApp únicos (lo real)
    const sinTelefono = revisados - synced;   // activos sin teléfono válido en Wisphub
    const repetidos = synced - unicos;        // comparten número con otro cliente
    lastWisphubSync = new Date().toISOString();
    wisphubSyncError = null;
    lastWisphubTotal = revisados;
    lastWisphubSinTel = sinTelefono;
    lastWisphubComplete = complete; // la bienvenida a nuevos solo actúa si esto es true
    console.log(`[Wisphub] Sync OK: ${unicos} números únicos | ${revisados} activos | ${sinTelefono} sin teléfono válido | ${repetidos} con número repetido`);
    return { synced: unicos, total: revisados, sinTelefono, repetidos };
  } catch (e) {
    wisphubSyncError = e.message;
    console.error('[Wisphub] Sync error:', e.message);
    alertAdmin('wisphub', [
      'Falló la sincronización con Wisphub.',
      `Motivo: ${String(e.message || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`,
      `El bot sigue trabajando con la última lista buena (${wisphubClients.size} clientes en memoria).`,
      'Se reintenta solo cada 6 horas; no hay que hacer nada salvo que se repita todo el día.',
    ].join('\n'));
    return { synced: 0, error: e.message };
  } finally {
    _wisphubSyncing = false;
  }
}

// Bienvenida automática a NUEVOS clientes de Wisphub. Lee la lista YA sincronizada
// (no toca el sync) y solo actúa tras hidratar. La PRIMERA vez marca a todos los
// clientes actuales como "conocidos" SIN enviar nada (baseline), para no saludar a
// los existentes; después solo saluda a los que aparezcan nuevos. Con tope de
// seguridad: si aparecen demasiados "nuevos" de golpe, NO envía (avisa al admin).
// Parsea la fecha de instalación de Wisphub ("DD/MM/YYYY HH:MM:SS" o "DD/MM/YYYY").
function parseInstallDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(dt.getTime()) ? null : dt;
}
// ¿La instalación es RECIENTE (cliente realmente nuevo, no reactivado)? Sin fecha → NO.
function isRecentInstall(v, days = WELCOME_MAX_AGE_DAYS) {
  const dt = parseInstallDate(v);
  if (!dt) return false;
  const age = Date.now() - dt.getTime();
  return age >= -86400000 && age <= days * 86400000; // instalado en los últimos <days> días
}

async function sweepNewClients() {
  try {
    // Solo actúa sobre un sync VERIFICADAMENTE COMPLETO (lastWisphubComplete). Un sync
    // que se cortó a media paginación daría una lista parcial y haría ver como "nuevos"
    // a clientes EXISTENTES → jamás sembramos ni saludamos con una lista incompleta.
    if (!welcomeReady || _wisphubSyncing || wisphubSyncError || !lastWisphubComplete || !wisphubClients.size) return;
    const current = new Set(wisphubClients.keys());
    if (!welcomeSeeded) {
      for (const ph of current) welcomedClients.add(ph);
      welcomeSeeded = true; schedulePersist();
      console.log(`[bienvenida] baseline: ${welcomedClients.size} clientes marcados como conocidos (sin enviar).`);
      return;
    }
    if (!NEW_CLIENT_WELCOME_ENABLED) return;
    const nuevos = [...current].filter(ph => !welcomedClients.has(ph));
    if (!nuevos.length) return;
    // Marca TODOS los "nuevos" como conocidos (para no re-evaluarlos) y separa los que
    // REALMENTE son nuevos (instalación reciente) de los existentes/reactivados (fecha
    // de instalación vieja) → estos NO reciben bienvenida (solo se marcan).
    const recientes = [];
    for (const ph of nuevos) {
      welcomedClients.add(ph);
      const c = wisphubClients.get(ph);
      if (c && isRecentInstall(c.fechaInstalacion)) recientes.push(ph);
    }
    schedulePersist();
    if (!recientes.length) return; // eran reactivaciones/existentes, no clientes nuevos
    if (recientes.length > 30) { // anomalía real: demasiados nuevos-recientes de golpe
      console.warn(`[bienvenida] ${recientes.length} nuevos recientes de golpe — NO envío por seguridad.`);
      alertAdmin('bienvenida-anomala', `Aparecieron ${recientes.length} clientes nuevos (instalación reciente) de golpe; NO se enviaron bienvenidas por seguridad.`);
      return;
    }
    for (const ph of recientes) {
      const c = wisphubClients.get(ph);
      try { await sendNewClientWelcome(ph, c && c.name); console.log(`[bienvenida] enviada a nuevo cliente ${ph}`); }
      catch (e) { console.error('[bienvenida] falló envío a', ph, e.message); }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    console.error('[bienvenida] sweep error:', e.message);
  }
}

// Auto-sync on startup + every 6 hours
syncWisphubClients();
setInterval(syncWisphubClients, 6 * 3600 * 1000);

// ==================== MANUAL CLIENT DATABASE ====================
const manualClients = new Map(); // phoneNumber → { name, phone, addedAt, notes }

function normalizePhone(raw) {
  let p = raw.replace(/\D/g, '');
  if (p.length === 10) p = '52' + p;
  if (p.startsWith('521') && p.length === 13) p = '52' + p.slice(3);
  return p;
}

function getAllBroadcastRecipients() {
  const seen = new Set();
  const recipients = [];
  // 1. Wisphub clients (most authoritative)
  for (const [phone, client] of wisphubClients.entries()) {
    if (!seen.has(phone)) {
      seen.add(phone);
      recipients.push({ chatId: phone, name: client.name, source: 'wisphub' });
    }
  }
  // 2. Manually added clients
  for (const [phone, client] of manualClients.entries()) {
    if (!seen.has(phone)) {
      seen.add(phone);
      recipients.push({ chatId: phone, name: client.name || phone, source: 'manual' });
    }
  }
  // 3. Auto-discovered bot clients
  for (const user of dataManager.getAllUsers()) {
    if (user.platform === 'whatsapp' && !seen.has(user.chatId)) {
      seen.add(user.chatId);
      recipients.push({ chatId: user.chatId, name: user.name, source: 'bot' });
    }
  }
  return recipients;
}

// ==================== ADMIN BROADCAST SYSTEM ====================
const scheduledBroadcasts = new Map(); // id → broadcast object
const broadcastHistory = []; // Array of sent records

function generateBroadcastId() {
  return `BC-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
}

async function sendBulkWhatsApp(message, imageUrls = []) {
  const recipients = getAllBroadcastRecipients();
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await sendWhatsAppMessage(r.chatId, message, imageUrls);
      sent++;
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 200));
  }
  return { sent, failed, total: recipients.length };
}

// Envía una PLANTILLA aprobada (funciona aunque hayan pasado +24h sin chatear).
// opts.templateName: nombre de la plantilla (default = aviso). opts.imageUrl: imagen de encabezado.
async function sendWhatsAppTemplate(to, message, opts = {}) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) throw new Error('Faltan credenciales de WhatsApp');
  const name = opts.templateName || WHATSAPP_AVISO_TEMPLATE;
  if (!name) throw new Error('Plantilla no configurada');
  // El parámetro de una plantilla no admite saltos de línea ni espacios largos.
  const param = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const components = [];
  if (opts.imageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: opts.imageUrl } }] });
  components.push({ type: 'body', parameters: [{ type: 'text', text: param }] });
  // Botón de respuesta rápida. Solo funciona si la plantilla aprobada en Meta
  // YA trae ese botón definido; si no, Meta rechaza el envío.
  if (opts.buttonPayload) {
    components.push({
      type: 'button', sub_type: 'quick_reply', index: '0',
      parameters: [{ type: 'payload', payload: String(opts.buttonPayload) }]
    });
  }
  const res = await fetch(`${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: WHATSAPP_TEMPLATE_LANG }, components }
    })
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`); }
  return true;
}

/*
 * AVISOS QUE EL BOT MANDA POR SU CUENTA (nadie escribió antes).
 *
 * WhatsApp solo deja mandar texto libre dentro de las 24 h siguientes al
 * último mensaje del cliente. Un "se cobró tu mensualidad", un "¿ya quedó tu
 * servicio?" tres días después, o el aviso al dueño de que otra persona pagó
 * por él, casi siempre caen FUERA de esa ventana: Meta los rechaza en
 * silencio (error 131047) y nadie se entera. Por eso van por la plantilla
 * aprobada de avisos, igual que el recordatorio de corte. Si no hay plantilla
 * configurada, se intenta el texto libre: mejor un intento que ninguno.
 */
async function avisarPorIniciativa(to, message, opts = {}) {
  if (WHATSAPP_AVISO_TEMPLATE) {
    try { return await sendWhatsAppTemplate(to, message, opts); }
    catch (e) { console.warn('[aviso] plantilla falló para', to, '·', e.message); }
  }
  return sendWhatsAppMessage(to, message);
}

// Envío masivo por PLANTILLA a todos los clientes (sin límite 24h).
async function sendBulkTemplate(message, opts = {}) {
  const recipients = getAllBroadcastRecipients();
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try { await sendWhatsAppTemplate(r.chatId, message, opts); sent++; }
    catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 200));
  }
  return { sent, failed, total: recipients.length };
}

// Decide el método de envío masivo:
//  - Con imagen + plantilla de promo → plantilla con imagen (llega a TODOS).
//  - Sin imagen + plantilla de aviso → plantilla de texto (llega a TODOS).
//  - Si no hay plantilla → texto/imagen normal (solo dentro de 24h).
async function sendBroadcastSmart(message, imageUrls = []) {
  const img = imageUrls && imageUrls[0];
  if (img && WHATSAPP_PROMO_TEMPLATE) return await sendBulkTemplate(message, { templateName: WHATSAPP_PROMO_TEMPLATE, imageUrl: img });
  if (!img && WHATSAPP_AVISO_TEMPLATE) return await sendBulkTemplate(message);
  return await sendBulkWhatsApp(message, imageUrls);
}

// Avisa al admin (a ALERT_ADMIN_NUMBER) cuando algo crítico falla. Usa la plantilla
// de utilidad (llega aunque no haya chat reciente) y hace throttle por tipo: no
// repite el mismo aviso en 30 min. Nunca lanza: si el aviso falla, no pasa nada.
async function alertAdmin(type, message) {
  try {
    const now = Date.now();
    if (now - (_alertLast.get(type) || 0) < 30 * 60 * 1000) return;
    _alertLast.set(type, now);
    const to = normalizePhone(String(ALERT_ADMIN_NUMBER || ''));
    if (!to || to.length < 12) return;
    const txt = `⚠️ Alerta del bot León Telecom\n${String(message || '').slice(0, 500)}`;
    if (WHATSAPP_AVISO_TEMPLATE) {
      await sendWhatsAppTemplate(to, txt).catch(() => sendWhatsAppMessage(to, txt).catch(() => {}));
    } else {
      await sendWhatsAppMessage(to, txt).catch(() => {});
    }
  } catch (_) { /* nunca romper por una alerta */ }
}

// Mensaje de bienvenida/agradecimiento a un cliente recién dado de alta en Wisphub.
async function sendNewClientWelcome(phone, name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const nombre = first ? (first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()) : 'cliente';
  const txt = `¡Hola ${nombre}! 🎉 Te damos la bienvenida a *León Telecom* y te agradecemos por contratar tu servicio de internet con nosotros. 💙 ` +
    `Por este WhatsApp puedes reportar una falla, enviar tu comprobante de pago o pedir soporte cuando lo necesites. ` +
    `Escribe *hola* y con gusto te atendemos. ¡Bienvenido(a) a la familia León Telecom!`;
  if (WHATSAPP_AVISO_TEMPLATE) return sendWhatsAppTemplate(phone, txt);
  return sendWhatsAppMessage(phone, txt);
}

// Scheduler — checks every 60s if any broadcast needs to be sent
let _schedulerBusy = false;
setInterval(async () => {
  if (_schedulerBusy) return; // evita pasadas concurrentes: un envío largo NO se re-dispara
  _schedulerBusy = true;
  try {
    const now = new Date();
    for (const [id, bc] of scheduledBroadcasts.entries()) {
      if (bc.status !== 'active') continue;
      if (bc.endAt && now > new Date(bc.endAt)) {
        bc.status = 'completed';
        scheduledBroadcasts.set(id, bc);
        continue;
      }
      if (now >= new Date(bc.nextSendAt)) {
        // RESERVAR el próximo envío ANTES de mandar. Así, aunque el envío masivo
        // tarde varios minutos, el siguiente tick ya NO lo ve "pendiente" y no se
        // vuelve a disparar (ESTE era el bug del bucle).
        if (bc.intervalMs) {
          const next = new Date(now.getTime() + bc.intervalMs);
          if (!bc.endAt || next <= new Date(bc.endAt)) bc.nextSendAt = next.toISOString();
          else bc.status = 'completed';
        } else {
          bc.status = 'completed';
        }
        scheduledBroadcasts.set(id, bc);
        schedulePersist();
        try {
          const result = await sendBroadcastSmart(bc.message, bc.imageUrls || []);
          bc.sentCount = (bc.sentCount || 0) + 1;
          bc.lastSentAt = now.toISOString();
          broadcastHistory.unshift({ id, type: bc.type, label: bc.label, message: bc.message, sentAt: now.toISOString(), result });
          if (broadcastHistory.length > 100) broadcastHistory.pop();
          scheduledBroadcasts.set(id, bc);
          schedulePersist();
        } catch (e) { console.error('[Broadcast scheduler error]', e.message); }
      }
    }
  } finally { _schedulerBusy = false; }
}, 60000);

// Simple in-memory session store keyed by chatId. Keeps short conversational state.
const sessions = new Map();

function getSession(chatId) {
  return sessions.get(String(chatId)) || { state: null, data: {} };
}

function setSession(chatId, session) {
  sessions.set(String(chatId), session);
  // Las de pago se guardan: son las que no pueden perderse en un reinicio.
  if (session && /^pago_(otro_|servicio_)/.test(String(session.state || ''))) schedulePersist();
}

function clearSession(chatId) {
  const habia = sessions.get(String(chatId));
  sessions.delete(String(chatId));
  if (habia && /^pago_(otro_|servicio_)/.test(String(habia.state || ''))) schedulePersist();
}

// In-memory folio store - tracks active appointment folios for cancellation
// Structure: folios[folio] = { chatId, type, location, createdAt }
const folios = new Map();

// ==================== TICKETS DE SOPORTE ====================
// Cada falla reportada por un cliente genera un ticket. Persistido en state.tickets.
const tickets = new Map(); // id → { id, folio, chatId, name, problema, ubicacion, estado, tecnico, nota, createdAt, updatedAt }
function createTicket(chatId, name, problema, ubicacion) {
  const id = 'tk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const folio = 'SOP-' + Date.now().toString(36).toUpperCase().slice(-5) + Math.random().toString(36).slice(2, 4).toUpperCase();
  const now = new Date().toISOString();
  const t = { id, folio, chatId: String(chatId), name: name || '', problema: problema || '', ubicacion: ubicacion || '', estado: 'abierto', tecnico: '', nota: '', createdAt: now, updatedAt: now };
  tickets.set(id, t);
  schedulePersist();
  return t;
}

function storeFolio(folio, chatId, type, location) {
  folios.set(folio, {
    chatId: String(chatId),
    type: type, // 'installation' or 'migration'
    location: location,
    createdAt: new Date()
  });
  schedulePersist();
}

function retrieveFolio(folio) {
  return folios.get(folio) || null;
}

function cancelFolio(folio) {
  const ok = folios.delete(folio);
  schedulePersist();
  return ok;
}

// ==================== HISTORIAL / BITÁCORA ====================
// Todo lo que se hace desde el panel (quién, qué, cuándo y con qué resultado)
// y todas las llamadas a la API de Wisphub. Se guarda con el resto del estado.
const AUDIT_MAX = 1000;          // movimientos del panel que conservamos
const WISPHUB_LOG_MAX = 300;     // llamadas a Wisphub que conservamos
let auditLog = [];               // [{ts, user, name, role, ip, accion, detalle, ok, ms}]
let wisphubLog = [];             // [{ts, op, url, status, ok, ms, items, error, por}]

// Nombre legible de cada acción del panel (método + ruta → qué hizo).
const ACCIONES = [
  [/^POST \/admin\/api\/broadcast$/, 'Envió un aviso masivo'],
  [/^DELETE \/admin\/api\/broadcasts\//, 'Canceló un aviso programado'],
  [/^PATCH \/admin\/api\/broadcasts\//, 'Modificó un aviso programado'],
  [/^POST \/admin\/api\/incident$/, 'Cambió el Modo Incidencia'],
  [/^POST \/admin\/api\/users$/, 'Creó un usuario del panel'],
  [/^PATCH \/admin\/api\/users\//, 'Editó un usuario del panel'],
  [/^DELETE \/admin\/api\/users\//, 'Eliminó un usuario del panel'],
  [/^POST \/admin\/api\/products$/, 'Agregó un producto'],
  [/^PATCH \/admin\/api\/products\//, 'Editó un producto'],
  [/^DELETE \/admin\/api\/products\//, 'Eliminó un producto'],
  [/^POST \/admin\/api\/plans$/, 'Agregó un plan'],
  [/^PATCH \/admin\/api\/plans\//, 'Editó un plan'],
  [/^DELETE \/admin\/api\/plans\//, 'Eliminó un plan'],
  [/^POST \/admin\/api\/promo-banner$/, 'Creó un banner promocional'],
  [/^PATCH \/admin\/api\/promo-banner\//, 'Editó el banner promocional'],
  [/^DELETE \/admin\/api\/promo-banner\//, 'Eliminó un banner promocional'],
  [/^POST \/admin\/api\/corte-templates$/, 'Creó una plantilla de corte'],
  [/^PATCH \/admin\/api\/corte-templates\//, 'Editó/activó una plantilla de corte'],
  [/^DELETE \/admin\/api\/corte-templates\//, 'Eliminó una plantilla de corte'],
  [/^POST \/admin\/api\/corte-reminders\/run$/, 'Forzó el envío de recordatorios de corte'],
  [/^PATCH \/admin\/api\/tickets\/.*$/, 'Actualizó un ticket de soporte'],
  [/^DELETE \/admin\/api\/tickets\//, 'Eliminó un ticket'],
  [/^POST \/admin\/api\/tickets\/.*\/notify$/, 'Notificó por WhatsApp a un cliente'],
  [/^POST \/admin\/api\/clients$/, 'Agregó un cliente manual'],
  [/^DELETE \/admin\/api\/clients\//, 'Eliminó un cliente manual'],
  [/^POST \/admin\/api\/wisphub-sync$/, 'Sincronizó clientes con Wisphub'],
  [/^POST \/admin\/api\/upload-image$/, 'Subió una imagen'],
  [/^POST \/admin\/api\/send-message$/, 'Envió un anuncio (Telegram)'],
  [/^POST \/admin\/api\/send-promotion$/, 'Envió una promoción (Telegram)'],
  [/^POST \/admin\/api\/login$/, 'Inició sesión'],
];
function nombreAccion(metodo, ruta) {
  const clave = metodo + ' ' + ruta;
  for (const [rx, txt] of ACCIONES) if (rx.test(clave)) return txt;
  return metodo + ' ' + ruta;
}
// Resumen corto y SIN datos sensibles de lo que mandó el usuario.
const CAMPOS_OCULTOS = new Set(['token', 'password', 'newPassword', 'imageBase64', 'image', 'photo']);
function resumenDetalle(req) {
  const partes = [];
  if (req.params && Object.keys(req.params).length) {
    for (const [k, v] of Object.entries(req.params)) partes.push(`${k}=${String(v).slice(0, 40)}`);
  }
  const b = req.body || {};
  for (const [k, v] of Object.entries(b)) {
    if (CAMPOS_OCULTOS.has(k) || v == null) continue;
    let txt;
    if (typeof v === 'string') txt = v.length > 60 ? v.slice(0, 60) + '…' : v;
    else if (typeof v === 'boolean' || typeof v === 'number') txt = String(v);
    else if (Array.isArray(v)) txt = `[${v.length}]`;
    else continue;
    partes.push(`${k}: ${txt}`);
    if (partes.length >= 6) break;
  }
  return partes.join(' · ');
}
function registrarAuditoria(entrada) {
  auditLog.unshift(entrada);
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
  schedulePersist();
}
function registrarWisphub(entrada) {
  wisphubLog.unshift({ ts: new Date().toISOString(), ...entrada });
  if (wisphubLog.length > WISPHUB_LOG_MAX) wisphubLog.length = WISPHUB_LOG_MAX;
}
// Llamada a Wisphub instrumentada: mide, registra y devuelve la respuesta tal cual.
async function wisphubFetch(url, opts, op, por) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, opts);
    registrarWisphub({ op, url: String(url).split('?')[0], status: r.status, ok: r.ok, ms: Date.now() - t0, por: por || 'sistema' });
    return r;
  } catch (e) {
    registrarWisphub({ op, url: String(url).split('?')[0], status: 0, ok: false, ms: Date.now() - t0, error: e.message, por: por || 'sistema' });
    throw e;
  }
}

// ==================== PERSISTENCIA DE ESTADO ====================
// Toma una "foto" de todas las colecciones en memoria para guardarlas.
function buildStateSnapshot() {
  const mapToObj = (m) => Object.fromEntries(m);
  return {
    clientProfiles: mapToObj(clientProfiles),
    manualClients: mapToObj(manualClients),
    scheduledBroadcasts: mapToObj(scheduledBroadcasts),
    broadcastHistory: broadcastHistory.slice(0, 200),
    folios: mapToObj(folios),
    pausedChats: Object.fromEntries(
      [...pausedChats].map(([k, v]) => [k, { pausedUntil: v.pausedUntil instanceof Date ? v.pausedUntil.toISOString() : v.pausedUntil }])
    ),
    agentActiveCases: mapToObj(agentActiveCases),
    pendingAgentRequests: Object.fromEntries(
      [...pendingAgentRequests].map(([k, v]) => [k, { ...v, since: v.since instanceof Date ? v.since.toISOString() : v.since }])
    ),
    adminUsers: mapToObj(adminUsers),
    products: products,
    plans: plans,
    stats: stats,
    tickets: mapToObj(tickets),
    promoBanners: promoBanners,
    caseLog: caseLog.slice(0, CASE_LOG_MAX),
    lastDigestDate: lastDigestDate,
    agentLastInbound: mapToObj(agentLastInbound),
    agentPingSent: mapToObj(agentPingSent),
    corteReminders: corteReminders,
    lastCorteRunDate: lastCorteRunDate,
    corteRunLog: corteRunLog.slice(0, CORTE_RUN_LOG_MAX),
    corteTemplates: corteTemplates,
    corteActiveId: corteActiveId,
    welcomedClients: [...welcomedClients],
    welcomeSeeded: welcomeSeeded,
    incident: incident,
    auditLog: auditLog.slice(0, AUDIT_MAX),
    wisphubLog: wisphubLog.slice(0, WISPHUB_LOG_MAX),
    // Copia de seguridad de la lista de clientes: si Render reinicia mientras Wisphub
    // está caído, el bot arrancaba SIN NINGÚN cliente (no reconocía a nadie, ni corte,
    // ni estados de cuenta). Con esto restaura la última lista buena y sigue operando.
    wisphubClientes: Object.fromEntries(wisphubClients),
    wisphubClientesAl: lastWisphubSync || null,
    // La CLABE de cada cliente: se guarda porque no puede cambiar nunca.
    stripeClientes: Object.fromEntries(stripeClientes),
    // Para cazar pagos dobles entre canales tras un reinicio de Render.
    stripePagosRecientes: Object.fromEntries(stripePagosRecientes),
    prorrogas,
    autoCobros,
    /*
     * Solo las sesiones de PAGO (a quién le paga, qué contrato, cuántos
     * meses). Son las que duelen si el servidor se reinicia a media
     * conversación: el cliente ya dijo "es la cuenta de mi mamá", toca
     * Tarjeta, y de pronto el bot le cotiza la suya. Caducan solas a la
     * media hora, así que guardar las demás no aporta nada.
     */
    sesionesDePago: Object.fromEntries([...sessions].filter(([, v]) => v && /^pago_(otro_|servicio_)/.test(String(v.state || '')))),
    stripeRegistrosPendientes: stripeRegistrosPendientes.slice(-REGISTRO_PENDIENTE_MAX),
    /*
     * Los avisos de Stripe ya procesados.
     *
     * Se guardan porque Stripe reintenta un aviso hasta por tres días, y Render
     * reinicia cada vez que se despliega. Si esto viviera solo en memoria, el
     * reintento que cae DESPUÉS de un reinicio encontraría la lista vacía y
     * volvería a correr el pago entero: segundo "ya quedó" al cliente, segunda
     * reactivación, y una falsa alerta de pago doble sobre un pago que era uno.
     */
    stripeVistos: Object.fromEntries(stripeVistos),
    // Depósitos que entraron a Stripe y todavía NO llegaron a León Telecom.
    stripeSaldosRezagados: Object.fromEntries(stripeSaldosRezagados),
    stripeCargosPerdidos: stripeCargosPerdidos.slice(-CARGOS_PERDIDOS_MAX),
    /*
     * La cuenta de Stripe a la que le cae el dinero de León.
     *
     * Se persiste porque se da de alta UNA vez desde su panel. Si se perdiera
     * en un reinicio, el sistema creería que nunca la dio de alta y le pediría
     * hacer otra: dos cuentas conectadas, el dinero partido entre las dos y
     * ninguna forma sencilla de juntarlo.
     */
    stripeCuentaLeon: stripeCuentaLeon || null,
    stripePilotoLeon: stripePilotoLeon || null,
    stripeCobrado: Object.fromEntries(stripeCobrado)
  };
}

/*
 * Qué cliente de Stripe es cada teléfono, y qué CLABE se le entregó.
 *
 * Se persiste con el resto del estado porque la CLABE tiene que ser la MISMA
 * para siempre: el cliente ya la anotó en su banco. Si esto se perdiera en un
 * reinicio, la búsqueda en Stripe es el respaldo, pero esa búsqueda tarda en
 * indexar y podría crear un cliente duplicado con otra CLABE. El registro es lo
 * que hace que eso no pase nunca.
 */
/*
 * Cuántos clientes hay, para poder repartir un cupo de "50 clientes" sin que
 * nadie tenga que convertirlo a porcentaje a mano cada vez que crece el padrón.
 */
stripeLeon.usarPadron({
  total: () => wisphubClients.size,
  telefonos: () => Array.from(wisphubClients.keys()),
  /*
   * Quiénes deberían entrar primero al piloto: los que están suspendidos o con
   * adeudo. Son los que de verdad van a usar el pago en línea. Un piloto hecho
   * con clientes que pagan puntual en la oficina mide mal, y puede hacer
   * parecer que la cosa no sirve cuando lo que pasa es que a esos no les hacía
   * falta.
   */
  prioritarios: () => Array.from(wisphubClients.entries())
    .filter(([, c]) => /suspend|corte|adeud|moroso/i.test(String((c && c.status) || '')))
    .map(([tel]) => tel),
});

/*
 * Quiénes quedaron dentro del piloto. Se guarda con el resto del estado porque
 * la decisión se toma una vez: si se perdiera en un reinicio, se elegirían
 * otros 50 y los primeros perderían la opción de un día para otro.
 */
let stripePilotoLeon = null;
stripeLeon.usarPiloto({
  obtener: () => stripePilotoLeon,
  guardar: (datos) => { stripePilotoLeon = datos; schedulePersist(); },
});

let stripeCuentaLeon = null;
stripeLeon.usarCuenta({
  obtener: () => stripeCuentaLeon,
  guardar: (datos) => { stripeCuentaLeon = datos; schedulePersist(); },
});

const stripeClientes = new Map();
stripeLeon.usarRegistro({
  obtener: (tel) => stripeClientes.get(String(tel)) || null,
  guardar: (tel, datos) => {
    /*
     * Se FUNDE con lo que ya había, no se reemplaza. En el mismo registro
     * viven la CLABE, el cobro automático y "pagado hasta": si sacar la CLABE
     * borrara lo demás, un cliente perdería su cobro automático (o sus meses
     * adelantados) por pedir su número de cuenta.
     */
    stripeClientes.set(String(tel), { ...(stripeClientes.get(String(tel)) || {}), ...datos });
    schedulePersist();
  },
});

// Restaura las colecciones desde lo guardado (al arrancar el servidor).
function hydrateState(s) {
  if (!s || typeof s !== 'object') return;
  if (Array.isArray(s.auditLog)) auditLog = s.auditLog.slice(0, AUDIT_MAX);
  // Lista de Wisphub de respaldo: solo si la memoria está vacía (el sync real manda).
  if (s.wisphubClientes && typeof s.wisphubClientes === 'object' && !wisphubClients.size) {
    for (const [k, v] of Object.entries(s.wisphubClientes)) wisphubClients.set(k, v);
    if (s.wisphubClientesAl) lastWisphubSync = s.wisphubClientesAl;
    if (wisphubClients.size) console.log(`[Wisphub] Lista restaurada del respaldo: ${wisphubClients.size} clientes (del ${String(s.wisphubClientesAl || '').slice(0, 16)})`);
  }
  if (Array.isArray(s.wisphubLog)) wisphubLog = s.wisphubLog.slice(0, WISPHUB_LOG_MAX);
  /*
   * La cuenta de cobro de León, primero que nada: el módulo tiene que saberla
   * ANTES de que llegue el primer pago, no después.
   */
  if (s.stripeCobrado && typeof s.stripeCobrado === 'object') {
    for (const [k, v] of Object.entries(s.stripeCobrado)) stripeCobrado.set(String(k), v);
  }
  if (s.stripePilotoLeon && Array.isArray(s.stripePilotoLeon.telefonos)) {
    stripePilotoLeon = s.stripePilotoLeon;
    stripeLeon.usarPiloto({
      obtener: () => stripePilotoLeon,
      guardar: (datos) => { stripePilotoLeon = datos; schedulePersist(); },
    });
  }
  if (s.stripeCuentaLeon && s.stripeCuentaLeon.id) {
    stripeCuentaLeon = s.stripeCuentaLeon;
    stripeLeon.usarCuenta({
      obtener: () => stripeCuentaLeon,
      guardar: (datos) => { stripeCuentaLeon = datos; schedulePersist(); },
    });
  }
  if (s.stripeClientes && typeof s.stripeClientes === 'object') {
    for (const [k, v] of Object.entries(s.stripeClientes)) stripeClientes.set(String(k), v);
  }
  if (Array.isArray(s.stripeRegistrosPendientes)) {
    stripeRegistrosPendientes = s.stripeRegistrosPendientes.slice(-REGISTRO_PENDIENTE_MAX);
  }
  if (s.stripePagosRecientes && typeof s.stripePagosRecientes === 'object') {
    for (const [k, v] of Object.entries(s.stripePagosRecientes)) {
      if (Array.isArray(v)) stripePagosRecientes.set(String(k), v);
    }
  }
  if (s.stripeVistos && typeof s.stripeVistos === 'object') {
    // Solo lo del último día: lo más viejo Stripe ya no lo va a reintentar.
    const limite = Date.now() - 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(s.stripeVistos)) {
      if (Number(v) > limite) stripeVistos.set(String(k), Number(v));
    }
  }
  if (s.stripeSaldosRezagados && typeof s.stripeSaldosRezagados === 'object') {
    for (const [k, v] of Object.entries(s.stripeSaldosRezagados)) {
      if (v && typeof v === 'object') stripeSaldosRezagados.set(String(k), v);
    }
  }
  if (Array.isArray(s.stripeCargosPerdidos)) {
    stripeCargosPerdidos = s.stripeCargosPerdidos.slice(-CARGOS_PERDIDOS_MAX);
  }
  const fill = (map, obj) => { if (obj) for (const [k, v] of Object.entries(obj)) map.set(k, v); };
  fill(clientProfiles, s.clientProfiles);
  fill(manualClients, s.manualClients);
  fill(scheduledBroadcasts, s.scheduledBroadcasts);
  // Limpieza anti-bucle: avisos de "una sola vez" que quedaron activos y vencidos
  // (por el bug anterior) se marcan completados para que NO se reenvíen al arrancar.
  for (const [id, bc] of scheduledBroadcasts) {
    if (bc.status === 'active' && !bc.intervalMs && bc.nextSendAt && new Date(bc.nextSendAt) < new Date()) {
      bc.status = 'completed';
      scheduledBroadcasts.set(id, bc);
    }
  }
  fill(folios, s.folios);
  fill(tickets, s.tickets);
  if (Array.isArray(s.promoBanners)) promoBanners = s.promoBanners;
  else if (s.promoBanner && s.promoBanner.text) promoBanners = [{ id: 'pb-legacy', text: s.promoBanner.text, link: s.promoBanner.link || '', active: !!s.promoBanner.active, createdAt: new Date().toISOString() }];
  fill(agentActiveCases, s.agentActiveCases);
  fill(adminUsers, s.adminUsers);
  // Productos: si la base ya tiene una lista guardada, reemplaza la semilla.
  if (Array.isArray(s.products) && s.products.length) {
    products.length = 0;
    products.push(...s.products.map(p => ({ showWeb: true, showBot: true, active: true, ...p })));
  }
  // Planes: si la base ya tiene una lista guardada, reemplaza la semilla.
  if (Array.isArray(s.plans) && s.plans.length) {
    plans.length = 0;
    plans.push(...s.plans.map((p, i) => ({ active: true, order: i, period: '/mes', ...p })));
  }
  if (s.stats && typeof s.stats === 'object') {
    stats.productHits = s.stats.productHits || {};
    stats.daily = s.stats.daily || {};
  }
  if (Array.isArray(s.broadcastHistory)) { broadcastHistory.length = 0; broadcastHistory.push(...s.broadcastHistory); }
  if (s.pausedChats) for (const [k, v] of Object.entries(s.pausedChats)) pausedChats.set(k, { pausedUntil: new Date(v.pausedUntil) });
  if (s.pendingAgentRequests) for (const [k, v] of Object.entries(s.pendingAgentRequests)) pendingAgentRequests.set(k, { ...v, since: new Date(v.since) });
  if (Array.isArray(s.caseLog)) caseLog = s.caseLog.slice(0, CASE_LOG_MAX);
  if (typeof s.lastDigestDate === 'string') lastDigestDate = s.lastDigestDate;
  if (s.agentLastInbound && typeof s.agentLastInbound === 'object') agentLastInbound = new Map(Object.entries(s.agentLastInbound));
  if (s.agentPingSent && typeof s.agentPingSent === 'object') agentPingSent = new Map(Object.entries(s.agentPingSent));
  if (s.corteReminders && typeof s.corteReminders === 'object') corteReminders = s.corteReminders;
  if (s.prorrogas && typeof s.prorrogas === 'object') prorrogas = s.prorrogas;
  if (s.autoCobros && typeof s.autoCobros === 'object') autoCobros = s.autoCobros;
  if (s.sesionesDePago && typeof s.sesionesDePago === 'object') {
    const limite = Date.now() - 30 * 60 * 1000;   // misma vigencia que la sesión de pago
    for (const [k, v] of Object.entries(s.sesionesDePago)) {
      if (v && v.data && Number(v.data.desde) > limite) sessions.set(String(k), v);
    }
  }
  if (typeof s.lastCorteRunDate === 'string') lastCorteRunDate = s.lastCorteRunDate;
  if (Array.isArray(s.corteRunLog)) corteRunLog = s.corteRunLog.filter(r => r && r.fecha).slice(0, CORTE_RUN_LOG_MAX);
  if (Array.isArray(s.corteTemplates)) corteTemplates = s.corteTemplates;
  if (typeof s.corteActiveId === 'string') corteActiveId = s.corteActiveId;
  if (Array.isArray(s.welcomedClients)) welcomedClients = new Set(s.welcomedClients.map(String));
  if (typeof s.welcomeSeeded === 'boolean') welcomeSeeded = s.welcomeSeeded;
  if (s.incident && typeof s.incident === 'object') {
    incident = { active: !!s.incident.active, zona: String(s.incident.zona || ''), since: s.incident.since || null, testNumber: String(s.incident.testNumber || '') };
  }
  // Seguridad: si la activa apunta a una plantilla que ya no existe, vuelve a la predeterminada.
  if (corteActiveId !== 'default' && !corteTemplates.some(t => t.id === corteActiveId)) corteActiveId = 'default';
  console.log(`[persistence] Estado restaurado — perfiles:${clientProfiles.size} clientes:${manualClients.size} avisos:${scheduledBroadcasts.size} folios:${folios.size}`);
}

// Guardado con "debounce": agrupa varios cambios seguidos en una sola escritura.
let _persistTimer = null;
function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistence.save(buildStateSnapshot()).catch(e => console.error('[persistence] save:', e.message));
  }, 1500);
}

// Chat history store - maintains conversation memory per chat
// Structure: chatHistory[chatId] = { createdAt, updatedAt, messages: [{role, text, timestamp}] }
// Ready for persistence: Can be easily migrated to MongoDB/PostgreSQL for WhatsApp integration
const chatHistory = new Map();

// --- Historial por cliente (persistencia SEPARADA, bajo demanda) ------------
// _convDirty = chats con mensajes nuevos pendientes de volcar al almacén aparte.
// Marcar/volcar NO toca el estado principal → cero impacto en el guardado normal.
// Todo es defensivo: si el historial falla, el bot sigue funcionando igual.
const _convDirty = new Set();
const CONV_MAX_CHATS = 2500;   // tope de chats en memoria (blindaje anti-fuga)
let _convFlushing = false;

function getHistory(chatId) {
  const id = String(chatId);
  if (!chatHistory.has(id)) {
    chatHistory.set(id, {
      chatId: id,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: []
    });
  }
  return chatHistory.get(id);
}

function addMessageToHistory(chatId, role, text) {
  const id = String(chatId);
  const history = getHistory(id);
  history.messages.push({
    role: role, // 'user' or 'bot'
    text: text,
    timestamp: new Date()
  });
  history.updatedAt = new Date();
  // Keep last 100 messages per chat to manage memory
  if (history.messages.length > 100) {
    history.messages = history.messages.slice(-100);
  }
  _convDirty.add(id); // marcar para volcar al almacén de historial (barato: 1 Set.add)
}

function clearHistory(chatId) {
  chatHistory.delete(String(chatId));
}

function getFullChatContext(chatId) {
  const history = getHistory(chatId);
  return {
    chatId: String(chatId),
    createdAt: history.createdAt,
    updatedAt: history.updatedAt,
    messageCount: history.messages.length,
    recentMessages: history.messages.slice(-10), // Last 10 messages
    fullHistory: history.messages // Full history if needed
  };
}

// Vuelca a un almacén SEPARADO los chats con mensajes nuevos (solo los "dirty").
// Corre en un intervalo aparte; nunca lanza (todo envuelto). Si un guardado
// falla, ese chat se re-marca para el siguiente intento.
async function flushConversations() {
  if (_convFlushing) return;         // evita solapes si un volcado tardó
  _convFlushing = true;
  try {
    const ids = [..._convDirty];
    _convDirty.clear();
    for (const id of ids) {
      try {
        const h = chatHistory.get(id);
        if (!h || !h.messages || !h.messages.length) continue;
        const ok = await persistence.saveConversation(id, {
          chatId: id, createdAt: h.createdAt, updatedAt: h.updatedAt, messages: h.messages
        });
        if (!ok) _convDirty.add(id); // reintenta en la próxima pasada
      } catch (_) { _convDirty.add(id); }
    }
    // Blindaje de memoria: si hay demasiados chats, saca de RAM los menos recientes
    // (ya quedaron guardados; se recargan bajo demanda si alguien los abre).
    if (chatHistory.size > CONV_MAX_CHATS) {
      const entries = [...chatHistory.entries()]
        .sort((a, b) => new Date(a[1].updatedAt || 0) - new Date(b[1].updatedAt || 0));
      const sobran = chatHistory.size - CONV_MAX_CHATS;
      for (let i = 0; i < sobran; i++) {
        if (!_convDirty.has(entries[i][0])) chatHistory.delete(entries[i][0]);
      }
    }
  } catch (e) {
    console.error('[historial] flush error:', e.message);
  } finally {
    _convFlushing = false;
  }
}

// Planes que usa el BOT para cotizar. Los PRECIOS se mantienen en sync con los
// planes editables del panel vía syncHardcodedPlanPrices() → una sola fuente de
// precios (se editan en el panel y el bot los sigue). Por eso son `let`.
let FIBER_PLANS = [
  { name: 'Lite', speed: '30 Mbps', price: '$289/mes' },
  { name: 'Basic', speed: '80 Mbps', price: '$320/mes' },
  { name: 'Medium', speed: '150 Mbps', price: '$440/mes' },
  { name: 'Advanced', speed: '200 Mbps', price: '$560/mes' },
  { name: 'Ultra', speed: '300 Mbps', price: '$680/mes' }
];

let WIRELESS_PLANS = [
  { name: '15 Mbps', speed: '15 Mbps', price: '$290/mes' },
  { name: '20 Mbps', speed: '20 Mbps', price: '$340/mes' },
  { name: '30 Mbps', speed: '30 Mbps', price: '$440/mes' }
];

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Generate unique random folio for appointments (format: LT-XXXXX-XXXXX)
function generateRandomFolio() {
  const timestamp = Date.now().toString().slice(-5); // Last 5 digits of timestamp
  const random = Math.random().toString(36).substring(2, 7).toUpperCase(); // Random alphanumeric
  return `LT-${timestamp}-${random}`;
}

function isPlanRequest(text) {
  const value = normalizeText(text);
  return /\b(plan|paquete|planes|precio|precios|tarifa|tarifas|costo|costos|promocion|contratar|fibra|inalambrico)\b/.test(value);
}

function isOtherPlansQuestion(text) {
  const value = normalizeText(text);
  return /\b(otros planes|otras opciones|alternativas|cual es la diferencia|que diferencia hay|que diferencia|compara|comparar|como se compara|cual es mejor|mas rapido|mas barato|faster|cheaper)\b/.test(value);
}

function areaDifferentFromContext(queryText, currentLocation) {
  const detectedLocation = detectLocation(queryText);
  return detectedLocation && detectedLocation !== currentLocation;
}

function isCoverageRequest(text) {
  const value = normalizeText(text);
  return /\b(cobertura|cubre|disponible en|tienen servicio|llega a|zona|colonia|fraccionamiento)\b/.test(value);
}

function isTechnicalIssue(text) {
  const value = normalizeText(text);
  // Requires explicit problem signal — NOT just mention of "internet"
  return /\b(falla|sin servicio|no funciona|intermitente|reiniciar|caido|caida|sin internet|no jala|no agarra|se cae|se corta|no carga|no hay internet|se fue el internet|no tengo internet|se corto el internet|lentisim[oa]|lentit[oa]|muy lent[oa]|va lent[oa]|esta lent[oa]|anda lent[oa]|internet lent[oa]|wifi lent[oa]|super lent[oa]|sigue lent[oa]|esta fallando|no sirve|no me sirve|no funca|sin senal|sin señal)\b/.test(value);
}

// ¿A qué "flujo" pertenece el estado actual de la conversación?
function currentFlow(state) {
  if (!state) return 'none';
  if (state.includes('camera')) return 'camera';
  if (state.includes('migration')) return 'migration';
  if (state.includes('report') || state.includes('neighborhood') || state.includes('emergency')) return 'support';
  if (state.includes('agent')) return 'agent';
  if (state.includes('location') || state.includes('plan') || state.includes('contract') || state.includes('household')) return 'plan';
  return 'other';
}

// Detecta si el cliente está pidiendo OTRO tema (por palabra clave, NO por números
// sueltos, para no confundir respuestas como "somos 3" con la opción 3 del menú).
function detectNewIntent(text) {
  const v = normalizeText(text);
  if (isMigrationRequest(text)) return 'migration';
  if (isCameraRequest(text)) return 'camera';
  if (/\b(asesor|agente|ejecutivo|humano|una persona|con alguien|con un humano)\b/.test(v) || /hablar con/.test(v)) return 'agent';
  if (isReportRequest(text) || isTechnicalIssue(text)) return 'support';
  if (isProductRequest(text)) return 'products';
  // "plan" solo con palabras específicas de internet (NO "costo/precio" sueltos,
  // que también aplican a cámaras y harían cambiar de tema por error).
  if (/\b(plan|planes|paquete|paquetes|tarifa|tarifas|fibra|inalambric|megas|mbps)\b/.test(v) ||
      /\b(contratar|quiero internet|instalar internet|quiero el servicio|quiero contratar)\b/.test(v)) return 'plan';
  return null;
}

// Emergencia / falla de infraestructura: debe pasar a un técnico DE INMEDIATO.
// Cubre cosas como "se está quemando", chispas, humo, poste/cable caído, corto, etc.
function isEmergency(text) {
  const v = normalizeText(text);
  // Fuego / eléctrico
  const fuego = /(se esta quemando|esta quemando|quemandose|se quema|se quemo|quemando|incendi|hay fuego|en llamas|llamarada|chispa|chisporrot|huele a quemad|olor a quemad|sale humo|hay humo|hace corto|hizo corto|corto circuito|cortocircuito|exploto|explosion|explot|revento|reventando|transformador)/.test(v);
  // Daño físico a cable/poste (en cualquier orden de palabras)
  const infra = /(cable|cables|cableado|poste|postes)/.test(v) && /(ca[ií]d|cayo|cayendo|tirad|roto|rota|colgan|suelt|revent|chispe|quema)/.test(v);
  return fuego || infra;
}

function isAgentRequest(text) {
  const value = normalizeText(text);
  return /\b(agente|asesor|ejecutivo|humano|persona|llamar|contactar|ventas|atencion|atención)\b/.test(value);
}

function wantsToCancel(text) {
  const v = normalizeText(text);
  // Don't cancel if the message actually contains a real question or content
  const hasQuestion = /\?|cuantos|cuanto|como |que |cual|donde|cuando|dispositiv|aparato|velocid|precio|plan|mbps|puede|incluye|funciona|instala|cubre|diferencia/.test(v);
  if (hasQuestion) return false;
  return /\b(no quiero|no mejor|cancelar|cancel|volver|atras|menu|no eso no|no gracias|equivoque|me equivoque|no es eso|otra cosa|nada|salir|regresar)\b/.test(v);
}

function isCameraRequest(text) {
  const value = normalizeText(text);
  return /\b(camara|camaras|videovigilancia|cctv|tapo|hikvision|nvr|dvr|vigilar|vigilancia|seguridad|grabadora)\b/.test(value);
}

function isMigrationRequest(text) {
  const value = normalizeText(text);
  return /\b(migrar|migracion|migraci|cambiar domicilio|cambio de domicilio|mover servicio|cambiar de casa|otro domicilio|nueva casa|nuevo domicilio)\b/.test(value);
}

function isReportRequest(text) {
  const value = normalizeText(text);
  return /\b(reportar|reporte|reporto|report|denunciar|problema|reportar problema)\b/.test(value);
}

// Detector AMPLIO de reporte de caída — para el Modo Incidencia. Cubre lo que la
// gente escribe de verdad: internet/wifi/señal/red/conexión con "no hay/no tengo/no
// sirve/lento/se cayó". No toca isTechnicalIssue (que usan otros flujos).
function isOutageReport(text) {
  const v = normalizeText(text);
  if (isTechnicalIssue(v) || isReportRequest(v)) return true;
  const problema = /\b(no (tengo|hay|me da|sirve|funciona|jala|agarra|carga|conecta|prende)|sin|se (fue|cayo|corto|va)|fallo|falla|fallando|caid[oa]|lent[oa]|malo|mala|intermitente)\b/;
  const conexion = /\b(wifi|wi-?fi|internet|inter|señal|senal|red|conexion|conexión|servicio|el net|la red|linea|línea)\b/;
  return problema.test(v) && conexion.test(v);
}

function isInstallationRequest(text) {
  const value = normalizeText(text);
  return /\b(instal|instalar|instalacion|instalación|agendar|cita|programar|agenda)\b/.test(value);
}

function sanitizeAIReply(reply) {
  if (!reply || typeof reply !== 'string') return '';
  // Split into sentences and remove obvious greetings/intro sentences
  const parts = reply.trim().split(/(?<=[.!?])\s+/);
  const filtered = parts.filter((s) => !/^(\s*¡?hola\b|\s*me alegra\b|\s*encantad[oa]\b|\s*gracias\b|\s*estoy feliz\b)/i.test(s));
  const result = (filtered.length ? filtered : parts).slice(0, 2).join(' ').trim();
  return result || reply.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
}

function detectLocation(text) {
  const value = normalizeText(text);

  if (/\bhuitzo\b/.test(value)) {
    return LOCATIONS.huitzo;
  }

  if (/\btelixtlahuaca\b|\btelix\b/.test(value)) {
    return LOCATIONS.telixtlahuaca;
  }

  // Suchilquitongo y sus variantes comunes
  if (/\bsuchilquitongo\b|\bsuchilqui\b|\bsuchil\b|\bsantiago suchil\b/.test(value)) {
    return LOCATIONS.suchilquitongo;
  }

  return '';
}

function parseDayToDate(dayText) {
  const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  
  const value = normalizeText(dayText).toLowerCase().trim();
  const now = new Date();
  let targetDate = null;

  // Check for relative dates
  if (/\bmanana\b|\bmañana\b|\bmaana\b/.test(value)) {
    targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (/\bhoy\b|\bahorita\b|\bahorita/.test(value)) {
    targetDate = new Date(now);
  } else if (/\bpasado manana\b|\bpasado mañana\b|\bpasado maana\b/.test(value)) {
    targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + 2);
  } else {
    // Try to parse specific date patterns like "25", "25 de mayo", etc.
    const numberMatch = value.match(/(\d{1,2})/);
    if (numberMatch) {
      const day = parseInt(numberMatch[1], 10);
      targetDate = new Date(now.getFullYear(), now.getMonth(), day);
      // If the date is in the past, assume next month
      if (targetDate < now) {
        targetDate.setMonth(targetDate.getMonth() + 1);
      }
    }
  }

  if (!targetDate) {
    // If we can't parse, return the text as-is
    return dayText;
  }

  // Format as "Lunes 25 de Mayo del 2026"
  const dayName = dayNames[targetDate.getDay()];
  const monthName = monthNames[targetDate.getMonth()];
  const day = targetDate.getDate();
  const year = targetDate.getFullYear();
  
  // Capitalize first letter
  const formattedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
  const formattedMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  
  return `${formattedDay} ${day} de ${formattedMonth} del ${year}`;
}

function findNeighborhood(text, location) {
  if (!location || !NEIGHBORHOODS[location.toLowerCase()]) return null;
  const value = normalizeText(text).toLowerCase().trim();
  const neighborhoods = NEIGHBORHOODS[location.toLowerCase()];
  const match = neighborhoods.find(n => normalizeText(n).includes(value) || value.includes(normalizeText(n).split(' ')[0]));
  return match ? { name: match, location } : null;
}

// Search neighborhoods across ALL zones — returns best match {name, zone} or null
function searchAllNeighborhoods(text) {
  const value = normalizeText(text);
  for (const [zoneKey, neighborhoods] of Object.entries(NEIGHBORHOODS)) {
    for (const n of neighborhoods) {
      const normalN = normalizeText(n);
      const nWords = normalN.split(' ').filter(w => w.length > 3);
      if (nWords.some(w => value.includes(w)) || normalN.includes(value)) {
        return { name: n, zone: LOCATIONS[zoneKey] || zoneKey };
      }
    }
  }
  return null;
}

function isGreetingMessage(text) {
  const value = normalizeText(text).trim();
  // Only match PURE greetings — "hola" alone, not "hola tengo un problema"
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal)\s*[,!.👋🙏]*\s*$/.test(value);
}

function isPlanListRequest(text) {
  const value = normalizeText(text);
  return /\b(todos los planes|planes|paquetes|precios|tarifas|internet|wifi|wifis|servicio)\b/.test(value);
}

function parseHouseholdSize(text) {
  const value = normalizeText(text);
  const numericMatch = value.match(/\b(\d{1,2})\b/);
  if (numericMatch) {
    const parsed = Number(numericMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const wordMap = {
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    once: 11,
    doce: 12,
    trece: 13,
    catorce: 14,
    quince: 15
  };

  for (const [word, count] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${word}\\b`).test(value)) {
      return count;
    }
  }

  return null;
}

function chooseRecommendedFiberPlan(householdSize) {
  if (householdSize >= 9) return FIBER_PLANS.find((plan) => plan.name === 'Ultra') || FIBER_PLANS[FIBER_PLANS.length - 1];
  if (householdSize >= 6) return FIBER_PLANS.find((plan) => plan.name === 'Advanced') || FIBER_PLANS[FIBER_PLANS.length - 2];
  if (householdSize >= 4) return FIBER_PLANS.find((plan) => plan.name === 'Medium') || FIBER_PLANS[2];
  if (householdSize >= 2) return FIBER_PLANS.find((plan) => plan.name === 'Basic') || FIBER_PLANS[1];
  return FIBER_PLANS.find((plan) => plan.name === 'Lite') || FIBER_PLANS[0];
}

function chooseRecommendedWirelessPlan(householdSize) {
  if (householdSize >= 8) return WIRELESS_PLANS[2];
  if (householdSize >= 4) return WIRELESS_PLANS[1];
  return WIRELESS_PLANS[0];
}

function buildPlanLines(plans) {
  return plans.map((plan) => `- ${plan.name}: ${plan.speed} → ${plan.price}`).join('\n');
}

function buildLocationPrompt() {
  return {
    text: '¿En cuál zona vives? Te muestro planes con fibra óptica o inalámbrico según lo que llegue a tu área.',
    mediaUrls: [],
    buttons: [
      { id: 'huitzo', title: 'Huitzo' },
      { id: 'telixtlahuaca', title: 'Telixtlahuaca' },
      { id: 'suchilquitongo', title: 'Suchilquitongo' }
    ],
    replyMarkup: {
      keyboard: [[{ text: 'Huitzo' }, { text: 'Telixtlahuaca' }, { text: 'Suchilquitongo' }]],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

function buildPlanReplyForLocation(location) {
  if (location === LOCATIONS.huitzo) {
    return {
      text: [
        '🔥 Planes de fibra óptica para Huitzo:',
        buildPlanLines(FIBER_PLANS),
        '',
        '💰 Instalación: ' + costoInstalacion() + ' | Primer mes gratis' + notaPromoInstalacion(),
        '¿Te interesa alguno? Dime cuál y te conectamos con un asesor.'
      ].join('\n'),
      mediaUrls: FIBER_PLAN_MEDIA_URL ? [FIBER_PLAN_MEDIA_URL] : []
    };
  }

  if (location === LOCATIONS.telixtlahuaca || location === LOCATIONS.suchilquitongo) {
    return {
      text: [
        `📡 Planes de internet inalámbrico para ${location}:`,
        buildPlanLines(WIRELESS_PLANS),
        '',
        location === LOCATIONS.telixtlahuaca
          ? '💰 Instalación: Centro de Telixtlahuaca ' + costoInstalacion() + notaPromoInstalacion() + ' · Agencias de los alrededores $1,200'
          : '💰 Instalación: a cotizar con técnico',
        '¿Te interesa alguno? Dime cuál y te conectamos con un asesor.'
      ].join('\n'),
      mediaUrls: WIRELESS_PLAN_MEDIA_URL ? [WIRELESS_PLAN_MEDIA_URL] : []
    };
  }

  return buildLocationPrompt();
}

function buildRecommendationPrompt() {
  return {
    text: [
      'Cualquier duda sobre el plan, me la cuentas.',
      'O podemos agendar tu instalación ahora mismo. ¿Qué dices?'
    ].join(' '),
    mediaUrls: []
  };
}

function buildAgentReply() {
  return {
    text: [
      'Perfecto, voy a conectarte con un agente ahora.',
      'Tu contacto: 📞 951 169 7346. Alguien te atiende en poco tiempo.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildReportPrompt() {
  return {
    text: '¿Qué está pasando con tu internet?',
    mediaUrls: [],
    buttons: [
      { id: 'sin_internet', title: 'Sin internet' },
      { id: 'internet_lento', title: 'Muy lento' },
      { id: 'va_y_viene', title: 'Va y viene' }
    ]
  };
}

function buildPlanReply(text) {
  const location = detectLocation(text);
  const value = normalizeText(text);

  if (location) {
    return buildPlanReplyForLocation(location);
  }

  return buildLocationPrompt();
}

function buildCoverageReply(text) {
  const location = detectLocation(text);

  if (location) {
    return buildPlanReplyForLocation(location);
  }

  return {
    text: [
      '📍 Dime tu zona: Huitzo (fibra 🔥), Telixtlahuaca, o Suchilquitongo.',
      'Y te muestro qué planes llegan a ti.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildTechnicalReply(text) {
  return {
    text: [
      '⚡ Vamos paso a paso:',
      '1) Reinicia tu router 2 minutos 2) Si sigue igual, me dices: sin internet, lento o intermitente 3) Listo, te damos solución.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildAllPlansForLocation(location) {
  const plans = location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
  const planList = plans.map(p => `• ${p.name}: ${p.speed} - ${p.price}`).join('\n');
  
  return {
    text: [
      `📋 Todos nuestros planes en ${location}:`,
      planList,
      '¿Cuál te llama la atención? Cuéntame para darte más detalles.'
    ].join('\n'),
    mediaUrls: []
  };
}

async function callAI(systemContent, userContent, options = {}) {
  if (!AI_API_KEY) return null;
  const temperature = options.temperature || 0.4;
  // Timeout: si la IA tarda demasiado, abortamos para no dejar al cliente sin respuesta.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    if (AI_PROVIDER === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: AI_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: options.maxTokens || 512,
          system: systemContent,
          // Los turnos previos van como mensajes REALES, no como texto dentro del
          // prompt: un modelo entiende muchísimo mejor una conversación de ida y
          // vuelta que un bloque de "Cliente: ... Leo: ...".
          messages: [...(Array.isArray(options.history) ? options.history : []), { role: 'user', content: userContent }],
          temperature
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Anthropic API failed (${response.status}): ${await response.text()}`);
      const payload = await response.json();
      return payload.content?.[0]?.text || null;
    }

    // OpenAI-compatible (Groq, etc.)
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemContent },
          ...(Array.isArray(options.history) ? options.history : []),   // turnos reales
          { role: 'user', content: userContent }
        ],
        max_tokens: options.maxTokens || 512,   // antes se ignoraba en esta rama
        temperature
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`AI request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content || null;
  } finally {
    clearTimeout(timer);
  }
}

function agentNotifiedMsg(notified, name, type = 'asesor') {
  const who = (name && name !== 'Usuario' && looksLikeName(name)) ? `${name}, ` : '';
  if (isWithinBusinessHours()) {
    return `Listo, ${who}registré tu solicitud. Un ${type} de León Telecom te contactará en breve. 📱`;
  }
  return [
    `Gracias, ${who}registré tu solicitud. ✅`,
    `🕒 En este momento estamos fuera de horario de atención, pero un ${type} te contactará ${describeNextOpening()}.`,
    `Horario de atención: ${BUSINESS_HOURS_SUMMARY}.`
  ].join('\n');
}

// ==================== AI BRAIN ====================
// Main intelligence: Claude with full conversation history decides what to do.
// Returns { message, action, location }
async function callMainAI(chatId, userText) {
  if (!AI_API_KEY) return null;

  const profile = getProfile(chatId);
  const history = getHistory(chatId);
  // El mensaje actual del usuario ya se guardó en el historial (handleChatMessage lo
  // añade antes de llamar aquí). Lo quitamos del arreglo de turnos previos para no
  // mandarlo dos veces: va aparte como userContent en callAI.
  const prevTurns = history.messages.slice(-12);
  if (prevTurns.length && prevTurns[prevTurns.length - 1].role === 'user' &&
      prevTurns[prevTurns.length - 1].text === userText) prevTurns.pop();
  const turnos = prevTurns.slice(-8).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.text || '').slice(0, 800),
  }));


  const clientName = nameOf(profile);
  const clientLocation = profile?.location || null;

  const fiberPlans = FIBER_PLANS.map(p => `${p.name} ${p.speed}/${p.price}`).join(', ');
  const wirelessPlans = WIRELESS_PLANS.map(p => `${p.speed}/${p.price}`).join(', ');

  const systemPrompt = [
    'Eres Leo, asistente virtual de León Telecom (ISP en Oaxaca, México).',
    'Tono: profesional y amable, como un buen agente de atención al cliente. Sin slang ni expresiones informales. Máximo 2-3 oraciones. Sin markdown.',
    '',
    'SERVICIOS DE INTERNET (las 3 zonas SÍ tienen cobertura):',
    `Huitzo — fibra óptica en: Primera/Segunda/Tercera Sección, La Guadalupe, La Cantera, Cañada del Chisme, Ojo de Agua, Esmeralda, Privada del Laurel, El Llano, Gasolinera, Loma los Pinos, Agua Blanca, Santa María Tenéxpam. Instalación: ${costoInstalacion()}, primer mes gratis${promoAgostoActiva() ? ' (PROMOCIÓN DE AGOSTO: precio normal $800; menciónala con entusiasmo)' : ''}. Resto de Huitzo: antena inalámbrica. Planes fibra: ${fiberPlans}`,
    `Telixtlahuaca (inalámbrico/antena): instalación ${costoInstalacion()}${promoAgostoActiva() ? ' (PROMO DE AGOSTO, normal $800)' : ''} en el CENTRO/cabecera (${TELIXTLAHUACA_CENTRO_ZONES.join(', ')}); $1,200 en las AGENCIAS/alrededores (${TELIXTLAHUACA_AGENCIAS.join(', ')}). Si el cliente no especifica colonia, pregunta si es en el centro o en una agencia antes de dar el costo. Planes: ${wirelessPlans}`,
    `Suchilquitongo —también llamado "Suchil"— (inalámbrico/antena): instalación a cotizar con técnico. Planes: ${wirelessPlans}`,
    'IMPORTANTE: León Telecom NO ofrece telefonía, TV ni cable. Sus servicios son: INTERNET, CÁMARAS de seguridad y venta de ACCESORIOS/PRODUCTOS en la oficina.',
    'Las 3 zonas SÍ tienen cobertura. Nunca digas que no hay servicio.',
    '',
    'CÁMARAS DE SEGURIDAD:',
    'Wi-Fi Tapo TP-Link (1-3 cámaras, instalación simple):',
    '- C210: Interior, 2K, 360°, audio bidireccional. Ideal: salas, recámaras, mascotas.',
    '- C320WS: Exterior fija, 2K QHD, visión nocturna a color, alarma luz/sonido. Ideal: fachadas, entradas.',
    '- C500: Exterior, 1080p, 360°+seguimiento automático, IP65. Ideal: patios grandes, estacionamientos.',
    '- C520WS: Exterior premium, 2K QHD, 360°+seguimiento, nocturna a color. Máxima calidad exterior.',
    'Todas graban en tarjeta MicroSD o nube Tapo Care.',
    'Sistemas Hikvision (4+ cámaras o proyectos comerciales/industriales):',
    '- Analógico DVR: económico, cables directos. IP/NVR (PoE): máxima calidad, analíticas avanzadas.',
    '- Ventaja: video guardado en grabador oculto, monitoreo centralizado de 4-16+ cámaras.',
    '- Para Hikvision se agenda visita técnica gratuita para cotización a medida.',
    'Preguntas clave para recomendar: 1)¿interior o exterior? 2)¿cuántas cámaras? 3)¿hay buena señal Wi-Fi ahí?',
    '',
    'ACCESORIOS Y PRODUCTOS (se venden en la oficina): Roku, cables HDMI/USB-C/Lightning, adaptadores USB, memorias USB, TINTA HP para impresora, mouse, base enfriadora, soporte de TV, reflectores solares, tiras LED, luminarios.',
    'REGLA: si preguntan por un accesorio/producto (tinta, cable, roku, memoria, etc.), NUNCA digas que no lo tenemos; invítalos a escribir "productos" para ver el catálogo con fotos y precios.',
    '',
    'DATOS DE CONTACTO Y OFICINA (los ÚNICOS verdaderos; jamás inventes otros):',
    `Teléfono y WhatsApp de contacto: ${LEON_CONTACT_NUMBER}. Es el ÚNICO número. Si piden "el número", "el teléfono" o "el número de la oficina", da EXACTAMENTE este; nunca inventes ni cambies un dígito.`,
    `Dirección de la oficina: ${OFFICE_ADDRESS}. Es la única dirección; si la piden, dala tal cual, nunca inventes otra calle ni referencia.`,
    `Horario de atención: ${BUSINESS_HOURS_SUMMARY}.`,
    'Zonas con cobertura: SOLO Huitzo, Telixtlahuaca y Suchilquitongo.',
    '',
    'REGLA DE ORO — NO INVENTES DATOS: solo puedes dar información que aparezca en ESTE prompt (teléfono, dirección, horario, zonas, planes, precios, cámaras, productos). Está PROHIBIDO inventar teléfonos, direcciones, precios o promociones. Si te piden un dato que NO está aquí, di que un asesor lo confirma o da el teléfono oficial; NUNCA lo adivines.',
    `El único teléfono que puedes dar es ${LEON_CONTACT_NUMBER}; si escribes cualquier otro número, es un error grave.`,
    'MENSAJES CORTOS O AMBIGUOS: si el mensaje es breve o poco claro ("es de un hotel", "pero ese num", "y eso", "sí"), apóyate en los mensajes previos para entender a qué se refiere. NO cambies de tema ni ofrezcas planes o zonas que nadie pidió; si aún no queda claro, haz UNA sola pregunta corta para aclarar.',
    '',
    clientName ? `Nombre del cliente: ${clientName}` : '',
    clientLocation ? `Zona del cliente: ${clientLocation}` : '',
    '',
    turnos.length ? 'La conversación previa va como mensajes reales; toma en cuenta el hilo completo, no solo el último mensaje.' : '(Es la primera interacción con este cliente.)',
    '',
    'EJEMPLOS DE CÓMO RESPONDER (imita el estilo; usa SIEMPRE este formato JSON, sin markdown):',
    `Cliente: "pero ese num es whatsapp?" -> {"message":"Sí, el ${LEON_CONTACT_NUMBER} es nuestro número de contacto y también WhatsApp. ¿Te ayudo con algo más?","action":null,"location":null,"neighborhood":null,"urgent":false}`,
    'Cliente: "es de un hotel" -> {"message":"Perfecto, para un hotel podemos ayudarte con internet o con cámaras de seguridad. ¿Qué necesitas: internet, cámaras, o ambos?","action":null,"location":null,"neighborhood":null,"urgent":false}',
    'Cliente: "tienen paquetes de TV por cable?" -> {"message":"Nos enfocamos en internet (fibra y antena), cámaras de seguridad y venta de accesorios; no manejamos TV ni cable. ¿Te interesa alguno de esos?","action":null,"location":null,"neighborhood":null,"urgent":false}',
    'Cliente: "venden tinta para impresora?" -> {"message":"Sí, manejamos tinta HP y varios accesorios en la oficina. Escribe la palabra productos y te muestro el catálogo con fotos y precios.","action":null,"location":null,"neighborhood":null,"urgent":false}',
    'Cliente: "quiero poner cámaras en mi negocio" -> {"message":"Con gusto te ayudo con las cámaras de seguridad.","action":"show_cameras","location":null,"neighborhood":null,"urgent":false}',
    'Cliente: "y si somos muchos en la casa" -> {"message":"Nuestros planes rinden bien para varios equipos a la vez. ¿Cuántas personas o dispositivos serían, para recomendarte el plan ideal?","action":null,"location":null,"neighborhood":null,"urgent":false}',
    '',
    'INSTRUCCIONES DE RESPUESTA:',
    'LEE BIEN el mensaje completo y responde de forma natural y útil (no como robot). Responde con JSON puro (sin texto extra):',
    '{"message":"respuesta natural aquí","action":null,"location":null,"neighborhood":null,"urgent":false}',
    '',
    'Valores de "action":',
    '"show_plans" → quiere ver planes/precios de internet, contratar, preguntar por instalación o costos',
    '"show_support" → falla ACTIVA o problema de INFRAESTRUCTURA: sin internet, lento, se cae, no funciona, equipo/módem/antena dañado, un cable o poste caído, algo que se quema, huele a quemado, chispas, humo, corto. NO para preguntas generales sobre planes, velocidad o dispositivos.',
    '"show_cameras" → pregunta por cámaras, videovigilancia, CCTV, seguridad',
    '"show_migration" → quiere MIGRAR o MOVER su servicio a otro domicilio o zona. Palabras clave: migrar, cambiar domicilio, mover servicio, nueva casa, otro domicilio. Mensaje: confirmar que se iniciará el proceso.',
    '"request_agent" → SOLO cuando el cliente pide EXPLÍCITAMENTE hablar con un humano/asesor/persona. Ejemplos: "quiero hablar con alguien", "me comunicas con un asesor", "necesito hablar con una persona".',
    'null → preguntas de información, dudas sobre planes, velocidades, dispositivos, precios, comparaciones. Responde directo.',
    '',
    'REGLA CRÍTICA: NUNCA derives un problema de infraestructura (cable, poste, antena, equipo, algo que se quema/echa humo/chispas) a las autoridades, al 911 ni al municipio como si no fuera de León Telecom. León Telecom tiene postes, cables, antenas y equipo en campo: ESOS reportes SIEMPRE son "show_support" y se pasan a un técnico. Si hay riesgo de incendio, además sugiere llamar al 911, pero igual escala con el técnico.',
    'Pon "urgent": true cuando haya riesgo o daño físico: algo se quema, humo, chispas, fuego, poste o cable caído, corto, transformador. En esos casos NO pidas datos de más: usa la ubicación que ya dio el cliente.',
    'NUNCA uses request_agent para: preguntas sobre cuántos dispositivos, velocidad, precio, diferencias entre planes, "oigan", "disculpen", etc.',
    'IMPORTANTE: "quiero migrar/cambiar mi servicio/domicilio" → SIEMPRE show_migration, no show_plans',
    '',
    '"location" → SOLO la zona que el cliente mencione EN SU MENSAJE (Huitzo/Telixtlahuaca/Suchilquitongo), o null. NUNCA afirmes ni adivines en qué zona vive (no digas "estás en X, ¿verdad?"); si no la dijo, deja location en null.',
    '"neighborhood" → colonia/barrio/sección mencionada (incluye "la segunda"→Segunda Sección, etc.), o null'
  ].filter(Boolean).join('\n');

  try {
    const response = await callAI(systemPrompt, userText, { temperature: 0.45, maxTokens: 320, history: turnos });
    if (!response) return null;
    const match = response.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        message: String(parsed.message || '').replace(/[*_`#]/g, '').trim(),
        action: parsed.action || null,
        location: parsed.location || null,
        neighborhood: parsed.neighborhood || null,
        urgent: parsed.urgent === true,
        cameraContext: parsed.cameraContext || null
      };
    }
    return { message: response.replace(/[*_`#]/g, '').trim(), action: null, location: null };
  } catch (e) {
    console.error('[mainAI]', e.message);
    return null;
  }
}

async function generateNaturalPlanRecommendationReply(context) {
  const baseRecommendation = context.location === LOCATIONS.huitzo
    ? chooseRecommendedFiberPlan(context.householdSize)
    : chooseRecommendedWirelessPlan(context.householdSize);

  const whyItFits = context.householdSize >= 8 ? 'porque necesitan estabilidad para varios dispositivos' : context.householdSize >= 4 ? 'para que todos usen internet sin demoras' : 'para una conexión fluida y segura';
  const fallbackText = context.location === LOCATIONS.huitzo
    ? `Con ${context.householdSize} en casa, el ${baseRecommendation.name} (${baseRecommendation.speed}) es perfecto ${whyItFits}. Son ${baseRecommendation.price}. ¿Quieres que programe tu instalación?`
    : `Para ${context.householdSize} personas en ${context.location}, ${baseRecommendation.speed} es lo que necesitas ${whyItFits}. Cuesta ${baseRecommendation.price}. ¿Empezamos?`;

  if (!AI_API_KEY) {
    return {
      text: fallbackText,
      mediaUrls: []
    };
  }

  const allPlans = context.location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
  const plansSummary = allPlans.map(p => `${p.name}: ${p.speed} (${p.price})`).join('; ');

  try {
    const systemContent = [
      'Eres Leo, asesor de León Telecom.',
      `PLANES REALES EN ${context.location.toUpperCase()}: ${plansSummary}. SOLO menciona estos planes.`,
      'Máximo dos frases. PROHIBIDO inventar planes.',
      'Sé específico, cálido, directo.',
      'Termina con: "¿Instalamos?", "¿Dudas?", o "¿Te paso con asesor?"'
    ].join(' ');
    const userContent = [
      `Zona: ${context.location}, Personas: ${context.householdSize}`,
      `Plan recomendado: ${baseRecommendation.name} (${baseRecommendation.speed}/${baseRecommendation.price})`,
      'Explica brevemente por qué encaja. Invita a actuar.'
    ].join('\n');

    const reply = await callAI(systemContent, userContent, { temperature: 0.65 });
    if (reply) return { text: reply.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim(), mediaUrls: [] };
  } catch (error) {
    console.error('Natural plan recommendation AI error:', error.message);
  }

  return { text: fallbackText, mediaUrls: [] };
}

async function generateFollowupRecommendationReply(context, userText) {
  // Check if asking about plans from a DIFFERENT zone
  const queriedLocation = detectLocation(userText);
  if (queriedLocation && queriedLocation !== context.location) {
    return buildAllPlansForLocation(queriedLocation);
  }

  // If asking about other plans in current zone, show real list without AI
  if (isOtherPlansQuestion(userText)) {
    return buildAllPlansForLocation(context.location);
  }

  const baseRecommendation = context.location === LOCATIONS.huitzo
    ? chooseRecommendedFiberPlan(context.householdSize)
    : chooseRecommendedWirelessPlan(context.householdSize);

  const fallbackText = `El ${baseRecommendation.name || baseRecommendation.speed} es lo ideal para ${context.householdSize}. ¿Tienes dudas o te gustaría agendar con un asesor?`;

  if (!AI_API_KEY) {
    return {
      text: fallbackText,
      mediaUrls: []
    };
  }

  const allPlans = context.location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
  const plansSummary = allPlans.map(p => `${p.name}: ${p.speed} (${p.price})`).join('; ');

  try {
    const systemContent = [
      'Eres Leo, asesor de León Telecom.',
      `PLANES DISPONIBLES: ${plansSummary}. SOLO responde de esta lista. PROHIBIDO inventar.`,
      'Máximo dos frases. Sé amable, directo.',
      'Termina siempre con una acción: "¿Instalamos?", "¿Más info?", o "¿Te paso con asesor?"'
    ].join(' ');
    const userContent = [
      `Zona: ${context.location}, ${context.householdSize} personas, plan recomendado: ${baseRecommendation.name} (${baseRecommendation.speed}/${baseRecommendation.price}).`,
      `Cliente dice: ${userText}`,
      'Responde brevemente manteniendo continuidad.'
    ].join('\n');

    const reply = await callAI(systemContent, userContent, { temperature: 0.65 });
    if (reply) return { text: sanitizeAIReply(reply), mediaUrls: [] };
  } catch (error) {
    console.error('Follow-up recommendation AI error:', error.message);
  }

  return { text: fallbackText, mediaUrls: [] };
}

function buildGreetingReply(text) {
  return buildMenuReply();
}

function buildFallbackReply(text) {
  return buildMenuReply();
}

function buildMenuReply() {
  // Durante la promo de agosto la opción 5 (migración) se oculta; los números
  // NO se recorren (el 6 sigue siendo productos) para no romper las respuestas.
  return {
    text: [
      '¿En qué puedo ayudarte? Elige una opción:',
      '',
      '1️⃣ Ver planes de internet',
      '2️⃣ Cámaras de seguridad',
      '3️⃣ Soporte técnico',
      '4️⃣ Hablar con un asesor',
      ...(promoAgostoActiva() ? [] : ['5️⃣ Migrar mi servicio']),
      '6️⃣ Productos y accesorios 🛍️'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: promoAgostoActiva()
        ? [[{ text: '1' }, { text: '2' }, { text: '3' }], [{ text: '4' }, { text: '6' }]]
        : [[{ text: '1' }, { text: '2' }, { text: '3' }], [{ text: '4' }, { text: '5' }, { text: '6' }]],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

async function notifyAgentRequest(chatId, userText, location = '', opts = {}) {
  // Build a short conversation history for context
  const history = getHistory(chatId);
  const recentMsgs = history.messages.slice(-8);
  const historyText = recentMsgs.length > 0
    ? recentMsgs.map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.text}`).join('\n')
    : '(sin historial)';

  const profile = getProfile(chatId);
  const clientName = nameOf(profile, 'Desconocido');

  // AI-generated concise summary (en emergencias usamos el texto tal cual, sin resumir)
  let summaryLine = userText;
  if (!opts.urgent && AI_API_KEY && recentMsgs.length > 0) {
    const shortHistory = recentMsgs.slice(-5).map(m => `${m.role === 'user' ? 'C' : 'L'}: ${m.text.substring(0, 120)}`).join('\n');
    summaryLine = await callAI(
      'Resume en máximo 2 líneas qué quiere o necesita el cliente. Formato:\nMOTIVO: [qué quiere]\nDETALLE: [info clave]\nSin texto extra.',
      `${shortHistory}\nÚltimo mensaje: ${userText}`,
      { temperature: 0.2, maxTokens: 80 }
    ).catch(() => userText);
  }

  const withinHours = isWithinBusinessHours();
  const hoursLine = withinHours
    ? '🟢 En horario de atención'
    : `🌙 Fuera de horario — el cliente sabe que lo atenderás ${describeNextOpening()}`;

  const fullMessage = [
    opts.urgent ? '🚨🚨 EMERGENCIA — ATENDER DE INMEDIATO 🚨🚨' : '🔔 SOLICITUD — León Telecom',
    `👤 ${clientName}  📱 ${chatId}`,
    location ? `📍 ${location}` : '',
    hoursLine,
    '',
    summaryLine,
    '',
    `▶️ ATENDER ${chatId}`
  ].filter(Boolean).join('\n');

  const payload = {
    source: 'whatsapp',
    chatId,
    clientName,
    location,
    userText,
    history: recentMsgs,
    timestamp: new Date().toISOString()
  };

  let notified = false;

  if (AGENT_NOTIFY_WEBHOOK_URL) {
    try {
      const response = await fetch(AGENT_NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) console.error(`Agent webhook failed (${response.status})`);
      else notified = true;
    } catch (e) {
      console.error('Agent webhook error:', e.message);
    }
  }

  if (AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE) {
    try {
      await sendTelegramMessage(AGENT_NOTIFY_CHAT_ID, fullMessage);
      notified = true;
    } catch (e) {
      console.error('Agent Telegram notify error:', e.message);
    }
  }

  if (AGENT_WHATSAPP_NUMBERS.length) {
    await sendToAllAgents(fullMessage, [], {
      buttons: [
        { id: `RECIBIDO ${chatId}`, title: '✅ Recibido, gracias' },
        { id: `ATENDER ${chatId}`, title: '📞 Atender caso' }
      ]
    });
    notified = true;
  }

  // Registro persistente del caso (para el resumen matutino y que nada se pierda)
  logCase(chatId, clientName, opts.urgent ? 'emergencia' : 'asesor', summaryLine);

  if (!notified) {
    console.warn('[notify] No notification channel configured. Set AGENT_WHATSAPP_NUMBER, AGENT_NOTIFY_CHAT_ID, or AGENT_NOTIFY_WEBHOOK_URL in environment variables.');
  }

  // En horario, registramos al cliente para recordarle si nadie lo atiende pronto.
  if (withinHours) {
    pendingAgentRequests.set(String(chatId), { since: new Date(), name: clientName, type: 'asesor', stage: 0 });
    schedulePersist();
  }

  return notified;
}

async function notifyAgentPaymentReceipt(chatId, userName, analysis) {
  const analysisText = analysis.valido
    ? Object.entries(analysis).filter(([k]) => k !== 'valido').map(([k, v]) => `• ${k}: ${v}`).join('\n')
    : `Inválido: ${analysis.razon}`;

  const fullMessage = [
    '📸 *COMPROBANTE DE PAGO — León Telecom*',
    `👤 Cliente: ${userName}`,
    `📱 WhatsApp: ${chatId}`,
    '',
    analysis.valido ? '✅ Comprobante válido' : '❌ Comprobante inválido',
    analysisText
  ].join('\n');

  const payload = {
    source: 'whatsapp',
    type: 'payment_receipt',
    chatId,
    userName,
    analysis,
    timestamp: new Date().toISOString()
  };

  let notified = false;

  if (AGENT_NOTIFY_WEBHOOK_URL) {
    try {
      const response = await fetch(AGENT_NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) notified = true;
    } catch (e) {
      console.error('Agent webhook error:', e.message);
    }
  }

  if (AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE) {
    try {
      await sendTelegramMessage(AGENT_NOTIFY_CHAT_ID, fullMessage);
      notified = true;
    } catch (e) {
      console.error('Agent Telegram receipt notify error:', e.message);
    }
  }

  if (AGENT_WHATSAPP_NUMBER) {
    try {
      await sendWhatsAppMessage(AGENT_WHATSAPP_NUMBER, fullMessage);
      notified = true;
    } catch (e) {
      console.error('Agent WhatsApp receipt notify error:', e.message);
    }
  }

  return notified;
}

async function generateAIReply(userText) {
  if (!AI_API_KEY) return null;
  return callAI(SYSTEM_PROMPT, userText, { temperature: 0.4, maxTokens: 256 });
}

async function sendTelegramMessage(chatId, text, mediaUrls = [], options = {}) {
  if (!TELEGRAM_API_BASE) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }

  // Save bot message to chat history
  if (text) {
    addMessageToHistory(chatId, 'bot', text);
  }

  // Send photos first (if any). Retry each media up to 2 times.
  for (const mediaUrl of mediaUrls || []) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const photoResponse = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: mediaUrl })
        });

        if (!photoResponse.ok) {
          const errorText = await photoResponse.text();
          lastErr = new Error(`Telegram sendPhoto failed (${photoResponse.status}): ${errorText}`);
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }

        // success
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    if (lastErr) throw lastErr;
  }

  // Prepare message payload with optional reply markup
  const messageBody = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    allow_sending_without_reply: true
  };

  if (options.replyMarkup) {
    messageBody.reply_markup = options.replyMarkup;
  }

  // Retry sendMessage a few times to handle transient network/Telegram errors
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const messageResponse = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody)
      });

      const rawMessageText = await messageResponse.text();
      let messagePayload = null;

      try {
        messagePayload = rawMessageText ? JSON.parse(rawMessageText) : null;
      } catch (_error) {
        messagePayload = null;
      }

      if (!messageResponse.ok || !messagePayload?.ok) {
        lastError = new Error(`Telegram sendMessage failed (${messageResponse.status}): ${rawMessageText}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }

      const sentMessageId = messagePayload?.result?.message_id;
      console.log(`[Telegram send ok] chat=${chatId} message_id=${sentMessageId || 'unknown'}`);
      return messagePayload;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  throw lastError || new Error('Unknown Telegram sendMessage error');
}

// ==================== WHATSAPP SEND FUNCTIONS ====================

async function sendWhatsAppMessage(to, text, mediaUrls = [], _options = {}) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    console.error('[WhatsApp] Missing credentials: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
    return;
  }

  const base = `${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const headers = {
    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  if (text) addMessageToHistory(to, 'bot', text);

  for (const imageUrl of (mediaUrls || [])) {
    try {
      await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: imageUrl }
        })
      });
    } catch (err) {
      console.error('[WhatsApp] Image send error:', err.message);
    }
  }

  if (!text) return;

  // Build payload: interactive (buttons/list) or plain text
  let msgPayload;
  if (_options.buttons && _options.buttons.length > 0) {
    msgPayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: text.substring(0, 1024) },
        action: {
          buttons: _options.buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: String(b.id).substring(0, 256), title: String(b.title).substring(0, 20) }
          }))
        }
      }
    };
  } else if (_options.listItems && _options.listItems.length > 0) {
    msgPayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: text.substring(0, 1024) },
        action: {
          button: 'Ver opciones',
          sections: [{
            rows: _options.listItems.slice(0, 10).map(item => ({
              id: String(item.id).substring(0, 256),
              title: String(item.title).substring(0, 24)
            }))
          }]
        }
      }
    };
  } else {
    msgPayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify(msgPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(`WhatsApp send failed (${response.status}): ${errorText}`);
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }

      const result = await response.json();
      console.log(`[WhatsApp send ok] to=${to} message_id=${result?.messages?.[0]?.id || 'unknown'}`);
      return result;
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }

  throw lastError || new Error('Unknown WhatsApp send error');
}

async function downloadWhatsAppMedia(mediaId) {
  const urlResponse = await fetch(
    `${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${mediaId}`,
    { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
  if (!urlResponse.ok) throw new Error(`WhatsApp media URL failed: ${urlResponse.status}`);
  const { url } = await urlResponse.json();

  const mediaResponse = await fetch(url, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
  });
  if (!mediaResponse.ok) throw new Error(`WhatsApp media download failed: ${mediaResponse.status}`);

  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  return buffer.toString('base64');
}

// ==================== SHARED MESSAGE HANDLERS ====================

// Guarda la imagen del cliente en Mongo y devuelve una URL pública (para reenviarla al asesor).
async function storeIncomingImage(imageBase64) {
  try {
    if (!SERVER_BASE_URL) return '';
    let buffer = Buffer.from(imageBase64, 'base64');
    const sharp = getSharp();
    if (sharp) {
      try { buffer = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(); } catch (_) {}
    }
    const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const ok = await persistence.saveImage(id, 'image/jpeg', buffer);
    return ok ? `${SERVER_BASE_URL}/images/db/${id}` : '';
  } catch (e) { console.error('[img] store error:', e.message); return ''; }
}

// Guarda un archivo cualquiera (ej. PDF) en Mongo y devuelve una URL pública.
async function storeIncomingFile(base64, contentType, ext) {
  try {
    if (!SERVER_BASE_URL) return '';
    const buffer = Buffer.from(base64, 'base64');
    const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
    const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const ok = await persistence.saveImage(id, contentType || 'application/octet-stream', buffer);
    return ok ? `${SERVER_BASE_URL}/images/db/${id}` : '';
  } catch (e) { console.error('[file] store error:', e.message); return ''; }
}

// Envía un documento (PDF, etc.) por WhatsApp a partir de un link público.
async function sendWhatsAppDocument(to, link, filename, caption) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !link) return false;
  const base = `${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const doc = { link, filename: String(filename || 'documento.pdf').slice(0, 240) };
  // El caption viaja DENTRO del mismo mensaje que el documento (anclados: no se
  // pueden separar ni entrelazar con otros casos).
  if (caption) doc.caption = String(caption).slice(0, 1024);
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'document', document: doc })
    });
    if (!r.ok) console.error('[WhatsApp] Document send fail', to, r.status, (await r.text().catch(() => '')).slice(0, 180));
    return r.ok;
  } catch (e) { console.error('[WhatsApp] Document send error:', e.message); return false; }
}

// Imagen con el texto ANCLADO como caption: un solo mensaje de WhatsApp, así la
// foto y su información llegan pegadas ("hermanitos") y jamás se cruzan con otro caso.
async function sendWhatsAppImageCaption(to, link, caption) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !link) return false;
  const base = `${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'image',
        image: { link, caption: String(caption || '').slice(0, 1024) }
      })
    });
    if (!r.ok) console.error('[WhatsApp] Image+caption fail', to, r.status, (await r.text().catch(() => '')).slice(0, 180));
    return r.ok;
  } catch (e) { console.error('[WhatsApp] Image+caption error:', e.message); return false; }
}

// TODO-EN-UNO: foto (o PDF) + información + botones dentro de UN solo mensaje de
// WhatsApp (interactivo con encabezado multimedia). Es el formato ideal para los
// reportes de pago: nada puede separarse.
async function sendWhatsAppMediaButtons(to, media, bodyText, buttons) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !buttons || !buttons.length) return false;
  const header = media.imageUrl
    ? { type: 'image', image: { link: media.imageUrl } }
    : media.docUrl
      ? { type: 'document', document: { link: media.docUrl, filename: String(media.docName || 'documento.pdf').slice(0, 240) } }
      : null;
  if (!header) return false;
  const base = `${WHATSAPP_GRAPH}/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'button',
          header,
          body: { text: String(bodyText || '').slice(0, 1024) },
          action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: String(b.id).substring(0, 256), title: String(b.title).substring(0, 20) } })) }
        }
      })
    });
    if (!r.ok) console.error('[WhatsApp] Media+buttons fail', to, r.status, (await r.text().catch(() => '')).slice(0, 180));
    return r.ok;
  } catch (e) { console.error('[WhatsApp] Media+buttons error:', e.message); return false; }
}

// Cola de envío POR ASESOR: cada caso se entrega COMPLETO (foto/PDF anclado + sus
// botones) antes de que empiece el siguiente. Si dos clientes reportan pago al
// mismo tiempo, al asesor le llegan en bloques ordenados, nunca revueltos.
const _agentSendQ = new Map();
function agentQueue(num, fn) {
  const prev = _agentSendQ.get(num) || Promise.resolve();
  const next = prev.then(fn, fn);
  _agentSendQ.set(num, next.then(() => {}, () => {}));
  return next;
}

// Avisa a TODOS los asesores. Si el envío normal falla, reintenta con plantilla.
//
// Sin ese plan B se perdían avisos en silencio: WhatsApp solo deja mandar
// mensajes normales a quien te escribió en las últimas 24 h, así que si el
// asesor llevaba un día sin hablarle al bot, Meta rechazaba el aviso, el error
// se quedaba en la consola y nadie se enteraba. Pasó de verdad: un cliente
// escribió a las 5 de la tarde y el asesor no supo hasta las 10 de la mañana
// siguiente, cuando el resumen matutino —que sí tenía este plan B— lo rescató.
//
// La plantilla no admite botones, así que en ese caso se explica cómo responder
// por texto (el bot ya entiende RECIBIDO / ATENDER escritos a mano).
async function sendToAllAgents(text, media = [], opts = {}) {
  await Promise.all(AGENT_WHATSAPP_NUMBERS.map(num => agentQueue(num, async () => {
    try { await sendWhatsAppMessage(num, text, media, opts); }
    catch (e) {
      console.warn('[notify wa] Envío normal falló a', num, '(¿ventana de 24h?), probando plantilla:', e.message);
      try {
        await sendWhatsAppTemplate(num, `${text}\n\nResponde: RECIBIDO [número] o ATENDER [número].`);
        console.log('[notify wa] Rescatado por plantilla a', num);
      } catch (e2) {
        // Si TAMBIÉN falló la plantilla (p. ej. WHATSAPP_AVISO_TEMPLATE sin
        // configurar), el aviso se perdería sin que nadie lo note: justo lo que
        // causó este problema. Al menos que quede a la vista.
        console.error('[notify wa] Plantilla también falló a', num, ':', e2.message);
        alertAdmin('aviso-no-entregado',
          `No pude avisarte de un caso por WhatsApp (${num}). Falló el envío normal y también la plantilla. ` +
          `El caso NO se perdió: está en el panel y en el resumen de mañana. Revisa WHATSAPP_AVISO_TEMPLATE.`);
      }
    }
  })));
}
// Reenvía un documento a TODOS los asesores.
async function sendDocToAllAgents(docUrl, docName) {
  if (!docUrl) return;
  await Promise.all(AGENT_WHATSAPP_NUMBERS.map(num => agentQueue(num, async () => {
    try { await sendWhatsAppDocument(num, docUrl, docName); } catch (_) {}
  })));
}
// Avisa a los OTROS asesores (todos menos el que actuó). Útil para "caso ya tomado".
async function notifyOtherAgents(exceptAgent, text) {
  const ex = _normAgentNum(exceptAgent);
  for (const num of AGENT_WHATSAPP_NUMBERS) {
    if (num === ex) continue;
    try { await sendWhatsAppMessage(num, text); }
    catch (e) {
      // Mismo plan B que en sendToAllAgents: sin esto, el asesor que lleva más
      // de 24 h sin escribirle al bot nunca se entera de que otro ya tomó el caso.
      console.warn('[notify other] Envío normal falló a', num, '(¿ventana de 24h?), probando plantilla:', e.message);
      try { await sendWhatsAppTemplate(num, text); }
      catch (e2) { console.error('[notify other] Plantilla también falló a', num, ':', e2.message); }
    }
  }
}
/**
 * Cómo se nombra a un asesor en los avisos entre asesores.
 *
 * Antes decían solo "otro asesor", y con varios en el equipo eso no ayudaba:
 * había que preguntar por el grupo quién había tomado el caso. Ahora va el
 * número, que es con lo que se le busca en la agenda o se le marca.
 *
 * A propósito NO se muestra el nombre, aunque el bot lo tenga guardado: se
 * pidió así, y el número es el dato que de verdad sirve para localizarlo.
 */
function describeAgent(num) {
  const limpio = _normAgentNum(num);
  if (!limpio) return 'otro asesor';
  return `el asesor con el número *${limpio}*`;
}

// ¿Qué asesor está atendiendo (relay) a este cliente? '' si ninguno.
function agentHandling(clientId) {
  const c = String(clientId);
  for (const [agent, client] of agentActiveCases.entries()) if (String(client) === c) return agent;
  return '';
}

// Avisa al/los asesor(es) (Telegram y WhatsApp) con el texto y, si hay, la foto/documento.
// Agrega dos botones de acción: "Recibido, gracias" (acuse) y "Atender caso" (abre relay).
async function notifyAgentWithImage(chatId, userName, headline, bodyLines, imageUrl, opts = {}) {
  const num = String(chatId).replace(/\D/g, '');
  const msg = [headline, `👤 Cliente: ${userName || 'Sin nombre'}`, `📱 WhatsApp: ${num}`, '', ...(bodyLines || [])].join('\n');
  const media = imageUrl ? [imageUrl] : [];
  // Registro persistente del caso (para el resumen matutino y que nada se pierda)
  if (!opts.noLog) logCase(num, userName, opts.caseType || 'imagen', `${headline} · ${(bodyLines || []).join(' · ')}`, { imageUrl, docUrl: opts.docUrl || '' });
  const buttons = opts.noButtons ? null : [
    { id: `RECIBIDO ${num}`, title: '✅ Recibido, gracias' },
    { id: `ATENDER ${num}`, title: '📞 Atender caso' }
  ];
  // Los botones van con el nombre del cliente para que se sepa de QUÉ caso son.
  const btnTxt = `👆 Botones de ESTE caso: *${userName || 'cliente'}* (${num})`;
  if (AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE) { try { await sendTelegramMessage(AGENT_NOTIFY_CHAT_ID, msg, media); } catch (e) { console.error('[notify tg]', e.message); } }
  // Entrega ANCLADA y EN BLOQUE por asesor: la foto/PDF lleva la información como
  // caption (un solo mensaje, imposible que se separen) y los botones salen justo
  // después, todo dentro de la cola del asesor para que otro caso no se meta en medio.
  await Promise.all(AGENT_WHATSAPP_NUMBERS.map(agent => agentQueue(agent, async () => {
    try {
      // 1) IDEAL — TODO EN UNO: adjunto + información + botones en el mismo mensaje.
      if (buttons && (imageUrl || opts.docUrl)) {
        const ok = await sendWhatsAppMediaButtons(agent, { imageUrl, docUrl: opts.docUrl, docName: opts.docName }, msg, buttons);
        if (ok) {
          // caso rarísimo: imagen Y pdf a la vez → el pdf va justo después, en la misma cola
          if (imageUrl && opts.docUrl) await sendWhatsAppDocument(agent, opts.docUrl, opts.docName);
          return;
        }
      }
      // 2) Plan B: adjunto con la info anclada como caption + botones aparte.
      let anclado = false;
      if (imageUrl) anclado = await sendWhatsAppImageCaption(agent, imageUrl, msg);
      if (opts.docUrl) {
        const okDoc = await sendWhatsAppDocument(agent, opts.docUrl, opts.docName, anclado ? '' : msg);
        anclado = anclado || okDoc;
      }
      if (!anclado) {
        // 3) Último recurso: que la información NUNCA se pierda.
        const aviso = (imageUrl || opts.docUrl)
          ? '\n\n⚠️ No pude adjuntar el archivo aquí; míralo en: ' + (imageUrl || opts.docUrl)
          : '';
        await sendWhatsAppMessage(agent, msg + aviso, [], buttons ? { buttons } : {});
        return;
      }
      if (buttons) await sendWhatsAppMessage(agent, btnTxt, [], { buttons });
    } catch (e) { console.error('[notify anclado]', agent, e.message); }
  })));
}

async function handleIncomingImage(chatId, userName, imageBase64, platform, sendMsg) {
  try {
    // Anti-flood: las imágenes son caras (análisis IA); limitamos por número también.
    if (!isAgentNumber(String(chatId)) && isFlooding(chatId)) { console.warn(`[rate-limit] exceso de imágenes de ${chatId}, ignorado`); return; }
    dataManager.registerUser(chatId, { name: userName, platform });
    await sendMsg(chatId, '⏳ Analizando tu imagen…');
    const a = (await analyzePaymentReceipt(imageBase64)) || {};
    try { dataManager.createReport(chatId, a, imageBase64); } catch (_) {}
    const url = await storeIncomingImage(imageBase64);
    const tipo = a.tipo || (a.valido ? 'comprobante' : 'otro');

    // Una imagen nueva invalida cualquier confirmación de comprobante / documento en curso.
    pendingDoc.delete(String(chatId));

    // ---- COMPROBANTE: extrae nombre + monto y pide confirmación con botones ----
    if (tipo === 'comprobante') {
      const nombre = String(a.nombre || '').trim();
      const monto = String(a.monto || '').trim();
      // ¿El cliente ya había dicho por texto "a nombre de X"? Lo cotejamos.
      const _st = statedTitular.get(String(chatId));
      const titular = (_st && Date.now() - (_st.ts || 0) < 20 * 60 * 1000) ? _st.name : '';
      statedTitular.delete(String(chatId));
      // Registramos el caso YA (aunque el cliente no confirme, no se pierde y sale en el resumen).
      const _c = logCase(chatId, userName, 'pago',
        `Comprobante recibido (esperando confirmación): pagó ${nombre || '¿?'} / ${monto || '¿?'}${titular ? ' · a nombre de ' + titular : ''}`,
        { imageUrl: url });
      pendingImage.set(String(chatId), { url, analysis: a, userName, ts: Date.now(), caseId: _c && _c.id, titular });
      let det = '📄 Recibí tu comprobante de pago. En la imagen detecté:\n\n';
      det += '👤 Nombre: ' + (nombre || '_no lo pude leer bien_') + '\n';
      det += '💵 Monto: ' + (monto || '_no lo pude leer bien_');
      if (a.fecha) det += '\n📅 Fecha: ' + a.fecha;
      if (titular) det += '\n\n📝 Y tú me dijiste que es a nombre de: *' + titular + '*.';
      det += '\n\n¿Los datos son correctos?';
      if (platform === 'whatsapp') {
        await sendMsg(chatId, det, [], { buttons: [
          { id: 'comprobante_si', title: '✅ Sí, correcto' },
          { id: 'comprobante_no', title: '❌ No / corregir' }
        ] });
      } else {
        await sendMsg(chatId, det + '\n\nResponde *SÍ* o *NO*.');
      }
      return;
    }

    // ---- EQUIPO / EMERGENCIA / OTRO: la IA lo describe y se pasa al asesor con la foto ----
    // Bug fix: una imagen no-comprobante invalida cualquier confirmación pendiente para
    // que el siguiente texto del cliente NO se dispare como "corrección" fantasma.
    pendingImage.delete(String(chatId));
    const desc = String(a.descripcion || '').trim();
    if (tipo === 'emergencia') {
      await notifyAgentWithImage(chatId, userName, '🚨 POSIBLE EMERGENCIA (imagen del cliente)', [desc || 'El cliente envió una imagen que parece urgente.'], url, { caseType: 'emergencia' });
      await sendMsg(chatId, '🚨 Recibí tu imagen y parece algo urgente. Ya avisé a un asesor para atenderte lo antes posible. Si es una emergencia grave, por favor llama también. 🙏');
    } else if (tipo === 'equipo') {
      await notifyAgentWithImage(chatId, userName, '🔧 Imagen de equipo / posible falla', [desc || 'El cliente envió una foto de un equipo.'], url, { caseType: 'equipo' });
      await sendMsg(chatId, '✅ Recibí la foto de tu equipo. Un asesor la está revisando y te contactará pronto para ayudarte. 🔧');
    } else {
      await notifyAgentWithImage(chatId, userName, '🖼️ Imagen del cliente', [desc || 'El cliente envió una imagen.'], url, { caseType: 'imagen' });
      await sendMsg(chatId, '✅ Recibí tu imagen. Un asesor la revisará y se pondrá en contacto contigo. 😊');
    }
    pendingAgentRequests.set(String(chatId), { since: new Date(), name: userName, type: 'imagen', stage: 0 });
    if (typeof schedulePersist === 'function') schedulePersist();
  } catch (error) {
    console.error('Image handling error:', error.message);
    try { await sendMsg(chatId, '❌ Tuve un problema al procesar la imagen. ¿Puedes reenviarla, por favor?'); } catch (_) {}
  }
}

function buildMigrationNotification(d, name) {
  return [
    `SOLICITUD DE MIGRACIÓN DE SERVICIO`,
    `Nombre: ${name}`,
    '',
    `DOMICILIO ACTUAL (${d.currentLocation}):`,
    d.currentNeighborhood ? `  Colonia/Barrio: ${d.currentNeighborhood}` : '',
    `  Referencias: ${d.currentDetails || 'no especificadas'}`,
    '',
    `DOMICILIO NUEVO (${d.newLocation}):`,
    d.newNeighborhood ? `  Colonia/Barrio: ${d.newNeighborhood}` : '',
    `  Referencias: ${d.newDetails || 'no especificadas'}`
  ].filter(Boolean).join('\n');
}

/*
 * Dar por bueno el comprobante de un cliente: marca sus casos, le avisa (por
 * plantilla, puede ser de hace días) y, si el comprobante era de otra cuenta,
 * también al titular. Lo usan el asesor por WhatsApp (RECIBIDO) y el panel.
 */
async function confirmarPagoRecibido(clientId, porQuien) {
  // Qué factura cubre ese comprobante: la que debía al aceptarlo. Se anota en el
  // caso para que "ya pagó este mes" se decida por periodo también aquí.
  try {
    const dc = await deudaConocidaDe(String(clientId).replace(/\D/g, ''));
    if (dc.conocida && dc.cubreHasta) for (const c of caseLog) if (c.clientId === String(clientId).replace(/\D/g, '') && c.type === 'pago' && c.status === 'pendiente') c.cubreHasta = dc.cubreHasta;
  } catch (_) { /* sin factura a la mano, vale la ventana de días */ }
  const casoPago = caseLog.find((c) => c.clientId === clientId && c.status === 'pendiente' && c.type === 'pago');
  const titularAjeno = (String((casoPago || {}).resumen || '').match(/Coincide: [^·\n]+· (\d{12})/) || [])[1];
  const marcados = markCases(clientId, 'recibido', porQuien);
  if (!marcados) return { marcados: 0, eraPago: !!casoPago, titularAjeno: '' };
  pendingAgentRequests.delete(clientId);
  schedulePersist();
  const suspendidoAun = /suspend|cort/i.test(String((wisphubClients.get(clientId) || {}).status || ''));
  try {
    await avisarPorIniciativa(clientId, casoPago
      ? '✅ Tu pago quedó registrado. ¡Gracias! 🙌' + (suspendidoAun ? ' Tu servicio se reactiva en unos minutos; si en una hora sigue sin navegar, reinicia tu módem o escríbenos.' : '')
      : '✅ ¡Recibido, gracias! 🙌');
  } catch (e) { console.error('[recibido] aviso al cliente:', e.message); }
  if (titularAjeno && titularAjeno !== clientId) {
    try { await avisarPorIniciativa(titularAjeno, '✅ Recibimos el pago de tu servicio de internet (lo mandó otra persona por ti) y ya quedó registrado. ¡Gracias! 🙌'); }
    catch (e) { console.error('[recibido] aviso al titular:', e.message); }
  }
  return { marcados, eraPago: !!casoPago, titularAjeno: titularAjeno && titularAjeno !== clientId ? titularAjeno : '' };
}

async function handleAgentCommand(agentNumber, text) {
  const v = text.trim().toUpperCase();

  function normalizeClientNumber(raw) {
    let n = raw.replace(/\D/g, '');
    if (!n.startsWith('52')) n = '52' + n;
    if (n.startsWith('521') && n.length === 13) n = '52' + n.slice(3);
    return n;
  }

  // ATENDER [número] — toma el control y activa el relay
  const atenderMatch = v.match(/^ATENDER\s+(\d[\d\s-]{6,})/);
  if (atenderMatch) {
    const clientId = normalizeClientNumber(atenderMatch[1]);

    // Si ya tiene un caso activo (distinto), no deja tomar otro: hay que cerrarlo primero.
    const current = agentActiveCases.get(agentNumber);
    if (current && current !== clientId) {
      const curName = nameOf(getProfile(current), current);
      await sendWhatsAppMessage(agentNumber, [
        `⚠️ Ya tienes un caso activo con *${curName}* (${current}).`,
        '',
        'Debes *cerrarlo* antes de tomar otro.',
        `Cierra con *LIBERAR ${current}* o con el botón de abajo. 👇`
      ].join('\n'), [], { buttons: [{ id: `LIBERAR ${current}`, title: 'Cerrar caso actual' }] });
      return;
    }
    // Si ya está atendiendo justamente a ese cliente, solo lo reconfirma.
    if (current && current === clientId) {
      const cName = nameOf(getProfile(clientId), clientId);
      await sendWhatsAppMessage(agentNumber,
        `ℹ️ Ya tienes este caso activo: *${cName}* (${clientId}). Lo que escribas se le reenvía.`,
        [], { buttons: [{ id: `LIBERAR ${clientId}`, title: 'Cerrar caso' }] });
      return;
    }
    // Si OTRO asesor ya está atendiendo a este cliente, avisamos y no lo duplicamos.
    const otro = agentHandling(clientId);
    if (otro && otro !== agentNumber) {
      const cName = nameOf(getProfile(clientId), clientId);
      await sendWhatsAppMessage(agentNumber,
        `🙋 *${cName}* (${clientId}) ya lo está atendiendo ${describeAgent(otro)}. Si necesitas tomarlo tú, pídele que lo cierre con *LIBERAR ${clientId}*.`);
      return;
    }

    pauseChat(clientId, 4);
    agentActiveCases.set(agentNumber, clientId);
    pendingAgentRequests.delete(clientId); // ya lo está atendiendo un asesor
    markCases(clientId, 'atendido', agentNumber);
    schedulePersist();
    const clientProfile = getProfile(clientId);
    const clientName = nameOf(clientProfile, clientId);
    try {
      await sendWhatsAppMessage(clientId,
        'Un asesor de León Telecom ya está en línea y te atenderá directamente. 📱'
      );
    } catch (e) { console.error('[Agent] Notify client error:', e.message); }
    await sendWhatsAppMessage(agentNumber, [
      `✅ Caso activo: ${clientName} (${clientId})`,
      '',
      'Todo lo que escribas aquí se reenvía al cliente.',
      'Lo que responda el cliente te llegará a ti.'
    ].join('\n'), [], {
      buttons: [{ id: `LIBERAR ${clientId}`, title: 'Cerrar caso' }]
    });
    // Avisa a los demás asesores que este caso ya fue tomado (sus botones ya no aplican).
    await notifyOtherAgents(agentNumber,
      `🔒 El caso de *${clientName}* (${clientId}) ya fue tomado por ${describeAgent(agentNumber)}.\nLos botones de ese caso ya no aplican. 🙅`);
    return;
  }

  // PRORROGA [número] [días] [motivo] — le da plazo al cliente y calla el aviso de corte
  const prorrogaMatch = text.trim().match(/^PR[OÓ]RROGA\s+(\d[\d\s-]{6,})\s+(\d{1,2})\s*(?:d[ií]as?)?\s*(.*)$/i);
  if (prorrogaMatch) {
    const clientId = normalizeClientNumber(prorrogaMatch[1]);
    const p = darProrroga(clientId, prorrogaMatch[2], agentNumber, prorrogaMatch[3]);
    const nombre = (wisphubClients.get(clientId) || {}).name || clientId;
    const [y, m, d] = p.hasta.split('-');
    const hastaTxt = `${d}/${m}/${y}`;
    await sendWhatsAppMessage(agentNumber, `📅 Prórroga registrada para *${nombre}* hasta el *${hastaTxt}* (${p.dias} día${p.dias !== 1 ? 's' : ''}). No le va a llegar aviso de corte hasta entonces.`);
    try {
      await avisarProrroga(clientId, p);
    } catch (_) { /* si no se le pudo avisar, la prórroga vale igual */ }
    return;
  }

  // LIBERAR [número] — cierra el relay y devuelve al bot
  const liberarMatch = v.match(/^LIBERAR\s+(\d[\d\s-]{6,})/);
  if (liberarMatch) {
    const clientId = normalizeClientNumber(liberarMatch[1]);
    unpauseChat(clientId);
    agentActiveCases.delete(agentNumber);
    pendingAgentRequests.delete(clientId);
    markCases(clientId, 'atendido', agentNumber);
    schedulePersist();
    try {
      await sendWhatsAppMessage(clientId,
        'El asesor ha finalizado la atención. El asistente virtual queda a tus órdenes. ¿En qué más puedo ayudarte?'
      );
    } catch (e) {}
    await sendWhatsAppMessage(agentNumber, `✅ Caso cerrado. Bot reactivado para ${clientId}.`);
    return;
  }

  // RECIBIDO [número] — acuse de recibo: agradece al cliente y cierra la espera (NO abre relay)
  const recibidoMatch = v.match(/^RECIBIDO\s+(\d[\d\s-]{6,})/);
  if (recibidoMatch) {
    const clientId = normalizeClientNumber(recibidoMatch[1]);
    const cName = nameOf(getProfile(clientId), clientId);
    // Si OTRO asesor ya lo está atendiendo, no lo tocamos (él lo cierra).
    const dueño = agentHandling(clientId);
    if (dueño && dueño !== agentNumber) {
      await sendWhatsAppMessage(agentNumber, `🔒 *${cName}* (${clientId}) ya lo está atendiendo ${describeAgent(dueño)}. No hice nada.`);
      return;
    }
    // Si ya fue gestionado (no queda pendiente), avisamos y no repetimos el "gracias".
    // Si ya fue gestionado (no queda pendiente), avisamos y no repetimos el "gracias".
    const yaHabia = caseLog.some((c) => c.clientId === clientId && c.status === 'pendiente');
    if (!yaHabia && !pendingAgentRequests.has(clientId)) {
      const quien = quienGestiono(clientId);
      await sendWhatsAppMessage(agentNumber, quien
        ? `ℹ️ El caso de *${cName}* (${clientId}) ya había sido gestionado por ${describeAgent(quien)}.`
        : `ℹ️ El caso de *${cName}* (${clientId}) ya había sido gestionado por otro asesor.`);
      return;
    }
    const rc = await confirmarPagoRecibido(clientId, agentNumber);
    if (!rc.marcados) { pendingAgentRequests.delete(clientId); schedulePersist(); try { await sendWhatsAppMessage(clientId, '✅ ¡Recibido, gracias! 🙌'); } catch (_) {} }
    const titularAjeno = rc.titularAjeno;
    await sendWhatsAppMessage(agentNumber, `✅ Marcado como recibido. Le avisé a *${cName}* (${clientId})${titularAjeno && titularAjeno !== clientId ? ` y al titular (${titularAjeno})` : ''}. El bot sigue atendiéndolo.`);
    // Avisa a los demás asesores que este caso ya fue gestionado.
    await notifyOtherAgents(agentNumber, `✅ El caso de *${cName}* (${clientId}) ya fue *marcado como recibido* por ${describeAgent(agentNumber)}.`);
    return;
  }

  // PAUSADOS — ver casos activos
  if (v === 'PAUSADOS') {
    const activos = [];
    for (const [chatId, data] of pausedChats.entries()) {
      if (new Date() < data.pausedUntil) {
        const mins = Math.round((data.pausedUntil - new Date()) / 60000);
        const cp = getProfile(chatId);
        const name = nameOf(cp, chatId);
        activos.push(`• ${name} — ${chatId} (${mins} min)`);
      }
    }
    await sendWhatsAppMessage(agentNumber,
      activos.length > 0
        ? `Casos activos:\n${activos.join('\n')}`
        : 'No hay casos activos actualmente.'
    );
    return;
  }

  // PENDIENTES / CASOS / MENSAJES — baja de la base de datos los casos pendientes
  // (los que llegaron fuera de horario también) enlistados con sus botones.
  if (v === 'PENDIENTES' || v === 'CASOS' || v === 'MENSAJES') {
    await deliverPendingCases(agentNumber);
    return;
  }

  // Mensaje normal mientras hay un caso activo → relay al cliente
  const activeClient = agentActiveCases.get(agentNumber);
  if (activeClient && !v.startsWith('ATENDER') && !v.startsWith('LIBERAR') && !v.startsWith('RECIBIDO')
      && v !== 'PAUSADOS' && v !== 'PENDIENTES' && v !== 'CASOS' && v !== 'MENSAJES') {
    pendingAgentRequests.delete(activeClient); // el asesor ya respondió
    try {
      await sendWhatsAppMessage(activeClient, text.trim());
    } catch (e) {
      await sendWhatsAppMessage(agentNumber, `❌ No se pudo enviar al cliente: ${e.message}`);
    }
    return;
  }

  // Ayuda
  await sendWhatsAppMessage(agentNumber, [
    '🤖 Comandos disponibles:',
    '',
    'PENDIENTES → Ver los casos pendientes (con sus botones)',
    'ATENDER [número] → Tomar un caso (activa relay)',
    'RECIBIDO [número] → Acuse: agradece al cliente y cierra la espera',
    'LIBERAR [número] → Cerrar caso y devolver al bot',
    'PRORROGA [número] [días] [motivo] → Darle días para pagar (se le avisa y no le llega aviso de corte)',
    'PAUSADOS → Ver casos activos',
    '',
    'Solo puedes tener UN caso a la vez: ciérralo (LIBERAR) antes de tomar otro.',
    'Mientras tienes un caso activo, todo lo que escribas se reenvía al cliente.'
  ].join('\n'));
}

// ==================== RECORDATORIO AL CLIENTE EN ESPERA ====================
// Si un cliente pidió asesor y nadie lo atiende, le mandamos un mensaje de calma.
const REMINDER_1_MIN = 15;   // primer recordatorio (mensaje de calma, sin número)
const REMINDER_2_MIN = 30;   // segundo recordatorio (recién aquí ofrece el teléfono)
const REMINDER_STALE_MIN = 360; // tras 6h sin atención, descartamos la espera

async function sweepAgentReminders() {
  if (pendingAgentRequests.size === 0) return;
  if (!isWithinBusinessHours()) return; // solo recordamos en horario de atención
  const now = Date.now();
  const attendedClients = new Set(agentActiveCases.values());

  for (const [clientId, info] of [...pendingAgentRequests.entries()]) {
    // Si ya lo está atendiendo un asesor, dejamos de recordar
    if (attendedClients.has(clientId)) { pendingAgentRequests.delete(clientId); continue; }

    const since = info.since instanceof Date ? info.since.getTime() : new Date(info.since).getTime();
    const mins = (now - since) / 60000;
    if (mins > REMINDER_STALE_MIN) { pendingAgentRequests.delete(clientId); continue; }

    try {
      if ((info.stage || 0) < 1 && mins >= REMINDER_1_MIN) {
        await sendWhatsAppMessage(clientId,
          'Estimado cliente, agradecemos su paciencia. 🙏 Su solicitud sigue en proceso y un asesor de León Telecom lo atenderá muy pronto. Una disculpa por la espera.');
        info.stage = 1; pendingAgentRequests.set(clientId, info); schedulePersist();
      } else if ((info.stage || 0) < 2 && mins >= REMINDER_2_MIN) {
        await sendWhatsAppMessage(clientId,
          `Lamentamos la demora. 🙏 Un asesor lo atenderá lo antes posible. Si su asunto es *urgente*, puede llamarnos directamente al ${LEON_CONTACT_NUMBER}.`);
        info.stage = 2; pendingAgentRequests.set(clientId, info); schedulePersist();
      }
    } catch (e) {
      console.error('[reminder] error enviando recordatorio:', e.message);
    }
  }
}

// ==================== RESUMEN MATUTINO DE CASOS AL ASESOR ====================
// Manda un mensaje al asesor (o intenta) y si falló por la ventana de 24h,
// lo reintenta con la plantilla de utilidad (que sí llega siempre).
async function sendAgentMessageSafe(text, opts = {}) {
  if (AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE) {
    try { await sendTelegramMessage(AGENT_NOTIFY_CHAT_ID, text); } catch (e) { console.error('[digest tg]', e.message); }
  }
  for (const num of AGENT_WHATSAPP_NUMBERS) {
    try {
      await sendWhatsAppMessage(num, text, [], opts);
    } catch (e) {
      console.warn('[digest] Envío normal falló a', num, '(¿ventana de 24h?), probando plantilla:', e.message);
      try { await sendWhatsAppTemplate(num, text); }
      catch (e2) { console.error('[digest] Plantilla también falló a', num, ':', e2.message); }
    }
  }
}

const CASE_TYPE_EMOJI = { pago: '💳', documento: '📄', equipo: '🔧', emergencia: '🚨', asesor: '🙋', imagen: '🖼️' };

// Envía a UN asesor los casos pendientes de la base de datos, uno por uno,
// cada uno con su foto/documento y sus botones (Recibido / Atender).
async function deliverPendingCases(agentNumber) {
  const pend = caseLog.filter(c => c.status === 'pendiente');
  if (!pend.length) { await sendWhatsAppMessage(agentNumber, '✅ No hay casos pendientes por ahora. ¡Todo al día! 🙌'); return; }
  const fmtHora = new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
  await sendWhatsAppMessage(agentNumber, `📥 Tienes *${pend.length}* caso(s) pendiente(s). Te los mando con sus botones 👇 (🌙 = fuera de horario)`);
  const lote = pend.slice(0, 20);
  for (const c of lote) {
    try {
      const body = [
        `${CASE_TYPE_EMOJI[c.type] || '•'}${c.offHours ? ' 🌙' : ''} *${c.name}* (${c.clientId})`,
        `🕒 ${fmtHora.format(new Date(c.ts))}`,
        c.resumen || ''
      ].filter(Boolean).join('\n');
      const btns = { buttons: [
        { id: `RECIBIDO ${c.clientId}`, title: '✅ Recibido, gracias' },
        { id: `ATENDER ${c.clientId}`, title: '📞 Atender caso' }
      ] };
      // Cada caso sale como un BLOQUE anclado dentro de la cola del asesor:
      // foto/PDF con su información como caption + sus botones, sin mezclarse
      // con avisos en vivo que lleguen a media descarga.
      await agentQueue(agentNumber, async () => {
        // Ideal: adjunto + info + botones en UN solo mensaje.
        if (c.imageUrl || c.docUrl) {
          const ok = await sendWhatsAppMediaButtons(agentNumber, { imageUrl: c.imageUrl, docUrl: c.docUrl, docName: 'documento' }, body, btns.buttons);
          if (ok) { if (c.imageUrl && c.docUrl) await sendWhatsAppDocument(agentNumber, c.docUrl, 'documento'); return; }
        }
        // Plan B: caption + botones aparte.
        let anclado = false;
        if (c.imageUrl) anclado = await sendWhatsAppImageCaption(agentNumber, c.imageUrl, body);
        if (c.docUrl) {
          const okDoc = await sendWhatsAppDocument(agentNumber, c.docUrl, 'documento', anclado ? '' : body);
          anclado = anclado || okDoc;
        }
        if (!anclado) { await sendWhatsAppMessage(agentNumber, body, [], btns); return; }
        await sendWhatsAppMessage(agentNumber, `👆 Botones de ESTE caso: *${c.name}* (${c.clientId})`, [], btns);
      });
      await new Promise(r => setTimeout(r, 350));
    } catch (e) { console.error('[casos] deliver error:', e.message); }
  }
  if (pend.length > lote.length) await sendWhatsAppMessage(agentNumber, `…y ${pend.length - lote.length} caso(s) más. Ve gestionando estos y vuelve a pedir *PENDIENTES*.`);
}

// Al abrir la oficina: resumen de los casos que siguen pendientes (sobre todo
// los que llegaron fuera de horario y se pudieron perder entre los chats).
// ==================== MANTENER ABIERTA LA VENTANA DE 24 H ====================
// Plantilla propia para este recordatorio (debe traer UN botón de respuesta
// rápida). Si no está configurada, se usa la de avisos, que llega igual pero
// sin botón: entonces hay que contestarle al bot a mano para reabrir.
const WHATSAPP_VENTANA_TEMPLATE = process.env.WHATSAPP_VENTANA_TEMPLATE || '';
const VENTANA_MS = 24 * 3600 * 1000;
const VENTANA_AVISAR_ANTES_MS = 2 * 3600 * 1000; // tocarle el hombro 2 h antes

/**
 * Le recuerda al asesor que toque el botón antes de que se cierre su ventana.
 *
 * El problema de fondo: WhatsApp solo deja mandar avisos normales a quien te
 * escribió en las últimas 24 h, y esa cuenta la reinicia SOLO lo que el asesor
 * manda. Que el bot le escriba no cuenta. Así que si pasa un día sin que él le
 * escriba al bot, los avisos de clientes empiezan a rebotar.
 *
 * La plantilla por sí sola tampoco reabre nada — pero el TOQUE del botón sí,
 * porque para WhatsApp eso es un mensaje del asesor. De ahí que el recordatorio
 * lleve botón: un toque y quedan otras 24 h.
 *
 * Es preventivo; el reintento con plantilla al fallar un aviso sigue estando
 * como red por debajo.
 */
async function sweepAgentWindow() {
  try {
    if (!AGENT_WHATSAPP_NUMBERS.length) return;
    // Nunca de madrugada: un recordatorio a las 3 a.m. nadie lo va a tocar y
    // solo despierta a alguien. Entre 8:00 y 21:00 de México.
    const { minutesOfDay } = mexicoNow();
    if (minutesOfDay < 480 || minutesOfDay > 1260) return;

    const ahora = Date.now();
    for (const num of AGENT_WHATSAPP_NUMBERS) {
      const ultimo = agentLastInbound.get(num);
      // Sin dato = nunca ha escrito, o se perdió en un reinicio. Se asume lo
      // peor (ventana cerrada) y se le avisa: equivocarse hacia el aviso de más
      // cuesta un mensaje; equivocarse al revés cuesta perder el de un cliente.
      const quedaAbierta = ultimo ? (new Date(ultimo).getTime() + VENTANA_MS) - ahora : -1;
      if (quedaAbierta > VENTANA_AVISAR_ANTES_MS) continue;

      // Como mucho un recordatorio al día, aunque nunca conteste.
      const previo = agentPingSent.get(num);
      if (previo && ahora - new Date(previo).getTime() < VENTANA_MS) continue;

      const horas = quedaAbierta > 0 ? Math.max(1, Math.round(quedaAbierta / 3600000)) : 0;
      const texto = horas > 0
        ? `Hola 👋 Para seguir recibiendo los avisos de clientes al instante, toca el botón de abajo. Tu conexión con el bot se cierra en ~${horas} h y después los avisos se retrasan.`
        : 'Hola 👋 Tu conexión con el bot se cerró, así que los avisos de clientes te van a llegar tarde. Toca el botón de abajo para reactivarla ahora.';

      try {
        if (WHATSAPP_VENTANA_TEMPLATE) {
          await sendWhatsAppTemplate(num, texto, { templateName: WHATSAPP_VENTANA_TEMPLATE, buttonPayload: 'VENTANA_OK' });
        } else {
          // Sin plantilla propia: la de avisos llega, pero sin botón. Se le pide
          // que conteste cualquier cosa, que para WhatsApp vale igual que el toque.
          await sendWhatsAppTemplate(num, `${texto} (Responde cualquier cosa a este chat.)`);
        }
        agentPingSent.set(num, new Date().toISOString());
        schedulePersist();
        console.log(`[ventana] Recordatorio enviado a ${num} (quedaban ${horas} h)`);
      } catch (e) {
        console.error('[ventana] No se pudo enviar el recordatorio a', num, ':', e.message);
      }
    }
  } catch (e) { console.error('[ventana] sweep error:', e.message); }
}

/**
 * Quita de la lista los pagos que alguien ya registró en Wisphub.
 *
 * Se pregunta por el estado real en vez de confiar en la memoria: la oficina
 * puede marcar una factura desde el panel de Wisphub sin que este sistema se
 * entere. Si no se comprobara, la lista de la mañana repetiría cosas ya hechas
 * y en pocos días nadie la leería.
 *
 * Si Wisphub no contesta, se conserva la lista tal cual: es mejor pedir de más
 * que perder el rastro de un pago que ya entró.
 */
async function depurarRegistrosPendientes() {
  if (!stripeRegistrosPendientes.length) return [];
  if (!WISPHUB_API_KEY) return stripeRegistrosPendientes;

  const vivos = [];
  for (const r of stripeRegistrosPendientes) {
    // El saldo a favor no tiene factura que consultar: se queda hasta que
    // alguien lo aplique, y se suelta solo a los 30 días para no crecer sin fin.
    if (r.tipo !== 'factura' || !r.factura) {
      if (Date.now() - r.cuando < 30 * 24 * 3600 * 1000) vivos.push(r);
      continue;
    }
    try {
      const res = await wisphubFetch(`${WISPHUB_API_URL}/api/facturas/${r.factura}/?format=json`,
        { headers: { Authorization: `Api-Key ${WISPHUB_API_KEY}` } }, 'digest: revisar factura');
      if (!res.ok) { vivos.push(r); continue; }
      const f = await res.json();
      const yaPagada = String(f.estado || '').toLowerCase().includes('pagada');
      if (!yaPagada) vivos.push(r);
      else console.log(`[digest] factura ${r.factura} ya fue registrada, sale de la lista`);
    } catch (e) {
      console.warn('[digest] no se pudo revisar la factura', r.factura, '·', e.message);
      vivos.push(r);
    }
  }
  if (vivos.length !== stripeRegistrosPendientes.length) {
    stripeRegistrosPendientes = vivos;
    schedulePersist();
  }
  return vivos;
}

async function sweepMorningDigest() {
  try {
    if (!AGENT_WHATSAPP_NUMBERS.length && !(AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE)) return;
    const today = mexicoDateStr();
    if (lastDigestDate === today) return;
    const { dow, minutesOfDay } = mexicoNow();
    const windows = BUSINESS_HOURS[dow] || [];
    if (!windows.length) return;
    const opening = windows[0][0];
    // Ventana de 20 min a partir de la hora de apertura del día
    if (minutesOfDay < opening || minutesOfDay >= opening + 20) return;
    lastDigestDate = today;
    schedulePersist();

    const cutoff = Date.now() - 36 * 3600 * 1000; // casos de las últimas 36 horas
    const pend = caseLog.filter(c => c.status === 'pendiente' && new Date(c.ts).getTime() >= cutoff);

    /*
     * Antes de pedir que marquen facturas, se comprueba cuáles YA se marcaron.
     *
     * Alguien pudo haberlo hecho ayer desde el panel de Wisphub sin pasar por
     * aquí. Pedirle a la oficina que vuelva a marcar algo ya hecho es la forma
     * más rápida de que dejen de leer la lista, y entonces se pierde la que sí
     * importaba.
     */
    const registros = await depurarRegistrosPendientes();
    if (!pend.length && !registros.length) return; // nada que reportar, no molestamos

    const fmtHora = new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
    const lines = pend.slice(0, 15).map(c =>
      `${CASE_TYPE_EMOJI[c.type] || '•'}${c.offHours ? ' 🌙' : ''} *${c.name}* (${c.clientId}) — ${fmtHora.format(new Date(c.ts))}\n   ${c.resumen.slice(0, 140)}`
    );
    /*
     * Los pagos que entraron solos y que alguien tiene que registrar.
     *
     * Va con el monto y el número de factura para que sea buscar y marcar, no
     * investigar. Y se dice POR QUÉ urge: con la factura pendiente, a alguien
     * que ya pagó le siguen llegando avisos de corte y lo pueden volver a
     * suspender.
     */
    const facturas = registros.filter((r) => r.tipo === 'factura');
    const aFavor = registros.filter((r) => r.tipo === 'afavor');
    /*
     * El dinero que se fue para atrás va en SU PROPIO bloque.
     *
     * Un contracargo no es "un pago por registrar": es lo contrario, un pago
     * que se deshizo. Mezclarlo con los demás haría que la oficina fuera a
     * marcar como pagada una factura cuyo dinero el banco ya se llevó, que es
     * exactamente el error que este aviso existe para evitar.
     */
    const enContra = registros.filter((r) => r.tipo === 'disputa' || r.tipo === 'devolucion');
    const porRegistrar = registros.filter((r) => r.tipo !== 'disputa' && r.tipo !== 'devolucion');
    const bloqueContra = !enContra.length ? [] : [
      '',
      `🚨 *${enContra.length} pago${enContra.length === 1 ? '' : 's'} que se revirtió*`,
      '(el dinero YA NO está: no marques estas facturas como pagadas)',
      '',
      ...enContra.slice(0, 8).map((r) => (r.tipo === 'disputa'
        ? `⚖️ *${r.nombre || r.telefono}* — contracargo por $${Number(r.total).toFixed(2)}\n     ${r.detalle || ''}`
        : `↩️ *${r.nombre || r.telefono}* — devolución de $${Number(r.total).toFixed(2)}`)),
    ].filter(Boolean);
    const bloqueRegistros = !porRegistrar.length ? [] : [
      '',
      `💰 *${porRegistrar.length} pago${porRegistrar.length === 1 ? '' : 's'} por registrar en Wisphub*`,
      '(ya se les reactivó el servicio; falta marcar su factura o su saldo a favor)',
      '',
      ...facturas.slice(0, 12).map((r) =>
        `🧾 *${r.nombre}* — factura *#${r.factura}* · $${Number(r.total).toFixed(2)}`),
      ...aFavor.slice(0, 6).map((r) =>
        `⭐ *${r.nombre}* — $${Number(r.total).toFixed(2)} a favor (no debía nada)`),
      ...registros.filter((r) => r.tipo === 'ambiguo').slice(0, 6).map((r) =>
        `❓ *${r.nombre}* (${r.telefono}) — pagó, pero tiene varios servicios\n     ${r.detalle || ''}`),
      porRegistrar.length > 18 ? `…y ${porRegistrar.length - 18} más.` : '',
      '',
      '⚠️ Mientras no se marquen, esos clientes siguen apareciendo con deuda y les pueden volver a cortar.',
    ].filter(Boolean);

    const encabezado = pend.length
      ? [`☀️ ¡Buenos días! Tienes *${pend.length} caso${pend.length === 1 ? '' : 's'} pendiente${pend.length === 1 ? '' : 's'}*:`,
         '(🌙 = llegó fuera de horario)', '', ...lines,
         pend.length > 15 ? `…y ${pend.length - 15} más.` : '', '',
         'Toca *📥 Ver casos* para bajarlos uno por uno con sus botones, o responde *RECIBIDO [número]* / *ATENDER [número]*.']
      : ['☀️ ¡Buenos días! No hay casos pendientes de clientes.'];

    const msg = [...encabezado, ...bloqueRegistros, ...bloqueContra].filter(Boolean).join('\n');
    await sendAgentMessageSafe(msg, pend.length ? { buttons: [{ id: 'PENDIENTES', title: '📥 Ver casos' }] } : {});
    console.log(`[digest] Resumen matutino enviado: ${pend.length} casos · ${registros.length} pagos por registrar`);
  } catch (e) { console.error('[digest] sweep error:', e.message); }
}

// ==================== RECORDATORIO DE FECHA DE CORTE (Wisphub) ====================
// Un día antes del corte, se avisa a cada cliente por PLANTILLA de utilidad
// (llega aunque no haya chateado con el bot en 24h), personalizado con su nombre.
const CORTE_REMINDER_TIME = process.env.CORTE_REMINDER_TIME || '10:00'; // hora de México
// Hasta qué hora (México) se acepta mandar el aviso cuando el barrido no pudo correr a
// su hora. 20:00 = cierre de atención entre semana de León Telecom (BUSINESS_HOURS):
// más tarde el cliente ya no puede preguntarle nada a nadie, así que el aviso solo lo
// angustia — y mandar plantillas de noche a decenas de personas es la forma más rápida
// de que reporten el número como spam y Meta nos baje la calidad.
const CORTE_REMINDER_LIMIT = process.env.CORTE_REMINDER_LIMIT || '20:00'; // hora de México
// APAGADO por defecto: los avisos de corte NO se envían solos hasta el lanzamiento
// oficial del bot. Para activarlos: poner CORTE_REMINDER_ENABLED=true en Render.
// (La prueba manual desde el panel con force=true sí funciona aunque esté apagado.)
const CORTE_REMINDER_ENABLED = String(process.env.CORTE_REMINDER_ENABLED || 'false') === 'true';

// Normaliza fecha de corte de Wisphub a 'YYYY-MM-DD'. Acepta: '2026-07-15',
// ISO con hora, '15/07/2026' o solo el día del mes ('15').
function parseFechaCorte(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^\d{1,2}$/); // solo el día del mes → próxima ocurrencia
  if (m) {
    const day = Number(s);
    if (day < 1 || day > 31) return null;
    const [y, mo] = mexicoDateStr().split('-').map(Number);
    const mk = (yy, mm) => {
      const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // días del mes
      return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, dim)).padStart(2, '0')}`;
    };
    const hoy = mexicoDateStr();
    const cand = mk(y, mo);
    if (cand >= hoy) return cand;
    return mo === 12 ? mk(y + 1, 1) : mk(y, mo + 1);
  }
  return null;
}

function parseTimeToMinutes(hhmm, fallback = 600) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return (mins >= 0 && mins < 1440) ? mins : fallback;
}

// Extrae el nombre que el cliente dice en un texto: "a nombre de X", "de parte de X",
// "comprobante de X", "el pago es de X". Devuelve '' si no encuentra un nombre razonable.
function extractTitularName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(?:a\s+nombre\s+de|de\s+parte\s+de|el\s+pago\s+es\s+de|comprobante\s+(?:de|del|es\s+de|a\s+nombre\s+de))\s+(.+)$/i);
  if (!m) return '';
  let name = m[1]
    .replace(/\b(gracias|porfa(?:vor)?|please|saludos|buen[oa]s?\s+(?:d[ií]as|tardes|noches))\b.*$/i, '')
    .replace(/[.,;:!¡¿?"'()]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Solo palabras que parezcan de un nombre (letras), máximo 6.
  let palabras = name.split(' ').filter(w => /^[a-záéíóúñü]+$/i.test(w));
  // Quita títulos/artículos al inicio (la señora Guadalupe → Guadalupe).
  const titulos = new Set(['la', 'el', 'sr', 'sra', 'señor', 'señora', 'don', 'doña', 'c', 'mi', 'del']);
  while (palabras.length && titulos.has(palabras[0].toLowerCase())) palabras.shift();
  palabras = palabras.slice(0, 6);
  name = palabras.join(' ').trim();
  if (name.length < 3 || palabras.length < 1) return '';
  return tituloCase(name);
}

// "CARLOS MANUEL ACEVEDO FLORES" → "Carlos Manuel Acevedo Flores" (partículas en minúscula).
function tituloCase(s) {
  const chicas = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do']);
  return String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean).map((w, i) =>
    (i > 0 && chicas.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
}

// ¿Este cliente DEBE? Es EXACTAMENTE el mismo criterio del reporte de finanzas
// (/admin/api/cobranza). A propósito no se inventa otro: si el panel dijera una cosa y
// el WhatsApp otra, los números no cuadrarían y no se podría confiar en ninguno.
// OJO con los nombres: finanzas lee el objeto CRUDO de Wisphub (estado, estado_facturas)
// y aquí leemos el mapa ya sincronizado, que los guarda en camelCase (status,
// estadoFacturas). Equivocarse ahí daría "no debe" para TODOS y el aviso dejaría de
// mandarse a nadie sin que nadie se entere.
// Sin dato de facturas y sin saldo NO cuenta como deuda, igual que en finanzas: falla
// hacia "no mandar", que es la dirección segura.
// ¿La factura está sin pagar? Se buscaba el trozo "pagad" y se daba por pagada.
// Hoy Wisphub manda 'Pagadas' y 'Pendiente de Pago', y con esos funciona bien — pero
// "No Pagado" TAMBIÉN contiene "pagad", así que el día que cambiaran la etiqueta
// dejaríamos de avisarle a quien debe, en silencio y sin que nadie se entere.
// Por eso ahora la negación manda: primero se busca "no/sin pagad", y solo si no
// está se acepta "pagad" como pagada. Vacío = sin dato = no cuenta como deuda
// (mismo criterio de siempre; la deuda de verdad la delata el saldo o la suspensión).
function facturaDebe(fact) {
  const f = String(fact || '').toLowerCase().trim();
  if (!f) return false;
  if (/\b(no|sin)\s+pagad/.test(f)) return true;    // "No Pagado", "sin pagar"
  return !f.includes('pagad');                       // "Pendiente de Pago", "Vencida"…
}
/*
 * ¿Ya pagó, aunque Wisphub todavía no lo sepa?
 *
 * La factura en Wisphub se marca a mano (la API no deja), así que entre que
 * el cliente paga y la oficina lo registra pueden pasar días. En ese hueco
 * Wisphub dice "debe" y el bot le mandaba "mañana te cortamos" a alguien que
 * ya pagó por el propio bot. Aquí se mira lo que el bot SÍ sabe: los pagos
 * en línea que entraron y los comprobantes que la oficina ya dio por buenos.
 */
/*
 * Cuántos días atrás cuenta un pago como "ya pagó este mes". Tres semanas, no
 * un mes: con 31 días, quien paga puntual el día antes de su corte (el 14 para
 * el 15) tenía ese pago "reciente" cuando llegaba el aviso del mes siguiente
 * (el 14 del otro mes, 30 días después) y se le callaba el recordatorio que sí
 * le tocaba; mes tras mes. Con 21 días, el pago de hace un mes ya no cuenta y
 * el de hace dos semanas (el que Wisphub a veces tarda en marcar) sí.
 */
const CORTE_DIAS_PAGO_RECIENTE = Math.max(1, Number(process.env.CORTE_DIAS_PAGO_RECIENTE) || 21);
/*
 * ¿Ya pagó lo de este periodo? Si el pago trae hasta qué vencimiento cubre
 * (`cubreHasta`, la factura que pagó), se compara con el corte que se está
 * evaluando: cubre si cae a ±15 días de ese corte o más adelante. Si no lo
 * trae (pagos viejos, comprobantes), vale la ventana de días.
 */
function pagoRecienteDe(telefono, corte = '') {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return null;
  const desde = Date.now() - CORTE_DIAS_PAGO_RECIENTE * 24 * 3600 * 1000;
  const reg = stripeClientes.get(tel) || {};
  if (reg.adelantadoHasta && reg.adelantadoHasta >= fechaLocalISO()) return { cuando: Date.now(), canal: `adelantado hasta ${reg.adelantadoHasta}` };
  const ref = corte || fechaLocalISO();
  const refMs = new Date(ref + 'T12:00:00').getTime();
  const cubre = (p) => {
    if (!p.cubreHasta) return p.cuando >= desde;
    const dif = (new Date(p.cubreHasta + 'T12:00:00').getTime() - refMs) / 86400000;
    return dif >= -15;
  };
  const enLinea = (stripePagosRecientes.get(tel) || []).filter((p) => p && cubre(p) && p.cuando >= Date.now() - 400 * 86400000);
  if (enLinea.length) { const u = enLinea[enLinea.length - 1]; return { cuando: u.cuando, canal: u.canal || 'en línea' }; }
  for (const c of caseLog) {
    if (c.type !== 'pago' || c.status !== 'recibido') continue;
    /*
     * El comprobante lo manda quien paga, que muchas veces no es el titular.
     * Si el aviso al asesor ya traía "Coincide: ... · <teléfono del titular>",
     * ese pago cuenta para el TITULAR: es a él a quien no hay que mandarle
     * "mañana te cortamos" cuando su hija ya pagó por él.
     */
    const esSuyo = c.clientId === tel || String(c.resumen || '').includes('· ' + tel);
    if (!esSuyo) continue;
    const t = new Date(c.ts).getTime();
    const vale = c.cubreHasta ? ((new Date(c.cubreHasta + 'T12:00:00').getTime() - refMs) / 86400000 >= -15 && t >= Date.now() - 400 * 86400000) : t >= desde;
    if (vale) return { cuando: t, canal: c.clientId === tel ? 'comprobante' : 'comprobante de otra persona' };
  }
  return null;
}
/*
 * Pagó meses adelantados (por link o por transferencia): se anota hasta
 * cuándo, para que el aviso de corte no le llegue en esos meses, y se le
 * dice a la oficina que registre los meses que vienen (Wisphub solo tiene la
 * factura de hoy). Devuelve la fecha hasta la que queda cubierto.
 */
function anotarMesesAdelantados(telefono, mesesPagados, montoTexto) {
  const tel = String(telefono || '').replace(/\D/g, '');
  const w0 = wisphubClients.get(tel) || {};
  const base = parseFechaCorte(w0.fechaCorte) || fechaLocalISO();
  const h = new Date(base + 'T12:00:00'); h.setMonth(h.getMonth() + (mesesPagados - 1));
  const hasta = fechaLocalISO(h);
  stripeClientes.set(tel, { ...(stripeClientes.get(tel) || {}), adelantadoHasta: hasta, adelantadoMeses: mesesPagados });
  schedulePersist();
  alertAdmin('meses-adelantados', `📅 ${w0.name || tel} pagó *${mesesPagados} meses* de una vez (${montoTexto}). Wisphub solo tiene la factura de este mes: hay que registrar los ${mesesPagados - 1} siguientes a mano. Queda cubierto hasta el ${hasta}.`);
  return hasta;
}

// Un comprobante que ya mandaron (él o alguien por él) y la oficina todavía
// no revisa. No es un pago confirmado, pero tampoco se le puede decir
// "mañana te cortamos" como si no hubiera mandado nada.
function comprobanteEnRevisionDe(telefono, dias = 3) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return null;
  const desde = Date.now() - dias * 24 * 3600 * 1000;
  return caseLog.find((c) => c.type === 'pago' && c.status === 'pendiente' && new Date(c.ts).getTime() >= desde
    && (c.clientId === tel || String(c.resumen || '').includes('· ' + tel))) || null;
}

// El último pago reciente que este teléfono hizo por la cuenta de OTRO (la hija
// que paga lo de su mamá y luego pregunta "¿ya quedó?").
function pagoHechoPor(telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return null;
  const desde = Date.now() - CORTE_DIAS_PAGO_RECIENTE * 24 * 3600 * 1000;
  let mejor = null;
  for (const [titular, lista] of stripePagosRecientes) {
    for (const p of lista || []) {
      if (p && p.pagadoPor === tel && p.cuando >= desde && (!mejor || p.cuando > mejor.cuando)) mejor = { ...p, titular };
    }
  }
  return mejor;
}
function canalTexto(canal) {
  const m = { tarjeta: 'con tarjeta', oxxo: 'en OXXO', transferencia: 'por transferencia a tu CLABE', 'tarjeta-automatico': 'con tu cobro automático', comprobante: 'con el comprobante que mandaste', 'comprobante de otra persona': 'con el comprobante que mandaron por ti' };
  const k = String(canal || '');
  return m[k] || (k.startsWith('adelantado') ? 'pagado por adelantado' : 'en línea');
}
function fechaLocalISO(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function prorrogaVigente(telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  const p = prorrogas[tel];
  if (!p || !p.hasta) return null;
  if (p.hasta < fechaLocalISO()) { delete prorrogas[tel]; schedulePersist(); return null; }
  return p;
}
function darProrroga(telefono, dias, por, motivo = '') {
  const tel = String(telefono || '').replace(/\D/g, '');
  const n = Math.max(1, Math.min(31, Number(dias) || 0));
  const hasta = new Date(); hasta.setDate(hasta.getDate() + n);
  // Si se ajusta una prórroga sin decir por qué, el motivo original se queda.
  const motivoFinal = String(motivo || '').trim() || ((prorrogas[tel] || {}).motivo || '');
  prorrogas[tel] = { hasta: fechaLocalISO(hasta), dias: n, por: String(por || '').replace(/[^\w@. -]/g, '').slice(0, 40), cuando: new Date().toISOString(), motivo: motivoFinal.slice(0, 200) };
  schedulePersist();
  return { ...prorrogas[tel], conAutomatico: !!(stripeClientes.get(tel) || {}).cobroAutomatico };
}

// Lo que se le dice al cliente cuando se le da (o se le ajusta) una prórroga,
// se dé por WhatsApp o desde el panel: la misma frase en los dos lados.
async function avisarProrroga(telefono, p) {
  const [y, m, d] = String(p.hasta || '').split('-');
  const hastaTxt = `${d}/${m}/${y}`;
  return avisarPorIniciativa(telefono, p.conAutomatico
    ? `📅 Listo, te dimos hasta el *${hastaTxt}*. Como tienes *cobro automático*, ese mes se cobra a tu tarjeta un día antes de que venza la prórroga (te aviso dos días antes), no en tu fecha de corte. Si prefieres pagar antes de otra forma, escribe *pagar*. 🙌`
    : `📅 Listo, te dimos hasta el *${hastaTxt}* para pagar tu servicio. Ese día es el último: si no pagas, el servicio se suspende. Cuando quieras pagar, escribe *pagar*. 🙌`);
}

function clienteDebe(c) {
  const low = s => String(s || '').toLowerCase();
  const e = low(c && c.status);
  const saldo = parseFloat((c && c.saldo) || 0) || 0;
  const fact = String((c && c.estadoFacturas) || '');
  return !!(e.includes('suspend') || saldo > 0 || facturaDebe(fact));
}

// Último minuto del día en que se acepta mandar el aviso atrasado. Si la variable viene
// mal escrita se usa el default (20:00), y si alguien pusiera un tope ANTERIOR a la hora
// de envío se vuelve a la ventana corta de 30 min: así ningún typo deja al barrido sin
// ventana ni le abre una absurda.
function corteTopeMinutos(objetivo) {
  const tope = parseTimeToMinutes(CORTE_REMINDER_LIMIT, 1200);
  return tope > objetivo ? tope : objetivo + 30;
}

// Deja constancia de la corrida. Devuelve true solo si escribió una línea NUEVA: los
// abortos se reevalúan cada rato y sin este filtro llenarían la bitácora (y el
// WhatsApp del admin) con la misma queja repetida.
function registrarCorridaCorte(e) {
  if (e.motivo && corteRunLog.some(r => r.fecha === e.fecha && r.motivo === e.motivo)) return false;
  corteRunLog.unshift({ at: new Date().toISOString(), ...e, motivo: e.motivo || '' });
  if (corteRunLog.length > CORTE_RUN_LOG_MAX) corteRunLog.length = CORTE_RUN_LOG_MAX;
  schedulePersist();
  return true;
}

// Días de los últimos <dias> sin constancia de una corrida buena. Cada hueco es un
// grupo de clientes que cortó sin recibir su aviso. No cuenta los días anteriores a la
// primera corrida registrada: ahí todavía no existía esta bitácora y serían huecos falsos.
function huecosCorte(dias = 7) {
  if (!corteRunLog.length) return [];
  const primera = corteRunLog[corteRunLog.length - 1].fecha;
  if (!primera) return [];
  const buenos = new Set(corteRunLog.filter(r => r.ok).map(r => r.fecha));
  const out = [];
  for (let i = 1; i <= dias; i++) {
    const d = mexicoDateStr(new Date(Date.now() - i * 86400000));
    if (d < primera) break;
    if (!buenos.has(d)) out.push(d);
  }
  return out;
}

// force=true (desde el panel) corre ya, sin esperar la hora — el dedup evita repetir.
/*
 * ¿A quién le toca aviso o cobro automático hoy? Se decide con la fecha de
 * corte que trae Wisphub: dos días antes, aviso; un día antes, cobro.
 */
function fechaMasDias(dias) {
  const d = new Date(); d.setDate(d.getDate() + dias);
  return fechaLocalISO(d);
}
let _ultimoBarridoAuto = null;
async function barrerCobroAutomatico(force = false) {
  const hechos = { avisados: 0, cobrados: 0, rechazados: 0, sinDeuda: 0, sinTarjeta: 0 };
  const _resultado = (r) => { _ultimoBarridoAuto = { ...r, cuando: new Date().toISOString() }; return r; };
  if (!stripeLeon.activo() || !stripeLeon.cuentaLista()) return _resultado({ ...hechos, apagado: true });
  const hora = Number(new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, hour: 'numeric', hour12: false }).format(new Date()));
  // Entre las 9 y las 20: a nadie le gusta un cargo (ni un aviso) de madrugada.
  if (!force && (hora < 9 || hora >= 20)) return _resultado({ ...hechos, fueraDeHorario: true });
  const manana = fechaMasDias(1);
  const pasadoManana = fechaMasDias(2);

  for (const [clave, reg] of stripeClientes) {
    if (!reg || !reg.cobroAutomatico || !reg.clienteId) continue;
    const { tel, servicioId: servicioDeClave } = stripeLeon.partirClave(clave);
    if (servicioDeClave) continue;   // el automático vive en la clave del teléfono, no en la de cada CLABE
    const c = { ...(wisphubClients.get(tel) || {}) };
    /*
     * Con varios contratos, la deuda y la reactivación son las del contrato
     * que el cliente eligió al activar el automático, no las del primero.
     */
    if (reg.autoServicioId) {
      const varios = await serviciosDeLaCuenta(tel);
      const el = varios.find((x) => x.id === String(reg.autoServicioId));
      if (el) { c.usuario = el.usuario || c.usuario; c.etiqueta = el.etiqueta; }
    }
    const corte = parseFechaCorte(c.fechaCorte);
    if (!corte) continue;
    const log = autoCobros[tel] || (autoCobros[tel] = {});
    const per = log[corte] || (log[corte] = {});
    /*
     * Con prórroga, el día de cobro se recorre: se avisa dos días antes de que
     * venza y se cobra un día antes, no en la fecha de corte original. Pedir
     * más días y que la tarjeta se cobre igual no sería una prórroga.
     */
    const prAuto = prorrogaVigente(tel);
    const diaDeCobro = prAuto && prAuto.hasta > corte ? prAuto.hasta : corte;
    if (diaDeCobro !== corte && !per.estado) hechos.conProrroga = (hechos.conProrroga || 0) + 1;

    // Dos días antes: el aviso, con el monto que Wisphub diga hoy. Si este mes ya
    // pagó por su cuenta (o va adelantado), no se le anuncia un cobro que no va a pasar.
    if (diaDeCobro === pasadoManana && !per.avisado) {
      if (pagoRecienteDe(tel, corte)) { per.avisado = new Date().toISOString(); per.estado = 'ya-pago'; schedulePersist(); continue; }
      let monto = 0;
      try { monto = (await wisphubReactivar.deudaDelCliente(c.usuario || '')).total; } catch (_) { /* se avisa sin monto */ }
      if (monto <= 0) monto = parseFloat(c.precioPlan) || 0;
      per.avisado = new Date().toISOString(); schedulePersist();
      await avisarPorIniciativa(tel,
        `📅 Hola. Tu fecha de pago es el ${corte.split('-').reverse().join('/')}. *Mañana se cobrará${monto > 0 ? ` $${monto.toFixed(2)}` : ' tu mensualidad'} a tu tarjeta guardada*, como lo pediste, y tu servicio sigue sin cortes.\n\n`
        + 'Si este mes prefieres pagar de otra forma, escribe *pagar* y elige cómo: al ver tu pago, mañana no se cobra nada a la tarjeta. Para quitar el automático por completo, escribe *CANCELAR AUTOMÁTICO*.').catch(() => {});
      hechos.avisados++;
      continue;
    }

    // Un día antes: el cobro. Una sola vez por periodo, pase lo que pase.
    if (diaDeCobro === manana && !per.estado) {
      /*
       * Si mandó un comprobante que la oficina no ha revisado, cobrarle ahora
       * sería cobrarle dos veces. Se pospone (la pasada de la siguiente hora lo
       * vuelve a intentar): si lo dan por bueno, cae en "ya pagó"; si lo
       * rechazan, se cobra. La oficina se entera una sola vez.
       */
      if (comprobanteEnRevisionDe(tel)) {
        if (!per.avisadoRevision) {
          per.avisadoRevision = new Date().toISOString(); schedulePersist();
          alertAdmin('auto-en-revision', `📄 ${c.name || tel} tiene cobro automático para mañana, pero mandó un comprobante que sigue SIN REVISAR. No se le cobró a la tarjeta para no cobrarle doble: revísalo hoy en el panel (Comprobantes por revisar).`);
        }
        hechos.enRevision = (hechos.enRevision || 0) + 1;
        continue;
      }
      per.estado = 'en-proceso'; per.cuando = new Date().toISOString(); schedulePersist();
      try {
        /*
         * Si este mes ya pagó por su cuenta (tarjeta, OXXO, CLABE o comprobante
         * aceptado), no se le cobra en automático aunque Wisphub siga con la
         * factura pendiente: la oficina la marca a mano y eso tarda días.
         */
        const yaPago = pagoRecienteDe(tel, corte);
        if (yaPago) {
          per.estado = 'ya-pago'; per.motivo = yaPago.canal; schedulePersist(); hechos.sinDeuda++;
          await avisarPorIniciativa(tel, '✅ Este mes ya pagaste por tu cuenta, así que no se cobró nada a tu tarjeta. El cobro automático sigue activo para el mes que viene. 🙌').catch(() => {});
          continue;
        }
        let deuda = 0;
        try { deuda = (await wisphubReactivar.deudaDelCliente(c.usuario || '')).total; }
        catch (e) { throw new Error('No se pudo leer la deuda: ' + e.message); }
        if (deuda <= 0) {
          per.estado = 'sin-deuda'; schedulePersist(); hechos.sinDeuda++;
          await avisarPorIniciativa(tel, '✅ Hoy tocaba tu cobro automático, pero tu cuenta ya está al corriente: no se cobró nada. 🙌').catch(() => {});
          continue;
        }
        const tarjeta = await stripeLeon.metodoGuardadoDe(reg.clienteId);
        if (!tarjeta) {
          per.estado = 'sin-tarjeta'; schedulePersist(); hechos.sinTarjeta++;
          await avisarPorIniciativa(tel, `⚠️ Tocaba cobrar tu mensualidad de $${deuda.toFixed(2)} a tu tarjeta, pero ya no hay una tarjeta guardada. Escribe *pagar* para pagar de otra forma, o vuelve a activar el automático al pagar con tarjeta. 🙏`).catch(() => {});
          continue;
        }
        const r = await stripeLeon.cobrarGuardado({ clienteId: reg.clienteId, metodoPago: tarjeta.id, monto: deuda, telefono: tel, nombre: c.name, periodo: corte });
        if (r.ok) {
          per.estado = 'cobrado'; per.ref = r.id; per.monto = r.mensualidad; schedulePersist(); hechos.cobrados++;
          registrarPagoYRevisarDoble({ telefono: tel, monto: r.mensualidad, canal: 'tarjeta-automatico', ref: r.id, cubreHasta: corte });
          markCases(tel, 'recibido', 'stripe-auto');
          sumarAlMes(r.mensualidad, 'tarjeta');
          await avisarPorIniciativa(tel, `✅ Se cobró tu mensualidad de *$${r.mensualidad.toFixed(2)}* (más $${r.cargo.toFixed(2)} por pagar en línea) a tu tarjeta terminación ${tarjeta.ultimos4}. Tu servicio sigue activo, sin cortes. 🙌`).catch(() => {});
          try {
            const w = await wisphubReactivar.aplicarPago({ telefono: tel, monto: r.mensualidad, referencia: r.id, idServicio: reg.autoServicioId || undefined });
            avisarRegistroPendiente(w, tel);
          } catch (e) { console.error('[auto] aplicar pago:', e.message); }
        } else {
          per.estado = 'rechazado'; per.motivo = r.motivo || r.estado; schedulePersist(); hechos.rechazados++;
          await avisarPorIniciativa(tel, `⚠️ No se pudo cobrar tu mensualidad de $${deuda.toFixed(2)} a tu tarjeta terminación ${tarjeta.ultimos4} (${r.necesitaAlCliente ? 'el banco pide tu autorización' : 'fue rechazada'}). Para que no se corte tu servicio, escribe *pagar* y elige otra forma. 🙏`).catch(() => {});
          alertAdmin('cobro-automatico', `El cobro automático de ${c.name || tel} ($${deuda.toFixed(2)}) fue rechazado (${r.motivo || r.estado}). Ya se le pidió que pague por otra vía.`);
        }
      } catch (e) {
        per.estado = 'error'; per.motivo = e.message; schedulePersist();
        console.error('[auto] cobro de', tel, ':', e.message);
        alertAdmin('cobro-automatico', `No se pudo hacer el cobro automático de ${c.name || tel}: ${e.message}. Conviene revisarlo antes de su corte de mañana.`);
      }
    }
  }
  return _resultado(hechos);
}

/*
 * ¿YA QUEDÓ? Un reporte de falla que nadie cierra.
 *
 * En el panel, 31 de 33 reportes seguían "abiertos" aunque el técnico ya
 * había ido: nadie los cierra. A los tres días el bot le pregunta al cliente
 * si ya quedó, con dos botones. "Sí" cierra el reporte solo; "sigue igual" lo
 * vuelve a subir al asesor con la marca de que ya pasaron tres días.
 */
const TICKET_DIAS_PREGUNTA = Math.max(1, Number(process.env.TICKET_DIAS_PREGUNTA) || 3);
async function preguntarSiYaQuedo(force = false) {
  const hechos = { preguntados: 0 };
  const hora = Number(new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, hour: 'numeric', hour12: false }).format(new Date()));
  if (!force && (hora < 10 || hora >= 20)) return hechos;
  const limite = Date.now() - TICKET_DIAS_PREGUNTA * 24 * 3600 * 1000;
  for (const t of tickets.values()) {
    if (!t || t.estado === 'resuelto' || t.preguntadoEn) continue;
    if (new Date(t.createdAt).getTime() > limite) continue;
    t.preguntadoEn = new Date().toISOString(); schedulePersist();
    try {
      // Va por plantilla (fuera de la ventana de 24 h no llega el texto libre),
      // y la plantilla no trae botones propios: se contesta con una palabra.
      await avisarPorIniciativa(t.chatId,
        `🔧 Hola. Hace unos días reportaste: "${String(t.problema || '').slice(0, 80)}" (folio ${t.folio}). ¿Ya quedó tu servicio? Responde *SÍ* si ya quedó, o *NO* si sigue igual.`);
      hechos.preguntados++;
    } catch (e) { console.warn('[tickets] no se pudo preguntar por', t.folio, e.message); }
  }
  return hechos;
}

async function sweepCorteReminders(force = false) {
  try {
    if (!CORTE_REMINDER_ENABLED && !force) return null;
    if (!WHATSAPP_AVISO_TEMPLATE || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) return null;
    // NADA de escribirle a clientes con el estado a medio cargar. Si persistence.load()
    // falla o tarda, corteReminders y lastCorteRunDate quedan VACÍOS y este barrido
    // creería que hoy no ha mandado nada → reenviaría a todos los de mañana. Es el
    // mismo seguro que ya usa la bienvenida (welcomeReady = true justo tras hidratar).
    // Aplica también al botón del panel: ahí el riesgo de duplicar es el mismo.
    if (!welcomeReady) return { error: 'El estado guardado aún no se cargó (o falló al cargar). No se envía nada para no repetir avisos ya enviados.' };
    const today = mexicoDateStr();
    if (!force) {
      if (lastCorteRunDate === today) return null;
      const objetivo = parseTimeToMinutes(CORTE_REMINDER_TIME);
      const { minutesOfDay } = mexicoNow();
      // Ventana LARGA (de la hora configurada al tope de la tarde) en vez de los 30 min
      // de antes: en Render gratis la instancia duerme, y si entre 10:00 y 10:30 nadie
      // le escribía al bot, ese día NADIE recibía su aviso y ni siquiera quedaba un
      // error. Ahora sale en cuanto el servidor despierte, mientras al cliente todavía
      // le da tiempo de pagar.
      if (minutesOfDay < objetivo || minutesOfDay >= corteTopeMinutos(objetivo)) return null;
    }

    // Datos FRESCOS antes de escribirle a nadie: el sync de rutina es cada 6 h y en ese
    // hueco cabe de sobra el pago de ayer. Avisarle de corte a quien ya pagó es justo el
    // error que no nos podemos permitir, así que vale la pena el costo (3 llamadas a
    // Wisphub, ~4 s) antes de mandar nada.
    // Si Wisphub está caído no tiene caso machacarlo cada 5 min durante diez horas (ni
    // llenar la bitácora y el WhatsApp del admin): se reintenta cada 25 min, que en la
    // ventana de 10:00 a 20:00 son ~20 oportunidades, de sobra.
    if (!force && Date.now() - _corteLastSyncTry < 25 * 60000) return null;
    const fresco = await syncWisphubClients();
    // Se cruzó con el sync de rutina: NO armamos el freno (no le pegamos a Wisphub) para
    // que el siguiente tick, dentro de 5 min, lo vuelva a intentar enseguida.
    if (fresco && fresco.skipped) return { error: 'Hay una sincronización de Wisphub en curso; se reintenta solo en unos minutos.' };
    if (wisphubSyncError || !lastWisphubComplete || !wisphubClients.size) {
      // Lista fallida o a medias = mandaríamos avisos con datos de quién sabe cuándo, o
      // dejaríamos fuera a medio pueblo. NO marcamos el día como corrido, así que se
      // reintenta dentro de la ventana. Mandar tarde se perdona; mandar mal, no.
      if (!force) _corteLastSyncTry = Date.now(); // el freno se arma solo si SÍ fallamos
      const motivo = wisphubSyncError ? `Wisphub falló (${wisphubSyncError})`
        : (fresco && fresco.error) ? `Wisphub no respondió (${fresco.error})`
        : 'la lista de Wisphub llegó incompleta';
      if (registrarCorridaCorte({ fecha: today, ok: false, motivo, forzada: !!force })) {
        alertAdmin('corte-datos', `Avisos de corte detenidos: ${motivo}. Se reintenta solo cada 25 min hasta las ${CORTE_REMINDER_LIMIT}.`);
      }
      return { error: `Datos de Wisphub no confiables (${motivo}). No se envió nada.` };
    }

    lastCorteRunDate = today;
    schedulePersist();

    const mananaDate = new Date(Date.now() + 24 * 3600 * 1000);
    const manana = mexicoDateStr(mananaDate);
    // "jueves 16 de julio" (sin la coma que mete Intl entre el día de la semana y la fecha).
    const bonita = new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(mananaDate).replace(',', '');

    // Foto de la lista ANTES de empezar a enviar: el bucle tarda ~300 ms por cliente y
    // si a media corrida entra un sync (que hace wisphubClients.clear()), recorrer el
    // Map vivo se cortaría en silencio y media lista se quedaría sin aviso.
    // Aquí mismo se saca de la lista a quien YA PAGÓ: ese no debe recibir nada.
    const candidatos = [];
    const enRevision = [];
    let alCorriente = 0, yaPagaron = 0, conProrroga = 0, conAutomatico = 0;
    for (const [phone, c] of wisphubClients.entries()) {
      const fc = parseFechaCorte(c.fechaCorte);
      if (!fc || fc !== manana) continue;
      if (!clienteDebe(c)) { alCorriente++; continue; }
      if (pagoRecienteDe(phone, fc)) { yaPagaron++; continue; }
      // Mandó comprobante y nadie lo ha revisado: el aviso lo ofende, y lo que urge es revisarlo hoy.
      if (comprobanteEnRevisionDe(phone)) { enRevision.push(c.name || phone); continue; }
      if (prorrogaVigente(phone)) { conProrroga++; continue; }
      // Con cobro automático, el cobro sale hoy mismo: "mañana te cortamos" sería un susto sin sentido.
      // Salvo que el cobro de este mes ya se haya intentado y NO haya pasado (tarjeta
      // rechazada, sin tarjeta): entonces el aviso sí le toca, o se corta sin saber.
      let autoFallo = '';
      if ((stripeClientes.get(phone) || {}).cobroAutomatico) {
        const per = ((autoCobros[phone] || {})[fc]) || {};
        if (per.estado !== 'rechazado' && per.estado !== 'sin-tarjeta') { conAutomatico++; continue; }
        autoFallo = per.estado;
      }
      candidatos.push([phone, c, fc, autoFallo]);
    }

    let sent = 0, failed = 0, yaEnviados = 0;
    for (const [phone, c, fc, autoFallo] of candidatos) {
      try {
        const key = `${phone}|${fc}`;
        if (corteReminders[key]) { yaEnviados++; continue; }
        const first = String(c.name || '').trim().split(/\s+/)[0] || 'cliente';
        const nombre = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
        const titular = tituloCase(c.name) || 'ti';
        const datos = { nombre, titular, fecha: bonita, plan: c.plan || '' };
        // Mensaje según la plantilla ACTIVA del panel (o la predeterminada).
        let msgCorte = renderCorteVars(activeCorteTemplate().text, datos);
        // Salvaguarda: si al sustituir las variables el mensaje queda vacío (p. ej. una
        // plantilla que es solo "{plan}" y el cliente no tiene plan), usamos la
        // predeterminada — WhatsApp rechaza un cuerpo de plantilla vacío.
        if (!msgCorte.replace(/\s+/g, ' ').trim()) msgCorte = renderCorteVars(CORTE_MSG_DEFAULT, datos);
        /*
         * A los del piloto se les dice que YA pueden pagar desde el teléfono.
         *
         * Sin esto nadie se entera de que la opción existe hasta que escribe
         * PAGAR por su cuenta, y la mayoría no escribe: paga como siempre o no
         * paga. El recordatorio de corte es el momento exacto en que tienen el
         * dinero en la cabeza. Solo a quien de verdad le va a salir la opción;
         * a los demás no se les promete nada.
         */
        if (autoFallo) {
          msgCorte = (msgCorte.trim() + (autoFallo === 'sin-tarjeta'
            ? ' ⚠️ Tu cobro automático de este mes no se hizo porque ya no hay una tarjeta guardada.'
            : ' ⚠️ Tu cobro automático de este mes no pasó: la tarjeta fue rechazada.')).slice(0, 900);
        }
        if (stripeLeon.permitido(phone, TELEFONO_PILOTO_STRIPE)) {
          msgCorte = (msgCorte.trim() + ' 💳 Ahora también puedes pagar desde tu teléfono, con tarjeta o en OXXO, sin ir a la oficina: responde PAGAR y te digo cómo.').slice(0, 1000);
        }
        await sendWhatsAppTemplate(phone, msgCorte);
        corteReminders[key] = new Date().toISOString();
        sent++;
        // Guardar de a poco DURANTE el envío, no solo al final: si el proceso se muere a
        // media corrida (Render se duerme, un redespliegue), lo ya enviado se quedaría
        // sin registrar y una corrida manual posterior lo REPETIRÍA — justo el incidente
        // de mensajes duplicados que ya vivimos. Así lo expuesto son 10 envíos, no todos.
        if (sent % 10 === 0) schedulePersist();
        await new Promise(r => setTimeout(r, 300)); // pausa para no saturar la API
      } catch (e) { failed++; }
    }
    /*
     * A quien le dimos prórroga no se le manda "mañana te cortamos", pero
     * tampoco se le deja vencer en silencio: el día antes de que se acabe se
     * le recuerda, con cómo pagar. Es una prórroga, no un olvido.
     */
    let prorrogaVence = 0;
    for (const [telP, p] of Object.entries(prorrogas)) {
      try {
        if (!p || p.hasta !== manana) continue;
        const c = wisphubClients.get(telP);
        if (!c || !clienteDebe(c) || pagoRecienteDe(telP)) continue;
        if ((stripeClientes.get(telP) || {}).cobroAutomatico) continue;   // a ese se le cobra solo un día antes de que venza
        const key = `${telP}|prorroga|${p.hasta}`;
        if (corteReminders[key]) continue;
        const first = String(c.name || '').trim().split(/\s+/)[0] || '';
        const nombre = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : 'cliente';
        const pagar = stripeLeon.permitido(telP, TELEFONO_PILOTO_STRIPE)
          ? ' Responde PAGAR y te digo cómo hacerlo desde tu teléfono (tarjeta, OXXO o transferencia), sin ir a la oficina.'
          : ' Puedes pagar en la oficina o por transferencia; responde PAGAR y te doy los datos.';
        await sendWhatsAppTemplate(telP, `Hola ${nombre}, te recordamos que mañana ${bonita} vence la prórroga que te dimos para pagar tu servicio de internet. Si ya pagaste, no hagas caso a este mensaje.${pagar}`);
        corteReminders[key] = new Date().toISOString();
        prorrogaVence++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) { failed++; }
    }
    // Limpieza: registros de hace más de 60 días
    const old = Date.now() - 60 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(corteReminders)) {
      if (new Date(v).getTime() < old) delete corteReminders[k];
    }
    schedulePersist();
    console.log(`[corte] Recordatorios para ${manana}: ${sent} enviados, ${yaEnviados} ya enviados antes, ${failed} fallidos, ${alCorriente} omitidos por estar al corriente, ${yaPagaron} porque ya pagaron por el bot, ${conProrroga} con prórroga (${prorrogaVence} avisados de que mañana vence), ${conAutomatico} con cobro automático`);
    // Que el filtro se coma a TODOS es señal de que el criterio "debe" no está leyendo lo
    // que creemos (ojo: en el criterio de finanzas "No Pagado" CONTIENE "pagad", así que
    // cuenta como al corriente; si Wisphub usa ese texto, el filtro se apoya solo en el
    // saldo). Falla hacia "no mandar", que es lo seguro, pero en silencio nadie se
    // enteraría hasta que un cliente reclamara que lo cortaron sin avisar.
    if (!candidatos.length && alCorriente) {
      alertAdmin('corte-filtro', `Hoy NINGÚN cliente pasó el filtro de deuda: los ${alCorriente} con corte el ${manana} salieron todos "al corriente". Revisa saldo y estado de facturas en el panel antes de dar ese cero por bueno.`);
    }
    if (enRevision.length) {
      alertAdmin('corte-en-revision', `📄 ${enRevision.length} cliente(s) con corte mañana mandaron comprobante y siguen SIN REVISAR: ${enRevision.slice(0, 8).join(', ')}${enRevision.length > 8 ? '…' : ''}. No se les mandó aviso de corte; revísalos hoy en el panel (Comprobantes por revisar) para que no se corten con el pago hecho.`);
    }
    registrarCorridaCorte({ fecha: today, ok: true, manana, sent, failed, yaEnviados, alCorriente, yaPagaron, enRevision: enRevision.length, conProrroga, prorrogaVence, conAutomatico, candidatos: candidatos.length, forzada: !!force });
    // Si AYER no quedó constancia, hubo gente que cortó sin recibir su aviso. Se avisa
    // SOLO el día siguiente al hueco (no los 7 días que el hueco sigue apareciendo en la
    // lista), para que la alerta signifique algo y no se vuelva ruido que nadie lee.
    const huecos = huecosCorte(7);
    if (huecos[0] === mexicoDateStr(new Date(Date.now() - 86400000))) {
      alertAdmin('corte-hueco', `Sin avisos de corte el/los día(s): ${huecos.join(', ')}. Revisa el despertador de GitHub Actions (parece que Render se durmió).`);
    }
    return { manana, sent, failed, yaEnviados, alCorriente, yaPagaron, enRevision: enRevision.length, conProrroga, prorrogaVence, conAutomatico };
  } catch (e) { console.error('[corte] sweep error:', e.message); return { error: e.message }; }
}

const MENU_LIST_ITEMS = [
  { id: '1', title: 'Ver planes de internet' },
  { id: '2', title: 'Cámaras de seguridad' },
  { id: '3', title: 'Soporte técnico' },
  { id: '4', title: 'Hablar con un asesor' },
  { id: '5', title: 'Migrar mi servicio' },
  { id: '6', title: 'Productos y accesorios' }
];

const CAMERA_KNOWLEDGE = `
Catálogo de cámaras León Telecom:

LÍNEA WI-FI TAPO (TP-Link) — para 1 a 3 cámaras:
• C210 (Interior): 2K, gira 360°, audio bidireccional. Para salas, recámaras, mascotas, cuidado de niños.
• C320WS (Exterior fija): 2K QHD, visión nocturna A COLOR, alarma con luz y sonido. Para fachadas, entradas.
• C500 (Exterior motorizada): 1080p, 360° con seguimiento automático de personas, IP65. Para patios, estacionamientos.
• C520WS (Exterior premium): 2K QHD, 360°, nocturna a color, seguimiento autos y personas. Máxima calidad.
Almacenamiento: tarjeta MicroSD o nube Tapo Care.

SISTEMAS PROFESIONALES HIKVISION / HILOOK (4+ cámaras o comercial/industrial):
• Analógico (DVR): cableado coaxial/UTP, más económico, no satura el Wi-Fi.
• IP/NVR (PoE): máxima resolución, analíticas avanzadas (detección de personas/vehículos).
• HiLook: línea económica de Hikvision, excelente calidad-precio para negocios medianos.
• Video grabado en disco duro oculto → seguro si dañan una cámara.
• Para Hikvision/HiLook: se agenda visita técnica GRATUITA para cotizar a medida.

REGLA DE ORO: 1-3 cámaras → Tapo Wi-Fi. 4+ cámaras o negocio → Hikvision/HiLook + visita técnica.
`;

// Camera product images served from the server
function getCameraImages(context) {
  if (!SERVER_BASE_URL) return [];
  const base = SERVER_BASE_URL + '/images/';
  const ctx = (context || '').toLowerCase();
  if (ctx.includes('hikvision') || ctx.includes('hilook') || ctx.includes('profesional') || ctx.includes('dvr') || ctx.includes('nvr')) {
    return [`${base}camarahiklookhikvision.jpeg`];
  }
  if (ctx.includes('exterior') || ctx.includes('patio') || ctx.includes('fachada') || ctx.includes('c500') || ctx.includes('c520') || ctx.includes('c320')) {
    return [`${base}camarawifi.jpeg`];
  }
  if (ctx.includes('tapo') || ctx.includes('wifi') || ctx.includes('interior') || ctx.includes('c210')) {
    return [`${base}tapoo2kcamera.jpeg`];
  }
  // Default: show wifi cameras
  return [`${base}camarawifi.jpeg`];
}

// ==================== PRODUCTOS / VITRINA ====================
// Productos en la vitrina de la oficina. Imágenes en public/images/products/.
const PRODUCT_IMG_BASE = (SERVER_BASE_URL ? `${SERVER_BASE_URL}` : '') + '/images/products/';
const DEFAULT_PRODUCTS = [
  { name: 'Roku Streaming Stick Plus 4K', price: '$720', img: 'ROkuplus4K.jpeg', cat: 'Streaming', kw: ['roku 4k', 'roku plus', 'streaming 4k', 'roku'] },
  { name: 'Roku Streaming Stick HD', price: '$680', img: 'RokuStickHD.jpeg', cat: 'Streaming', kw: ['roku hd', 'roku stick'] },
  { name: 'Extensor de rango Wi-Fi TP-Link N300', price: '$450', img: 'extensorderangowifitplink.jpeg', cat: 'Internet', kw: ['extensor', 'repetidor', 'amplificador wifi'] },
  { name: 'Adaptador USB Wi-Fi TP-Link AC600', price: '$220', img: 'adaptadorwifimini.jpeg', cat: 'Internet', kw: ['adaptador wifi', 'antena usb', 'antena wifi', 'usb wifi'] },
  { name: 'Tinta original HP GT52/GT53 (4 pzas)', price: '$750', img: 'tintaoriginalHP4pz.jpeg', cat: 'Cómputo', kw: ['tinta', 'tintas', 'cartucho', 'tinta hp', 'impresora'] },
  { name: 'Memoria USB ADATA 32GB (USB 3.2)', price: '$90', img: 'USB adata 32Gb.jpeg', cat: 'Cómputo', kw: ['memoria 32', 'usb 32', '32gb'] },
  { name: 'Memoria USB ADATA 64GB (USB 2.0)', price: '$140', img: 'UBS adata 64 Gb.jpeg', cat: 'Cómputo', kw: ['memoria 64', 'usb 64', '64gb'] },
  { name: 'Mouse inalámbrico UGREEN', price: '$190', img: 'mouseugreen.jpeg', cat: 'Cómputo', kw: ['mouse', 'raton'] },
  { name: 'Base enfriadora ACTECK (laptop 15")', price: '$180', img: 'baseenfriadoraacteck.jpeg', cat: 'Cómputo', kw: ['enfriadora', 'cooler', 'base laptop', 'base para laptop', 'ventilador laptop'] },
  { name: 'Soporte para TV 13"–42" (full motion)', price: '$400', img: 'soporteparatvde13pulgadashassta42pulgadas.jpeg', cat: 'TV', kw: ['soporte tv', 'soporte para tv', 'soporte de tv', 'rack tv', 'base tv'] },
  { name: 'Adaptador UGREEN USB-C a USB-A', price: '$150', img: 'AdapatadorUSBCaUSBA.jpeg', cat: 'Cables', kw: ['usb c a usb a', 'adaptador tipo c a usb'] },
  { name: 'Adaptador UGREEN USB-A a USB-C', price: '$175', img: 'adaptadorUSBAaUSBC.jpeg', cat: 'Cables', kw: ['usb a a usb c', 'adaptador usb a tipo c'] },
  { name: 'Cable UGREEN USB-C a Lightning (iPhone) 20W', price: '$280', img: 'cableligthningacugreen.jpeg', cat: 'Cables', kw: ['cable iphone', 'cable lightning', 'cargador iphone', 'lightning'] },
  { name: 'Cable HDMI Manhattan 4K 1.8m', price: '$80', img: 'cableshdmisuperspeed.jpeg', cat: 'Cables', kw: ['cable hdmi', 'hdmi 4k'] },
  { name: 'Cable UGREEN USB-C a USB-C 60W', price: '$150', img: 'cabletipocatipocugreen.jpeg', cat: 'Cables', kw: ['cable tipo c', 'cable usb c', 'cable type c', 'usb c', 'usb-c', 'tipo c', 'type c'] },
  { name: 'Convertidor Steren HDMI a RCA', price: '$320', img: 'convertidordeHDMIaRCAsteren.jpeg', cat: 'Cables', kw: ['convertidor hdmi', 'hdmi a rca', 'hdmi rca'] },
  { name: 'Reflector solar JWL 100W (2 pzas)', price: '$1,300', img: 'reflectorsolar100W.jpeg', cat: 'Iluminación', kw: ['reflector solar 100', 'reflector 100', 'reflector solar', 'reflector'] },
  { name: 'Reflector solar JWL 200W (2 pzas)', price: '$1,500', img: 'reflectorsolar.jpeg', cat: 'Iluminación', kw: ['reflector solar 200', 'reflector 200', 'reflector solar', 'reflector'] },
  { name: 'Tira LED JWL 5m (12V)', price: '$250', img: 'TIRALED5M.jpeg', cat: 'Iluminación', kw: ['tira led', 'tira de led', 'tiras led'] },
  { name: 'Luminario público JWL 150W LED (con fotocelda)', price: '$1,050', img: 'luminariopublico150W.jpeg', cat: 'Iluminación', kw: ['luminario', 'luminaria', 'lampara publica', 'alumbrado'] },
  { name: 'Espuma limpiadora SILIMEX SILIMPO 454ml', price: '$120', img: 'espumalimpiadoraslimpoo.jpeg', cat: 'Limpieza', kw: ['espuma', 'limpiador espuma'] }
];

// Lista VIVA de productos (editable desde el panel y persistida en la base).
// Arranca con DEFAULT_PRODUCTS como semilla; al hidratar se reemplaza si la base
// ya tiene productos guardados. La consumen el bot Y la página web (vía /api/products).
let products = DEFAULT_PRODUCTS.map((p, i) => ({
  id: 'seed' + (i + 1),
  showWeb: true, showBot: true, active: true,
  ...p
}));

// Normaliza un precio para que siempre muestre "$" al inicio.
function fmtPrice(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  return s.startsWith('$') ? s : ('$' + s);
}
// Convierte palabras clave (array o texto con comas) a array limpio en minúsculas.
function sanitizeKw(kw) {
  if (Array.isArray(kw)) return kw.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  return String(kw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function findProductById(id) { return products.find(p => p.id === id) || null; }
// Productos visibles para el BOT / para la WEB (activos + con su casilla marcada).
function getBotProducts() { return products.filter(p => p.active !== false && p.showBot !== false); }
function getWebProducts() { return products.filter(p => p.active !== false && p.showWeb !== false); }

// ====================================================================
// PLANES de internet (editables desde el panel, los pinta la web vía /api/plans)
// ====================================================================
const DEFAULT_PLANS = [
  // Fibra óptica · hogar
  { tipo: 'fibra', segmento: 'hogar', mbps: '30',  label: 'LITE',     price: '$289', features: ['Fibra Óptica Dedicada', 'Velocidad hasta 30 Mbps', 'Router Incluido', 'Soporte 24/7'], badge: '' },
  { tipo: 'fibra', segmento: 'hogar', mbps: '80',  label: 'BÁSICO',   price: '$320', features: ['Fibra Óptica Dedicada', 'Velocidad hasta 80 Mbps', 'Router Premium', 'Soporte Prioritario'], badge: '' },
  { tipo: 'fibra', segmento: 'hogar', mbps: '150', label: 'MEDIO',    price: '$440', features: ['Fibra Óptica Dedicada', 'Velocidad hasta 150 Mbps', 'Router Premium', 'Soporte VIP'], badge: 'Recomendado' },
  { tipo: 'fibra', segmento: 'hogar', mbps: '200', label: 'AVANZADO', price: '$560', features: ['Fibra Óptica Dedicada', 'Velocidad hasta 200 Mbps', 'Router Premium', 'Soporte Premium'], badge: '' },
  { tipo: 'fibra', segmento: 'hogar', mbps: '300', label: 'ULTRA',    price: '$680', features: ['Fibra Óptica Dedicada', 'Velocidad hasta 300 Mbps', 'Router Premium', 'Soporte Dedicado'], badge: 'Ultra' },
  // Inalámbrico · hogar
  { tipo: 'inalambrico', segmento: 'hogar', mbps: '15', label: 'Internet Inalámbrico', price: '$290', features: ['Internet Ilimitado', 'Con Antena', 'Velocidad hasta 15 Mbps', 'Soporte 24/7'], badge: '' },
  { tipo: 'inalambrico', segmento: 'hogar', mbps: '20', label: 'Internet Inalámbrico', price: '$340', features: ['Internet Ilimitado', 'Con Antena', 'Velocidad hasta 20 Mbps', 'Soporte Prioritario'], badge: 'Popular' },
  { tipo: 'inalambrico', segmento: 'hogar', mbps: '30', label: 'Internet Inalámbrico', price: '$440', features: ['Internet Ilimitado', 'Con Antena', 'Velocidad hasta 30 Mbps', 'Soporte VIP'], badge: '' }
];
// Lista VIVA de planes (semilla DEFAULT_PLANS; se reemplaza al hidratar si la base ya tiene).
let plans = DEFAULT_PLANS.map((p, i) => ({ id: 'planseed' + (i + 1), active: true, order: i, period: '/mes', ...p }));
function findPlanById(id) { return plans.find(p => p.id === id) || null; }
function getWebPlans() { return plans.filter(p => p.active !== false).slice().sort((a, b) => (a.order || 0) - (b.order || 0)); }

// UNA SOLA FUENTE DE PRECIOS: copia los precios de los planes EDITABLES del panel
// a las listas que el bot usa para cotizar (empareja por Mbps). Si un plan no está
// en el panel, conserva su precio actual. Solo sincroniza PRECIOS (no agrega/quita
// niveles). Se llama al arrancar y cada vez que se editan los planes en el panel.
function syncHardcodedPlanPrices() {
  try {
    const web = getWebPlans();
    const apply = (arr, tipo) => {
      for (const p of arr) {
        const mbps = parseInt(String(p.speed), 10);
        // Solo planes de HOGAR (los que cotiza el bot); ignora los de 'negocio' para
        // que un plan empresarial del mismo Mbps no pise el precio residencial.
        const src = web.find(w => (w.tipo === tipo) && ((w.segmento || 'hogar') === 'hogar') && parseInt(String(w.mbps), 10) === mbps);
        if (src && src.price) p.price = `${src.price}${src.period || '/mes'}`;
      }
    };
    apply(FIBER_PLANS, 'fibra');
    apply(WIRELESS_PLANS, 'inalambrico');
  } catch (e) { console.error('[planes] sync de precios:', e.message); }
}
function sanitizeFeatures(f) {
  const arr = Array.isArray(f) ? f : String(f || '').split('\n');
  return arr.map(s => String(s).trim()).filter(Boolean).slice(0, 8);
}
// Arma el link de WhatsApp para contratar un plan (igual estilo que la web).
function planWaLink(p) {
  const tipoTxt = p.tipo === 'inalambrico'
    ? 'Internet Inalámbrico'
    : ('Fibra Óptica' + (p.label && p.label !== 'Internet Inalámbrico' ? ' ' + p.label : ''));
  const msg = `Hola 👋, vi el plan ${tipoTxt} de ${p.mbps} Mbps (${fmtPrice(p.price)}/mes) en su página web y me gustaría contratarlo. ¿Me ayudan?`;
  return 'https://wa.me/529512172814?text=' + encodeURIComponent(msg);
}

// URL de imagen: si ya es una URL completa (imagen subida), úsala tal cual;
// si es solo el nombre de archivo (productos semilla), apunta a /images/products/.
function getProductImageUrl(p) {
  const img = String(p.img || '');
  if (/^https?:\/\//i.test(img)) return img;
  // ?v=2 = cache-buster: al cambiar las fotos, el navegador y WhatsApp bajan la nueva.
  return PRODUCT_IMG_BASE + encodeURIComponent(img) + '?v=6';
}

function isProductRequest(text) {
  const v = normalizeText(text);
  return /\b(producto|productos|accesorio|accesorios|que venden|que mas venden|que mas tienen|que tienen en la oficina|vitrina|articulos|en oferta|ofertas)\b/.test(v);
}

function findProducts(text) {
  const v = normalizeText(text);
  return getBotProducts().filter(p => (p.kw || []).some(k => v.includes(k)));
}

// ¿El cliente está cerrando la conversación? (para el destacado de producto)
function isClosing(text) {
  const v = normalizeText(text);
  if (/\?|cuant|como |cual|donde|precio|plan|mbps|instala/.test(v)) return false;
  return /\b(gracias|muchas gracias|ok gracias|listo gracias|eso es todo|es todo|nada mas|ya no|por ahora no|adios|hasta luego|bye|sale gracias|de acuerdo gracias|esta bien gracias)\b/.test(v);
}

// ¿El texto parece un nombre propio (y NO una pregunta o una intención)?
// Evita que "¿qué planes tienes?" se guarde como el nombre del cliente.
function looksLikeName(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  if (/[?¿]/.test(t)) return false;
  if (/\d{4,}/.test(t)) return false;
  const v = normalizeText(t);
  if (/\b(plan|planes|precio|precios|costo|costos|cuanto|cuant|que|como|cual|donde|cuando|producto|productos|accesorio|internet|camara|camaras|wifi|megas|mbps|tienes|tienen|hay|info|informacion|reflector|roku|cable|usb|mouse|tinta|soporte|cotiz|instala|paquete|telefono|numero)\b/.test(v)) return false;
  return true;
}

// Devuelve el nombre del cliente SOLO si es válido. Protege contra nombres
// corruptos ya guardados en el perfil (ej. una pregunta guardada como nombre).
function nameOf(profile, fallback = null) {
  const n = profile && profile.name;
  return (n && n !== 'Usuario' && looksLikeName(n)) ? n : fallback;
}

// ¿El cliente quiere CONTRATAR internet / un plan? (sin confundir con una falla)
function wantsInternet(text) {
  const v = normalizeText(text);
  if (isTechnicalIssue(text)) return false;
  if (/\b(no tengo|sin internet|se cayo|se fue|no hay|no sirve|no funciona|no jala|no agarra|lento|lenta)\b/.test(v)) return false;
  if (/\b(quiero|necesito|me interesa|contratar|instalar|dar de alta|poner|adquirir|info de|informacion de)\b/.test(v) &&
      /\b(internet|servicio|wifi|plan|planes|paquete|fibra|inalambric|megas|promo|promocion)\b/.test(v)) return true;
  // Interés "a secas" (p. ej. responder "me interesa" a una promo de internet) → lo tomamos como interés en internet.
  if (/^(s[ií]\s+|claro\s+|simon\s+|sip?\s+)?(me\s+)?interesa(\s+la\s+promo(cion)?)?[\s.!]*$/.test(v.trim()) ||
      /^interesad[oa][\s.!]*$/.test(v.trim()) ||
      /^(mas|quiero)\s+info(rmacion)?[\s.!]*$/.test(v.trim())) return true;
  return isPlanRequest(text);
}

// Producto destacado AL AZAR, evitando repetir el último que se mostró.
// (Antes usaba un contador que se reiniciaba a 0 en cada reinicio del server,
//  por lo que siempre salía el primer producto. El azar garantiza variedad.)
let _lastPromoId = null;
function nextPromoProduct() {
  const list = getBotProducts();
  if (!list.length) return null;
  if (list.length === 1) { _lastPromoId = list[0].id; return list[0]; }
  let pick, guard = 0;
  do {
    pick = list[Math.floor(Math.random() * list.length)];
    guard++;
  } while (pick.id === _lastPromoId && guard < 12);
  _lastPromoId = pick.id;
  return pick;
}

// Destacado de producto al cerrar el chat (rotando entre el catálogo).
async function sendProductHighlight(chatId, sendMsg) {
  const p = nextPromoProduct();
  if (!p) return;
  await sendMsg(chatId,
    `Por cierto 👀 en nuestra oficina también vendemos:\n🛍️ *${p.name}*\n¿Te interesa? Escribe *productos* para ver más.\n\n🛒 Y en nuestra *tienda en línea* encuentras mucho más (cámaras, redes, control de acceso, cableado y más):\n${STORE_URL}`,
    [getProductImageUrl(p)]
  );
}

function buildProductListText() {
  const list = getBotProducts();
  if (!list.length) return '🛍️ Por ahora no tenemos productos en vitrina. Pregúntame por internet o cámaras y con gusto te ayudo. 😊';
  const cats = {};
  for (const p of list) { (cats[p.cat] = cats[p.cat] || []).push(`• ${p.name} — ${fmtPrice(p.price)}`); }
  // Orden preferido + cualquier categoría nueva al final (para que nada se pierda).
  const preferred = ['Streaming', 'Internet', 'TV', 'Cables', 'Cómputo', 'Iluminación', 'Limpieza'];
  const order = [...preferred.filter(c => cats[c]), ...Object.keys(cats).filter(c => !preferred.includes(c))];
  const lines = ['🛍️ *Productos y accesorios en nuestra oficina:*', ''];
  for (const c of order) { lines.push(`*${c}*`, ...cats[c], ''); }
  lines.push('Escríbeme el nombre del que te interese y te mando foto. 😊');
  lines.push('');
  lines.push(`🛒 ¿Buscas *más*? Visita nuestra *tienda en línea* — cámaras, redes, control de acceso, alarmas y más:\n${STORE_URL}`);
  return lines.join('\n');
}

// Saludo + menú (determinista, sin IA) — corto: solo el saludo y las opciones.
async function sendWelcomeMenu(chatId, sendMsg) {
  setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
  // Reconoce al cliente por su número en Wisphub → saludo con su nombre y plan.
  const w = wisphubClients.get(String(chatId));
  let saludo;
  if (w && w.name) {
    const first = w.name.trim().split(/\s+/)[0] || '';
    const nombre = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
    saludo = `👋 ¡Hola de nuevo, ${nombre}!`;
  } else {
    const knownName = nameOf(getProfile(chatId));
    saludo = knownName ? `👋 ¡Hola de nuevo, ${knownName}!` : '👋 ¡Hola! Soy Leo, de León Telecom.';
  }
  await sendMsg(chatId, [
    `${saludo} ¿En qué te ayudo?`,
    '',
    '1️⃣ Ver planes de internet',
    '2️⃣ Cámaras de seguridad',
    '3️⃣ Soporte técnico',
    '4️⃣ Hablar con un asesor',
    ...(promoAgostoActiva() ? [] : ['5️⃣ Migrar mi servicio']),
    '6️⃣ Productos y accesorios 🛍️'
  ].join('\n'));
}

// ==================== MÉTRICAS LIGERAS ====================
// Se persisten en state.stats. productHits: cuántas veces se mostró cada producto
// porque el cliente lo pidió. daily: conversaciones únicas por día (clave YYYY-MM-DD).
let stats = { productHits: {}, daily: {} };
// Banners de promoción editables que se muestran en la web (vía /api/promo).
// Lista; solo uno puede estar activo a la vez (es el que ve la web).
let promoBanners = [];
function activePromo() { return promoBanners.find(b => b.active) || null; }
function mxDayKey(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }); // YYYY-MM-DD
}
function trackProductHit(id) {
  if (!id) return;
  stats.productHits[id] = (stats.productHits[id] || 0) + 1;
  schedulePersist();
}
function trackConversation(chatId) {
  const day = mxDayKey();
  const prof = getProfile(chatId);
  if (prof && prof.lastConvDay === day) return; // ya se contó este chat hoy
  stats.daily[day] = (stats.daily[day] || 0) + 1;
  updateProfile(chatId, { lastConvDay: day });
  schedulePersist();
}

// ==================== PROMO POR INACTIVIDAD ====================
// Si el cliente deja de responder unos minutos, le mandamos UN producto destacado
// (dentro de la ventana de 24h de WhatsApp, así no requiere plantilla).
const promoTracker = new Map(); // chatId → { lastMsg, lastPromoAt, eligible }
const PROMO_IDLE_MIN = 10;                  // minutos de inactividad para enviar
const PROMO_IDLE_MAX_MIN = 120;             // si pasaron más de 2h, ya no (se siente fuera de lugar)
const PROMO_COOLDOWN_MS = 6 * 3600 * 1000;  // máx. un promo de inactividad cada 6h por cliente

function markClientActivity(chatId) {
  const id = String(chatId);
  const pt = promoTracker.get(id) || { lastPromoAt: 0 };
  pt.lastMsg = Date.now();
  pt.eligible = true;
  promoTracker.set(id, pt);
}

function markPromoSent(chatId) {
  const id = String(chatId);
  const pt = promoTracker.get(id) || {};
  pt.lastPromoAt = Date.now();
  pt.eligible = false;
  promoTracker.set(id, pt);
}

async function sweepIdlePromos() {
  if (promoTracker.size === 0) return;
  const now = Date.now();
  for (const [chatId, pt] of [...promoTracker.entries()]) {
    if (!pt.eligible) continue;
    const idleMin = (now - (pt.lastMsg || 0)) / 60000;
    if (idleMin < PROMO_IDLE_MIN || idleMin > PROMO_IDLE_MAX_MIN) continue;
    if (now - (pt.lastPromoAt || 0) < PROMO_COOLDOWN_MS) { pt.eligible = false; continue; }
    if (isPaused(chatId)) continue;                 // un asesor está atendiendo
    const s = getSession(chatId);
    if (s && s.state && s.state !== 'awaiting_menu_choice') continue; // está a medio flujo
    try {
      await sendProductHighlight(chatId, sendWhatsAppMessage);
      markPromoSent(chatId);
    } catch (e) { pt.eligible = false; }
  }
}

// Arma la línea de ubicación a partir de la colonia detectada y/o la zona del perfil.
function resolveEmergencyLocation(text, profile) {
  const nbhd = searchAllNeighborhoods(text);
  const zoneFromText = detectLocation(text);
  const profileZone = profile?.location || '';
  if (nbhd) {
    return { line: [nbhd.name, nbhd.zone].filter(Boolean).join(', '), zone: nbhd.zone, have: true };
  }
  if (zoneFromText) return { line: zoneFromText, zone: zoneFromText, have: true };
  if (profileZone) return { line: profileZone, zone: profileZone, have: true };
  return { line: 'no especificada', zone: '', have: false };
}

// Reporte de emergencia / falla urgente → avisar al técnico DE INMEDIATO,
// usando la info que ya venga en el mensaje (sin preguntas de más).
async function handleEmergency(chatId, text, sendMsg) {
  const profile = getProfile(chatId);
  const knownName = nameOf(profile);
  const ubic = resolveEmergencyLocation(text, profile);

  await notifyAgentRequest(chatId, [
    '🚨 EMERGENCIA / FALLA URGENTE',
    knownName ? `Cliente: ${knownName}` : '',
    `Reporte: ${text}`,
    `Ubicación: ${ubic.line}`
  ].filter(Boolean).join('\n'), ubic.zone, { urgent: true }).catch(() => {});

  if (ubic.have) {
    clearSession(chatId);
    await sendMsg(chatId,
      `🚨 Gracias por avisar${knownName ? ', ' + knownName : ''}. Ya reporté esto como URGENTE a nuestro equipo técnico (ubicación: ${ubic.line}) y lo revisarán con prioridad. Si hay fuego o riesgo para las personas, aléjate y llama al 911.`
    );
  } else {
    setSession(chatId, { state: 'awaiting_emergency_location', data: { description: text } });
    await sendMsg(chatId,
      `🚨 Gracias por avisar${knownName ? ', ' + knownName : ''}. Ya estoy alertando a nuestro equipo técnico. Para que lleguen rápido, dime la sección/colonia y alguna referencia (calle o casa cercana).`
    );
  }
}

// Segundo paso: el cliente respondió con la ubicación de la emergencia.
async function finishEmergencyWithLocation(chatId, text, data, sendMsg) {
  const profile = getProfile(chatId);
  const knownName = nameOf(profile);
  const nbhd = searchAllNeighborhoods(text);
  const zone = (nbhd && nbhd.zone) || detectLocation(text) || profile?.location || '';
  const locationLine = nbhd ? [nbhd.name, nbhd.zone].filter(Boolean).join(', ') : (text.trim() || zone || 'no especificada');

  await notifyAgentRequest(chatId, [
    '🚨 EMERGENCIA / FALLA URGENTE (ubicación)',
    knownName ? `Cliente: ${knownName}` : '',
    `Reporte: ${data?.description || ''}`,
    `Ubicación/referencia: ${locationLine}`
  ].filter(Boolean).join('\n'), zone, { urgent: true }).catch(() => {});

  clearSession(chatId);
  await sendMsg(chatId, `Listo${knownName ? ', ' + knownName : ''}. Pasé la ubicación a nuestro equipo técnico para que acudan con prioridad. Gracias por reportarlo.`);
}

// Inicia el flujo de reporte cuando el cliente YA describió la falla (en "text").
// Da un tip, captura el problema y pide solo la ubicación — sin re-preguntar el síntoma.
async function startReportFlow(chatId, text, sendMsg) {
  await sendMsg(chatId, 'Entendido. 🔧 Tip rápido: reinicia tu módem ~2 minutos. Si sigue igual, lo revisamos.');
  const nbhd = searchAllNeighborhoods(text);
  const knownName = nameOf(getProfile(chatId));
  if (nbhd) {
    setSession(chatId, { state: 'awaiting_neighborhood_confirm', data: { problemDescription: text, detectedNeighborhood: nbhd.name, detectedZone: nbhd.zone } });
    await sendMsg(chatId, `¿La ubicación es ${nbhd.name}, ${nbhd.zone}?`, [], { buttons: [{ id: 'si_ubicacion', title: 'Sí, es ahí' }, { id: 'no_ubicacion', title: 'No, es otra' }] });
  } else {
    setSession(chatId, { state: 'awaiting_report_location', data: { problemDescription: text, knownName } });
    await sendMsg(chatId, '¿En qué colonia o barrio es y cuáles son las referencias del domicilio? (ej: Colonia Centro, casa azul frente a la cancha)');
  }
}

// A quién se le acaba de ofrecer el cobro automático ("¿Lo activamos?"): un
// "sí" o "no" escritos en la media hora siguiente son la respuesta a eso.
const autoOfrecido = new Map();   // chatId -> ts

// Frases que NO son la respuesta a "¿cuál vas a pagar?" aunque lleguen en ese paso.
function _pideDatosPagoTemprano(pt) {
  return /^(pagar|menu|men[uú]|hola|buen|salir|cancelar|otro|a nombre de)/.test(String(pt || ''));
}

async function handleChatMessage(chatId, text, sendMsg) {
  try {
    // Anti-flood: si UN número manda demasiados mensajes en poco tiempo, ignoramos el
    // exceso (protege al bot de saturación). No aplica a los asesores.
    if (!isAgentNumber(String(chatId)) && isFlooding(chatId)) { console.warn(`[rate-limit] exceso de mensajes de ${chatId}, ignorado`); return; }
    // ---- Comprobante (imagen) / Documento (PDF): confirmación, corrección o titular ----
    const _pendKey = String(chatId);
    const _pt = String(text || '').toLowerCase().trim();
    const _btnSi = _pt === 'comprobante_si';
    const _btnNo = _pt === 'comprobante_no';
    const _btnDocNo = _pt === 'doc_no';
    const _isBtn = _btnSi || _btnNo || _btnDocNo;
    // Una EMERGENCIA siempre tiene prioridad: jamás la consumimos como confirmación/nombre.
    const _emergencyNow = !_isBtn && isEmergency(text);

    // ===== Botones del recordatorio de corte (horario en oficina / datos de pago) =====
    // Respuesta a "¿ya quedó tu servicio?" de un reporte de falla.
    let _tkResp = _pt.match(/^tk_(si|no)_(tk[a-z0-9]+)$/);
    if (!_tkResp) {
      // Un "sí" o "no" pelón, si hay un reporte suyo con la pregunta hecha y sin contestar.
      const esSi = /^(s[ií]|ya qued[oó]|ya|listo|ya funciona|ya sirve)[\s.!]*$/.test(_pt);
      const esNo = /^(no|sigue igual|todav[ií]a no|a[uú]n no|no sirve|sigue sin)[\s.!]*$/.test(_pt);
      if (esSi || esNo) {
        // Solo cuenta como respuesta a la pregunta si la pregunta fue hace menos de 2 días:
        // un "sí" suelto una semana después es de otra conversación.
        const hace2d = Date.now() - 2 * 24 * 3600 * 1000;
        const t = [...tickets.values()].filter((x) => String(x.chatId) === String(chatId) && x.preguntadoEn && !x.contestadoEn && x.estado !== 'resuelto' && new Date(x.preguntadoEn).getTime() >= hace2d)
          .sort((a, b) => new Date(b.preguntadoEn) - new Date(a.preguntadoEn))[0];
        if (t) _tkResp = [null, esSi ? 'si' : 'no', t.id];
      }
    }
    if (_tkResp) {
      const t = tickets.get(_tkResp[2]);
      if (!t || String(t.chatId) !== String(chatId)) { await sendMsg(chatId, 'Ese reporte ya no está. Si sigues con la falla, escríbeme qué pasa y levanto uno nuevo.'); return; }
      t.contestadoEn = new Date().toISOString();
      t.updatedAt = new Date().toISOString();
      if (_tkResp[1] === 'si') {
        t.estado = 'resuelto'; t.cerradoPor = 'cliente'; schedulePersist();
        await sendMsg(chatId, `¡Qué bueno! Cierro tu reporte ${t.folio}. Si vuelve a fallar, escríbeme y lo abrimos de nuevo. 🙌`);
      } else {
        t.estado = 'abierto'; t.sigueIgual = (t.sigueIgual || 0) + 1; schedulePersist();
        await sendMsg(chatId, `Lo siento. Le aviso al asesor que tu reporte ${t.folio} sigue sin resolverse para que lo atiendan con prioridad. 🙏`);
        alertAdmin('ticket-sigue', `⚠️ El reporte ${t.folio} de ${t.name || chatId} (${String(t.problema || '').slice(0, 60)}) sigue SIN resolverse después de ${TICKET_DIAS_PREGUNTA} días: el cliente lo confirmó.`);
      }
      return;
    }

    if (_pt === 'pago_horario') {
      await sendMsg(chatId, buildBusinessHoursMessage() + '\n\n🏢 En oficina puedes pagar en *efectivo* o con *tarjeta* (presencial). ¡Te esperamos!');
      return;
    }
    if (_pt === 'pago_datos') {
      const img = SERVER_BASE_URL ? [`${SERVER_BASE_URL}/images/metodosdepago.jpeg`] : [];
      await sendMsg(chatId, '💳 Estos son nuestros *datos de pago vigentes* (depósito o transferencia):', img);
      await sendMsg(chatId, 'Cuando realices tu pago, mándanos tu *comprobante* (foto o PDF) por aquí y lo registramos. 🙌');
      return;
    }
    // MAQUETA: pagar con tarjeta/OXXO por Stripe, sin mandar comprobante. Repite
    // el candado del número piloto por si alguien manda el id del botón a mano.
    /*
     * ── TARJETA U OXXO: PRIMERO CUÁL, DESPUÉS EL LINK ───────────────────────
     *
     * Antes este botón entregaba un solo link donde el cliente elegía adentro
     * de Stripe. Ya no se puede: OXXO cuesta más que la tarjeta y cada uno
     * tiene su tarifa, así que si eligiera adentro le habríamos cobrado el
     * cargo de la otra forma. Se le pregunta aquí, con los dos precios a la
     * vista, y el link ya sale amarrado a lo que escogió.
     */
    if (_pt === 'pago_tarjeta') {
      if (!stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
        await sendMsg(chatId, 'Esa opción todavía no está disponible para tu cuenta. Usa depósito/transferencia y manda tu comprobante como de costumbre. 🙌');
        return;
      }
      try {
        if (await preguntarContratoSiHayVarios(chatId, sendMsg, 'pago_tarjeta')) return;
        const ajena = cuentaAjena(chatId);
        const servicio = servicioEnSesion(chatId);
        const cobro = await montoACobrar(chatId, ajena, servicio);
        if (!cobro.ok) { await sendMsg(chatId, cobro.mensaje); return; }

        const t = stripeLeon.calcularCargo(cobro.monto, 'tarjeta');
        const o = stripeLeon.calcularCargo(cobro.monto, 'oxxo');
        const deQuien = ajena
          ? `La mensualidad de *${(wisphubClients.get(ajena) || {}).name || 'esa cuenta'}* es de`
          : 'Tu mensualidad es de';
        await sendMsg(chatId,
          `${deQuien} *$${cobro.monto.toFixed(2)}*${cobro.deTexto}. ¿Cómo prefieres pagarla?\n\n`
          + `💳 *Con tarjeta* — total $${(t.totalCentavos / 100).toFixed(2)}\n`
          + `   (cargo por pagar en línea: $${(t.cargoCentavos / 100).toFixed(2)})\n\n`
          + `🏪 *En efectivo en OXXO* — total $${(o.totalCentavos / 100).toFixed(2)}\n`
          + `   (cargo por pagar en línea: $${(o.cargoCentavos / 100).toFixed(2)})\n\n`
          + `Cuesta un poco más en OXXO porque la tienda cobra por recibir el efectivo.`
          + (mesesEnSesion(chatId) > 1 ? ' Si solo quieres pagar un mes, escribe *1 mes*.' : ''),
          [], { buttons: [
            { id: 'pago_con_tarjeta', title: '💳 Con tarjeta' },
            { id: 'pago_con_oxxo', title: '🏪 Efectivo OXXO' },
          ] });
      } catch (e) {
        console.error('[stripe-leon] cotizando tarjeta/OXXO:', e.message);
        await sendMsg(chatId, 'No pude consultar tu cuenta ahorita. Intenta de nuevo en un rato, o paga como siempre por depósito/transferencia. 🙏');
      }
      return;
    }

    if (_pt === 'pago_con_tarjeta' || _pt === 'pago_con_oxxo') {
      if (!stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
        await sendMsg(chatId, 'Esa opción todavía no está disponible para tu cuenta. Usa depósito/transferencia y manda tu comprobante como de costumbre. 🙌');
        return;
      }
      const forma = _pt === 'pago_con_oxxo' ? 'oxxo' : 'tarjeta';
      try {
        if (await preguntarContratoSiHayVarios(chatId, sendMsg, _pt)) return;
        /*
         * ¿Para quién es el pago? Para quien escribe, salvo que antes haya
         * dicho que va a pagar la cuenta de alguien más. En ese caso el link
         * lleva la cuenta del otro y quien escribe solo pone la tarjeta: al
         * confirmarse, se reactiva el servicio del dueño y se les avisa a los
         * dos.
         */
        const paraOtro = cuentaAjena(chatId);
        const telCuenta = paraOtro || normalizePhone(chatId);
        const c = wisphubClients.get(telCuenta) || {};
        const servicio = servicioEnSesion(chatId);
        const cobro = await montoACobrar(chatId, telCuenta, servicio);
        if (!cobro.ok) { await sendMsg(chatId, cobro.mensaje); return; }

        const pago = await stripeLeon.generarLinkPago({
          telefono: telCuenta, monto: cobro.monto, nombre: c.name,
          urlBase: SERVER_BASE_URL, forma,
          pagadoPor: paraOtro ? normalizePhone(chatId) : undefined,
          // Con esto el webhook abona y reactiva ESE contrato, sin adivinar.
          servicioId: servicio ? servicio.servicioId : undefined,
          meses: mesesEnSesion(chatId),
          cubreHasta: cobro.cubreHasta || undefined,
        });
        if (paraOtro) clearSession(chatId);

        // Cuando paga por otro, el servicio que se reactiva no es el suyo.
        const suServicio = paraOtro ? `el servicio de *${c.name || telCuenta}*` : 'tu servicio';
        const cabeza = forma === 'oxxo'
          ? (paraOtro ? '🏪 Aquí sale la ficha para pagar en OXXO:' : '🏪 Aquí sale tu ficha para pagar en OXXO:')
          : '💳 Aquí puedes pagar con tu tarjeta, sin salir de tu casa:';
        // Si el corte es hoy o mañana (o ya está suspendido), OXXO puede llegar tarde: que lo sepa antes de ir a la tienda.
        const corteCuenta = parseFechaCorte((servicio && servicio.fechaCorte) || c.fechaCorte);
        const urge = /suspend|cort/i.test(String((servicio && servicio.estado) || c.status || '')) || (corteCuenta && corteCuenta <= fechaMasDias(1));
        const cola = forma === 'oxxo'
          ? '\n\nAbre el link y te da la ficha con el código de barras. Llévala a cualquier OXXO y págala en caja.\n\n'
            + '⏱️ Tienes 30 minutos para abrir el link, pero la *ficha te dura varios días*.\n\n'
            + `Cuando la tienda reporte el pago te avisamos por aquí y ${suServicio} se reactiva solo. Puede tardar unas horas. *No mandes comprobante*, nosotros lo vemos.`
            + (urge ? `\n\n⚠️ Ojo: OXXO puede tardar hasta un día en reportar el pago. Si te urge que ${suServicio} quede activo hoy, con *tarjeta* o *transferencia* se reactiva al momento.` : '')
          : `\n\nEn cuanto se confirme te avisamos por aquí y ${suServicio} se reactiva solo — no hace falta comprobante.\n\n`
            + '⏱️ Tienes 30 minutos para abrir el link.';

        await sendMsg(chatId,
          `${cabeza}\n\n`
          + (paraOtro ? `• Cuenta de: *${c.name || telCuenta}*\n` : '')
          + (servicio && servicio.etiqueta ? `• Servicio: ${servicio.etiqueta}\n` : '')
          + `• Mensualidad: $${pago.mensualidad.toFixed(2)}${cobro.deTexto}\n`
          + `• Cargo por pagar en línea: $${pago.cargo.toFixed(2)}\n`
          + `• *Total: $${pago.total.toFixed(2)}*\n\n`
          + `${pago.url}`
          + cola
          + `\n\n⚠️ No pagues además por otra vía: se te cobraría dos veces.\n\n`
          + `Si prefieres pagar como siempre, por depósito o transferencia directa, sigue siendo gratis: solo mándanos tu comprobante. 🙌`
          + (forma === 'tarjeta' && !paraOtro && !(stripeClientes.get(telCuenta) || {}).cobroAutomatico ? '\n\n🔁 ¿Quieres que cada mes se cobre solo a tu tarjeta y nunca se corte? Escribe *AUTOMÁTICO*.' : ''));
      } catch (e) {
        console.error('[stripe-leon] generando link de', forma, ':', e.message);
        /*
         * "Intenta en un rato" solo sirve si en un rato va a funcionar. Si lo
         * que falta es la cuenta de León, el siguiente intento falla igual y el
         * cliente se estrella dos veces. Ahí se le manda directo a la vía que
         * sí funciona, sin prometerle nada.
         */
        const esDeLaCuenta = /cuenta|aprobada/i.test(e.message || '');
        if (esDeLaCuenta) {
          console.error('[stripe-leon] ¡LA CUENTA DE LEÓN NO ESTÁ LISTA! Se le ofreció pagar en línea a un cliente y no se pudo.');
          await sendMsg(chatId, 'El pago en línea no está disponible en este momento. Paga como siempre, por depósito o transferencia, y mándanos tu comprobante. 🙏');
        } else {
          await sendMsg(chatId, 'No pude generar el link de pago ahorita. Intenta de nuevo en un rato, o paga como siempre por depósito/transferencia. 🙏');
        }
      }
      return;
    }
    /*
     * "Otras formas": horario y datos de pago juntos.
     *
     * Existe porque con el cobro en línea encendido ya no caben cuatro botones.
     * Nada se pierde: lo que antes eran dos opciones aquí es una sola respuesta
     * con las dos cosas.
     */
    if (_pt === 'pago_otras') {
      await sendMsg(chatId, buildBusinessHoursMessage() + '\n\n🏢 En oficina puedes pagar en *efectivo* o con *tarjeta* (presencial). ¡Te esperamos!');
      const imgOtras = SERVER_BASE_URL ? [`${SERVER_BASE_URL}/images/metodosdepago.jpeg`] : [];
      await sendMsg(chatId, '💳 Y estos son nuestros *datos de pago vigentes* (depósito o transferencia):', imgOtras);
      await sendMsg(chatId, 'Si pagas por aquí, mándanos tu *comprobante* (foto o PDF) y lo registramos. 🙌');
      return;
    }
    /*
     * La CLABE fija del cliente.
     *
     * A diferencia del link —que vence en 32 minutos— esta cuenta es suya para
     * siempre: la anota una vez en su banco y cada mes deposita ahí. Es la
     * opción que de verdad le sirve a quien paga en ventanilla o por
     * transferencia desde su app, que es como paga casi todo el pueblo.
     */
    if (_pt === 'pago_clabe') {
      if (!stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
        await sendMsg(chatId, 'Esa opción todavía no está disponible para tu cuenta. Usa depósito/transferencia y manda tu comprobante como de costumbre. 🙌');
        return;
      }
      try {
        // La CLABE es de la cuenta que se está pagando (la propia o la de otro)
        // y, si esa cuenta tiene varios contratos, del contrato elegido.
        const ajenaClabe = cuentaAjena(chatId);
        const tel = ajenaClabe || normalizePhone(chatId);
        const c = wisphubClients.get(tel);
        const servicioClabe = servicioEnSesion(chatId);

        /*
         * Solo a clientes de verdad.
         *
         * Antes bastaba con escribirle "pagar" al bot: con la lista abierta a
         * todos, cualquiera obtenía una cuenta bancaria permanente y podía
         * transferirle dinero a León Telecom que no se puede aplicar a ningún
         * servicio. Ese dinero entra, no tiene dueño, y alguien tiene que
         * devolverlo a mano.
         *
         * Si la lista de Wisphub está vacía —arrancó con Wisphub caído— se
         * prefiere no entregar nada: es mejor un "ahorita no puedo" que una
         * cuenta suelta.
         */
        if (!c || !c.name) {
          await sendMsg(chatId, !wisphubClients.size
            ? 'Ahorita no puedo consultar tu cuenta. Intenta en un rato, o paga como siempre por depósito/transferencia. 🙏'
            : 'No encuentro un servicio a nombre de este número. Si eres cliente y ves esto, escríbele a un asesor para que lo revisemos. 🙏');
          return;
        }

        if (await preguntarContratoSiHayVarios(chatId, sendMsg, 'pago_clabe')) return;

        const datos = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: c.name, servicioId: servicioClabe ? servicioClabe.servicioId : undefined });

        /*
         * DECIRLE CUÁNTO TRANSFERIR, con el cargo ya sumado.
         *
         * Esto no es un detalle de redacción, es de dinero. La comisión sale
         * del EXCEDENTE sobre lo que el cliente debía: si transfiere justo su
         * mensualidad, el excedente es cero y no se cobra nada. Y una
         * transferencia SPEI le cuesta $8.12 a la plataforma, comprobado
         * contra la API de Stripe. O sea que cada cliente que deposite justo su
         * plan —que es lo que iba a hacer todo el mundo, porque el mensaje
         * anterior decía literalmente "transfiere el monto de tu plan"— deja a
         * OBEX $8.12 abajo. Con el padrón entero eso son más de once mil pesos
         * al mes de pérdida, en silencio.
         *
         * El monto sale de las facturas pendientes, igual que en el botón de
         * tarjeta. Si Wisphub no contesta se cae al precio de su plan, y si
         * tampoco hay, se dice sin cifras antes que decir una equivocada.
         */
        let deuda = 0;
        let cuantas = 0;
        try {
          // La deuda del contrato elegido, no la del primero que aparezca.
          const d = await wisphubReactivar.deudaDelCliente((servicioClabe && servicioClabe.usuario) || c.usuario || '');
          deuda = d.total;
          cuantas = d.facturas.length;
        } catch (e) {
          console.warn('[stripe-leon] sin deuda para la CLABE de', tel, '·', e.message);
        }
        if (deuda <= 0) deuda = parseFloat(c.precioPlan) || 0;
        const cargo = deuda > 0 ? stripeLeon.calcularCargo(deuda, 'clabe') : null;

        const bloqueMonto = cargo
          ? `\n💵 *Transfiere: $${(cargo.totalCentavos / 100).toFixed(2)}*\n`
            + `   • ${cuantas > 1 ? (ajenaClabe ? `Sus ${cuantas} mensualidades` : `Tus ${cuantas} mensualidades`) : (ajenaClabe ? 'Su mensualidad' : 'Tu mensualidad')}: $${(cargo.baseCentavos / 100).toFixed(2)}\n`
            + `   • Cargo por pagar en línea: $${(cargo.cargoCentavos / 100).toFixed(2)}\n`
          : '\n💵 Transfiere el monto de tu recibo más el cargo por pagar en línea.\n';

        await sendMsg(chatId,
          (ajenaClabe
            ? `🏦 Esta es la cuenta para pagar el internet de *${c.name}*${servicioClabe && servicioClabe.etiqueta ? ` (${servicioClabe.etiqueta})` : ''}:\n\n`
            : `🏦 Esta es *tu cuenta personal* para pagar tu internet${servicioClabe && servicioClabe.etiqueta ? ` (${servicioClabe.etiqueta})` : ''}:\n\n`)
          + `*CLABE:* ${datos.clabe}\n`
          + (datos.banco ? `*Banco:* ${datos.banco}\n` : '')
          + (datos.beneficiario ? `*A nombre de:* ${datos.beneficiario}\n` : '')
          + bloqueMonto
          + (ajenaClabe
            ? `\nEsta CLABE es *de esa cuenta* y no cambia nunca: lo que caiga aquí se le abona a *${c.name}*, lo mandes tú o quien sea. Lo único que cambia es el monto, según lo que deba ese mes.\n\n`
              + `Cuando transfieras, el pago se registra solo y *su* servicio se reactiva — *no hace falta que mandes comprobante*.\n\n`
            : `\nGuárdala en tu banco: *la CLABE es tuya y no cambia nunca*. Lo único que cambia es el monto, según lo que debas ese mes.\n\n`
              + `Cuando transfieras, tu pago se registra solo y tu servicio se reactiva — *no hace falta que mandes comprobante*.\n\n`)
          + `Si transfieres desde tu app del banco, dala de alta una vez como cuenta frecuente y ya.\n\n`
          + `Si vas a ventanilla y te preguntan a nombre de quién va, enséñales esta pantalla: la cuenta la administra el banco que procesa nuestros pagos. 🙌`);
      } catch (e) {
        console.error('[stripe-leon] CLABE:', e.message);
        await sendMsg(chatId, 'No pude generar tu cuenta ahorita. Intenta de nuevo en un rato, o paga como siempre por depósito/transferencia. 🙏');
      }
      return;
    }
    /*
     * ═══════════ PAGAR LA CUENTA DE ALGUIEN MÁS ═══════════
     *
     * Aquí la gente paga por su mamá, por su suegra, por el vecino que no tiene
     * WhatsApp. Antes el cobro iba amarrado al teléfono de quien escribe, así
     * que eso no se podía: la persona pagaba SU cuenta sin querer, o se daba
     * por vencida y se iba a la oficina.
     *
     * El flujo: escribe OTRO, dice de quién (teléfono o nombre como está en el
     * contrato), confirma, y de ahí sigue el cobro normal pero con la cuenta
     * del otro. Al confirmarse el pago, se reactiva el servicio del dueño y se
     * les avisa a los dos.
     */
    /*
     * Lo que dijo hace media hora ya no cuenta. Sin esto, quien dijo OTRO un
     * martes y se distrajo pagaría la cuenta ajena el jueves, cuando vuelva a
     * escribir PAGAR para la suya.
     */
    const _ses = sesionDePagoAjeno(chatId);
    // Eligió cuál de sus servicios paga: se guarda y se sigue por donde iba.
    /*
     * "¿Cuál vas a pagar?" también se contesta escribiendo: "el local", "la
     * casa", "el de Juárez", "el suspendido", "el primero", "los dos" no (uno
     * a la vez). Se busca la palabra en la etiqueta del contrato; si solo uno
     * coincide, es ese.
     */
    let _ptServicio = _pt;
    if (_ses.state === 'pago_servicio_elegir' && !_isBtn && !/^pago_servicio_\d$/.test(_pt)) {
      const lista = _ses.data.servicios || [];
      const quitarAcentos = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const q = quitarAcentos(_pt).replace(/[¡!¿?.,]/g, ' ').replace(/\b(el|la|los|las|de|del|que|es|mi|quiero|pagar|pago|ese|esa|este|esta|uno|una)\b/g, ' ').trim();
      let idx = -1;
      const ordinal = q.match(/^(primer[oa]?|1|segund[oa]?|2|tercer[oa]?|3)$/);
      if (ordinal) idx = /^(primer|1)/.test(ordinal[1]) ? 0 : /^(segund|2)/.test(ordinal[1]) ? 1 : 2;
      else if (/^(suspendid[oa]|cortad[oa]|sin servicio|debe|deb[oa])$/.test(q)) {
        const susp = lista.map((x, i) => (/suspend|cort/i.test(x.estado) ? i : -1)).filter((i) => i >= 0);
        if (susp.length === 1) idx = susp[0];
      } else if (q.length >= 3) {
        const hits = lista.map((x, i) => (quitarAcentos(x.etiqueta).includes(q) ? i : -1)).filter((i) => i >= 0);
        if (hits.length === 1) idx = hits[0];
      }
      if (idx >= 0 && lista[idx]) _ptServicio = 'pago_servicio_' + idx;
      else if (q.length >= 3 && !/^(men[uú]|salir|cancelar|volver)$/.test(q) && !_pideDatosPagoTemprano(_pt)) {
        await sendMsg(chatId, 'No supe cuál de los dos: toca el botón del servicio que vas a pagar. 👆');
        return;
      }
    }
    if (_ses.state === 'pago_servicio_elegir' && /^pago_servicio_\d$/.test(_ptServicio)) {
      const el = (_ses.data.servicios || [])[Number(_ptServicio.slice(-1))];
      if (!el) { clearSession(chatId); await sendMsg(chatId, 'Esa opción ya no está. Escribe *pagar* para empezar de nuevo.'); return; }
      setSession(chatId, { state: 'pago_otro_listo', data: { pagarPara: _ses.data.pagarPara || '', servicioId: el.id, usuario: el.usuario, etiqueta: el.etiqueta, meses: _ses.data.meses || 1, desde: Date.now() } });
      return handleChatMessage(chatId, _ses.data.siguiente || (_ses.data.viaClabe ? 'pago_clabe' : 'pago_tarjeta'), sendMsg);
    }
    // Si acaba de mandar un comprobante y el bot le preguntó a nombre de quién
    // está, lo que escriba es esa respuesta, no un nombre para buscar.
    const _conComprobante = pendingImage.has(_pendKey) || pendingDoc.has(_pendKey);
    // "menú", "salir" o un saludo sacan de CUALQUIER paso de pagar por otro: si
    // no, lo escrito se buscaría como nombre, o el menú principal se abriría con
    // la cuenta ajena todavía pegada.
    if (String(_ses.state || '').startsWith('pago_otro_') && !_isBtn
        && /^(men[uú]|salir|cancelar|inicio|hola|regresar|volver)[\s.!]*$/.test(_pt)) {
      clearSession(chatId);
      await sendMsg(chatId, 'Listo, lo dejamos ahí. Cuando quieras pagar tu cuenta escribe *pagar*; si es la de alguien más, escribe *OTRO*.');
      return;
    }
    if (_ses.state === 'pago_otro_buscar' && !_isBtn && !_emergencyNow && !_conComprobante) {
      const digitos = text.replace(/\D/g, '');
      // Sin acentos de los dos lados: "ana perez" tiene que dar con "Ana Pérez".
      const sinAcentos = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
      const nombreBuscado = sinAcentos(text);
      const encontrados = [];
      for (const [tel, c] of wisphubClients.entries()) {
        const porTel = digitos.length >= 7 && tel.endsWith(digitos.slice(-10));
        const porNombre = nombreBuscado.length >= 4 && sinAcentos(c.name).includes(nombreBuscado);
        if ((porTel || porNombre) && tel !== normalizePhone(chatId)) encontrados.push({ tel, name: c.name || tel });
        if (encontrados.length >= 4) break;
      }
      // Más de tres es demasiado para los botones de WhatsApp: mejor afinar la búsqueda.
      if (encontrados.length > 3) {
        await sendMsg(chatId, `Hay varias personas con "${text.trim().slice(0, 40)}". Escríbeme el *nombre con apellidos* completo, o mejor su *número de teléfono*, para dar con la cuenta correcta.`);
        return;
      }
      if (!encontrados.length) {
        await sendMsg(chatId, 'No encontré una cuenta con eso. Escríbeme el *número de teléfono* que tiene registrado, o el *nombre completo* como aparece en su contrato. Si prefieres salir, escribe *menú*.');
        return;
      }
      setSession(chatId, { state: 'pago_otro_confirmar', data: { candidatos: encontrados, meses: _ses.data.meses || 1, desde: Date.now() } });
      /*
       * WhatsApp corta los títulos a 20 letras. Dos "María del Carmen López"
       * distintas se verían iguales; si chocan, se les pega el final del
       * teléfono para que quien paga sepa cuál es la suya.
       */
      const cortos = encontrados.map((e) => String(e.name).slice(0, 20));
      const botones = encontrados.map((e, i) => {
        const repetido = cortos.filter((c) => c === cortos[i]).length > 1;
        const title = repetido ? `${String(e.name).slice(0, 13)} ·${e.tel.slice(-4)}` : cortos[i];
        return { id: 'pago_otro_es_' + i, title };
      });
      await sendMsg(chatId,
        encontrados.length === 1
          ? `¿Es la cuenta de *${encontrados[0].name}*?`
          : 'Encontré estas cuentas. ¿Cuál es?',
        [], { buttons: botones });
      return;
    }
    /*
     * "¿Es la cuenta de Ana Pérez?" se contesta con el botón, pero mucha gente
     * escribe "sí" (o "no"). Con una sola candidata, "sí" es esa; "no" vuelve a
     * preguntar de quién es. Con varias, "sí" no dice cuál: se le pide tocar.
     */
    let _ptConfirmar = _pt;
    if (_ses.state === 'pago_otro_confirmar' && !_isBtn) {
      const cand = _ses.data.candidatos || [];
      const siLimpio = _pt.replace(/[¡!¿?.,\s]+/g, ' ').trim();
      if (/^(s[ií]|s[ií] es|s[ií] es esa|s[ií] esa|esa|esa es|esa misma|correcto|as[ií] es|exacto|claro|ella|[eé]l|es ella|es [eé]l|s[ií] ella|s[ií] [eé]l)$/.test(siLimpio)) {
        if (cand.length === 1) _ptConfirmar = 'pago_otro_es_0';
        else { await sendMsg(chatId, 'Son varias con ese nombre: toca el botón de la que es. 👆'); return; }
      } else if (/^(no|nel|nop|otra|otro|esa no)\b/.test(siLimpio) && siLimpio.length <= 60) {
        // "no", "no es esa", "no, esa no"... y "no, es Ana Pérez Gómez": lo que sobre se busca de una vez.
        const relleno = new Set(['no', 'nel', 'nop', 'es', 'esa', 'ese', 'ella', 'el', 'él', 'de', 'del', 'la', 'otra', 'otro', 'sino', 'mejor']);
        const palabras = siLimpio.split(' ');
        while (palabras.length && relleno.has(palabras[0])) palabras.shift();
        const resto = palabras.join(' ').trim();
        setSession(chatId, { state: 'pago_otro_buscar', data: { desde: Date.now(), meses: _ses.data.meses || 1 } });
        if (resto.length >= 4) return handleChatMessage(chatId, resto, sendMsg);
        await sendMsg(chatId, 'Va. ¿De quién es la cuenta? Escríbeme el *nombre completo* o el *teléfono* como está en el contrato.');
        return;
      }
    }
    if (_ses.state === 'pago_otro_confirmar' && /^pago_otro_es_\d$/.test(_ptConfirmar)) {
      const elegido = (_ses.data.candidatos || [])[Number(_ptConfirmar.slice(-1))];
      if (!elegido) { clearSession(chatId); await sendMsg(chatId, 'Esa opción ya no está. Escribe *OTRO* para buscar de nuevo.'); return; }
      // Se deja la cuenta elegida en la sesión: el cobro de tarjeta/OXXO la lee.
      setSession(chatId, { state: 'pago_otro_listo', data: { pagarPara: elegido.tel, meses: _ses.data.meses || 1, desde: Date.now() } });
      let cuanto = '';
      try {
        // Con varios contratos se pregunta CUÁL de una vez (con lo que debe cada uno); al elegir, sigue el menú de pago.
        const contratos = await serviciosDeLaCuenta(elegido.tel);
        if (contratos.length > 1) {
          await sendMsg(chatId, `Perfecto, vas a pagar la cuenta de *${elegido.name}*.`);
          if (await preguntarContratoSiHayVarios(chatId, sendMsg, 'pagar')) return;
        } else {
          const cobro = await montoACobrar(chatId, elegido.tel);
          if (cobro.ok) cuanto = ` Su mensualidad es de *$${cobro.monto.toFixed(2)}*${cobro.deTexto}.`;
        }
      } catch (_) { /* sin monto se sigue igual */ }
      await sendMsg(chatId,
        `Perfecto, vas a pagar la cuenta de *${elegido.name}*.${cuanto} ¿Cómo quieres pagar? Toca una opción 👇\n\n`
        + '🏦 Transferencia: te doy la CLABE de *su* cuenta; lo que caiga ahí se le abona a ella.\n💳 Tarjeta: pagas desde tu teléfono.\n🏪 OXXO: te doy una ficha para pagar en caja.',
        [], { buttons: [
          { id: 'pago_clabe', title: '🏦 Transferencia' },
          { id: 'pago_con_tarjeta', title: '💳 Tarjeta' },
          { id: 'pago_con_oxxo', title: '🏪 OXXO (efectivo)' },
        ] });
      return;
    }
    /*
     * "otro" solo abre este flujo cuando no está a media conversación de otra
     * cosa: en el paso de elegir plan o de dar una ubicación, "otro" es una
     * respuesta a ESA pregunta y no hay que robársela.
     */
    // El menú principal no es "otra cosa": desde ahí OTRO tiene que funcionar.
    const _enOtraCosa = !!_ses.state && !String(_ses.state).startsWith('pago_otro_') && _ses.state !== 'awaiting_menu_choice';
    /*
     * "Pago de internet a nombre de Ana Lilia Hernández": así escribe la gente
     * de verdad (106 de 169 pagos recientes vienen con "a nombre de"). No hay
     * que enseñarles a escribir OTRO: se toma el nombre y se busca de una vez.
     */
    const _aNombreDe = (text.match(/a nombre de\s+(?:la\s+se[ñn]ora?\s+|el\s+se[ñn]or\s+|don\s+|do[ñn]a\s+)?([^\n,.;]{4,60})/i) || [])[1];
    if (_aNombreDe && !_enOtraCosa && !_conComprobante && !_isBtn
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      // "3 meses a nombre de mi mamá": los meses viajan con la búsqueda hasta el cobro.
      const _mesesAjenos = (_pt.match(/(\d{1,2}|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s*meses/) || [])[1];
      const _palabrasM = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
      const _nMeses = _mesesAjenos ? Math.min(12, Math.max(1, _palabrasM[_mesesAjenos] || Number(_mesesAjenos) || 1)) : 1;
      setSession(chatId, { state: 'pago_otro_buscar', data: { desde: Date.now(), ...(_nMeses > 1 ? { meses: _nMeses } : {}) } });
      // "a nombre de mi mamá Ana Pérez": el parentesco sobra para buscar.
      const nombreLimpio = _aNombreDe.trim().replace(/^(mi|la|el|de mi|de la|del)\s+(mam[aá]|pap[aá]|esposa?|hij[oa]|herman[oa]|suegr[ao]|abuel[oa]|t[ií][ao]|vecin[oa]|se[ñn]ora?|patr[oó]n[a]?|jef[ea])\s+/i, '').trim();
      return handleChatMessage(chatId, nombreLimpio || _aNombreDe.trim(), sendMsg);
    }
    /*
     * "3 meses", "pagar 6 meses", "adelantar dos meses": se guarda cuántos y
     * se cotiza de una vez con el total. Solo en el piloto.
     */
    // También como lo escriben de verdad: "¿puedo pagar dos meses de internet?", "quisiera adelantar 3 meses".
    const _mesesTxt = _pt.replace(/^[¿¡\s]+|[?!.\s]+$/g, '').match(/^(?:hola[,.!\s]*)?(?:(?:quiero|quisiera|puedo|podr[ií]a|me gustar[ií]a|voy a|deseo|se puede|si puedo|cu[aá]nto(?: es| sale| ser[ií]a| cuesta)?(?: por| si pago| de)?)\s+)?(?:pagar(?:le|te)?|adelantar|abonar|pago|adelanto|cubrir)?\s*(?:de\s+|los\s+|por\s+)?(\d{1,2}|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s*mes(es)?(\s+(adelantad|por adelantado|de jal[oó]n|juntos|seguidos|de una vez|de internet|de servicio|de mi (internet|servicio|plan)).*)?$/);
    if (_mesesTxt && !_enOtraCosa && !_conComprobante
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      const palabras = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
      const meses = Math.min(12, Math.max(1, palabras[_mesesTxt[1]] || Number(_mesesTxt[1]) || 1));
      const previa = sesionDePagoAjeno(chatId);
      const data = previa.state === 'pago_otro_listo' ? { ...previa.data } : {};
      setSession(chatId, { state: 'pago_otro_listo', data: { ...data, pagarPara: data.pagarPara || '', meses, desde: Date.now() } });
      if (meses === 1) return handleChatMessage(chatId, 'pagar', sendMsg);
      return handleChatMessage(chatId, 'pago_tarjeta', sendMsg);
    }
    /*
     * ── COBRO AUTOMÁTICO: ACTIVAR Y CANCELAR ──────────────────────────────
     * Se pide con una palabra, se explica en dos líneas y se confirma con un
     * botón. Cancelar es igual de fácil: nadie debe sentirse atrapado.
     */
    // "¿Lo activamos?" contestado con palabras: "sí", "dale", "va" activan; "no", "ahora no" no.
    const _ofrecidoHace = autoOfrecido.get(String(chatId)) || 0;
    if (_ofrecidoHace && Date.now() - _ofrecidoHace < 30 * 60000 && !_isBtn && !_enOtraCosa && !_conComprobante) {
      const t = _pt.replace(/[¡!¿?.,\s]+/g, ' ').trim();
      if (/^(s[ií]|s[ií] (claro|dale|va|por favor|porfa|act[ií]valo|quiero|cada mes|est[aá] bien)|dale|va|claro|ok|okey|de acuerdo|act[ií]valo|act[ií]var|activar|que s[ií]|s[ií] s[ií]|est[aá] bien|adelante)$/.test(t)) {
        autoOfrecido.delete(String(chatId));
        return handleChatMessage(chatId, 'auto_si', sendMsg);
      }
      if (/^(no|ahora no|no gracias|nel|luego|despu[eé]s|no por ahora|mejor no|todav[ií]a no|a[uú]n no|no quiero|no por el momento)( gracias| por ahora| por el momento| mejor)?$/.test(t)) {
        autoOfrecido.delete(String(chatId));
        await sendMsg(chatId, 'Va, sin problema. Cuando quieras activarlo, escribe *AUTOMÁTICO*. 🙌');
        return;
      }
    }
    // Como lo dice la gente: "ya no quiero el cobro automático", "quítame lo automático", "cancela mi suscripción".
    const _cancelaAuto = /^(?:hola[,.!\s]*)?(?:por favor\s+)?(cancelar|cancela|cancelen|cancelame|cancélame|quitar|quita|quiten|quitame|quítame|desactivar|desactiva|desactiven|ya no quiero|ya no|no quiero|dar de baja|den de baja|baja|suspender|suspende)\s+(?:el\s+|la\s+|lo\s+|mi\s+|del\s+|de\s+)?(?:cobro\s+|pago\s+|cargo\s+)?(?:autom[aá]tic[oa]|suscripci[oó]n|domiciliaci[oó]n)/.test(_pt.replace(/[¿¡?!.]+$/g, ''));
    if ((_cancelaAuto || _pt === 'auto_no') && !_enOtraCosa) {
      const tel = normalizePhone(chatId);
      const reg = stripeClientes.get(tel);
      if (reg && reg.cobroAutomatico) {
        stripeClientes.set(tel, { ...reg, cobroAutomatico: false, autoCanceladoEn: new Date().toISOString() });
        schedulePersist();
        await sendMsg(chatId, 'Listo, quité el cobro automático: ya no se va a cobrar nada a tu tarjeta por su cuenta. Cada mes escribe *pagar* y eliges cómo. 🙌');
      } else {
        await sendMsg(chatId, 'No tienes cobro automático activo, así que no hay nada que quitar. Si quieres activarlo, escribe *AUTOMÁTICO*.');
      }
      return;
    }
    if ((/^(autom[aá]tico|cobro autom[aá]tico|activar (el )?(cobro )?autom[aá]tico|suscripci[oó]n|domiciliar|domiciliaci[oó]n|pago autom[aá]tico)[\s.!]*$/.test(_pt) || _pt === 'auto_si')
        && !_enOtraCosa && !_conComprobante
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      const tel = normalizePhone(chatId);
      const c = wisphubClients.get(tel) || {};
      if (_pt !== 'auto_si') {
        const reg = stripeClientes.get(tel);
        if (reg && reg.cobroAutomatico) {
          await sendMsg(chatId, 'Ya tienes el cobro automático activo: un día antes de tu fecha de pago se cobra a tu tarjeta guardada, y te aviso el día anterior. Para quitarlo, escribe *CANCELAR AUTOMÁTICO*.');
          return;
        }
        await sendMsg(chatId,
          '🔁 *Cobro automático cada mes*\n\n'
          + 'Pagas una vez con tu tarjeta y queda guardada. De ahí en adelante:\n'
          + '• Dos días antes de tu fecha de pago te aviso cuánto se va a cobrar.\n'
          + '• Un día antes se cobra solo, y tu servicio nunca se corta.\n'
          + '• Lo quitas cuando quieras escribiendo *CANCELAR AUTOMÁTICO*.\n\n'
          + '¿Lo activamos?',
          [], { buttons: [{ id: 'auto_si', title: '✅ Sí, cada mes' }, { id: 'auto_no', title: '❌ Ahora no' }] });
        autoOfrecido.set(String(chatId), Date.now());
        return;
      }
      autoOfrecido.delete(String(chatId));
      try {
        if (await preguntarContratoSiHayVarios(chatId, sendMsg, 'auto_si')) return;
        const servicio = servicioEnSesion(chatId);
        const cobro = await montoACobrar(chatId, '', servicio);
        // Hace falta un cliente de Stripe al cual pegarle la tarjeta: el mismo de su CLABE.
        const datos = await stripeLeon.clabeDelCliente({ telefono: tel, nombre: c.name, servicioId: servicio ? servicio.servicioId : undefined });
        const monto = cobro.ok ? cobro.monto : (parseFloat(c.precioPlan) || 0);
        if (monto <= 0) { await sendMsg(chatId, 'No veo un saldo ni un plan en tu cuenta para activar el cobro. Escríbele a un asesor. 🙏'); return; }
        const pago = await stripeLeon.generarLinkPago({
          telefono: tel, monto, nombre: c.name, urlBase: SERVER_BASE_URL, forma: 'tarjeta',
          guardarTarjeta: true, clienteId: datos.clienteId,
          servicioId: servicio ? servicio.servicioId : undefined,
          cubreHasta: (cobro.ok && cobro.cubreHasta) || undefined,
        });
        await sendMsg(chatId,
          '💳 Paga esta vez con tu tarjeta y queda guardada para los meses que vienen:\n\n'
          + `• Mensualidad: $${pago.mensualidad.toFixed(2)}${cobro.ok ? cobro.deTexto : ''}\n`
          + `• Cargo por pagar en línea: $${pago.cargo.toFixed(2)}\n`
          + `• *Total: $${pago.total.toFixed(2)}*\n\n`
          + `${pago.url}\n\n`
          + 'En cuanto se confirme, el cobro automático queda activo. ⏱️ Tienes 30 minutos para abrir el link.');
      } catch (e) {
        console.error('[auto] activar:', e.message);
        await sendMsg(chatId, /cuenta|aprobada/i.test(e.message || '') ? 'El pago en línea no está disponible en este momento. Paga como siempre y mándanos tu comprobante. 🙏' : 'No pude preparar el cobro automático ahorita. Intenta de nuevo en un rato. 🙏');
      }
      return;
    }
    /*
     * "¿Cuándo es mi corte?" es de las preguntas más comunes y el aviso de
     * lanzamiento prometió contestarla. Se contesta con el dato de Wisphub, sin
     * IA de por medio, y con el monto si debe algo.
     */
    if (/(cu[aá]ndo|que d[ií]a|qu[eé] d[ií]a|fecha)\s.*(corte|vence|pago|pagar)|^(mi|fecha de) corte|^corte[\s?]*$|cu[aá]ndo me (cortan|toca pagar)/.test(_pt)
        && !_enOtraCosa && !_conComprobante && !_isBtn) {
      const telC = normalizePhone(chatId);
      const c = wisphubClients.get(telC);
      if (!c) {
        await sendMsg(chatId, 'No encuentro un servicio a nombre de este número. Si eres cliente, escríbele a un asesor con tu nombre completo para revisarlo. 🙏');
        return;
      }
      // Con varios contratos, se dice cómo va cada uno.
      const variosC = await serviciosDeLaCuenta(telC);
      if (variosC.length > 1) {
        const { lineas, debeAlgo } = await describirContratos(variosC);
        await sendMsg(chatId,
          `Tienes *${variosC.length} servicios* con nosotros:\n` + lineas.join('\n')
          + (debeAlgo ? '\n\nEscribe *pagar* y te pregunto cuál quieres pagar.' : '\n\nEstás al corriente en los dos. 🙌'));
        return;
      }
      const corte = parseFechaCorte(c.fechaCorte);
      const bonita = corte ? corte.split('-').reverse().join('/') : '';
      const suspendido = /suspend|cort/i.test(String(c.status || ''));
      let monto = '';
      // Si el bot ya vio su pago (aunque Wisphub siga diciendo que debe), no se le cobra en el mensaje.
      const vistoC = pagoRecienteDe(telC);
      if (vistoC) monto = /^adelantado hasta /.test(vistoC.canal) ? ` ✅ Estás pagado hasta el *${vistoC.canal.slice(-10).split('-').reverse().join('/')}*.` : ` ✅ Ya tenemos tu pago de este mes (${canalTexto(vistoC.canal)}).`;
      else try { const cobro = await montoACobrar(chatId, ''); if (cobro.ok && clienteDebe(c)) monto = ` Tienes pendiente *$${cobro.monto.toFixed(2)}*${cobro.deTexto}.`; } catch (_) { /* sin monto */ }
      const prC = prorrogaVigente(telC);
      const prTexto = prC ? `\n⏳ Tienes prórroga hasta el *${prC.hasta.split('-').reverse().join('/')}*: no se te corta antes.` : '';
      await sendMsg(chatId,
        (suspendido ? '🔴 Tu servicio está *suspendido*.' : (corte ? `📅 Tu fecha de corte es el *${bonita}*.` : '📅 No tengo tu fecha de corte a la mano.'))
        + monto + prTexto
        + (vistoC ? ' Estás al corriente. 🙌' : (suspendido || monto ? '\n\nEscribe *pagar* y te digo cómo, o *cuánto debo* para ver el detalle.' : '\n\nEstás al corriente. 🙌')));
      return;
    }
    /*
     * "Ya pagué" / "ya deposité" sin comprobante. Es de lo más común en las
     * conversaciones reales ("Sea depositado 440", "el pago se hizo el 14").
     * Si el bot ya vio ese pago, se lo confirma; si no, le pide la foto del
     * comprobante en vez de dejarlo esperando una respuesta que no llega.
     */
    if ((/^(ya (pagu[eé]|deposit[eé]|transfer[ií]|hice el pago|realic[eé] el pago|se pag[oó])|(se|sea|le|ya se|ya le) ?(deposit|transfir|transfer|hizo el pago|realiz[oó] el pago)|(el )?pago (ya )?(se hizo|est[aá] hecho|fue realizado)|deposit[eé] (los|el|\$)|transfer[ií] (los|el|\$))/.test(_pt)
         // "¿Ya quedó registrado mi pago?", "si fue registrado ya el pago", "ya se reflejó"
         || /(registr|aplic|reflej|recib)\w*\s.{0,25}pago|pago\s.{0,30}(registr|aplic|reflej|recib)|ya (lleg|entr)[oó] (mi|el) pago/.test(_pt))
        && !_enOtraCosa && !_conComprobante && !_isBtn) {
      const telP = normalizePhone(chatId);
      const visto = pagoRecienteDe(telP);
      // Un comprobante que ya mandó y la oficina todavía no revisa: no se le vuelve a pedir.
      const enRevision = comprobanteEnRevisionDe(telP);
      const porOtro = visto ? null : pagoHechoPor(telP);
      if (visto) {
        await sendMsg(chatId, `✅ Sí, tu pago ya está registrado (${canalTexto(visto.canal)}). No hace falta que mandes nada más. 🙌`);
      } else if (porOtro) {
        const nombreT = (wisphubClients.get(porOtro.titular) || {}).name || 'esa cuenta';
        await sendMsg(chatId, `✅ Sí, el pago que hiciste para *${nombreT}* ya está registrado (${canalTexto(porOtro.canal)}). No hace falta que mandes nada más. 🙌`);
      } else if (enRevision) {
        await sendMsg(chatId, '📄 Ya tenemos tu comprobante y la oficina lo está revisando. En cuanto lo registren te aviso por aquí; no hace falta que lo vuelvas a mandar. 🙌');
      } else {
        await sendMsg(chatId, '👍 Gracias. Para registrarlo, *mándame la foto o el PDF de tu comprobante* aquí mismo y te confirmo en cuanto la oficina lo revise. Si pagaste por el bot (tarjeta, OXXO o tu CLABE), no hace falta: se registra solo.');
      }
      return;
    }
    /*
     * "Pago del señor Félix Ramos", "pago de servicio de Víctor Caballero":
     * también así avisan que pagan por otro. Aquí solo se toma como pago por
     * otro si el nombre existe en el padrón; si no, sigue el flujo normal.
     */
    const _pagoDe = (text.match(/^(?:buen(?:[oa]s?)?\s+(?:d[ií]as?|tardes|noches)[,.]?\s*)?(?:pago|pagar|abono)\s+(?:de|del|para)\s+(?:(?:el\s+)?servicio\s+(?:de|del)\s+|internet\s+(?:de|del)\s+)?(?:(?:el|la)\s+)?(?:se[ñn]ora?|don|do[ñn]a|sr\.?|sra\.?)?\s*([^\n,.;]{6,60})$/i) || [])[1];
    if (_pagoDe && !_aNombreDe && !_enOtraCosa && !_conComprobante && !_isBtn
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
      const q = norm(_pagoDe);
      const hay = q.length >= 6 && [...wisphubClients.entries()].some(([tel, c]) => tel !== normalizePhone(chatId) && norm(c.name).includes(q));
      if (hay) {
        setSession(chatId, { state: 'pago_otro_buscar', data: { desde: Date.now() } });
        return handleChatMessage(chatId, _pagoDe.trim(), sendMsg);
      }
    }
    if (/^(oficina|en la oficina|pagar en oficina|otras formas)[\s.!]*$/.test(_pt) && !_enOtraCosa) {
      return handleChatMessage(chatId, 'pago_otras', sendMsg);
    }
    if (/^(otro|pagar otro|pagar por otro|pagar (el|la) de|es de otra persona|de otra persona|de alguien m[aá]s)/.test(_pt)
        && !_enOtraCosa && !_conComprobante
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      setSession(chatId, { state: 'pago_otro_buscar', data: { desde: Date.now() } });
      await sendMsg(chatId, '¿De quién es la cuenta que quieres pagar? Escríbeme su *número de teléfono* o su *nombre completo* como está en el contrato.');
      return;
    }

    // Intención de pago (o el "PAGAR" que sugiere el recordatorio de corte) → botones.
    /*
     * Así piden los datos de pago en las conversaciones reales: "Para pagar en
     * transferencia?", "Proporcionarme los números de cuenta para depositar",
     * "me pasan la clabe". Todo eso es "quiero pagar".
     */
    const _pideDatosPago = /n[uú]meros? de cuenta|cuenta para (depositar|transferir|pagar)|d[oó]nde (deposito|transfiero|le deposito|hago el pago)|(en|por) transferencia\??$|datos (bancarios|de la cuenta|para (pagar|depositar|transferir))|\bclabe\b|a qu[eé] cuenta/.test(_pt);
    /*
     * Quien pide "los números de cuenta", "mi CLABE" o "a qué cuenta deposito"
     * ya eligió cómo pagar: se le da la CLABE de una vez, sin pasar por el
     * menú. Si no está en el piloto, el menú de siempre trae los datos.
     */
    if (_pideDatosPago && !_enOtraCosa && !_conComprobante && !_isBtn
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      return handleChatMessage(chatId, 'pago_clabe', sendMsg);
    }
    /*
     * "¿Cómo quieres pagar?" también se contesta escribiendo: "tarjeta", "con
     * tarjeta", "oxxo", "en oxxo", "transferencia". Sin más vueltas.
     */
    const _formaEscrita = _pt.replace(/[¡!¿?.,\s]+/g, ' ').trim().match(/^(?:quiero |prefiero |mejor |pago |pagar |pagarlo |voy a pagar )?(?:con |en |por |la |el )?(tarjeta(?: de (?:cr[eé]dito|d[eé]bito))?|oxxo|transferencia|dep[oó]sito|spei)(?: por favor| porfa| porfavor)?$/);
    if (_formaEscrita && !_enOtraCosa && !_conComprobante && !_isBtn
        && stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE)) {
      const f = _formaEscrita[1];
      return handleChatMessage(chatId, /^tarjeta/.test(f) ? 'pago_con_tarjeta' : f === 'oxxo' ? 'pago_con_oxxo' : 'pago_clabe', sendMsg);
    }
    if (/^(pagar|quiero pagar|como (puedo )?pag|cómo (puedo )?pag|donde pag|dónde pag|datos de pago|m[eé]todos de pago|formas de pago|cu[aá]nto (debo|tengo que pagar|es|pago|es mi)|mi saldo|mi adeudo|qu[eé] debo)/.test(_pt)
        || (_pideDatosPago && !_enOtraCosa && !_conComprobante && !_isBtn)) {
      /*
       * WhatsApp solo muestra TRES botones y `sendWhatsAppMessage` corta el
       * resto sin avisar. Por eso el menú se arma completo según el caso en vez
       * de ir empujando opciones: con cuatro, la cuarta simplemente no
       * aparecería y nadie sabría por qué.
       *
       * Los títulos también se cortan a 20 caracteres, así que van cortos a
       * propósito.
       */
      // El cobro en línea se ofrece según el interruptor COBRO_LINEA_ACTIVO, no
      // por una comparación fija: así se amplía o se apaga desde las variables
      // de entorno, sin tocar código ni volver a desplegar. Vacío = solo el piloto.
      /*
       * UN TOQUE POR FORMA DE PAGAR, CON LAS PALABRAS DE LA GENTE.
       *
       * Antes: "Mi CLABE fija" (nadie dice así), "Tarjeta u OXXO" (y luego
       * otra pregunta), "Otras formas". Ahora cada botón es una forma y al
       * tocarlo sale directo lo que necesita: la CLABE, el link con tarjeta o
       * la ficha de OXXO, cada uno con su total. La oficina se pide por texto.
       */
      const esPiloto = stripeLeon.permitido(normalizePhone(chatId), TELEFONO_PILOTO_STRIPE);
      const botonesPago = esPiloto
        ? [
          { id: 'pago_clabe', title: '🏦 Transferencia' },
          { id: 'pago_con_tarjeta', title: '💳 Tarjeta' },
          { id: 'pago_con_oxxo', title: '🏪 OXXO (efectivo)' },
        ]
        : [
          { id: 'pago_horario', title: '🏢 Horario en oficina' },
          { id: 'pago_datos', title: '💳 Datos de pago' },
        ];
      let encabezado = '';
      if (esPiloto) {
        // Quien tiene cobro automático no necesita hacer nada: que lo sepa antes de pagar dos veces.
        const regMenu = stripeClientes.get(normalizePhone(chatId)) || {};
        const vistoMenu = !cuentaAjena(chatId) && mesesEnSesion(chatId) <= 1 ? pagoRecienteDe(normalizePhone(chatId)) : null;
        if (regMenu.cobroAutomatico && !cuentaAjena(chatId) && !vistoMenu) {
          const corteMenu = parseFechaCorte((wisphubClients.get(normalizePhone(chatId)) || {}).fechaCorte);
          // Si el cobro de este periodo ya se intentó y no pasó, "no tienes que hacer nada" sería mentira.
          const perMenu = corteMenu ? (((autoCobros[normalizePhone(chatId)] || {})[corteMenu]) || {}) : {};
          if (perMenu.estado === 'rechazado' || perMenu.estado === 'sin-tarjeta') {
            encabezado = (perMenu.estado === 'sin-tarjeta'
              ? '⚠️ Este mes tu *cobro automático* no se hizo: ya no hay una tarjeta guardada.'
              : '⚠️ Este mes tu *cobro automático* no pasó: la tarjeta fue rechazada.')
              + ' Paga ahora de otra forma para que no se corte tu servicio (si pagas con tarjeta, esa queda guardada para el mes que viene).\n\n';
          } else {
            encabezado = '🔁 Tienes *cobro automático*: '
              + (corteMenu ? `se cobra solo a tu tarjeta un día antes del ${corteMenu.split('-').reverse().join('/')}` : 'se cobra solo a tu tarjeta un día antes de tu fecha de pago')
              + '. No tienes que hacer nada.\n\nSi de todos modos quieres pagar ahora, elige cómo (y ese mes ya no se te cobra en automático).\n\n';
          }
        }
        // Y quien ya pagó este mes también debe saberlo antes de pagar dos veces
        // (salvo que venga a adelantar meses a propósito).
        if (vistoMenu) {
          encabezado += (/^adelantado hasta /.test(vistoMenu.canal)
            ? `✅ Ya estás pagado hasta el *${vistoMenu.canal.slice(-10).split('-').reverse().join('/')}*.`
            : `✅ Ya tenemos tu pago de este mes (${canalTexto(vistoMenu.canal)}).`)
            + ' No tienes que pagar nada ahora.'
            + (regMenu.cobroAutomatico ? ' Y como tienes *cobro automático*, el siguiente se cobra solo.' : '')
            + '\n\nSi quieres adelantar el siguiente, elige cómo.\n\n';
        }
        // Con prórroga vigente, que sepa hasta cuándo tiene antes de elegir cómo pagar.
        const prMenu = !cuentaAjena(chatId) ? prorrogaVigente(normalizePhone(chatId)) : null;
        if (prMenu && !vistoMenu) {
          encabezado += `⏳ Tienes prórroga hasta el *${prMenu.hasta.split('-').reverse().join('/')}*: no se te corta antes de esa fecha, y puedes pagar cuando quieras.\n\n`;
        }
        // Si se sabe cuánto debe, se le dice ANTES de preguntar cómo: es la
        // primera duda de cualquiera ("¿cuánto es?").
        try {
          const ajenaMenu = cuentaAjena(chatId);
          const servicioMenu = servicioEnSesion(chatId);
          const varios = ajenaMenu || servicioMenu ? [] : await serviciosDeLaCuenta(normalizePhone(chatId));
          // Con dos contratos se pregunta CUÁL antes que CÓMO: primero qué se paga, luego con qué.
          if (varios.length > 1 && await preguntarContratoSiHayVarios(chatId, sendMsg, 'pagar')) return;
          if (varios.length <= 1) {
            const cobro = await montoACobrar(chatId, ajenaMenu, servicioMenu);
            if (cobro.ok) encabezado += `${ajenaMenu ? `La mensualidad de *${(wisphubClients.get(ajenaMenu) || {}).name || 'esa cuenta'}*` : 'Tu mensualidad'} es de *$${cobro.monto.toFixed(2)}*${cobro.deTexto}.`
              // Con meses adelantados en la sesión, que sepa cómo volver a uno solo.
              + (mesesEnSesion(chatId) > 1 ? ' Si solo quieres pagar un mes, escribe *1 mes*.' : '') + '\n\n';
          }
        } catch (_) { /* sin monto, el menú sale igual */ }
      }
      await sendMsg(chatId,
        encabezado + '¿Cómo quieres pagar? Toca una opción 👇'
        + (esPiloto
          ? '\n\n🏦 Transferencia: te doy una CLABE que es solo tuya.\n💳 Tarjeta: pagas desde tu teléfono.\n🏪 OXXO: te doy una ficha para pagar en caja.'
            + '\n\nSi vas a pagar la cuenta de *alguien más*, escríbeme *a nombre de quién* está. Si quieres adelantar varios meses, escribe cuántos (por ejemplo *3 meses*). Si prefieres pagar en la oficina, escribe *oficina*.'
          : ''),
        [], { buttons: botonesPago });
      return;
    }

    // ===== Prórroga / plazo de pago → directo con un asesor (decisión humana) =====
    // Solo si no es emergencia, no es un botón y no hay un comprobante pendiente por
    // confirmar (esos flujos de arriba tienen prioridad). agentNotifiedMsg ya adapta
    // el mensaje al horario: en horario "te contactará en breve", fuera de horario
    // "te contactará <próximo horario>" (sin dar número). El caso queda registrado
    // para el resumen matutino si es fuera de horario.
    if (!_emergencyNow && !_isBtn && !pendingImage.has(_pendKey) && !pendingDoc.has(_pendKey) && isProrrogaRequest(text)) {
      addMessageToHistory(chatId, 'user', text);
      const _nom = nameOf(getProfile(chatId));
      // Si ya tiene una prórroga, se le recuerda hasta cuándo; no se abre otro caso.
      const _prV = prorrogaVigente(normalizePhone(chatId));
      if (_prV) {
        await sendMsg(chatId, `⏳ Ya tienes una prórroga hasta el *${_prV.hasta.split('-').reverse().join('/')}*: no se te corta antes de esa fecha. Si necesitas más días, escribe *asesor* y lo revisa una persona.`);
        return;
      }
      const _notif = await notifyAgentRequest(chatId, [
        '📅 SOLICITUD DE PRÓRROGA / PLAZO DE PAGO',
        _nom ? `Cliente: ${_nom}` : '',
        `Mensaje: ${text}`,
        `Para dársela, responde: PRORROGA ${normalizePhone(chatId).replace(/^52/, '')} 3   (los días que quieras)`
      ].filter(Boolean).join('\n'), '').catch(() => false);
      await sendMsg(chatId, agentNotifiedMsg(_notif, _nom, 'asesor'));
      return;
    }

    // ===== Modo Incidencia: falla masiva declarada desde el panel =====
    // Si está ACTIVO y el cliente reporta una falla (internet/wifi/señal…), le damos el
    // aviso y NO creamos ticket ni pingeamos al asesor (evita saturación). Emergencias
    // (fuego/humo) y comprobantes pendientes NO se tocan. Apagado = flujo idéntico a hoy.
    // Si hay testNumber, SOLO responde a ese número (para probar sin afectar a nadie más).
    const _incTest = incident.testNumber ? _last10(incident.testNumber) : '';
    if (incident.active && (!_incTest || _incTest === _last10(chatId))
        && !_emergencyNow && !_isBtn && !pendingImage.has(_pendKey) && !pendingDoc.has(_pendKey)
        && isOutageReport(text)) {
      addMessageToHistory(chatId, 'user', text);
      incidentAffected.add(String(chatId));
      const _zona = incident.zona ? ` en ${incident.zona}` : '';
      await sendMsg(chatId, `🔧 Ya estamos al tanto de una falla${_zona} y nuestro equipo técnico trabaja en repararla. Te avisaremos por aquí en cuanto se restablezca. Gracias por tu paciencia. 🙏 — León Telecom`);
      return;
    }

    // ===== Documento / PDF pendiente: ¿es comprobante? ¿a nombre de quién el servicio? =====
    const _pdoc = pendingDoc.get(_pendKey);
    if (_pdoc && Date.now() - (_pdoc.ts || 0) > 20 * 60 * 1000) {
      pendingDoc.delete(_pendKey);
    } else if (_pdoc && !_emergencyNow) {
      pendingDoc.delete(_pendKey);
      const noEs = _btnDocNo || /^no[\s.,!]*$|^(no es|no,)/.test(_pt);
      if (noEs) {
        await notifyAgentWithImage(chatId, _pdoc.userName, '📄 DOCUMENTO del cliente (dice que NO es comprobante)',
          ['Archivo: ' + _pdoc.fname, 'El cliente indica que no es un comprobante de pago.'],
          '', { docUrl: _pdoc.docUrl, docName: _pdoc.fname, caseType: 'documento' });
        pendingAgentRequests.set(_pendKey, { since: new Date(), name: _pdoc.userName, type: 'documento', stage: 0 });
        if (typeof schedulePersist === 'function') schedulePersist();
        await sendMsg(chatId, '✅ Listo, se lo envié a un asesor para revisarlo. En breve te contacta. 🙌');
        return;
      }
      // Lo que escribió es a nombre de quién está el servicio que paga.
      const titular = String(text || '').trim().slice(0, 120);
      await notifyAgentWithImage(chatId, _pdoc.userName, '💳 COMPROBANTE (PDF) del cliente',
        ['Archivo: ' + _pdoc.fname, '👤 Servicio a nombre de: ' + (titular || 'no especificado'), ...(titular ? [lineaCoincidencias(titular, normalizePhone(chatId))] : [])],
        '', { docUrl: _pdoc.docUrl, docName: _pdoc.fname, caseType: 'pago' });
      pendingAgentRequests.set(_pendKey, { since: new Date(), name: _pdoc.userName, type: 'pago', stage: 0 });
      if (typeof schedulePersist === 'function') schedulePersist();
      await sendMsg(chatId, '✅ ¡Gracias! Envié tu comprobante a un asesor. Se pondrá en contacto contigo para confirmar tu pago. 🙌');
      return;
    }

    // ===== Comprobante por imagen: confirmación / corrección de datos =====
    const _pend = pendingImage.get(_pendKey);
    if (_pend && Date.now() - (_pend.ts || 0) > 20 * 60 * 1000) {
      pendingImage.delete(_pendKey);
      if (_isBtn) {
        await sendMsg(chatId, '⌛ Ese comprobante ya expiró. Por favor mándame de nuevo la *foto del comprobante* y lo reviso al instante. 🙌');
        return;
      }
    } else if (_pend && !_emergencyNow) {
      // Envía el comprobante al asesor y actualiza el caso ya registrado (sin duplicarlo).
      const enviarComprobante = async (lines, headline) => {
        if (_pend.titular) lines = [...lines, '🧾 A nombre de (dicho por el cliente): ' + _pend.titular];
        await notifyAgentWithImage(chatId, _pend.userName, headline, lines, _pend.url, { caseType: 'pago', noLog: true });
        if (!updateCase(_pend.caseId, { resumen: headline + ' · ' + lines.join(' · ') })) {
          logCase(chatId, _pend.userName, 'pago', headline + ' · ' + lines.join(' · '), { imageUrl: _pend.url });
        }
        pendingAgentRequests.set(_pendKey, { since: new Date(), name: _pend.userName, type: 'pago', stage: 0 });
        if (typeof schedulePersist === 'function') schedulePersist();
      };
      // Pide (OBLIGATORIO) el nombre del titular del servicio antes de mandar el
      // comprobante al asesor — salvo que el cliente ya lo haya dicho por texto.
      const pedirTitular = async (lines, headline) => {
        if (_pend.titular) {   // ya lo dijo ("a nombre de X"): no preguntamos doble
          pendingImage.delete(_pendKey);
          await enviarComprobante(lines, headline);
          await sendMsg(chatId, '✅ ¡Gracias! Envié tu comprobante a un asesor. Se pondrá en contacto contigo para confirmar tu pago. 🙌');
          return;
        }
        _pend.stage = 'titular';
        _pend.lineasListas = lines;
        _pend.headlinePend = headline;
        _pend.ts = Date.now();   // renueva para que no expire a media pregunta
        pendingImage.set(_pendKey, _pend);
        await sendMsg(chatId, '👤 Una última cosa: ¿a *nombre de quién* está el servicio de internet que estás pagando?\n\n(El nombre del titular del contrato — puede ser diferente de quien hizo el pago.)');
      };
      const confirmarOriginal = async () => {
        const a = _pend.analysis || {};
        const lines = [
          '💳 Datos del comprobante (confirmados por el cliente):',
          '👤 Nombre: ' + (String(a.nombre || '').trim() || 'no especificado'),
          '💵 Monto: ' + (String(a.monto || '').trim() || 'no especificado')
        ];
        if (a.banco) lines.push('🏦 Banco/Operador: ' + a.banco);
        if (a.fecha) lines.push('📅 Fecha: ' + a.fecha);
        await pedirTitular(lines, '💳 COMPROBANTE DE PAGO');
      };
      if (_pend.stage === 'correccion') {
        // El cliente está corrigiendo: lo que escriba son el nombre y monto correctos.
        if (_btnSi) { await confirmarOriginal(); return; }
        if (_btnNo) {
          await sendMsg(chatId, '✍️ Escríbeme en un *solo mensaje* el nombre y el monto correctos.\n\nEjemplo: _Juan Pérez, $500_');
          return;
        }
        const raw = String(text || '').trim().slice(0, 200);
        if (!raw) return;
        const a = _pend.analysis || {};
        const montoM = raw.match(/\$\s*[\d,]+(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:pesos|mxn|mx)?\b/i);
        const monto = montoM ? montoM[0].trim() : '';
        const nombre = raw.replace(montoM ? montoM[0] : '', '').replace(/[,;:\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
        const lines = [
          '💳 Datos CORREGIDOS por el cliente:',
          '👤 Nombre: ' + (nombre || 'ver texto abajo'),
          '💵 Monto: ' + (monto || 'ver texto abajo'),
          '📝 Escribió: "' + raw + '"',
          '🤖 La IA había leído: ' + (String(a.nombre || '').trim() || '¿?') + ' / ' + (String(a.monto || '').trim() || '¿?')
        ];
        // Antes de mandarlo al asesor, falta el dato clave: el titular del servicio.
        await pedirTitular(lines, '💳 COMPROBANTE DE PAGO (corregido por el cliente)');
        return;
      }
      // ===== Etapa TITULAR: el cliente responde a nombre de quién está el servicio =====
      if (_pend.stage === 'titular') {
        if (_isBtn) { await sendMsg(chatId, '👤 Solo me falta el *nombre del titular* del servicio. Escríbemelo por favor 🙏'); return; }
        const titular = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
        if (titular.length < 3) { await sendMsg(chatId, '👤 ¿Me escribes el *nombre completo del titular* del servicio, por favor?'); return; }
        pendingImage.delete(_pendKey);
        const lines = [...(_pend.lineasListas || []), '🧾 Servicio a nombre de: ' + titular, lineaCoincidencias(titular, normalizePhone(chatId))];
        await enviarComprobante(lines, _pend.headlinePend || '💳 COMPROBANTE DE PAGO');
        await sendMsg(chatId, '✅ ¡Gracias! Envié tu comprobante a un asesor. Se pondrá en contacto contigo para confirmar tu pago. 🙌');
        return;
      }
      // Regex estrictos: solo respuestas cortas/explícitas disparan sí/no (evita que
      // "no me llega el internet" caiga como corrección).
      const yes = _btnSi || /^s[ií][\s.,!]*$|^(s[ií],|correcto|es correcto|asi es|así es|de acuerdo|👍|✅)/.test(_pt);
      const no = _btnNo || /^no[\s.,!]*$|^(corregir|incorrecto|esta mal|está mal|no es|no,|❌|👎)/.test(_pt);
      if (yes) { await confirmarOriginal(); return; }
      if (no) {
        _pend.stage = 'correccion';
        _pend.ts = Date.now(); // renueva el tiempo para que no expire a media corrección
        pendingImage.set(_pendKey, _pend);
        await sendMsg(chatId, 'De acuerdo 🙏 Escríbeme en un *solo mensaje* el nombre y el monto correctos.\n\nEjemplo: _Juan Pérez, $500_\n\nO si prefieres, mándame otra *foto más clara* del comprobante. 📸');
        return;
      }
      // Escribió otra cosa: dejamos la confirmación pendiente y seguimos el flujo normal.
    } else if (_isBtn) {
      // Botón de un comprobante viejo (ya procesado o expirado) → evitamos que la IA invente.
      await sendMsg(chatId, 'ℹ️ Ese comprobante ya fue procesado o expiró. Si necesitas enviar otro, mándame la *foto* y con gusto lo reviso. 🙌');
      return;
    }

    // If agent has taken over this chat, relay client message to the RIGHT agent.
    if (isPaused(chatId)) {
      const dest = agentHandling(chatId) || AGENT_WHATSAPP_NUMBER;
      if (dest) {
        const cp = getProfile(chatId);
        const clientName = nameOf(cp, chatId);
        try {
          await sendWhatsAppMessage(dest, `💬 ${clientName}:\n${text}`);
        } catch (e) { console.error('[Relay] Error forwarding to agent:', e.message); }
      }
      return;
    }

    const profile = getProfile(chatId);
    dataManager.registerUser(chatId, {
      name: (profile && profile.name) || 'Usuario',
      platform: 'whatsapp'
    });

    const session = getSession(chatId);
    addMessageToHistory(chatId, 'user', text);
    markClientActivity(chatId); // reinicia el reloj de inactividad para la promo

    // ===== EMERGENCIAS / FALLAS URGENTES (máxima prioridad) =====
    // Si el cliente ya estaba dando la ubicación de una emergencia, la procesamos.
    if (session.state === 'awaiting_emergency_location') {
      await finishEmergencyWithLocation(chatId, text, session.data, sendMsg);
      return;
    }
    // Detección directa: "se está quemando", chispas, poste/cable caído, etc.
    if (isEmergency(text)) {
      await handleEmergency(chatId, text, sendMsg);
      return;
    }

    // El cliente dice "a nombre de X" (titular del comprobante). Lo guardamos para
    // cotejarlo con la imagen; si viene con contexto de pago, le pedimos la foto/PDF.
    {
      const _tit = extractTitularName(text);
      if (_tit) {
        statedTitular.set(String(chatId), { name: _tit, ts: Date.now() });
        const contextoPago = /comprobante|dep[oó]sito|transferencia|pag(?:u|o|é|ar|ue)|abon|ficha/i.test(_pt);
        if (contextoPago) {
          await sendMsg(chatId, `¡Perfecto! 🙌 Anoté que el comprobante es a nombre de *${_tit}*.\n\nAhora mándame la *foto o PDF* del comprobante y lo reviso al instante. 📸`);
          return;
        }
      }
    }

    // Pregunta por el horario de atención → responder con la lista (sin romper el flujo)
    if (isHoursRequest(text)) {
      addMessageToHistory(chatId, 'bot', 'horario');
      await sendMsg(chatId, buildBusinessHoursMessage());
      return;
    }

    // Pide el TELÉFONO / número de contacto → dar el número REAL (nunca dejar que la IA
    // lo invente). Va aquí, junto al horario: emergencias, pagos y comprobantes ya se
    // resolvieron y retornaron más arriba, así que no les robamos el mensaje.
    if (isContactoRequest(text)) {
      const _msg = `📞 Con gusto. El número de contacto de León Telecom es *${LEON_CONTACT_NUMBER}*. También por aquí mismo puedo ayudarte. 🙌`;
      await sendMsg(chatId, _msg);   // sendMsg ya guarda en el historial
      return;
    }

    // Pregunta por la DIRECCIÓN / ubicación de la oficina → dar la dirección REAL
    // (OFFICE_ADDRESS), nunca dejar que la IA la invente.
    if (isUbicacionRequest(text)) {
      const _msg = `📍 Nuestra oficina está en: *${OFFICE_ADDRESS}*.\nHorario: ${BUSINESS_HOURS_SUMMARY}. Cualquier duda, al ${LEON_CONTACT_NUMBER}. 🙌`;
      await sendMsg(chatId, _msg);   // sendMsg ya guarda en el historial
      return;
    }

    // Saludo ("hola/buenas") → SIEMPRE el menú, al instante y sin depender de la IA.
    // (aunque haya una sesión activa: reinicia la conversación limpiamente)
    if (isGreetingMessage(text)) {
      await sendWelcomeMenu(chatId, sendMsg);
      return;
    }

    // Pregunta por productos/accesorios → mostrar FOTO y precio (en cualquier estado,
    // incluso después del menú). Antes esto se iba a la IA y a veces respondía mal.
    if (isProductRequest(text)) {
      await sendMsg(chatId, buildProductListText());
      return;
    }
    {
      const prodHits = findProducts(text);
      if (prodHits.length && !isTechnicalIssue(text) && !isAgentRequest(text) && !isMigrationRequest(text) && !isCameraRequest(text) && !isPlanRequest(text) && !wantsInternet(text)) {
        for (const p of prodHits.slice(0, 3)) {
          trackProductHit(p.id);
          await sendMsg(chatId, `🛍️ *${p.name}* — ${p.price}`, [getProductImageUrl(p)]);
        }
        await sendMsg(chatId, `¿Te interesa alguno? Te puedo pasar con un asesor para apartarlo. 😊\n\n🛒 Y si quieres ver *mucho más* (cámaras, redes, control de acceso…), checa nuestra *tienda en línea*:\n${STORE_URL}`);
        return;
      }
    }

    async function sendReplyObject(replyObj) {
      if (!replyObj.text) return;
      addMessageToHistory(chatId, 'bot', replyObj.text);
      const opts = {};
      if (replyObj.buttons) opts.buttons = replyObj.buttons;
      if (replyObj.listItems) opts.listItems = replyObj.listItems;
      if (replyObj.replyMarkup) opts.replyMarkup = replyObj.replyMarkup;
      await sendMsg(chatId, replyObj.text, replyObj.mediaUrls || [], opts);
    }

    function parseMenuChoice(input) {
      const v = normalizeText(input);
      if (/^1$|^1\b|\buno\b|ver planes|planes|paquetes|contratar/.test(v)) return 1;
      if (/^2$|^2\b|\bdos\b|camara|camaras|videovigilancia|cctv/.test(v)) return 2;
      if (/^3$|^3\b|\btres\b|reportar|problema|reporte|soporte|tecnico|falla/.test(v)) return 3;
      if (/^4$|^4\b|\bcuatro\b|hablar con|asesor|agente/.test(v)) return 4;
      if (/^5$|^5\b|\bcinco\b|migrar|migracion|migraci/.test(v)) return 5;
      if (/^6$|^6\b|\bseis\b|producto|productos|accesorio|accesorios/.test(v)) return 6;
      return null;
    }

    // ===== INTENT INTERRUPTION LAYER =====
    // Si el cliente está dentro de un flujo (eligió algo del menú) y luego pide
    // OTRA cosa, cambiamos al tema nuevo en vez de forzar su mensaje como respuesta
    // del flujo anterior. Funciona aun dentro de soporte/cámaras/asesor/migración.
    if (session.state && session.state !== 'awaiting_menu_choice') {
      const newIntent = detectNewIntent(text);
      const flow = currentFlow(session.state);
      if (newIntent && newIntent !== flow) {
        if (newIntent === 'migration') {
          setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
          await sendMsg(chatId, '¡Con gusto te ayudamos con la migración! ¿En cuál zona está el servicio ACTUAL?', [], {
            buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
          });
          return;
        }
        if (newIntent === 'camera') {
          setSession(chatId, { state: 'awaiting_camera_needs', data: {} });
          await sendMsg(chatId, 'Con gusto te asesoro en cámaras. ¿Qué espacio quieres vigilar y cuántas cámaras necesitas?');
          return;
        }
        if (newIntent === 'agent') {
          setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
          await sendMsg(chatId, '¿Cuál es tu nombre?');
          return;
        }
        if (newIntent === 'support') {
          if (isTechnicalIssue(text)) {
            // Ya describió la falla → no re-preguntar el síntoma
            await startReportFlow(chatId, text, sendMsg);
          } else {
            // Reporte genérico ("quiero reportar algo") → sí preguntamos qué pasa
            setSession(chatId, { state: 'awaiting_report', data: {} });
            await sendReplyObject(buildReportPrompt());
          }
          return;
        }
        if (newIntent === 'plan') {
          setSession(chatId, { state: 'awaiting_location', data: {} });
          await sendReplyObject(buildLocationPrompt());
          return;
        }
        if (newIntent === 'products') {
          clearSession(chatId);
          await sendMsg(chatId, buildProductListText());
          return;
        }
      }
    }
    // ===== END INTENT INTERRUPTION LAYER =====

    if (session.state === 'awaiting_menu_choice') {
      const choice = parseMenuChoice(text);
      if (choice === 1) { setSession(chatId, { state: 'awaiting_location', data: {} }); await sendReplyObject(buildLocationPrompt()); return; }
      if (choice === 2) {
        setSession(chatId, { state: 'awaiting_camera_needs', data: {} });
        await sendMsg(chatId, 'Con gusto te asesoramos en cámaras de seguridad. 📷\n¿Para qué espacio lo necesitas y cuántas cámaras tienes en mente?');
        return;
      }
      if (choice === 3 || text === 'sin_internet' || text === 'internet_lento' || text === 'va_y_viene') {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }
      if (choice === 4) { setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: text } }); await sendMsg(chatId, '¿Cuál es tu nombre?'); return; }
      if (choice === 5) {
        setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
        await sendMsg(chatId, '🔄 Migración de servicio\n¿En cuál zona está el servicio ACTUAL?', [], {
          buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
        });
        return;
      }
      if (choice === 6) { clearSession(chatId); await sendMsg(chatId, buildProductListText()); return; }
      /*
       * "No tengo internet" escrito en vez de tocar "3" es lo más normal del
       * mundo. Antes eso se le mandaba a la IA, y si la IA no contestaba el
       * cliente veía el menú otra vez, y otra, y otra. Lo obvio se atiende
       * aquí sin IA: una falla abre el reporte y "quiero un asesor" lo pide.
       */
      const intencionMenu = detectNewIntent(text);
      if (intencionMenu === 'support') {
        if (isTechnicalIssue(text)) await startReportFlow(chatId, text, sendMsg);
        else { setSession(chatId, { state: 'awaiting_report', data: {} }); await sendReplyObject(buildReportPrompt()); }
        return;
      }
      if (intencionMenu === 'agent') {
        setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: text } });
        await sendMsg(chatId, '¿Cuál es tu nombre?');
        return;
      }
      // Nothing matched — let AI handle it (same logic as default handler)
      const aiResult2 = await callMainAI(chatId, text);
      if (!aiResult2) { await sendReplyObject(buildFallbackReply(text)); return; }
      const knownName2 = nameOf(profile);
      if (aiResult2.action === 'show_plans') {
        const loc2 = aiResult2.location ? (detectLocation(aiResult2.location) || aiResult2.location) : null;
        if (aiResult2.message) await sendMsg(chatId, aiResult2.message);
        if (loc2) { updateProfile(chatId, { location: loc2 }); setSession(chatId, { state: 'awaiting_plan_selection', data: { location: loc2 } }); await sendReplyObject(buildPlanReplyForLocation(loc2)); }
        else { setSession(chatId, { state: 'awaiting_location', data: {} }); await sendReplyObject(buildLocationPrompt()); }
      } else if (aiResult2.action === 'show_support') {
        if (isTechnicalIssue(text)) {
          await startReportFlow(chatId, text, sendMsg); // ya dijo la falla → no re-preguntar
        } else {
          setSession(chatId, { state: 'awaiting_report', data: {} });
          await sendReplyObject(buildReportPrompt());
        }
      } else if (aiResult2.action === 'show_migration') {
        if (aiResult2.message) await sendMsg(chatId, aiResult2.message);
        setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
        await sendMsg(chatId, '¿En cuál zona está el servicio ACTUAL?', [], {
          buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
        });
      } else if (aiResult2.action === 'show_cameras') {
        if (aiResult2.message) await sendMsg(chatId, aiResult2.message);
        setSession(chatId, { state: 'awaiting_camera_needs', data: {} });
        await sendMsg(chatId, '¿Qué espacio quiere vigilar y cuántas cámaras necesita aproximadamente?');
      } else if (aiResult2.action === 'request_agent') {
        const isInfoQ = /\?|cuant|como|que |cual|donde|precio|plan|mbps|dispositiv|aparato|velocid|cuesta|instala|cubre|diferencia/i.test(text);
        if (isInfoQ) { if (aiResult2.message) await sendMsg(chatId, aiResult2.message); }
        else if (knownName2) { const n2 = await notifyAgentRequest(chatId, [`SOLICITUD ASESOR`, `Nombre: ${knownName2}`, `Motivo: ${text}`].join('\n'), '').catch(() => false); await sendMsg(chatId, agentNotifiedMsg(n2, knownName2)); }
        else { if (aiResult2.message) await sendMsg(chatId, aiResult2.message); setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: text } }); await sendMsg(chatId, '¿A qué nombre te contactamos?'); }
      } else { if (aiResult2.message) await sendMsg(chatId, aiResult2.message); }
      return;
    }

    // Camera button shortcuts (work from any state)
    if (text === 'cotizar_camara') {
      const cameraContext = session.data?.cameraContext || 'cámaras de seguridad';
      clearSession(chatId);
      setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: `Cotización: ${cameraContext}` } });
      await sendMsg(chatId, '¿A qué nombre realizamos la cotización?');
      return;
    }

    if (session.state === 'awaiting_camera_needs') {
      // Exit conditions — only if no real question in the message
      const hasRealQ = /\?|cuantos|cuanto|como |que |cual|dispositiv|camara|modelo|precio|diferencia|funciona|puede/.test(normalizeText(text));
      const goodbye = !hasRealQ && /\b(no gracias|no|ya no|solo preguntaba|nada|gracias nada mas|es todo|luego|despues|al rato|mas tarde|ahorita no|ahora no|por ahora no|lo pienso|pensarlo|mejor luego|mejor despues|deja(me)? pensarlo)\b/.test(normalizeText(text));
      if (goodbye) {
        clearSession(chatId);
        await sendMsg(chatId, 'Con gusto, aquí estamos cuando quieras. 😊');
        return;
      }

      const isBigProject = /\b(negoci|empresa|bodega|almacen|taller|local|cuatro|cinco|seis|siete|ocho|nueve|diez|\b[4-9]\b|\b1[0-9]\b|muchas|varios puntos)\b/.test(normalizeText(text));

      // Build conversation history for context
      const camHistory = getHistory(chatId).messages.slice(-6)
        .map(m => `${m.role === 'user' ? 'Cliente' : 'Leo'}: ${m.text}`)
        .join('\n');

      const cameraSystemPrompt = [
        'Eres Leo, asesor de cámaras de seguridad de León Telecom.',
        'Responde con la información EXACTA del catálogo. NO inventes precios, modelos ni especificaciones.',
        'Si no tienes el dato (ej: precio exacto), di que un asesor puede dar el detalle.',
        '',
        CAMERA_KNOWLEDGE,
        '',
        'Historial de la conversación:',
        camHistory || '(primera pregunta)',
        '',
        'Instrucciones:',
        '- Máximo 4 oraciones. Sin markdown. Texto plano.',
        '- Si el cliente ya sabe qué quiere o pregunta precio → termina con "¿Desea que un asesor le cotice?"',
        '- Si aún tiene dudas → responde y deja la puerta abierta para más preguntas.',
        '- Para 4+ cámaras o proyectos comerciales → recomienda visita técnica GRATUITA de Hikvision.',
        '- NUNCA inventes especificaciones no listadas en el catálogo.'
      ].join('\n');

      const rec = await callAI(cameraSystemPrompt, text, { temperature: 0.35, maxTokens: 300 }).catch(() => null);

      if (rec) {
        const camImages = getCameraImages((rec || '') + ' ' + text);
        await sendMsg(chatId, rec, camImages);
      }

      if (isBigProject) {
        const cameraContext = `Proyecto cámaras Hikvision: ${text}`;
        clearSession(chatId);
        setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: cameraContext } });
        await sendMsg(chatId, '¿A qué nombre agendamos la visita técnica gratuita?');
      } else {
        // Keep context and offer next step
        setSession(chatId, { state: 'awaiting_camera_needs', data: { cameraContext: text } });
        await sendMsg(chatId, '¿Le puedo ayudar con algo más o desea cotizar?', [], {
          buttons: [{ id: 'cotizar_camara', title: 'Quiero cotizar' }, { id: 'no gracias', title: 'Es todo, gracias' }]
        });
      }
      return;
    }

    if (session.state === 'awaiting_migration_current_location') {
      if (wantsToCancel(text)) { clearSession(chatId); await sendMsg(chatId, 'Sin problema. ¿En qué más puedo ayudarte?'); await sendReplyObject(buildMenuReply()); return; }
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_migration_current_details', data: { currentLocation: location } });
        await sendMsg(chatId, `¿En qué colonia, barrio o sección está la instalación ACTUAL en ${location}?\nIncluye referencias del domicilio (ej: Colonia Primera Sección, casa blanca frente a la cancha)`);
        return;
      }
      await sendMsg(chatId, '¿En cuál zona está el servicio ACTUAL?', [], {
        buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
      });
      return;
    }

    if (session.state === 'awaiting_migration_current_details') {
      if (wantsToCancel(text)) { clearSession(chatId); await sendMsg(chatId, 'Sin problema. ¿En qué más puedo ayudarte?'); await sendReplyObject(buildMenuReply()); return; }
      const d = session.data || {};
      const nbhd = searchAllNeighborhoods(text);
      setSession(chatId, { state: 'awaiting_migration_new_location', data: { ...d, currentDetails: text, currentNeighborhood: nbhd?.name || null } });
      await sendMsg(chatId, '¿A cuál zona quieres MIGRAR el servicio?', [], {
        buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
      });
      return;
    }

    if (session.state === 'awaiting_migration_new_location') {
      if (wantsToCancel(text)) { clearSession(chatId); await sendMsg(chatId, 'Sin problema. ¿En qué más puedo ayudarte?'); await sendReplyObject(buildMenuReply()); return; }
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_migration_new_details', data: { ...session.data, newLocation: location } });
        await sendMsg(chatId, `¿En qué colonia, barrio o sección estará la instalación NUEVA en ${location}?\nIncluye referencias del domicilio`);
        return;
      }
      await sendMsg(chatId, '¿A cuál zona quieres migrar?', [], {
        buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
      });
      return;
    }

    if (session.state === 'awaiting_migration_new_details') {
      if (wantsToCancel(text)) { clearSession(chatId); await sendMsg(chatId, 'Sin problema. ¿En qué más puedo ayudarte?'); await sendReplyObject(buildMenuReply()); return; }
      const d = session.data || {};
      const nbhd = searchAllNeighborhoods(text);
      const newData = { ...d, newDetails: text, newNeighborhood: nbhd?.name || null };
      const migKnownName = nameOf(profile);
      if (migKnownName) {
        const notifyText = buildMigrationNotification(newData, migKnownName);
        await notifyAgentRequest(chatId, notifyText, d.newLocation).catch(() => {});
        clearSession(chatId);
        await sendMsg(chatId, `✅ ¡Listo, ${migKnownName}! Solicitud de migración de ${d.currentLocation} → ${d.newLocation} registrada con todos los detalles. Un asesor te contactará pronto. 📞`);
      } else {
        setSession(chatId, { state: 'awaiting_migration_name', data: newData });
        await sendMsg(chatId, '¿A qué nombre está el servicio?');
      }
      return;
    }

    if (session.state === 'awaiting_migration_name') {
      if (wantsToCancel(text)) { clearSession(chatId); await sendMsg(chatId, 'Sin problema. ¿En qué más puedo ayudarte?'); await sendReplyObject(buildMenuReply()); return; }
      const d = session.data || {};
      updateProfile(chatId, { name: text });
      const notifyText = buildMigrationNotification(d, text);
      await notifyAgentRequest(chatId, notifyText, d.newLocation).catch(() => {});
      clearSession(chatId);
      await sendMsg(chatId, `✅ ¡Listo, ${text}! Solicitud de migración de ${d.currentLocation} → ${d.newLocation} registrada. Un asesor te contactará pronto. 📞`);
      return;
    }

    if (session.state === 'awaiting_location') {
      const location = detectLocation(text);
      if (location) {
        updateProfile(chatId, { location });
        setSession(chatId, { state: 'awaiting_plan_selection', data: { location } });
        await sendReplyObject(buildPlanReplyForLocation(location));
        return;
      }
      await sendMsg(chatId, 'No reconozco esa zona. Por favor escribe exactamente: Huitzo, Telixtlahuaca o Suchilquitongo.');
      return;
    }

    if (session.state === 'awaiting_plan_selection') {
      const v = normalizeText(text);

      // ¿Mencionó OTRA zona? (ej. estaba viendo Telixtlahuaca y dice "quiero en Huitzo")
      // → cambiar de zona y mostrar sus planes, en vez de tomarlo como selección.
      const mentionedZone = detectLocation(text);
      if (mentionedZone && mentionedZone !== session.data?.location) {
        updateProfile(chatId, { location: mentionedZone });
        setSession(chatId, { state: 'awaiting_plan_selection', data: { ...session.data, location: mentionedZone } });
        await sendReplyObject(buildPlanReplyForLocation(mentionedZone));
        return;
      }

      const hasQuestion = /\?|cuantos|cuanto|como |que |cual|dispositiv|aparato|velocid|mbps|puede|incluye|funciona|diferencia/.test(v);

      // Pure cancellation (no question content)
      if (!hasQuestion && /\b(no|solo preguntaba|solo info|solo queria|nada|luego|despues|no gracias)\b/.test(v)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Sin problema, aquí estamos cuando quieras. 😊');
        return;
      }

      // Question about plans → answer with AI, stay in this state
      if (hasQuestion) {
        const planZone2 = session.data?.location;
        const zPlans = planZone2 === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
        const plansInfo2 = zPlans.map(p => `${p.name} ${p.speed} ${p.price}`).join(', ');
        const qReply = await callAI([
          `Eres Leo, asesor de León Telecom. Responde la pregunta del cliente de forma natural y conversacional, como si hablaras con un conocido.`,
          `Zona del cliente: ${planZone2}. Planes disponibles en ${planZone2}: ${plansInfo2}.`,
          `Zonas: Huitzo = fibra óptica (Lite 30Mbps, Basic 80Mbps, Medium 150Mbps, Advanced 200Mbps, Ultra 300Mbps). Telixtlahuaca y Suchilquitongo = inalámbrico (15Mbps/$290, 20Mbps/$340, 30Mbps/$440).`,
          `INSTRUCCIONES:`,
          `1. Responde PRIMERO la pregunta directamente con información útil y específica. Ejemplo: si preguntan cuántos dispositivos, da una estimación práctica según el plan (ej: 30 Mbps alcanza bien para 4-5 dispositivos en uso normal, navegar redes, ver videos).`,
          `2. Si mencionan un plan que no existe en su zona, explícalo de forma amable y sugiere el equivalente disponible.`,
          `3. Termina con "¿Gustas que te pase con un asesor?" solo si la pregunta lo amerita.`,
          `Máximo 3 oraciones naturales. Sin listas, sin markdown, sin asteriscos.`
        ].join(' '),
          text, { temperature: 0.4, maxTokens: 200 }
        ).catch(() => null);
        await sendMsg(chatId, qReply || `En ${planZone2} los planes disponibles son: ${plansInfo2}. ¿Gustas que te pase con un asesor para más información?`);
        return; // Stay in awaiting_plan_selection
      }

      const location = session.data?.location;
      const plans = location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
      // Use word-boundary match to avoid "basico" matching "basic"
      const selectedPlan = plans.find(p =>
        new RegExp('\\b' + normalizeText(p.name).replace(/\s+/g, '\\s*') + '\\b').test(v) ||
        new RegExp('\\b' + normalizeText(p.speed).replace(/\s+/g, '\\s*') + '\\b').test(v)
      );
      // If plan found or user expressed interest → move to contact
      if (selectedPlan || /\b(si|sí|quiero|me interesa|ese|dale|ok|ese mismo|el primero|el ultimo|el mas|me gusta|contratar|el de|ese de|quiero ese|ese plan)\b/.test(v)) {
        const planData = selectedPlan
          ? { ...session.data, selectedPlan: selectedPlan.name, selectedSpeed: selectedPlan.speed, selectedPrice: selectedPlan.price }
          : session.data;
        const planLabel = selectedPlan ? `${selectedPlan.name} — ${selectedPlan.speed} — ${selectedPlan.price}` : '';
        setSession(chatId, { state: 'awaiting_contract_name', data: planData });
        await sendMsg(chatId,
          `¡Qué buena elección! 🎉${planLabel ? '\nPlan: ' + planLabel : ''}\n\n¿A qué nombre te contactamos para coordinar la instalación?`,
          [], { buttons: [{ id: 'solo_preguntaba', title: 'Solo preguntaba' }] }
        );
        return;
      }
      // User has a question about plans → AI answers with context
      const planZone = session.data?.location;
      const zonePlans = planZone === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
      const plansInfo = zonePlans.map(p => `${p.name} ${p.speed} ${p.price}`).join(', ');
      const aiReply = await callAI(
        `Eres Leo de León Telecom. Zona: ${planZone}. Planes disponibles: ${plansInfo}. Responde la pregunta del cliente sobre estos planes. Tono casual, máximo 2 oraciones. Solo texto, sin markdown.`,
        text, { temperature: 0.5, maxTokens: 150 }
      ).catch(() => null);
      if (aiReply) { await sendMsg(chatId, aiReply); }
      else { await sendMsg(chatId, `Aquí están los planes disponibles para ${planZone}. ¿Cuál te llama la atención?`); }
      return;
    }

    if (session.state === 'awaiting_contract_name') {
      const d = session.data || {};
      if (text === 'solo_preguntaba' || normalizeText(text).match(/\b(solo preguntaba|solo info|no gracias|solo informacion|nada mas|despues|luego|solo queria saber|solo curiosidad)\b/)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Ah, sin problema 😊 Cuando quieras contratar aquí estamos, cualquier duda me dices.');
        return;
      }
      // Si no parece un nombre (es una duda/pregunta), no lo guardamos como nombre.
      if (!looksLikeName(text)) {
        if (d.location) {
          setSession(chatId, { state: 'awaiting_plan_selection', data: d });
          await sendReplyObject(buildPlanReplyForLocation(d.location));
        } else {
          const ai = await callMainAI(chatId, text).catch(() => null);
          if (ai?.message) await sendMsg(chatId, ai.message);
          await sendMsg(chatId, 'Y para coordinar, ¿a qué nombre te contactamos?', [], { buttons: [{ id: 'solo_preguntaba', title: 'Solo preguntaba' }] });
        }
        return;
      }
      updateProfile(chatId, { name: text });
      const planLine = d.selectedPlan ? `Plan de interés: ${d.selectedPlan} (${d.selectedSpeed} — ${d.selectedPrice})` : '';
      try {
        await notifyAgentRequest(chatId, [
          `SOLICITUD DE INSTALACIÓN — NUEVO CLIENTE`,
          `Nombre: ${text}`,
          `Zona: ${d.location || 'no especificada'}`,
          planLine
        ].filter(Boolean).join('\n'), d.location || '');
      } catch (e) { console.error('Contract notify error:', e.message); }
      clearSession(chatId);
      await sendMsg(chatId, `Listo, ${text}. En breve un asesor de León Telecom te contactará por aquí para coordinar tu instalación. 📞`);
      return;
    }

    if (session.state === 'awaiting_recommendation_followup') {
      if (isAgentRequest(text)) {
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendMsg(chatId, '¿Cuál es tu nombre?');
        return;
      }
      const context = session.data || {};
      if (context.location && context.householdSize) {
        const reply = await generateFollowupRecommendationReply(context, text);
        const sanitized = (reply && reply.text) ? reply.text : String(reply || '');
        if (/^\s*(¡?hola\b|me alegra|gracias|estoy feliz)/i.test(sanitized)) {
          await sendMsg(chatId, 'Te confirmo la recomendación. ¿Quieres que programe un contacto con un asesor?');
          return;
        }
        await sendMsg(chatId, sanitized, reply.mediaUrls || []);
        return;
      }
      clearSession(chatId);
      await sendReplyObject(buildMenuReply());
      return;
    }

    if (session.state === 'awaiting_neighborhood_confirm') {
      const d = session.data || {};
      const yes = text === 'si_ubicacion' || normalizeText(text).match(/\b(si|sí|correcto|exacto|ese|esa|ahí)\b/);
      const no = text === 'no_ubicacion' || normalizeText(text).match(/\b(no|incorrecto|otra|otro)\b/);
      if (yes) {
        updateProfile(chatId, { location: d.detectedZone });
        const knownName = nameOf(profile);
        if (knownName) {
          const notified = await notifyAgentRequest(chatId, [
            `REPORTE DE FALLA`,
            `Nombre: ${knownName}`,
            `Problema: ${d.problemDescription}`,
            `Ubicación: ${d.detectedNeighborhood}, ${d.detectedZone}`
          ].join('\n'), d.detectedZone).catch(() => false);
          try { createTicket(chatId, knownName, d.problemDescription, `${d.detectedNeighborhood}, ${d.detectedZone}`); } catch (_) {}
          clearSession(chatId);
          await sendMsg(chatId, notified
            ? `Listo, ${knownName}. Ya le avisamos a un técnico con la ubicación (${d.detectedNeighborhood}). Te contactarán pronto. 🔧`
            : `Entendido. En un momento un técnico revisará el problema en ${d.detectedNeighborhood}. 🔧`);
        } else {
          setSession(chatId, { state: 'awaiting_report_name', data: { problemDescription: d.problemDescription, neighborhood: d.detectedNeighborhood, zone: d.detectedZone } });
          await sendMsg(chatId, '¿A qué nombre está el servicio?');
        }
      } else if (no) {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendMsg(chatId, 'Entendido. ¿Qué tipo de problema tienes con el internet?', [], {
          buttons: [{ id: 'sin_internet', title: 'Sin internet' }, { id: 'internet_lento', title: 'Muy lento' }, { id: 'va_y_viene', title: 'Va y viene' }]
        });
      } else {
        await sendMsg(chatId, '¿Es esa la ubicación correcta?', [], { buttons: [{ id: 'si_ubicacion', title: 'Sí, es ahí' }, { id: 'no_ubicacion', title: 'No, es otra' }] });
      }
      return;
    }

    if (session.state === 'awaiting_report') {
      if (wantsToCancel(text)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Sin problema. ¿En qué más te puedo ayudar?');
        await sendReplyObject(buildMenuReply());
        return;
      }
      const problemMap = { sin_internet: 'Sin internet', internet_lento: 'Internet muy lento', va_y_viene: 'Internet intermitente (va y viene)' };
      const problemDescription = problemMap[text] || text;

      let advice = null;
      try {
        advice = await callAI(
          'Eres Leo de León Telecom. Da 1-2 pasos concretos para intentar solucionar el problema antes de que llegue el técnico. Tono profesional y amable. Máximo 2 oraciones. Solo texto, sin markdown.',
          `Problema: ${problemDescription}`,
          { temperature: 0.4, maxTokens: 120 }
        );
      } catch (e) { /* fall through */ }

      if (advice) await sendMsg(chatId, advice);

      const reportKnownName = nameOf(profile);
      // Always ask for location + references for accurate dispatch
      setSession(chatId, { state: 'awaiting_report_location', data: { problemDescription, knownName: reportKnownName } });
      await sendMsg(chatId, '¿En qué colonia o barrio es el problema y cuáles son las referencias del domicilio? (ej: Colonia Centro, cerca de la iglesia)');
      return;
    }

    if (session.state === 'awaiting_report_location') {
      if (wantsToCancel(text)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Sin problema. ¿En qué más te puedo ayudar?');
        await sendReplyObject(buildMenuReply());
        return;
      }
      const d = session.data || {};
      // Try to find neighborhood in text
      const nbhd = searchAllNeighborhoods(text);
      const locationLine = nbhd ? `${nbhd.name}, ${nbhd.zone}` : text;

      if (d.knownName) {
        await notifyAgentRequest(chatId, [
          `REPORTE DE FALLA`,
          `Nombre: ${d.knownName}`,
          `Problema: ${d.problemDescription}`,
          `Ubicación: ${locationLine}`
        ].join('\n'), nbhd?.zone || '').catch(() => {});
        let folioTk = '';
        try { folioTk = (createTicket(chatId, d.knownName, d.problemDescription, locationLine) || {}).folio || ''; } catch (_) {}
        clearSession(chatId);
        // El folio va en el mensaje: es lo que el cliente dice cuando llama a preguntar.
        await sendMsg(chatId, `Listo, ${d.knownName}. Registramos tu reporte en ${locationLine}${folioTk ? ` con folio *${folioTk}*` : ''}. Un técnico te contactará pronto. 🔧`);
      } else {
        setSession(chatId, { state: 'awaiting_report_name', data: { ...d, locationLine } });
        await sendMsg(chatId, '¿A qué nombre está el servicio?');
      }
      return;
    }

    if (session.state === 'awaiting_report_name') {
      if (wantsToCancel(text)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Sin problema. ¿En qué más te puedo ayudar?');
        await sendReplyObject(buildMenuReply());
        return;
      }
      const d = session.data || {};
      updateProfile(chatId, { name: text });
      const nbhd = d.locationLine ? searchAllNeighborhoods(d.locationLine) : null;
      const locationLine = d.locationLine || '';
      const notified = await notifyAgentRequest(chatId, [
        `REPORTE DE FALLA`,
        `Nombre: ${text}`,
        `Problema: ${d.problemDescription}`,
        locationLine ? `Ubicación: ${locationLine}` : ''
      ].filter(Boolean).join('\n'), nbhd?.zone || '').catch(() => false);
      try { createTicket(chatId, text, d.problemDescription, locationLine); } catch (_) {}
      clearSession(chatId);
      await sendMsg(chatId, notified
        ? `Listo, ${text}. Ya le avisamos a un técnico, te contactarán pronto. 🔧`
        : `Anotado, ${text}. En un momento un técnico se pondrá en contacto contigo. 🔧`);
      return;
    }

    if (session.state === 'awaiting_agent_name') {
      if (wantsToCancel(text)) {
        clearSession(chatId);
        await sendMsg(chatId, 'Sin problema. ¿En qué más te puedo ayudar?');
        await sendReplyObject(buildMenuReply());
        return;
      }
      const d = session.data || {};
      // Si no parece un nombre (es una duda), respondemos y volvemos a pedir el nombre.
      if (!looksLikeName(text)) {
        const ai = await callMainAI(chatId, text).catch(() => null);
        if (ai?.message) await sendMsg(chatId, ai.message);
        await sendMsg(chatId, 'Con gusto. ¿A qué nombre te contactamos para que un asesor te atienda?');
        return;
      }
      updateProfile(chatId, { name: text });
      // If we already have context from initialRequest, notify immediately
      if (d.initialRequest) {
        clearSession(chatId);
        const notified = await notifyAgentRequest(chatId, [`SOLICITUD DE ASESOR`, `Nombre: ${text}`, `Motivo: ${d.initialRequest}`].join('\n'), '').catch(() => false);
        await sendMsg(chatId, agentNotifiedMsg(notified, text));
      } else {
        setSession(chatId, { state: 'awaiting_agent_need', data: { ...d, agentName: text } });
        await sendMsg(chatId, '¿En qué te podemos ayudar?');
      }
      return;
    }

    if (session.state === 'awaiting_agent_need') {
      const d = session.data || {};
      clearSession(chatId);
      const notified = await notifyAgentRequest(chatId, [`SOLICITUD DE ASESOR`, `Nombre: ${d.agentName}`, `Necesidad: ${text}`].join('\n'), '').catch(() => false);
      await sendMsg(chatId, agentNotifiedMsg(notified, d.agentName));
      return;
    }

    if (session.state === 'awaiting_folio_to_cancel') {
      if (normalizeText(text).match(/\b(volver|back|atras|menu)\b/)) {
        clearSession(chatId);
        setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
        await sendMsg(chatId, 'Ok, regresando al menú. 👋');
        await sendReplyObject(buildMenuReply());
        return;
      }
      const folioInput = normalizeText(text).toUpperCase();
      const folio = retrieveFolio(folioInput);
      if (folio) {
        cancelFolio(folioInput);
        clearSession(chatId);
        setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
        await sendMsg(chatId, `✅ Cita cancelada correctamente.\n\nFolio ${folioInput} ha sido eliminado.\nCuando quieras agendar de nuevo, me avisas. 👍`);
        await sendReplyObject(buildMenuReply());
      } else {
        await sendMsg(chatId, `❌ No encontré ese folio en el sistema.\n\nVerifica que esté correcto. (ej: LT-12345-ABCDE)\no escribe "volver" para regresar al menú.`);
      }
      return;
    }

    // Default: no session state
    if (isGreetingMessage(text)) {
      await sendWelcomeMenu(chatId, sendMsg);
      return;
    }

    // Cierre de conversación → despedida + producto destacado (vitrina)
    if (isClosing(text)) {
      await sendMsg(chatId, '¡Con gusto! Que tengas excelente día. 🙌');
      try { await sendProductHighlight(chatId, sendMsg); } catch (e) {}
      markPromoSent(chatId); // ya se promocionó; evita el promo por inactividad
      clearSession(chatId);
      return;
    }

    // Productos / vitrina (lista general o producto específico)
    if (isProductRequest(text)) {
      await sendMsg(chatId, buildProductListText());
      return;
    }
    const prodMatches = findProducts(text);
    if (prodMatches.length && !isTechnicalIssue(text) && !isAgentRequest(text) && !isPlanRequest(text) && !isMigrationRequest(text) && !isCameraRequest(text)) {
      for (const p of prodMatches.slice(0, 3)) {
        trackProductHit(p.id);
        await sendMsg(chatId, `🛍️ *${p.name}* — ${p.price}`, [getProductImageUrl(p)]);
      }
      await sendMsg(chatId, '¿Quieres apartar alguno? Te puedo pasar con un asesor. 😊');
      return;
    }

    // Quiere internet/planes → flujo estructurado (pregunta zona con BOTONES y
    // luego muestra planes con FOTO). No dejamos que la IA lo conteste en texto.
    if (wantsInternet(text)) {
      const loc0 = detectLocation(text);
      if (loc0) {
        updateProfile(chatId, { location: loc0 });
        setSession(chatId, { state: 'awaiting_plan_selection', data: { location: loc0 } });
        await sendReplyObject(buildPlanReplyForLocation(loc0));
      } else {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
      }
      return;
    }

    // No session — Claude as the brain
    const aiResult = await callMainAI(chatId, text);
    if (!aiResult) { setSession(chatId, { state: 'awaiting_menu_choice', data: {} }); await sendReplyObject(buildMenuReply()); return; }

    const knownName = nameOf(profile);

    if (aiResult.action === 'show_plans') {
      // Solo usamos la zona si el cliente la menciona EN ESTE mensaje (no asumir
      // la del perfil ni la que invente la IA). Si no, abajo se le pregunta la zona.
      const loc = detectLocation(text);

      const wantsContract = /\b(quiero contratar|quiero el servicio|me interesa|dale|lo quiero|ya quiero)\b/i.test(text);
      if (wantsContract && loc && knownName) {
        await notifyAgentRequest(chatId, [`SOLICITUD DE INSTALACIÓN`, `Nombre: ${knownName}`, `Zona: ${loc}`].join('\n'), loc).catch(() => {});
        clearSession(chatId);
        await sendMsg(chatId, `Listo, ${knownName}. Ya le avisamos a un asesor para coordinar la instalación en ${loc}. 📞`);
      } else if (wantsContract && loc) {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        setSession(chatId, { state: 'awaiting_contract_name', data: { location: loc } });
        await sendMsg(chatId, '¿A qué nombre te contactamos?', [], { buttons: [{ id: 'solo_preguntaba', title: 'Solo preguntaba' }] });
      } else if (loc) {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        updateProfile(chatId, { location: loc });
        setSession(chatId, { state: 'awaiting_plan_selection', data: { location: loc } });
        await sendReplyObject(buildPlanReplyForLocation(loc));
      } else {
        // No mencionó zona → NO mandamos el mensaje de la IA (que tiende a adivinar);
        // solo preguntamos la zona directamente.
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
      }

    } else if (aiResult.action === 'show_support') {
      // Emergencia detectada por la IA → escalar directo a un técnico, sin preguntas de más
      if (aiResult.urgent || isEmergency(text)) {
        await handleEmergency(chatId, text, sendMsg);
        return;
      }
      // El cliente YA describió el problema → no re-preguntamos el síntoma.
      await startReportFlow(chatId, text, sendMsg);

    } else if (aiResult.action === 'show_migration') {
      if (aiResult.message) await sendMsg(chatId, aiResult.message);
      setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
      await sendMsg(chatId, '¿En cuál zona está el servicio ACTUAL?', [], {
        buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
      });

    } else if (aiResult.action === 'show_cameras') {
      if (aiResult.message) await sendMsg(chatId, aiResult.message);
      setSession(chatId, { state: 'awaiting_camera_needs', data: {} });
      await sendMsg(chatId, '¿Para qué espacio lo necesita y cuántas cámaras tiene en mente?');

    } else if (aiResult.action === 'request_agent') {
      // Safety check: if it looks like an informational question, treat as null
      const isInfoQuestion = /\?|cuant|cuant|como|que |cual|donde|cuando|por que|precio|plan|mbps|megas|dispositiv|aparato|velocid|cuesta|instala|cubre|cobertura|diferencia/i.test(text);
      if (isInfoQuestion) {
        // AI misclassified — just answer the question
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
      } else if (knownName) {
        const notified = await notifyAgentRequest(chatId, [`SOLICITUD DE ASESOR`, `Nombre: ${knownName}`, `Motivo: ${text}`].join('\n'), '').catch(() => false);
        await sendMsg(chatId, agentNotifiedMsg(notified, knownName));
      } else {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: text } });
        await sendMsg(chatId, '¿A qué nombre te contactamos?');
      }

    } else {
      // null — just the AI response
      if (aiResult.message) await sendMsg(chatId, aiResult.message);
    }
  } catch (error) {
    console.error('Message handling error:', error.message);
    try {
      await sendMsg(chatId, 'Tu mensaje llegó, pero hubo un error al procesarlo. Intenta de nuevo en unos segundos.');
    } catch (sendError) {
      console.error('Fallback send error:', sendError.message);
    }
  }
}

/*
 * A dónde regresa el cliente después de dar sus datos en Stripe.
 *
 * Antes el `return_url` apuntaba a la raíz del servidor, que contesta JSON.
 * Alguien terminaba de llenar un formulario largo con su RFC y su cuenta de
 * banco, y aterrizaba en `{"ok":true,"service":"leontelecom-server"}`. Cualquiera
 * pensaría que falló, y lo primero que haría es hablar preguntando si su
 * información se perdió.
 */
const sinCacheCobro = (_req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); };
app.get('/cuenta-cobro', sinCacheCobro, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'cuenta-cobro.html'), { cacheControl: false }));

/*
 * El estado de la cuenta, SIN sesión.
 *
 * Quien llega a /cuenta-cobro viene del sitio de Stripe, no del panel, y no
 * trae token. Sin esta ruta, esa pantalla no puede saber si quedó y tiene que
 * decirle "listo" a ciegas, que es justo lo que hacía.
 *
 * Solo contesta dos cosas: si esa cuenta ya puede cobrar y qué le falta. No
 * dice el id de la cuenta, ni el banco, ni nada que sirva a un tercero.
 */
async function revisarCuentaLeon() {
  if (!stripeLeon.hayLlave() || !stripeLeon.cuentaConectada()) return;
  try {
    const est = await stripeLeon.estadoCuenta();
    if (!est.puedeCobrar) {
      console.warn('[cobro] la cuenta de León NO puede cobrar ahora mismo. Falta:',
        (est.faltante || []).join(', ') || 'sin detalle');
    }
  } catch (e) {
    /*
     * Se distingue "Stripe dice que esa cuenta ya no sirve" de "no se pudo
     * hablar con Stripe", porque piden lo contrario. Un 4xx significa que la
     * cuenta se borró o se desconectó y hay que dejar de cobrar contra ella.
     * Cualquier otra cosa es un tropiezo, y apagar el cobro por un tropiezo de
     * un minuto es peor que el tropiezo.
     */
    if (e.status >= 400 && e.status < 500) {
      console.error('[cobro] Stripe ya no reconoce la cuenta de León:', e.message);
      stripeLeon.olvidarCuenta();
    } else {
      console.warn('[cobro] no se pudo revisar la cuenta, se deja como estaba:', e.message);
    }
  }
}

/*
 * Prórrogas desde el panel: verlas, darlas y quitarlas. Lo mismo que el
 * asesor hace por WhatsApp con PRORROGA, pero con la lista a la vista.
 */
/* Comprobantes que esperan revisión, y darlos por buenos desde el panel. */
app.get('/admin/api/comprobantes', verifyAdminToken, (_req, res) => {
  const lista = caseLog.filter((c) => c.type === 'pago' && c.status === 'pendiente').slice(0, 100)
    .map((c) => {
      // El titular al que hay que abonarle: el que coincide en el padrón, o quien escribió.
      const telTitular = (String(c.resumen || '').match(/Coincide: [^·\n]+· (\d{12})/) || [])[1] || c.clientId;
      const w = wisphubClients.get(telTitular) || {};
      // Lo que urge: el corte del titular es hoy o mañana, ya está suspendido, o su cobro automático está esperando esta revisión.
      const corteT = parseFechaCorte(w.fechaCorte);
      const urgencia = /suspend|cort/i.test(String(w.status || '')) ? 'suspendido'
        : corteT && corteT <= fechaLocalISO() ? 'corte hoy'
        : corteT && corteT === fechaMasDias(1) ? 'corte mañana' : '';
      const autoEspera = !!((stripeClientes.get(telTitular) || {}).cobroAutomatico && corteT && (((autoCobros[telTitular] || {})[corteT]) || {}).avisadoRevision && !(((autoCobros[telTitular] || {})[corteT]) || {}).estado);
      return { id: c.id, ts: c.ts, telefono: c.clientId, nombre: c.name || (wisphubClients.get(c.clientId) || {}).name || '', resumen: String(c.resumen || '').slice(0, 400), imageUrl: c.imageUrl || '', docUrl: c.docUrl || '', fueraDeHorario: !!c.offHours,
        titular: { telefono: telTitular, nombre: w.name || '', wisphubId: w.wisphubId || null, corte: corteT || '' }, urgencia, autoEspera };
    })
    // Los urgentes primero; entre iguales, el más viejo arriba.
    .sort((a, b) => ((b.urgencia || b.autoEspera) ? 1 : 0) - ((a.urgencia || a.autoEspera) ? 1 : 0) || String(a.ts).localeCompare(String(b.ts)));
  res.json({ comprobantes: lista, total: lista.length, urgentes: lista.filter((x) => x.urgencia || x.autoEspera).length });
});
app.post('/admin/api/comprobantes/:id/recibido', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  const c = caseLog.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Ese comprobante ya no está' });
  if (c.status !== 'pendiente') return res.json({ ok: true, yaEstaba: true });
  const rc = await confirmarPagoRecibido(c.clientId, (req.admin && req.admin.username) || 'panel');
  res.json({ ok: true, ...rc });
});

app.get('/admin/api/prorrogas', verifyAdminToken, (_req, res) => {
  const hoy = fechaLocalISO();
  const lista = Object.entries(prorrogas)
    .filter(([, p]) => p && p.hasta >= hoy)
    .map(([tel, p]) => ({ telefono: tel, nombre: (wisphubClients.get(tel) || {}).name || '', ...p,
      // Quién la dio, con palabras: "asesor …1234" si fue por WhatsApp, el usuario si fue por el panel.
      porTexto: /^\d{10,13}$/.test(String(p.por || '')) ? `asesor por WhatsApp (…${String(p.por).slice(-4)})` : (p.por || 'panel'),
      // Cuántos días le quedan, si ya pagó mientras tanto y si ya se le recordó que vence.
      restan: Math.round((new Date(p.hasta + 'T12:00:00').getTime() - new Date(hoy + 'T12:00:00').getTime()) / 86400000),
      yaPago: !!pagoRecienteDe(tel),
      avisado: !!corteReminders[`${tel}|prorroga|${p.hasta}`] }))
    .sort((a, b) => a.hasta.localeCompare(b.hasta));
  res.json({ prorrogas: lista, total: lista.length });
});
app.post('/admin/api/prorrogas', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  const tel = normalizePhone(String((req.body || {}).telefono || ''));
  const dias = Number((req.body || {}).dias || 0);
  if (!tel || tel.length < 12) return res.status(400).json({ error: 'Falta el teléfono' });
  if (!(dias >= 1 && dias <= 31)) return res.status(400).json({ error: 'Los días van de 1 a 31' });
  const p = darProrroga(tel, dias, (req.admin && req.admin.username) || 'panel', (req.body || {}).motivo);
  // Desde el panel también se le avisa al cliente (salvo que la oficina diga que no).
  let avisado = false;
  if (!(req.body || {}).sinAviso) {
    try { await avisarProrroga(tel, p); avisado = true; } catch (e) { console.warn('[prorroga] no se pudo avisar a', tel, '·', e.message); }
  }
  res.json({ ok: true, telefono: tel, avisado, ...p });
});
app.delete('/admin/api/prorrogas/:telefono', verifyAdminToken, requirePermission('clients'), (req, res) => {
  const tel = normalizePhone(String(req.params.telefono || ''));
  const habia = !!prorrogas[tel];
  delete prorrogas[tel];
  schedulePersist();
  res.json({ ok: true, habia });
});

app.get('/api/cuenta-cobro/estado', async (_req, res) => {
  try {
    if (!stripeLeon.hayLlave() || !stripeLeon.cuentaConectada()) {
      return res.json({ ok: true, existe: false, puedeCobrar: false, faltante: [] });
    }
    const est = await stripeLeon.estadoCuenta();
    res.json({
      ok: true, existe: true,
      puedeCobrar: !!est.puedeCobrar,
      faltante: (est.faltante || []).slice(0, 6),
      // Sin plantilla, los avisos que el bot manda por su cuenta (cobro
      // automático, ¿ya quedó?, pago por otro) no llegan fuera de las 24 h.
      plantillaAvisos: !!WHATSAPP_AVISO_TEMPLATE,
    });
  } catch (e) {
    console.warn('[cobro] estado público:', e.message);
    res.json({ ok: false, existe: true, puedeCobrar: false, faltante: [] });
  }
});

/*
 * SOLO PARA PRUEBAS (PRUEBAS=1). Envejece la sesión de un chat para comprobar
 * que lo que alguien dijo hace media hora ya no cuenta, sin esperar media hora.
 * En producción esta ruta no existe.
 */
if (process.env.PRUEBAS === '1') {
  // Simula que pasó un mes: se olvidan los pagos recientes de un teléfono.
  app.post('/api/pruebas/envejecer-pagos', (req, res) => {
    // Hace que los pagos en línea de un cliente parezcan de hace N días (se acumula).
    const tel = normalizePhone(String((req.body || {}).telefono || ''));
    const ms = (Number((req.body || {}).dias) || 0) * 86400000;
    for (const p of stripePagosRecientes.get(tel) || []) p.cuando -= ms;
    res.json({ ok: true, pagos: (stripePagosRecientes.get(tel) || []).map((p) => ({ canal: p.canal, hace: Math.round((Date.now() - p.cuando) / 86400000) })) });
  });
  app.post('/api/pruebas/cubre', (req, res) => {
    // ¿El último pago de este cliente cubre el corte de hoy/mañana, y el que se pida?
    const tel = normalizePhone(String((req.body || {}).telefono || ''));
    const corte = parseFechaCorte((wisphubClients.get(tel) || {}).fechaCorte) || fechaLocalISO();
    res.json({ esteCorte: !!pagoRecienteDe(tel, corte), siguienteCorte: !!pagoRecienteDe(tel, String((req.body || {}).corte || '')) });
  });
  app.post('/api/pruebas/olvidar-pagos', (req, res) => {
    const tel = normalizePhone(String((req.body || {}).telefono || ''));
    stripePagosRecientes.delete(tel);
    for (const c of caseLog) if (c.clientId === tel && c.type === 'pago') c.status = 'viejo';
    res.json({ ok: true });
  });
  app.post('/api/pruebas/auto-estado', (req, res) => {
    // Deja el cobro automático de un cliente en el estado que se pida (p. ej. rechazado).
    const tel = normalizePhone(String((req.body || {}).telefono || ''));
    const corte = parseFechaCorte((wisphubClients.get(tel) || {}).fechaCorte);
    if (!tel || !corte) return res.status(400).json({ error: 'sin cliente o sin corte' });
    const log = autoCobros[tel] || (autoCobros[tel] = {});
    log[corte] = { ...(log[corte] || {}), estado: String((req.body || {}).estado == null ? 'rechazado' : req.body.estado) };
    res.json({ ok: true, corte });
  });
  app.post('/api/pruebas/ya-quedo', async (req, res) => {
    // Envejece los reportes abiertos y pregunta.
    const dias = Number((req.body || {}).dias || 4);
    for (const t of tickets.values()) if (t.estado !== 'resuelto') t.createdAt = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
    res.json(await preguntarSiYaQuedo(true));
  });
  app.post('/api/pruebas/cobro-automatico', async (_req, res) => {
    res.json(await barrerCobroAutomatico(true));
  });
  app.post('/api/pruebas/envejecer-sesion', (req, res) => {
    const tel = normalizePhone(String((req.body || {}).telefono || ''));
    const ms = Number((req.body || {}).ms || 0);
    const ses = getSession(tel);
    if (!ses.state) return res.json({ ok: false, motivo: 'sin sesión' });
    setSession(tel, { ...ses, data: { ...(ses.data || {}), desde: Date.now() - ms } });
    res.json({ ok: true, estado: ses.state });
  });
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'leontelecom-server' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Get chat history context (ready for WhatsApp or other channels)
app.get('/chat/:chatId/history', (req, res) => {
  const { chatId } = req.params;
  const context = getFullChatContext(chatId);
  res.json(context);
});

// Get recent messages from a chat (last 10)
app.get('/chat/:chatId/recent', (req, res) => {
  const { chatId } = req.params;
  const history = getHistory(chatId);
  res.json({
    chatId: String(chatId),
    recentMessages: history.messages.slice(-10),
    totalMessages: history.messages.length
  });
});

// ==================== TELEGRAM WEBHOOK (legacy, optional) ====================
app.post('/webhook', async (req, res) => {
  const update = req.body || {};
  const message = update.message;
  res.sendStatus(200);

  if (!message) return;
  const chatId = String(message.chat?.id || '');
  if (!chatId) return;

  const userName = message.from?.first_name || 'Usuario';

  // Handle photo/image uploads
  if (message.photo && message.photo.length > 0) {
    try {
      if (!TELEGRAM_API_BASE) return;
      const photo = message.photo[message.photo.length - 1];
      const fileResponse = await fetch(`${TELEGRAM_API_BASE}/getFile?file_id=${photo.file_id}`);
      const fileData = await fileResponse.json();
      if (!fileData.ok) { await sendTelegramMessage(chatId, '❌ No pude descargar la imagen. Intenta de nuevo.'); return; }
      const imageResponse = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`);
      const imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
      await handleIncomingImage(chatId, userName, imageBase64, 'telegram', sendTelegramMessage);
    } catch (err) {
      console.error('[Telegram] Image error:', err.message);
      try { await sendTelegramMessage(chatId, '❌ Error al procesar la imagen. Intenta de nuevo.'); } catch (_) {}
    }
    return;
  }

  if (typeof message.text !== 'string') return;
  await handleChatMessage(chatId, message.text.trim(), sendTelegramMessage);
});

// ==================== WHATSAPP WEBHOOK ====================

/*
 * MAQUETA — webhook de Stripe. Confirma que el pago de la mensualidad de un
 * cliente piloto entró de verdad, y avisa por WhatsApp sin que un asesor tenga
 * que revisar un comprobante a mano.
 *
 * Vive en la MISMA plataforma de Stripe que Aforo: un aviso con `account`
 * (evento.account) viene de OTRA cuenta conectada firmando con el mismo
 * secreto del endpoint, no de la nuestra — se ignora, igual que en
 * aforo/server.js. Sin este filtro, cualquier organizador de Aforo con acceso
 * a su propio Stripe podría fabricar un aviso que reactive gratis a un cliente
 * de León Telecom.
 */
/*
 * Avisos de Stripe ya procesados, para no repetir el trabajo cuando Stripe
 * reintenta. Se limpia solo: un aviso de hace más de un día ya no va a volver.
 */
const stripeVistos = new Map();
setInterval(() => {
  const limite = Date.now() - 24 * 3600 * 1000;
  for (const [id, t] of stripeVistos) if (t < limite) stripeVistos.delete(id);
}, 3600 * 1000).unref();

/*
 * Los pagos recientes de cada teléfono.
 *
 * Existe para cazar el PAGO DOBLE ENTRE CANALES, que es fácil de hacer sin
 * mala intención: el cliente saca su ficha de OXXO el lunes, se impacienta y el
 * martes transfiere a su CLABE, y el miércoles alguien va y paga la ficha. Los
 * dos pagos entran de verdad y son dos cargos reales.
 *
 * No se bloquea nada: hay motivos legítimos para pagar dos veces en un mes (dos
 * mensualidades atrasadas, o un vecino que paga sin avisar). Se detecta y se
 * avisa, que es lo que permite devolverle su dinero a alguien antes de que se
 * enoje, en vez de enterarse cuando reclama.
 */
/*
 * Las facturas que la oficina todavía tiene que marcar como pagadas.
 *
 * La API de Wisphub no permite marcarlas (`estado` es de solo lectura y no hay
 * endpoint de pagos), así que el cliente paga, se reconecta solo, pero su
 * factura sigue apareciendo como deuda. Eso no es cosmética: con la factura
 * pendiente le siguen llegando recordatorios de corte y en el siguiente ciclo
 * es candidato a que lo vuelvan a suspender. Marcarla es lo que hace que la
 * reconexión se sostenga.
 *
 * Se junta aquí y se entrega en el resumen matutino, en una sola pasada. Los
 * avisos sueltos de madrugada se pierden entre sí; una lista a la hora de
 * abrir, no.
 */
let stripeRegistrosPendientes = [];   // [{ factura, total, nombre, telefono, idServicio, cuando, tipo }]
const REGISTRO_PENDIENTE_MAX = 200;

function anotarRegistroPendiente(reg) {
  // Sin duplicar: el mismo pago puede llegar por dos avisos de Stripe.
  const clave = `${reg.tipo}:${reg.factura || reg.telefono}`;
  if (stripeRegistrosPendientes.some((r) => `${r.tipo}:${r.factura || r.telefono}` === clave)) return;
  stripeRegistrosPendientes.push({ ...reg, cuando: Date.now() });
  if (stripeRegistrosPendientes.length > REGISTRO_PENDIENTE_MAX) {
    stripeRegistrosPendientes = stripeRegistrosPendientes.slice(-REGISTRO_PENDIENTE_MAX);
  }
  schedulePersist();
}

const stripePagosRecientes = new Map();   // telefono -> [{ monto, cuando, canal, ref }]
const VENTANA_DUPLICADO_MS = 20 * 24 * 3600 * 1000;

function registrarPagoYRevisarDoble({ telefono, monto, canal, ref, pagadoPor, cubreHasta }) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return null;
  const ahora = Date.now();
  const previos = (stripePagosRecientes.get(tel) || []).filter((p) => ahora - p.cuando < VENTANA_DUPLICADO_MS);
  const sospechoso = previos.find((p) => p.ref !== ref);
  const por = String(pagadoPor || '').replace(/\D/g, '');
  const cubre = /^\d{4}-\d{2}-\d{2}$/.test(String(cubreHasta || '')) ? String(cubreHasta) : '';
  previos.push({ monto: Number(monto) || 0, cuando: ahora, canal, ref, ...(por && por !== tel ? { pagadoPor: por } : {}), ...(cubre ? { cubreHasta: cubre } : {}) });
  stripePagosRecientes.set(tel, previos.slice(-6));
  sumarAlMes(monto, canal);
  schedulePersist();
  return sospechoso || null;
}

/*
 * CUÁNTO DINERO HA ENTRADO POR EL COBRO EN LÍNEA.
 *
 * Es el número que le dice a León si esto sirve o no, y no existía: el panel
 * mostraba cuántos clientes tienen CLABE y cuánto está atorado, pero no cuánto
 * entró. Sin eso no hay forma de juzgar el piloto de 50 clientes más que "yo
 * siento que sí".
 *
 * Se guarda por mes y por vía, porque no es lo mismo que entren por
 * transferencia que con tarjeta: la vía dice qué está adoptando la gente.
 * Se conservan seis meses, que es de sobra para ver si la cosa crece.
 */
const stripeCobrado = new Map();   // '2026-09' -> { pagos, pesos, porVia: { clabe, tarjeta, oxxo } }
const MESES_QUE_SE_GUARDAN = 6;

function mesDe(cuando) {
  const d = new Date(cuando || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function sumarAlMes(monto, canal) {
  const pesos = Number(monto) || 0;
  if (pesos <= 0) return;
  const mes = mesDe();
  const m = stripeCobrado.get(mes) || { pagos: 0, pesos: 0, porVia: {} };
  m.pagos += 1;
  m.pesos = +(m.pesos + pesos).toFixed(2);
  const via = String(canal || 'otro');
  m.porVia[via] = (m.porVia[via] || 0) + 1;
  stripeCobrado.set(mes, m);

  // Se tiran los meses viejos aquí y no en un barrido aparte: es una línea, y
  // un barrido más es una cosa más que se puede olvidar de encender.
  if (stripeCobrado.size > MESES_QUE_SE_GUARDAN) {
    for (const viejo of [...stripeCobrado.keys()].sort().slice(0, stripeCobrado.size - MESES_QUE_SE_GUARDAN)) {
      stripeCobrado.delete(viejo);
    }
  }
}

/*
 * Cuánto hay que cobrarle a este cliente, y por qué.
 *
 * Vive aparte porque ahora lo preguntan tres caminos distintos (la cotización
 * de tarjeta/OXXO, el link de tarjeta y el de OXXO) y los tres tienen que dar
 * exactamente el mismo número. Si cada uno lo calculara por su cuenta, bastaría
 * con que la deuda cambiara entre una pantalla y la siguiente para cotizarle
 * una cosa y cobrarle otra.
 *
 * El monto sale de las FACTURAS PENDIENTES, no del campo `saldo`: en la
 * instalación de León Telecom ese campo viene en 0.00 para 286 de cada 300
 * clientes, así que cobrando por ahí el botón no le serviría a casi nadie.
 * Si Wisphub no contesta, se cae al precio de su plan antes que dejarlo sin
 * poder pagar.
 */
/*
 * La cuenta ajena que alguien dijo que iba a pagar, si todavía vale.
 *
 * Vale media hora. Es el tiempo que dura el link de pago, y es más de lo que
 * tarda cualquiera en terminar. Después de eso se olvida sola: la persona que
 * vuelve al día siguiente y escribe PAGAR quiere pagar lo suyo, no lo del otro.
 */
const PAGO_AJENO_VIGENCIA_MS = 30 * 60 * 1000;
function sesionDePagoAjeno(chatId) {
  const ses = getSession(chatId);
  if (!ses.state || !/^pago_(otro_|servicio_)/.test(String(ses.state))) return ses;
  const desde = Number((ses.data || {}).desde || 0);
  if (!desde || Date.now() - desde > PAGO_AJENO_VIGENCIA_MS) { clearSession(chatId); return { state: null, data: {} }; }
  return ses;
}
function cuentaAjena(chatId) {
  const ses = sesionDePagoAjeno(chatId);
  return ses.state === 'pago_otro_listo' ? String((ses.data || {}).pagarPara || '') : '';
}
/*
 * El servicio que el cliente ya eligió, cuando su teléfono tiene varios.
 * Vive en la misma sesión que el pago por otro y caduca igual.
 */
function mesesEnSesion(chatId) {
  const ses = sesionDePagoAjeno(chatId);
  const m = Number((ses.data || {}).meses || 0);
  return ses.state === 'pago_otro_listo' && m > 1 ? Math.min(12, m) : 1;
}
function servicioEnSesion(chatId) {
  const ses = sesionDePagoAjeno(chatId);
  const d = ses.data || {};
  return ses.state === 'pago_otro_listo' && d.servicioId ? { servicioId: String(d.servicioId), usuario: d.usuario || '', etiqueta: d.etiqueta || '' } : null;
}
/*
 * ¿Cuántos contratos tiene esta cuenta? Si son varios, antes de cobrar hay
 * que preguntar CUÁL: 26 teléfonos del padrón tienen dos o tres, y pagar "el
 * de la casa" cuando se quería pagar "el del local" deja al cliente cortado y
 * su dinero en el contrato equivocado. Si Wisphub no contesta, se sigue como
 * antes (uno solo): no se detiene el cobro por una consulta.
 */
/*
 * Antes de cobrar por CUALQUIER vía, si la cuenta tiene varios contratos se
 * pregunta cuál. Devuelve true si preguntó (y entonces quien llama se detiene);
 * `siguiente` es el botón que se vuelve a disparar solo cuando el cliente
 * elija, para que no tenga que volver a empezar.
 */
async function preguntarContratoSiHayVarios(chatId, sendMsg, siguiente) {
  if (servicioEnSesion(chatId)) return false;
  const ajena = cuentaAjena(chatId);
  const tel = ajena || normalizePhone(chatId);
  const varios = await serviciosDeLaCuenta(tel);
  if (varios.length <= 1) return false;
  setSession(chatId, { state: 'pago_servicio_elegir', data: { pagarPara: ajena, servicios: varios.slice(0, 3), siguiente, meses: mesesEnSesion(chatId), desde: Date.now() } });
  const deQuienEs = ajena ? `*${(wisphubClients.get(ajena) || {}).name || 'esa cuenta'}* tiene` : 'Tienes';
  const { lineas } = await describirContratos(varios.slice(0, 3));
  await sendMsg(chatId,
    `${deQuienEs} *${varios.length} servicios* con nosotros:\n${lineas.join('\n')}\n\n¿Cuál vas a pagar? 👇`
    + (varios.length > 3 ? '\n\n(Se muestran los primeros 3; si es otro, escríbele a un asesor.)' : ''),
    [], { buttons: varios.slice(0, 3).map((x, i) => ({ id: 'pago_servicio_' + i, title: (x.estado && /suspend|cort/i.test(x.estado) ? '🔴 ' : '') + x.etiqueta })) });
  return true;
}

// Una línea por contrato: cómo está, cuándo le toca y cuánto debe (si se pudo leer).
async function describirContratos(varios) {
  const lineas = [];
  let debeAlgo = false;
  for (const x of varios) {
    let deuda = 0;
    try { deuda = (await wisphubReactivar.deudaDelCliente(x.usuario)).total || 0; } catch (_) { /* sin deuda a la mano */ }
    if (deuda > 0) debeAlgo = true;
    const susp = /suspend|cort/i.test(x.estado);
    lineas.push(`• *${x.etiqueta}*: ${susp ? '🔴 suspendido' : '🟢 activo'}`
      + (x.fechaCorte ? ` · corte ${x.fechaCorte.split('-').reverse().slice(0, 2).join('/')}` : '')
      + (deuda > 0 ? ` · debe *$${deuda.toFixed(2)}*` : (susp ? '' : ' · al corriente')));
  }
  return { lineas, debeAlgo };
}

async function serviciosDeLaCuenta(tel) {
  try {
    const h = await wisphubReactivar.serviciosDe(tel);
    return (h.servicios || []).map((x) => ({
      id: String(x.id_servicio || x.id || ''),
      usuario: x.usuario || '',
      etiqueta: [x.plan_internet && (x.plan_internet.nombre || x.plan_internet), x.direccion || x.colonia || x.localidad].filter(Boolean).join(' · ') || `Servicio ${x.id_servicio}`,
      estado: x.estado || '',
      fechaCorte: parseFechaCorte(x.fecha_corte) || '',
      precio: parseFloat(x.precio_plan) || 0,
    })).filter((x) => x.id);
  } catch (e) {
    console.warn('[cobro] no se pudieron leer los servicios de', tel, '·', e.message);
    return [];
  }
}

async function montoACobrar(chatId, telefonoCuenta, servicio = null) {
  // Normalmente la cuenta es la de quien escribe. Cuando alguien paga por otro,
  // la cuenta es la de ese otro, y quien escribe solo pone la tarjeta. Si el
  // teléfono tiene varios contratos, la deuda es la del que eligió.
  const tel = normalizePhone(telefonoCuenta || chatId);
  const c = wisphubClients.get(tel) || {};
  let monto = 0;
  let deTexto = '';
  let cubreHasta = '';
  try {
    const d = await wisphubReactivar.deudaDelCliente((servicio && servicio.usuario) || c.usuario || '');
    monto = d.total;
    deTexto = d.facturas.length > 1 ? ` (${d.facturas.length} mensualidades)` : '';
    cubreHasta = d.facturas.map((f) => String(f.fecha_vencimiento || '').slice(0, 10)).filter(Boolean).sort().pop() || '';
  } catch (e) {
    console.warn('[stripe-leon] no se pudo leer la deuda de', tel, '·', e.message);
  }
  if (monto <= 0) { monto = parseFloat(c.precioPlan) || 0; deTexto = ''; }

  /*
   * MESES POR ADELANTADO. "Pago 6 meses de jalón" pasa más de lo que parece
   * (gente que se va a trabajar fuera, o que cobra una vez al año). El monto
   * es lo que debe hoy más los meses siguientes al precio de su plan.
   */
  const meses = mesesEnSesion(chatId);
  if (meses > 1 && monto > 0) {
    const precio = parseFloat(c.precioPlan) || monto;
    monto = +(monto + (meses - 1) * precio).toFixed(2);
    deTexto = ` (${meses} meses)`;
    if (cubreHasta) { const h = new Date(cubreHasta + 'T12:00:00'); h.setMonth(h.getMonth() + (meses - 1)); cubreHasta = fechaLocalISO(h); }
  }

  if (monto <= 0) {
    const ajena = telefonoCuenta && normalizePhone(telefonoCuenta) !== normalizePhone(chatId);
    const cual = ajena ? `en la cuenta de *${c.name || tel}*` : 'en tu cuenta';
    return { ok: false, mensaje: `No veo un saldo pendiente ${cual} ahorita, así que no hay nada que cobrar por aquí. Si crees que es un error, escribe a un asesor. 🙏` };
  }
  return { ok: true, monto, deTexto, cubreHasta };
}

/*
 * De un aviso de Stripe de vuelta al teléfono del cliente.
 *
 * Un contracargo o una devolución llegan como el objeto de la DISPUTA o del
 * CARGO, no como la sesión de pago, así que no siempre traen el teléfono en el
 * metadata. Lo que sí traen es el `payment_intent`, y ese es justo el número de
 * referencia con el que se guardó el pago cuando entró. O sea que el registro
 * de pagos recientes ya es el índice que hace falta, sin ir a preguntarle nada
 * a Stripe.
 */
function telefonoDeEventoStripe(o) {
  const directo = String((o && o.metadata && o.metadata.telefono) || '').replace(/\D/g, '');
  if (directo) return directo;
  const refs = [o && o.payment_intent, o && o.charge, o && o.id].filter(Boolean).map(String);
  for (const [tel, pagos] of stripePagosRecientes) {
    if ((pagos || []).some((p) => refs.includes(String(p.ref)))) return tel;
  }
  return '';
}

/*
 * Le avisa a la oficina qué quedó pendiente de registrar en Wisphub.
 *
 * La API de Wisphub NO permite marcar una factura como pagada: `estado` es de
 * solo lectura y no existe ningún endpoint de pagos (se buscaron nueve). O sea
 * que el dinero entra, el cliente se reconecta solo, pero la factura sigue
 * apareciendo como deuda hasta que alguien la marque a mano.
 *
 * Eso NO puede quedarse en un log. Una factura cobrada que sigue viéndose
 * pendiente le manda recordatorios de corte a alguien que ya pagó, y acaba
 * cortándolo. Por eso cada caso así genera un aviso con el número de factura,
 * para que sea un clic y no una investigación.
 */
function avisarRegistroPendiente(w, telefono) {
  if (!w || !w.cliente) return;
  const quien = `${w.cliente.nombre} (servicio ${w.cliente.idServicio}, tel ${telefono})`;

  /*
   * Un teléfono con varios servicios y ninguno claramente el que se pagó.
   *
   * Hay 26 teléfonos así en el padrón. Aquí NO se adivina: si se elige mal, el
   * cliente sigue cortado y su dinero queda abonado a otra cuenta. Va derecho a
   * una persona, con la lista de servicios para que elija.
   */
  if (w.ambiguo) {
    const cuales = (w.serviciosPosibles || [])
      .map((x) => `#${x.idServicio} ${x.nombre} (${x.estado})`).join(' · ');
    alertAdmin('wisphub-ambiguo',
      `⚠️ PAGO SIN APLICAR de ${telefono}: ese teléfono tiene varios servicios y no se sabe cuál pagó.\n${cuales}\nAplícalo a mano y reactiva el que corresponda.`);
    anotarRegistroPendiente({ tipo: 'ambiguo', factura: null, total: 0,
      nombre: w.cliente.nombre, telefono, idServicio: w.cliente.idServicio,
      detalle: cuales });
    return;
  }

  if (w.registroManual && w.registroManual.length) {
    const cuales = w.registroManual.map((r) => `#${r.factura} ($${Number(r.total).toFixed(2)})`).join(', ');
    alertAdmin('wisphub-registro', `${quien} PAGÓ. Marca a mano en Wisphub: ${cuales}`);
    for (const r of w.registroManual) {
      anotarRegistroPendiente({ tipo: 'factura', factura: r.factura, total: Number(r.total) || 0,
        nombre: w.cliente.nombre, telefono, idServicio: w.cliente.idServicio, usuario: w.cliente.usuario });
    }
  }
  if (w.aFavor && w.sobrante > 0.01) {
    alertAdmin('wisphub-afavor', `${quien} pagó $${w.sobrante.toFixed(2)} y NO debía nada. Aplícalo como saldo a favor.`);
    anotarRegistroPendiente({ tipo: 'afavor', factura: null, total: w.sobrante,
      nombre: w.cliente.nombre, telefono, idServicio: w.cliente.idServicio, usuario: w.cliente.usuario });
  }
  // Una avería de verdad (no "todavía debe", que es la regla funcionando).
  if (w.avisos.some((a) => /No se pudo reactivar|Error hablando|no se pudo confirmar/i.test(a))) {
    alertAdmin('wisphub-reactivar', `${quien} pagó pero algo falló: ${w.avisos.join(' · ')}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  EL DINERO QUE SE QUEDÓ ATORADO EN STRIPE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una transferencia a la CLABE del cliente NO le llega sola a León Telecom.
 * Cae en el saldo de ese cliente DENTRO de Stripe y se queda ahí hasta que
 * alguien la cobra. Ese cobro lo hace el webhook en cuanto entra el aviso.
 *
 * Pero el webhook puede fallar justo en ese paso, y de hecho es el paso más
 * frágil de todo el cobro: depende de que Stripe conteste una segunda vez, en
 * caliente, mientras Render puede estar reiniciando por un despliegue. Cuando
 * falla, hoy solo salía una alerta y el dinero se quedaba parado esperando a
 * que una persona lo moviera a mano. Si esa persona no lo ve —de madrugada, un
 * domingo, entre cien avisos— el cliente ya está reconectado, ya le dijimos
 * "gracias", y León Telecom nunca recibió su dinero.
 *
 * Esto lo va a buscar solo. Dos redes, no una:
 *
 *   1. REINTENTO de los que ya sabemos que fallaron (cada 10 min).
 *   2. AUDITORÍA de TODOS los clientes con CLABE (cada 6 h), por si el aviso
 *      de Stripe nunca llegó y entonces ni siquiera sabemos que hay dinero.
 *
 * La segunda es la que de verdad cierra el hueco: la primera solo alcanza los
 * fallos que vimos, y el peor caso es justamente el que no vimos.
 */
/*
 * La deuda del cliente, distinguiendo "no debe nada" de "no se pudo saber".
 *
 * La diferencia decide a quién le toca la comisión, y por eso no puede
 * confundirse. La comisión sale del EXCEDENTE: de lo que el cliente depositó
 * por encima de lo que debía. Si Wisphub no contesta y damos la deuda por cero,
 * el sistema cree que TODO el depósito es excedente y le cobra comisión a
 * dinero que el cliente mandó para su internet. Eso es quitarle a León Telecom
 * de su mensualidad, en silencio y sin que nadie lo cuadre.
 *
 * Así que cuando no se sabe, se dice que no se sabe, y quien llama decide.
 */
async function deudaConocidaDe(telefono) {
  const c = wisphubClients.get(String(telefono)) || {};
  if (!c.usuario) return { conocida: false, total: 0, porque: 'el cliente no está en la lista de Wisphub' };
  try {
    const d = await wisphubReactivar.deudaDelCliente(c.usuario);
    const cubreHasta = (d.facturas || []).map((f) => String(f.fecha_vencimiento || '').slice(0, 10)).filter(Boolean).sort().pop() || '';
    return { conocida: true, total: Number(d.total) || 0, cubreHasta };
  } catch (e) {
    return { conocida: false, total: 0, porque: e.message };
  }
}

/*
 * Los pagos que entraron SIN dejar cargo por servicio.
 *
 * Pasa cuando el cliente transfiere justo lo que debía, sin el cargo sumado.
 * No es un error del sistema y el cliente queda perfecto: su pago se aplica
 * completo. Pero a la plataforma ese movimiento le cuesta $8.12 de comisión de
 * Stripe, así que cada uno de estos deja a OBEX en números rojos por ese pago.
 *
 * Se lleva la cuenta porque es la única forma de notarlo. Un pago sin cargo no
 * falla, no alerta y no se ve en ningún lado: simplemente el mes cierra con
 * menos dinero del esperado y nadie sabe por qué. Con esto se ve en el panel.
 */
let stripeCargosPerdidos = [];   // [{ telefono, pesos, cuando, motivo }]
const CARGOS_PERDIDOS_MAX = 300;

function anotarCargoPerdido(telefono, pesos, motivo) {
  stripeCargosPerdidos.push({
    telefono: String(telefono || ''), pesos: Number(pesos) || 0,
    cuando: Date.now(), motivo: String(motivo || ''),
  });
  if (stripeCargosPerdidos.length > CARGOS_PERDIDOS_MAX) {
    stripeCargosPerdidos = stripeCargosPerdidos.slice(-CARGOS_PERDIDOS_MAX);
  }
  schedulePersist();
}

const stripeSaldosRezagados = new Map();   // telefono -> { clienteId, pesos, desde, intentos, error }

function anotarSaldoRezagado(telefono, clienteId, pesos, error) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!tel) return;
  const previo = stripeSaldosRezagados.get(tel) || { desde: Date.now(), intentos: 0 };
  stripeSaldosRezagados.set(tel, {
    ...previo, clienteId: clienteId || previo.clienteId,
    pesos: Number(pesos) || previo.pesos || 0,
    error: error ? String(error).slice(0, 200) : previo.error,
  });
  schedulePersist();
}

function olvidarSaldoRezagado(telefono) {
  const tel = String(telefono || '').replace(/\D/g, '');
  if (stripeSaldosRezagados.delete(tel)) schedulePersist();
}

let _barriendoSaldos = false;
let _ultimaAuditoriaSaldos = 0;
let _auditoriaDesde = 0;          // por dónde va la auditoría por tandas
const AUDITORIA_POR_PASADA = 300;  // clientes revisados en cada vuelta
const AUDITORIA_SALDOS_MS = 6 * 3600 * 1000;
// Después de tantos intentos fallidos deja de insistir solo y pide una persona:
// si algo lleva 8 intentos fallando, reintentar la novena vez no lo arregla.
const REZAGO_INTENTOS_MAX = 8;
// Cuántas veces se espera a que Wisphub conteste antes de mandar el depósito
// completo a León Telecom sin cobrar comisión. Cada intento son 10 min.
const REZAGO_SIN_DEUDA_MAX = 4;
// Lo que Stripe cobra por recibir una transferencia SPEI. Comprobado contra la
// API con un cargo real: $440 entraron, $431.88 quedaron.
const COSTO_SPEI = 8.12;

async function barrerSaldosRezagados({ forzarAuditoria = false } = {}) {
  if (_barriendoSaldos) return { corriendo: true };
  if (!stripeLeon.activo() || !stripeLeon.hayLlave()) return { apagado: true };
  if (!(process.env.LEON_STRIPE_CUENTA_CONECTADA || '').trim()) return { apagado: true };
  _barriendoSaldos = true;
  try {
    /*
     * A quién revisarle el saldo en esta pasada.
     *
     * Los que ya sabemos que fallaron van SIEMPRE. Al resto del padrón se le
     * revisa cada 6 h, porque es una llamada a Stripe por cliente y no hace
     * falta hacerlo cada diez minutos.
     *
     * `_auditoriaDesde > 0` significa que la auditoría anterior quedó a medias,
     * y entonces se sigue en la pasada de los diez minutos en vez de esperar
     * las seis horas: recorrer el padrón entero de 300 en 300 tardaría día y
     * medio, y una red de seguridad que tarda día y medio en cerrarse no es
     * una red.
     */
    const auditar = forzarAuditoria || _auditoriaDesde > 0
      || Date.now() - _ultimaAuditoriaSaldos > AUDITORIA_SALDOS_MS;
    const revisar = new Map();
    for (const [tel, r] of stripeSaldosRezagados) {
      if ((r.intentos || 0) < REZAGO_INTENTOS_MAX) revisar.set(tel, { ...r, yaAnotado: true });
    }
    if (auditar) {
      /*
       * La auditoría es una llamada a Stripe por cliente. Con el padrón entero
       * con CLABE serían más de mil en una sola pasada, y mientras corre no se
       * atienden los reintentos. Se revisa por tandas, siguiendo donde quedó la
       * anterior: en unas cuantas vueltas se recorre a todos igual.
       */
      const todos = [...stripeClientes.entries()].filter(([tel, d]) => d && d.clienteId && !revisar.has(tel));
      if (_auditoriaDesde >= todos.length) _auditoriaDesde = 0;
      const tanda = todos.slice(_auditoriaDesde, _auditoriaDesde + AUDITORIA_POR_PASADA);
      const siguiente = _auditoriaDesde + AUDITORIA_POR_PASADA;
      if (siguiente >= todos.length) {
        // Se dio la vuelta completa: ahora sí, a descansar las seis horas.
        _auditoriaDesde = 0;
        _ultimaAuditoriaSaldos = Date.now();
      } else {
        _auditoriaDesde = siguiente;
      }
      for (const [tel, datos] of tanda) revisar.set(tel, { clienteId: datos.clienteId, yaAnotado: false });
    }
    if (!revisar.size) return { revisados: 0, rescatados: 0, fallidos: 0 };

    let rescatados = 0;
    let fallidos = 0;
    for (const [tel, r] of revisar) {
      const clienteId = r.clienteId || (stripeClientes.get(tel) || {}).clienteId;
      if (!clienteId) { olvidarSaldoRezagado(tel); continue; }

      /*
       * Leer el saldo ANTES de cobrar es lo que hace seguro reintentar. Si el
       * intento anterior sí había pasado y solo se perdió la respuesta, aquí
       * el saldo ya está en cero y no se vuelve a cobrar nada.
       *
       * Y va en su propio intento, aparte del cobro, por una razón concreta: si
       * Stripe está caído durante una auditoría, esta lectura falla para los
       * MILES de clientes que se están revisando. Si eso contara como "dinero
       * atorado", la lista se llenaría de gente que no tiene ni un peso ahí y a
       * los ocho intentos saldría una alerta por cada uno. Un aviso importante
       * sepultado bajo mil avisos falsos es un aviso perdido. Así que solo se
       * anota a quien YA se sabía que tenía dinero.
       */
      let pesos = 0;
      try {
        pesos = await stripeLeon.saldoDisponible(clienteId);
      } catch (e) {
        if (!r.yaAnotado) {
          console.warn('[stripe-rezago] no se pudo leer el saldo de', tel, '·', e.message);
          continue;
        }
        pesos = -1;   // ya sabíamos que había dinero: cuenta como intento fallido
      }
      if (pesos >= 0 && pesos <= 0.01) { olvidarSaldoRezagado(tel); continue; }

      try {
        if (pesos < 0) throw new Error('no se pudo leer el saldo en Stripe');

        const nuevo = !r.yaAnotado;   // dinero que nadie había visto entrar
        /*
         * La misma regla que en el webhook: sin saber la deuda no se reparte.
         *
         * Pero aquí hay un límite. Si Wisphub lleva rato sin contestar, el
         * dinero no puede quedarse esperando indefinidamente: a los 4 intentos
         * (unos 40 minutos) se manda COMPLETO a León Telecom, sin comisión.
         * Entre cobrarle de más a León y renunciar a nuestro cargo, se renuncia
         * al cargo: el error caro no es perder $30, es que un cliente pague su
         * internet y ese dinero no llegue.
         */
        const intentosPrevios = (stripeSaldosRezagados.get(tel) || {}).intentos || 0;
        const d = await deudaConocidaDe(tel);
        if (!d.conocida && intentosPrevios < REZAGO_SIN_DEUDA_MAX) {
          fallidos++;
          stripeSaldosRezagados.set(tel, {
            ...(stripeSaldosRezagados.get(tel) || {}), clienteId, pesos,
            desde: (stripeSaldosRezagados.get(tel) || {}).desde || Date.now(),
            intentos: intentosPrevios + 1,
            error: 'sin deuda: ' + d.porque,
          });
          schedulePersist();
          console.warn('[stripe-rezago] pospuesto ·', tel, '· no se sabe la deuda:', d.porque);
          continue;
        }
        const deuda = d.total;
        if (!d.conocida) {
          console.warn('[stripe-rezago] se barre SIN comisión ·', tel, '· Wisphub no contestó en', intentosPrevios, 'intentos');
          alertAdmin('stripe-rezago',
            `Se mandó completo a León Telecom el depósito de ${tel} ($${pesos.toFixed(2)}) porque Wisphub no contestó y no se pudo calcular el cargo. El cliente quedó bien; el cargo por servicio de ese pago se perdió.`);
          anotarCargoPerdido(tel, pesos, 'Wisphub no contestó y no se pudo calcular el cargo');
        }

        /*
         * La llave que impide cobrar dos veces se cuelga del MOVIMIENTO, no del
         * monto ni del día: dos depósitos iguales el mismo día son dos pagos
         * distintos y tienen que poder cobrarse los dos. Si Stripe no dijera
         * cuál fue el último movimiento, se cae a monto y día, que protege del
         * reintento inmediato aunque no distinga esos dos depósitos.
         */
        let referencia = '';
        try { referencia = await stripeLeon.ultimoMovimientoSaldo(clienteId); }
        catch (e) { console.warn('[stripe-rezago] sin id de movimiento para', tel, '·', e.message); }
        if (!referencia) {
          const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          referencia = `rezago-${clienteId}-${Math.round(pesos * 100)}-${hoy}`;
        }
        const barrido = await stripeLeon.cobrarDelSaldo({
          clienteId, deposito: pesos, deuda, telefono: tel,
          nombre: (wisphubClients.get(tel) || {}).name,
          referencia,
        });
        rescatados++;
        olvidarSaldoRezagado(tel);
        console.log('[stripe-rezago] rescatado ·', tel, '· $' + barrido.aLeonTelecom.toFixed(2), 'a León');
        // Mismo conteo que en el webhook: un pago sin cargo cobrado no es ganar
        // cero, es perder los $8.12 que cuesta la transferencia.
        if (barrido.sinComision && d.conocida) {
          anotarCargoPerdido(tel, pesos, 'transfirió justo lo que debía, sin el cargo');
        }

        /*
         * Si el aviso original SÍ llegó, al cliente ya se le dio las gracias y
         * la factura ya se anotó: aquí solo faltaba mover el dinero, y volver a
         * escribirle sería un segundo "ya quedó" por el mismo pago.
         *
         * Si el dinero apareció en la auditoría, nadie sabía que existía: ahí sí
         * hay que avisarle y aplicar el pago, porque para él pagó y no pasó nada.
         */
        if (nuevo) {
          console.warn('[stripe-rezago] ¡depósito que el webhook nunca reportó! ·', tel, '· $' + pesos.toFixed(2));
          alertAdmin('stripe-rezago',
            `Se encontró un depósito de $${pesos.toFixed(2)} de ${tel} que Stripe nunca avisó. Ya se movió a León Telecom y se le aplicó. Vale la pena revisar que el webhook esté recibiendo.`);
          registrarPagoYRevisarDoble({ telefono: tel, monto: pesos, canal: 'transferencia', ref: barrido.id });
          markCases(tel, 'recibido', 'stripe-clabe');
          await avisarPorIniciativa(tel,
            `✅ Recibimos tu transferencia por $${pesos.toFixed(2)} — tu pago quedó registrado. ¡Gracias! 🙌`).catch(() => {});
          try {
            const w = await wisphubReactivar.aplicarPago({ telefono: tel, monto: pesos, referencia: barrido.id });
            if (w.reactivado) {
              await avisarPorIniciativa(tel, '📶 Tu servicio ya quedó reactivado. Si en unos minutos sigue sin navegar, reinicia tu módem. 🙌').catch(() => {});
            }
            avisarRegistroPendiente(w, tel);
          } catch (e) { console.error('[stripe-rezago] wisphub:', e.message); }
        }
      } catch (e) {
        const previo = stripeSaldosRezagados.get(tel) || {};
        const intentos = (previo.intentos || 0) + 1;
        stripeSaldosRezagados.set(tel, {
          ...previo, clienteId, intentos,
          // El monto que se acaba de leer, no el que hubiera de antes: si no,
          // el panel enseña "$0 atorado" sobre dinero que sí está parado ahí.
          pesos: pesos > 0 ? pesos : (previo.pesos || 0),
          desde: previo.desde || Date.now(),
          error: String(e.message).slice(0, 200),
        });
        schedulePersist();
        fallidos++;
        console.error('[stripe-rezago] intento', intentos, 'falló para', tel, '·', e.message);
        /*
         * Se avisa UNA sola vez, al agotar los intentos. Alertar en cada
         * pasada convertiría una avería en cien mensajes y la alerta dejaría
         * de leerse, que es como se pierden las importantes.
         */
        if (intentos === REZAGO_INTENTOS_MAX) {
          alertAdmin('stripe-rezago',
            `⚠️ Hay dinero de ${tel} atorado en Stripe y ya no se pudo mover solo (${intentos} intentos). Último error: ${e.message}. Hay que barrerlo a mano desde el panel de Stripe.`);
        }
      }
    }
    if (rescatados) console.log('[stripe-rezago] pasada terminada ·', rescatados, 'rescatado(s)');
    return { revisados: revisar.size, rescatados, fallidos, auditoria: auditar };
  } catch (e) {
    console.error('[stripe-rezago] barrido:', e.message);
    return { error: e.message };
  } finally {
    _barriendoSaldos = false;
  }
}

app.post('/webhook/stripe', async (req, res) => {
  const secreto = (process.env.STRIPE_WEBHOOK_SECRET_LEON || '').trim();
  if (!secreto) { console.error('[stripe-leon] falta STRIPE_WEBHOOK_SECRET_LEON'); return res.status(500).json({ error: 'Webhook sin configurar.' }); }
  if (!stripeLeon.verificarFirma(req.rawBody, req.headers['stripe-signature'], secreto)) {
    console.warn('[stripe-leon] firma inválida desde', req.ip);
    return res.status(400).json({ error: 'Firma inválida.' });
  }

  let evento;
  try { evento = JSON.parse(req.rawBody); }
  catch { return res.status(400).json({ error: 'Cuerpo ilegible.' }); }

  if (evento.account) {
    console.warn('[stripe-leon] aviso de otra cuenta conectada, ignorado:', evento.account);
    return res.json({ recibido: true, ignorado: 'cuenta-conectada' });
  }

  try {
    const o = (evento.data && evento.data.object) || {};
    /*
     * ── PAGO EN OXXO ────────────────────────────────────────────────────────
     *
     * OXXO NO llega como `checkout.session.completed` pagado. Llegan dos
     * avisos distintos y separados por días:
     *
     *   completed + payment_status 'unpaid'  → se generó la ficha
     *   async_payment_succeeded              → el cliente ya pagó en la tienda
     *   async_payment_failed                 → la ficha venció sin pagarse
     *
     * Sin este bloque, quien pagaba en OXXO no recibía confirmación NUNCA y
     * seguía suspendido con su ticket en la mano. El bot le ofrece OXXO en el
     * menú, así que no escucharlo era prometer algo que no pasaba.
     */
    if (o.metadata && o.metadata.tipo === 'mensualidad-leontelecom'
        && evento.type === 'checkout.session.completed' && o.payment_status === 'unpaid') {
      /*
       * La ficha la tiene quien la sacó, que no siempre es el dueño del
       * servicio. Si alguien pagó por su mamá, el aviso de "ya está tu ficha"
       * le sirve a él, y a la mamá le llegaría de la nada.
       */
      const tel = String(o.metadata.telefono || '').replace(/\D/g, '');
      const quien = String(o.metadata.pagadoPor || tel).replace(/\D/g, '');
      if (quien) {
        const ajeno = quien !== tel;
        const nombreDuenio = (wisphubClients.get(tel) || {}).name || tel;
        await sendWhatsAppMessage(quien,
          (ajeno ? `🧾 Ya se generó la ficha para pagar el servicio de *${nombreDuenio}*. ` : '🧾 Ya se generó tu ficha de pago. ')
          + 'Llévala a OXXO y págala en caja.\n\n'
          + `En cuanto la tienda reporte el pago te avisamos por aquí y ${ajeno ? 'su' : 'tu'} servicio se reactiva solo. `
          + 'Puede tardar unas horas después de pagar. *No mandes comprobante*, nosotros lo vemos.').catch(() => {});
      }
      return res.json({ recibido: true, ficha: true });
    }

    /*
     * El link venció sin que lo abriera (o lo abrió y no terminó). Que lo sepa
     * y que pedir otro sea una palabra: si no, vuelve a abrir el mismo link,
     * ve "expirado" en inglés y piensa que el sistema no sirve.
     */
    if (o.metadata && o.metadata.tipo === 'mensualidad-leontelecom'
        && evento.type === 'checkout.session.expired' && o.payment_status !== 'paid') {
      const tel = String(o.metadata.telefono || '').replace(/\D/g, '');
      const quien = String(o.metadata.pagadoPor || tel).replace(/\D/g, '');
      if (quien && o.metadata.forma !== 'oxxo') {
        const ajeno = quien !== tel;
        await sendWhatsAppMessage(quien,
          '⏱️ El link de pago venció (dura 30 minutos). No se cobró nada. '
          + `Cuando quieras, escribe *${ajeno ? 'a nombre de quién' : 'pagar'}* y te doy uno nuevo. 🙌`).catch(() => {});
      }
      return res.json({ recibido: true, vencido: true });
    }

    if (o.metadata && o.metadata.tipo === 'mensualidad-leontelecom'
        && evento.type === 'checkout.session.async_payment_failed') {
      const tel = String(o.metadata.telefono || '').replace(/\D/g, '');
      const quien = String(o.metadata.pagadoPor || tel).replace(/\D/g, '');
      if (quien) {
        const ajeno = quien !== tel;
        await avisarPorIniciativa(quien,
          (ajeno ? `⚠️ La ficha de pago del servicio de *${(wisphubClients.get(tel) || {}).name || tel}* venció sin pagarse, así que sigue pendiente. `
                 : '⚠️ Tu ficha de pago venció sin pagarse, así que tu servicio sigue pendiente. ')
          + `Escribe *${ajeno ? 'OTRO' : 'pagar'}* para generar otra, o paga como siempre por depósito. 🙏`).catch(() => {});
      }
      return res.json({ recibido: true, fichaVencida: true });
    }

    if (o.metadata && o.metadata.tipo === 'mensualidad-leontelecom'
        && (evento.type === 'checkout.session.async_payment_succeeded'
            || (evento.type === 'checkout.session.completed' && o.payment_status === 'paid'))) {
      /*
       * Stripe reintenta el MISMO aviso si tardamos en contestar —es su
       * garantía de entrega, no un error— así que sin este candado el cliente
       * recibiría dos "ya quedó" por el mismo pago. Hoy eso solo es feo; el día
       * que esto además le registre el pago a Wisphub, sería abonarle dos veces.
       */
      if (stripeVistos.has(o.id)) {
        console.log('[stripe-leon] aviso repetido de', o.id, '— ya estaba procesado, se ignora');
        return res.json({ recibido: true, repetido: true });
      }
      stripeVistos.set(o.id, Date.now());

      // `telefono` es del DUEÑO del servicio; `pagadoPor`, de quien sacó la
      // tarjeta. Casi siempre son el mismo, pero cuando no lo son hay que
      // abonarle al dueño y avisarle a los dos: quien pagó necesita su acuse, y
      // el dueño necesita saber que ya quedó (a lo mejor ni estaba enterado).
      const telefono = String(o.metadata.telefono || '').replace(/\D/g, '');
      const pagadoPor = String(o.metadata.pagadoPor || telefono).replace(/\D/g, '');
      if (telefono) {
        markCases(telefono, 'recibido', 'stripe-auto');
        const doble = registrarPagoYRevisarDoble({
          telefono, monto: (o.amount_total || 0) / 100,
          canal: o.payment_status === 'paid' ? 'tarjeta' : 'oxxo',
          ref: o.payment_intent || o.id, pagadoPor, cubreHasta: o.metadata.cubreHasta,
        });
        if (doble) {
          alertAdmin('pago-doble', `⚠️ POSIBLE PAGO DOBLE de ${telefono}: ya había pagado $${doble.monto.toFixed(2)} por ${doble.canal} hace ${Math.round((Date.now() - doble.cuando) / 3600000)} h. Revisa si hay que devolverle.`);
        }
        const duenio = wisphubClients.get(telefono) || {};
        /*
         * Cada aviso va en su propio try: si el WhatsApp del dueño falla, el de
         * quien pagó SÍ tiene que salir igual. El dinero ya entró; lo último que
         * queremos es que además nadie se entere.
         */
        // OXXO se confirma días después y el dueño puede no haber escrito nunca: plantilla.
        const porIniciativa = pagadoPor !== telefono || o.payment_status !== 'paid';
        try {
          await (porIniciativa ? avisarPorIniciativa : sendWhatsAppMessage)(telefono,
            '✅ Recibimos el pago de tu servicio — quedó confirmado automáticamente, no hace falta comprobante. ¡Gracias! 🙌'
            + (pagadoPor !== telefono ? '\n\n(Lo pagó otra persona por ti.)' : ''));
        } catch (e) { console.error('[stripe-leon] no salió el aviso al dueño', telefono, e.message); }

        if (pagadoPor && pagadoPor !== telefono) {
          markCases(pagadoPor, 'recibido', 'stripe-auto');
          try {
            await (o.payment_status !== 'paid' ? avisarPorIniciativa : sendWhatsAppMessage)(pagadoPor,
              `✅ Listo, tu pago se aplicó al servicio de *${duenio.name || telefono}*. Quedó confirmado automáticamente. ¡Gracias! 🙌`);
          } catch (e) { console.error('[stripe-leon] no salió el aviso a quien pagó', pagadoPor, e.message); }
        }
        /*
         * Si el cliente aceptó el cobro automático, aquí se recuerda con qué
         * tarjeta. Se guarda junto a su registro, que ya es el lugar donde vive
         * su cliente de Stripe.
         *
         * Solo si `guardarTarjeta` dice que sí: esa marca viene del link, y el
         * link solo la trae cuando el cliente pasó por el aviso y aceptó.
         */
        if (o.metadata.guardarTarjeta === 'si' && o.customer) {
          try {
            const reg = stripeClientes.get(telefono) || {};
            stripeClientes.set(telefono, {
              ...reg,
              clienteId: String(o.customer),
              autoDesde: new Date().toISOString(),
              // El método de pago se resuelve al cobrar: aquí solo se anota que
              // este cliente aceptó. Guardar el id de la tarjeta ahora sería
              // guardar uno que puede caducar antes del próximo mes.
              cobroAutomatico: true,
              // Si el teléfono tiene varios contratos, cuál es el que se cobra solo.
              ...(o.metadata.servicioId ? { autoServicioId: String(o.metadata.servicioId) } : {}),
            });
            schedulePersist();
            console.log('[stripe-leon] cobro automático activado para', telefono);
            await sendWhatsAppMessage(telefono, '🔁 Tu cobro automático quedó activo. Cada mes te aviso dos días antes de tu fecha de pago y un día antes se cobra a esta tarjeta. Para quitarlo, escribe *CANCELAR AUTOMÁTICO*.').catch(() => {});
          } catch (e) { console.error('[stripe-leon] no se pudo guardar el cobro automático:', e.message); }
        }
        /*
         * Reconectar al cliente. Va DESPUÉS del aviso, no antes: el dinero ya
         * entró y su confirmación no puede depender de que Wisphub conteste.
         * `aplicarPago` nunca lanza; devuelve qué pudo hacer y qué no.
         */
        try {
          /*
           * Se abona la MENSUALIDAD, no el total cobrado. `amount_total` trae
           * el cargo por servicio sumado, y ese no es dinero de León Telecom:
           * aplicarlo a la factura la abonaría de más y marcaría cada pago
           * como "pagó de más".
           */
          const mensualidad = Number(o.metadata.mensualidad || 0) / 100 || (o.amount_total || 0) / 100;
          /*
           * Pagó meses adelantados: se anota hasta cuándo, para que el aviso
           * de corte no le llegue en esos meses, y se le dice a la oficina que
           * registre los meses que vienen (Wisphub solo tiene la factura de hoy).
           */
          const mesesPagados = Number(o.metadata.meses || 1) || 1;
          if (mesesPagados > 1) anotarMesesAdelantados(telefono, mesesPagados, `$${mensualidad.toFixed(2)}`);
          const w = await wisphubReactivar.aplicarPago({ telefono, monto: mensualidad, referencia: o.payment_intent || o.id, idServicio: o.metadata.servicioId || undefined });
          if (w.reactivado) {
            console.log('[wisphub] servicio reactivado ·', telefono, '· tarea', w.tareaId);
            await (porIniciativa ? avisarPorIniciativa : sendWhatsAppMessage)(telefono, '📶 Tu servicio ya quedó reactivado. Si en unos minutos sigue sin navegar, reinicia tu módem. 🙌').catch(() => {});
          }
          if (w.avisos.length) console.warn('[wisphub]', telefono, '·', w.avisos.join(' · '));

          /*
           * Pagó, pero no alcanzó. Hay que DECÍRSELO: si no, se queda esperando
           * una reconexión que no va a llegar y acaba hablando a la oficina,
           * que es justo el trabajo que veníamos a quitar.
           */
          if (w.ambiguo) {
            // Tiene varios contratos: no podemos saber cuál pagó sin preguntarle.
            await (porIniciativa ? avisarPorIniciativa : sendWhatsAppMessage)(telefono,
              '✅ Recibimos tu pago, gracias. Como tienes *más de un servicio* con nosotros, '
              + 'un asesor va a aplicarlo al que corresponde en un momento. Si es urgente, dinos cuál es. 🙏').catch(() => {});
          } else if (!w.reactivado && w.deudaRestante > 0.01 && w.cliente && w.cliente.estado !== 'Activo') {
            await (porIniciativa ? avisarPorIniciativa : sendWhatsAppMessage)(telefono,
              `✅ Recibimos tu pago. Todavía queda un saldo de *$${w.deudaRestante.toFixed(2)}*, `
              + 'y por eso el servicio sigue suspendido. En cuanto se cubra se reactiva solo. 🙏').catch(() => {});
          }
          avisarRegistroPendiente(w, telefono);
        } catch (e) { console.error('[wisphub] reactivación:', e.message); }
        console.log('[stripe-leon] pago confirmado · servicio', telefono, '· pagado por', pagadoPor, '· sesión', o.id);
      } else {
        // Un pago sin teléfono no se puede abonar a nadie: que no se pierda en silencio.
        console.error('[stripe-leon] ¡pago sin teléfono en metadata!', o.id);
        alertAdmin('stripe-leon', `Entró un pago (${o.id}) sin teléfono en el metadata: no se pudo abonar a ningún cliente. Revísalo a mano en Stripe.`);
      }
    }
    /*
     * ── EL DEPÓSITO A LA CLABE ──────────────────────────────────────────────
     *
     * Una transferencia SPEI a la CLABE fija del cliente NO produce un
     * `checkout.session.completed`: ahí no hubo checkout ninguno, el cliente
     * entró a su banco y mandó dinero. Llega por aquí, como un movimiento del
     * saldo de ese Customer.
     *
     * Sin este bloque, el cliente que usa su CLABE —que es justo la forma que
     * más va a usar la gente del pueblo— transfiere y el bot nunca le dice
     * nada. Se quedaría esperando su confirmación y acabaría mandando el
     * comprobante a mano, que es lo que veníamos a quitar.
     */
    if (evento.type === 'customer_cash_balance_transaction.created' && o.type === 'funded') {
      const clienteId = String(o.customer || '');
      // De vuelta del cliente de Stripe al teléfono: el registro es el mapa.
      // La clave puede traer el servicio (`tel~servicio`): esa CLABE es de UN
      // contrato en particular, y así se abona sin adivinar.
      let telefono = '';
      let servicioDelDeposito = '';
      for (const [clave, datos] of stripeClientes) {
        if (datos && datos.clienteId === clienteId) {
          const partes = stripeLeon.partirClave(clave);
          telefono = partes.tel; servicioDelDeposito = partes.servicioId || String(datos.servicioId || '');
          break;
        }
      }
      /*
       * Si el registro no lo conoce, PREGUNTARLE A STRIPE de quién es.
       *
       * Antes esto se rendía aquí y el depósito quedaba sin dueño, esperando a
       * que alguien lo resolviera a mano en el panel. Pero cada cliente se creó
       * con su teléfono en el metadata, así que Stripe siempre lo sabe: basta
       * con preguntar. Pasa cuando el registro local se perdió (base nueva,
       * migración) y es justo el caso donde el cliente ya transfirió y jura que
       * pagó.
       */
      if (!telefono && clienteId) {
        try {
          const c = await stripeLeon.obtenerCliente(clienteId);
          const tel = String((c && c.metadata && c.metadata.telefono) || '').replace(/\D/g, '');
          if (tel) {
            telefono = tel;
            servicioDelDeposito = String((c.metadata && c.metadata.servicioId) || '').replace(/\D/g, '');
            const claveReg = stripeLeon.claveDeRegistro(tel, servicioDelDeposito);
            const yaTiene = (stripeClientes.get(claveReg) || {}).clienteId;
            if (yaTiene && yaTiene !== clienteId) {
              /*
               * Ese teléfono YA tiene su cliente de Stripe, y no es este. El
               * registro no se toca: su CLABE es la que ya anotó en su banco y
               * cambiarla sería el peor error posible aquí. El depósito sí se
               * le abona (el dinero es suyo), pero que alguien revise por qué
               * hay dos clientes para el mismo teléfono.
               */
              console.warn('[stripe-leon] depósito de un SEGUNDO cliente de', tel, '·', clienteId, '(el suyo es', yaTiene + ')');
              alertAdmin('stripe-leon',
                `Entró dinero de ${tel} a un cliente de Stripe distinto del suyo (${clienteId} en vez de ${yaTiene}). Se le abonó igual y su CLABE NO se cambió, pero conviene revisar en Stripe por qué hay dos.`);
            } else {
              stripeClientes.set(claveReg, { ...(stripeClientes.get(claveReg) || {}), clienteId, ...(servicioDelDeposito ? { servicioId: servicioDelDeposito } : {}) });
              schedulePersist();
              console.warn('[stripe-leon] cliente recuperado de Stripe ·', clienteId, '→', claveReg);
            }
          }
        } catch (e) {
          console.error('[stripe-leon] no se pudo preguntar de quién es', clienteId, '·', e.message);
        }
      }

      if (stripeVistos.has(o.id)) {
        console.log('[stripe-leon] depósito repetido de', o.id, '— se ignora');
        return res.json({ recibido: true, repetido: true });
      }
      stripeVistos.set(o.id, Date.now());

      const centavos = (o.net_amount != null ? o.net_amount : ((o.funded && o.funded.bank_transfer && o.funded.bank_transfer.amount) || 0));
      const pesos = (Number(centavos) || 0) / 100;

      if (telefono) {
        markCases(telefono, 'recibido', 'stripe-clabe');

        /*
         * BARRER EL SALDO. Sin esto el dinero no le llega a León Telecom.
         *
         * Una transferencia a la CLABE cae en el saldo del cliente DENTRO de
         * Stripe y ahí se queda: no rebota sola. Hay que cobrarla, y ese cobro
         * es el que la parte entre León y la comisión.
         *
         * Va antes del aviso a propósito: si el barrido falla hay que decirlo,
         * no mandar un "ya quedó" sobre dinero que no se movió.
         */
        const reg = stripeClientes.get(telefono) || {};
        const deuda = await deudaConocidaDe(telefono);
        if (!deuda.conocida) {
          /*
           * Sin saber la deuda no se puede repartir bien, así que el barrido se
           * POSPONE en vez de hacerse mal. La comisión sale del excedente sobre
           * lo que el cliente debía; si damos la deuda por cero cuando en
           * realidad no la sabemos, todo el depósito parece excedente y le
           * cobramos comisión a dinero que era la mensualidad de León.
           *
           * El dinero no corre ningún riesgo: sigue en Stripe, a nombre del
           * cliente, y `barrerSaldosRezagados` lo reintenta cada diez minutos.
           * En cuanto Wisphub conteste se reparte como debe; si nunca contesta,
           * a los cuarenta minutos se manda completo a León Telecom sin cobrar
           * nada, que es el lado correcto donde equivocarse.
           */
          console.warn('[stripe-leon] barrido pospuesto ·', telefono, '· no se sabe la deuda:', deuda.porque);
          anotarSaldoRezagado(telefono, o.customer || reg.clienteId, pesos, 'sin deuda: ' + deuda.porque);
        } else {
          try {
            const barrido = await stripeLeon.cobrarDelSaldo({
              /*
               * El dinero está en `o.customer`: este aviso ES el movimiento del
               * saldo de ESE cliente. Tomarlo del registro sería barrer al
               * cliente equivocado el día que un teléfono tenga dos (pasa si se
               * duplicó antes de que existiera el registro), y el cobro
               * fallaría por saldo insuficiente sobre dinero que sí está.
               */
              clienteId: o.customer || reg.clienteId, deposito: pesos, deuda: deuda.total,
              telefono, nombre: (wisphubClients.get(telefono) || {}).name, referencia: o.id,
            });
            console.log('[stripe-leon] saldo barrido ·', telefono,
              '· a León $' + barrido.aLeonTelecom.toFixed(2), '· comisión $' + barrido.comision.toFixed(2));
            if (barrido.sinComision) {
              console.warn('[stripe-leon] sin comisión: depositó justo su plan, sin el cargo ·', telefono);
              anotarCargoPerdido(telefono, pesos, 'transfirió justo lo que debía, sin el cargo');
            }
          } catch (e) {
            /*
             * El dinero está a salvo en el saldo del cliente: no se pierde, pero
             * tampoco le llegó a León.
             *
             * Antes esto solo alertaba y se quedaba esperando a que una persona
             * lo moviera a mano. Ahora se anota y `barrerSaldosRezagados` lo
             * reintenta solo cada diez minutos: la mayoría de estos fallos son
             * pasajeros (Stripe intermitente, un reinicio a media transacción) y
             * se arreglan sin que nadie tenga que enterarse. La alerta se guarda
             * para cuando de verdad ya no se pudo.
             */
            console.error('[stripe-leon] NO se pudo barrer el saldo de', telefono, '·', e.message);
            anotarSaldoRezagado(telefono, o.customer || reg.clienteId, pesos, e.message);
          }
        }
        const doble = registrarPagoYRevisarDoble({ telefono, monto: pesos, canal: 'transferencia', ref: o.id, cubreHasta: deuda.cubreHasta || undefined });
        if (doble) {
          alertAdmin('pago-doble', `⚠️ POSIBLE PAGO DOBLE de ${telefono}: ya había pagado $${doble.monto.toFixed(2)} por ${doble.canal} hace ${Math.round((Date.now() - doble.cuando) / 3600000)} h. Revisa si hay que devolverle.`);
        }
        /*
         * Quien transfiere dos o más mensualidades de un jalón también va
         * adelantado: se cuenta con el plan del contrato (o con lo que debía,
         * si el plan no se sabe) y queda anotado hasta cuándo.
         */
        let cubreTexto = '';
        try {
          let unidad = 0;
          if (servicioDelDeposito) {
            const svc = (await serviciosDeLaCuenta(telefono)).find((x) => x.id === String(servicioDelDeposito));
            if (svc) { unidad = svc.precio; if (!unidad) { try { unidad = (await wisphubReactivar.deudaDelCliente(svc.usuario)).total || 0; } catch (_) { /* sin deuda a la mano */ } } }
          }
          if (!unidad) unidad = parseFloat((wisphubClients.get(telefono) || {}).precioPlan) || (deuda.conocida ? Number(deuda.total) || 0 : 0);
          if (unidad > 0 && pesos >= 2 * unidad - 0.5) {
            const mesesDep = Math.min(12, Math.floor((pesos + 0.5) / unidad));
            const hasta = anotarMesesAdelantados(telefono, mesesDep, `$${pesos.toFixed(2)} por transferencia`);
            cubreTexto = ` Cubre ${mesesDep} meses: quedas pagado hasta el ${hasta.split('-').reverse().join('/')}.`;
          }
        } catch (e) { console.warn('[stripe-leon] no se pudo contar los meses del depósito ·', e.message); }
        try {
          await avisarPorIniciativa(telefono,
            `✅ Recibimos tu transferencia por $${pesos.toFixed(2)} — tu pago quedó registrado automáticamente, no hace falta comprobante.${cubreTexto} ¡Gracias! 🙌`);
        } catch (e) { console.error('[stripe-leon] no salió el aviso del depósito a', telefono, e.message); }
        try {
          const w = await wisphubReactivar.aplicarPago({ telefono, monto: pesos, referencia: o.id, idServicio: servicioDelDeposito || undefined });
          if (w.reactivado) {
            console.log('[wisphub] servicio reactivado por depósito ·', telefono, '· tarea', w.tareaId);
            await avisarPorIniciativa(telefono, '📶 Tu servicio ya quedó reactivado. Si en unos minutos sigue sin navegar, reinicia tu módem. 🙌').catch(() => {});
          }
          if (w.avisos.length) console.warn('[wisphub]', telefono, '·', w.avisos.join(' · '));
          if (w.ambiguo) {
            await avisarPorIniciativa(telefono,
              '✅ Recibimos tu transferencia, gracias. Como tienes *más de un servicio* con nosotros, '
              + 'un asesor va a aplicarla al que corresponde en un momento. Si es urgente, dinos cuál es. 🙏').catch(() => {});
          } else if (!w.reactivado && w.deudaRestante > 0.01 && w.cliente && w.cliente.estado !== 'Activo') {
            await avisarPorIniciativa(telefono,
              `✅ Recibimos tu transferencia. Todavía queda un saldo de *$${w.deudaRestante.toFixed(2)}*, `
              + 'y por eso el servicio sigue suspendido. En cuanto se cubra se reactiva solo. 🙏').catch(() => {});
          }
          avisarRegistroPendiente(w, telefono);
        } catch (e) { console.error('[wisphub] reactivación:', e.message); }
        console.log('[stripe-leon] depósito a CLABE ·', telefono, '· $' + pesos.toFixed(2), '·', o.id);
      } else {
        /*
         * Entró dinero a una CLABE que no está en el registro. Puede ser un
         * cliente de antes de que existiera el registro, o una CLABE vieja. El
         * dinero está a salvo en Stripe, pero NO se puede abonar solo: que
         * alguien lo revise antes de que el cliente reclame que ya pagó.
         */
        console.error('[stripe-leon] ¡depósito de un cliente desconocido!', clienteId, o.id);
        alertAdmin('stripe-leon', `Entró una transferencia de $${pesos.toFixed(2)} al cliente de Stripe ${clienteId}, que no está en el registro: no se pudo abonar a nadie. Revísalo a mano en Stripe.`);
      }
      return res.json({ recibido: true });
    }
    /*
     * ── CUANDO EL DINERO SE DA LA VUELTA ────────────────────────────────────
     *
     * Un contracargo o una devolución es un pago que ya dimos por bueno y que
     * después se deshace. Para entonces el cliente ya está reconectado, ya se
     * le dijo "gracias", y la factura ya se marcó como pagada en la oficina.
     *
     * Hasta ahora esto no se escuchaba: el dinero se iba y el sistema seguía
     * creyendo que ese mes estaba pagado. Nadie se enteraba hasta cuadrar caja,
     * si es que alguien cuadraba.
     *
     * Aquí NO se corta a nadie automáticamente. Cortar por un contracargo sería
     * dejar sin internet a alguien que a lo mejor solo no reconoció el nombre
     * del cargo en su estado de cuenta, que es de donde sale la mayoría de las
     * disputas. La decisión es de una persona; lo que hace falta es que esa
     * persona SE ENTERE, con el nombre y el monto en la mano.
     */
    if (evento.type === 'charge.dispute.created' || evento.type === 'charge.dispute.closed') {
      const tel = telefonoDeEventoStripe(o);
      const quien = tel ? `${(wisphubClients.get(tel) || {}).name || 'cliente'} (${tel})` : `cargo ${o.charge || o.id}`;
      const monto = ((Number(o.amount) || 0) / 100).toFixed(2);

      if (evento.type === 'charge.dispute.created') {
        alertAdmin('stripe-disputa',
          `🚨 CONTRACARGO de ${quien} por $${monto}. El banco retuvo ese dinero y hay que responder en Stripe con la evidencia (contrato, historial de servicio) antes de que venza el plazo. El servicio NO se cortó solo: decidan ustedes.`);
        console.warn('[stripe-leon] contracargo ·', quien, '· $' + monto, '·', o.id);
        anotarRegistroPendiente({ tipo: 'disputa', factura: null, total: Number(monto),
          nombre: (wisphubClients.get(tel) || {}).name || '', telefono: tel || '',
          detalle: `Contracargo ${o.id} · motivo: ${o.reason || 'sin especificar'}` });
      } else {
        const gano = o.status === 'won';
        alertAdmin('stripe-disputa',
          `${gano ? '✅' : '❌'} El contracargo de ${quien} por $${monto} se cerró: *${gano ? 'ganado' : String(o.status || 'perdido')}*.`
          + (gano ? ' El dinero regresa.' : ' Ese dinero ya no vuelve; si el cliente sigue conectado, decidan qué hacer.'));
        console.warn('[stripe-leon] disputa cerrada ·', quien, '·', o.status);
      }
      return res.json({ recibido: true, disputa: true });
    }

    if (evento.type === 'charge.refunded') {
      const tel = telefonoDeEventoStripe(o);
      const devuelto = ((Number(o.amount_refunded) || 0) / 100);
      const total = ((Number(o.amount) || 0) / 100);
      const parcial = devuelto > 0 && devuelto < total - 0.01;
      const quien = tel ? `${(wisphubClients.get(tel) || {}).name || 'cliente'} (${tel})` : `cargo ${o.id}`;

      alertAdmin('stripe-devolucion',
        `↩️ DEVOLUCIÓN ${parcial ? 'PARCIAL ' : ''}a ${quien} por $${devuelto.toFixed(2)}`
        + (parcial ? ` de $${total.toFixed(2)}` : '')
        + '. Si ese pago ya se había marcado en Wisphub, hay que deshacerlo ahí.');
      console.warn('[stripe-leon] devolución ·', quien, '· $' + devuelto.toFixed(2), '·', o.id);
      anotarRegistroPendiente({ tipo: 'devolucion', factura: null, total: devuelto,
        nombre: (wisphubClients.get(tel) || {}).name || '', telefono: tel || '',
        detalle: `Devolución del cargo ${o.id}` });
      return res.json({ recibido: true, devolucion: true });
    }

    /*
     * Un cobro que se intentó y no pasó. Casi siempre es el barrido del saldo
     * de una CLABE: el dinero del cliente sigue dentro de Stripe sin llegarle a
     * León. Se anota para que `barrerSaldosRezagados` lo reintente solo, en vez
     * de quedarse esperando a que alguien lo note.
     */
    if (evento.type === 'payment_intent.payment_failed'
        && o.metadata && o.metadata.tipo === 'mensualidad-leontelecom') {
      const tel = String(o.metadata.telefono || '').replace(/\D/g, '');
      const motivo = (o.last_payment_error && o.last_payment_error.message) || 'sin detalle';
      console.warn('[stripe-leon] cobro fallido ·', tel || o.id, '·', motivo);
      if (tel && o.metadata.via === 'clabe') {
        anotarSaldoRezagado(tel, o.customer, (Number(o.amount) || 0) / 100, motivo);
      }
      return res.json({ recibido: true, fallido: true });
    }
  } catch (e) { console.error('[stripe-leon] webhook:', e.message); }

  // Siempre 200: un error nuestro no debe hacer que Stripe reintente sin fin.
  res.json({ recibido: true });
});

// GET: Meta webhook verification challenge
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('[WhatsApp] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST: Incoming WhatsApp messages
app.post('/webhook/whatsapp', async (req, res) => {
  // Verificación de firma de Meta (X-Hub-Signature-256). Opcional: solo se exige
  // si defines META_APP_SECRET (o WHATSAPP_APP_SECRET) en Render. Sin esa variable,
  // el comportamiento es igual que antes (no rompe el bot en producción).
  const APP_SECRET = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '';
  if (APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[WhatsApp] Webhook con firma inválida — rechazado');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  const value = body.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages || messages.length === 0) return;

  const msg = messages[0];
  const rawFrom = msg.from;
  // Normalize Mexican numbers: Meta sometimes sends 521XXXXXXXXXX instead of 52XXXXXXXXXX
  const from = rawFrom.startsWith('521') && rawFrom.length === 13
    ? '52' + rawFrom.slice(3)
    : rawFrom;
  const contactName = value?.contacts?.[0]?.profile?.name || 'Usuario';

  console.log(`[WhatsApp] Incoming: type=${msg.type} from=${from} (raw=${rawFrom}) name=${contactName}`);

  // Métrica: cuenta conversaciones únicas por día (no cuenta a los asesores).
  if (!isAgentNumber(from)) { try { trackConversation(from); } catch (_) {} }

  /*
   * Cada vez que un asesor escribe (lo que sea: texto, botón, foto), WhatsApp
   * reabre la ventana de 24 h para poder mandarle avisos normales. Se anota
   * aquí para saber cuándo está por cerrarse y avisarle antes, y se borra el
   * recordatorio pendiente porque ya no hace falta.
   */
  if (isAgentNumber(from)) {
    const num = _normAgentNum(from);
    agentLastInbound.set(num, new Date().toISOString());
    agentPingSent.delete(num);
    schedulePersist();
  }

  // Save WhatsApp profile name if we don't know this client yet
  if (contactName && contactName !== 'Usuario') {
    const existing = getProfile(from);
    if (!existing?.name || existing.name === 'Usuario') {
      updateProfile(from, { name: contactName });
    }
  }

  if (msg.type === 'image') {
    try {
      const imageBase64 = await downloadWhatsAppMedia(msg.image?.id);
      await handleIncomingImage(from, contactName, imageBase64, 'whatsapp', sendWhatsAppMessage);
    } catch (error) {
      console.error('[WhatsApp] Image handling error:', error.message);
      try { await sendWhatsAppMessage(from, '❌ Error al procesar la imagen. Intenta de nuevo.'); } catch (_) {}
    }
    return;
  }

  if (msg.type === 'document') {
    const fname = msg.document?.filename || 'documento.pdf';
    try {
      // Descargamos el archivo y preguntamos: ¿es comprobante? ¿a nombre de quién el servicio?
      let docUrl = '';
      try {
        const b64 = await downloadWhatsAppMedia(msg.document?.id);
        const mime = msg.document?.mime_type || 'application/octet-stream';
        const ext = (fname.includes('.') ? fname.split('.').pop() : 'pdf');
        docUrl = await storeIncomingFile(b64, mime, ext);
      } catch (e) { console.error('[WhatsApp] Doc download error:', e.message); }
      pendingImage.delete(from); // un doc nuevo invalida una confirmación de imagen en curso
      pendingDoc.set(from, { docUrl, fname, userName: contactName, ts: Date.now() });
      await sendWhatsAppMessage(from,
        `📄 Recibí *${fname}*.\n\n¿Es un *recibo/comprobante de pago*? Si sí, escríbeme *a nombre de quién está el servicio* que estás pagando (nombre completo). 🙌\n\nSi *no* es un comprobante, toca el botón. 👇`,
        [], { buttons: [{ id: 'doc_no', title: '❌ No es comprobante' }] });
    } catch (e) { console.error('[WhatsApp] Document handling error:', e.message); }
    return;
  }

  if (msg.type === 'text') {
    const text = msg.text?.body?.trim();
    if (!text) return;

    // If message is FROM an agent → route to agent handler (commands or relay)
    if (isAgentNumber(from)) {
      await handleAgentCommand(from, text);
      return;
    }


    await handleChatMessage(from, text, sendWhatsAppMessage);
    return;
  }

  // Handle interactive button/list replies (user tapped a button)
  /*
   * Botón de una PLANTILLA. Llega distinto a los botones normales: como
   * `type: 'button'` con `button.payload`, no como `type: 'interactive'`.
   * No estaba contemplado, así que un toque en una plantilla se ignoraba por
   * completo. Importa ahora que el recordatorio de ventana usa un botón.
   */
  if (msg.type === 'button') {
    const payload = msg.button?.payload || msg.button?.text || '';
    console.log(`[WhatsApp] Botón de plantilla: "${payload}" from=${from}`);
    if (payload === 'VENTANA_OK') {
      // El toque en sí ya reabrió la ventana (arriba se anotó el inbound).
      await sendWhatsAppMessage(from, '👍 Listo, seguirás recibiendo los avisos al instante durante las próximas 24 horas.');
      return;
    }
    if (payload) {
      if (isAgentNumber(from)) await handleAgentCommand(from, payload);
      else await handleChatMessage(from, payload, sendWhatsAppMessage);
    }
    return;
  }

  if (msg.type === 'interactive') {
    const itype = msg.interactive?.type;
    let replyId = '';
    if (itype === 'button_reply') {
      replyId = msg.interactive.button_reply?.id || msg.interactive.button_reply?.title || '';
    } else if (itype === 'list_reply') {
      replyId = msg.interactive.list_reply?.id || msg.interactive.list_reply?.title || '';
    }
    if (replyId) {
      console.log(`[WhatsApp] Interactive reply: ${itype} id="${replyId}" from=${from}`);
      // If an agent tapped a button (e.g. "Atender caso") → route to agent commands
      if (isAgentNumber(from)) {
        await handleAgentCommand(from, replyId);
      } else {
        await handleChatMessage(from, replyId, sendWhatsAppMessage);
      }
    }
  }
});


// ==================== ADMIN PANEL ROUTES ====================

// Admin main page - redirect to login
app.get('/admin', (_req, res) => {
  res.redirect('/admin/login');
});

// Evita que el navegador cachee el HTML del panel (siempre la última versión).
function noCacheHtml(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

// Admin login page
app.get('/admin/login', (_req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public/admin-login.html'));
});

// Admin dashboard page — auth handled client-side via localStorage token
app.get('/admin/dashboard', (_req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(__dirname, 'public/admin-dashboard.html'));
});

// ---- Autenticación del panel: tokens firmados (HMAC) con expiración ----
function signAdminToken(user, ttlMs = ADMIN_TOKEN_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({
    u: user.username, n: user.name, role: user.role, perms: permsOf(user),
    iat: Date.now(), exp: Date.now() + ttlMs
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Verifica firma + expiración; devuelve el payload decodificado o null.
function decodeAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!data.exp || Date.now() >= data.exp) return null;
    return data;
  } catch (e) { return null; }
}

// Límite de intentos de login por IP (anti fuerza bruta). Solo cuenta los FALLOS;
// una contraseña CORRECTA siempre entra y limpia el contador (nunca deja afuera al dueño).
const loginAttempts = new Map(); // ip → { count, firstAt, blockedUntil }
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;

function clientIp(req) {
  // Con trust proxy, req.ip = IP real del cliente (no la del proxy de Render).
  return (req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();
}

// API: Admin login (usuario + contraseña)
app.post('/admin/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { rec.count = 0; rec.firstAt = now; rec.blockedUntil = 0; }

  const { username, password } = req.body || {};
  const uname = (username || 'admin').toString().trim().toLowerCase();
  const user = getAdminUser(uname);
  const ok = user && user.active !== false && verifyAdminPassword(password, user.salt, user.hash);

  // Credenciales CORRECTAS → entra siempre (aunque hubiera intentos previos) y limpia el contador.
  if (ok) {
    loginAttempts.delete(ip);
    return res.json({
      success: true, token: signAdminToken(user),
      name: user.name, role: user.role, perms: permsOf(user),
      expiresInHours: Math.round(ADMIN_TOKEN_TTL_MS / 3600000)
    });
  }

  // Credenciales incorrectas: si esta IP ya está bloqueada, rechaza; si no, cuenta y quizá bloquea.
  if (rec.blockedUntil > now) {
    const mins = Math.ceil((rec.blockedUntil - now) / 60000);
    loginAttempts.set(ip, rec);
    return res.status(429).json({ success: false, error: `Demasiados intentos fallidos. Intenta de nuevo en ${mins} min.` });
  }
  rec.count += 1;
  let blocked = false;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) { rec.blockedUntil = now + LOGIN_BLOCK_MS; rec.count = 0; blocked = true; }
  loginAttempts.set(ip, rec);
  if (blocked) {
    return res.status(429).json({ success: false, error: `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(LOGIN_BLOCK_MS / 60000)} min.` });
  }
  return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
});

// Middleware: verifica token y pone req.admin = { username, name, role, perms }
// Bitácora automática: cualquier acción que MODIFIQUE algo desde el panel queda
// registrada con quién la hizo, desde dónde y si salió bien. Se monta antes de las
// rutas, así que cuando termina la respuesta ya sabemos el usuario (req.admin).
function auditar(req, res, next) {
  if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) return next();
  const t0 = Date.now();
  const ruta = req.originalUrl.split('?')[0];
  const detalle = resumenDetalle(req);
  res.on('finish', () => {
    const a = req.admin || {};
    // El login fallido también se registra (útil para detectar intentos raros).
    const usuario = a.username || (ruta === '/admin/api/login' ? String((req.body || {}).username || '?').toLowerCase() : 'anónimo');
    registrarAuditoria({
      ts: new Date().toISOString(),
      user: usuario,
      name: a.name || (ruta === '/admin/api/login' ? '' : 'Desconocido'),
      role: a.role || '',
      ip: clientIp(req),
      accion: nombreAccion(req.method, ruta),
      detalle,
      ok: res.statusCode < 400,
      status: res.statusCode,
      ms: Date.now() - t0
    });
  });
  next();
}
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = req.body?.token || req.query.token || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  const d = decodeAdminToken(token);
  if (!d) return res.status(401).json({ error: 'Sesión expirada o token inválido' });
  if (d.u) {
    const u = getAdminUser(d.u);
    if (!u || u.active === false) return res.status(401).json({ error: 'Usuario deshabilitado' });
  }
  req.admin = { username: d.u, name: d.n, role: d.role, perms: d.perms || [] };
  next();
}

// Middleware: exige un permiso específico (superadmin pasa siempre)
function requirePermission(perm) {
  return (req, res, next) => {
    const a = req.admin;
    // 'admin' = token legado (antes del sistema de usuarios) → acceso total
    if (a && (a.role === 'superadmin' || a.role === 'admin' || (a.perms || []).includes(perm))) return next();
    return res.status(403).json({ error: 'No tienes permiso para esta acción' });
  };
}

// Permite el acceso si el usuario tiene CUALQUIERA de los permisos indicados.
function requireAnyPermission(perms) {
  return (req, res, next) => {
    const a = req.admin;
    if (a && (a.role === 'superadmin' || a.role === 'admin' || (a.perms || []).some(p => perms.includes(p)))) return next();
    return res.status(403).json({ error: 'No tienes permiso para esta acción' });
  };
}

// ==================== HISTORIAL (solo permiso "users") ====================
// Movimientos del panel: quién hizo qué, cuándo y si salió bien.
app.get('/admin/api/audit', verifyAdminToken, requirePermission('users'), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const usuario = String(req.query.user || '').trim().toLowerCase();
  const limite = Math.min(parseInt(req.query.limit, 10) || 200, AUDIT_MAX);
  let filas = auditLog;
  if (usuario) filas = filas.filter(f => (f.user || '').toLowerCase() === usuario);
  if (q) filas = filas.filter(f => `${f.accion} ${f.detalle} ${f.name} ${f.user}`.toLowerCase().includes(q));
  res.json({
    total: auditLog.length,
    mostrando: Math.min(filas.length, limite),
    usuarios: [...new Set(auditLog.map(f => f.user).filter(Boolean))].sort(),
    movimientos: filas.slice(0, limite)
  });
});
// Llamadas a la API de Wisphub (para ver si responde, cuánto tarda y si falla).
app.get('/admin/api/wisphub-logs', verifyAdminToken, requireAnyPermission(['users', 'wisphub']), (req, res) => {
  const ult = wisphubLog.slice(0, 50);
  const oks = wisphubLog.filter(l => l.ok).length;
  res.json({
    total: wisphubLog.length,
    exitosas: oks,
    fallidas: wisphubLog.length - oks,
    promedioMs: wisphubLog.length ? Math.round(wisphubLog.reduce((a, l) => a + (l.ms || 0), 0) / wisphubLog.length) : 0,
    llamadas: ult
  });
});
// API: datos del usuario logueado + catálogo de permisos
app.get('/admin/api/me', verifyAdminToken, (req, res) => {
  res.json({ user: req.admin, allPermissions: ADMIN_PERMISSIONS, permLabels: ADMIN_PERM_LABELS });
});

// ==================== GESTIÓN DE USUARIOS (solo permiso "users") ====================
app.get('/admin/api/users', verifyAdminToken, requirePermission('users'), (req, res) => {
  const users = [...adminUsers.values()].map(u => ({
    username: u.username, name: u.name, role: u.role,
    permissions: permsOf(u), active: u.active !== false
  }));
  res.json({ users, allPermissions: ADMIN_PERMISSIONS, permLabels: ADMIN_PERM_LABELS });
});

app.post('/admin/api/users', verifyAdminToken, requirePermission('users'), (req, res) => {
  let { username, name, password, permissions } = req.body || {};
  username = String(username || '').trim().toLowerCase().replace(/\s+/g, '');
  name = String(name || '').trim();
  if (!username || !password || !name) return res.status(400).json({ error: 'Faltan datos: usuario, nombre y contraseña' });
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) return res.status(400).json({ error: 'Usuario inválido (3-20, solo letras/números)' });
  if (getAdminUser(username)) return res.status(400).json({ error: 'Ese usuario ya existe' });
  // Crear como Administrador (acceso total): solo un superadmin puede.
  const makeAdmin = (req.body && req.body.role === 'superadmin') && req.admin.role === 'superadmin';
  const perms = makeAdmin ? ADMIN_PERMISSIONS.slice()
    : (Array.isArray(permissions) ? permissions.filter(p => ADMIN_PERMISSIONS.includes(p) && p !== 'users') : []);
  const { salt, hash } = hashAdminPassword(password);
  adminUsers.set(username, { username, name, role: makeAdmin ? 'superadmin' : 'staff', salt, hash, permissions: perms, active: true, createdAt: new Date().toISOString() });
  schedulePersist();
  res.json({ success: true });
});

app.patch('/admin/api/users/:username', verifyAdminToken, requirePermission('users'), (req, res) => {
  const u = getAdminUser(req.params.username);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { name, password, permissions, active, role } = req.body || {};
  if (name) u.name = String(name).trim();
  if (typeof active === 'boolean') {
    if (u.role === 'superadmin' && active === false) return res.status(400).json({ error: 'No puedes desactivar al superadmin' });
    u.active = active;
  }
  // Cambio de rol (Administrador ↔ Staff): SOLO un administrador (superadmin) puede.
  if (role === 'superadmin' || role === 'staff') {
    if (req.admin.role !== 'superadmin') return res.status(403).json({ error: 'Solo un administrador puede cambiar el rol' });
    if (role === 'staff' && u.role === 'superadmin') {
      const otrosAdmins = [...adminUsers.values()].filter(x => x.role === 'superadmin' && x.username !== u.username && x.active !== false);
      if (!otrosAdmins.length) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo' });
    }
    u.role = role;
    if (role === 'superadmin') u.permissions = ADMIN_PERMISSIONS.slice();
  }
  if (Array.isArray(permissions) && u.role !== 'superadmin') {
    u.permissions = permissions.filter(p => ADMIN_PERMISSIONS.includes(p) && p !== 'users');
  }
  if (password) { const { salt, hash } = hashAdminPassword(password); u.salt = salt; u.hash = hash; }
  adminUsers.set(u.username, u);
  schedulePersist();
  res.json({ success: true });
});

app.delete('/admin/api/users/:username', verifyAdminToken, requirePermission('users'), (req, res) => {
  const u = getAdminUser(req.params.username);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.role === 'superadmin') return res.status(400).json({ error: 'No puedes eliminar al superadmin' });
  if (req.admin.username === u.username) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  adminUsers.delete(u.username);
  schedulePersist();
  res.json({ success: true });
});

// ==================== GESTIÓN DE PRODUCTOS (permiso "products") ====================
// Una sola fuente de verdad: el bot la lee directo y la web la consume por /api/products.
app.get('/admin/api/products', verifyAdminToken, requirePermission('products'), (req, res) => {
  const list = products.map(p => ({ ...p, imgUrl: getProductImageUrl(p) }));
  const categories = [...new Set(products.map(p => p.cat).filter(Boolean))];
  res.json({ products: list, categories });
});

app.post('/admin/api/products', verifyAdminToken, requirePermission('products'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre del producto' });
  const p = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    price: fmtPrice(b.price),
    cat: String(b.cat || 'Otros').trim() || 'Otros',
    img: String(b.img || '').trim(),
    kw: sanitizeKw(b.kw),
    desc: String(b.desc || '').trim(),
    showWeb: b.showWeb !== false,
    showBot: b.showBot !== false,
    active: b.active !== false
  };
  products.push(p);
  schedulePersist();
  res.json({ success: true, product: p });
});

app.patch('/admin/api/products/:id', verifyAdminToken, requirePermission('products'), (req, res) => {
  const p = findProductById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const b = req.body || {};
  if (b.name !== undefined) p.name = String(b.name).trim() || p.name;
  if (b.price !== undefined) p.price = fmtPrice(b.price);
  if (b.cat !== undefined) p.cat = String(b.cat).trim() || p.cat;
  if (b.img !== undefined) p.img = String(b.img).trim();
  if (b.kw !== undefined) p.kw = sanitizeKw(b.kw);
  if (b.desc !== undefined) p.desc = String(b.desc).trim();
  if (typeof b.showWeb === 'boolean') p.showWeb = b.showWeb;
  if (typeof b.showBot === 'boolean') p.showBot = b.showBot;
  if (typeof b.active === 'boolean') p.active = b.active;
  schedulePersist();
  res.json({ success: true, product: p });
});

app.delete('/admin/api/products/:id', verifyAdminToken, requirePermission('products'), (req, res) => {
  const i = products.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Producto no encontrado' });
  const [removed] = products.splice(i, 1);
  schedulePersist();
  res.json({ success: true, removed });
});

// Banners de promoción para la web (lista editable desde el panel)
app.get('/admin/api/promo-banner', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  res.json({ banners: promoBanners });
});
app.post('/admin/api/promo-banner', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Escribe el texto del banner' });
  const banner = {
    id: 'pb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    text, link: String(b.link || '').trim().slice(0, 300),
    active: b.active !== false, createdAt: new Date().toISOString()
  };
  if (banner.active) promoBanners.forEach(x => x.active = false); // solo uno activo
  promoBanners.unshift(banner);
  schedulePersist();
  res.json({ success: true, banners: promoBanners });
});
app.patch('/admin/api/promo-banner/:id', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  const b = promoBanners.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Banner no encontrado' });
  const body = req.body || {};
  if (body.text !== undefined) b.text = String(body.text).trim().slice(0, 200);
  if (body.link !== undefined) b.link = String(body.link).trim().slice(0, 300);
  if (typeof body.active === 'boolean') {
    b.active = body.active;
    if (body.active) promoBanners.forEach(x => { if (x.id !== b.id) x.active = false; });
  }
  schedulePersist();
  res.json({ success: true, banners: promoBanners });
});
app.delete('/admin/api/promo-banner/:id', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  const i = promoBanners.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Banner no encontrado' });
  promoBanners.splice(i, 1);
  schedulePersist();
  res.json({ success: true, banners: promoBanners });
});
// API pública (la consume la web) — banner activo (sin caché para que se actualice al instante)
app.get('/api/promo', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const a = activePromo();
  res.json({ active: !!a, text: a ? a.text : '', link: a ? a.link : '' });
});

// API pública (la consume la página web) — lista de productos visibles en la web.
app.get('/api/products', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=60');
  const list = getWebProducts().map(p => ({
    id: p.id, name: p.name, price: fmtPrice(p.price),
    cat: p.cat || 'Otros', img: getProductImageUrl(p), desc: p.desc || ''
  }));
  res.json({ products: list, updatedAt: Date.now() });
});

// ---------- PLANES de internet (CRUD desde el panel + API pública para la web) ----------
app.get('/admin/api/plans', verifyAdminToken, requirePermission('products'), (req, res) => {
  res.json({ plans: plans.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) });
});
app.post('/admin/api/plans', verifyAdminToken, requirePermission('products'), (req, res) => {
  const b = req.body || {};
  const mbps = String(b.mbps || '').trim();
  if (!mbps) return res.status(400).json({ error: 'Falta la velocidad (Mbps)' });
  const tipo = b.tipo === 'inalambrico' ? 'inalambrico' : 'fibra';
  const p = {
    id: 'plan' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tipo, segmento: b.segmento === 'negocio' ? 'negocio' : 'hogar',
    mbps, label: String(b.label || '').trim() || (tipo === 'inalambrico' ? 'Internet Inalámbrico' : ''),
    price: fmtPrice(b.price), period: '/mes',
    features: sanitizeFeatures(b.features), badge: String(b.badge || '').trim().slice(0, 20),
    active: b.active !== false, order: Number.isFinite(+b.order) ? +b.order : plans.length
  };
  plans.push(p);
  schedulePersist();
  syncHardcodedPlanPrices(); // el bot cotiza con estos precios
  res.json({ success: true, plan: p });
});
app.patch('/admin/api/plans/:id', verifyAdminToken, requirePermission('products'), (req, res) => {
  const p = findPlanById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan no encontrado' });
  const b = req.body || {};
  if (b.tipo !== undefined) p.tipo = b.tipo === 'inalambrico' ? 'inalambrico' : 'fibra';
  if (b.segmento !== undefined) p.segmento = b.segmento === 'negocio' ? 'negocio' : 'hogar';
  if (b.mbps !== undefined) p.mbps = String(b.mbps).trim() || p.mbps;
  if (b.label !== undefined) p.label = String(b.label).trim();
  if (b.price !== undefined) p.price = fmtPrice(b.price);
  if (b.features !== undefined) p.features = sanitizeFeatures(b.features);
  if (b.badge !== undefined) p.badge = String(b.badge).trim().slice(0, 20);
  if (typeof b.active === 'boolean') p.active = b.active;
  if (b.order !== undefined && Number.isFinite(+b.order)) p.order = +b.order;
  schedulePersist();
  syncHardcodedPlanPrices(); // el bot cotiza con estos precios
  res.json({ success: true, plan: p });
});
app.delete('/admin/api/plans/:id', verifyAdminToken, requirePermission('products'), (req, res) => {
  const i = plans.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Plan no encontrado' });
  const [removed] = plans.splice(i, 1);
  schedulePersist();
  syncHardcodedPlanPrices(); // el bot cotiza con estos precios
  res.json({ success: true, removed });
});
// API pública (la consume la página web) — planes visibles, ordenados.
app.get('/api/plans', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=60');
  const list = getWebPlans().map(p => ({
    id: p.id, tipo: p.tipo, segmento: p.segmento || 'hogar', mbps: p.mbps,
    label: p.label || '', price: fmtPrice(p.price), period: p.period || '/mes',
    features: p.features || [], badge: p.badge || '', wa: planWaLink(p)
  }));
  res.json({ plans: list, updatedAt: Date.now() });
});

// Normaliza un cliente de Wisphub a los campos del estado de cuenta.
function mapWisphubAccount(c) {
  let tel = String(c.telefono || c.celular || '').replace(/\D/g, '');
  if (tel.length === 10) tel = '52' + tel;
  return {
    name: [c.nombre, c.apellidos].filter(Boolean).join(' ') || c.razon_social || c.usuario || '',
    phone: tel,
    status: c.estado,
    saldo: c.saldo,
    fechaCorte: c.fecha_corte,
    plan: (c.plan_internet && c.plan_internet.nombre) || c.plan_internet || '',
    precioPlan: c.precio_plan,
    estadoFacturas: c.estado_facturas,
    id: c.id_servicio || c.id
  };
}

// API: Buscar cliente + estado de cuenta.
// Por NÚMERO → consulta Wisphub EN VIVO (datos frescos, incluye suspendidos).
// Por NOMBRE → busca en lo sincronizado (clientes activos).
/*
 * ¿A ESTE CLIENTE LE SALE LA OPCIÓN DE PAGAR EN LÍNEA, Y POR QUÉ NO?
 *
 * Es la pregunta del primer día: alguien llama diciendo "a mí no me aparece", y
 * del otro lado no había forma de contestarle más que adivinando. Se responde
 * donde la oficina ya busca clientes, no en una pantalla aparte que nadie
 * recuerda que existe.
 *
 * Y se dice el MOTIVO, no solo sí o no: cada motivo se arregla en otro lado.
 */
/*
 * Con quién coincide un nombre escrito a mano ("Ana Lilia Hernández"). Para
 * que el asesor no tenga que buscarlo en Wisphub: el comprobante llega ya con
 * el teléfono, el plan y el estado del servicio al que hay que abonarle. Si
 * hay varias coincidencias se listan todas; si no hay, se dice.
 */
function coincidenciasDeTitular(nombre) {
  // "mi mamá Gloria Núñez", "la señora Ana": el parentesco y el tratamiento sobran.
  const limpio = String(nombre || '').replace(/^(mi|la|el|de mi|de la|del)\s+(mam[aá]|pap[aá]|esposa?|hij[oa]|herman[oa]|suegr[ao]|abuel[oa]|t[ií][ao]|vecin[oa]|se[ñn]ora?|patr[oó]n[a]?|jef[ea])\s+/i, '').replace(/^(se[ñn]ora?|don|do[ñn]a|sr\.?|sra\.?)\s+/i, '');
  const q = limpio.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 4) return [];
  const palabras = q.split(' ').filter((w) => w.length > 2);
  const out = [];
  for (const [tel, c] of wisphubClients.entries()) {
    const n = String(c.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!n) continue;
    const todas = palabras.length && palabras.every((w) => n.includes(w));
    if (todas || n.includes(q)) out.push({ tel, name: c.name, plan: c.plan || '', status: c.status || '', precioPlan: c.precioPlan || '' });
    if (out.length >= 4) break;
  }
  return out;
}
function lineaCoincidencias(nombre, remitente) {
  const c = coincidenciasDeTitular(nombre);
  if (!c.length) return '🔎 No encontré ese nombre en el padrón: revisar a mano.';
  return c.map((x) => `🔎 Coincide: ${x.name} · ${x.tel}${x.plan ? ' · ' + x.plan : ''}${x.status ? ' · ' + x.status : ''}${x.tel === String(remitente || '').replace(/\D/g, '') ? ' (es quien escribe)' : ' (paga otra persona)'}`).join('\n');
}

function conCobroEnLinea(cliente) {
  const tel = String((cliente && cliente.phone) || '').replace(/\D/g, '');
  const puede = tel ? stripeLeon.permitido(tel, TELEFONO_PILOTO_STRIPE) : false;
  let porque = '';
  if (!puede) {
    if (!stripeLeon.activo()) porque = 'el cobro en línea está apagado para todos';
    else if (!stripeLeon.hayLlave()) porque = 'falta configurar Stripe en el servidor';
    else if (!stripeLeon.cuentaConectada()) porque = 'falta dar de alta la cuenta a la que llega el dinero';
    else if (!stripeLeon.cuentaLista()) porque = 'Stripe todavía no aprueba la cuenta de cobro';
    else porque = 'no está entre los clientes del piloto';
  }
  /*
   * Lo que la oficina necesita saber de este cliente de un vistazo cuando
   * llama: si ya pagó por el bot (y cuándo), si tiene prórroga, si pagó meses
   * adelantados, si tiene el cobro automático. Cada una de esas cosas cambia
   * la respuesta que se le da.
   */
  const reg = tel ? (stripeClientes.get(tel) || {}) : {};
  const pago = tel ? pagoRecienteDe(tel) : null;
  const pr = tel ? prorrogaVigente(tel) : null;
  const hoy = fechaLocalISO();
  return {
    ...cliente, cobroEnLinea: puede, cobroEnLineaPorque: porque,
    ultimoPagoEnLinea: pago ? { cuando: new Date(pago.cuando).toISOString(), canal: pago.canal } : null,
    prorroga: pr ? { hasta: pr.hasta, motivo: pr.motivo || '', por: pr.por || '' } : null,
    adelantadoHasta: reg.adelantadoHasta && reg.adelantadoHasta >= hoy ? reg.adelantadoHasta : null,
    cobroAutomatico: !!reg.cobroAutomatico,
    // Qué pasó con el cobro automático de este periodo: cobrado, rechazado, sin tarjeta…
    autoEstado: (() => {
      if (!reg.cobroAutomatico) return null;
      const corte = parseFechaCorte((cliente && cliente.fechaCorte) || (wisphubClients.get(tel) || {}).fechaCorte);
      const per = corte ? (((autoCobros[tel] || {})[corte]) || {}) : {};
      const textos = { cobrado: 'cobrado', rechazado: 'tarjeta rechazada', 'sin-tarjeta': 'sin tarjeta guardada', 'ya-pago': 'ya había pagado', 'sin-deuda': 'sin deuda', 'en-proceso': 'en proceso' };
      return per.estado ? { estado: per.estado, texto: textos[per.estado] || per.estado, corte, cuando: per.cuando || null, motivo: per.motivo || '' } : null;
    })(),
  };
}

app.get('/admin/api/client-lookup', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [], source: 'none' });
  const digits = q.replace(/\D/g, '');

  // Teléfono → consulta en vivo a Wisphub por el campo telefono (10 dígitos).
  if (digits.length >= 7 && WISPHUB_API_KEY) {
    const tel = digits.slice(-10);
    try {
      const r = await wisphubFetch(`${WISPHUB_API_URL}/api/clientes/?format=json&limit=10&telefono=${tel}`,
        { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } }, 'buscar cliente por teléfono', req.admin && req.admin.username);
      if (r.ok) {
        const d = await r.json();
        const items = d.results || (Array.isArray(d) ? d : []);
        const results = items.map(mapWisphubAccount).map(conCobroEnLinea);
        return res.json({ results, source: 'wisphub-live', total: results.length });
      }
    } catch (e) { /* si falla, cae al respaldo en memoria */ }
  }

  // Nombre (o respaldo) → busca en los clientes sincronizados.
  const ql = q.toLowerCase();
  const out = [];
  for (const [phone, c] of wisphubClients.entries()) {
    const byPhone = digits.length >= 3 && phone.includes(digits);
    const byName = String(c.name || '').toLowerCase().includes(ql);
    if (byPhone || byName) {
      out.push(conCobroEnLinea({
        name: c.name, phone, status: c.status, saldo: c.saldo,
        fechaCorte: c.fechaCorte, plan: c.plan, precioPlan: c.precioPlan,
        estadoFacturas: c.estadoFacturas, id: c.wisphubId
      }));
      if (out.length >= 20) break;
    }
  }
  res.json({ results: out, source: 'sync', lastSync: lastWisphubSync, total: out.length });
});

// API: Métricas (productos más solicitados, conversaciones/día, avisos/día)
app.get('/admin/api/metrics', verifyAdminToken, (req, res) => {
  const nameById = {};
  for (const p of products) nameById[p.id] = p.name;
  const topProducts = Object.entries(stats.productHits)
    .map(([id, count]) => ({ id, name: nameById[id] || id, count }))
    .sort((a, b) => b.count - a.count).slice(0, 10);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }));
  }
  const conversations = days.map(k => ({ date: k, count: stats.daily[k] || 0 }));
  const bcByDay = {};
  for (const h of broadcastHistory) {
    if (!h.sentAt) continue;
    const k = new Date(h.sentAt).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const sent = (h.result && typeof h.result.sent === 'number') ? h.result.sent : 0;
    bcByDay[k] = (bcByDay[k] || 0) + sent;
  }
  const broadcasts = days.map(k => ({ date: k, count: bcByDay[k] || 0 }));
  res.json({ topProducts, conversations, broadcasts });
});

// API: Get user count
app.get('/admin/api/user-count', verifyAdminToken, (req, res) => {
  res.json({ count: dataManager.getUserCount() });
});

// API: Send broadcast — ahora o programado a fecha/hora (aviso o promo)
app.post('/admin/api/broadcast', verifyAdminToken, requirePermission('broadcast'), async (req, res) => {
  const { type, label, message, imageUrl, scheduleType, sendAt } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  const id = generateBroadcastId();
  const now = new Date();
  const imageUrls = imageUrl ? [imageUrl] : [];

  // ¿Programado a una fecha/hora futura? (al menos ~20s adelante)
  const when = sendAt ? new Date(sendAt) : null;
  const isScheduled = !!(when && !isNaN(when.getTime()) && when.getTime() > Date.now() + 20000);
  const base = isScheduled ? when : now;

  // Repetición (endAt/intervalMs) calculada desde la fecha base (ahora o programada)
  let intervalMs = null, endAt = null;
  if (scheduleType === 'daily_3days') { intervalMs = 24*3600000; endAt = new Date(base.getTime() + 3*24*3600000).toISOString(); }
  else if (scheduleType === 'daily_7days') { intervalMs = 24*3600000; endAt = new Date(base.getTime() + 7*24*3600000).toISOString(); }
  else if (scheduleType === 'hourly_2h') { intervalMs = 2*3600000; endAt = new Date(base.getTime() + 2*3600000).toISOString(); }
  else if (scheduleType === 'hourly_6h') { intervalMs = 6*3600000; endAt = new Date(base.getTime() + 6*3600000).toISOString(); }
  // else 'once': sin repetición

  const bc = { id, type: type || 'aviso', label: label || message.substring(0, 40), message, imageUrls, scheduleType, intervalMs, endAt, status: 'active', sentCount: 0, createdAt: now.toISOString(), nextSendAt: base.toISOString() };
  scheduledBroadcasts.set(id, bc);

  // Programado a futuro: NO se envía ahora; el scheduler lo manda a la hora indicada.
  if (isScheduled) {
    schedulePersist();
    return res.json({ success: true, id, scheduled: true, sendAt: bc.nextSendAt });
  }

  // RESERVAR el slot ANTES de enviar: el envío masivo puede tardar minutos y el
  // scheduler corre cada 60s; si no reservamos, lo re-dispararía en bucle.
  bc.nextSendAt = intervalMs ? new Date(now.getTime() + intervalMs).toISOString() : null;
  if (!intervalMs) bc.status = 'completed';
  scheduledBroadcasts.set(id, bc);
  schedulePersist();
  // Envío inmediato
  try {
    const result = await sendBroadcastSmart(message, imageUrls);
    bc.sentCount = 1;
    bc.lastSentAt = now.toISOString();
    scheduledBroadcasts.set(id, bc);
    broadcastHistory.unshift({ id, type: bc.type, label: bc.label, message, sentAt: now.toISOString(), result });
    schedulePersist();
    res.json({ success: true, id, result });
  } catch (e) {
    bc.status = 'failed';
    scheduledBroadcasts.set(id, bc);
    schedulePersist();
    res.status(500).json({ error: e.message });
  }
});

// API: List scheduled broadcasts
app.get('/admin/api/broadcasts', verifyAdminToken, (req, res) => {
  const active = [...scheduledBroadcasts.values()].filter(b => b.status === 'active');
  res.json({ broadcasts: active });
});

// API: Cancel a broadcast
app.delete('/admin/api/broadcasts/:id', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  const bc = scheduledBroadcasts.get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'No encontrado' });
  bc.status = 'cancelled';
  scheduledBroadcasts.set(req.params.id, bc);
  schedulePersist();
  res.json({ success: true });
});

// API: Modify broadcast duration
app.patch('/admin/api/broadcasts/:id', verifyAdminToken, requirePermission('broadcast'), (req, res) => {
  const bc = scheduledBroadcasts.get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'No encontrado' });
  const { scheduleType } = req.body;
  const now = new Date();
  if (scheduleType === 'daily_3days') { bc.intervalMs = 24*3600000; bc.endAt = new Date(now.getTime() + 3*24*3600000).toISOString(); }
  else if (scheduleType === 'daily_7days') { bc.intervalMs = 24*3600000; bc.endAt = new Date(now.getTime() + 7*24*3600000).toISOString(); }
  else if (scheduleType === 'hourly_2h') { bc.intervalMs = 2*3600000; bc.endAt = new Date(now.getTime() + 2*3600000).toISOString(); }
  else if (scheduleType === 'hourly_6h') { bc.intervalMs = 6*3600000; bc.endAt = new Date(now.getTime() + 6*3600000).toISOString(); }
  bc.scheduleType = scheduleType;
  scheduledBroadcasts.set(req.params.id, bc);
  schedulePersist();
  res.json({ success: true, broadcast: bc });
});

// API: Broadcast history
app.get('/admin/api/broadcast-history', verifyAdminToken, (req, res) => {
  res.json({ history: broadcastHistory.slice(0, 50) });
});

// API: Upload image → comprime, guarda en MongoDB y sirve desde /images/db/:id
app.post('/admin/api/upload-image', verifyAdminToken, requireAnyPermission(['broadcast', 'products']), (req, res) => {
  upload.single('image')(req, res, async (err) => {
    // Errores de multer (archivo muy grande, no es imagen) → respuesta JSON clara
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'La imagen es muy grande (máx 25 MB).' : (err.message || 'Error al subir el archivo.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
    try {
      let buffer = req.file.buffer;
      let contentType = req.file.mimetype;
      let ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      // Comprimir/redimensionar para que cargue rápido y quepa en la base
      const sharp = getSharp();
      if (sharp) {
        try {
          buffer = await sharp(req.file.buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
          contentType = 'image/jpeg';
          ext = '.jpg';
        } catch (e) { console.warn('[upload] compresión falló, se guarda original:', e.message); }
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const ok = await persistence.saveImage(id, contentType, buffer);
      if (!ok) return res.status(500).json({ error: 'No se pudo guardar la imagen' });
      res.json({ success: true, url: `${SERVER_BASE_URL}/images/db/${id}` });
    } catch (e) {
      console.error('[upload] error:', e.message);
      res.status(500).json({ error: 'No se pudo procesar la imagen' });
    }
  });
});

// Servir imágenes guardadas (público: WhatsApp las descarga desde esta URL)
app.get('/images/db/:id', async (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9._-]/g, '');
  const img = await persistence.loadImage(id);
  if (!img) return res.status(404).send('No encontrado');
  res.set('Content-Type', img.contentType);
  res.set('Cache-Control', 'public, max-age=31536000');
  res.send(img.buffer);
});

// API: Registro de casos del asesor (comprobantes, documentos, solicitudes…)
app.get('/admin/api/casos', verifyAdminToken, (req, res) => {
  res.json({ total: caseLog.length, pendientes: caseLog.filter(c => c.status === 'pendiente').length, casos: caseLog.slice(0, 200) });
});

// ===== Modo Incidencia (falla masiva) — el bot avisa y no satura al asesor =====
app.get('/admin/api/incident', verifyAdminToken, requirePermission('reports'), (req, res) => {
  res.json({ active: incident.active, zona: incident.zona, since: incident.since, testNumber: incident.testNumber || '', avisados: incidentAffected.size });
});
app.post('/admin/api/incident', verifyAdminToken, requirePermission('reports'), async (req, res) => {
  const b = req.body || {};
  if (b.active) {
    if (!incident.active) { incident.since = new Date().toISOString(); incidentAffected = new Set(); }
    incident.active = true;
    incident.zona = String(b.zona || '').trim().slice(0, 80);
    incident.testNumber = String(b.testNumber || '').replace(/\D/g, '').slice(0, 15); // vacío = todos
    schedulePersist();
    return res.json({ success: true, active: true, zona: incident.zona, testNumber: incident.testNumber, since: incident.since });
  }
  // Desactivar (servicio restablecido)
  const afectados = [...incidentAffected];
  incident.active = false; incident.zona = ''; incident.since = null; incident.testNumber = '';
  incidentAffected = new Set();
  schedulePersist();
  const porAvisar = (b.notifyResolved && afectados.length) ? afectados.length : 0;
  res.json({ success: true, active: false, porAvisar });
  // Aviso "ya quedó" en SEGUNDO PLANO (no bloquea la respuesta aunque sean muchos).
  if (porAvisar) {
    (async () => {
      for (const id of afectados) {
        try {
          await sendWhatsAppMessage(id, '✅ ¡Buenas noticias! Tu servicio de internet ya quedó *restablecido*. Si sigues con algún problema, escríbenos y con gusto te ayudamos. — León Telecom 💙');
        } catch (_) {}
        await new Promise(r => setTimeout(r, 150));
      }
      console.log(`[incidencia] aviso de restablecido enviado a ${afectados.length} clientes`);
    })().catch(() => {});
  }
});

// API: Historial de conversación de un cliente (memoria si está, si no del almacén;
// bajo demanda para no cargar todo en RAM). Defensivo: nunca rompe.
app.get('/admin/api/history/:chatId', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  try {
    const id = String(req.params.chatId || '').replace(/\D/g, '');
    if (!id) return res.status(400).json({ error: 'Número inválido' });
    let msgs = [];
    const mem = chatHistory.get(id);
    if (mem && Array.isArray(mem.messages) && mem.messages.length) {
      msgs = mem.messages;
    } else {
      const stored = await persistence.loadConversation(id).catch(() => null);
      if (stored && Array.isArray(stored.messages)) msgs = stored.messages;
    }
    const w = wisphubClients.get(id), man = manualClients.get(id), prof = clientProfiles.get(id);
    const name = (w && w.name) || (man && man.name) || (prof && prof.name) || '';
    const messages = msgs.slice(-200).map(m => ({
      role: m.role === 'user' ? 'user' : 'bot',
      text: String(m.text == null ? '' : m.text).slice(0, 4000),
      ts: m.timestamp || m.ts || null
    }));
    res.json({ chatId: id, name, count: messages.length, messages });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo cargar el historial' });
  }
});

// API: Vista previa de recordatorios de corte (quién recibiría el aviso mañana)
// Lleva permiso 'clients' como sus vecinas (cobranza, historial, plantillas de corte):
// ahora devuelve saldo y estado de facturas de cada cliente, y eso no lo debe ver
// cualquier usuario del panel, solo quien ya tiene acceso a datos de clientes.
app.get('/admin/api/corte-reminders', verifyAdminToken, requirePermission('clients'), (req, res) => {
  const mananaDate = new Date(Date.now() + 24 * 3600 * 1000);
  const manana = mexicoDateStr(mananaDate);
  const lista = [];
  let alCorriente = 0, aEnviar = 0;
  for (const [phone, c] of wisphubClients.entries()) {
    const fc = parseFechaCorte(c.fechaCorte);
    if (fc !== manana) continue;
    // debe=false → ya pagó y NO se le manda nada (mismo criterio que Cobranza).
    const debe = clienteDebe(c);
    const yaEnviado = !!corteReminders[`${phone}|${fc}`];
    if (!debe) alCorriente++; else if (!yaEnviado) aEnviar++;
    lista.push({ name: c.name, phone, plan: c.plan || '', fechaCorte: c.fechaCorte, yaEnviado, debe, saldo: c.saldo, estadoFacturas: c.estadoFacturas || '' });
  }
  res.json({
    manana, total: lista.length, aEnviar, alCorriente,
    habilitado: CORTE_REMINDER_ENABLED, hora: CORTE_REMINDER_TIME, tope: CORTE_REMINDER_LIMIT,
    plantillaConfigurada: !!WHATSAPP_AVISO_TEMPLATE,
    corridaHoy: lastCorteRunDate === mexicoDateStr(),
    // Con qué datos se está mirando esto: si no están completos, el barrido no envía.
    datosCompletos: !!lastWisphubComplete && !wisphubSyncError,
    ultimoSync: lastWisphubSync,
    // Constancia de las corridas y de los días que se saltaron.
    corridas: corteRunLog.slice(0, 30),
    huecos: huecosCorte(14),
    lista: lista.slice(0, 200)
  });
});

// API: Tablero del aviso de corte — a cuántos se les avisó HOY, a cuántos NO porque ya
// pagaron (con nombres) y si el barrido corrió cada uno de los últimos días. Solo lee.
app.get('/admin/api/corte-reminders/stats', verifyAdminToken, requirePermission('clients'), (req, res) => {
  try {
    const hoy = mexicoDateStr();
    const manana = mexicoDateStr(new Date(Date.now() + 24 * 3600 * 1000));
    const OMIT_MAX = 300;

    // Lo de HOY se cuenta EN VIVO contra corteReminders (los envíos de verdad), no con
    // los contadores de la corrida: si alguien forzó una corrida temprano, la automática
    // reportaría "0 enviados" aunque la gente sí quedó avisada.
    let total = 0, notificados = 0, omitidosPago = 0, sinAviso = 0;
    const omitidos = [];
    for (const [phone, c] of wisphubClients.entries()) {
      if (parseFechaCorte(c.fechaCorte) !== manana) continue;
      total++;
      if (!clienteDebe(c)) {
        omitidosPago++;
        if (omitidos.length < OMIT_MAX) omitidos.push({ name: c.name || '', phone, plan: c.plan || '' });
        continue;
      }
      if (corteReminders[`${phone}|${manana}`]) notificados++; else sinAviso++;
    }

    const filaHoy = corteRunLog.find(x => x && x.fecha === hoy && x.ok) || null;
    const corridasHoy = corteRunLog.filter(x => x && x.fecha === hoy && x.ok).length;
    const objetivo = parseTimeToMinutes(CORTE_REMINDER_TIME);
    const { minutesOfDay } = mexicoNow();
    const hhmm = iso => { try { return new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch (_) { return ''; } };
    // El día más viejo con registro: antes de eso la bitácora no existía, así que un día
    // sin corrida NO es un hueco de verdad y no hay que pintarlo de rojo.
    const masViejo = corteRunLog.reduce((a, x) => (x && x.fecha && (!a || x.fecha < a)) ? x.fecha : a, null);

    // Un renglón por día AUNQUE no haya corrido: el día vacío es justo el que hay que ver.
    const dias = [];
    for (let i = 0; i < 14; i++) {
      const d = mexicoDateStr(new Date(Date.now() - i * 24 * 3600 * 1000));
      const f = corteRunLog.find(x => x && x.fecha === d && x.ok) || null;
      dias.push({
        fecha: d, corrio: !!f,
        corridas: corteRunLog.filter(x => x && x.fecha === d && x.ok).length,
        hora: f ? hhmm(f.at) : null, forzada: !!(f && f.forzada),
        notificados: f ? ((f.sent || 0) + (f.yaEnviados || 0)) : 0,
        omitidosPago: f ? (f.alCorriente || 0) : 0,
        fallidos: f ? (f.failed || 0) : 0,
        sinDatos: !f && (!masViejo || d < masViejo),
        pendiente: d === hoy && !f && CORTE_REMINDER_ENABLED && minutesOfDay < objetivo,
        // Salieron avisos pero no quedó constancia: se reinició el servidor a media
        // corrida (en Render gratis pasa) y quedó gente sin su aviso.
        parcial: d === hoy && !f && notificados > 0,
      });
    }

    res.json({
      hoy, manana,
      habilitado: CORTE_REMINDER_ENABLED, hora: CORTE_REMINDER_TIME,
      plantillaConfigurada: !!(WHATSAPP_AVISO_TEMPLATE && WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN),
      clientesCargados: wisphubClients.size > 0,
      sincronizando: !!_wisphubSyncing,
      wisphubError: wisphubSyncError || '',
      wisphubAl: lastWisphubSync || null,
      corridaHoy: !!filaHoy, horaCorrida: filaHoy ? hhmm(filaHoy.at) : null,
      forzadaHoy: !!(filaHoy && filaHoy.forzada), corridas: corridasHoy,
      pendienteHoy: !filaHoy && CORTE_REMINDER_ENABLED && minutesOfDay < objetivo,
      parcialHoy: !filaHoy && notificados > 0,
      total, notificados, omitidosPago, sinAviso,
      fallidos: filaHoy ? (filaHoy.failed || 0) : 0,
      omitidos, omitidosTruncados: omitidosPago > OMIT_MAX, omitidosMax: OMIT_MAX,
      dias,
    });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo cargar el tablero de avisos de corte.' });
  }
});

// API: Forzar la corrida de recordatorios de corte AHORA (para probar)
// Este botón MANDA WHATSAPPS A CLIENTES REALES y no pedía ningún permiso: cualquier
// usuario del panel, aunque solo tuviera 'productos', podía dispararlo. Se exige
// 'broadcast' o 'clients' (superadmin/admin pasan siempre) para no quitarle el botón a
// quien hoy sí lo usa.
app.post('/admin/api/corte-reminders/run', verifyAdminToken, requireAnyPermission(['broadcast', 'clients']), async (req, res) => {
  const r = await sweepCorteReminders(true);
  res.json(r || { error: 'No se pudo correr (¿plantilla o Wisphub sin configurar?)' });
});

// ===== Plantillas del mensaje de aviso de corte (predeterminada + personalizadas) =====
// Listar (marca la activa; incluye variables disponibles).
app.get('/admin/api/corte-templates', verifyAdminToken, requirePermission('clients'), (req, res) => {
  res.json(corteTemplatesPayload());
});
// Crear una plantilla personalizada. Por defecto queda ACTIVA (solo una activa).
app.post('/admin/api/corte-templates', verifyAdminToken, requirePermission('clients'), (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 900);
  if (!text) return res.status(400).json({ error: 'Escribe el texto del mensaje' });
  const name = String(b.name || '').trim().slice(0, 60) || ('Plantilla ' + (corteTemplates.length + 1));
  const now = new Date().toISOString();
  const t = { id: 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, text, createdAt: now, updatedAt: now };
  corteTemplates.unshift(t);
  if (b.activate !== false) corteActiveId = t.id; // al crear queda activa
  schedulePersist();
  res.json({ success: true, ...corteTemplatesPayload() });
});
// Editar (texto/nombre) o activar. La predeterminada no se edita, solo se activa.
app.patch('/admin/api/corte-templates/:id', verifyAdminToken, requirePermission('clients'), (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  // Activar → deja SOLO esta activa (o la predeterminada con id 'default').
  if (body.active === true) {
    if (id === 'default') corteActiveId = 'default';
    else if (corteTemplates.some(t => t.id === id)) corteActiveId = id;
    else return res.status(404).json({ error: 'Plantilla no encontrada' });
    schedulePersist();
    return res.json({ success: true, ...corteTemplatesPayload() });
  }
  if (id === 'default') return res.status(400).json({ error: 'La plantilla predeterminada no se puede editar. Crea una nueva.' });
  const t = corteTemplates.find(x => x.id === id);
  if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
  if (body.text !== undefined) {
    const text = String(body.text).trim().slice(0, 900);
    if (!text) return res.status(400).json({ error: 'El texto no puede quedar vacío' });
    t.text = text;
  }
  if (body.name !== undefined) t.name = String(body.name).trim().slice(0, 60) || t.name;
  t.updatedAt = new Date().toISOString();
  if (body.activate) corteActiveId = t.id;
  schedulePersist();
  res.json({ success: true, ...corteTemplatesPayload() });
});
// Eliminar una personalizada. Si estaba activa → regresa a la predeterminada (nunca queda vacío).
app.delete('/admin/api/corte-templates/:id', verifyAdminToken, requirePermission('clients'), (req, res) => {
  const id = req.params.id;
  if (id === 'default') return res.status(400).json({ error: 'La plantilla predeterminada no se puede eliminar' });
  const i = corteTemplates.findIndex(x => x.id === id);
  if (i < 0) return res.status(404).json({ error: 'Plantilla no encontrada' });
  corteTemplates.splice(i, 1);
  if (corteActiveId === id) corteActiveId = 'default';
  schedulePersist();
  res.json({ success: true, ...corteTemplatesPayload() });
});

// API: List all clients (bot + manual)
app.get('/admin/api/clients', verifyAdminToken, (req, res) => {
  const recipients = getAllBroadcastRecipients();
  // Enriquece con datos de cuenta (plan, estado, corte, saldo) para filtros y exportación.
  const clients = recipients.map(r => {
    const w = wisphubClients.get(r.chatId);
    return {
      ...r,
      plan: (w && w.plan) || '',
      estado: (w && w.status) || '',
      fechaCorte: (w && w.fechaCorte) || '',
      saldo: (w && w.saldo != null) ? w.saldo : '',
      precioPlan: (w && w.precioPlan) || ''
    };
  });
  res.json({ clients, total: clients.length });
});

// Trae TODOS los clientes de Wisphub (todos los estados) con caché de 10 min.
let _allClientsCache = { at: 0, data: null };
async function getAllWisphubClientsCached(maxAgeMs = 10 * 60 * 1000) {
  if (_allClientsCache.data && (Date.now() - _allClientsCache.at) < maxAgeMs) return _allClientsCache.data;
  if (!WISPHUB_API_KEY) return [];
  const out = [];
  let offset = 0, count = null, pages = 0;
  while (pages < 30) {
    const r = await wisphubFetch(`${WISPHUB_API_URL}/api/clientes/?format=json&limit=500&offset=${offset}`,
      { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } }, 'todos los clientes (offset ' + offset + ')');
    if (!r.ok) break;
    const d = await r.json();
    if (count === null) count = d.count;
    const items = d.results || (Array.isArray(d) ? d : []);
    if (!items.length) break;
    out.push(...items);
    offset += items.length; pages++;
    if (count && offset >= count) break;
  }
  if (out.length) _allClientsCache = { at: Date.now(), data: out };
  return out;
}

// API: Resumen de cobranza (activos/suspendidos/adeudo/ingreso/próximos cortes/morosos)
app.get('/admin/api/cobranza', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  try {
    const all = await getAllWisphubClientsCached();
    if (!all.length) return res.json({ error: 'Sin datos de Wisphub (configura WISPHUB_API_KEY o sincroniza).', totals: {} });
    const low = s => String(s || '').toLowerCase();
    let activos = 0, suspendidos = 0, gratis = 0, otros = 0, ingreso = 0, conAdeudo = 0, saldoPend = 0;
    const ciclo = {}; const morosos = [];
    for (const c of all) {
      const est = String(c.estado || '');
      const e = low(est);
      const saldo = parseFloat(c.saldo || 0) || 0;
      const fact = String(c.estado_facturas || '');
      const activo = e.includes('activ');
      if (activo) activos++;
      else if (e.includes('suspend')) suspendidos++;
      else if (e.includes('gratis')) gratis++;
      else otros++;
      if (activo) ingreso += parseFloat(c.precio_plan || 0) || 0;
      const debe = e.includes('suspend') || saldo > 0 || facturaDebe(fact);
      if (debe) { conAdeudo++; if (saldo > 0) saldoPend += saldo; }
      if (activo && c.fecha_corte) ciclo[c.fecha_corte] = (ciclo[c.fecha_corte] || 0) + 1;
      if (e.includes('suspend') || saldo > 0) {
        let tel = String(c.telefono || c.celular || '').replace(/\D/g, ''); if (tel.length === 10) tel = '52' + tel;
        morosos.push({
          name: [c.nombre, c.apellidos].filter(Boolean).join(' ') || c.razon_social || c.usuario || '',
          phone: tel, estado: est, saldo: c.saldo, fechaCorte: c.fecha_corte,
          plan: (c.plan_internet && c.plan_internet.nombre) || c.plan_internet || ''
        });
      }
    }
    const parseF = f => { const m = String(f).split('/'); return m.length === 3 ? new Date(+m[2], +m[1] - 1, +m[0]).getTime() : 0; };
    const ciclos = Object.entries(ciclo).map(([fecha, n]) => ({ fecha, n, ts: parseF(fecha) }))
      .sort((a, b) => a.ts - b.ts).map(({ fecha, n }) => ({ fecha, n }));
    morosos.sort((a, b) => (parseFloat(b.saldo || 0) || 0) - (parseFloat(a.saldo || 0) || 0));
    res.json({
      generatedAt: _allClientsCache.at,
      totals: { todos: all.length, activos, suspendidos, gratis, otros },
      ingresoMensual: ingreso, conAdeudo, saldoPendiente: saldoPend,
      ciclos, morosos: morosos.slice(0, 200)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== TICKETS DE SOPORTE (permiso "reports") ====================
app.get('/admin/api/tickets', verifyAdminToken, requirePermission('reports'), (req, res) => {
  const order = { abierto: 0, en_proceso: 1, resuelto: 2 };
  const list = [...tickets.values()].sort((a, b) =>
    (order[a.estado] ?? 0) - (order[b.estado] ?? 0) || new Date(b.createdAt) - new Date(a.createdAt));
  const tecnicos = [...adminUsers.values()].map(u => u.name).filter(Boolean);
  res.json({ tickets: list, tecnicos });
});

app.patch('/admin/api/tickets/:id', verifyAdminToken, requirePermission('reports'), (req, res) => {
  const t = tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
  const b = req.body || {};
  if (b.estado && ['abierto', 'en_proceso', 'resuelto'].includes(b.estado)) t.estado = b.estado;
  if (b.tecnico !== undefined) t.tecnico = String(b.tecnico).trim();
  if (b.nota !== undefined) t.nota = String(b.nota).trim();
  t.updatedAt = new Date().toISOString();
  tickets.set(t.id, t);
  schedulePersist();
  res.json({ success: true, ticket: t });
});

app.delete('/admin/api/tickets/:id', verifyAdminToken, requirePermission('reports'), (req, res) => {
  if (!tickets.delete(req.params.id)) return res.status(404).json({ error: 'Ticket no encontrado' });
  schedulePersist();
  res.json({ success: true });
});

// Avisar al cliente por WhatsApp sobre su ticket
app.post('/admin/api/tickets/:id/notify', verifyAdminToken, requirePermission('reports'), async (req, res) => {
  const t = tickets.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
  const custom = String((req.body && req.body.message) || '').trim();
  const msg = custom || `Hola${t.name ? ' ' + t.name : ''}, sobre tu reporte (folio ${t.folio}): nuestro equipo técnico ya lo está atendiendo. Te mantendremos al tanto. — León Telecom 🔧`;
  try { await sendWhatsAppMessage(t.chatId, msg); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'No se pudo enviar: ' + e.message }); }
});

// ==================== DASHBOARD EJECUTIVO (permiso "clients") ====================
app.get('/admin/api/ejecutivo', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  try {
    const all = await getAllWisphubClientsCached();
    if (!all.length) return res.json({ error: 'Sin datos de Wisphub.' });
    const ym = s => { const p = String(s || '').split(' ')[0].split('/'); return p.length === 3 ? p[2] + '-' + String(p[1]).padStart(2, '0') : null; };
    const altas = {}, bajas = {}, ingCiudad = {}, ingPlan = {};
    let ingreso = 0, activos = 0;
    for (const c of all) {
      const fi = ym(c.fecha_instalacion); if (fi) altas[fi] = (altas[fi] || 0) + 1;
      if (c.fecha_cancelacion) { const fc = ym(c.fecha_cancelacion); if (fc) bajas[fc] = (bajas[fc] || 0) + 1; }
      if (String(c.estado || '').toLowerCase().includes('activ')) {
        activos++;
        const p = parseFloat(c.precio_plan || 0) || 0; ingreso += p;
        const ciudad = (String(c.ciudad || '').trim()) || '(sin ciudad)';
        ingCiudad[ciudad] = (ingCiudad[ciudad] || 0) + p;
        const plan = (c.plan_internet && c.plan_internet.nombre) || c.plan_internet || '(sin plan)';
        ingPlan[plan] = (ingPlan[plan] || 0) + p;
      }
    }
    const months = []; const now = new Date();
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
    const altasMes = months.map(m => ({ mes: m, n: altas[m] || 0 }));
    const bajasMes = months.map(m => ({ mes: m, n: bajas[m] || 0 }));
    const last3 = altasMes.slice(-3).reduce((s, x) => s + x.n, 0) / 3;
    const ciudades = Object.entries(ingCiudad).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 12);
    const planes = Object.entries(ingPlan).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 12);
    res.json({ activos, ingresoMensual: ingreso, altasMes, bajasMes, proyeccionAltas: Math.round(last3), ciudades, planes, generatedAt: _allClientsCache.at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Facturas de Wisphub indexadas por cliente (id_servicio), con caché de 10 min.
let _invoicesCache = { at: 0, byId: null };
async function getInvoicesByClientCached(maxAgeMs = 10 * 60 * 1000) {
  if (_invoicesCache.byId && (Date.now() - _invoicesCache.at) < maxAgeMs) return _invoicesCache.byId;
  if (!WISPHUB_API_KEY) return {};
  const byId = {};
  let offset = 0, count = null, pages = 0;
  while (pages < 40) {
    const r = await wisphubFetch(`${WISPHUB_API_URL}/api/facturas/?format=json&limit=500&offset=${offset}`,
      { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } }, 'facturas (offset ' + offset + ')');
    if (!r.ok) break;
    const d = await r.json();
    if (count === null) count = d.count;
    const items = d.results || [];
    if (!items.length) break;
    for (const f of items) {
      const usu = String((f.cliente && f.cliente.usuario) || '');
      const m = usu.match(/^(\d+)/);
      if (!m) continue;
      (byId[m[1]] = byId[m[1]] || []).push(f);
    }
    offset += items.length; pages++;
    if (count && offset >= count) break;
  }
  if (Object.keys(byId).length) _invoicesCache = { at: Date.now(), byId };
  return byId;
}

// API: Facturas de un cliente (por id_servicio)
app.get('/admin/api/client-invoices', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  const id = String(req.query.id || '').replace(/\D/g, '');
  if (!id) return res.json({ invoices: [], total: 0 });
  try {
    const byId = await getInvoicesByClientCached();
    const raw = byId[id] || [];
    const invoices = raw.map(f => ({
      folio: f.folio || ('#' + f.id_factura),
      emision: f.fecha_emision, vencimiento: f.fecha_vencimiento, pago: f.fecha_pago,
      estado: f.estado, total: f.total, saldo: f.saldo,
      formaPago: (f.forma_pago && f.forma_pago.nombre) || ''
    })).sort((a, b) => new Date(b.emision || 0) - new Date(a.emision || 0)).slice(0, 15);
    res.json({ invoices, total: raw.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Add manual client
app.post('/admin/api/clients', verifyAdminToken, requirePermission('clients'), (req, res) => {
  let { phone, name, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número requerido' });
  // Normalize number
  phone = phone.replace(/\D/g, '');
  if (!phone.startsWith('52')) phone = '52' + phone;
  if (phone.startsWith('521') && phone.length === 13) phone = '52' + phone.slice(3);
  manualClients.set(phone, { name: name || '', phone, notes: notes || '', addedAt: new Date().toISOString() });
  schedulePersist();
  res.json({ success: true, phone });
});

// API: Delete manual client
app.delete('/admin/api/clients/:phone', verifyAdminToken, requirePermission('clients'), (req, res) => {
  manualClients.delete(req.params.phone);
  schedulePersist();
  res.json({ success: true });
});

// API: Wisphub sync status
app.get('/admin/api/wisphub-status', verifyAdminToken, (req, res) => {
  res.json({
    configured: !!WISPHUB_API_KEY,
    lastSync: lastWisphubSync,
    error: wisphubSyncError,
    count: wisphubClients.size,
    total: lastWisphubTotal,
    sinTelefono: lastWisphubSinTel
  });
});

// API: Trigger Wisphub sync manually
app.post('/admin/api/wisphub-sync', verifyAdminToken, requirePermission('wisphub'), async (req, res) => {
  const result = await syncWisphubClients();
  // Si ya había una sincronización en curso, avisamos claro (no es un error de 0 clientes).
  if (result && result.skipped) {
    return res.json({ skipped: true, message: 'Ya hay una sincronización en curso. Espera unos segundos e intenta de nuevo.' });
  }
  res.json(result);
});

/*
 * Ver y mover a mano el dinero atorado en Stripe.
 *
 * El barrido automático corre cada diez minutos, y para casi todo eso sobra.
 * Pero el día que un cliente llame diciendo "ya transferí" nadie quiere
 * contestarle "espérate diez minutos": con esto se revisa y se mueve al
 * momento, y la respuesta dice exactamente cuánto se rescató.
 *
 * `?auditar=1` fuerza la revisión de TODOS los clientes con CLABE, no solo de
 * los que ya se sabía que habían fallado.
 */
/* ═══════════ LA CUENTA A LA QUE LE CAE EL DINERO, DESDE EL PANEL ═══════════
 *
 * Antes esto era una variable de entorno que alguien tenía que crear a mano en
 * Stripe y pegar en Render. León no podía hacerlo solo, y mientras tanto todo
 * el cobro en línea se quedaba apagado esperando a que alguien más se sentara.
 */
app.get('/admin/api/cuenta-cobro', verifyAdminToken, requirePermission('reports'), async (_req, res) => {
  try {
    if (!stripeLeon.hayLlave()) {
      return res.json({ ok: true, configurado: false, cuenta: null });
    }
    const id = stripeLeon.cuentaConectada();
    if (!id) return res.json({ ok: true, configurado: true, cuenta: null });
    let est = null;
    try { est = await stripeLeon.estadoCuenta(); }
    catch (e) { console.warn('[cobro] no se pudo consultar la cuenta:', e.message); }
    res.json({
      ok: true, configurado: true,
      cuenta: {
        id,
        puedeCobrar: est ? est.puedeCobrar : stripeLeon.cuentaLista(),
        faltante: (est && est.faltante) || [],
        banco: (est && est.banco) || null,
        demora: est ? est.demora : null,
        sinRespuesta: !est,
      },
    });
  } catch (e) {
    console.error('[cobro] cuenta:', e.message);
    res.status(500).json({ ok: false, error: 'No se pudo consultar la cuenta de cobro.' });
  }
});

app.post('/admin/api/cuenta-cobro', verifyAdminToken, requirePermission('reports'), async (req, res) => {
  try {
    if (!stripeLeon.hayLlave()) {
      return res.status(503).json({ ok: false, error: 'Todavía no está configurado el cobro con tarjeta.' });
    }
    const urlBase = (process.env.URL_PUBLICA || '').replace(/\/$/, '')
      || `${req.protocol}://${req.get('host')}`;
    await stripeLeon.crearCuentaConectada({
      email: (process.env.LEON_CONTACTO_EMAIL || '').trim() || undefined,
      nombre: 'León Telecom',
    });
    res.json({ ok: true, urlAlta: await stripeLeon.enlaceOnboarding({ urlBase }) });
  } catch (e) {
    const dice = (e.stripe && e.stripe.message) || e.message || '';
    console.error('[cobro] alta de cuenta:', dice);
    /*
     * Un 4xx de Stripe es configuración que falta: el siguiente intento va a
     * fallar igual. Decir "intenta luego" manda a picar un botón que nunca va
     * a servir y esconde la causa en un registro que nadie abre.
     */
    if (e.status >= 400 && e.status < 500 && dice) {
      return res.status(503).json({ ok: false, error: 'Stripe no dejó crear la cuenta y dijo esto: “' + dice.slice(0, 300) + '”. No es un problema pasajero.' });
    }
    res.status(502).json({ ok: false, error: 'No pudimos abrir el alta de la cuenta. Intenta en un momento.' });
  }
});

/*
 * El estado del cobro en línea de un vistazo, para el panel.
 *
 * Lo que una persona necesita saber sin abrir Stripe: si está encendido, a
 * quién se le está ofreciendo, cuánta gente ya tiene su CLABE, y sobre todo si
 * hay dinero parado o pagos que se dieron la vuelta.
 */
function describirAlcance(valor) {
  const v = String(valor || '').trim();
  if (!v) return 'solo el teléfono piloto';
  if (v === '*') return `todos los clientes (${wisphubClients.size})`;
  if (/^\d{1,3}\s*%$/.test(v)) {
    const pct = parseInt(v, 10);
    const cuantos = Math.round((pct / 100) * wisphubClients.size);
    return `${pct}% del padrón · unos ${cuantos} clientes`;
  }
  if (/^\d{1,6}$/.test(v)) {
    const meta = Number(v);
    const total = wisphubClients.size;
    if (meta >= total && total) return `todos los clientes (${total})`;
    return `${meta} clientes${total ? ` de ${total}` : ''} · los que más batallan para pagar`;
  }
  const cuantos = v.split(',').filter((x) => x.replace(/\D/g, '')).length;
  return `${cuantos} ${cuantos === 1 ? 'teléfono elegido' : 'teléfonos elegidos'} a mano`;
}

app.get('/admin/api/stripe/estado', verifyAdminToken, (req, res) => {
  const alcance = (process.env.COBRO_LINEA_TELEFONOS || '').trim();
  const atorado = [...stripeSaldosRezagados.values()].reduce((a, r) => a + (Number(r.pesos) || 0), 0);
  const porTipo = (t) => stripeRegistrosPendientes.filter((r) => r.tipo === t).length;
  res.json({
    activo: stripeLeon.activo(),
    hayLlave: stripeLeon.hayLlave(),
    /*
     * La cuenta puede venir del panel o de la variable de siempre. Mirar solo
     * la variable hacía que el tablero dijera "falta configurar Stripe" aunque
     * él ya la hubiera dado de alta con sus propias manos.
     */
    // Cobro automático: cuántos lo tienen y qué hizo la última pasada.
    automatico: {
      activos: [...stripeClientes.entries()].filter(([k, v]) => v && v.cobroAutomatico && !stripeLeon.partirClave(k).servicioId).length,
      ultimoBarrido: _ultimoBarridoAuto,
      // Los que este periodo NO se pudieron cobrar y siguen sin pagar: la oficina tiene que ir tras ellos.
      pendientes: (() => {
        const lista = [];
        const hace45 = fechaLocalISO(new Date(Date.now() - 45 * 86400000));
        for (const [tel, log] of Object.entries(autoCobros)) {
          if (!(stripeClientes.get(tel) || {}).cobroAutomatico) continue;
          for (const [corte, per] of Object.entries(log || {})) {
            if (!per || (per.estado !== 'rechazado' && per.estado !== 'sin-tarjeta') || corte < hace45) continue;
            if (pagoRecienteDe(tel)) continue;
            lista.push({ telefono: tel, nombre: (wisphubClients.get(tel) || {}).name || '', corte, estado: per.estado, motivo: per.motivo || '', cuando: per.cuando || null });
          }
        }
        return lista.sort((a, b) => b.corte.localeCompare(a.corte)).slice(0, 50);
      })(),
    },
    cuentaConectada: !!stripeLeon.cuentaConectada(),
    cuentaLista: stripeLeon.cuentaLista(),
    reactivacionActiva: wisphubReactivar.activo(),
    /*
     * El alcance en palabras, no en crudo.
     *
     * Decía "50" a secas, que se lee como 50 por ciento, o como 50 y quién
     * sabe qué. Quien abre este tablero necesita entender a cuánta gente le
     * está entrando dinero sin tener que acordarse de cómo se configura.
     */
    alcance: describirAlcance(alcance),
    /*
     * Lo que de verdad quiere saber: cuánto ha entrado. Se manda el mes en
     * curso y el anterior, que es lo que permite ver si crece.
     */
    cobrado: (() => {
      const meses = [...stripeCobrado.keys()].sort().slice(-2).reverse();
      return meses.map((mes) => ({ mes, ...stripeCobrado.get(mes) }));
    })(),
    conClabe: [...stripeClientes.values()].filter((d) => d && d.clienteId).length,
    rezagados: stripeSaldosRezagados.size,
    atorado: +atorado.toFixed(2),
    porRegistrar: porTipo('factura') + porTipo('afavor') + porTipo('ambiguo'),
    revertidos: porTipo('disputa') + porTipo('devolucion'),
    /*
     * Lo que costó cobrar sin haber podido cobrar el cargo. Cada transferencia
     * SPEI le cuesta $8.12 a la plataforma, así que un pago sin cargo no es
     * "ganar cero": es perder esos $8.12.
     */
    sinCargo: (() => {
      const desde = Date.now() - 30 * 24 * 3600 * 1000;
      const recientes = stripeCargosPerdidos.filter((x) => x.cuando > desde);
      return { cantidad: recientes.length, costo: +(recientes.length * COSTO_SPEI).toFixed(2) };
    })(),
  });
});

app.get('/admin/api/stripe/rezagados', verifyAdminToken, (req, res) => {
  const lista = [...stripeSaldosRezagados.entries()].map(([telefono, r]) => ({
    telefono,
    nombre: (wisphubClients.get(telefono) || {}).name || '',
    pesos: Number(r.pesos) || 0,
    intentos: r.intentos || 0,
    desde: r.desde ? new Date(r.desde).toISOString() : null,
    error: r.error || '',
    // Ya no se reintenta solo: necesita que una persona lo mueva desde Stripe.
    agotado: (r.intentos || 0) >= REZAGO_INTENTOS_MAX,
  }));
  res.json({ total: lista.length, rezagados: lista });
});

app.post('/admin/api/stripe/barrer', verifyAdminToken, async (req, res) => {
  try {
    const r = await barrerSaldosRezagados({ forzarAuditoria: req.query.auditar === '1' });
    res.json(r || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get network status (check Wisphub or return online)
app.get('/admin/api/network-status', verifyAdminToken, async (req, res) => {
  try {
    // For now, return online. In production, check Wisphub API
    res.json({ online: true, message: 'Servicio operativo' });
  } catch (error) {
    res.json({ online: false, message: error.message });
  }
});

// API: Send bulk message
app.post('/admin/api/send-message', verifyAdminToken, async (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mensaje vacío' });
  }

  try {
    const users = dataManager.getAllUsers();
    let sent = 0;

    for (const user of users) {
      try {
        await sendTelegramMessage(user.chatId, `📢 ANUNCIO\n\n${message}`);
        sent++;
      } catch (error) {
        console.error(`Failed to send message to ${user.chatId}:`, error.message);
      }
    }

    res.json({ success: true, sent, total: users.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Send promotion
app.post('/admin/api/send-promotion', verifyAdminToken, async (req, res) => {
  const { text, imageBase64 } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Descripción vacía' });
  }

  if (!imageBase64) {
    return res.status(400).json({ error: 'Imagen requerida' });
  }

  try {
    const users = dataManager.getAllUsers();
    const promotion = dataManager.addPromotion({
      text,
      imageBase64: imageBase64.substring(0, 100000),
      sentAt: new Date()
    });

    let sent = 0;

    for (const user of users) {
      try {
        // Send image
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const telegramResponse = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: user.chatId,
            photo: `data:image/jpeg;base64,${imageBase64}`,
            caption: text
          })
        });

        if (telegramResponse.ok) {
          sent++;
        }
      } catch (error) {
        console.error(`Failed to send promotion to ${user.chatId}:`, error.message);
      }
    }

    res.json({ success: true, sent, total: users.length, promotionId: promotion.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get pending reports
app.get('/admin/api/reports', verifyAdminToken, (req, res) => {
  const reports = dataManager.getPendingReports();
  res.json({ reports, count: reports.length });
});

// API: Mark report as contacted
app.post('/admin/api/reports/:reportId/contact', verifyAdminToken, (req, res) => {
  const { reportId } = req.params;
  const report = dataManager.markReportAsContacted(reportId);

  if (report) {
    res.json({ success: true, report });
  } else {
    res.status(404).json({ success: false, error: 'Reporte no encontrado' });
  }
});

// Middleware de errores: cualquier fallo en una ruta responde limpio (sin tumbar nada).
app.use((err, req, res, next) => {
  console.error('[express error]', req.method, req.path, '-', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocurrió un error procesando la solicitud.' });
});

const port = Number(process.env.PORT || 3000);

(async () => {
  // 1) Conectar persistencia y restaurar estado guardado
  try {
    await persistence.init();
    hydrateState(await persistence.load());
    syncHardcodedPlanPrices(); // el bot cotiza con los precios del panel (una sola fuente)
    welcomeReady = true;       // ya con estado hidratado, la bienvenida a nuevos puede actuar
  } catch (e) {
    console.error('[persistence] Error al iniciar:', e.message);
  }
  ensureSuperAdmin();
  rescatarAdmin();   // solo hace algo si ADMIN_RESET=1 // crea el usuario superadmin si no existe

  // 2) Guardado periódico de seguridad (por si algún cambio no disparó schedulePersist)
  setInterval(() => schedulePersist(), 30000);

  // 3) Recordatorios a clientes que siguen esperando un asesor
  setInterval(() => sweepAgentReminders().catch(() => {}), 90000);

  // 3b) Promo de productos a clientes que dejaron de responder unos minutos
  setInterval(() => sweepIdlePromos().catch(() => {}), 120000);

  // 3c) Resumen matutino de casos pendientes al asesor (al abrir la oficina)
  setInterval(() => sweepMorningDigest().catch(() => {}), 60000);
  // Ventana de 24 h del asesor: se revisa cada 30 min (no hace falta más fino,
  // el aviso sale con 2 h de anticipación).
  setInterval(() => sweepAgentWindow().catch(() => {}), 30 * 60000);

  // 3d) Recordatorio de fecha de corte (un día antes, por plantilla de utilidad).
  // Primer intento a los 45 s: en Render gratis la instancia despierta con el primer
  // ping y puede volver a dormirse pronto, así que esperar hasta 5 min al intervalo era
  // justo lo que hacía que se saltara un día. Es inofensivo: para cuando este timer se
  // registra el estado YA está hidratado, y las guardas de adentro (ya corrió hoy,
  // ventana, dedup) impiden que mande nada de más.
  setTimeout(() => sweepCorteReminders().catch(() => {}), 45000);
  setInterval(() => sweepCorteReminders().catch(() => {}), 5 * 60000);
  // Reportes de falla: cada 2 horas pregunta "¿ya quedó?" a los de hace 3 días.
  // También a los 2 min de arrancar: en Render gratis el servidor se reinicia
  // seguido y un intervalo de 2 h podría no llegar nunca.
  setTimeout(() => preguntarSiYaQuedo().catch(() => {}), 2 * 60000);
  setInterval(() => preguntarSiYaQuedo().catch(() => {}), 2 * 60 * 60000);
  // Cobro automático: cada hora mira si a alguien le toca aviso o cobro.
  setTimeout(() => barrerCobroAutomatico().catch(() => {}), 60000);
  setInterval(() => barrerCobroAutomatico().catch(() => {}), 60 * 60000);

  // 3e) Volcado del historial de conversaciones al almacén aparte (cada 60s)
  setInterval(() => flushConversations().catch(() => {}), 60000);

  /*
   * 3e-bis) ¿La cuenta de León sigue pudiendo cobrar?
   *
   * Aprobada hoy no quiere decir aprobada para siempre. Stripe suspende una
   * cuenta cuando se le vence un documento o cuando le pide información nueva,
   * y no avisa por este lado. Sin esta revisión, el sistema seguiría mandando
   * cobros contra una cuenta muerta: el cliente mete su tarjeta, el cargo se
   * rechaza, y quien da la cara es León.
   *
   * Cada diez minutos, que es de sobra para algo que cambia dos veces al año.
   */
  setTimeout(() => revisarCuentaLeon(), 30000);
  setInterval(() => revisarCuentaLeon(), 10 * 60000);

  // 3f) Bienvenida a NUEVOS clientes de Wisphub (baseline + saludo a los nuevos)
  setTimeout(() => sweepNewClients().catch(() => {}), 20000);        // primera pasada al arrancar
  setInterval(() => sweepNewClients().catch(() => {}), 15 * 60000);  // luego cada 15 min

  /*
   * 3g) Ir por el dinero que se quedó atorado dentro de Stripe.
   *
   * Arranca a los 90 s (no de inmediato: al levantar, el estado apenas se está
   * restaurando y Wisphub todavía no sincroniza) y luego cada 10 min. Cada 6 h
   * esa misma pasada audita a TODOS los clientes con CLABE, por si entró un
   * depósito cuyo aviso nunca llegó.
   *
   * Sale gratis cuando no hay nada que hacer: si el cobro está apagado o no hay
   * rezagados, la función regresa sin hablar con nadie.
   */
  setTimeout(() => barrerSaldosRezagados().catch(() => {}), 90000);
  setInterval(() => barrerSaldosRezagados().catch(() => {}), 10 * 60000);

  // 4) Levantar el servidor
  app.listen(port, () => {
    console.log(`León Telecom server listening on port ${port}`);
    console.log(`AI provider: ${AI_PROVIDER}`);
    console.log(`Persistencia: ${persistence.label}`);
    console.log(`Horario de atención: ${BUSINESS_HOURS_SUMMARY}`);
  });
})();
