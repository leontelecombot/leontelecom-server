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

    // ===== INTENT INTERRUPTION LAYER =====
    // At ANY point in the conversation, detect if user wants to switch contexts
    // This takes priority over the current session state
    const detectedChoice = parseMenuChoice(text);
    if (session.state && session.state !== 'awaiting_menu_choice' && detectedChoice !== null) {
      // User is mid-flow but explicitly chose a menu option
      if (detectedChoice === 1) {
        // User wants to see plans
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }
      if (detectedChoice === 2) {
        // User is existing customer
        setSession(chatId, { state: 'awaiting_plan_name', data: {} });
        await sendReplyObject(buildExistingCustomerReply());
        return;
      }
      if (detectedChoice === 3) {
        // User wants to talk to an agent
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendTelegramMessage(chatId, '¿Cuál es tu nombre?');
        return;
      }
      if (detectedChoice === 4) {
        // User wants to report a problem
        setSession(chatId, { state: 'awaiting_report', data: {} });
        await sendReplyObject(buildReportPrompt());
        return;
      }
    }

    // Also detect intents by keyword, anywhere in the flow
    if (session.state && session.state !== 'awaiting_menu_choice') {
      if (isPlanRequest(text) && !session.state.includes('installation') && !session.state.includes('plan')) {
        setSession(chatId, { state: 'awaiting_location', data: {} });
        await sendReplyObject(buildLocationPrompt());
        return;
      }
      if (isAgentRequest(text) && session.state !== 'awaiting_agent_name' && session.state !== 'awaiting_agent_neighborhood') {
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendTelegramMessage(chatId, '¿Cuál es tu nombre?');
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
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendTelegramMessage(chatId, '¿Cuál es tu nombre?');
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
      const formattedDay = parseDayToDate(text);
      setSession(chatId, { state: 'awaiting_installation_name', data: { ...installationData, day: formattedDay } });
      await sendTelegramMessage(chatId, '¿A qué nombre va la instalación?');
      return;
    }

    // If awaiting installation name
    if (session.state === 'awaiting_installation_name') {
      const installationData = session.data || {};
      setSession(chatId, { state: 'awaiting_installation_address', data: { ...installationData, name: text } });
      const location = installationData.location || 'tu zona';
      await sendTelegramMessage(chatId, `¿Cuál es la dirección de la instalación en ${location}?`);
      return;
    }

    // If awaiting installation address
    if (session.state === 'awaiting_installation_address') {
      const installationData = session.data || {};
      setSession(chatId, { state: 'awaiting_installation_neighborhood', data: { ...installationData, address: text } });
      await sendTelegramMessage(chatId, '¿Cuál es tu colonia, barrio o sección?');
      return;
    }

    // If awaiting installation neighborhood
    if (session.state === 'awaiting_installation_neighborhood') {
      const installationData = session.data || {};
      const location = installationData.location || 'Huitzo';
      const neighborhoodMatch = findNeighborhood(text, location);
      
      if (neighborhoodMatch) {
        setSession(chatId, { state: 'awaiting_installation_location_confirm', data: { ...installationData, neighborhood: neighborhoodMatch.name } });
        await sendTelegramMessage(chatId, `¿Es correcto que la instalación es en ${neighborhoodMatch.name} ${neighborhoodMatch.location}?`);
        return;
      }

      // If not found, ask again
      await sendTelegramMessage(chatId, `No encontré tu colonia/barrio en ${location}. Intenta de nuevo o escribe el nombre más claramente.`);
      return;
    }

    // If awaiting location confirmation
    if (session.state === 'awaiting_installation_location_confirm') {
      const confirmYes = normalizeText(text).match(/\b(si|sí|yes|claro|ok|okay|correcto|verdad|sale)\b/);
      const confirmNo = normalizeText(text).match(/\b(no|nope|nah|incorrecto)\b/);
      
      if (confirmYes) {
        const installationData = session.data || {};
        clearSession(chatId);
        
        // Notify agent with full details including neighborhood
        try {
          await notifyAgentRequest(chatId, [
            `SOLICITUD DE INSTALACIÓN`,
            `Día propuesto: ${installationData.day}`,
            `Nombre: ${installationData.name}`,
            `Dirección: ${installationData.address}`,
            `Barrio/Colonia: ${installationData.neighborhood}`,
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
          `📍 Dirección: ${installationData.address}`,
          `🏘️ Barrio: ${installationData.neighborhood}`,
          '',
          `⏳ En un momento un asesor se va a poner en contacto con ${installationData.name} para confirmar todos los detalles. 📱`
        ].join('\n'));
        return;
      }
      
      if (confirmNo) {
        // Go back to location selection and restart the flow
        const locationData = session.data || {};
        setSession(chatId, { state: 'awaiting_location', data: { selectedPlan: locationData.selectedPlan, selectedSpeed: locationData.selectedSpeed, selectedPrice: locationData.selectedPrice } });
        await sendTelegramMessage(chatId, 'Entendido. Vamos a empezar de nuevo. ¿En dónde vives?', null, buildLocationKeyboard());
        return;
      }

      // If unclear, ask again
      await sendTelegramMessage(chatId, '¿Es correcto o no? Responde sí o no.');
      return;
    }

    // If awaiting location from user
    if (session.state === 'awaiting_location') {
      const location = detectLocation(text);
      if (location) {
        setSession(chatId, { state: 'awaiting_plan_selection', data: { location } });
        const reply = buildPlanReplyForLocation(location);
        await sendReplyObject(reply);
        await sendTelegramMessage(chatId, '¿Cuál plan te gustaría?');
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

    // If awaiting plan selection
    if (session.state === 'awaiting_plan_selection') {
      const location = session.data?.location;
      const plans = location === LOCATIONS.huitzo ? FIBER_PLANS : WIRELESS_PLANS;
      const selectedPlan = plans.find(p => normalizeText(text).includes(normalizeText(p.name)) || normalizeText(text).includes(normalizeText(p.speed)));
      
      if (selectedPlan) {
        setSession(chatId, { state: 'awaiting_orientation_choice', data: { ...session.data, selectedPlan: selectedPlan.name, selectedSpeed: selectedPlan.speed, selectedPrice: selectedPlan.price } });
        await sendTelegramMessage(chatId, `Entendido, el plan ${selectedPlan.name} (${selectedPlan.speed} → ${selectedPlan.price}). ¿Quieres que te dé orientación sobre por qué este plan es una buena opción?`);
        return;
      }

      // If plan not recognized, ask again
      await sendTelegramMessage(chatId, 'No reconozco el plan. Por favor elige uno de los planes mencionados (Lite, Basic, Medium, Advanced o Ultra según tu zona).');
      return;
    }

    // If awaiting orientation choice
    if (session.state === 'awaiting_orientation_choice') {
      const wantsOrientation = normalizeText(text).match(/\b(si|sí|yes|claro|dale|ok|okay|adelante|ok dale|quiero)\b/);
      const rejectsOrientation = normalizeText(text).match(/\b(no|nope|nah|no quiero|no gracias|sin orientacion|sin orientación)\b/);
      
      if (wantsOrientation) {
        const location = session.data?.location;
        const selectedPlan = session.data?.selectedPlan;
        const orientation = `El ${selectedPlan} es ideal para ${location} porque ofrece excelente velocidad y estabilidad. Te permitirá navegar, ver películas y trabajar sin problemas.`;
        setSession(chatId, { state: 'awaiting_installation_confirmation', data: session.data });
        await sendTelegramMessage(chatId, orientation);
        await sendTelegramMessage(chatId, '¿Quieres agendar la instalación de este plan?');
        return;
      }
      
      if (rejectsOrientation) {
        setSession(chatId, { state: 'awaiting_installation_confirmation', data: session.data });
        await sendTelegramMessage(chatId, `Perfecto. Tu elección es ${session.data?.selectedPlan} (${session.data?.selectedSpeed} → ${session.data?.selectedPrice}). ¿Quieres agendar la instalación?`);
        return;
      }

      // If unclear, ask again
      await sendTelegramMessage(chatId, '¿Quieres orientación sí o no?');
      return;
    }

    // If awaiting installation confirmation
    if (session.state === 'awaiting_installation_confirmation') {
      const wantsInstallation = normalizeText(text).match(/\b(si|sí|yes|claro|dale|ok|okay|adelante|ok dale|instalar|quiero|agend|agendar)\b/);
      const rejectsInstallation = normalizeText(text).match(/\b(no|nope|nah|no quiero|no gracias|luego)\b/);
      
      if (wantsInstallation) {
        setSession(chatId, { state: 'awaiting_installation_day', data: { ...session.data, initialRequest: text } });
        await sendTelegramMessage(chatId, '📅 ¿Qué día tienes disponibilidad para la instalación? (Ej: mañana, el jueves, el 30 de mayo)\n\n(Nota: Será a acordar con un asesor)');
        return;
      }
      
      if (rejectsInstallation) {
        clearSession(chatId);
        await sendTelegramMessage(chatId, 'Sin problema. Si en otro momento quieres agendar, me contactas. ¡Estamos aquí para ayudarte! 📱');
        return;
      }

      // If unclear, ask again
      await sendTelegramMessage(chatId, '¿Quieres agendar ahora o prefieres hacerlo después?');
      return;
    }

    // If we already recommended a plan, keep the context alive for short follow-ups.
    if (session.state === 'awaiting_recommendation_followup') {
      // Check for mid-conversation agent request
      if (isAgentRequest(text)) {
        setSession(chatId, { state: 'awaiting_agent_name', data: { ...session.data, initialRequest: text } });
        await sendTelegramMessage(chatId, '¿Cuál es tu nombre?');
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
      const reportData = { problemDescription: text };
      setSession(chatId, { state: 'awaiting_report_name', data: reportData });
      await sendTelegramMessage(chatId, '¿A qué nombre está el servicio?');
      return;
    }

    // If awaiting report name
    if (session.state === 'awaiting_report_name') {
      const reportData = session.data || {};
      setSession(chatId, { state: 'awaiting_report_address', data: { ...reportData, name: text } });
      await sendTelegramMessage(chatId, '¿Dónde está ubicada la casa de la instalación?');
      return;
    }

    // If awaiting report address
    if (session.state === 'awaiting_report_address') {
      const reportData = session.data || {};
      const location = detectLocation(reportData.problemDescription) || 'Ubicación no especificada';
      setSession(chatId, { state: 'awaiting_report_neighborhood', data: { ...reportData, address: text, location } });
      await sendTelegramMessage(chatId, '¿Cuál es tu colonia, barrio o sección?');
      return;
    }

    // If awaiting report neighborhood
    if (session.state === 'awaiting_report_neighborhood') {
      const reportData = session.data || {};
      const location = reportData.location;
      const neighborhoodMatch = location !== 'Ubicación no especificada' ? findNeighborhood(text, location) : null;
      
      if (neighborhoodMatch) {
        setSession(chatId, { state: 'awaiting_report_location_confirm', data: { ...reportData, neighborhood: neighborhoodMatch.name } });
        await sendTelegramMessage(chatId, `¿Es correcto que el problema es en ${neighborhoodMatch.name} ${neighborhoodMatch.location}?`);
        return;
      }

      // If location is unknown or not found, still accept the neighborhood info
      const fallbackNeighborhood = text;
      setSession(chatId, { state: 'awaiting_report_location_confirm', data: { ...reportData, neighborhood: fallbackNeighborhood } });
      await sendTelegramMessage(chatId, `¿Es correcto? Tu reporte es de ${fallbackNeighborhood}.`);
      return;
    }

    // If awaiting report location confirmation
    if (session.state === 'awaiting_report_location_confirm') {
      const confirmYes = normalizeText(text).match(/\b(si|sí|yes|claro|ok|okay|correcto|verdad|sale)\b/);
      
      if (confirmYes) {
        const reportData = session.data || {};
        clearSession(chatId);
        
        // Notify agent with full details
        try {
          await notifyAgentRequest(chatId, [
            `REPORTE DE PROBLEMA`,
            `Problema: ${reportData.problemDescription}`,
            `Nombre: ${reportData.name}`,
            `Dirección: ${reportData.address}`,
            `Barrio/Colonia: ${reportData.neighborhood}`,
            `Ubicación: ${reportData.location}`
          ].join('\n'), reportData.location);
        } catch (notifyError) {
          console.error('Agent notification error:', notifyError.message);
        }
        
        await sendTelegramMessage(chatId, [
          '✅ Perfecto. He registrado tu reporte:',
          `🔧 Problema: ${reportData.problemDescription}`,
          `👤 Nombre: ${reportData.name}`,
          `📍 Dirección: ${reportData.address}`,
          `🏘️ Barrio: ${reportData.neighborhood}`,
          '',
          `⏳ En un momento un asesor se va a poner en contacto con ${reportData.name} para asistirte. 📱`
        ].join('\n'));
        return;
      }

      // If not confirmed, go back
      setSession(chatId, { state: 'awaiting_report_neighborhood', data: session.data });
      await sendTelegramMessage(chatId, 'Entendido. ¿Cuál es tu colonia, barrio o sección correcta?');
      return;
    }

    // If awaiting agent name (mid-conversation agent request)
    if (session.state === 'awaiting_agent_name') {
      const currentData = session.data || {};
      setSession(chatId, { state: 'awaiting_agent_need', data: { ...currentData, agentName: text } });
      await sendTelegramMessage(chatId, '¿Qué necesitas o qué preguntas tienes?');
      return;
    }

    // If awaiting agent need (mid-conversation agent request)
    if (session.state === 'awaiting_agent_need') {
      const agentData = session.data || {};
      setSession(chatId, { state: 'awaiting_agent_neighborhood', data: { ...agentData, need: text } });
      await sendTelegramMessage(chatId, '¿Cuál es tu colonia, barrio o sección?');
      return;
    }

    // If awaiting agent neighborhood
    if (session.state === 'awaiting_agent_neighborhood') {
      const agentData = session.data || {};
      const location = agentData.location;
      const neighborhoodMatch = location && location !== 'Ubicación no especificada' ? findNeighborhood(text, location) : null;
      
      if (neighborhoodMatch) {
        clearSession(chatId);
        try {
          await notifyAgentRequest(chatId, [
            `SOLICITUD DIRECTA DE ASESOR`,
            `Nombre: ${agentData.agentName}`,
            `Necesidad: ${agentData.need}`,
            `Barrio/Colonia: ${neighborhoodMatch.name}`,
            `Ubicación: ${neighborhoodMatch.location}`,
            `Contexto: ${agentData.initialRequest || 'Sin contexto adicional'}`
          ].join('\n'), location);
        } catch (notifyError) {
          console.error('Agent notification error:', notifyError.message);
        }
        await sendTelegramMessage(chatId, [`✅ Perfecto ${agentData.agentName}.`, `En unos momentos un asesor te atenderá en el chat. 📱`].join('\n'));
        return;
      }

      // If location is unknown, still accept and notify
      clearSession(chatId);
      const fallbackNeighborhood = text;
      try {
        await notifyAgentRequest(chatId, [
          `SOLICITUD DIRECTA DE ASESOR`,
          `Nombre: ${agentData.agentName}`,
          `Necesidad: ${agentData.need}`,
          `Ubicación mencionada: ${fallbackNeighborhood}`,
          `Contexto: ${agentData.initialRequest || 'Sin contexto adicional'}`
        ].join('\n'), location);
      } catch (notifyError) {
        console.error('Agent notification error:', notifyError.message);
      }
      await sendTelegramMessage(chatId, [`✅ Perfecto ${agentData.agentName}.`, `En unos momentos un asesor te atenderá en el chat. 📱`].join('\n'));
      return;
    }

    // Default: no session state — use intent resolution, but always lock into menu for unclear text.
    if (isGreetingMessage(message.text)) {
      setSession(chatId, { state: 'awaiting_menu_choice', data: {} });
      await sendReplyObject(buildMenuReply());
      return;
    }

    if (isPlanRequest(message.text)) {
      const detectedLoc = detectLocation(message.text);
      if (!detectedLoc) {
        setSession(chatId, { state: 'awaiting_location', data: { ...session.data } });
      }
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