require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { analyzePaymentReceipt } = require('./utils/imageAnalysis');
const dataManager = require('./utils/dataManager');
const persistence = require('./utils/persistence');

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
  if ([...adminUsers.values()].some(u => u.role === 'superadmin')) return;
  const { salt, hash } = hashAdminPassword(ADMIN_PASSWORD);
  adminUsers.set('admin', { username: 'admin', name: 'Administrador', role: 'superadmin', salt, hash, permissions: ADMIN_PERMISSIONS.slice(), active: true, createdAt: new Date().toISOString() });
  console.log('[admin] Superadmin creado (usuario: admin / contraseña: ADMIN_PASSWORD)');
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
  0: [[600, 840]],               // Domingo 10:00–14:00
  1: [[600, 900], [960, 1200]],  // Lunes   10:00–15:00 y 16:00–20:00
  2: [[600, 900], [960, 1200]],  // Martes
  3: [[600, 900], [960, 1200]],  // Miércoles
  4: [[600, 900], [960, 1200]],  // Jueves
  5: [[600, 900], [960, 1200]],  // Viernes
  6: [[600, 900], [960, 1080]]   // Sábado  10:00–15:00 y 16:00–18:00
};
const BUSINESS_HOURS_SUMMARY = 'Lun a Vie 10:00–15:00 y 16:00–20:00, Sáb 10:00–15:00 y 16:00–18:00, Dom 10:00–14:00';
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
    '• Lunes a Viernes: 10:00 – 15:00 y 16:00 – 20:00',
    '• Sábado: 10:00 – 15:00 y 16:00 – 18:00',
    '• Domingo: 10:00 – 14:00',
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
let corteReminders = {};    // "telefono|fecha" → ISO de cuándo se envió (evita duplicados)
let lastCorteRunDate = '';  // 'YYYY-MM-DD' (México) de la última corrida de recordatorios de corte

// --- Alertas al admin cuando algo falla (throttle por tipo, para no spamear) ---
const ALERT_ADMIN_NUMBER = process.env.ALERT_ADMIN_NUMBER || '9511603125';
const _alertLast = new Map(); // tipo -> ts del último aviso

// --- Anti-flood por número (rate-limit ligero del webhook) ---
const _msgRate = new Map();     // chatId -> [timestamps]
const RATE_MAX = 12;            // máx mensajes por ventana y número
const RATE_WINDOW_MS = 30000;   // ventana de 30 s

// --- Bienvenida automática a NUEVOS clientes de Wisphub ---
// welcomedClients = teléfonos ya conocidos (no se les vuelve a saludar).
// welcomeSeeded = ya se hizo el "baseline" para NO saludar a los clientes existentes.
// welcomeReady = true tras hidratar (evita actuar con estado a medias / en arranque).
const NEW_CLIENT_WELCOME_ENABLED = String(process.env.NEW_CLIENT_WELCOME_ENABLED || 'true') === 'true';
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
function markCases(clientId, status) {
  try {
    const num = String(clientId).replace(/\D/g, '');
    let n = 0;
    for (const c of caseLog) {
      if (c.clientId === num && c.status === 'pendiente') { c.status = status; n++; }
    }
    if (n) schedulePersist();
    return n;
  } catch (e) { return 0; }
}

