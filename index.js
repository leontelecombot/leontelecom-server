require('dotenv').config();
const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CONFIGURATION
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Diagnostic: print whether Twilio credentials are present (masked)
const _sid = process.env.TWILIO_ACCOUNT_SID || '';
const _tok = process.env.TWILIO_AUTH_TOKEN || '';
console.log('Twilio SID set:', Boolean(_sid));
console.log('Twilio Auth token length:', _tok.length ? `${_tok.length} chars` : 'not set');

let AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
if (AI_PROVIDER === 'openai') AI_PROVIDER = 'openai-compatible';
const AI_MODEL = process.env.AI_MODEL || 'llama3.1';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
const DEMO_MODE = (process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';
const LEON_CONTACT_NUMBER = process.env.LEON_CONTACT_NUMBER || '9511603125';
const FIBER_PLAN_MEDIA_URL = process.env.FIBER_PLAN_MEDIA_URL || '';
const WIRELESS_PLAN_MEDIA_URL = process.env.WIRELESS_PLAN_MEDIA_URL || '';

const FIBER_COVERAGE = ['Huitzo'];
const WIRELESS_COVERAGE = ['Telixtlahuaca', 'Suchilquitongo'];
const WIRELESS_COVERAGE_NOTE = 'En Telixtlahuaca y Suchilquitongo el servicio es por antena inalambrica.';

const FIBER_PLANS = [
  { name: 'Lite', speed: '30 Mbps', price: '$289/mo' },
  { name: 'Basic', speed: '80 Mbps', price: '$320/mo' },
  { name: 'Medium', speed: '150 Mbps', price: '$440/mo' },
  { name: 'Advanced', speed: '200 Mbps', price: '$560/mo' },
  { name: 'Ultra', speed: '300 Mbps', price: '$680/mo' },
];

const WIRELESS_PLANS = [
  { speed: '15 Mbps', price: '$290/mo' },
  { speed: '20 Mbps', price: '$340/mo' },
  { speed: '30 Mbps', price: '$440/mo' },
];

// BOT PERSONA
const SYSTEM_PROMPT = `
Eres "Leo", el asistente amigable de León Telecom 🚀
Ayudas a clientes en Oaxaca con internet de fibra óptica (en Huitzo) e inalámbrico con antena (en Telixtlahuaca y Suchilquitongo).

📋 PLANES DISPONIBLES:

🔌 FIBRA ÓPTICA (en Huitzo):
  • Lite: 30 Mbps → $289/mes
  • Basic: 80 Mbps → $320/mes
  • Medium: 150 Mbps → $440/mes
  • Advanced: 200 Mbps → $560/mes
  • Ultra: 300 Mbps → $680/mes

📡 INALÁMBRICO CON ANTENA (Telixtlahuaca, Suchilquitongo):
  • 15 Mbps → $290/mes
  • 20 Mbps → $340/mes
  • 30 Mbps → $440/mes

✨ PROMOCIÓN: Nuevos clientes reciben el doble de velocidad el primer mes.

🏘️ COBERTURA:
  • Huitzo: fibra óptica ✓
  • Telixtlahuaca: antena inalámbrica ✓
  • Suchilquitongo: antena inalámbrica ✓

📞 CONTACTO DIRECTO: ${LEON_CONTACT_NUMBER}

🎯 INSTRUCCIONES:
- Eres amable, natural y conversacional. Habla como un amigo.
- Responde breve y directo (máximo 3-4 líneas). Usa máximo 1-2 emojis por mensaje.
- Cuando pregunten por planes, sugiere basándote en: cuántas personas, qué usan internet, dónde viven.
- Cuando pregunten sobre cobertura, confirma su localidad y ofrece la opción disponible.
- Si reportan problemas técnicos, pide nombre y dirección. Promete contacto en 2 horas (lun-sab, 8am-8pm).
- NUNCA inventes planes o precios fuera de la lista.
- Sé proactivo: haz preguntas abiertas para entender mejor sus necesidades.
- Si no sabes algo específico, ofrece pasar al equipo de ventas: ${LEON_CONTACT_NUMBER}.
- Responde en español de México (informal, amable).
`.trim();

// PER-USER HISTORY IN MEMORY
const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }

  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });

  if (history.length > 20) {
    history.splice(0, 2);
  }
}

function buildConversation(phone) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(phone).map(({ role, content }) => ({ role, content })),
  ];
}

function isPlanRequest(message) {
  return /\b(plan|planes|paquete|paquetes|precio|precios|tarifa|tarifas|costo|costos|paquetes?|promocion|promoci[oó]n)\b/i.test(message);
}

function isCoverageRequest(message) {
  return /\b(cobertura|cubre|zona|llega|disponible|servicio|huitzo|telixtlahuaca|suchil|fibra|antena)\b/i.test(message);
}

function isTechnicalIssue(message) {
  return /\b(falla|sin internet|caido|ca[ií]do|lento|servicio|no sirve|averia|aver[ií]a)\b/i.test(message);
}

function buildPlanReply() {
  return [
    'Claro, estos son los planes de Leon Telecom:',
    `Fibra: ${FIBER_PLANS.map(plan => `${plan.name} ${plan.speed} ${plan.price}`).join(' | ')}`,
    `Inalambrico: ${WIRELESS_PLANS.map(plan => `${plan.speed} ${plan.price}`).join(' | ')}`,
    `Si me dices cuantas personas son y tu localidad, te recomiendo el ideal.`,
  ].join('\n');
}

