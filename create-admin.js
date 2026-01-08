const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function createAdmin() {
  const email = 'demi@rcscheckin.com';  // ⚠️ CAMBIA ESTO
  const password = 'TuContraseña123!';   // ⚠️ CAMBIA ESTO
  const fullName = 'Demi';

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active) 
       VALUES ($1, $2, $3, 'ADMIN', true)
       ON CONFLICT (email) DO UPDATE 
       SET password_hash = $2, full_name = $3, role = 'ADMIN'
       RETURNING id, email, role`,
      [email.toLowerCase().trim(), passwordHash, fullName]
    );

    console.log('✅ Usuario ADMIN creado:');
    console.log('   Email:', result.rows[0].email);
    console.log('   Role:', result.rows[0].role);

    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e);
    process.exit(1);
  }
}

createAdmin();