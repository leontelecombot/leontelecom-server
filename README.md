# León Telecom WhatsApp Bot 🤖

Bot inteligente de WhatsApp para León Telecom que responde preguntas sobre planes, cobertura y soporte técnico, 24/7.

Construido con **Node.js**, **Twilio**, **Ollama** (IA local) y desplegado en **Render** para disponibilidad continua.

## ✨ Features

- ✅ Respuestas con IA (Ollama/Llama3 local o compatible)
- ✅ Planes de fibra óptica e inalámbrico configurables
- ✅ Cobertura automática por zona (Huitzo, Telixtlahuaca, Suchilquitongo)
- ✅ Adjunta imágenes de planes en WhatsApp
- ✅ Conversación persistente por usuario (últimos 20 mensajes)
- ✅ Integración Twilio WhatsApp (Sandbox o Producción)
- ✅ Modo demo con respuestas de respaldo si IA no está disponible
- ✅ Escalable 24/7 en la nube (sin ngrok, sin reinicios)

## 🚀 Quick Start (Render Cloud – 5 minutos)

### 1. Sube el código a GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/tu-usuario/leontelecom-server.git
git push -u origin main
```

### 2. Deploy en Render (Gratis)

1. Ve a https://render.com (crea cuenta gratis)
2. Haz clic: **New** → **Web Service**
3. Conecta tu repositorio de GitHub
4. **Name**: `leontelecom-bot`
5. **Runtime**: Node
6. **Build Command**: `npm install`
7. **Start Command**: `node index.js`
8. **Plan**: Free (funciona 24/7)
9. En **Environment**, añade:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_WHATSAPP_NUMBER=+14155238886
   AI_PROVIDER=ollama
   AI_BASE_URL=http://127.0.0.1:11434
   AI_MODEL=llama3.1
   DEMO_MODE=true
   LEON_CONTACT_NUMBER=9511603125
   FIBER_PLAN_MEDIA_URL=https://via.placeholder.com/800x600?text=Planes+Fibra
   WIRELESS_PLAN_MEDIA_URL=https://via.placeholder.com/800x600?text=Planes+Inalambricos
   ```
10. **Create Web Service** → espera 2-3 minutos a que compile

### 3. Actualiza Twilio Webhook

1. Ve a https://console.twilio.com → **Messaging** → **Try it out** → **WhatsApp**
2. En "**When a message comes in**", reemplaza con tu URL de Render:
   ```
   https://leontelecom-bot.onrender.com/webhook
   ```
3. **Save** → ¡Listo! El bot ya responde 24/7

---

## 🏠 Instalación Local

Para desarrollo o si quieres correr localmente:

```bash
# Instalar dependencias
npm install

# Crear archivo de variables
cp .env.example .env

# Editar .env con tus credenciales
nano .env
```

### Variables de entorno (`.env`)

```env
# Twilio (obtén en https://console.twilio.com → Account Info)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=+14155238886  # Sandbox

# IA
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434
AI_MODEL=llama3.1

# León Telecom
LEON_CONTACT_NUMBER=9511603125

# Imágenes (usa placeholders para testing)
FIBER_PLAN_MEDIA_URL=https://via.placeholder.com/800x600?text=Planes+Fibra
WIRELESS_PLAN_MEDIA_URL=https://via.placeholder.com/800x600?text=Planes+Inalambricos
```

### Corriendo Ollama localmente

Si quieres IA local (privada, sin costos):

```bash
# Instala Ollama desde https://ollama.ai
ollama pull llama3.1
ollama serve  # en otra terminal
```

### Arrancando el servidor

```bash
# Producción
npm start

# Desarrollo (se reinicia al guardar)
npm run dev
```

El servidor corre en `http://localhost:3000/webhook`.

---

## 📱 Configurar Twilio WhatsApp

### Opción A: Sandbox (Pruebas, Gratis – 5 mensajes/día)

1. Ve a https://console.twilio.com → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. Sigue instrucciones para unirte al sandbox desde tu teléfono (recibirás un código)
3. El número es `+14155238886`, ponlo en `.env`:
   ```env
   TWILIO_WHATSAPP_NUMBER=+14155238886
   ```

### Opción B: Producción (Número Real – Ilimitado)

1. Ve a https://console.twilio.com → **Messaging** → **Senders** → **WhatsApp senders**
2. **Register WhatsApp Sender**
3. Sigue flujo de verificación con Meta Business Manager (necesita datos de empresa y teléfono verificado)
4. Meta tarda ~1-3 días en aprobar
5. Una vez aprobado, actualiza `.env`:
   ```env
   TWILIO_WHATSAPP_NUMBER=+521234567890  # Tu número aprobado
   ```

---

## 🖼️ Imágenes de Planes

