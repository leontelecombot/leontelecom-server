require('dotenv').config();

const express = require('express');
const path = require('path');
const { analyzePaymentReceipt } = require('./utils/imageAnalysis');
const dataManager = require('./utils/dataManager');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const SYSTEM_PROMPT = [
  'Eres Leo, asesor de internet para León Telecom.',
  'Eres cálido, honesto, y enfocado en ayudar a cada cliente.',
  'Responde siempre en español, con tono amable y directo.',
  'Tu objetivo: que el cliente vea el servicio como la solución perfecta para su familia.',
  'Habla solo de internet; nunca menciones otros servicios.',
  'Si no tienes un dato, sé transparente pero mantén la confianza en la solución.'
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

const NEIGHBORHOODS = {
  huitzo: [
    'Colonia Primera Sección', 'Centro de la Segunda Sección', 'Centro de la Tercera Sección',
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
  return /\b(plan|paquete|planes|precio|precios|tarifa|tarifas|costo|costos|promocion|internet)\b/.test(value);
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
  return /\b(falla|sin servicio|no funciona|intermitente|lento|reiniciar|conectar|conexion|caido|caída|soporte)\b/.test(value);
}

function isAgentRequest(text) {
  const value = normalizeText(text);
  return /\b(agente|asesor|ejecutivo|humano|persona|llamar|contactar|ventas|atencion|atención)\b/.test(value);
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

  if (/\btelixtlahuaca\b/.test(value) || /\btelix\b/.test(value)) {
    return LOCATIONS.telixtlahuaca;
  }

  if (/\bsuchilquitongo\b/.test(value) || /\bsuchil\b/.test(value)) {
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
  
  // Find best match
  const match = neighborhoods.find(n => normalizeText(n).includes(value) || value.includes(normalizeText(n).split(' ')[0]));
  return match ? { name: match, location } : null;
}

function isGreetingMessage(text) {
  const value = normalizeText(text).trim();
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal)(\b|\s|,|!|\.)/i.test(value);
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
    text: [
      '👤 Genial. Para ayudarte mejor, necesito:',
      '1) Tu plan actual (Lite, Basic, Medium, Advanced, Ultra o el MB/precio)',
      '2) El problema: velocidad, facturación, instalación, o soporte técnico?'
    ].join(' '),
    mediaUrls: []
  };
}

function buildReportPrompt() {
  return {
    text: [
      '🔧 Entendido. Cuéntame qué pasa:',
      '❌ Sin internet, 🐢 muy lento, ⚡ intermitente, u otro?',
      'Así puedo indicarte la solución rápido.'
    ].join(' '),
    mediaUrls: []
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
      '¿En qué te puedo ayudar? Responde con el número:',
      '',
      '1️⃣ Ver planes de internet',
      '2️⃣ Soporte técnico',
      '3️⃣ Ya soy cliente',
      '4️⃣ Hablar con un asesor',
      '5️⃣ Migrar mi servicio'
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

  const fullMessage = [
    '🔔 *SOLICITUD DE ASESOR — León Telecom*',
    `👤 Cliente: ${clientName}`,
    `📱 WhatsApp: ${chatId}`,
    location ? `📍 Zona: ${location}` : '',
    '',
    userText,
    '',
    '--- Últimos mensajes ---',
    historyText
  ].filter(line => line !== undefined).join('\n');

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
      await sendWhatsAppMessage(AGENT_WHATSAPP_NUMBER, fullMessage);
      notified = true;
    } catch (e) {
      console.error('Agent WhatsApp notify error:', e.message);
    }
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

const MENU_LIST_ITEMS = [
  { id: '1', title: 'Ver planes de internet' },
  { id: '4', title: 'Soporte técnico' },
  { id: '2', title: 'Ya soy cliente' },
  { id: '3', title: 'Hablar con un asesor' },
  { id: '5', title: 'Migrar mi servicio' }
];

async function handleChatMessage(chatId, text, sendMsg) {
  try {
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
      if (/^1$|^1\b|\buno\b|ver planes|planes|paquetes|internet|contratar/.test(v)) return 1;
      if (/^2$|^2\b|\bdos\b|ya soy cliente|tengo un plan|soy cliente/.test(v)) return 2;
      if (/^3$|^3\b|\btres\b|hablar con|asesor|agente/.test(v)) return 3;
      if (/^4$|^4\b|\bcuatro\b|reportar|problema|reporte|soporte|tecnico|falla/.test(v)) return 4;
      if (/^5$|^5\b|\bcinco\b|migrar|migracion|migraci/.test(v)) return 5;
      if (/^6$|^6\b|\bseis\b|cancelar|cancel|no quiero/.test(v)) return 6;
      return null;
    }

    // ===== INTENT INTERRUPTION LAYER =====
    const detectedChoice = parseMenuChoice(text);
    if (session.state && session.state !== 'awaiting_menu_choice' && detectedChoice !== null) {
      if (detectedChoice === 1) {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }
      if (detectedChoice === 2) {
        setSession(chatId, { state: 'awaiting_plan_name', data: {} });
        await sendReplyObject(buildExistingCustomerReply());
        return;
      }
      if (detectedChoice === 3) {
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendMsg(chatId, '¿Cuál es tu nombre?');
        return;
      }
      if (detectedChoice === 4) {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }
    }

    if (session.state && session.state !== 'awaiting_menu_choice') {
      if (isPlanRequest(text) && !session.state.includes('installation') && !session.state.includes('plan')) {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }
      if (isAgentRequest(text) && session.state !== 'awaiting_agent_name' && session.state !== 'awaiting_agent_neighborhood') {
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendMsg(chatId, '¿Cuál es tu nombre?');
        return;
      }
      if (isReportRequest(text) && session.state !== 'awaiting_report' && !session.state.includes('report')) {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }
      if (isExistingCustomer(text) && session.state !== 'awaiting_plan_name' && !session.state.includes('installation')) {
        setSession(chatId, { state: 'awaiting_plan_name', data: {} });
        await sendReplyObject(buildExistingCustomerReply());
        return;
      }
    }
    // ===== END INTENT INTERRUPTION LAYER =====

    if (session.state === 'awaiting_menu_choice') {
      const choice = parseMenuChoice(text);
      if (choice === 1) { setSession(chatId, { state: 'awaiting_location', data: {} }); await sendReplyObject(buildLocationPrompt()); return; }
      if (choice === 2) { setSession(chatId, { state: 'awaiting_plan_name', data: {} }); await sendReplyObject(buildExistingCustomerReply()); return; }
      if (choice === 3) { setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } }); await sendMsg(chatId, '¿Cuál es tu nombre?'); return; }
      if (choice === 4) { setSession(chatId, { state: 'awaiting_report', data: {} }); await sendReplyObject(buildReportPrompt()); return; }
      if (choice === 5) {
        setSession(chatId, { state: 'awaiting_migration_current_location', data: {} });
        await sendMsg(chatId, '🔄 Migración de servicio\n¿En cuál zona está el servicio ACTUAL?', [], {
          buttons: [
            { id: 'huitzo', title: 'Huitzo' },
            { id: 'telixtlahuaca', title: 'Telixtlahuaca' },
            { id: 'suchilquitongo', title: 'Suchilquitongo' }
          ]
        });
        return;
      }
      await sendReplyObject(buildFallbackReply(text));
      return;
    }

    if (session.state === 'awaiting_migration_current_location') {
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_migration_new_location', data: { currentLocation: location } });
        await sendMsg(chatId, '¿A cuál zona quieres MIGRAR el servicio?', [], {
          buttons: [
            { id: 'huitzo', title: 'Huitzo' },
            { id: 'telixtlahuaca', title: 'Telixtlahuaca' },
            { id: 'suchilquitongo', title: 'Suchilquitongo' }
          ]
        });
        return;
      }
      await sendMsg(chatId, 'Elige tu zona actual:', [], {
        buttons: [
          { id: 'huitzo', title: 'Huitzo' },
          { id: 'telixtlahuaca', title: 'Telixtlahuaca' },
          { id: 'suchilquitongo', title: 'Suchilquitongo' }
        ]
      });
      return;
    }

    if (session.state === 'awaiting_migration_new_location') {
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_migration_name', data: { ...session.data, newLocation: location } });
        await sendMsg(chatId, '¿A qué nombre está el servicio actual?');
        return;
      }
      await sendMsg(chatId, 'Elige la zona de destino:', [], {
        buttons: [
          { id: 'huitzo', title: 'Huitzo' },
          { id: 'telixtlahuaca', title: 'Telixtlahuaca' },
          { id: 'suchilquitongo', title: 'Suchilquitongo' }
        ]
      });
      return;
    }

    if (session.state === 'awaiting_migration_name') {
      const d = session.data || {};
      updateProfile(chatId, { name: text });
      try {
        await notifyAgentRequest(chatId, [
          `SOLICITUD DE MIGRACIÓN DE SERVICIO`,
          `Nombre: ${text}`,
          `Zona actual: ${d.currentLocation}`,
          `Zona nueva: ${d.newLocation}`
        ].join('\n'), d.newLocation);
      } catch (e) { console.error('Migration notify error:', e.message); }
      clearSession(chatId);
      await sendMsg(chatId, [
        `✅ ¡Listo, ${text}!`,
        `Solicitud de migración de ${d.currentLocation} → ${d.newLocation} registrada.`,
        `Un asesor de León Telecom te contactará pronto por WhatsApp. 📞`
      ].join('\n'));
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
      const location = session.data?.location;
      const plans = location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
      const selectedPlan = plans.find(p =>
        normalizeText(text).includes(normalizeText(p.name)) ||
        normalizeText(text).includes(normalizeText(p.speed))
      );
      const planData = selectedPlan
        ? { ...session.data, selectedPlan: selectedPlan.name, selectedSpeed: selectedPlan.speed, selectedPrice: selectedPlan.price }
        : session.data;
      const planLabel = selectedPlan ? `${selectedPlan.name} — ${selectedPlan.speed} — ${selectedPlan.price}` : '';
      setSession(chatId, { state: 'awaiting_contract_name', data: planData });
      await sendMsg(chatId,
        `¡Excelente! 🎉${planLabel ? '\nPlan: ' + planLabel : ''}\n\n¿A qué nombre te contactamos para coordinar la instalación?`,
        [], { buttons: [{ id: 'solo_info', title: 'Solo información' }] }
      );
      return;
    }

    if (session.state === 'awaiting_contract_name') {
      const d = session.data || {};
      if (text === 'solo_info' || normalizeText(text).match(/\b(solo info|no gracias|solo informacion|nada mas|despues|luego)\b/)) {
        clearSession(chatId);
        await sendMsg(chatId, '¡Sin problema! Si decides contratar, aquí estaré. 😊');
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
      await sendMsg(chatId, `✅ ¡Listo, ${text}! Un asesor de León Telecom te contactará pronto por este WhatsApp para coordinar los detalles de tu instalación. 📞`);
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
      setSession(chatId, { state: 'awaiting_plan_issue', data: { plan: text } });
      await sendMsg(chatId, `Gracias. Indica en qué necesitas ayuda con el plan "${text}": facturación, velocidad, falla, o cambio de plan.`);
      return;
    }

    if (session.state === 'awaiting_plan_issue') {
      const plan = session.data?.plan || 'tu plan';
      clearSession(chatId);
      await sendMsg(chatId, `Recibido sobre ${plan}. He registrado tu consulta: "${text}". Un agente podrá revisarla y te contactará si es necesario.`);
      try { await notifyAgentRequest(chatId, `Cliente: ${plan} - ${text}`, detectLocation(text)); } catch (e) { console.error('Agent notification error:', e.message); }
      return;
    }

    if (session.state === 'awaiting_report') {
      setSession(chatId, { state: 'awaiting_report_name', data: { problemDescription: text } });
      await sendMsg(chatId, '¿A qué nombre está el servicio?');
      return;
    }

    if (session.state === 'awaiting_report_name') {
      const d = session.data || {};
      updateProfile(chatId, { name: text });
      setSession(chatId, { state: 'awaiting_report_address', data: { ...d, name: text } });
      await sendMsg(chatId, '¿Dónde está ubicada la casa de la instalación?');
      return;
    }

    if (session.state === 'awaiting_report_address') {
      const d = session.data || {};
      const location = detectLocation(d.problemDescription) || 'Ubicación no especificada';
      setSession(chatId, { state: 'awaiting_report_neighborhood', data: { ...d, address: text, location } });
      await sendMsg(chatId, '¿Cuál es tu colonia, barrio o sección?');
      return;
    }

    if (session.state === 'awaiting_report_neighborhood') {
      try {
        const d = session.data || {};
        const match = d.location !== 'Ubicación no especificada' ? findNeighborhood(text, d.location) : null;
        const neighborhood = match ? match.name : text;
        setSession(chatId, { state: 'awaiting_report_location_confirm', data: { ...d, neighborhood } });
        await sendMsg(chatId, match ? `¿Es correcto que el problema es en ${match.name} ${match.location}?` : `¿Es correcto? Tu reporte es de ${text}.`);
      } catch (err) {
        console.error('Report neighborhood error:', err.message);
        setSession(chatId, { state: 'awaiting_report_location_confirm', data: { ...session.data, neighborhood: text } });
        await sendMsg(chatId, `¿Es correcto? Tu reporte es de ${text}.`);
      }
      return;
    }

    if (session.state === 'awaiting_report_location_confirm') {
      const yes = normalizeText(text).match(/\b(si|sí|yes|claro|ok|okay|correcto|verdad|sale)\b/);
      const no = normalizeText(text).match(/\b(no|nope|nah|incorrecto)\b/);
      if (yes) {
        const d = session.data || {};
        clearSession(chatId);
        try {
          await notifyAgentRequest(chatId, [
            `REPORTE DE PROBLEMA`,
            `Problema: ${d.problemDescription}`,
            `Nombre: ${d.name}`,
            `Dirección: ${d.address}`,
            `Barrio/Colonia: ${d.neighborhood}`,
            `Ubicación: ${d.location}`
          ].join('\n'), d.location);
        } catch (e) { console.error('Agent notification error:', e.message); }
        await sendMsg(chatId, [
          '✅ Perfecto. He registrado tu reporte:',
          `🔧 Problema: ${d.problemDescription}`,
          `👤 Nombre: ${d.name}`,
          `📍 Dirección: ${d.address}`,
          `🏘️ Barrio: ${d.neighborhood}`,
          '',
          `⏳ En un momento un asesor se va a poner en contacto con ${d.name} para asistirte. 📱`
        ].join('\n'));
        return;
      }
      if (no) {
        clearSession(chatId);
        setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
        await sendMsg(chatId, 'Okej. ¿Qué necesitas hacer?');
        await sendReplyObject(buildMenuReply());
        return;
      }
      setSession(chatId, { state: 'awaiting_report_neighborhood', data: session.data });
      await sendMsg(chatId, 'Entendido. ¿Cuál es tu colonia, barrio o sección correcta?');
      return;
    }

    if (session.state === 'awaiting_agent_name') {
      const d = session.data || {};
      updateProfile(chatId, { name: text });
      setSession(chatId, { state: 'awaiting_agent_need', data: { ...d, agentName: text } });
      await sendMsg(chatId, '¿Qué necesitas o qué preguntas tienes?');
      return;
    }

    if (session.state === 'awaiting_agent_need') {
      const d = session.data || {};
      setSession(chatId, { state: 'awaiting_agent_neighborhood', data: { ...d, need: text } });
      await sendMsg(chatId, '¿Cuál es tu colonia, barrio o sección?');
      return;
    }

    if (session.state === 'awaiting_agent_neighborhood') {
      const d = session.data || {};
      const match = d.location && d.location !== 'Ubicación no especificada' ? findNeighborhood(text, d.location) : null;
      clearSession(chatId);
      const notifyText = [
        `SOLICITUD DIRECTA DE ASESOR`,
        `Nombre: ${d.agentName}`,
        `Necesidad: ${d.need}`,
        match ? `Barrio/Colonia: ${match.name}` : `Ubicación mencionada: ${text}`,
        match ? `Ubicación: ${match.location}` : '',
        `Contexto: ${d.initialRequest || 'Sin contexto adicional'}`
      ].filter(Boolean).join('\n');
      try { await notifyAgentRequest(chatId, notifyText, d.location); } catch (e) { console.error('Agent notification error:', e.message); }
      await sendMsg(chatId, `✅ Perfecto ${d.agentName}.\nEn unos momentos un asesor te atenderá en el chat. 📱`);
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
      const menuText = [
        '',
        '1️⃣ Ver planes de internet',
        '2️⃣ Soporte técnico',
        '3️⃣ Ya soy cliente',
        '4️⃣ Hablar con un asesor',
        '5️⃣ Migrar mi servicio'
      ].join('\n');
      if (knownName) {
        await sendMsg(chatId, `¡Hola de nuevo, ${knownName}! ¿En qué te puedo ayudar?\n${menuText}`);
      } else {
        await sendMsg(chatId, `Hola, soy Leo de León Telecom 👋\n¿En qué te puedo ayudar?\n${menuText}`);
      }
      return;
    }

    const hasDirectIntent = isPlanRequest(text) || isCoverageRequest(text) || isTechnicalIssue(text) || isAgentRequest(text) || isExistingCustomer(text) || isReportRequest(text);

    if (!hasDirectIntent) {
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
      await sendReplyObject(buildMenuReply());
      return;
    }

    const reply = await generateReply(text);
    if (reply.replyMarkup && !session.state) {
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
    }
    await sendMsg(chatId, reply.text, reply.mediaUrls || []);

    if (isAgentRequest(text)) {
      try { await notifyAgentRequest(chatId, text, detectLocation(text)); } catch (e) { console.error('Agent notification error:', e.message); }
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
    if (text) await handleChatMessage(from, text, sendWhatsAppMessage);
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
      await handleChatMessage(from, replyId, sendWhatsAppMessage);
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