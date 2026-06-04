require('dotenv').config();

const express = require('express');
const path = require('path');
const { analyzePaymentReceipt } = require('./utils/imageAnalysis');
const dataManager = require('./utils/dataManager');

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
const WISPHUB_API_URL = process.env.WISPHUB_API_URL || 'https://api.wisphub.net'; // Optional

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
  telixtlahuaca: { costo: '$1,200', promo: '' },
  suchilquitongo: { costo: 'a cotizar con técnico', promo: '' }
};

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

// Client profiles — remembers name, location across messages (in-memory, resets on redeploy)
const clientProfiles = new Map();

function getProfile(chatId) {
  return clientProfiles.get(String(chatId)) || null;
}

function updateProfile(chatId, updates) {
  const id = String(chatId);
  const existing = clientProfiles.get(id) || { firstSeen: new Date() };
  clientProfiles.set(id, { ...existing, ...updates, lastSeen: new Date() });
}

// Agent takeover — pauses bot for a specific client chat
const pausedChats = new Map(); // Map<chatId, { pausedUntil: Date }>

// Active relay: which client the agent is currently chatting through the bot
const agentActiveCases = new Map(); // Map<agentNumber, clientId>

function isPaused(chatId) {
  const p = pausedChats.get(String(chatId));
  if (!p) return false;
  if (new Date() > p.pausedUntil) { pausedChats.delete(String(chatId)); return false; }
  return true;
}

function pauseChat(chatId, hours = 2) {
  pausedChats.set(String(chatId), { pausedUntil: new Date(Date.now() + hours * 3600000) });
}

function unpauseChat(chatId) {
  pausedChats.delete(String(chatId));
}

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
}

function retrieveFolio(folio) {
  return folios.get(folio) || null;
}

