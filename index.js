require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { analyzePaymentReceipt } = require('./utils/imageAnalysis');
const dataManager = require('./utils/dataManager');
const persistence = require('./utils/persistence');

// File upload config — imágenes en memoria; se guardan en MongoDB (persistentes).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) return cb(new Error('Solo imágenes'));
  cb(null, true);
}});

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

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
const LEON_CONTACT_NUMBER = process.env.LEON_CONTACT_NUMBER || '9511603125';
const AGENT_NOTIFY_CHAT_ID = process.env.AGENT_NOTIFY_CHAT_ID || '';
const AGENT_NOTIFY_WEBHOOK_URL = process.env.AGENT_NOTIFY_WEBHOOK_URL || '';
const AGENT_WHATSAPP_NUMBER = process.env.AGENT_WHATSAPP_NUMBER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'leon123'; // Change in production!
// Secreto para firmar los tokens del panel. Si no se define, se deriva de la
// contraseña (estable entre reinicios). Definir ADMIN_SECRET en Render es lo ideal.
const ADMIN_SECRET = process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('leontelecom::' + ADMIN_PASSWORD).digest('hex');
const ADMIN_TOKEN_TTL_MS = 12 * 3600 * 1000; // los tokens del panel expiran en 12 horas
const WISPHUB_API_URL = process.env.WISPHUB_API_URL || 'https://api.wisphub.net'; // Optional

if (ADMIN_PASSWORD === 'leon123') {
  console.warn('[seguridad] ⚠️ ADMIN_PASSWORD usa el valor por defecto. Define una contraseña fuerte en Render → Environment.');
}

// ==================== WHATSAPP CLOUD API ====================
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'leontelecom-verify';
const WHATSAPP_API_VERSION = 'v22.0';

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

async function syncWisphubClients() {
  if (!WISPHUB_API_KEY) {
    return { synced: 0, error: 'WISPHUB_API_KEY no configurado' };
  }
  try {
    const base = (WISPHUB_API_URL || 'https://api.wisphub.net').replace(/\/$/, '');
    const url = `${base}/api/clientes/?format=json&limit=1000&estado=1`;
    // Wisphub puede usar distintos esquemas de Authorization; probamos los comunes.
    const schemes = ['Api-Key', 'Token', 'Bearer'];
    let res = null, lastTxt = '';
    for (const scheme of schemes) {
      res = await fetch(url, { headers: { 'Authorization': `${scheme} ${WISPHUB_API_KEY}` } });
      if (res.ok) { console.log(`[Wisphub] Autenticado con esquema "${scheme}"`); break; }
      lastTxt = await res.text().catch(() => '');
      if (res.status !== 401 && res.status !== 403) break; // error que no es de auth → no insistir
    }
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res ? res.status : '??'}: ${lastTxt.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.results || []);
    wisphubClients.clear();
    let synced = 0;
    for (const c of items) {
      // Wisphub uses: telefono, celular, nombre, apellidos
      const rawPhone = c.telefono || c.celular || c.phone || '';
      if (!rawPhone) continue;
      let phone = rawPhone.replace(/\D/g, '');
      if (phone.length === 10) phone = '52' + phone;
      if (phone.startsWith('521') && phone.length === 13) phone = '52' + phone.slice(3);
      if (phone.length < 12) continue; // skip invalid
      const name = [c.nombre, c.apellidos].filter(Boolean).join(' ') || c.name || rawPhone;
      wisphubClients.set(phone, { name, phone, status: c.estado, wisphubId: c.id, source: 'wisphub' });
      synced++;
    }
    lastWisphubSync = new Date().toISOString();
    wisphubSyncError = null;
    console.log(`[Wisphub] Sync OK: ${synced} clientes`);
    return { synced, total: items.length };
  } catch (e) {
    wisphubSyncError = e.message;
    console.error('[Wisphub] Sync error:', e.message);
    return { synced: 0, error: e.message };
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

// Scheduler — checks every 60s if any broadcast needs to be sent
setInterval(async () => {
  const now = new Date();
  for (const [id, bc] of scheduledBroadcasts.entries()) {
    if (bc.status !== 'active') continue;
    if (bc.endAt && now > new Date(bc.endAt)) {
      bc.status = 'completed';
      scheduledBroadcasts.set(id, bc);
      continue;
    }
    if (now >= new Date(bc.nextSendAt)) {
      try {
        const result = await sendBulkWhatsApp(bc.message, bc.imageUrls || []);
        bc.sentCount = (bc.sentCount || 0) + 1;
        bc.lastSentAt = now.toISOString();
        broadcastHistory.unshift({ id, type: bc.type, label: bc.label, message: bc.message, sentAt: now.toISOString(), result });
        if (broadcastHistory.length > 100) broadcastHistory.pop();

        if (bc.intervalMs) {
          const next = new Date(now.getTime() + bc.intervalMs);
          if (!bc.endAt || next <= new Date(bc.endAt)) {
            bc.nextSendAt = next.toISOString();
          } else {
            bc.status = 'completed';
          }
        } else {
          bc.status = 'completed';
        }
        scheduledBroadcasts.set(id, bc);
        schedulePersist();
      } catch (e) { console.error('[Broadcast scheduler error]', e.message); }
    }
  }
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
    )
  };
}

