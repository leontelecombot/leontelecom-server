/**
 * Image Analysis - clasifica la imagen del cliente (comprobante / equipo / emergencia / otro)
 * y extrae datos. Usa Claude Vision (anthropic) o Groq/OpenAI-compatible.
 */

const PROMPT = `Eres el asistente de León Telecom (proveedor de internet, cámaras de seguridad y accesorios en Oaxaca, México). Un cliente envió esta imagen por WhatsApp. Analízala y clasifícala.

Devuelve SOLO un objeto JSON con esta forma exacta:
{
  "tipo": "comprobante" | "equipo" | "emergencia" | "otro",
  "nombre": "nombre de la persona que hizo el pago (SOLO si es comprobante; si no, cadena vacía)",
  "monto": "monto pagado con signo, ej. $500.00 (SOLO comprobante)",
  "banco": "banco u operador si aparece (SOLO comprobante)",
  "fecha": "fecha si aparece",
  "descripcion": "1-2 frases describiendo qué se ve (para equipo/emergencia/otro)",
  "razon": "si algo no se lee o no puedes clasificar, explícalo breve"
}

Guía de clasificación:
- "comprobante": recibo, ticket o captura de una transferencia/pago (SPEI, banco, tienda, OXXO, etc.). Extrae el nombre de quien paga y el monto.
- "equipo": foto de un router, módem, cable, cámara, fuente u otro equipo (posible falla técnica). Describe qué equipo es y qué se ve (luces, daño, etc.).
- "emergencia": foto de incendio, humo, poste o cable caído/quemado, accidente, o algo urgente. Descríbelo.
- "otro": cualquier otra cosa.

Responde SOLO el JSON, sin ningún texto adicional fuera del JSON.`;

async function analyzePaymentReceipt(imageBase64) {
  const AI_PROVIDER = process.env.AI_PROVIDER || 'openai-compatible';
  const AI_API_KEY = process.env.AI_API_KEY || '';

  if (!AI_API_KEY) return { tipo: 'otro', valido: false, razon: 'API key no configurada' };

  try {
    let response;

    if (AI_PROVIDER === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: PROMPT }
            ]
          }]
        })
      });
    } else {
      const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
      response = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.AI_VISION_MODEL || 'llama-3.2-90b-vision-preview',
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              { type: 'text', text: PROMPT }
            ]
          }],
          temperature: 0.2,
          max_tokens: 500
        })
      });
    }

    if (!response.ok) {
      console.error('Vision API error:', response.status, response.statusText);
      return { tipo: 'otro', valido: false, razon: 'Error al analizar la imagen' };
    }

    const data = await response.json();
    let content = AI_PROVIDER === 'anthropic'
      ? (data.content?.[0]?.text || '{}')
      : (data.choices?.[0]?.message?.content || '{}');

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let obj = {};
    if (jsonMatch) { try { obj = JSON.parse(jsonMatch[0]); } catch (_) { obj = {}; } }
    if (!obj || typeof obj !== 'object') obj = {};
    if (!obj.tipo) obj.tipo = 'otro';
    obj.valido = obj.tipo === 'comprobante';
    return obj;
  } catch (error) {
    console.error('Image analysis error:', error);
    return { tipo: 'otro', valido: false, razon: 'Error procesando la imagen' };
  }
}

module.exports = { analyzePaymentReceipt };
