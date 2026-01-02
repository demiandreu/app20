// ====================================================
// Beds24 Webhook Route
// ====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

router.post('/booking', async (req, res) => {
  console.log('✅ Beds24 webhook hit:', req.body);

  try {
    const booking = req.body;
    const bookingId = booking.id;
    const roomId = booking.roomId;

    console.log(`📦 Booking received: ${bookingId}, Room: ${roomId}`);

    // Aquí iría la lógica de guardar el booking en la BD
    // Por ahora solo loggeamos

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Beds24 webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
