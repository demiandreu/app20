// ====================================================
// Database Configuration & Initialization
// ====================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false
});

// Set UTF8 encoding
pool.on('connect', (client) => {
  client.query('SET client_encoding TO UTF8');
});

// ===== DATABASE INITIALIZATION =====
async function initDb() {
  console.log('🔄 Initializing database...');

  // Tabla principal de check-ins
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      apartment_id TEXT NOT NULL,
      apartment_name TEXT,
      booking_token TEXT NOT NULL,
      booking_id_from_start TEXT,
      beds24_booking_id BIGINT,
      beds24_room_id TEXT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      guest_language TEXT DEFAULT 'es',
      arrival_date DATE NOT NULL,
      arrival_time TIME,
      departure_date DATE NOT NULL,
      departure_time TIME,
      adults INTEGER DEFAULT 1,
      children INTEGER DEFAULT 0,
      reg_done BOOLEAN DEFAULT FALSE,
      reg_done_at TIMESTAMPTZ,
      pay_done BOOLEAN DEFAULT FALSE,
      pay_done_at TIMESTAMPTZ,
      lock_code TEXT,
      lock_visible BOOLEAN DEFAULT FALSE,
      clean_ok BOOLEAN DEFAULT FALSE,
      beds24_raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Tabla de sesiones de WhatsApp
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone TEXT PRIMARY KEY,
      checkin_id INTEGER REFERENCES checkins(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Tabla de configuración de apartamentos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beds24_rooms (
      id SERIAL PRIMARY KEY,
      beds24_room_id TEXT UNIQUE NOT NULL,
      name TEXT,
      registration_url TEXT,
      payment_url TEXT,
      keys_instructions_url TEXT,
      default_arrival_time TIME DEFAULT '17:00',
      default_departure_time TIME DEFAULT '11:00',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Tabla de reglas de early/late checkout
  await pool.query(`
    CREATE TABLE IF NOT EXISTS early_late_checkout_rules (
      id SERIAL PRIMARY KEY,
      apartment_id TEXT NOT NULL,
      standard_checkin_time TIME NOT NULL,
      standard_checkout_time TIME NOT NULL,
      early_checkin_option1_time TIME,
      early_checkin_option1_price DECIMAL(10,2),
      early_checkin_option2_time TIME,
      early_checkin_option2_price DECIMAL(10,2),
      early_checkin_option3_time TIME,
      early_checkin_option3_price DECIMAL(10,2),
      late_checkout_option1_time TIME,
      late_checkout_option1_price DECIMAL(10,2),
      late_checkout_option2_time TIME,
      late_checkout_option2_price DECIMAL(10,2),
      late_checkout_option3_time TIME,
      late_checkout_option3_price DECIMAL(10,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Tabla de selecciones de horario
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkin_time_selections (
      id SERIAL PRIMARY KEY,
      checkin_id INTEGER UNIQUE REFERENCES checkins(id),
      requested_arrival_time INTEGER,
      confirmed_arrival_time INTEGER,
      early_checkin_supplement DECIMAL(10,2) DEFAULT 0,
      requested_departure_time INTEGER,
      confirmed_departure_time INTEGER,
      late_checkout_supplement DECIMAL(10,2) DEFAULT 0,
      whatsapp_phone TEXT,
      approval_status TEXT DEFAULT 'pending',
      approval_status_updated_at TIMESTAMPTZ,
      approved_by TEXT,
      manager_notes TEXT,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Índices para tablas principales
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_booking_id ON checkins(beds24_booking_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_phone ON checkins(phone);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_phone ON whatsapp_sessions(phone);`);

  // Tabla de secciones de apartamentos (para panel de huéspedes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apartment_sections (
      id SERIAL PRIMARY KEY,
      apartment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      icon TEXT DEFAULT '📌',
      display_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Índice para apartment_sections (después de crear la tabla)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_apartment_sections_apartment ON apartment_sections(apartment_id);`);

  console.log('✅ Database initialized successfully');
}

module.exports = { pool, initDb };
