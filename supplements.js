// ====================================================
// Supplements Service - Cálculo de Suplementos
// ====================================================

const { getCheckoutRules } = require('./database');

/**
 * Parsear hora desde texto (formato: "14" o "14:00")
 */
function parseTime(text) {
  const match = text.trim().match(/^(\d{1,2})(?::00)?$/);
  if (match) {
    const hour = parseInt(match[1]);
    if (hour >= 0 && hour <= 23) {
      return hour;
    }
  }
  return null;
}

/**
 * Calcular suplemento para early check-in o late check-out
 */
async function calculateSupplement(apartmentId, requestedHour, type) {
  console.log(`💰 Calculating supplement: apartment=${apartmentId}, hour=${requestedHour}, type=${type}`);
  
  const rules = await getCheckoutRules(apartmentId);
  
  if (!rules) {
    console.log('⚠️  No rules found for apartment:', apartmentId);
    return { supplement: 0, found: false };
  }

  const standardTime = type === 'checkin' 
    ? rules.standard_checkin_time 
    : rules.standard_checkout_time;
  
  // Convertir TIME de DB a integer hora
  const standard = parseInt(String(standardTime).slice(0, 2));
  const requested = parseInt(requestedHour);

  console.log(`⏰ Times: requested=${requested}, standard=${standard}`);

  // Determinar si es early o late
  const isEarly = type === 'checkin' && requested < standard;
  const isLate = type === 'checkout' && requested > standard;

  if (!isEarly && !isLate) {
    console.log('✅ No supplement needed (within standard time)');
    return { supplement: 0, found: true };
  }

  // Construir opciones disponibles
  const options = [];
  
  if (type === 'checkin') {
    // Early check-in options
    if (rules.early_checkin_option1_time) {
      const hour1 = parseInt(String(rules.early_checkin_option1_time).slice(0, 2));
      options.push({ hour: hour1, price: parseFloat(rules.early_checkin_option1_price) || 0 });
    }
    if (rules.early_checkin_option2_time) {
      const hour2 = parseInt(String(rules.early_checkin_option2_time).slice(0, 2));
      options.push({ hour: hour2, price: parseFloat(rules.early_checkin_option2_price) || 0 });
    }
    if (rules.early_checkin_option3_time) {
      const hour3 = parseInt(String(rules.early_checkin_option3_time).slice(0, 2));
      options.push({ hour: hour3, price: parseFloat(rules.early_checkin_option3_price) || 0 });
    }
  } else {
    // Late checkout options
    if (rules.late_checkout_option1_time) {
      const hour1 = parseInt(String(rules.late_checkout_option1_time).slice(0, 2));
      options.push({ hour: hour1, price: parseFloat(rules.late_checkout_option1_price) || 0 });
    }
    if (rules.late_checkout_option2_time) {
      const hour2 = parseInt(String(rules.late_checkout_option2_time).slice(0, 2));
      options.push({ hour: hour2, price: parseFloat(rules.late_checkout_option2_price) || 0 });
    }
    if (rules.late_checkout_option3_time) {
      const hour3 = parseInt(String(rules.late_checkout_option3_time).slice(0, 2));
      options.push({ hour: hour3, price: parseFloat(rules.late_checkout_option3_price) || 0 });
    }
  }

  console.log('🎯 Available options:', options);

  // Buscar coincidencia exacta
  const exactMatch = options.find(opt => opt.hour === requested);
  
  if (exactMatch) {
    console.log(`✅ Exact match found: ${exactMatch.hour}:00 = ${exactMatch.price}€`);
    return { supplement: exactMatch.price, found: true };
  }

  console.log('⚠️  No exact match found for requested hour');
  return { supplement: 0, found: false };
}

module.exports = { parseTime, calculateSupplement };
