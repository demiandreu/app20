// ====================================================
// Database Service - Queries
// ====================================================

const { pool } = require('../config/database');

/**
 * Obtener checkin por session de WhatsApp
 */
async function getCheckinByPhone(phone) {
  const result = await pool.query(
    `SELECT c.* FROM whatsapp_sessions ws
     JOIN checkins c ON c.id = ws.checkin_id
     WHERE ws.phone = $1 
     ORDER BY ws.updated_at DESC 
     LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

/**
 * Crear/actualizar sesión de WhatsApp
 */
async function setWhatsAppSession(phone, checkinId) {
  await pool.query(
    `INSERT INTO whatsapp_sessions (phone, checkin_id, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (phone) 
     DO UPDATE SET checkin_id = EXCLUDED.checkin_id, updated_at = NOW()`,
    [phone, checkinId]
  );
}

/**
 * Buscar checkin por booking ID
 */
async function findCheckinByBookingId(bookingId) {
  const result = await pool.query(
    `SELECT * FROM checkins
     WHERE booking_token = $1 
        OR beds24_booking_id::text = $1 
        OR REPLACE(beds24_booking_id::text, ' ', '') = $1 
        OR booking_id_from_start = $1
     ORDER BY id DESC 
     LIMIT 1`,
    [bookingId]
  );
  return result.rows[0] || null;
}

/**
 * Actualizar idioma del checkin
 */
async function updateCheckinLanguage(checkinId, language) {
  await pool.query(
    `UPDATE checkins SET guest_language = $1 WHERE id = $2`,
    [language, checkinId]
  );
}

/**
 * Actualizar teléfono del checkin
 */
async function updateCheckinPhone(checkinId, phone) {
  await pool.query(
    `UPDATE checkins SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE id = $2`,
    [phone, checkinId]
  );
}

/**
 * Marcar registro como completado
 */
async function markRegistrationDone(checkinId) {
  await pool.query(
    `UPDATE checkins SET reg_done = true, reg_done_at = NOW() WHERE id = $1`,
    [checkinId]
  );
}

/**
 * Marcar pago como completado
 */
async function markPaymentDone(checkinId) {
  await pool.query(
    `UPDATE checkins SET pay_done = true, pay_done_at = NOW() WHERE id = $1`,
    [checkinId]
  );
}

/**
 * Obtener configuración de apartamento
 */
async function getRoomSettings(apartmentId) {
  const result = await pool.query(
    `SELECT * FROM beds24_rooms 
     WHERE beds24_room_id = $1 OR id::text = $1 
     LIMIT 1`,
    [String(apartmentId || '')]
  );
  return result.rows[0] || {};
}

/**
 * Obtener reglas de early/late checkout
 */
async function getCheckoutRules(apartmentId) {
  const result = await pool.query(
    `SELECT * FROM early_late_checkout_rules 
     WHERE apartment_id = $1 
     LIMIT 1`,
    [String(apartmentId || '')]
  );
  return result.rows[0] || null;
}

/**
 * Guardar/actualizar selección de horario
 */
async function saveTimeSelection(data) {
  const { checkinId, arrivalTime, arrivalSupplement, departureTime, departureSupplement, phone } = data;
  
  if (arrivalTime !== undefined) {
    // Primera vez: guardar hora de llegada
    await pool.query(
      `INSERT INTO checkin_time_selections (
        checkin_id, requested_arrival_time, confirmed_arrival_time,
        early_checkin_supplement, whatsapp_phone, approval_status, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      ON CONFLICT (checkin_id) DO UPDATE SET
        requested_arrival_time = EXCLUDED.requested_arrival_time,
        confirmed_arrival_time = EXCLUDED.confirmed_arrival_time,
        early_checkin_supplement = EXCLUDED.early_checkin_supplement,
        approval_status = 'pending',
        updated_at = NOW()`,
      [checkinId, arrivalTime, arrivalTime, arrivalSupplement, phone]
    );
  }
  
  if (departureTime !== undefined) {
    // Segunda vez: actualizar hora de salida
    await pool.query(
      `UPDATE checkin_time_selections SET 
        requested_departure_time = $1, 
        confirmed_departure_time = $2,
        late_checkout_supplement = $3, 
        approval_status = 'pending', 
        updated_at = NOW()
       WHERE checkin_id = $4`,
      [departureTime, departureTime, departureSupplement, checkinId]
    );
  }
}

/**
 * Obtener selección de horario
 */
async function getTimeSelection(checkinId) {
  const result = await pool.query(
    `SELECT * FROM checkin_time_selections WHERE checkin_id = $1`,
    [checkinId]
  );
  return result.rows[0] || null;
}

module.exports = {
  getCheckinByPhone,
  setWhatsAppSession,
  findCheckinByBookingId,
  updateCheckinLanguage,
  updateCheckinPhone,
  markRegistrationDone,
  markPaymentDone,
  getRoomSettings,
  getCheckoutRules,
  saveTimeSelection,
  getTimeSelection
};