El bot adjunta automáticamente imágenes cuando pregunta por planes. Opciones para alojar:

### GitHub Pages (Recomendado, Gratis)

```bash
# Crea repositorio separado
mkdir leontelecom-images
cd leontelecom-images
git init
mkdir public
# Sube tus imágenes a public/fiber.png, public/wireless.png

# Sube a GitHub
git remote add origin https://github.com/tu-usuario/leontelecom-images.git
git push -u origin main

# En Settings → Pages → Source: main/public branch
# Tus URLs serán:
# https://tu-usuario.github.io/leontelecom-images/fiber.png
```

Luego actualiza `.env`:
```env
FIBER_PLAN_MEDIA_URL=https://tu-usuario.github.io/leontelecom-images/fiber.png
WIRELESS_PLAN_MEDIA_URL=https://tu-usuario.github.io/leontelecom-images/wireless.png
```

### Cloudflare R2 (Gratis, 10GB/mes)

1. Ve a https://dash.cloudflare.com → **R2**
2. Crea bucket: `leontelecom-plans`
3. Sube imágenes
4. Copia URLs públicas a `.env`

### Imgur (Más simple)

1. Ve a https://imgur.com
2. Sube imágenes (sin cuenta)
3. Copia URLs a `.env`

---

## 📋 Planes Configurables

### Fibra Óptica (Huitzo)
- **Lite**: 30 Mbps → $289/mes
- **Basic**: 80 Mbps → $320/mes
- **Medium**: 150 Mbps → $440/mes
- **Advanced**: 200 Mbps → $560/mes
- **Ultra**: 300 Mbps → $680/mes

### Inalámbrico con Antena (Telixtlahuaca, Suchilquitongo)
- **15 Mbps** → $290/mes
- **20 Mbps** → $340/mes
- **30 Mbps** → $440/mes

**Promoción**: Nuevos clientes reciben el doble de velocidad el primer mes.

Edita `FIBER_PLANS`, `WIRELESS_PLANS` y `SYSTEM_PROMPT` en `index.js` para personalizar.

---

## 🔧 Personalización

### Cambiar el prompt del bot

Edita `SYSTEM_PROMPT` en `index.js`:
- Nombre del asistente
- Planes y precios
- Instrucciones de comportamiento
- Número de contacto

### Cambiar el modelo IA

```env
AI_MODEL=llama3.2    # Otro modelo Ollama
AI_PROVIDER=openai-compatible  # Para OpenAI, Anthropic, etc.
```

---

## 🐛 Troubleshooting

| Problema | Solución |
|----------|----------|
| "username is required" | Verifica `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` en `.env` o Render variables |
| "fetch failed" (IA sin responder) | Verifica que Ollama está corriendo (`ollama serve`) o usa IA remota |
| Mensajes no se envían | Revisa logs en Render Dashboard; verifica webhook URL en Twilio |
| Sandbox limitado a 5 msgs/día | Normal. Registra WhatsApp Sender para producción (ilimitado) |
| Error en deploy de Render | Revisa que `.gitignore` excluye `node_modules` y `.env` |

---

## 📊 Monitoreo

En Render Dashboard puedes ver:
- **Logs en vivo** de tu bot
- **CPU/Memory usage**
- **Deploy status** y historial
- **Auto-redeploy** cuando haces `git push`

En local:
```bash
curl http://localhost:3000/health  # Verifica que corre
```

---

## 🔒 Seguridad

- **NUNCA** subas `.env` a GitHub (ya está en `.gitignore`)
- Rotación de credenciales Twilio regularmente en console.twilio.com
- Con Ollama local, tus datos no salen del servidor (privado)
- Para producción, considera HTTPS obligatorio y validar firmas de Twilio

---

## 📖 Flujo del Bot

```
Usuario → WhatsApp → Twilio
                        ↓
                   Webhook (tu servidor)
                        ↓
                   ¿Pregunta sobre planes?
                   ✓ Sí → IA genera respuesta + imágenes
                   ✗ No → Fallback o IA general
                        ↓
                   Twilio envía respuesta
                        ↓
                      Usuario recibe en WhatsApp
```

---

## 💡 Tips & Mejoras Futuras

- Guardar historial en Redis/MongoDB para persistencia (actualmente en memoria)
- Integrar pagos (Mercado Pago, Stripe) para contratos directos
- Analytics de preguntas más frecuentes
- Soporte multiidioma
- Integración con CRM (HubSpot, Salesforce)
- Notificaciones automáticas de cortes/mantenimiento

---

## 📞 Soporte

Para preguntas sobre el bot o León Telecom: **9511603125**

Para bugs o sugerencias: abre un issue en GitHub.

---

Made with ❤️ for León Telecom | 2026
