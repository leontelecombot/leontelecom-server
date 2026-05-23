# León Telecom Server

Servidor Node.js para el bot de León Telecom con webhook de Telegram y respuesta asistida por IA.

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