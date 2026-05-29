# León Telecom Bot & Admin Panel

**Servidor Node.js con Telegram bot, panel admin, análisis de imágenes y sistema de comunicaciones masivas**

> Arquitectura moderna para Q&A conversacional, procesamiento de comprobantes de pago y gestión de servicios.

## 🚀 Características Principales

### 🤖 Bot de Telegram
- ✅ Conversación IA con contexto (basada en Groq/Claude)
- ✅ Detección y análisis de imágenes (comprobantes de pago)
- ✅ Registro automático de usuarios
- ✅ Historial de chat persistente
- ✅ Notificaciones a agentes
- ✅ Gestión de zonas y planes

### 👨‍💼 Panel de Administración
- ✅ Autenticación segura con contraseña
- ✅ **Mensajes masivos** a todos los usuarios
- ✅ **Promociones** (foto + texto) para toda la base de usuarios
- ✅ Estado de la red (integración opcional con Wisphub)
- ✅ Vista de reportes pendientes
- ✅ Interfaz responsive y moderna

### 📊 Gestión de Datos
- ✅ Usuarios activos rastreados
- ✅ Reportes con análisis de imágenes
- ✅ Historial de promociones
- ✅ Sistema de estados

---

## 📋 Instalación & Configuración

### 1. Clonar el repositorio
```bash
git clone https://github.com/leontelecombot/leontelecom-server.git
cd leontelecom-server
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
```bash
cp .env.example .env
```

**Variables críticas:**
```env
# Telegram
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
AGENT_NOTIFY_CHAT_ID=YOUR_CHAT_ID

# AI
AI_API_KEY=YOUR_GROQ_OR_CLAUDE_KEY
AI_BASE_URL=https://api.groq.com/openai/v1
AI_MODEL=llama-3.1-8b-instant

# Admin Panel
ADMIN_PASSWORD=tu_contraseña_segura  # ⚠️ Cambiar en producción

# Opcional: Planes
FIBER_PLAN_MEDIA_URL=https://...
WIRELESS_PLAN_MEDIA_URL=https://...
```

### 4. Ejecutar localmente
```bash
npm start          # Producción
npm run dev        # Desarrollo (con nodemon)
```

El servidor escuchará en `http://localhost:3000`

---

## 🔑 Endpoints Principales

### Públicos
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/webhook` | Webhook de Telegram (fotos + texto) |
| GET | `/health` | Health check |
| GET | `/chat/:chatId/history` | Historial de conversación |

### Admin Panel
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/admin` | Redirecciona a login |
| GET | `/admin/login` | Página de login |
| GET | `/admin/dashboard` | Panel principal |
| POST | `/admin/api/login` | Autenticación |
| POST | `/admin/api/send-message` | Enviar mensaje masivo |
| POST | `/admin/api/send-promotion` | Enviar promoción |
| GET | `/admin/api/user-count` | Contar usuarios activos |
| GET | `/admin/api/network-status` | Estado de la red |
| GET | `/admin/api/reports` | Ver reportes pendientes |

---

## 🎛️ Uso del Panel Admin

### Acceso
1. Navega a `https://tudominio.com/admin`
2. Ingresa la contraseña (`ADMIN_PASSWORD` de `.env`)
3. Accede al dashboard

### Enviar Mensaje Masivo
- Escribe el mensaje en el formulario
- Especifica destino (todos los usuarios)
- Haz click en "📤 Enviar Mensaje Masivo"
- Los usuarios recibirán: `📢 ANUNCIO\n\n{tu_mensaje}`

### Enviar Promoción
- Sube una imagen
- Escribe descripción/texto
- Haz click en "🎯 Enviar Oferta"
- Se enviará como foto con caption a todos

---

## 🖼️ Análisis de Imágenes (Claude Vision)

El bot detecta automáticamente cuando un usuario envía una foto:

```
Usuario: [envía foto de comprobante de pago]
        ↓
Bot: "⏳ Analizando tu comprobante..."
        ↓
Claude Vision: Analiza y extrae datos (monto, fecha, operador)
        ↓
Agente Notificado: Recibe análisis en el chat
        ↓
Usuario: "✅ Tu comprobante fue analizado. Asesor en camino"
```

**Análisis incluye:**
- ✅ Validez del documento
- ✅ Concepto/servicio pagado
- ✅ Monto (si está visible)
- ✅ Fecha
- ✅ Operador/banco

---

## 📁 Estructura del Proyecto

```
leontelecom-server/
├── index.js                 # Aplicación principal
├── package.json            # Dependencias
├── .env.example            # Variables de ejemplo
├── public/
│   ├── admin-login.html    # Login del admin
│   └── admin-dashboard.html # Dashboard principal
├── utils/
│   ├── imageAnalysis.js    # Claude Vision para imágenes
│   └── dataManager.js      # Gestión de usuarios/reportes
└── README.md
```

---

## 🔐 Seguridad

### En Producción
1. **Cambiar `ADMIN_PASSWORD`** en `.env`
2. **Usar HTTPS** (Render, Vercel, etc.)
3. **Validar tokens** en todas las rutas sensibles
4. **Rotación de secretos** regularmente
5. **Logs y monitoreo** activos

### Buenas Prácticas
- No commitear `.env` (usar `.env.example`)
- Usar variables de entorno para secrets
- Implementar rate limiting en `/admin` 
- Hacer backups de datos de reportes

---

## 🚀 Despliegue a Producción (Render)

### 1. Conectar repositorio
```bash
# En Render.com: New → Web Service → Connect GitHub
```

### 2. Configurar variables
En Render Dashboard → Environment Variables:
```
TELEGRAM_BOT_TOKEN=...
AI_API_KEY=...
ADMIN_PASSWORD=...
```

### 3. Deploy automático
- Push a `main` → Deploy automático
- Logs en tiempo real: `Render Dashboard`

---

## 💡 Ejemplos de Uso

### Verificar que funciona
```bash
# Health check
curl http://localhost:3000/health

# Ver último chat
curl http://localhost:3000/chat/123456/history
```

### Acceso admin (development)
1. URL: `http://localhost:3000/admin/login`
2. Password: (la de tu `.env`)
3. Enviar mensaje masivo a todos: "Se está haciendo mantenimiento"

---

## 🐛 Troubleshooting

| Problema | Solución |
|----------|----------|
| Bot no responde | ✓ Verificar `TELEGRAM_BOT_TOKEN` |
| Imágenes no se analizan | ✓ Verificar `AI_API_KEY` y modelo |
| Panel admin no carga | ✓ Revisar `ADMIN_PASSWORD` |
| Mensajes no se envían | ✓ Revisar lista de usuarios, conectividad |
| Errores en logs de Render | ✓ Ver Render → Logs → Tail |

---

## 📞 Soporte

- **Issues**: GitHub Issues
- **Documentación**: Ver archivos .md en repo
- **Contacto**: support@leontelecom.mx

---

## 📄 Licencia

Privado - León Telecom México 2026


Para las imágenes de planes, usa enlaces públicos directos. Los links de Google Drive deben estar compartidos para cualquiera con el enlace y, de preferencia, apuntar a una URL directa tipo `uc?export=view&id=...`.

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