// Fecha 'YYYY-MM-DD' en zona horaria de Oaxaca (el server corre en UTC).
function mexicoDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

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
      const res = await fetch(firstUrl, { headers: { 'Authorization': `${scheme} ${WISPHUB_API_KEY}` } });
      if (res.ok) { authHeader = `${scheme} ${WISPHUB_API_KEY}`; data = await res.json(); console.log(`[Wisphub] Autenticado con esquema "${scheme}"`); break; }
      lastTxt = await res.text().catch(() => '');
      if (res.status !== 401 && res.status !== 403) break;
    }
    if (!authHeader) throw new Error(`Auth falló: ${lastTxt.slice(0, 200)}`);

    wisphubClients.clear();
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
        wisphubClients.set(phone, {
          name, phone, status: c.estado, wisphubId: c.id_servicio || c.id, source: 'wisphub',
          // Datos de cuenta para la búsqueda/estado de cuenta en el panel:
          saldo: c.saldo, fechaCorte: c.fecha_corte,
          plan: (c.plan_internet && c.plan_internet.nombre) || c.plan_internet || '',
          precioPlan: c.precio_plan, estadoFacturas: c.estado_facturas, usuario: c.usuario
        });
        synced++;
      }
      offset += items.length;
      pages++;
      if (count && offset >= count) { complete = true; break; } // llegamos al total
      const res = await fetch(`${base}/api/clientes/?format=json&limit=${PAGE}&offset=${offset}&estado=1`, { headers: { 'Authorization': authHeader } });
      if (!res.ok) break; // ⚠️ se cortó a media paginación → NO es un sync completo
      data = await res.json();
    }

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
    alertAdmin('wisphub', `Falló la sincronización con Wisphub: ${e.message}`);
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
    if (nuevos.length > 30) { // anomalía (¿se reinició la lista?): NO enviar, avisar
      for (const ph of nuevos) welcomedClients.add(ph);
      schedulePersist();
      console.warn(`[bienvenida] ${nuevos.length} "nuevos" de golpe — NO envío por seguridad.`);
      alertAdmin('bienvenida-anomala', `Aparecieron ${nuevos.length} clientes "nuevos" de golpe; NO se enviaron bienvenidas por seguridad.`);
      return;
    }
    for (const ph of nuevos) {
      welcomedClients.add(ph); // marca ANTES de enviar (no re-saluda aunque falle)
      const c = wisphubClients.get(ph);
      try { await sendNewClientWelcome(ph, c && c.name); console.log(`[bienvenida] enviada a nuevo cliente ${ph}`); }
      catch (e) { console.error('[bienvenida] falló envío a', ph, e.message); }
      await new Promise(r => setTimeout(r, 300));
    }
    schedulePersist();
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
  const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
}

function clearSession(chatId) {
  sessions.delete(String(chatId));
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
    corteReminders: corteReminders,
    lastCorteRunDate: lastCorteRunDate,
    corteTemplates: corteTemplates,
    corteActiveId: corteActiveId,
    welcomedClients: [...welcomedClients],
    welcomeSeeded: welcomeSeeded
  };
}

