require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

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

const FIBER_PLAN_MEDIA_URL = process.env.FIBER_PLAN_MEDIA_URL || '';
const WIRELESS_PLAN_MEDIA_URL = process.env.WIRELESS_PLAN_MEDIA_URL || '';
const LEON_CONTACT_NUMBER = process.env.LEON_CONTACT_NUMBER || '9511603125';
const AGENT_NOTIFY_CHAT_ID = process.env.AGENT_NOTIFY_CHAT_ID || '';
const AGENT_NOTIFY_WEBHOOK_URL = process.env.AGENT_NOTIFY_WEBHOOK_URL || '';

const LOCATIONS = {
  huitzo: 'Huitzo',
  telixtlahuaca: 'Telixtlahuaca',
  suchilquitongo: 'Suchilquitongo'
};

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
    text: [
      '¿En cuál zona vives?',
      'Te muestro planes con fibra óptica o inalámbrico según lo que llegue a tu área.'
    ].join(' '),
    mediaUrls: [],
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
        '🔥 Planes de fibra óptica para Huitzo (la mejor conexión):',
        buildPlanLines(FIBER_PLANS),
        'Para darte la recomendación perfecta, ¿cuántas personas usan internet en tu casa?'
      ].join('\n'),
      mediaUrls: FIBER_PLAN_MEDIA_URL ? [FIBER_PLAN_MEDIA_URL] : []
    };
  }

  if (location === LOCATIONS.telixtlahuaca || location === LOCATIONS.suchilquitongo) {
    return {
      text: [
        `📡 Planes de internet inalámbrico para ${location}:`,
        buildPlanLines(WIRELESS_PLANS),
        'Dime cuántas personas usan internet en casa y te digo cuál se ajusta mejor.'
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
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Eres Leo, asesor de León Telecom.',
              `PLANES REALES EN ${context.location.toUpperCase()}: ${plansSummary}. SOLO menciona estos planes.`,
              'Máximo dos frases. PROHIBIDO inventar planes.',
              'Sé específico, cálido, directo.',
              'Termina con: "¿Instalamos?", "¿Dudas?", o "¿Te paso con asesor?"'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              `Zona: ${context.location}, Personas: ${context.householdSize}`,
              `Plan recomendado: ${baseRecommendation.name} (${baseRecommendation.speed}/${baseRecommendation.price})`,
              'Explica brevemente por qué encaja. Invita a actuar.'
            ].join('\n')
          }
        ],
        temperature: 0.65
      })
    });

    if (!response.ok) {
      return { text: fallbackText, mediaUrls: [] };
    }

    const payload = await response.json();
    const reply = payload?.choices?.[0]?.message?.content;
    if (typeof reply === 'string' && reply.trim()) {
      return { text: reply.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim(), mediaUrls: [] };
    }
  } catch (error) {
    console.error('Natural plan recommendation AI error:', error.message);
  }

  return {
    text: fallbackText,
    mediaUrls: []
  };
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
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Eres Leo, asesor de León Telecom.',
              `PLANES DISPONIBLES: ${plansSummary}. SOLO responde de esta lista. PROHIBIDO inventar.`,
              'Máximo dos frases. Sé amable, directo.',
              'Termina siempre con una acción: "¿Instalamos?", "¿Más info?", o "¿Te paso con asesor?"'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              `Zona: ${context.location}, ${context.householdSize} personas, plan recomendado: ${baseRecommendation.name} (${baseRecommendation.speed}/${baseRecommendation.price}).`,
              `Cliente dice: ${userText}`,
              'Responde brevemente manteniendo continuidad.'
            ].join('\n')
          }
        ],
        temperature: 0.65
      })
    });

    if (!response.ok) {
      return { text: fallbackText, mediaUrls: [] };
    }

    const payload = await response.json();
    const reply = payload?.choices?.[0]?.message?.content;
    if (typeof reply === 'string' && reply.trim()) {
      return { text: sanitizeAIReply(reply), mediaUrls: [] };
    }
  } catch (error) {
    console.error('Follow-up recommendation AI error:', error.message);
  }

  return {
    text: fallbackText,
    mediaUrls: []
  };
}

