// ====================================================
// Manager Panel Route - Panel de Gestión
// ====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { sendWhatsApp } = require('../config/twilio');

// Vista principal del manager
router.get('/', async (req, res) => {
  try {
    // Obtener solicitudes pendientes
    const pendingResult = await pool.query(`
      SELECT 
        cts.*,
        c.full_name,
        c.phone,
        c.apartment_name,
        c.apartment_id,
        c.arrival_date,
        c.departure_date,
        c.beds24_booking_id
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      WHERE cts.approval_status = 'pending'
      ORDER BY cts.created_at DESC
    `);

    // Obtener solicitudes aprobadas recientes
    const approvedResult = await pool.query(`
      SELECT 
        cts.*,
        c.full_name,
        c.apartment_name
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      WHERE cts.approval_status = 'approved'
      ORDER BY cts.approval_status_updated_at DESC
      LIMIT 10
    `);

    // Obtener próximos check-ins
    const upcomingResult = await pool.query(`
      SELECT 
        c.*,
        cts.requested_arrival_time,
        cts.requested_departure_time,
        cts.early_checkin_supplement,
        cts.late_checkout_supplement,
        cts.approval_status
      FROM checkins c
      LEFT JOIN checkin_time_selections cts ON cts.checkin_id = c.id
      WHERE c.arrival_date >= CURRENT_DATE
      ORDER BY c.arrival_date, c.arrival_time
      LIMIT 20
    `);

    res.send(generateManagerHTML(
      pendingResult.rows,
      approvedResult.rows,
      upcomingResult.rows
    ));

  } catch (error) {
    console.error('❌ Manager panel error:', error);
    res.status(500).send('Error al cargar el panel de manager');
  }
});

