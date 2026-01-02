// ====================================================
// Guest Panel Route - Panel de Huéspedes
// ====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Vista del panel de huéspedes
router.get('/:token', async (req, res) => {
  try {
    const token = req.params.token;
    
    // Buscar checkin por token
    const { rows } = await pool.query(
      `SELECT c.*, r.name as room_name, r.keys_instructions_url
       FROM checkins c
       LEFT JOIN beds24_rooms r ON r.beds24_room_id = c.apartment_id
       WHERE c.booking_token = $1 OR c.beds24_booking_id::text = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reserva No Encontrada</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              max-width: 600px;
              margin: 50px auto;
              padding: 20px;
              text-align: center;
            }
            .error {
              background: #fee;
              border: 1px solid #fcc;
              border-radius: 8px;
              padding: 30px;
            }
            h1 { color: #c33; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Reserva No Encontrada</h1>
            <p>No pudimos encontrar tu reserva con el código proporcionado.</p>
            <p>Por favor verifica el enlace.</p>
          </div>
        </body>
        </html>
      `);
    }

    const checkin = rows[0];
    
    // Obtener secciones del apartamento si existen
    let sections = [];
    try {
      const sectionsResult = await pool.query(
        `SELECT * FROM apartment_sections 
         WHERE apartment_id = $1 
         ORDER BY display_order`,
        [checkin.apartment_id]
      );
      sections = sectionsResult.rows;
    } catch (error) {
      // Tabla no existe aún - no hay problema
      console.log('ℹ️  apartment_sections table not found - skipping sections');
    }

    // Generar HTML del panel
    res.send(generateGuestHTML(checkin, sections));

  } catch (error) {
    console.error('❌ Guest panel error:', error);
    res.status(500).send('Error al cargar el panel');
  }
});

function generateGuestHTML(checkin, sections) {
  const lang = checkin.guest_language || 'es';
  
  const texts = {
    es: {
      title: 'Panel de Huésped',
      booking: 'Reserva',
      apartment: 'Apartamento',
      checkin: 'Entrada',
      checkout: 'Salida',
      guests: 'Huéspedes',
      adults: 'adultos',
      children: 'niños',
      accessCode: 'Código de Acceso',
      instructions: 'Instrucciones',
      sections: 'Información del Apartamento',
      viewInstructions: 'Ver Instrucciones de Llaves',
      status: 'Estado',
      regDone: 'Registro Completado',
      payDone: 'Pago Completado',
      pending: 'Pendiente'
    },
    en: {
      title: 'Guest Panel',
      booking: 'Booking',
      apartment: 'Apartment',
      checkin: 'Check-in',
      checkout: 'Check-out',
      guests: 'Guests',
      adults: 'adults',
      children: 'children',
      accessCode: 'Access Code',
      instructions: 'Instructions',
      sections: 'Apartment Information',
      viewInstructions: 'View Key Instructions',
      status: 'Status',
      regDone: 'Registration Completed',
      payDone: 'Payment Completed',
      pending: 'Pending'
    }
  };

  const t = texts[lang] || texts.es;

  const arrivalDate = checkin.arrival_date ? String(checkin.arrival_date).slice(0, 10) : '';
  const departureDate = checkin.departure_date ? String(checkin.departure_date).slice(0, 10) : '';
  const arrivalTime = checkin.arrival_time ? String(checkin.arrival_time).slice(0, 5) : '17:00';
  const departureTime = checkin.departure_time ? String(checkin.departure_time).slice(0, 5) : '11:00';

  const adults = Number(checkin.adults || 0);
  const children = Number(checkin.children || 0);
  const guestsText = `${adults} ${t.adults}${children ? `, ${children} ${t.children}` : ''}`;

  const showLockCode = checkin.lock_visible && checkin.lock_code;

  return `
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.title} - ${checkin.full_name}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    h2 {
      color: #667eea;
      margin-bottom: 20px;
      font-size: 20px;
      border-bottom: 2px solid #f0f0f0;
      padding-bottom: 10px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .info-item {
      padding: 15px;
      background: #f8f9ff;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    .info-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .info-value {
      font-size: 18px;
      color: #333;
      font-weight: 600;
    }
    .code-display {
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin: 20px 0;
    }
    .code-label {
      font-size: 14px;
      color: #856404;
      margin-bottom: 10px;
    }
    .code-value {
      font-size: 36px;
      font-weight: bold;
      color: #856404;
      letter-spacing: 3px;
    }
    .status-badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-right: 10px;
    }
    .status-success {
      background: #d4edda;
      color: #155724;
    }
    .status-warning {
      background: #fff3cd;
      color: #856404;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      transition: background 0.3s;
      margin-top: 10px;
    }
    .btn:hover {
      background: #5568d3;
    }
    .section {
      background: #f8f9ff;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .section:hover {
      background: #eff1ff;
    }
    .section-title {
      font-weight: 600;
      color: #333;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .section-icon {
      font-size: 24px;
    }
    .section-content {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #ddd;
      display: none;
      color: #666;
      line-height: 1.6;
    }
    .section.active .section-content {
      display: block;
    }
    @media (max-width: 600px) {
      .card {
        padding: 20px;
      }
      h1 {
        font-size: 22px;
      }
      .info-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    
    <div class="card">
      <h1>👋 ${checkin.full_name}</h1>
      <p style="color: #666; margin-bottom: 20px;">${t.title}</p>
      
      <div style="margin-bottom: 20px;">
        <span class="status-badge ${checkin.reg_done ? 'status-success' : 'status-warning'}">
          ${checkin.reg_done ? '✓' : '⏳'} ${t.regDone}
        </span>
        <span class="status-badge ${checkin.pay_done ? 'status-success' : 'status-warning'}">
          ${checkin.pay_done ? '✓' : '⏳'} ${t.payDone}
        </span>
      </div>

      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">🏠 ${t.apartment}</div>
          <div class="info-value">${checkin.apartment_name || checkin.room_name || checkin.apartment_id}</div>
        </div>
        <div class="info-item">
          <div class="info-label">📅 ${t.checkin}</div>
          <div class="info-value">${arrivalDate} ${arrivalTime}</div>
        </div>
        <div class="info-item">
          <div class="info-label">📅 ${t.checkout}</div>
          <div class="info-value">${departureDate} ${departureTime}</div>
        </div>
        <div class="info-item">
          <div class="info-label">👥 ${t.guests}</div>
          <div class="info-value">${guestsText}</div>
        </div>
      </div>

      ${showLockCode ? `
        <div class="code-display">
          <div class="code-label">🔑 ${t.accessCode}</div>
          <div class="code-value">${checkin.lock_code}</div>
        </div>
      ` : ''}

      ${checkin.keys_instructions_url ? `
        <a href="${checkin.keys_instructions_url}" target="_blank" class="btn">
          📖 ${t.viewInstructions}
        </a>
      ` : ''}
    </div>

    ${sections.length > 0 ? `
      <div class="card">
        <h2>${t.sections}</h2>
        ${sections.map(section => `
          <div class="section" onclick="toggleSection(this)">
            <div class="section-title">
              <span class="section-icon">${section.icon || '📌'}</span>
              <span>${section.title}</span>
            </div>
            <div class="section-content">
              ${section.content || ''}
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

  </div>

  <script>
    function toggleSection(element) {
      element.classList.toggle('active');
    }
  </script>
</body>
</html>
  `;
}

module.exports = router;
