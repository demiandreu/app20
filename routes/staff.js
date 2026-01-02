// ====================================================
// Staff Panel Route - Panel de Limpieza/Staff
// ====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Vista principal del staff
router.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    
    // Check-ins de hoy y mañana
    const { rows } = await pool.query(`
      SELECT 
        c.*,
        cts.requested_arrival_time,
        cts.requested_departure_time,
        cts.approval_status
      FROM checkins c
      LEFT JOIN checkin_time_selections cts ON cts.checkin_id = c.id
      WHERE c.arrival_date >= $1 AND c.arrival_date <= $1::date + interval '1 day'
      ORDER BY c.arrival_date, c.arrival_time
    `, [today]);

    res.send(generateStaffHTML(rows));

  } catch (error) {
    console.error('❌ Staff panel error:', error);
    res.status(500).send('Error al cargar el panel de staff');
  }
});

// Marcar apartamento como limpio
router.post('/mark-clean/:id', async (req, res) => {
  try {
    await pool.query(`
      UPDATE checkins 
      SET clean_ok = true 
      WHERE id = $1
    `, [req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Mark clean error:', error);
    res.status(500).json({ error: 'Error' });
  }
});

// API para solicitudes pendientes (para compatibilidad)
router.get('/pending-requests', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        cts.*,
        c.full_name,
        c.phone,
        c.apartment_name,
        c.arrival_date,
        c.departure_date
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      WHERE cts.approval_status = 'pending'
      ORDER BY cts.created_at DESC
    `);

    res.json({
      success: true,
      requests: rows
    });
  } catch (error) {
    console.error('❌ Staff panel error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function generateStaffHTML(checkins) {
  const today = new Date().toISOString().slice(0, 10);
  const todayCheckins = checkins.filter(c => String(c.arrival_date).slice(0, 10) === today);
  const tomorrowCheckins = checkins.filter(c => String(c.arrival_date).slice(0, 10) !== today);

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel de Staff - Limpieza</title>
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
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: white;
      margin-bottom: 30px;
      font-size: 32px;
      text-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .section {
      background: white;
      border-radius: 16px;
      padding: 25px;
      margin-bottom: 25px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    h2 {
      color: #667eea;
      margin-bottom: 20px;
      font-size: 20px;
      border-bottom: 2px solid #f0f0f0;
      padding-bottom: 10px;
    }
    .checkin-card {
      background: #f8f9ff;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 15px;
      border-left: 5px solid #667eea;
    }
    .checkin-card.clean {
      border-left-color: #28a745;
      background: #f0fff4;
    }
    .checkin-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .guest-name {
      font-size: 18px;
      font-weight: 600;
      color: #333;
    }
    .apartment-name {
      font-size: 14px;
      color: #666;
      margin-top: 3px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-top: 15px;
    }
    .info-item {
      font-size: 13px;
    }
    .info-label {
      color: #888;
      margin-bottom: 3px;
    }
    .info-value {
      color: #333;
      font-weight: 600;
    }
    .code-box {
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 8px;
      padding: 10px;
      text-align: center;
      margin-top: 10px;
    }
    .code-label {
      font-size: 11px;
      color: #856404;
      margin-bottom: 3px;
    }
    .code-value {
      font-size: 24px;
      font-weight: bold;
      color: #856404;
      letter-spacing: 2px;
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.3s;
    }
    .btn-clean {
      background: #28a745;
      color: white;
    }
    .btn-clean:hover {
      background: #218838;
    }
    .btn-clean:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      margin-left: 10px;
    }
    .badge-clean {
      background: #d4edda;
      color: #155724;
    }
    .badge-pending {
      background: #fff3cd;
      color: #856404;
    }
    .empty {
      text-align: center;
      padding: 40px;
      color: #95a5a6;
    }
    @media (max-width: 768px) {
      .info-grid {
        grid-template-columns: 1fr;
      }
      .checkin-header {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧹 Panel de Limpieza</h1>

    <div class="section">
      <h2>📅 Check-ins de Hoy</h2>
      ${todayCheckins.length > 0 ? todayCheckins.map(c => generateCheckinCard(c)).join('') : '<div class="empty">No hay check-ins para hoy</div>'}
    </div>

    <div class="section">
      <h2>📆 Check-ins de Mañana</h2>
      ${tomorrowCheckins.length > 0 ? tomorrowCheckins.map(c => generateCheckinCard(c)).join('') : '<div class="empty">No hay check-ins para mañana</div>'}
    </div>

  </div>

  <script>
    async function markClean(id) {
      if (!confirm('¿Marcar apartamento como limpio?')) return;
      
      try {
        const res = await fetch('/staff/mark-clean/' + id, {
          method: 'POST'
        });
        
        if (res.ok) {
          location.reload();
        } else {
          alert('Error al marcar como limpio');
        }
      } catch (error) {
        alert('Error: ' + error.message);
      }
    }

    // Auto-refresh cada 60 segundos
    setTimeout(() => location.reload(), 60000);
  </script>
</body>
</html>
  `;
}

function generateCheckinCard(c) {
  const arrivalTime = c.requested_arrival_time || (c.arrival_time ? String(c.arrival_time).slice(0, 5) : '17:00');
  const adults = Number(c.adults || 0);
  const children = Number(c.children || 0);
  const guestsText = `${adults} adultos${children ? `, ${children} niños` : ''}`;

  return `
    <div class="checkin-card ${c.clean_ok ? 'clean' : ''}">
      <div class="checkin-header">
        <div>
          <div class="guest-name">
            ${c.full_name}
            ${c.clean_ok ? '<span class="badge badge-clean">✓ Limpio</span>' : '<span class="badge badge-pending">Pendiente</span>'}
          </div>
          <div class="apartment-name">🏠 ${c.apartment_name || c.apartment_id}</div>
        </div>
        ${!c.clean_ok ? `
          <button class="btn btn-clean" onclick="markClean(${c.id})">
            ✓ Marcar Limpio
          </button>
        ` : ''}
      </div>

      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">⏰ Hora de llegada</div>
          <div class="info-value">${arrivalTime}:00</div>
        </div>
        <div class="info-item">
          <div class="info-label">👥 Huéspedes</div>
          <div class="info-value">${guestsText}</div>
        </div>
        <div class="info-item">
          <div class="info-label">📞 Teléfono</div>
          <div class="info-value">${c.phone || '—'}</div>
        </div>
        <div class="info-item">
          <div class="info-label">📧 Email</div>
          <div class="info-value">${c.email || '—'}</div>
        </div>
      </div>

      ${c.lock_code ? `
        <div class="code-box">
          <div class="code-label">🔑 Código de Acceso</div>
          <div class="code-value">${c.lock_code}</div>
        </div>
      ` : ''}
    </div>
  `;
}

module.exports = router;
