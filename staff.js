// ====================================================
// Staff Panel Route
// ====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

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

module.exports = router;