function buildCoverageReply() {
  return [
    `Tenemos fibra optica en ${FIBER_COVERAGE.join(', ')}.`,
    `En ${WIRELESS_COVERAGE.join(', ')} el servicio es por antena inalambrica.`,
    `Si me dices tu localidad exacta, te confirmo el servicio y te paso al ${LEON_CONTACT_NUMBER}.`,
  ].join('\n');
}

function buildTechnicalReply() {
  return [
    'Lamento la falla. Pasame tu nombre y direccion completa y lo revisamos.',
    'Un tecnico te contactara en maximo 2 horas en horario lun-sab 8am-8pm.',
    `Si quieres, tambien te atienden por WhatsApp al ${LEON_CONTACT_NUMBER}.`,
  ].join('\n');
}

function buildDefaultReply() {
  return [
    'Hola, soy Leo de Leon Telecom.',
    'Te puedo ayudar con planes, cobertura, contratacion o reportes tecnicos.',
    'Huitzo tiene fibra optica; Telixtlahuaca y Suchil van por antena inalambrica.',
  ].join('\n');
}

function getPlanMediaUrls() {
  return [FIBER_PLAN_MEDIA_URL, WIRELESS_PLAN_MEDIA_URL].filter(Boolean);
}

async function sendWhatsAppMessage(to, body, mediaUrls = []) {
  const payload = {
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to,
    body,
  };

  if (mediaUrls.length > 0) {
    payload.mediaUrl = mediaUrls;
  }

  return twilioClient.messages.create(payload);
}

function extractTextFromResponse(response) {
  if (!response) {
    return '';
  }

  if (typeof response === 'string') {
    return response.trim();
  }

  if (typeof response.message?.content === 'string') {
    return response.message.content.trim();
  }

  const choiceText = response.choices?.[0]?.message?.content;
  if (typeof choiceText === 'string') {
    return choiceText.trim();
  }

  if (Array.isArray(response.content)) {
    return response.content
      .map(block => (typeof block?.text === 'string' ? block.text : ''))
      .join('')
      .trim();
  }

  return '';
}

function buildFallbackReply(message) {
  if (isTechnicalIssue(message)) {
    return buildTechnicalReply();
  }

  if (isCoverageRequest(message)) {
    return buildCoverageReply();
  }

  if (isPlanRequest(message)) {
    return buildPlanReply();
  }

  return buildDefaultReply();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function generateReply(phone) {
  const messages = buildConversation(phone);

  if (AI_PROVIDER === 'ollama') {
    const response = await fetchWithTimeout(`${AI_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        stream: false,
        options: {
          temperature: 0.4,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama responded ${response.status}`);
    }

    const data = await response.json();
    const reply = extractTextFromResponse(data);

    if (!reply) {
      throw new Error('Ollama did not return text');
    }

    return reply;
  }

  if (AI_PROVIDER === 'openai-compatible') {
    const response = await fetchWithTimeout(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      throw new Error(`Compatible API responded ${response.status}`);
    }

    const data = await response.json();
    const reply = extractTextFromResponse(data);

    if (!reply) {
      throw new Error('Compatible API did not return text');
    }

    return reply;
  }

  throw new Error(`Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
}

function shouldUseFallback() {
  return DEMO_MODE;
}

function buildResponseForMessage(message) {
  if (isTechnicalIssue(message)) {
    return {
      body: buildTechnicalReply(),
      mediaUrls: [],
    };
  }

  if (isCoverageRequest(message)) {
    return {
      body: buildCoverageReply(),
      mediaUrls: [],
    };
  }

  if (isPlanRequest(message)) {
    return {
      body: buildPlanReply(),
      mediaUrls: getPlanMediaUrls(),
    };
  }

  return {
    body: null,
    mediaUrls: [],
  };
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'leontelecom-bot-server',
    provider: AI_PROVIDER,
    model: AI_MODEL,
    whatsapp: Boolean(process.env.TWILIO_WHATSAPP_NUMBER),
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// TWILIO WEBHOOK
app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const message = req.body.Body?.trim();

  console.log(`[${from}] ${message}`);

  if (!message) {
    return res.sendStatus(200);
  }

  addToHistory(from, 'user', message);

  let reply;
  let mediaUrls = [];

  try {
    // Always try AI first, only use scripted fallback if AI fails
    try {
      reply = await generateReply(from);
      // Attach media if it's a plan request (even for AI-generated reply)
      if (isPlanRequest(message)) {
        mediaUrls = getPlanMediaUrls();
      }
    } catch (aiError) {
      console.error('AI error, using fallback:', aiError.message);
      reply = buildFallbackReply(message);
      mediaUrls = isPlanRequest(message) ? getPlanMediaUrls() : [];
    }
  } catch (error) {
    console.error('Error generating reply:', error.message);
    return res.sendStatus(500);
  }

  addToHistory(from, 'assistant', reply);

  try {
    await sendWhatsAppMessage(from, reply, mediaUrls);

    console.log(`[Bot -> ${from}] ${reply}`);
    if (mediaUrls.length > 0) {
      console.log(`  [with ${mediaUrls.length} image(s)]`);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Error sending Twilio message:', error);
    // Still return 200 to acknowledge the webhook (don't retry)
    return res.sendStatus(200);
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook ready at http://localhost:${PORT}/webhook`);
  console.log(`AI provider: ${AI_PROVIDER} (${AI_MODEL})`);
});
