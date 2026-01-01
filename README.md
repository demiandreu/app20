# RCS Check-in System v2.0

Sistema de check-in automatizado para apartamentos turísticos con WhatsApp bot multiidioma.

## 📁 Estructura del Proyecto

```
proyecto/
├── index.js                    # Servidor principal (50 líneas)
├── config/
│   ├── database.js            # PostgreSQL configuración + init
│   └── twilio.js              # Twilio/WhatsApp config
├── routes/
│   ├── whatsapp.js            # Webhook de WhatsApp
│   ├── beds24.js              # Webhook de Beds24
│   └── staff.js               # API panel de staff
├── services/
│   ├── whatsappBot.js         # Lógica del bot
│   ├── supplements.js         # Cálculo de suplementos
│   └── database.js            # Queries de BD
├── data/
│   └── translations.js        # Textos multiidioma (ES/EN/FR/RU)
├── package.json
├── .env.example
└── README.md
```

## 🚀 Instalación

```bash
# 1. Clonar proyecto
git clone <tu-repo>
cd proyecto

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 4. Iniciar servidor
npm start
```

## 🔧 Variables de Entorno

```env
DATABASE_URL=postgresql://...
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
PORT=3000
```

## 📱 Flujo del Bot de WhatsApp

1. **START_BOOKINGID_es** → Inicia conversación
2. **REGOK** → Confirma registro completado
3. **PAYOK** → Confirma pago completado
4. **15** → Selecciona hora de llegada (ej: 15:00)
5. **12** → Selecciona hora de salida (ej: 12:00)

## 🌍 Idiomas Soportados

- 🇪🇸 Español (es)
- 🇬🇧 English (en)
- 🇫🇷 Français (fr)
- 🇷🇺 Русский (ru)

## 📊 Base de Datos

Tablas creadas automáticamente al iniciar:
- `checkins` - Reservas
- `whatsapp_sessions` - Sesiones activas
- `beds24_rooms` - Configuración de apartamentos
- `early_late_checkout_rules` - Reglas de suplementos
- `checkin_time_selections` - Selecciones de horario

## 🛠️ Desarrollo

```bash
# Modo desarrollo (auto-restart)
npm run dev
```

## 📝 Notas Importantes

- Código modular: cada archivo tiene una responsabilidad específica
- Fácil de mantener y extender
- Testing individual por módulo
- Sin duplicación de código

## 🐛 Troubleshooting

**Bot no responde:**
- Verificar logs con `console.log`
- Revisar credenciales de Twilio en `.env`
- Confirmar que webhook está configurado en Twilio

**Error de base de datos:**
- Verificar `DATABASE_URL`
- Confirmar que PostgreSQL está accesible
- Revisar logs de inicialización

## 📞 Soporte

Para problemas o preguntas, revisar logs del servidor.