// Restaura las colecciones desde lo guardado (al arrancar el servidor).
function hydrateState(s) {
  if (!s || typeof s !== 'object') return;
  const fill = (map, obj) => { if (obj) for (const [k, v] of Object.entries(obj)) map.set(k, v); };
  fill(clientProfiles, s.clientProfiles);
  fill(manualClients, s.manualClients);
  fill(scheduledBroadcasts, s.scheduledBroadcasts);
  fill(folios, s.folios);
  fill(agentActiveCases, s.agentActiveCases);
  if (Array.isArray(s.broadcastHistory)) { broadcastHistory.length = 0; broadcastHistory.push(...s.broadcastHistory); }
  if (s.pausedChats) for (const [k, v] of Object.entries(s.pausedChats)) pausedChats.set(k, { pausedUntil: new Date(v.pausedUntil) });
  if (s.pendingAgentRequests) for (const [k, v] of Object.entries(s.pendingAgentRequests)) pendingAgentRequests.set(k, { ...v, since: new Date(v.since) });
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

const FIBER_PLANS = [
  { name: 'Lite', speed: '30 Mbps', price: '$289/mes' },
  { name: 'Basic', speed: '80 Mbps', price: '$320/mes' },
  { name: 'Medium', speed: '150 Mbps', price: '$440/mes' },
  { name: 'Advanced', speed: '200 Mbps', price: '$560/mes' },
  { name: 'Ultra', speed: '300 Mbps', price: '$680/mes' }
];

const WIRELESS_PLANS = [
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
  return /\b(falla|sin servicio|no funciona|intermitente|reiniciar|caido|caida|sin internet|no jala|no agarra|se cae|se corta|no carga|no hay internet|se fue el internet|no tengo internet|se corto el internet)\b/.test(value);
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
      'Tu contacto: 📞 9511603125. Alguien te atiende en poco tiempo.'
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
      })
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
    })
  });
  if (!response.ok) throw new Error(`AI request failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || null;
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
    'IMPORTANTE: León Telecom SOLO ofrece internet. NO ofrece telefonía, TV, cable ni otros servicios.',
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

  if (AGENT_WHATSAPP_NUMBER) {
    try {
      await sendWhatsAppMessage(AGENT_WHATSAPP_NUMBER, fullMessage, [], {
        buttons: [{ id: `ATENDER ${chatId}`, title: 'Atender caso' }]
      });
      notified = true;
    } catch (e) {
      console.error('Agent WhatsApp notify error:', e.message);
    }
  }

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

  const buffer = await mediaResponse.buffer();
  return buffer.toString('base64');
}

// ==================== SHARED MESSAGE HANDLERS ====================

async function handleIncomingImage(chatId, userName, imageBase64, platform, sendMsg) {
  try {
    dataManager.registerUser(chatId, { name: userName, platform });
    await sendMsg(chatId, '⏳ Analizando tu comprobante de pago...');
    const analysis = await analyzePaymentReceipt(imageBase64);
    dataManager.createReport(chatId, analysis, imageBase64);

    try {
      await notifyAgentPaymentReceipt(chatId, userName, analysis);
    } catch (notifyError) {
      console.error('Agent notification error:', notifyError.message);
    }

    if (analysis.valido) {
      await sendMsg(chatId,
        '✅ Perfecto, tu comprobante de pago ha sido analizado.\n\n' +
        'Un asesor se pondrá en contacto contigo para procesar tu solicitud.\n\n' +
        '¿Hay algo más en lo que pueda ayudarte?'
      );
    } else {
      await sendMsg(chatId,
        `⚠️ No parece ser un comprobante de pago válido.\n\nRazón: ${analysis.razon}\n\n¿Quieres intentar enviar otra imagen?`
      );
    }
  } catch (error) {
    console.error('Image handling error:', error.message);
    try {
      await sendMsg(chatId, '❌ Error al procesar la imagen. Intenta de nuevo.');
    } catch (sendError) {
      console.error('Fallback send error:', sendError.message);
    }
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
    pauseChat(clientId, 4);
    agentActiveCases.set(agentNumber, clientId);
    pendingAgentRequests.delete(clientId); // ya lo está atendiendo un asesor
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
    return;
  }

  // LIBERAR [número] — cierra el relay y devuelve al bot
  const liberarMatch = v.match(/^LIBERAR\s+(\d+)/);
  if (liberarMatch) {
    const clientId = normalizeClientNumber(liberarMatch[1]);
    unpauseChat(clientId);
    agentActiveCases.delete(agentNumber);
    pendingAgentRequests.delete(clientId);
    schedulePersist();
    try {
      await sendWhatsAppMessage(clientId,
        'El asesor ha finalizado la atención. El asistente virtual queda a tus órdenes. ¿En qué más puedo ayudarte?'
      );
    } catch (e) {}
    await sendWhatsAppMessage(agentNumber, `✅ Caso cerrado. Bot reactivado para ${clientId}.`);
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

  // Mensaje normal mientras hay un caso activo → relay al cliente
  const activeClient = agentActiveCases.get(agentNumber);
  if (activeClient && !v.startsWith('ATENDER') && !v.startsWith('LIBERAR') && v !== 'PAUSADOS') {
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
    'ATENDER [número] → Tomar un caso (activa relay)',
    'LIBERAR [número] → Cerrar caso y devolver al bot',
    'PAUSADOS → Ver casos activos',
    '',
    'Mientras tienes un caso activo, todo lo que escribas se reenvía al cliente.'
  ].join('\n'));
}

// ==================== RECORDATORIO AL CLIENTE EN ESPERA ====================
// Si un cliente pidió asesor y nadie lo atiende, le mandamos un mensaje de calma.
const REMINDER_1_MIN = 10;   // primer recordatorio
const REMINDER_2_MIN = 30;   // segundo recordatorio (ofrece teléfono directo)
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
          'Seguimos gestionando tu solicitud. 🙏 En breve un asesor de León Telecom te atenderá, gracias por tu paciencia.');
        info.stage = 1; pendingAgentRequests.set(clientId, info); schedulePersist();
      } else if ((info.stage || 0) < 2 && mins >= REMINDER_2_MIN) {
        await sendWhatsAppMessage(clientId,
          `Disculpa la demora. 🙏 Si es urgente puedes llamarnos directamente al ${LEON_CONTACT_NUMBER}. Un asesor te atenderá lo antes posible.`);
        info.stage = 2; pendingAgentRequests.set(clientId, info); schedulePersist();
      }
    } catch (e) {
      console.error('[reminder] error enviando recordatorio:', e.message);
    }
  }
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
const PRODUCTS = [
  { name: 'Roku Streaming Stick Plus 4K', price: '$720', img: 'ROkuplus4K.jpeg', cat: 'Streaming', kw: ['roku 4k', 'roku plus', 'streaming 4k', 'roku'] },
  { name: 'Roku Streaming Stick HD', price: '$680', img: 'RokuStickHD.jpeg', cat: 'Streaming', kw: ['roku hd', 'roku stick'] },
  { name: 'Extensor de rango Wi-Fi TP-Link N300', price: '$450', img: 'extensorderangowifitplink.jpeg', cat: 'Internet', kw: ['extensor', 'repetidor', 'amplificador wifi'] },
  { name: 'Adaptador USB Wi-Fi TP-Link AC600', price: '$220', img: 'adaptadorwifimini.jpeg', cat: 'Internet', kw: ['adaptador wifi', 'antena usb', 'antena wifi', 'usb wifi'] },
  { name: 'Tinta original HP GT52/GT53 (4 pzas)', price: '$750', img: 'tintaoriginalHP4pz.jpeg', cat: 'Cómputo', kw: ['tinta', 'cartucho'] },
  { name: 'Memoria USB ADATA 32GB (USB 3.2)', price: '$90', img: 'USB adata 32Gb.jpeg', cat: 'Cómputo', kw: ['memoria 32', 'usb 32', '32gb'] },
  { name: 'Memoria USB ADATA 64GB (USB 2.0)', price: '$140', img: 'UBS adata 64 Gb.jpeg', cat: 'Cómputo', kw: ['memoria 64', 'usb 64', '64gb'] },
  { name: 'Mouse inalámbrico UGREEN', price: '$190', img: 'mouseugreen.jpeg', cat: 'Cómputo', kw: ['mouse', 'raton'] },
  { name: 'Base enfriadora ACTECK (laptop 15")', price: '$180', img: 'baseenfriadoraacteck.jpeg', cat: 'Cómputo', kw: ['enfriadora', 'cooler', 'base laptop', 'base para laptop', 'ventilador laptop'] },
  { name: 'Soporte para TV 13"–42" (full motion)', price: '$400', img: 'soporteparatvde13pulgadashassta42pulgadas.jpeg', cat: 'TV', kw: ['soporte tv', 'soporte para tv', 'soporte de tv', 'rack tv', 'base tv'] },
  { name: 'Adaptador UGREEN USB-C a USB-A', price: '$150', img: 'AdapatadorUSBCaUSBA.jpeg', cat: 'Cables', kw: ['usb c a usb a', 'adaptador tipo c a usb'] },
  { name: 'Adaptador UGREEN USB-A a USB-C', price: '$175', img: 'adaptadorUSBAaUSBC.jpeg', cat: 'Cables', kw: ['usb a a usb c', 'adaptador usb a tipo c'] },
  { name: 'Cable UGREEN USB-C a Lightning (iPhone) 20W', price: '$280', img: 'cableligthningacugreen.jpeg', cat: 'Cables', kw: ['cable iphone', 'cable lightning', 'cargador iphone', 'lightning'] },
  { name: 'Cable HDMI Manhattan 4K 1.8m', price: '$80', img: 'cableshdmisuperspeed.jpeg', cat: 'Cables', kw: ['cable hdmi', 'hdmi 4k'] },
  { name: 'Cable UGREEN USB-C a USB-C 60W', price: '$150', img: 'cabletipocatipocugreen.jpeg', cat: 'Cables', kw: ['cable tipo c', 'cable usb c', 'cable type c'] },
  { name: 'Convertidor Steren HDMI a RCA', price: '$320', img: 'convertidordeHDMIaRCAsteren.jpeg', cat: 'Cables', kw: ['convertidor hdmi', 'hdmi a rca', 'hdmi rca'] },
  { name: 'Reflector solar JWL 100W (2 pzas)', price: '$1,300', img: 'reflectorsolar100W.jpeg', cat: 'Iluminación', kw: ['reflector solar 100', 'reflector 100', 'reflector solar', 'reflector'] },
  { name: 'Reflector solar JWL 200W (2 pzas)', price: '$1,500', img: 'reflectorsolar.jpeg', cat: 'Iluminación', kw: ['reflector solar 200', 'reflector 200', 'reflector solar', 'reflector'] },
  { name: 'Tira LED JWL 5m (12V)', price: '$250', img: 'TIRALED5M.jpeg', cat: 'Iluminación', kw: ['tira led', 'tira de led', 'tiras led'] },
  { name: 'Luminario público JWL 150W LED (con fotocelda)', price: '$1,050', img: 'luminariopublico150W.jpeg', cat: 'Iluminación', kw: ['luminario', 'luminaria', 'lampara publica', 'alumbrado'] },
  { name: 'Espuma limpiadora SILIMEX SILIMPO 454ml', price: '$120', img: 'espumalimpiadoraslimpoo.jpeg', cat: 'Limpieza', kw: ['espuma', 'limpiador espuma'] }
];

function getProductImageUrl(p) { return PRODUCT_IMG_BASE + encodeURIComponent(p.img); }

function isProductRequest(text) {
  const v = normalizeText(text);
  return /\b(producto|productos|accesorio|accesorios|que venden|que mas venden|que mas tienen|que tienen en la oficina|vitrina|articulos|en oferta|ofertas)\b/.test(v);
}

function findProducts(text) {
  const v = normalizeText(text);
  return PRODUCTS.filter(p => p.kw.some(k => v.includes(k)));
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
      /\b(internet|servicio|wifi|plan|planes|paquete|fibra|inalambric|megas)\b/.test(v)) return true;
  return isPlanRequest(text);
}

let _promoIndex = 0;
function nextPromoProduct() {
  const p = PRODUCTS[_promoIndex % PRODUCTS.length];
  _promoIndex++;
  return p;
}

// Destacado de producto al cerrar el chat (rotando entre el catálogo).
async function sendProductHighlight(chatId, sendMsg) {
  const p = nextPromoProduct();
  await sendMsg(chatId,
    `Por cierto 👀 en nuestra oficina también vendemos:\n🛍️ *${p.name}* — ${p.price}\n¿Te interesa? Escribe *productos* para ver más.`,
    [getProductImageUrl(p)]
  );
}

function buildProductListText() {
  const cats = {};
  for (const p of PRODUCTS) { (cats[p.cat] = cats[p.cat] || []).push(`• ${p.name} — ${p.price}`); }
  const order = ['Streaming', 'Internet', 'TV', 'Cables', 'Cómputo', 'Iluminación', 'Limpieza'];
  const lines = ['🛍️ *Productos y accesorios en nuestra oficina:*', ''];
  for (const c of order) { if (cats[c]) { lines.push(`*${c}*`, ...cats[c], ''); } }
  lines.push('Escríbeme el nombre del que te interese y te mando foto. 😊');
  return lines.join('\n');
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

async function handleChatMessage(chatId, text, sendMsg) {
  try {
    // If agent has taken over this chat, relay client message to agent
    if (isPaused(chatId)) {
      if (AGENT_WHATSAPP_NUMBER) {
        const cp = getProfile(chatId);
        const clientName = nameOf(cp, chatId);
        try {
          await sendWhatsAppMessage(AGENT_WHATSAPP_NUMBER,
            `💬 ${clientName}:\n${text}`
          );
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

    // Pregunta por el horario de atención → responder con la lista (sin romper el flujo)
    if (isHoursRequest(text)) {
      addMessageToHistory(chatId, 'bot', 'horario');
      await sendMsg(chatId, buildBusinessHoursMessage());
      return;
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
          setSession(chatId, { state: 'awaiting_report', data: {} });
          await sendReplyObject(buildReportPrompt());
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
        if (aiResult2.message) await sendMsg(chatId, aiResult2.message);
        setSession(chatId, { state: 'awaiting_report', data: { problemDescription: text } });
        if (!knownName2) await sendReplyObject(buildReportPrompt());
        else { const n2 = await notifyAgentRequest(chatId, [`REPORTE`, `Nombre: ${knownName2}`, `Problema: ${text}`].join('\n'), '').catch(() => false); clearSession(chatId); await sendMsg(chatId, agentNotifiedMsg(n2, knownName2, 'técnico')); }
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
      const goodbye = !hasRealQ && normalizeText(text).match(/\b(no gracias|no|ya no|solo preguntaba|nada|gracias nada mas|es todo)\b/);
      if (goodbye) {
        clearSession(chatId);
        await sendMsg(chatId, 'Con gusto. Cuando guste nos contacta para cotizar. 😊');
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
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
      const knownProfile = getProfile(chatId);
      const knownName = nameOf(knownProfile);
      const menuOptions = [
        '1️⃣ Ver planes de internet',
        '2️⃣ Cámaras de seguridad',
        '3️⃣ Soporte técnico',
        '4️⃣ Hablar con un asesor',
        '5️⃣ Migrar mi servicio',
        '6️⃣ Productos y accesorios 🛍️'
      ].join('\n');
      if (knownName) {
        await sendMsg(chatId, [
          `Bienvenido de vuelta, ${knownName}. 👋`,
          '¿En qué puedo ayudarte hoy?',
          '',
          menuOptions
        ].join('\n'));
      } else {
        await sendMsg(chatId, [
          'Hola, soy Leo, el asistente virtual de León Telecom. 👋',
          '',
          'Puedo ayudarte con:',
          '• Planes de internet (fibra óptica e inalámbrico)',
          '• Cámaras de seguridad (Tapo Wi-Fi e Hikvision profesional)',
          '• Soporte técnico y reportes de fallas',
          '• Productos y accesorios (Roku, cables, reflectores, USB…) — escribe "productos"',
          '• Conectarte con un asesor',
          '',
          'Elige una opción o escribe tu consulta:',
          '',
          menuOptions
        ].join('\n'));
      }
      return;
    }

    // Cierre de conversación → despedida + producto destacado (vitrina)
    if (isClosing(text)) {
      await sendMsg(chatId, '¡Con gusto! Que tengas excelente día. 🙌');
      try { await sendProductHighlight(chatId, sendMsg); } catch (e) {}
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
      const detectedNbhd = (aiResult.neighborhood ? searchAllNeighborhoods(aiResult.neighborhood) : null) || searchAllNeighborhoods(text);
      if (detectedNbhd) {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        setSession(chatId, { state: 'awaiting_neighborhood_confirm', data: { problemDescription: text, detectedNeighborhood: detectedNbhd.name, detectedZone: detectedNbhd.zone } });
        await sendMsg(chatId, `¿La ubicación es ${detectedNbhd.name}, ${detectedNbhd.zone}?`, [], { buttons: [{ id: 'si_ubicacion', title: 'Sí, es ahí' }, { id: 'no_ubicacion', title: 'No, es otra' }] });
      } else if (knownName) {
        // ONE message: AI advice already mentions to contact tech if persists. Notify silently.
        await notifyAgentRequest(chatId, [`REPORTE DE FALLA`, `Nombre: ${knownName}`, `Problema: ${text}`].join('\n'), '').catch(() => {});
        clearSession(chatId);
        await sendMsg(chatId, aiResult.message || `Ya avisamos al equipo técnico, ${knownName}. Te contactarán pronto.`);
      } else {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        setSession(chatId, { state: 'awaiting_report', data: { problemDescription: text } });
        await sendReplyObject(buildReportPrompt());
      }

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
      const imageBase64 = (await imageResponse.buffer()).toString('base64');
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

  if (msg.type === 'text') {
    const text = msg.text?.body?.trim();
    if (!text) return;

    // If message is FROM the agent → route to agent handler (commands or relay)
    if (AGENT_WHATSAPP_NUMBER && from === AGENT_WHATSAPP_NUMBER) {
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
      // If agent tapped a button (e.g. "Atender caso") → route to agent commands
      if (AGENT_WHATSAPP_NUMBER && from === AGENT_WHATSAPP_NUMBER) {
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

// Admin login page
app.get('/admin/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-login.html'));
});

// Admin dashboard page — auth handled client-side via localStorage token
app.get('/admin/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-dashboard.html'));
});

// ---- Autenticación del panel: tokens firmados (HMAC) con expiración ----
function signAdminToken(ttlMs = ADMIN_TOKEN_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', iat: Date.now(), exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminTokenValue(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.role === 'admin' && data.exp && Date.now() < data.exp;
  } catch (e) { return false; }
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Límite de intentos de login por IP (anti fuerza bruta)
const loginAttempts = new Map(); // ip → { count, firstAt, blockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

// API: Admin login
app.post('/admin/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };

  if (rec.blockedUntil > now) {
    const mins = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Demasiados intentos. Intenta de nuevo en ${mins} min.` });
  }
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }

  const { password } = req.body || {};
  if (password && constantTimeEqual(password, ADMIN_PASSWORD)) {
    loginAttempts.delete(ip);
    return res.json({ success: true, token: signAdminToken(), expiresInHours: Math.round(ADMIN_TOKEN_TTL_MS / 3600000) });
  }

  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) { rec.blockedUntil = now + LOGIN_BLOCK_MS; rec.count = 0; }
  loginAttempts.set(ip, rec);
  return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

