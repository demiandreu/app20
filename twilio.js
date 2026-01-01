// ====================================================
// Twilio Configuration
// ====================================================

const twilio = require('twilio');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';

const twilioClient = 
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

if (!twilioClient) {
  console.log('ℹ️  Twilio not configured (missing credentials)');
}

/**
 * Enviar mensaje de WhatsApp
 */
async function sendWhatsApp(toE164, text) {
  if (!twilioClient) {
    console.log('ℹ️  Twilio client is null. Skip send.');
    return null;
  }

  if (!TWILIO_WHATSAPP_FROM) {
    console.log('ℹ️  TWILIO_WHATSAPP_FROM missing. Skip send.');
    return null;
  }

  const to = String(toE164).startsWith('whatsapp:')
    ? String(toE164)
    : `whatsapp:${String(toE164).trim()}`;

  try {
    const msg = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to,
      body: text
    });

    console.log('✅ WhatsApp sent:', msg.sid);
    return msg;
  } catch (error) {
    console.error('❌ WhatsApp send error:', error.message);
    return null;
  }
}

module.exports = { twilioClient, sendWhatsApp };