function buildGreetingReply(text) {
  // Present a short menu so the user picks an explicit action.
  return {
    text: [
      'Hola, soy Leo, el asistente de León Telecom.',
      '¿En qué te puedo ayudar hoy? Elige una opción o escribe su número:'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [
        [{ text: '1) Ver planes disponibles' }, { text: '2) Ya soy cliente (tengo un plan)' }],
        [{ text: '3) Quiero hablar con un asesor' }, { text: '4) Reportar un problema' }]
      ],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

function buildFallbackReply(text) {
  return {
    text: [
      '💭 Oye, no atrapé bien eso.',
      'Presiona 1️⃣, 2️⃣, 3️⃣ o 4️⃣ de arriba. 👍'
    ].join(' '),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [
        [{ text: '1️⃣ Ver planes' }, { text: '2️⃣ Ya soy cliente' }],
        [{ text: '3️⃣ Hablar con asesor' }, { text: '4️⃣ Reportar falla' }]
      ],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

function buildMenuReply() {
  return {
    text: [
      'Hola 👋 Soy Leo, de León Telecom.',
      'Internet rápido para tu zona. ¿Qué necesitas?'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [
        [{ text: '1️⃣ Ver planes' }, { text: '2️⃣ Ya soy cliente' }],
        [{ text: '3️⃣ Hablar con asesor' }, { text: '4️⃣ Reportar falla' }]
      ],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

async function notifyAgentRequest(chatId, userText, location = '') {
  const payload = {
    source: 'telegram',
    chatId,
    location,
    userText,
    timestamp: new Date().toISOString()
  };

  if (AGENT_NOTIFY_WEBHOOK_URL) {
    const response = await fetch(AGENT_NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Agent webhook failed (${response.status}): ${errorText}`);
    }

    return true;
  }

  if (AGENT_NOTIFY_CHAT_ID) {
    await sendTelegramMessage(
      AGENT_NOTIFY_CHAT_ID,
      [
        'Solicitud de agente recibida.',
        `Chat: ${chatId}`,
        location ? `Zona: ${location}` : 'Zona: no indicada',
        `Mensaje: ${userText}`
      ].join('\n')
    );

    return true;
  }

  return false;
}

async function generateAIReply(userText) {
  if (!AI_API_KEY) {
    return null;
  }

  const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText }
      ],
      temperature: 0.4
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content;

  return typeof reply === 'string' ? reply.trim() : null;
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

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'leontelecom-server' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', async (req, res) => {
  const update = req.body || {};
  const message = update.message;

  res.sendStatus(200);

  if (!message || typeof message.text !== 'string') {
    return;
  }

  const chatId = message.chat?.id;
  if (!chatId) {
    return;
  }

  try {
    // Session-aware handling
    const text = String(message.text || '').trim();
    const session = getSession(chatId);

    // Helper to send reply objects (which may include replyMarkup)
    async function sendReplyObject(replyObj) {
      const opts = {};
      if (replyObj.replyMarkup) opts.replyMarkup = replyObj.replyMarkup;
      await sendTelegramMessage(chatId, replyObj.text, replyObj.mediaUrls || [], opts);
    }

    // Parse simple numeric/menu choices
    function parseMenuChoice(input) {
      const v = normalizeText(input);
      if (/^1$|^1\b|\buno\b|ver planes|planes|paquetes/.test(v)) return 1;
      if (/^2$|^2\b|\bdos\b|ya soy cliente|tengo un plan|soy cliente/.test(v)) return 2;
      if (/^3$|^3\b|\btres\b|hablar con|asesor|agente/.test(v)) return 3;
      if (/^4$|^4\b|\bcuatro\b|reportar|problema|reporte/.test(v)) return 4;
      return null;
    }

    // If we previously showed menu, expect a numeric choice or text
    if (session.state === 'awaiting_menu_choice') {
      const choice = parseMenuChoice(text);
      if (choice === 1) {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }

      if (choice === 2) {
        setSession(chatId, { state: 'awaiting_plan_name', data: {} });
        await sendReplyObject(buildExistingCustomerReply());
        return;
      }

      if (choice === 3) {
        clearSession(chatId);
        const reply = buildAgentReply();
        await sendReplyObject(reply);
        try {
          await notifyAgentRequest(chatId, text, detectLocation(text));
        } catch (notifyError) {
          console.error('Agent notification error:', notifyError.message);
        }
        return;
      }

      if (choice === 4) {
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }

      // If no valid choice, re-send menu/fallback
      await sendReplyObject(buildFallbackReply(text));
      return;
    }

    // If awaiting installation day
    if (session.state === 'awaiting_installation_day') {
      const installationData = session.data || {};
      setSession(chatId, { state: 'awaiting_installation_name', data: { ...installationData, day: text } });
      await sendTelegramMessage(chatId, '¿A qué nombre va la instalación?');
      return;
    }

    // If awaiting installation name
    if (session.state === 'awaiting_installation_name') {
      const installationData = session.data || {};
      setSession(chatId, { state: 'awaiting_installation_address', data: { ...installationData, name: text } });
      await sendTelegramMessage(chatId, '¿Cuál es la dirección donde se hará la instalación?');
      return;
    }

    // If awaiting installation address
    if (session.state === 'awaiting_installation_address') {
      const installationData = session.data || {};
      const fullDetails = {
        ...installationData,
        address: text,
        timestamp: new Date().toISOString()
      };
      clearSession(chatId);
      
      // Notify agent with full details
      try {
        await notifyAgentRequest(chatId, [
          `SOLICITUD DE INSTALACIÓN`,
          `Día propuesto: ${installationData.day}`,
          `Nombre: ${installationData.name}`,
          `Dirección: ${text}`,
          `Ubicación: ${installationData.location}`,
          `Observaciones: ${installationData.initialRequest || 'Sin detalles adicionales'}`
        ].join('\n'), installationData.location);
      } catch (notifyError) {
        console.error('Agent notification error:', notifyError.message);
      }
      
      await sendTelegramMessage(chatId, [
        '✅ Perfecto. Registro tu solicitud con los datos:',
        `📅 Día propuesto: ${installationData.day}`,
        `👤 Nombre: ${installationData.name}`,
        `📍 Dirección: ${text}`,
        '',
        '⏳ Un asesor revisará tu solicitud y te contactará en el chat para confirmar el día exacto y los detalles finales.',
        'Mantén el chat abierto para que no te pierdan el contacto. 📱'
      ].join('\n'));
      return;
    }

    // If awaiting location from user
    if (session.state === 'awaiting_location') {
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_household_size', data: { location } });
        const reply = buildPlanReplyForLocation(location);
        await sendReplyObject(reply);
        await sendTelegramMessage(chatId, 'Si quieres una recomendación, dime cuántas personas usan internet en tu casa.');
        return;
      }

      // If user replied something vague, ask to pick from listed zones
      await sendReplyObject({
        text: 'No reconozco la colonia indicada. Por favor elige una de estas zonas o escríbela exactamente: Huitzo, Telixtlahuaca o Suchilquitongo.',
        mediaUrls: [],
        replyMarkup: { keyboard: [[{ text: 'Huitzo' }, { text: 'Telixtlahuaca' }, { text: 'Suchilquitongo' }]], one_time_keyboard: true, resize_keyboard: true }
      });
      return;
    }

    // If awaiting household size for a plan recommendation
    if (session.state === 'awaiting_household_size') {
      const householdSize = parseHouseholdSize(text);
      const location = session.data?.location || detectLocation(text);

      if (householdSize && location) {
        setSession(chatId, { state: 'awaiting_recommendation_followup', data: { location, householdSize } });
        const recommendation = await generateNaturalPlanRecommendationReply({ location, householdSize });
        await sendTelegramMessage(chatId, recommendation.text, recommendation.mediaUrls || []);
        await sendTelegramMessage(chatId, 'Si quieres, dime qué necesitas y te lo explico rápido.');
        return;
      }

      const fallbackLocation = location || session.data?.location;
      if (fallbackLocation) {
        await sendTelegramMessage(chatId, `Dime cuántas personas viven en tu casa para recomendarte mejor el plan de ${fallbackLocation}. Por ejemplo: 4, 6 o 10.`);
        return;
      }

      await sendReplyObject(buildMenuReply());
      return;
    }

    // If we already recommended a plan, keep the context alive for short follow-ups.
    if (session.state === 'awaiting_recommendation_followup') {
      // If user asked for installation, start multi-step process
      if (isInstallationRequest(text)) {
        setSession(chatId, { state: 'awaiting_installation_day', data: { location: session.data?.location, initialRequest: text, householdSize: session.data?.householdSize } });
        await sendTelegramMessage(chatId, '📅 ¿Qué día tienes disponibilidad para la instalación? (Ej: mañana, el jueves, el 30 de mayo)\n\n(Nota: Será a acordar con un asesor)');
        return;
      }

      const context = session.data || {};
      if (context.location && context.householdSize) {
        const reply = await generateFollowupRecommendationReply(context, text);
        // If AI reply looks like a generic greeting only, fallback to a short message
        const sanitized = (reply && reply.text) ? reply.text : String(reply || '');
        if (/^\s*(¡?hola\b|me alegra|gracias|estoy feliz)/i.test(sanitized)) {
          await sendTelegramMessage(chatId, 'Te confirmo la recomendación. ¿Quieres que programe un contacto con un asesor?');
          return;
        }

        await sendTelegramMessage(chatId, sanitized, reply.mediaUrls || []);
        return;
      }

      clearSession(chatId);
      await sendReplyObject(buildMenuReply());
      return;
    }

    // If awaiting plan name (existing customer)
    if (session.state === 'awaiting_plan_name') {
      // Use the provided text as plan identifier and ask what they need
      setSession(chatId, { state: 'awaiting_plan_issue', data: { plan: text } });
      await sendTelegramMessage(chatId, `Gracias. Indica en qué necesitas ayuda con el plan "${text}": facturación, velocidad, falla, o cambio de plan.`);
      return;
    }

    // If awaiting plan issue details
    if (session.state === 'awaiting_plan_issue') {
      const plan = session.data?.plan || 'tu plan';
      clearSession(chatId);
      await sendTelegramMessage(chatId, `Recibido sobre ${plan}. He registrado tu consulta: "${text}". Un agente podrá revisarla y te contactará si es necesario.`);
      try {
        await notifyAgentRequest(chatId, `Cliente: ${plan} - ${text}`, detectLocation(text));
      } catch (notifyError) {
        console.error('Agent notification error:', notifyError.message);
      }
      return;
    }

    // If awaiting report description
    if (session.state === 'awaiting_report') {
      clearSession(chatId);
      await sendTelegramMessage(chatId, 'Gracias por el reporte. Lo he registrado y un agente lo revisará.');
      try {
        await notifyAgentRequest(chatId, `Reporte de problema: ${text}`, detectLocation(text));
      } catch (notifyError) {
        console.error('Agent notification error:', notifyError.message);
      }
      return;
    }

    // Default: no session state — use intent resolution, but always lock into menu for unclear text.
    if (isGreetingMessage(message.text)) {
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
      await sendReplyObject(buildMenuReply());
      return;
    }

    if (isPlanRequest(message.text) && !detectLocation(message.text)) {
      setSession(chatId, { state: 'awaiting_location', data: {} });
    }

    const hasDirectIntent = isPlanRequest(message.text) || isCoverageRequest(message.text) || isTechnicalIssue(message.text) || isAgentRequest(message.text) || isExistingCustomer(message.text) || isReportRequest(message.text);

    if (!hasDirectIntent) {
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
      await sendReplyObject(buildMenuReply());
      return;
    }

    const reply = await generateReply(message.text);

    if (reply.replyMarkup) {
      await sendTelegramMessage(chatId, reply.text, reply.mediaUrls || [], { replyMarkup: reply.replyMarkup });
    } else {
      await sendTelegramMessage(chatId, reply.text, reply.mediaUrls || []);
    }

    // If user explicitly asks for an agent outside the menu flow
    if (isAgentRequest(message.text)) {
      try {
        await notifyAgentRequest(chatId, message.text, detectLocation(message.text));
      } catch (notifyError) {
        console.error('Agent notification error:', notifyError.message);
      }
    }
  } catch (error) {
    console.error('Webhook handling error:', error.message);
    try {
      await sendTelegramMessage(chatId, 'Tu mensaje llegó, pero hubo un error al procesarlo. Intenta de nuevo en unos segundos.');
    } catch (sendError) {
      console.error('Fallback Telegram send error:', sendError.message);
    }
  }
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`León Telecom server listening on port ${port}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
});