// Aprobar solicitud
router.post('/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    await pool.query(`
      UPDATE checkin_time_selections
      SET approval_status = 'approved',
          approval_status_updated_at = NOW(),
          approved_by = 'manager',
          manager_notes = $1
      WHERE id = $2
    `, [notes || '', id]);

    // Obtener datos para notificar al huésped
    const { rows } = await pool.query(`
      SELECT cts.*, c.phone, c.guest_language, c.full_name
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      WHERE cts.id = $1
    `, [id]);

    if (rows[0] && rows[0].phone) {
      const selection = rows[0];
      const lang = selection.guest_language || 'es';
      
      const messages = {
        es: `✅ ¡Solicitud Aprobada!

📅 Entrada: ${selection.confirmed_arrival_time}:00
📅 Salida: ${selection.confirmed_departure_time}:00
💰 Suplemento: ${(parseFloat(selection.early_checkin_supplement || 0) + parseFloat(selection.late_checkout_supplement || 0)).toFixed(2)}€

Tu reserva está confirmada.`,
        en: `✅ Request Approved!

📅 Check-in: ${selection.confirmed_arrival_time}:00
📅 Check-out: ${selection.confirmed_departure_time}:00
💰 Supplement: ${(parseFloat(selection.early_checkin_supplement || 0) + parseFloat(selection.late_checkout_supplement || 0)).toFixed(2)}€

Your booking is confirmed.`
      };

      await sendWhatsApp(`whatsapp:${selection.phone}`, messages[lang] || messages.es);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Approve error:', error);
    res.status(500).json({ error: 'Error al aprobar' });
  }
});

// Rechazar solicitud
router.post('/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    await pool.query(`
      UPDATE checkin_time_selections
      SET approval_status = 'rejected',
          approval_status_updated_at = NOW(),
          approved_by = 'manager',
          rejection_reason = $1
      WHERE id = $2
    `, [reason || '', id]);

    // Notificar al huésped
    const { rows } = await pool.query(`
      SELECT cts.*, c.phone, c.guest_language
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      WHERE cts.id = $1
    `, [id]);

    if (rows[0] && rows[0].phone) {
      const lang = rows[0].guest_language || 'es';
      
      const messages = {
        es: `❌ Solicitud No Disponible

Lo sentimos, los horarios solicitados no están disponibles.
${reason ? `\nMotivo: ${reason}` : ''}

Por favor contacta con nosotros para alternativas.`,
        en: `❌ Request Not Available

Sorry, the requested times are not available.
${reason ? `\nReason: ${reason}` : ''}

Please contact us for alternatives.`
      };

      await sendWhatsApp(`whatsapp:${rows[0].phone}`, messages[lang] || messages.es);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Reject error:', error);
    res.status(500).json({ error: 'Error al rechazar' });
  }
});

function generateManagerHTML(pending, approved, upcoming) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel de Manager</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f7fa;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      color: #2c3e50;
      margin-bottom: 30px;
      font-size: 32px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border-left: 4px solid #3498db;
    }
    .stat-label {
      font-size: 14px;
      color: #7f8c8d;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 32px;
      font-weight: bold;
      color: #2c3e50;
    }
    .section {
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      margin-bottom: 25px;
    }
    h2 {
      color: #34495e;
      margin-bottom: 20px;
      font-size: 20px;
      border-bottom: 2px solid #ecf0f1;
      padding-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #ecf0f1;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #2c3e50;
      font-size: 14px;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #ecf0f1;
      font-size: 14px;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-pending {
      background: #fff3cd;
      color: #856404;
    }
    .badge-approved {
      background: #d4edda;
      color: #155724;
    }
    .badge-rejected {
      background: #f8d7da;
      color: #721c24;
    }
    .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.3s;
      margin-right: 5px;
    }
    .btn-approve {
      background: #28a745;
      color: white;
    }
    .btn-approve:hover {
      background: #218838;
    }
    .btn-reject {
      background: #dc3545;
      color: white;
    }
    .btn-reject:hover {
      background: #c82333;
    }
    .empty {
      text-align: center;
      padding: 40px;
      color: #95a5a6;
    }
    @media (max-width: 768px) {
      .container {
        padding: 10px;
      }
      table {
        font-size: 12px;
      }
      th, td {
        padding: 8px 4px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Panel de Manager</h1>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">⏳ Solicitudes Pendientes</div>
        <div class="stat-value">${pending.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">✅ Aprobadas Hoy</div>
        <div class="stat-value">${approved.filter(a => {
          const today = new Date().toISOString().slice(0, 10);
          const approvedDate = a.approval_status_updated_at ? String(a.approval_status_updated_at).slice(0, 10) : '';
          return approvedDate === today;
        }).length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">📅 Próximos Check-ins</div>
        <div class="stat-value">${upcoming.length}</div>
      </div>
    </div>

    <div class="section">
      <h2>⏳ Solicitudes Pendientes de Aprobación</h2>
      ${pending.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Huésped</th>
              <th>Apartamento</th>
              <th>Fechas</th>
              <th>Llegada</th>
              <th>Salida</th>
              <th>Suplemento</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${pending.map(req => {
              const total = (parseFloat(req.early_checkin_supplement || 0) + parseFloat(req.late_checkout_supplement || 0)).toFixed(2);
              const arrivalDate = req.arrival_date ? String(req.arrival_date).slice(0, 10) : '';
              const departureDate = req.departure_date ? String(req.departure_date).slice(0, 10) : '';
              
              return `
                <tr>
                  <td><strong>${req.full_name}</strong><br><small>${req.phone || ''}</small></td>
                  <td>${req.apartment_name || req.apartment_id}</td>
                  <td>${arrivalDate} → ${departureDate}</td>
                  <td>${req.requested_arrival_time}:00</td>
                  <td>${req.requested_departure_time}:00</td>
                  <td><strong>${total}€</strong></td>
                  <td>
                    <button class="btn btn-approve" onclick="approve(${req.id})">✓ Aprobar</button>
                    <button class="btn btn-reject" onclick="reject(${req.id})">✗ Rechazar</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : '<div class="empty">✅ No hay solicitudes pendientes</div>'}
    </div>

    <div class="section">
      <h2>📅 Próximos Check-ins</h2>
      ${upcoming.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Huésped</th>
              <th>Apartamento</th>
              <th>Llegada</th>
              <th>Salida</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${upcoming.map(c => {
              const arrivalDate = c.arrival_date ? String(c.arrival_date).slice(0, 10) : '';
              const arrivalTime = c.requested_arrival_time || (c.arrival_time ? String(c.arrival_time).slice(0, 5) : '17:00');
              const departureTime = c.requested_departure_time || (c.departure_time ? String(c.departure_time).slice(0, 5) : '11:00');
              
              let statusBadge = '<span class="badge badge-pending">Pendiente</span>';
              if (c.approval_status === 'approved') statusBadge = '<span class="badge badge-approved">Aprobado</span>';
              if (c.approval_status === 'rejected') statusBadge = '<span class="badge badge-rejected">Rechazado</span>';
              
              return `
                <tr>
                  <td>${arrivalDate}</td>
                  <td><strong>${c.full_name}</strong></td>
                  <td>${c.apartment_name || c.apartment_id}</td>
                  <td>${arrivalTime}:00</td>
                  <td>${departureTime}:00</td>
                  <td>${statusBadge}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : '<div class="empty">No hay check-ins próximos</div>'}
    </div>

  </div>

  <script>
    async function approve(id) {
      const notes = prompt('Notas (opcional):');
      
      try {
        const res = await fetch('/manager/approve/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes })
        });
        
        if (res.ok) {
          alert('✅ Solicitud aprobada');
          location.reload();
        } else {
          alert('❌ Error al aprobar');
        }
      } catch (error) {
        alert('❌ Error: ' + error.message);
      }
    }

    async function reject(id) {
      const reason = prompt('Motivo del rechazo:');
      if (!reason) return;
      
      try {
        const res = await fetch('/manager/reject/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        
        if (res.ok) {
          alert('✅ Solicitud rechazada');
          location.reload();
        } else {
          alert('❌ Error al rechazar');
        }
      } catch (error) {
        alert('❌ Error: ' + error.message);
      }
    }

    // Auto-refresh cada 30 segundos
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>
  `;
}

module.exports = router;
