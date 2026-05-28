# REQUISITOS DE PROYECTO: LEÓN TELECOM BOT WHATSAPP
## Sistema de Gestión de Clientes para Telecom

**Fecha:** 28 de Mayo de 2026  
**Presupuesto Cliente:** 10,000 MXN  
**Presupuesto Operativo:** Servicios externos (a cargo de la empresa)

---

## 📋 RESUMEN EJECUTIVO

Bot inteligente WhatsApp + Telegram para gestión de clientes de León Telecom. Automatiza:
- Consulta de planes de internet
- Agendamiento de instalaciones
- Migración de servicios entre zonas
- Sistema de folios para seguimiento
- Reportes de fallas técnicas

**Arquitectura:** Node.js + Express (webhook) + Claude IA + MongoDB/PostgreSQL + Render

---

## 1️⃣ REQUISITOS WHATSAPP BUSINESS API

### 1.1 Configuración Meta/WhatsApp
- [ ] **Cuenta Meta Business** (verificada)
  - Crear en: https://business.facebook.com
  - Documento de identidad de empresa
  - Comprobante de domicilio actualizado
  - Costo: **GRATIS**

- [ ] **Número WhatsApp Business**
  - Usar número empresarial (9511603125 o similar)
  - Verificación vía SMS/llamada
  - Costo: **GRATIS**

- [ ] **Phone Number ID** (identificador único)
  - Generado automáticamente por Meta
  - Costo: **GRATIS**

- [ ] **Business Account ID**
  - Generado automáticamente por Meta
  - Costo: **GRATIS**

- [ ] **Access Token (API)**
  - Generado en App Dashboard
  - Debe renovarse cada 3 meses
  - Costo: **GRATIS**

### 1.2 Wishphub Integration (Ya contratado)
- [x] Suscripción Wishphub (empresa ya tiene)
- [x] Configuración de número en Wishphub
- [ ] Revisar límites API incluidos
- Costo: **YA PAGADO POR EMPRESA**

### 1.3 Gestión de Mensajes WhatsApp
- Mensajes entrantes: **Sin límite** (Meta proporciona)
- Mensajes salientes: **$0.06 USD por mensaje**
  - Estimado: 150-200 msgs/mes = $9-12 USD ≈ **170-230 MXN/mes**
- Rate limit: 80 mensajes/segundo

**Total WhatsApp/Mes:** ~**200 MXN**

---

## 2️⃣ INFRAESTRUCTURA TÉCNICA

### 2.1 Hosting Principal
**Opción: Render (Recomendado)**
- Plan: Standard (2 GB RAM, 1 CPU)
- Uso: Servidor Node.js + Webhook WhatsApp
- Uptime: 99.9%
- Costo: **$7 USD/mes ≈ 350 MXN/mes**

**Alternativas:**
- Heroku: $7-50 USD/mes
- Railway: $5-20 USD/mes
- AWS EC2: $10-30 USD/mes

### 2.2 Base de Datos
**Opción: MongoDB Atlas (Recomendado)**
- Tier: M0 Sandbox (gratuito) → M2 ($9/mes después)
- Almacenamiento: 512 MB (M0) → 2 GB (M2)
- Replicas: 3 nodos (redundancia automática)
- Backups: Diarios automáticos

**M0 Gratuito (primeros 3 meses):**
- Costo: **GRATIS**

**M2 (después):**
- Costo: **$9 USD/mes ≈ 450 MXN/mes**

**Alternativa: PostgreSQL en Render:**
- Costo: **$7-15 USD/mes ≈ 350-750 MXN/mes**

**Datos a almacenar:**
- Usuarios/chats: ~5,000 registros
- Historial conversacional: ~50,000 mensajes
- Folios/citas: ~1,000 documentos
- Espacio estimado: 500 MB - 2 GB

**Total BD/Mes:** ~**450 MXN** (después de período gratuito)

### 2.3 IA - API Claude (RECOMENDADO)
**Proveedor: Anthropic**
- Modelo: Claude 3.5 Sonnet (mejor relación costo-rendimiento)
- Tokens: ~50,000-100,000 tokens/mes estimados
- Precio: $3 USD/millón tokens entrada + $15 USD/millón tokens salida

**Cálculo:**
- Entrada: 60,000 tokens × $0.003 = $0.18
- Salida: 40,000 tokens × $0.015 = $0.60
- **Total: ~$0.80 USD ≈ 16 MXN/mes**

