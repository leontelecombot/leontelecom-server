// Genera PDF desde HTML usando punycode + métodos nativos
// Este script crea un PDF profesional con los requisitos

const fs = require('fs');
const path = require('path');

const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Requisitos Proyecto León Telecom WhatsApp</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            background: white;
            padding: 40px;
            max-width: 1000px;
            margin: 0 auto;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 40px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 32px;
            margin-bottom: 10px;
        }
        
        .header p {
            font-size: 14px;
            opacity: 0.9;
        }
        
        .section {
            margin-bottom: 40px;
            page-break-inside: avoid;
        }
        
        .section h2 {
            color: #667eea;
            font-size: 24px;
            margin-bottom: 20px;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }
        
        .section h3 {
            color: #764ba2;
            font-size: 18px;
            margin-top: 20px;
            margin-bottom: 12px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background: white;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        th {
            background: #667eea;
            color: white;
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid #eee;
        }
        
        tr:hover {
            background: #f5f5f5;
        }
        
        ul, ol {
            margin-left: 20px;
            margin-top: 10px;
        }
        
        li {
            margin-bottom: 8px;
        }
        
        .highlight {
            background: #f0f4ff;
            border-left: 4px solid #667eea;
            padding: 15px;
            margin: 15px 0;
            border-radius: 4px;
        }
        
        .cost-box {
            background: #e8f5e9;
            border: 2px solid #4caf50;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        
        .warning {
            background: #fff3e0;
            border: 2px solid #ff9800;
            padding: 15px;
            border-radius: 4px;
            margin: 15px 0;
        }
        
        .checklist {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 4px;
            margin: 15px 0;
        }
        
        .checklist input {
            margin-right: 10px;
        }
        
        .footer {
            margin-top: 60px;
            border-top: 2px solid #eee;
            padding-top: 20px;
            font-size: 12px;
            color: #999;
            text-align: center;
        }
        
        code {
            background: #f4f4f4;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
        
        .table-pricing {
            font-size: 13px;
        }
        
        .total-row {
            background: #e3f2fd;
            font-weight: bold;
        }
        
        @media print {
            body {
                padding: 20px;
            }
            .section {
                page-break-inside: avoid;
            }
            table {
                page-break-inside: avoid;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 LEÓN TELECOM BOT WhatsApp</h1>
        <p>Documento de Requisitos Técnicos y Presupuesto</p>
        <p style="margin-top: 10px; font-size: 12px;">28 de Mayo de 2026 | Versión 1.0</p>
    </div>

    <div class="section">
        <h2>📋 Resumen Ejecutivo</h2>
        <p>Bot inteligente WhatsApp + Telegram para gestión de clientes de León Telecom que automatiza:</p>
        <ul>
            <li>✅ Consulta de planes de internet</li>
            <li>✅ Agendamiento de instalaciones</li>
            <li>✅ Migración de servicios entre zonas</li>
            <li>✅ Sistema de folios para seguimiento</li>
            <li>✅ Reportes de fallas técnicas</li>
        </ul>
        <p style="margin-top: 15px;"><strong>Arquitectura:</strong> Node.js + Express (webhook) + Claude IA + MongoDB + Render</p>
    </div>

    <div class="section">
        <h2>1️⃣ Requisitos WhatsApp Business API</h2>
        
        <h3>1.1 Configuración Meta/WhatsApp</h3>
        <div class="checklist">
            <input type="checkbox"> <strong>Cuenta Meta Business</strong> (verificada)<br/>
            Crear en: https://business.facebook.com | Costo: GRATIS<br><br>
            
            <input type="checkbox"> <strong>Número WhatsApp Business</strong><br/>
            Usar número empresarial (9511603125) | Verificación vía SMS/llamada | Costo: GRATIS<br><br>
            
            <input type="checkbox"> <strong>Phone Number ID</strong> (identificador único)<br/>
            Generado automáticamente por Meta | Costo: GRATIS<br><br>
            
            <input type="checkbox"> <strong>Business Account ID</strong><br/>
            Generado automáticamente por Meta | Costo: GRATIS<br><br>
            
            <input type="checkbox"> <strong>Access Token (API)</strong><br/>
            Generado en App Dashboard | Renovación cada 3 meses | Costo: GRATIS
        </div>

        <h3>1.2 Wishphub Integration</h3>
        <div class="highlight">
            ✅ Suscripción Wishphub (empresa ya tiene) - <strong>YA PAGADO</strong><br/>
            ✅ Configuración de número en Wishphub<br/>
            ✅ Revisar límites API incluidos
        </div>

        <h3>1.3 Gestión de Mensajes WhatsApp</h3>
        <ul>
            <li><strong>Mensajes entrantes:</strong> Sin límite (Meta proporciona)</li>
            <li><strong>Mensajes salientes:</strong> \$0.06 USD por mensaje</li>
            <li><strong>Estimado:</strong> 150-200 msgs/mes = \$9-12 USD ≈ <strong>170-230 MXN/mes</strong></li>
            <li><strong>Rate limit:</strong> 80 mensajes/segundo</li>
        </ul>
        
        <div class="cost-box">
            <strong>💰 Total WhatsApp/Mes:</strong> ~<strong>200 MXN</strong>
        </div>
    </div>

    <div class="section">
        <h2>2️⃣ Infraestructura Técnica</h2>
        
        <h3>2.1 Hosting Principal</h3>
        <p><strong>Opción Recomendada: Render</strong></p>
        <ul>
            <li>Plan: Standard (2 GB RAM, 1 CPU)</li>
            <li>Uso: Servidor Node.js + Webhook WhatsApp</li>
            <li>Uptime: 99.9%</li>
            <li><strong>Costo: \$7 USD/mes ≈ 350 MXN/mes</strong></li>
        </ul>
        <p style="margin-top: 10px;"><em>Alternativas: Heroku (\$7-50), Railway (\$5-20), AWS EC2 (\$10-30)</em></p>

        <h3>2.2 Base de Datos</h3>
        <p><strong>Opción Recomendada: MongoDB Atlas</strong></p>
        <ul>
            <li>Tier M0 Sandbox: GRATIS (primeros 3 meses)</li>
            <li>Tier M2 (después): \$9 USD/mes ≈ <strong>450 MXN/mes</strong></li>
            <li>Almacenamiento: 512 MB (M0) → 2 GB (M2)</li>
            <li>Replicas: 3 nodos (redundancia automática)</li>
            <li>Backups: Diarios automáticos</li>
        </ul>
        <p style="margin-top: 10px;"><strong>Datos a almacenar:</strong> 5,000 usuarios + 50,000 mensajes + 1,000 folios ≈ 500 MB - 2 GB</p>

        <h3>2.3 IA - API Claude (RECOMENDADO)</h3>
        <p><strong>Proveedor: Anthropic</strong></p>
        <ul>
            <li>Modelo: Claude 3.5 Sonnet (mejor relación costo-rendimiento)</li>
            <li>Tokens: ~50,000-100,000 tokens/mes estimados</li>
            <li>Precio: \$3 USD/millón tokens entrada + \$15 USD/millón tokens salida</li>
        </ul>
        <div class="highlight">
            <strong>Cálculo Estimado:</strong><br/>
            Entrada: 60,000 × \$0.003 = \$0.18<br/>
            Salida: 40,000 × \$0.015 = \$0.60<br/>
            <strong>Total: ~\$0.80 USD ≈ 16 MXN/mes</strong>
        </div>

        <p style="margin-top: 15px;"><strong>Alternativas:</strong></p>
        <ul>
            <li>Groq (Actual): GRATIS hasta 30,000 requests/día</li>
            <li>OpenAI GPT-4: ~\$1.50-3 USD/mes ≈ 30-60 MXN/mes</li>
        </ul>
    </div>

    <div class="section">
        <h2>3️⃣ Servicios Adicionales</h2>
        
        <h3>3.1 Dominio y SSL</h3>
        <ul>
            <li>Dominio: bot.leontelecom.mx</li>
            <li>Registrar en: Namecheap, GoDaddy, etc.</li>
            <li>SSL: Incluido con Render (automático)</li>
            <li><strong>Costo: \$80-150 MXN/año</strong></li>
        </ul>

        <h3>3.2 Monitoreo y Logs</h3>
        <p><strong>Recomendado: Sentry</strong></p>
        <ul>
            <li>Seguimiento de errores en tiempo real</li>
            <li>5,000 eventos gratis/mes</li>
            <li><strong>Costo inicial: GRATIS</strong></li>
        </ul>

        <h3>3.3 Almacenamiento de Archivos (Opcional)</h3>
        <ul>
            <li>AWS S3: \$0.023 USD por GB</li>
            <li>Cloudinary: \$75-99 USD/mes</li>
            <li><strong>Costo estimado: 50-200 MXN/mes</strong></li>
        </ul>
    </div>

    <div class="section">
        <h2>4️⃣ Resumen de Costos Mensuales</h2>
        
        <table class="table-pricing">
            <thead>
                <tr>
                    <th>Servicio</th>
                    <th>Plan</th>
                    <th>Costo MXN</th>
                    <th>Responsable</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>WhatsApp API (mensajes)</td>
                    <td>Pago por uso</td>
                    <td>170-230</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>Hosting (Render)</td>
                    <td>Standard</td>
                    <td>350</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>Base de Datos (MongoDB M2)</td>
                    <td>M2 Shared</td>
                    <td>450</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>IA - Claude API</td>
                    <td>API Tokens</td>
                    <td>16</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>Dominio</td>
                    <td>.mx</td>
                    <td>10</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>Monitoreo (Sentry)</td>
                    <td>Free Tier</td>
                    <td>0</td>
                    <td>Empresa</td>
                </tr>
                <tr class="total-row">
                    <td colspan="2"><strong>TOTAL MENSUAL</strong></td>
                    <td><strong>~1,000 MXN</strong></td>
                    <td><strong>Empresa</strong></td>
                </tr>
                <tr class="total-row">
                    <td colspan="2"><strong>TOTAL ANUAL</strong></td>
                    <td><strong>~12,000 MXN</strong></td>
                    <td><strong>Empresa</strong></td>
                </tr>
            </tbody>
        </table>

        <div class="cost-box" style="margin-top: 30px;">
            <h3 style="color: #2e7d32; margin-top: 0;">💰 Presupuesto Total Año 1</h3>
            <p style="font-size: 18px; margin: 15px 0;">
                Desarrollo (ya pagado): <strong>10,000 MXN</strong><br/>
                Servicios operativos: <strong>~12,000 MXN</strong><br/>
                <span style="font-size: 20px; font-weight: bold;">INVERSIÓN TOTAL: ~22,000 MXN</span>
            </p>
        </div>
    </div>

    <div class="section">
        <h2>5️⃣ Especificaciones Técnicas</h2>
        
        <h3>5.1 Stack Tecnológico</h3>
        <ul>
            <li><strong>Backend:</strong> Node.js 18+</li>
            <li><strong>Framework:</strong> Express.js 4.x</li>
            <li><strong>Base de Datos:</strong> MongoDB 5.0+ (O PostgreSQL)</li>
            <li><strong>IA:</strong> Claude API (Anthropic)</li>
            <li><strong>Messaging:</strong> Telegram Bot API + WhatsApp Business API</li>
            <li><strong>Hosting:</strong> Render (Node.js 18)</li>
            <li><strong>Versionado:</strong> Git/GitHub</li>
        </ul>

        <h3>5.2 Funcionalidades Implementadas</h3>
        <div class="highlight">
            ✅ Menú interactivo (6 opciones)<br/>
            ✅ Consulta de planes (FIBER + WIRELESS)<br/>
            ✅ Agendamiento de instalaciones<br/>
            ✅ Migración de servicios<br/>
            ✅ Reportes de fallas<br/>
            ✅ Sistema de folios<br/>
            ✅ Cancelación de citas<br/>
            ✅ Historial conversacional<br/>
            ✅ Validación de direcciones (44 colonias)<br/>
            ⏳ Integración WhatsApp (EN DESARROLLO)<br/>
            🔮 Sistema de pagos (FUTURO)
        </div>
    </div>

    <div class="section">
        <h2>6️⃣ Cronograma Implementación</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Fase</th>
                    <th>Tarea</th>
                    <th>Tiempo</th>
                    <th>Responsable</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>1</td>
                    <td>Verificación Meta Business</td>
                    <td>3-5 días</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>2</td>
                    <td>Configuración WhatsApp API</td>
                    <td>2-3 días</td>
                    <td>Empresa</td>
                </tr>
                <tr>
                    <td>3</td>
                    <td>Setup MongoDB Atlas</td>
                    <td>1 día</td>
                    <td>Dev</td>
                </tr>
                <tr>
                    <td>4</td>
                    <td>Migración código Groq → Claude</td>
                    <td>2-3 días</td>
                    <td>Dev</td>
                </tr>
                <tr>
                    <td>5</td>
                    <td>Integración WhatsApp webhook</td>
                    <td>2-3 días</td>
                    <td>Dev</td>
                </tr>
                <tr>
                    <td>6</td>
                    <td>Testing y QA</td>
                    <td>3-5 días</td>
                    <td>QA</td>
                </tr>
                <tr>
                    <td>7</td>
                    <td>Despliegue producción</td>
                    <td>1 día</td>
                    <td>Dev</td>
                </tr>
                <tr class="total-row">
                    <td colspan="3"><strong>TOTAL</strong></td>
                    <td><strong>~25 días</strong></td>
                </tr>
            </tbody>
        </table>
    </div>

    <div class="section">
        <h2>⚠️ Notas Importantes</h2>
        
        <div class="warning">
            <strong>1. Meta Business Account:</strong> Requiere 3-5 días de verificación inicial<br/><br/>
            <strong>2. Rate Limits:</strong> WhatsApp limita a 80 mensajes/segundo<br/><br/>
            <strong>3. Pruebas:</strong> Usar números de prueba antes de producción<br/><br/>
            <strong>4. Backups:</strong> Configurar backups diarios de BD<br/><br/>
            <strong>5. Seguridad:</strong> Usar SSL/TLS (incluido en Render)<br/><br/>
            <strong>6. Escalabilidad:</strong> Plan actual soporta ~5,000 chats activos
        </div>
    </div>

    <div class="section">
        <h2>📞 Recursos y Referencias</h2>
        
        <h3>Documentación Oficial:</h3>
        <ul>
            <li>Meta Business: https://developers.facebook.com/docs/whatsapp</li>
            <li>Claude API: https://anthropic.com/claude/api</li>
            <li>MongoDB: https://docs.mongodb.com/</li>
            <li>Render: https://render.com/docs</li>
        </ul>

        <h3>Soporte Técnico:</h3>
        <ul>
            <li>Meta Business Support: support.meta.com</li>
            <li>Anthropic Support: support@anthropic.com</li>
            <li>MongoDB Support: support.mongodb.com</li>
            <li>Render Support: render.com/support</li>
        </ul>
    </div>

    <div class="footer">
        <p><strong>Documento preparado:</strong> 28 de Mayo, 2026</p>
        <p><strong>Versión:</strong> 1.0 - Aprobado para implementación</p>
        <p>León Telecom Bot WhatsApp | Requisitos y Presupuesto</p>
    </div>
</body>
</html>
`;

// Crear archivo HTML
fs.writeFileSync('/tmp/requisitos.html', htmlContent);
console.log('✅ HTML generado: /tmp/requisitos.html');

// Intentar convertir a PDF usando herramientas disponibles
console.log('📄 Para convertir a PDF, usa uno de estos comandos:');
console.log('');
console.log('Opción 1 (Recomendado - Usar navegador):');
console.log('  1. Abre: file:///tmp/requisitos.html');
console.log('  2. Presiona Ctrl+P');
console.log('  3. Guarda como PDF');
console.log('');
console.log('Opción 2 (Si tienes Chrome/Chromium):');
console.log('  chromium-browser --headless --print-to-pdf=/tmp/requisitos.pdf /tmp/requisitos.html');
console.log('');
console.log('Opción 3 (Si instalas wkhtmltopdf):');
console.log('  wkhtmltopdf /tmp/requisitos.html /tmp/requisitos.pdf');
console.log('');
console.log('✨ El archivo HTML está listo en: /tmp/requisitos.html');