function cancelFolio(folio) {
  return folios.delete(folio);
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

function isExistingCustomer(text) {
  const value = normalizeText(text);
  return /\b(ya tengo un plan|ya tengo servicio|soy cliente|tengo un plan|mi plan|ya soy cliente|cliente)\b/.test(value);
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
          ? '💰 Instalación: $1,200'
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

function buildExistingCustomerReply() {
  return {
    text: '¿En qué te puedo ayudar?',
    mediaUrls: [],
    buttons: [
      { id: 'problema_tecnico', title: 'Tengo un problema' },
      { id: 'mi_factura', title: 'Mi factura/pago' },
      { id: 'cambiar_plan', title: 'Cambiar de plan' }
    ]
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
  if (notified) return `Listo, ${name}. Ya le avisamos a un ${type}, te contactarán pronto. 📱`;
  return `Anotado, ${name}. En breve un ${type} de León Telecom se pondrá en contacto contigo. 📱`;
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

  const clientName = profile?.name && profile.name !== 'Usuario' ? profile.name : null;
  const clientLocation = profile?.location || null;

  const fiberPlans = FIBER_PLANS.map(p => `${p.name} ${p.speed}/${p.price}`).join(', ');
  const wirelessPlans = WIRELESS_PLANS.map(p => `${p.speed}/${p.price}`).join(', ');

  const systemPrompt = [
    'Eres Leo, asistente virtual de León Telecom (ISP en Oaxaca, México).',
    'Tono: profesional y amable, como un buen agente de atención al cliente. Sin slang ni expresiones informales. Máximo 2-3 oraciones. Sin markdown.',
    '',
    'SERVICIOS DE INTERNET (las 3 zonas SÍ tienen cobertura):',
    `Huitzo — fibra óptica en: Primera/Segunda/Tercera Sección, La Guadalupe, La Cantera, Cañada del Chisme, Ojo de Agua, Esmeralda, Privada del Laurel, El Llano, Gasolinera, Loma los Pinos, Agua Blanca, Santa María Tenéxpam. Instalación: $800, primer mes gratis. Resto de Huitzo: antena inalámbrica. Planes fibra: ${fiberPlans}`,
    `Telixtlahuaca (inalámbrico/antena): instalación $1,200. Planes: ${wirelessPlans}`,
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
    'Analiza el mensaje y responde con JSON puro (sin texto extra):',
    '{"message":"respuesta natural aquí","action":null,"location":null,"neighborhood":null}',
    '',
    'Valores de "action":',
    '"show_plans" → quiere ver planes/precios de internet, contratar, preguntar por instalación o costos',
    '"show_support" → falla ACTIVA: sin internet, internet lento, se cae, no funciona. NO para preguntas generales sobre planes, velocidad o dispositivos.',
    '"show_cameras" → pregunta por cámaras, videovigilancia, CCTV, seguridad',
    '"show_migration" → quiere MIGRAR o MOVER su servicio a otro domicilio o zona. Palabras clave: migrar, cambiar domicilio, mover servicio, nueva casa, otro domicilio. Mensaje: confirmar que se iniciará el proceso.',
    '"request_agent" → SOLO cuando el cliente pide EXPLÍCITAMENTE hablar con un humano/asesor/persona. Ejemplos: "quiero hablar con alguien", "me comunicas con un asesor", "necesito hablar con una persona".',
    'null → preguntas de información, dudas sobre planes, velocidades, dispositivos, precios, comparaciones. Responde directo.',
    'NUNCA uses request_agent para: preguntas sobre cuántos dispositivos, velocidad, precio, diferencias entre planes, "oigan", "disculpen", etc.',
    'IMPORTANTE: "quiero migrar/cambiar mi servicio/domicilio" → SIEMPRE show_migration, no show_plans',
    '',
    '"location" → zona mencionada (Huitzo/Telixtlahuaca/Suchilquitongo), o null',
    '"neighborhood" → colonia/barrio/sección mencionada, o null'
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
      '4️⃣ Ya soy cliente',
      '5️⃣ Hablar con un asesor',
      '6️⃣ Migrar mi servicio'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [
        [{ text: '1' }, { text: '2' }, { text: '3' }],
        [{ text: '4' }, { text: '5' }]
      ],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

async function notifyAgentRequest(chatId, userText, location = '') {
  // Build a short conversation history for context
  const history = getHistory(chatId);
  const recentMsgs = history.messages.slice(-8);
  const historyText = recentMsgs.length > 0
    ? recentMsgs.map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.text}`).join('\n')
    : '(sin historial)';

  const profile = getProfile(chatId);
  const clientName = profile?.name && profile.name !== 'Usuario' ? profile.name : 'Desconocido';

  // AI-generated concise summary
  let summaryLine = userText;
  if (AI_API_KEY && recentMsgs.length > 0) {
    const shortHistory = recentMsgs.slice(-5).map(m => `${m.role === 'user' ? 'C' : 'L'}: ${m.text.substring(0, 120)}`).join('\n');
    summaryLine = await callAI(
      'Resume en máximo 2 líneas qué quiere o necesita el cliente. Formato:\nMOTIVO: [qué quiere]\nDETALLE: [info clave]\nSin texto extra.',
      `${shortHistory}\nÚltimo mensaje: ${userText}`,
      { temperature: 0.2, maxTokens: 80 }
    ).catch(() => userText);
  }

  const fullMessage = [
    '🔔 SOLICITUD — León Telecom',
    `👤 ${clientName}  📱 ${chatId}`,
    location ? `📍 ${location}` : '',
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

async function generateReply(userText) {
  if (isGreetingMessage(userText)) {
    return buildMenuReply();
  }

  const location = detectLocation(userText);

  if (isAgentRequest(userText)) {
    return buildAgentReply();
  }

  if (isReportRequest(userText)) {
    return buildTechnicalReply(userText);
  }

  if (isExistingCustomer(userText)) {
    return buildExistingCustomerReply();
  }

  if (isPlanListRequest(userText)) {
    return buildPlanReplyForLocation(location);
  }

  if (isPlanRequest(userText)) {
    return buildPlanReply(userText);
  }

  if (isCoverageRequest(userText)) {
    return buildCoverageReply(userText);
  }

  if (isTechnicalIssue(userText)) {
    return buildTechnicalReply(userText);
  }

  return buildFallbackReply(userText);
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
    const clientProfile = getProfile(clientId);
    const clientName = clientProfile?.name && clientProfile.name !== 'Usuario' ? clientProfile.name : clientId;
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
        const name = cp?.name && cp.name !== 'Usuario' ? cp.name : chatId;
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

const MENU_LIST_ITEMS = [
  { id: '1', title: 'Ver planes de internet' },
  { id: '2', title: 'Cámaras de seguridad' },
  { id: '3', title: 'Soporte técnico' },
  { id: '4', title: 'Ya soy cliente' },
  { id: '5', title: 'Hablar con un asesor' },
  { id: '6', title: 'Migrar mi servicio' }
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

async function handleChatMessage(chatId, text, sendMsg) {
  try {
    // If agent has taken over this chat, relay client message to agent
    if (isPaused(chatId)) {
      if (AGENT_WHATSAPP_NUMBER) {
        const cp = getProfile(chatId);
        const clientName = cp?.name && cp.name !== 'Usuario' ? cp.name : chatId;
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
      if (/^4$|^4\b|\bcuatro\b|ya soy cliente|tengo un plan|soy cliente/.test(v)) return 4;
      if (/^5$|^5\b|\bcinco\b|hablar con|asesor|agente/.test(v)) return 5;
      if (/^6$|^6\b|\bseis\b|migrar|migracion|migraci/.test(v)) return 6;
      return null;
    }

    // ===== INTENT INTERRUPTION LAYER =====
    const detectedChoice = parseMenuChoice(text);
    if (session.state && session.state !== 'awaiting_menu_choice' && detectedChoice !== null) {
      if (detectedChoice === 1) { setSession(chatId, { state: 'awaiting_location', data: {} }); await sendReplyObject(buildLocationPrompt()); return; }
      if (detectedChoice === 2) { setSession(chatId, { state: 'awaiting_camera_needs', data: {} }); await sendMsg(chatId, '¿Para qué espacio necesita las cámaras y cuántas aproximadamente?'); return; }
      if (detectedChoice === 3) { setSession(chatId, { state: 'awaiting_report', data: {} }); await sendReplyObject(buildReportPrompt()); return; }
      if (detectedChoice === 4) { setSession(chatId, { state: 'awaiting_plan_name', data: {} }); await sendReplyObject(buildExistingCustomerReply()); return; }
      if (detectedChoice === 5) { setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } }); await sendMsg(chatId, '¿Cuál es tu nombre?'); return; }
    }

    if (session.state && session.state !== 'awaiting_menu_choice') {
      const inSupportFlow = session.state.includes('report') || session.state.includes('agent') || session.state.includes('contract') || session.state.includes('camera') || session.state.includes('migration');
      if (!inSupportFlow) {
        if (isMigrationRequest(text)) {
          setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
          await sendMsg(chatId, '¡Con gusto te ayudamos con la migración! ¿En cuál zona está el servicio ACTUAL?', [], {
            buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
          });
          return;
        }
        if (isCameraRequest(text)) {
          setSession(chatId, { state: 'awaiting_camera_needs', data: {} });
          await sendMsg(chatId, 'Con gusto te asesoro en cámaras. ¿Qué espacio quieres vigilar y cuántas cámaras necesitas?');
          return;
        }
        if (isPlanRequest(text) && !session.state.includes('plan')) {
          setSession(chatId, { state: 'awaiting_location', data: {} });
          await sendReplyObject(buildLocationPrompt());
          return;
        }
        if (isAgentRequest(text) && !session.state.includes('agent')) {
          setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
          await sendMsg(chatId, '¿Cuál es su nombre?');
          return;
        }
        if ((isReportRequest(text) || isTechnicalIssue(text)) && !session.state.includes('report')) {
          setSession(chatId, { state: 'awaiting_report', data: {} });
          await sendReplyObject(buildReportPrompt());
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
      if (choice === 4) { setSession(chatId, { state: 'awaiting_plan_name', data: {} }); await sendReplyObject(buildExistingCustomerReply()); return; }
      if (choice === 5) { setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: text } }); await sendMsg(chatId, '¿Cuál es tu nombre?'); return; }
      if (choice === 6) {
        setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
        await sendMsg(chatId, '🔄 Migración de servicio\n¿En cuál zona está el servicio ACTUAL?', [], {
          buttons: [{ id: 'huitzo', title: 'Huitzo' }, { id: 'telixtlahuaca', title: 'Telixtlahuaca' }, { id: 'suchilquitongo', title: 'Suchilquitongo' }]
        });
        return;
      }
      // Nothing matched — let AI handle it (same logic as default handler)
      const aiResult2 = await callMainAI(chatId, text);
      if (!aiResult2) { await sendReplyObject(buildFallbackReply(text)); return; }
      const knownName2 = profile?.name && profile.name !== 'Usuario' ? profile.name : null;
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
      const migKnownName = profile?.name && profile.name !== 'Usuario' ? profile.name : null;
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

    if (session.state === 'awaiting_plan_name') {
      // Handle buttons from buildExistingCustomerReply
      if (text === 'problema_tecnico' || isTechnicalIssue(text)) {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }
      if (text === 'mi_factura' || normalizeText(text).includes('factura') || normalizeText(text).includes('pago')) {
        setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: 'consulta de facturación' } });
        await sendMsg(chatId, '¿A qué nombre está el servicio?');
        return;
      }
      if (text === 'cambiar_plan' || normalizeText(text).includes('cambiar') || normalizeText(text).includes('cambio')) {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }
      // Free text → ask what the issue is
      setSession(chatId, { state: 'awaiting_plan_issue', data: { plan: text } });
      await sendMsg(chatId, `¿En qué te puedo ayudar con ese plan?`);
      return;
    }

    if (session.state === 'awaiting_plan_issue') {
      const plan = session.data?.plan || '';
      setSession(chatId, { state: 'awaiting_agent_name', data: { initialRequest: `${plan}: ${text}` } });
      await sendMsg(chatId, '¿A qué nombre está el servicio?');
      return;
    }

    if (session.state === 'awaiting_neighborhood_confirm') {
      const d = session.data || {};
      const yes = text === 'si_ubicacion' || normalizeText(text).match(/\b(si|sí|correcto|exacto|ese|esa|ahí)\b/);
      const no = text === 'no_ubicacion' || normalizeText(text).match(/\b(no|incorrecto|otra|otro)\b/);
      if (yes) {
        updateProfile(chatId, { location: d.detectedZone });
        const knownName = profile?.name && profile.name !== 'Usuario' ? profile.name : null;
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

      const reportKnownName = profile?.name && profile.name !== 'Usuario' ? profile.name : null;
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
      const knownName = knownProfile?.name && knownProfile.name !== 'Usuario' ? knownProfile.name : null;
      const menuOptions = [
        '1️⃣ Ver planes de internet',
        '2️⃣ Cámaras de seguridad',
        '3️⃣ Soporte técnico',
        '4️⃣ Ya soy cliente',
        '5️⃣ Hablar con un asesor',
        '6️⃣ Migrar mi servicio'
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
          '• Consultas sobre tu servicio activo',
          '',
          'Elige una opción o escribe tu consulta:',
          '',
          menuOptions
        ].join('\n'));
      }
      return;
    }

    // No session — Claude as the brain
    const aiResult = await callMainAI(chatId, text);
    if (!aiResult) { setSession(chatId, { state: 'awaiting_menu_choice', data: {} }); await sendReplyObject(buildMenuReply()); return; }

    const knownName = profile?.name && profile.name !== 'Usuario' ? profile.name : null;

    if (aiResult.action === 'show_plans') {
      // Only use location from the CURRENT message — never assume profile location for contracting
      // (profile location could be a different place than where they want the new service)
      const loc = aiResult.location
        ? (detectLocation(aiResult.location) || aiResult.location)
        : null;

      const wantsContract = /\b(quiero contratar|quiero el servicio|me interesa|dale|lo quiero|ya quiero)\b/i.test(text);
      if (wantsContract && loc && knownName) {
        await notifyAgentRequest(chatId, [`SOLICITUD DE INSTALACIÓN`, `Nombre: ${knownName}`, `Zona: ${loc}`].join('\n'), loc).catch(() => {});
        clearSession(chatId);
        await sendMsg(chatId, `Listo, ${knownName}. Ya le avisamos a un asesor para coordinar la instalación en ${loc}. 📞`);
      } else if (wantsContract && loc) {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        setSession(chatId, { state: 'awaiting_contract_name', data: { location: loc } });
        await sendMsg(chatId, '¿A qué nombre te contactamos?', [], { buttons: [{ id: 'solo_preguntaba', title: 'Solo preguntaba' }] });
      } else {
        if (aiResult.message) await sendMsg(chatId, aiResult.message);
        if (loc) { updateProfile(chatId, { location: loc }); setSession(chatId, { state: 'awaiting_plan_selection', data: { location: loc } }); await sendReplyObject(buildPlanReplyForLocation(loc)); }
        else { setSession(chatId, { state: 'awaiting_location', data: {} }); await sendReplyObject(buildLocationPrompt()); }
      }

    } else if (aiResult.action === 'show_support') {
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

// Admin dashboard page
app.get('/admin/dashboard', (req, res) => {
  const auth = req.headers.authorization || req.query.auth;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN || 'temp-token'}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.sendFile(path.join(__dirname, 'public/admin-dashboard.html'));
});

// API: Admin login
app.post('/admin/api/login', (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    const token = Buffer.from(`admin:${Date.now()}`).toString('base64');
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
  }
});

// Middleware to verify admin token
function verifyAdminToken(req, res, next) {
  const token = req.body.token || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    if (decoded.startsWith('admin:')) {
      return next();
    }
  } catch (e) {
    // Fall through
  }

  res.status(401).json({ error: 'Token inválido' });
}

// API: Get user count
app.get('/admin/api/user-count', (req, res) => {
  res.json({ count: dataManager.getUserCount() });
});

// API: Get network status (check Wisphub or return online)
app.get('/admin/api/network-status', async (req, res) => {
  try {
    // For now, return online. In production, check Wisphub API
    res.json({ online: true, message: 'Servicio operativo' });
  } catch (error) {
    res.json({ online: false, message: error.message });
  }
});

// API: Send bulk message
app.post('/admin/api/send-message', async (req, res) => {
  const { message, token } = req.body;

  // Basic auth check
  if (!token || token !== `Bearer ${ADMIN_PASSWORD}-bulk`) {
    const isAdmin = Buffer.from(token || '', 'base64').toString().startsWith('admin:');
    if (!isAdmin) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

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
app.post('/admin/api/send-promotion', async (req, res) => {
  const { text, imageBase64, token } = req.body;

  // Basic auth check (simplified for demo)
  if (!token) {
    return res.status(401).json({ error: 'No autorizado' });
  }

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
app.get('/admin/api/reports', (req, res) => {
  const reports = dataManager.getPendingReports();
  res.json({ reports, count: reports.length });
});

// API: Mark report as contacted
app.post('/admin/api/reports/:reportId/contact', (req, res) => {
  const { reportId } = req.params;
  const report = dataManager.markReportAsContacted(reportId);

  if (report) {
    res.json({ success: true, report });
  } else {
    res.status(404).json({ success: false, error: 'Reporte no encontrado' });
  }
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`León Telecom server listening on port ${port}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
});