**Alternativa 1: Groq (Actual)**
- Plan gratuito: 30,000 requests/día
- Costo: **GRATIS** (por ahora)
- Limitation: Puede cambiar tarifa en futuro

**Alternativa 2: OpenAI GPT-4**
- Costo: ~$1.50-3 USD/mes
- ≈ **30-60 MXN/mes**

**Total IA/Mes:** ~**16 MXN** (Claude) o **GRATIS** (Groq)

---

## 3️⃣ SERVICIOS ADICIONALES

### 3.1 Dominio y SSL
- Dominio: bot.leontelecom.mx
- Registrar en: Namecheap, GoDaddy, etc.
- SSL: Incluido con Render (automático)
- Costo: **$80-150 MXN/año** (dominio)

### 3.2 Monitoreo y Logs
**Opción 1: Sentry (Recomendado)**
- Seguimiento de errores en tiempo real
- 5,000 eventos gratis/mes
- Plan Pro: $29 USD/mes
- Costo inicial: **GRATIS**

**Opción 2: LogRocket**
- Registros completos de usuarios
- Costo: **$99 USD/mes (Enterprise)**

**Recomendación:** Usar Sentry gratuito + console.log

**Total Monitoreo/Mes:** **GRATIS**

### 3.3 Almacenamiento de Archivos (Futuros)
**Para fotos de planes, medios, etc.**
- AWS S3: $0.023 USD por GB
- Cloudinary: $75-99 USD/mes
- Firebase Storage: $0.018 USD por GB
- Costo estimado: **50-200 MXN/mes** (opcional)

### 3.4 Notificaciones a Agentes
**Webhook interno (Render)**
- Costo: **INCLUIDO**
- Usar: Telegram Bot o Slack

---

## 4️⃣ RESUMEN DE COSTOS MENSUALES

| Servicio | Plan | Costo MXN | Estado |
|----------|------|-----------|--------|
| WhatsApp API (msgs) | Pago por uso | 170-230 | Empresa |
| Hosting (Render) | Standard | 350 | Empresa |
| Base de Datos (MongoDB M2) | M2 Shared | 450 | Empresa* |
| IA - Claude | API Tokens | 16 | Empresa |
| Dominio | .mx | 10 | Empresa |
| Monitoreo | Sentry Free | 0 | Empresa |
| **TOTAL MENSUAL** | | **~1,000 MXN** | **Empresa** |
| **TOTAL ANUAL** | | **~12,000 MXN** | **Empresa** |

*MongoDB ofrece 3 meses gratuitos con M0

---

## 5️⃣ ESPECIFICACIONES TÉCNICAS

### 5.1 Stack Tecnológico
```
Backend: Node.js 18+
Framework: Express.js 4.x
Base de Datos: MongoDB 5.0+ (O PostgreSQL)
IA: Claude API (Anthropic)
Messaging: 
  - Telegram Bot API (webhook)
  - WhatsApp Business API (webhook)
Runtime: Render (Node.js 18)
Versión Control: Git/GitHub
```

### 5.2 Integraciónes Requeridas
- ✅ Telegram Bot API
- ✅ Meta WhatsApp Business API
- ✅ Claude API (Anthropic)
- ✅ MongoDB Atlas API
- ✅ Render Deployment API

### 5.3 Funcionalidades Implementadas
- [x] Menú interactivo (6 opciones)
- [x] Consulta de planes (FIBER + WIRELESS)
- [x] Agendamiento de instalaciones
- [x] Migración de servicios
- [x] Reportes de fallas
- [x] Sistema de folios
- [x] Cancelación de citas
- [x] Historial conversacional
- [x] Validación de direcciones (44 colonias)
- [ ] Integración WhatsApp (PENDIENTE)
- [ ] Sistema de pagos (FUTURO)

---

## 6️⃣ REQUISITOS FUNCIONALES

### 6.1 Flujos de Usuario
1. **Consultar Planes**
   - Seleccionar ubicación (Huitzo/Telixtlahuaca/Suchilquitongo)
   - Ingresar tamaño de hogar
   - Recibir recomendaciones personalizadas

2. **Agendar Instalación**
   - Seleccionar fecha
   - Ingresar datos (nombre, dirección, calle, referencias)
   - Recibir folio único
   - Confirmación de cita