// Restaura las colecciones desde lo guardado (al arrancar el servidor).
function hydrateState(s) {
  if (!s || typeof s !== 'object') return;
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
  if (s.corteReminders && typeof s.corteReminders === 'object') corteReminders = s.corteReminders;
  if (typeof s.lastCorteRunDate === 'string') lastCorteRunDate = s.lastCorteRunDate;
  if (Array.isArray(s.corteTemplates)) corteTemplates = s.corteTemplates;
  if (typeof s.corteActiveId === 'string') corteActiveId = s.corteActiveId;
  if (Array.isArray(s.welcomedClients)) welcomedClients = new Set(s.welcomedClients.map(String));
  if (typeof s.welcomeSeeded === 'boolean') welcomeSeeded = s.welcomeSeeded;
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
        '💰 Instalación: $800 | Primer mes gratis',
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
          ? '💰 Instalación: Centro de Telixtlahuaca $800 · Agencias de los alrededores $1,200'
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
          messages: [{ role: 'user', content: userContent }],
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
          { role: 'user', content: userContent }
        ],
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
  const recentMsgs = history.messages.slice(-10)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Leo'}: ${m.text}`)
    .join('\n');

  const clientName = nameOf(profile);
  const clientLocation = profile?.location || null;

  const fiberPlans = FIBER_PLANS.map(p => `${p.name} ${p.speed}/${p.price}`).join(', ');
  const wirelessPlans = WIRELESS_PLANS.map(p => `${p.speed}/${p.price}`).join(', ');

  const systemPrompt = [
    'Eres Leo, asistente virtual de León Telecom (ISP en Oaxaca, México).',
    'Tono: profesional y amable, como un buen agente de atención al cliente. Sin slang ni expresiones informales. Máximo 2-3 oraciones. Sin markdown.',
    '',
    'SERVICIOS DE INTERNET (las 3 zonas SÍ tienen cobertura):',
    `Huitzo — fibra óptica en: Primera/Segunda/Tercera Sección, La Guadalupe, La Cantera, Cañada del Chisme, Ojo de Agua, Esmeralda, Privada del Laurel, El Llano, Gasolinera, Loma los Pinos, Agua Blanca, Santa María Tenéxpam. Instalación: $800, primer mes gratis. Resto de Huitzo: antena inalámbrica. Planes fibra: ${fiberPlans}`,
    `Telixtlahuaca (inalámbrico/antena): instalación $800 en el CENTRO/cabecera (${TELIXTLAHUACA_CENTRO_ZONES.join(', ')}); $1,200 en las AGENCIAS/alrededores (${TELIXTLAHUACA_AGENCIAS.join(', ')}). Si el cliente no especifica colonia, pregunta si es en el centro o en una agencia antes de dar el costo. Planes: ${wirelessPlans}`,
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
    clientName ? `Nombre del cliente: ${clientName}` : '',
    clientLocation ? `Zona del cliente: ${clientLocation}` : '',
    '',
    'HISTORIAL RECIENTE:',
    recentMsgs || '(primera interacción)',
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
    const response = await callAI(systemPrompt, userText, { temperature: 0.6, maxTokens: 300 });
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
  return {
    text: [
      '¿En qué puedo ayudarte? Elige una opción:',
      '',
      '1️⃣ Ver planes de internet',
      '2️⃣ Cámaras de seguridad',
      '3️⃣ Soporte técnico',
      '4️⃣ Hablar con un asesor',
      '5️⃣ Migrar mi servicio',
      '6️⃣ Productos y accesorios 🛍️'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [
        [{ text: '1' }, { text: '2' }, { text: '3' }],
        [{ text: '4' }, { text: '5' }, { text: '6' }]
      ],
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

  const base = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
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
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
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
async function sendWhatsAppDocument(to, link, filename) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !link) return;
  const base = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(base, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'document',
        document: { link, filename: String(filename || 'documento.pdf').slice(0, 240) }
      })
    });
  } catch (e) { console.error('[WhatsApp] Document send error:', e.message); }
}

