// ====================================================
// WhatsApp Bot Service - Lógica del Bot
// ====================================================

const { sendWhatsApp } = require('../config/twilio');
const { translations, timeRequestTexts } = require('../data/translations');
const { parseTime, calculateSupplement } = require('./supplements');
const db = require('./database');

/**
 * Procesar mensaje de WhatsApp
 */
async function processMessage(from, body) {
  const phone = from.replace('whatsapp:', '').trim();
  const textUpper = body.toUpperCase().trim();

  console.log('📩 Processing message:', { phone, body, textUpper });

  // ===== COMANDO: START =====
  const startMatch = textUpper.match(/^START[\s_:-]*([0-9]+)[\s_:-]*([A-Z]{2})?\s*$/);
  if (startMatch) {
    return await handleStart(phone, from, startMatch);
  }

  // ===== COMANDO: REGOK =====
  if (textUpper === 'REGOK') {
    return await handleRegOk(phone, from);
  }

  // ===== COMANDO: PAYOK =====
  if (textUpper === 'PAYOK') {
    return await handlePayOk(phone, from);
  }

  // ===== DETECCIÓN DE HORA =====
  const timeValue = parseTime(body);
  if (timeValue !== null) {
    return await handleTimeInput(phone, from, timeValue);
  }

  // Mensaje no reconocido
  console.log('ℹ️  Message not recognized');
  return { success: true };
}

/**
 * Manejar comando START
 */
async function handleStart(phone, from, startMatch) {
  const bookingId = String(startMatch[1] || '').trim();
  const langCode = (startMatch[2] || 'es').toLowerCase();
  const supportedLangs = ['es', 'en', 'fr', 'ru'];
  const lang = supportedLangs.includes(langCode) ? langCode : 'en';
  const t = translations[lang];

  console.log('🚀 START command:', { bookingId, lang });

  const checkin = await db.findCheckinByBookingId(bookingId);

  if (!checkin) {
    await sendWhatsApp(from, `${t.notFound}\nSTART ${bookingId}`);
    return { success: true };
  }

  // Actualizar idioma si se especificó
  if (startMatch[2]) {
    await db.updateCheckinLanguage(checkin.id, lang);
  }

  // Crear sesión
  await db.setWhatsAppSession(phone, checkin.id);
  await db.updateCheckinPhone(checkin.id, phone);

  // Obtener configuración del apartamento
  const room = await db.getRoomSettings(checkin.apartment_id);
  const bookIdForLinks = String(
    checkin.beds24_booking_id || 
    checkin.booking_id_from_start || 
    checkin.booking_token || ''
  ).replace(/\s/g, '');

  const regLink = (room.registration_url || '').replace(/\[BOOKID\]/g, bookIdForLinks);

  // Preparar datos
  const name = checkin.full_name || '';
  const apt = checkin.apartment_name || checkin.apartment_id || '';
  const arriveDate = checkin.arrival_date ? String(checkin.arrival_date).slice(0, 10) : '';
  const departDate = checkin.departure_date ? String(checkin.departure_date).slice(0, 10) : '';
  const arriveTime = (checkin.arrival_time ? String(checkin.arrival_time).slice(0, 5) : '') || 
                     String(room.default_arrival_time || '').slice(0, 5) || '17:00';
  const departTime = (checkin.departure_time ? String(checkin.departure_time).slice(0, 5) : '') || 
                     String(room.default_departure_time || '').slice(0, 5) || '11:00';
  const adults = Number(checkin.adults || 0);
  const children = Number(checkin.children || 0);
  const sText = adults || children 
    ? `${adults} ${t.adults}${children ? `, ${children} ${t.children}` : ''}` 
    : '—';

  // Enviar mensaje de bienvenida
  await sendWhatsApp(from, `${t.greeting}, ${name} 👋

${t.bookingConfirmed} ✅

🏠 ${t.apartment}: ${apt}
📅 ${t.checkin}: ${arriveDate}, ${arriveTime}
📅 ${t.checkout}: ${departDate}, ${departTime}
👥 ${t.guests}: ${sText}

${t.registerInstructions}
${regLink || '—'}

${t.afterReg}`);

  return { success: true };
}