// Middleware to verify admin token
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = req.body?.token || req.query.token || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  if (verifyAdminTokenValue(token)) return next();
  return res.status(401).json({ error: 'Sesión expirada o token inválido' });
}

// API: Get user count
app.get('/admin/api/user-count', verifyAdminToken, (req, res) => {
  res.json({ count: dataManager.getUserCount() });
});

// API: Send broadcast NOW (aviso or promo)
app.post('/admin/api/broadcast', verifyAdminToken, async (req, res) => {
  const { type, label, message, imageUrl, scheduleType } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  const id = generateBroadcastId();
  const now = new Date();
  const imageUrls = imageUrl ? [imageUrl] : [];

  // Calculate endAt and intervalMs based on scheduleType
  let intervalMs = null, endAt = null;
  if (scheduleType === 'daily_3days') { intervalMs = 24*3600000; endAt = new Date(now.getTime() + 3*24*3600000).toISOString(); }
  else if (scheduleType === 'daily_7days') { intervalMs = 24*3600000; endAt = new Date(now.getTime() + 7*24*3600000).toISOString(); }
  else if (scheduleType === 'hourly_2h') { intervalMs = 2*3600000; endAt = new Date(now.getTime() + 2*3600000).toISOString(); }
  else if (scheduleType === 'hourly_6h') { intervalMs = 6*3600000; endAt = new Date(now.getTime() + 6*3600000).toISOString(); }
  // else 'once': no interval, no endAt

  const bc = { id, type: type || 'aviso', label: label || message.substring(0, 40), message, imageUrls, scheduleType, intervalMs, endAt, status: 'active', sentCount: 0, createdAt: now.toISOString(), nextSendAt: now.toISOString() };
  scheduledBroadcasts.set(id, bc);

  // Send immediately (scheduler will pick it up, but also trigger now)
  try {
    const result = await sendBulkWhatsApp(message, imageUrls);
    bc.sentCount = 1;
    bc.lastSentAt = now.toISOString();
    bc.nextSendAt = intervalMs ? new Date(now.getTime() + intervalMs).toISOString() : null;
    if (!intervalMs) bc.status = 'completed';
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
app.delete('/admin/api/broadcasts/:id', verifyAdminToken, (req, res) => {
  const bc = scheduledBroadcasts.get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'No encontrado' });
  bc.status = 'cancelled';
  scheduledBroadcasts.set(req.params.id, bc);
  schedulePersist();
  res.json({ success: true });
});

// API: Modify broadcast duration
app.patch('/admin/api/broadcasts/:id', verifyAdminToken, (req, res) => {
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

// API: Upload image → se guarda en MongoDB y se sirve desde /images/db/:id
app.post('/admin/api/upload-image', verifyAdminToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  let ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (!ext || ext === '.') ext = '.jpg';
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const ok = await persistence.saveImage(id, req.file.mimetype, req.file.buffer);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar la imagen' });
  res.json({ success: true, url: `${SERVER_BASE_URL}/images/db/${id}` });
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

// API: List all clients (bot + manual)
app.get('/admin/api/clients', verifyAdminToken, (req, res) => {
  const recipients = getAllBroadcastRecipients();
  res.json({ clients: recipients, total: recipients.length });
});

// API: Add manual client
app.post('/admin/api/clients', verifyAdminToken, (req, res) => {
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
app.delete('/admin/api/clients/:phone', verifyAdminToken, (req, res) => {
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
    count: wisphubClients.size
  });
});

// API: Trigger Wisphub sync manually
app.post('/admin/api/wisphub-sync', verifyAdminToken, async (req, res) => {
  const result = await syncWisphubClients();
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

const port = Number(process.env.PORT || 3000);

(async () => {
  // 1) Conectar persistencia y restaurar estado guardado
  try {
    await persistence.init();
    hydrateState(await persistence.load());
  } catch (e) {
    console.error('[persistence] Error al iniciar:', e.message);
  }

  // 2) Guardado periódico de seguridad (por si algún cambio no disparó schedulePersist)
  setInterval(() => schedulePersist(), 30000);

  // 3) Recordatorios a clientes que siguen esperando un asesor
  setInterval(() => sweepAgentReminders().catch(() => {}), 90000);

  // 4) Levantar el servidor
  app.listen(port, () => {
    console.log(`León Telecom server listening on port ${port}`);
    console.log(`AI provider: ${AI_PROVIDER}`);
    console.log(`Persistencia: ${persistence.label}`);
    console.log(`Horario de atención: ${BUSINESS_HOURS_SUMMARY}`);
  });
})();