// Envía un mensaje a TODOS los números de asesor configurados.
async function sendToAllAgents(text, media = [], opts = {}) {
  for (const num of AGENT_WHATSAPP_NUMBERS) {
    try { await sendWhatsAppMessage(num, text, media, opts); }
    catch (e) { console.error('[notify wa]', num, e.message); }
  }
}
// Reenvía un documento a TODOS los asesores.
async function sendDocToAllAgents(docUrl, docName) {
  if (!docUrl) return;
  for (const num of AGENT_WHATSAPP_NUMBERS) {
    try { await sendWhatsAppDocument(num, docUrl, docName); } catch (_) {}
  }
}
// Avisa a los OTROS asesores (todos menos el que actuó). Útil para "caso ya tomado".
async function notifyOtherAgents(exceptAgent, text) {
  const ex = _normAgentNum(exceptAgent);
  for (const num of AGENT_WHATSAPP_NUMBERS) {
    if (num === ex) continue;
    try { await sendWhatsAppMessage(num, text); } catch (e) { console.error('[notify other]', num, e.message); }
  }
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
  if (AGENT_NOTIFY_CHAT_ID && TELEGRAM_API_BASE) { try { await sendTelegramMessage(AGENT_NOTIFY_CHAT_ID, msg, media); } catch (e) { console.error('[notify tg]', e.message); } }
  if (opts.docUrl) await sendDocToAllAgents(opts.docUrl, opts.docName);
  await sendToAllAgents(msg, media, buttons ? { buttons } : {});
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

async function handleAgentCommand(agentNumber, text) {
  const v = text.trim().toUpperCase();

  function normalizeClientNumber(raw) {
    let n = raw.replace(/\D/g, '');
    if (!n.startsWith('52')) n = '52' + n;
    if (n.startsWith('521') && n.length === 13) n = '52' + n.slice(3);
    return n;
  }

  // ATENDER [número] — toma el control y activa el relay
  const atenderMatch = v.match(/^ATENDER\s+(\d+)/);
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
        `🙋 *${cName}* (${clientId}) ya lo está atendiendo otro asesor. Si necesitas tomarlo tú, pídele que lo cierre con *LIBERAR ${clientId}*.`);
      return;
    }

    pauseChat(clientId, 4);
    agentActiveCases.set(agentNumber, clientId);
    pendingAgentRequests.delete(clientId); // ya lo está atendiendo un asesor
    markCases(clientId, 'atendido');
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
      `🔒 El caso de *${clientName}* (${clientId}) ya fue *tomado por otro asesor*.\nLos botones de ese caso ya no aplican. 🙅`);
    return;
  }

  // LIBERAR [número] — cierra el relay y devuelve al bot
  const liberarMatch = v.match(/^LIBERAR\s+(\d+)/);
  if (liberarMatch) {
    const clientId = normalizeClientNumber(liberarMatch[1]);
    unpauseChat(clientId);
    agentActiveCases.delete(agentNumber);
    pendingAgentRequests.delete(clientId);
    markCases(clientId, 'atendido');
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
  const recibidoMatch = v.match(/^RECIBIDO\s+(\d+)/);
  if (recibidoMatch) {
    const clientId = normalizeClientNumber(recibidoMatch[1]);
    const cName = nameOf(getProfile(clientId), clientId);
    // Si OTRO asesor ya lo está atendiendo, no lo tocamos (él lo cierra).
    const dueño = agentHandling(clientId);
    if (dueño && dueño !== agentNumber) {
      await sendWhatsAppMessage(agentNumber, `🔒 *${cName}* (${clientId}) ya lo está atendiendo otro asesor. No hice nada.`);
      return;
    }
    // Si ya fue gestionado (no queda pendiente), avisamos y no repetimos el "gracias".
    const marcados = markCases(clientId, 'recibido');
    if (!marcados && !pendingAgentRequests.has(clientId)) {
      await sendWhatsAppMessage(agentNumber, `ℹ️ El caso de *${cName}* (${clientId}) ya había sido gestionado por otro asesor.`);
      return;
    }
    pendingAgentRequests.delete(clientId);
    schedulePersist();
    try {
      await sendWhatsAppMessage(clientId, '✅ ¡Recibido, gracias! 🙌');
    } catch (e) { console.error('[Agent] RECIBIDO notify client error:', e.message); }
    await sendWhatsAppMessage(agentNumber, `✅ Marcado como recibido. Le avisé a *${cName}* (${clientId}). El bot sigue atendiéndolo.`);
    // Avisa a los demás asesores que este caso ya fue gestionado.
    await notifyOtherAgents(agentNumber, `✅ El caso de *${cName}* (${clientId}) ya fue *marcado como recibido* por otro asesor.`);
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
      if (c.docUrl) { try { await sendWhatsAppDocument(agentNumber, c.docUrl, 'documento'); } catch (_) {} }
      const media = c.imageUrl ? [c.imageUrl] : [];
      const body = [
        `${CASE_TYPE_EMOJI[c.type] || '•'}${c.offHours ? ' 🌙' : ''} *${c.name}* (${c.clientId})`,
        `🕒 ${fmtHora.format(new Date(c.ts))}`,
        c.resumen || ''
      ].filter(Boolean).join('\n');
      await sendWhatsAppMessage(agentNumber, body, media, { buttons: [
        { id: `RECIBIDO ${c.clientId}`, title: '✅ Recibido, gracias' },
        { id: `ATENDER ${c.clientId}`, title: '📞 Atender caso' }
      ] });
      await new Promise(r => setTimeout(r, 350));
    } catch (e) { console.error('[casos] deliver error:', e.message); }
  }
  if (pend.length > lote.length) await sendWhatsAppMessage(agentNumber, `…y ${pend.length - lote.length} caso(s) más. Ve gestionando estos y vuelve a pedir *PENDIENTES*.`);
}

