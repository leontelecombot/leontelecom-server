require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json());

const SYSTEM_PROMPT = [
  'Eres el asistente virtual de León Telecom.',
  'Responde siempre en español, con tono claro, breve y útil.',
  'Ayuda con planes, cobertura, soporte técnico y pasos de contacto.',
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
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal)$/i.test(value);
}

function isPlanListRequest(text) {
  const value = normalizeText(text);
  return /\b(todos los planes|planes|paquetes|precios|tarifas|internet|wifi|wifis|servicio)\b/.test(value);
}

function buildPlanLines(plans) {
  return plans.map((plan) => `- ${plan.name}: ${plan.speed} → ${plan.price}`).join('\n');
}

function buildLocationPrompt() {
  return {
    text: [
      'Te puedo mostrar los planes según tu zona.',
      'Dime dónde vives: Huitzo, Telixtlahuaca o Suchilquitongo.'
    ].join(' '),
    mediaUrls: []
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

function buildPlanReply(text) {
  const location = detectLocation(text);
  const value = normalizeText(text);

  if (location) {
    return buildPlanReplyForLocation(location);
  }

  if (/\bhuitzo\b/.test(value) || /\btelixtlahuaca\b/.test(value) || /\bsuchilquitongo\b/.test(value)) {
    return buildLocationPrompt();
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

function buildGreetingReply(text) {
  const replies = [
    'Hola, soy Leo, tu asistente de León Telecom. Dime si vives en Huitzo, Telixtlahuaca o Suchilquitongo y te muestro los planes.',
    '¡Hola! Estoy listo para ayudarte con planes, cobertura o soporte. Solo dime tu zona: Huitzo, Telixtlahuaca o Suchilquitongo.',
    'Hola, te ayudo ahorita. Dime en qué zona vives y te enseño los planes correctos con fotos.'
  ];

  const normalized = normalizeText(text);
  const seed = normalized.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return {
    text: replies[seed % replies.length],
    mediaUrls: []
  };
}

function buildFallbackReply(text) {
  return {
    text: [
      'Hola, soy el asistente de León Telecom.',
      'Dime si vives en Huitzo, Telixtlahuaca o Suchilquitongo y te muestro los planes.',
      'También puedes pedir hablar con un agente.'
    ].join(' '),
    mediaUrls: []
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
  const location = detectLocation(userText);

  if (isAgentRequest(userText)) {
    return buildAgentReply();
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

  try {
    const aiReply = await generateAIReply(userText);
    if (aiReply) {
      return { text: aiReply, mediaUrls: [] };
    }
  } catch (error) {
    console.error('AI reply error:', error.message);
  }

  if (isGreetingMessage(userText)) {
    return buildGreetingReply(userText);
  }

  return buildFallbackReply(userText);
}

async function sendTelegramMessage(chatId, text, mediaUrls = []) {
  if (!TELEGRAM_API_BASE) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }

  for (const mediaUrl of mediaUrls) {
    const photoResponse = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: mediaUrl })
    });

    if (!photoResponse.ok) {
      const errorText = await photoResponse.text();
      throw new Error(`Telegram sendPhoto failed (${photoResponse.status}): ${errorText}`);
    }
  }

  const messageResponse = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      allow_sending_without_reply: true
    })
  });

  const rawMessageText = await messageResponse.text();
  let messagePayload = null;

  try {
    messagePayload = rawMessageText ? JSON.parse(rawMessageText) : null;
  } catch (_error) {
    messagePayload = null;
  }

  if (!messageResponse.ok || !messagePayload?.ok) {
    throw new Error(`Telegram sendMessage failed (${messageResponse.status}): ${rawMessageText}`);
  }

  const sentMessageId = messagePayload?.result?.message_id;
  console.log(`[Telegram send ok] chat=${chatId} message_id=${sentMessageId || 'unknown'}`);

  return messagePayload;
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
    const reply = await generateReply(message.text);
    await sendTelegramMessage(chatId, reply.text, reply.mediaUrls);

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