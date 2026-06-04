/**
 * Image Analysis Utility - Uses Claude Vision (Anthropic) or Groq Vision to analyze payment receipts
 */

async function analyzePaymentReceipt(imageBase64) {
  const AI_PROVIDER = process.env.AI_PROVIDER || 'openai-compatible';
  const AI_API_KEY = process.env.AI_API_KEY || '';

  if (!AI_API_KEY) {
    return { valido: false, razon: 'API key no configurada' };
  }

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
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: `Analiza esta imagen de comprobante de pago.

Por favor, extrae:
1. ¿Es un comprobante de pago válido? (sí/no)
2. Concepto o servicio pagado
3. Monto (si está visible)
4. Fecha (si está visible)
5. Operador o banco (si está visible)

Responde en formato JSON simple.
Si no es un comprobante de pago, responde: {"valido": false, "razon": "..."}
Si sí lo es, responde: {"valido": true, "concepto": "...", "monto": "...", "fecha": "...", "banco": "..."}`
              }
            ]
          }]
        })
      });
    } else {
      // OpenAI-compatible (Groq vision, etc.)
      const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
      response = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.2-90b-vision-preview',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
              },
              {
                type: 'text',
                text: `Analiza esta imagen de comprobante de pago y responde en JSON:
{"valido": true/false, "concepto": "...", "monto": "...", "fecha": "...", "banco": "..."}
Si no es comprobante: {"valido": false, "razon": "..."}`
              }
            ]
          }],
          temperature: 0.3,
          max_tokens: 200
        })
      });
    }

    if (!response.ok) {
      console.error('Vision API error:', response.status, response.statusText);
      return { valido: false, razon: 'Error al analizar la imagen' };
    }

    const data = await response.json();
    let content;

    if (AI_PROVIDER === 'anthropic') {
      content = data.content?.[0]?.text || '{}';
    } else {
      content = data.choices?.[0]?.message?.content || '{}';
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);

    return { valido: true, analisis: content };
  } catch (error) {
    console.error('Image analysis error:', error);
    return { valido: false, razon: 'Error procesando la imagen' };
  }
}

module.exports = { analyzePaymentReceipt };