// Al abrir la oficina: resumen de los casos que siguen pendientes (sobre todo
// los que llegaron fuera de horario y se pudieron perder entre los chats).
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
    if (!pend.length) return; // sin pendientes, no molestamos

    const fmtHora = new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
    const lines = pend.slice(0, 15).map(c =>
      `${CASE_TYPE_EMOJI[c.type] || '•'}${c.offHours ? ' 🌙' : ''} *${c.name}* (${c.clientId}) — ${fmtHora.format(new Date(c.ts))}\n   ${c.resumen.slice(0, 140)}`
    );
    const msg = [
      `☀️ ¡Buenos días! Tienes *${pend.length} caso${pend.length === 1 ? '' : 's'} pendiente${pend.length === 1 ? '' : 's'}*:`,
      '(🌙 = llegó fuera de horario)',
      '',
      ...lines,
      pend.length > 15 ? `…y ${pend.length - 15} más.` : '',
      '',
      'Toca *📥 Ver casos* para bajarlos uno por uno con sus botones, o responde *RECIBIDO [número]* / *ATENDER [número]*.'
    ].filter(Boolean).join('\n');
    await sendAgentMessageSafe(msg, { buttons: [{ id: 'PENDIENTES', title: '📥 Ver casos' }] });
    console.log(`[digest] Resumen matutino enviado: ${pend.length} casos pendientes`);
  } catch (e) { console.error('[digest] sweep error:', e.message); }
}

// ==================== RECORDATORIO DE FECHA DE CORTE (Wisphub) ====================
// Un día antes del corte, se avisa a cada cliente por PLANTILLA de utilidad
// (llega aunque no haya chateado con el bot en 24h), personalizado con su nombre.
const CORTE_REMINDER_TIME = process.env.CORTE_REMINDER_TIME || '10:00'; // hora de México
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

