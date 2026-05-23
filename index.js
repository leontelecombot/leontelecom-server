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

function isGreetingMessage(text) {
  const value = normalizeText(text).trim();
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal)$/i.test(value);
}

function buildPlanReply(text) {
  const value = normalizeText(text);
  const fiber = /\bfibra\b/.test(value);
  const wireless = /\binalambr|\binalambrica\b|\binternet\s+inalambrico\b/.test(value);

  if (fiber && FIBER_PLAN_MEDIA_URL) {
    return {
      text: 'Te comparto la info de fibra óptica. Si quieres, también te digo cuál te conviene según tu zona.',
      mediaUrls: [FIBER_PLAN_MEDIA_URL]
    };
  }

  if (wireless && WIRELESS_PLAN_MEDIA_URL) {
    return {
      text: 'Te comparto la info de internet inalámbrico. Si me dices tu colonia, te recomiendo la mejor opción.',
      mediaUrls: [WIRELESS_PLAN_MEDIA_URL]
    };
  }

  return {
    text: [
      'Manejamos opciones de internet para distintos tipos de zona.',
      `Si me dices si buscas fibra o inalámbrico y tu colonia, te doy una recomendación más exacta.`,
      `También te puedo ayudar por WhatsApp al ${LEON_CONTACT_NUMBER}.`
    ].join(' '),
    mediaUrls: []
  };
}

function buildCoverageReply(text) {
  return {
    text: [
      'Pásame tu colonia, localidad o referencia y te confirmo si hay cobertura.',
      `Si prefieres, también te atendemos al ${LEON_CONTACT_NUMBER}.`
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
    'Hola, soy Leo, tu asistente de León Telecom. ¿En qué te ayudo hoy?',
    '¡Hola! Estoy listo para ayudarte con planes, cobertura o soporte. Cuéntame qué necesitas.',
    'Hola, ¿buscas información de internet, cobertura o soporte técnico? Te ayudo ahorita.'
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
      'Puedo ayudarte con planes, cobertura y soporte técnico.',
      'Escríbeme qué necesitas y te respondo directo.'
    ].join(' '),
    mediaUrls: []
  };
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
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!messageResponse.ok) {
    const errorText = await messageResponse.text();
    throw new Error(`Telegram sendMessage failed (${messageResponse.status}): ${errorText}`);
  }

  const messagePayload = await messageResponse.json();
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