/**
 * Manejar comando REGOK
 */
async function handleRegOk(phone, from) {
  console.log('✅ REGOK command');

  const checkin = await db.getCheckinByPhone(phone);
  if (!checkin) {
    await sendWhatsApp(from, `${translations.es.noBooking} START 123456`);
    return { success: true };
  }

  const lang = checkin.guest_language || 'es';
  const t = translations[lang];

  await db.markRegistrationDone(checkin.id);

  const room = await db.getRoomSettings(checkin.apartment_id);
  const bookIdForLinks = String(
    checkin.beds24_booking_id || 
    checkin.booking_id_from_start || 
    checkin.booking_token || ''
  ).replace(/\s/g, '');

  const payLink = (room.payment_url || '').replace(/\[BOOKID\]/g, bookIdForLinks);

  await sendWhatsApp(from, `${t.regConfirmed}\n\n${payLink || '—'}\n\n${t.afterPay}`);

  return { success: true };
}

/**
 * Manejar comando PAYOK
 */
async function handlePayOk(phone, from) {
  console.log('💳 PAYOK command');

  const checkin = await db.getCheckinByPhone(phone);
  if (!checkin) {
    await sendWhatsApp(from, `${translations.es.noBooking} START 123456`);
    return { success: true };
  }

  const lang = checkin.guest_language || 'es';
  const t = translations[lang];
  const tt = timeRequestTexts[lang];

  await db.markPaymentDone(checkin.id);

  const room = await db.getRoomSettings(checkin.apartment_id);
  const standardTime = String(room.default_arrival_time || '17:00').slice(0, 5);

  await sendWhatsApp(
    from,
    t.payConfirmed + '\n\n' + tt.arrivalRequest.replace('{time}', standardTime)
  );

  return { success: true };
}

/**
 * Manejar entrada de hora (llegada o salida)
 */
async function handleTimeInput(phone, from, timeValue) {
  console.log('⏰ Time input:', timeValue);

  const checkin = await db.getCheckinByPhone(phone);
  if (!checkin) {
    return { success: true };
  }

  const lang = checkin.guest_language || 'es';
  const tt = timeRequestTexts[lang];

  // Verificar si ya existe una selección de horario
  const timeSelection = await db.getTimeSelection(checkin.id);
  const hasArrival = timeSelection && timeSelection.requested_arrival_time !== null;

  if (!hasArrival) {
    // Primera entrada: hora de LLEGADA
    console.log('🔵 Processing ARRIVAL time');

    const calc = await calculateSupplement(checkin.apartment_id, timeValue, 'checkin');

    await db.saveTimeSelection({
      checkinId: checkin.id,
      arrivalTime: timeValue,
      arrivalSupplement: calc.supplement,
      phone
    });

    const room = await db.getRoomSettings(checkin.apartment_id);
    const standardTime = String(room.default_departure_time || '11:00').slice(0, 5);

    await sendWhatsApp(
      from,
      tt.arrivalConfirmed
        .replace('{time}', timeValue)
        .replace('{price}', calc.supplement.toFixed(2)) +
      tt.standardCheckout.replace('{time}', standardTime)
    );

  } else {
    // Segunda entrada: hora de SALIDA
    console.log('🔴 Processing DEPARTURE time');

    const calc = await calculateSupplement(checkin.apartment_id, timeValue, 'checkout');

    await db.saveTimeSelection({
      checkinId: checkin.id,
      departureTime: timeValue,
      departureSupplement: calc.supplement
    });

    // Obtener la selección actualizada
    const updated = await db.getTimeSelection(checkin.id);
    const totalSupplement = parseFloat(updated.early_checkin_supplement || 0) + calc.supplement;

    await sendWhatsApp(
      from,
      tt.departureConfirmed
        .replace('{arrival}', updated.requested_arrival_time)
        .replace('{arrivalPrice}', parseFloat(updated.early_checkin_supplement || 0).toFixed(0))
        .replace('{departure}', timeValue)
        .replace('{departurePrice}', calc.supplement.toFixed(0))
        .replace('{total}', totalSupplement.toFixed(2))
    );
  }

  return { success: true };
}

module.exports = { processMessage };