// force=true (desde el panel) corre ya, sin esperar la hora — el dedup evita repetir.
async function sweepCorteReminders(force = false) {
  try {
    if (!CORTE_REMINDER_ENABLED && !force) return null;
    if (!WHATSAPP_AVISO_TEMPLATE || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) return null;
    if (!wisphubClients.size) return null;
    const today = mexicoDateStr();
    if (!force) {
      if (lastCorteRunDate === today) return null;
      const objetivo = parseTimeToMinutes(CORTE_REMINDER_TIME);
      const { minutesOfDay } = mexicoNow();
      // Ventana de 30 min a partir de la hora configurada
      if (minutesOfDay < objetivo || minutesOfDay >= objetivo + 30) return null;
    }
    lastCorteRunDate = today;
    schedulePersist();

    const mananaDate = new Date(Date.now() + 24 * 3600 * 1000);
    const manana = mexicoDateStr(mananaDate);
    // "jueves 16 de julio" (sin la coma que mete Intl entre el día de la semana y la fecha).
    const bonita = new Intl.DateTimeFormat('es-MX', { timeZone: BUSINESS_TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(mananaDate).replace(',', '');

    let sent = 0, failed = 0, yaEnviados = 0;
    for (const [phone, c] of wisphubClients.entries()) {
      try {
        const fc = parseFechaCorte(c.fechaCorte);
        if (!fc || fc !== manana) continue;
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
        await sendWhatsAppTemplate(phone, msgCorte);
        corteReminders[key] = new Date().toISOString();
        sent++;
        await new Promise(r => setTimeout(r, 300)); // pausa para no saturar la API
      } catch (e) { failed++; }
    }
    // Limpieza: registros de hace más de 60 días
    const old = Date.now() - 60 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(corteReminders)) {
      if (new Date(v).getTime() < old) delete corteReminders[k];
    }
    schedulePersist();
    console.log(`[corte] Recordatorios para ${manana}: ${sent} enviados, ${yaEnviados} ya enviados antes, ${failed} fallidos`);
    return { manana, sent, failed, yaEnviados };
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
  return PRODUCT_IMG_BASE + encodeURIComponent(img);
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
    '5️⃣ Migrar mi servicio',
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
    // Intención de pago (o el "PAGAR" que sugiere el recordatorio de corte) → 2 botones.
    if (/^(pagar|quiero pagar|como (puedo )?pag|cómo (puedo )?pag|donde pag|dónde pag|datos de pago|m[eé]todos de pago|formas de pago)/.test(_pt)) {
      await sendMsg(chatId, '💳 ¿Cómo quieres pagar? Elige una opción:', [], { buttons: [
        { id: 'pago_horario', title: '🏢 Horario en oficina' },
        { id: 'pago_datos', title: '💳 Datos de pago' }
      ] });
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
      const _notif = await notifyAgentRequest(chatId, [
        '📅 SOLICITUD DE PRÓRROGA / PLAZO DE PAGO',
        _nom ? `Cliente: ${_nom}` : '',
        `Mensaje: ${text}`
      ].filter(Boolean).join('\n'), '').catch(() => false);
      await sendMsg(chatId, agentNotifiedMsg(_notif, _nom, 'asesor'));
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
        ['Archivo: ' + _pdoc.fname, '👤 Servicio a nombre de: ' + (titular || 'no especificado')],
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
      const confirmarOriginal = async () => {
        pendingImage.delete(_pendKey);
        const a = _pend.analysis || {};
        const lines = [
          '💳 Datos del comprobante (confirmados por el cliente):',
          '👤 Nombre: ' + (String(a.nombre || '').trim() || 'no especificado'),
          '💵 Monto: ' + (String(a.monto || '').trim() || 'no especificado')
        ];
        if (a.banco) lines.push('🏦 Banco/Operador: ' + a.banco);
        if (a.fecha) lines.push('📅 Fecha: ' + a.fecha);
        await enviarComprobante(lines, '💳 COMPROBANTE DE PAGO');
        await sendMsg(chatId, '✅ ¡Gracias! Envié tu comprobante a un asesor. Se pondrá en contacto contigo para confirmar tu pago. 🙌');
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
        pendingImage.delete(_pendKey);
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
        await enviarComprobante(lines, '💳 COMPROBANTE DE PAGO (corregido por el cliente)');
        await sendMsg(chatId, '✅ ¡Gracias por la corrección! Envié tu comprobante con los datos correctos a un asesor. Se pondrá en contacto contigo para confirmar tu pago. 🙌');
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
        try { createTicket(chatId, d.knownName, d.problemDescription, locationLine); } catch (_) {}
        clearSession(chatId);
        await sendMsg(chatId, `Listo, ${d.knownName}. Registramos tu reporte en ${locationLine}. Un técnico te contactará pronto. 🔧`);
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
app.get('/admin/api/client-lookup', verifyAdminToken, requirePermission('clients'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [], source: 'none' });
  const digits = q.replace(/\D/g, '');

  // Teléfono → consulta en vivo a Wisphub por el campo telefono (10 dígitos).
  if (digits.length >= 7 && WISPHUB_API_KEY) {
    const tel = digits.slice(-10);
    try {
      const r = await fetch(`${WISPHUB_API_URL}/api/clientes/?format=json&limit=10&telefono=${tel}`,
        { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } });
      if (r.ok) {
        const d = await r.json();
        const items = d.results || (Array.isArray(d) ? d : []);
        const results = items.map(mapWisphubAccount);
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
      out.push({
        name: c.name, phone, status: c.status, saldo: c.saldo,
        fechaCorte: c.fechaCorte, plan: c.plan, precioPlan: c.precioPlan,
        estadoFacturas: c.estadoFacturas, id: c.wisphubId
      });
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
app.get('/admin/api/corte-reminders', verifyAdminToken, (req, res) => {
  const mananaDate = new Date(Date.now() + 24 * 3600 * 1000);
  const manana = mexicoDateStr(mananaDate);
  const lista = [];
  for (const [phone, c] of wisphubClients.entries()) {
    const fc = parseFechaCorte(c.fechaCorte);
    if (fc === manana) lista.push({ name: c.name, phone, plan: c.plan || '', fechaCorte: c.fechaCorte, yaEnviado: !!corteReminders[`${phone}|${fc}`] });
  }
  res.json({
    manana, total: lista.length,
    habilitado: CORTE_REMINDER_ENABLED, hora: CORTE_REMINDER_TIME,
    plantillaConfigurada: !!WHATSAPP_AVISO_TEMPLATE,
    corridaHoy: lastCorteRunDate === mexicoDateStr(),
    lista: lista.slice(0, 200)
  });
});

// API: Forzar la corrida de recordatorios de corte AHORA (para probar)
app.post('/admin/api/corte-reminders/run', verifyAdminToken, async (req, res) => {
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
    const r = await fetch(`${WISPHUB_API_URL}/api/clientes/?format=json&limit=500&offset=${offset}`,
      { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } });
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
      const debe = e.includes('suspend') || saldo > 0 || (fact && !low(fact).includes('pagad'));
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
    const r = await fetch(`${WISPHUB_API_URL}/api/facturas/?format=json&limit=500&offset=${offset}`,
      { headers: { 'Authorization': `Api-Key ${WISPHUB_API_KEY}` } });
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
  ensureSuperAdmin(); // crea el usuario superadmin si no existe

  // 2) Guardado periódico de seguridad (por si algún cambio no disparó schedulePersist)
  setInterval(() => schedulePersist(), 30000);

  // 3) Recordatorios a clientes que siguen esperando un asesor
  setInterval(() => sweepAgentReminders().catch(() => {}), 90000);

  // 3b) Promo de productos a clientes que dejaron de responder unos minutos
  setInterval(() => sweepIdlePromos().catch(() => {}), 120000);

  // 3c) Resumen matutino de casos pendientes al asesor (al abrir la oficina)
  setInterval(() => sweepMorningDigest().catch(() => {}), 60000);

  // 3d) Recordatorio de fecha de corte (un día antes, por plantilla de utilidad)
  setInterval(() => sweepCorteReminders().catch(() => {}), 5 * 60000);

  // 3e) Volcado del historial de conversaciones al almacén aparte (cada 60s)
  setInterval(() => flushConversations().catch(() => {}), 60000);

  // 3f) Bienvenida a NUEVOS clientes de Wisphub (baseline + saludo a los nuevos)
  setTimeout(() => sweepNewClients().catch(() => {}), 20000);        // primera pasada al arrancar
  setInterval(() => sweepNewClients().catch(() => {}), 15 * 60000);  // luego cada 15 min

  // 4) Levantar el servidor
  app.listen(port, () => {
    console.log(`León Telecom server listening on port ${port}`);
    console.log(`AI provider: ${AI_PROVIDER}`);
    console.log(`Persistencia: ${persistence.label}`);
    console.log(`Horario de atención: ${BUSINESS_HOURS_SUMMARY}`);
  });
})();
