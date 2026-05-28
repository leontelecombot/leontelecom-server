/**
 * Image Analysis Utility - Uses Claude Vision to analyze payment receipts
 */

async function analyzePaymentReceipt(imageBase64) {
  const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const AI_API_KEY = process.env.AI_API_KEY || '';

  try {
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.2-90b-vision-preview',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`
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
`
              }
            ]
          }
        ],
        temperature: 0.3,
        max_tokens: 200
      })
    });

    if (!response.ok) {
      console.error('Claude Vision error:', response.status, response.statusText);
      return {
        valido: false,
        razon: 'Error al analizar la imagen'
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    
    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return {
      valido: true,
      analisis: content
    };
  } catch (error) {
    console.error('Image analysis error:', error);
    return {
      valido: false,
      razon: 'Error procesando la imagen'
    };
  }
}

module.exports = {
  analyzePaymentReceipt
};
