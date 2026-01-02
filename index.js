// ====================================================
// RCS Check-in System - Servidor Principal
// Versión 2.0 - Estructura Modular
// ====================================================

require('dotenv').config();
const express = require('express');
const { initDb } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ROUTES =====
app.use('/webhooks/twilio', require('./routes/whatsapp'));
app.use('/webhooks/beds24', require('./routes/beds24'));
app.use('/staff', require('./routes/staff'));
app.use('/manager', require('./routes/manager'));
app.use('/guest', require('./routes/guest'));

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'RCS Check-in API',
    version: '2.0.0',
    endpoints: {
      whatsapp: '/webhooks/twilio/whatsapp',
      beds24: '/webhooks/beds24/booking',
      staff: '/staff',
      manager: '/manager',
      guest: '/guest/:token'
    }
  });
});

// ===== START SERVER =====
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log('✅ RCS Check-in API running on port', PORT);
    });
  } catch (error) {
    console.error('❌ Server startup error:', error);
    process.exit(1);
  }
})();
