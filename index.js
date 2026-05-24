require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

const SYSTEM_PROMPT = [
  'Eres el asistente virtual de León Telecom.',
  'Responde siempre en español, con tono claro, breve y útil.',
  'Ayuda solo con internet, cobertura, planes y pasos de contacto.',
  'Nunca menciones servicios distintos al internet que no ofrecemos.',
  'Si no tienes un dato confirmado, dilo de forma transparente y ofrece escalarlo.'
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
      'Te puedo mostrar los planes según tu zona.',
      'Elige una opción: Huitzo, Telixtlahuaca o Suchilquitongo.'
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
        'Estos son nuestros planes de fibra óptica para Huitzo:',
        buildPlanLines(FIBER_PLANS),
        'Si quieres, te recomiendo el mejor según cuántas personas usan internet en tu casa.'
      ].join('\n'),
      mediaUrls: FIBER_PLAN_MEDIA_URL ? [FIBER_PLAN_MEDIA_URL] : []
    };
  }

  if (location === LOCATIONS.telixtlahuaca || location === LOCATIONS.suchilquitongo) {
    return {
      text: [
        `Estos son nuestros planes de internet inalámbrico para ${location}:`,
        buildPlanLines(WIRELESS_PLANS),
        'Si quieres, te recomiendo el mejor según cuántas personas usan internet en tu casa.'
      ].join('\n'),
      mediaUrls: WIRELESS_PLAN_MEDIA_URL ? [WIRELESS_PLAN_MEDIA_URL] : []
    };
  }

  return buildLocationPrompt();
}

function buildAgentReply() {
  return {
    text: [
      'Claro, te paso con un agente.',
      'En cuanto esté disponible, te contactamos por aquí.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildExistingCustomerReply() {
  return {
    text: [
      'Perfecto — eres cliente. ¿Cuál es tu plan actual?',
      'Dime el nombre del plan o copia el mensaje que te llegó y te ayudo con facturación, velocidad o fallas.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildReportPrompt() {
  return {
    text: [
      'Entendido. Por favor descríbeme brevemente el problema que quieres reportar (por ejemplo: sin internet, muy lento, intermitente).',
      'Si quieres, puedes incluir horarios o capturas.'
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
      'Dime si vives en Huitzo, Telixtlahuaca o Suchilquitongo y te digo qué servicio te toca.',
      'También puedes pedir hablar con un agente si quieres que te atienda una persona.'
    ].join(' '),
    mediaUrls: []
  };
}

function buildTechnicalReply(text) {
  return {
    text: [
      'Vamos a revisarlo. Primero reinicia tu router o equipo y espera 2 minutos.',
      'Si sigue igual, dime si el problema es sin internet, lento o intermitente y te doy el siguiente paso.'
    ].join(' '),
    mediaUrls: []
  };
}

async function generateNaturalPlanRecommendationReply(context) {
  const baseRecommendation = context.location === LOCATIONS.huitzo
    ? chooseRecommendedFiberPlan(context.householdSize)
    : chooseRecommendedWirelessPlan(context.householdSize);

  const fallbackText = context.location === LOCATIONS.huitzo
    ? `Para ${context.householdSize} personas en ${context.location}, te recomiendo ${baseRecommendation.name} (${baseRecommendation.speed}) por ${baseRecommendation.price}. Si quieres, te digo si te conviene subir o bajar según el uso.`
    : `Para ${context.householdSize} personas en ${context.location}, te recomiendo ${baseRecommendation.speed} por ${baseRecommendation.price}. Si quieres, te digo si te conviene subir o bajar según el uso.`;

  if (!AI_API_KEY) {
    return {
      text: fallbackText,
      mediaUrls: []
    };
  }

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
              'Eres el asistente de León Telecom.',
              'Escribe una recomendación breve, natural y específica en máximo dos frases.',
              'No inventes planes ni precios.',
              'Usa solo la información proporcionada.',
              'Da una recomendación concreta y, si hace falta, agrega una sola pregunta de seguimiento simple.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              `Zona: ${context.location}`,
              `Personas en la casa: ${context.householdSize}`,
              `Tipo de servicio: ${context.location === LOCATIONS.huitzo ? 'fibra óptica' : 'internet inalámbrico'}`,
              `Plan sugerido: ${baseRecommendation.name || baseRecommendation.speed}`,
              `Velocidad: ${baseRecommendation.speed}`,
              `Precio: ${baseRecommendation.price}`,
              'Responde como si fueras un asesor humano, natural, seguro y breve. No des un discurso; solo una recomendación corta con una razón simple.'
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
      'No entendí bien. Puedes elegir una de estas opciones:',
      '1) Ver planes',
      '2) Ya soy cliente (dime tu plan)',
      '3) Hablar con un asesor',
      '4) Reportar un problema'
    ].join('\n'),
    mediaUrls: [],
    replyMarkup: {
      keyboard: [[{ text: '1) Ver planes' }, { text: '2) Ya soy cliente (dime tu plan)' }], [{ text: '3) Hablar con un asesor' }, { text: '4) Reportar un problema' }]],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
}

function buildMenuReply() {
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
        clearSession(chatId);
        const recommendation = await generateNaturalPlanRecommendationReply({ location, householdSize });
        await sendTelegramMessage(chatId, recommendation.text, recommendation.mediaUrls || []);
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