3. **Migrar Servicio**
   - Ubicación actual → Nueva ubicación
   - Validar direcciones
   - Generar folio de migración
   - Notificar al agente

4. **Reportar Falla**
   - Ingreso de ubicación y descripción
   - Asignación automática a técnico
   - Folio de seguimiento

### 6.2 Requisitos de Datos
- Base de datos persistente (no in-memory)
- Historial de 100+ mensajes por usuario
- Almacenamiento de folios (3-6 meses mínimo)
- Logs de errores (30 días)

---

## 7️⃣ CRONOGRAMA IMPLEMENTACIÓN

| Fase | Tarea | Tiempo | Responsable |
|------|-------|--------|-------------|
| 1 | Verificación Meta Business | 3-5 días | Empresa |
| 2 | Configuración WhatsApp API | 2-3 días | Empresa |
| 3 | Setup MongoDB Atlas | 1 día | Dev |
| 4 | Migración código Groq → Claude | 2-3 días | Dev |
| 5 | Integración WhatsApp webhook | 2-3 días | Dev |
| 6 | Testing y QA | 3-5 días | QA |
| 7 | Despliegue producción | 1 día | Dev |
| 8 | Monitoreo 7 días | 7 días | Dev+Support |
| **TOTAL** | | **~25 días** | |

---

## 8️⃣ CHECKLIST PARA LA EMPRESA

### A. Antes de iniciar desarrollo
- [ ] Verificar/crear cuenta Meta Business
- [ ] Registrar número WhatsApp Business (9511603125)
- [ ] Obtener Phone Number ID
- [ ] Obtener Business Account ID
- [ ] Generar Access Token permanente
- [ ] Configurar webhook URL en Meta
- [ ] Verificar suscripción Wishphub vigente

### B. Antes de desplegar
- [ ] Registrar dominio bot.leontelecom.mx
- [ ] Crear cuenta Render y conectar GitHub
- [ ] Crear cuenta MongoDB Atlas (o PostgreSQL)
- [ ] Crear cuenta Anthropic (Claude API)
- [ ] Configurar variables de entorno:
  - TELEGRAM_BOT_TOKEN
  - WHATSAPP_PHONE_NUMBER_ID
  - WHATSAPP_BUSINESS_ACCOUNT_ID
  - WHATSAPP_ACCESS_TOKEN
  - MONGODB_URI
  - CLAUDE_API_KEY
  - AI_PROVIDER=anthropic

### C. Después de desplegar
- [ ] Monitorear errores (Sentry)
- [ ] Revisar logs (Render)
- [ ] Testear flujos completos
- [ ] Validar mensajería WhatsApp
- [ ] Configurar backups automáticos
- [ ] Documentar credenciales (1Password/Vault)

---

## 9️⃣ NOTAS IMPORTANTES

⚠️ **CONSIDERAR:**
1. **Meta Business Account**: Requiere 3-5 días de verificación inicial
2. **Rate Limits**: WhatsApp limita a 80 msgs/seg
3. **Pruebas**: Usar números de prueba antes de producción
4. **Backups**: Configurar backups diarios de BD
5. **Seguridad**: Usar SSL/TLS (incluido en Render)
6. **Escalabilidad**: Plan actual soporta ~5,000 chats activos

---

## 🔟 PRESUPUESTO TOTAL (PRIMER AÑO)

```
Servicios Primer Mes:      ~1,000 MXN
Servicios Meses 2-12:      ~11,000 MXN
                           ──────────
TOTAL OPERATIVO ANUAL:     ~12,000 MXN

Desarrollo (ya pagado):     10,000 MXN
                           ──────────
INVERSIÓN TOTAL AÑO 1:      22,000 MXN
```

---

## 📞 CONTACTOS Y REFERENCIAS

**Documentación:**
- Meta Business: https://developers.facebook.com/docs/whatsapp
- Claude API: https://anthropic.com/claude/api
- MongoDB: https://docs.mongodb.com/
- Render: https://render.com/docs

**Soporte:**
- Meta Business Support: support.meta.com
- Anthropic Support: support@anthropic.com
- MongoDB Support: support.mongodb.com
- Render Support: render.com/support

---

**Documento Preparado:** 28 de Mayo, 2026  
**Versión:** 1.0  
**Estado:** Aprobado para implementación
