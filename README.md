# León Telecom Server

Servidor Node.js para el bot de León Telecom con webhook de Telegram, respuesta asistida por IA y flujo de planes por zona.

## Requisitos

- Node.js 18 o superior
- Variables de entorno en `.env` o en Render

## Variables

- `TELEGRAM_BOT_TOKEN`
- `AI_API_KEY`
- `AI_PROVIDER`
- `AI_BASE_URL`
- `AI_MODEL`
- `FIBER_PLAN_MEDIA_URL`
- `WIRELESS_PLAN_MEDIA_URL`
- `LEON_CONTACT_NUMBER`
- `AGENT_NOTIFY_CHAT_ID`
- `AGENT_NOTIFY_WEBHOOK_URL`

## Flujo de planes

- Huitzo: fibra óptica
- Telixtlahuaca: internet inalámbrico
- Suchilquitongo: internet inalámbrico

El bot ya no pide colonia. Solo pregunta la zona y muestra los planes correctos con sus fotos cuando están configuradas.

## Agente humano

Si el usuario pide hablar con un agente, el bot puede notificar a un chat de Telegram interno o a un webhook externo, por ejemplo un flujo de n8n.
Si no configuras esas variables, el bot sigue funcionando normal y solo responde al usuario.

## Uso local

```bash
npm install
npm start
```

## Webhook de Telegram

Después de desplegar, registra el webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TU_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://leontelecom-server.onrender.com/webhook"}'
```