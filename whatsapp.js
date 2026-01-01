// ====================================================
// WhatsApp Webhook Route
// ====================================================

const express = require('express');
const router = express.Router();
const { processMessage } = require('../services/whatsappBot');

router.post('/whatsapp', async (req, res) => {
  console.log('🔥 TWILIO HIT', req.body);

  try {
    const from = String(req.body.From || '');
    const body = String(req.body.Body || '').trim();

    if (!from || !body) {
      return res.status(200).send('OK');
    }

    await processMessage(from, body);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ WhatsApp webhook error:', error);
    res.status(200).send('OK');
  }
});

module.exports = router;
