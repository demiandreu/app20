// ====================================================
// RCS Guest Portal — Stable organized single-file version
// (same logic, only reorganized and labeled)
// ====================================================

// ===================== CONFIG ====================
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");
const path = require("path");
const session = require('express-session');
const bcrypt = require('bcrypt');
const pgSession = require('connect-pg-simple')(session);
const fs = require('fs'); 

// ============================================
// 📱 FUNCIÓN: Normalizar número de teléfono
// ============================================
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  
  // Limpiar espacios, guiones, paréntesis
  let cleaned = String(phone).replace(/[\s\-\(\)]/g, '');
  
  // Si ya tiene +, dejarlo como está
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  // Si empieza con 00, reemplazar por +
  if (cleaned.startsWith('00')) {
    return '+' + cleaned.substring(2);
  }
  
  // Si empieza con 34 (España) pero no tiene +
  if (cleaned.startsWith('34') && cleaned.length >= 11) {
    return '+' + cleaned;
  }
  
  // Si es un número español sin prefijo (9 dígitos, empieza con 6 o 7)
  if (cleaned.length === 9 && (cleaned.startsWith('6') || cleaned.startsWith('7'))) {
    return '+34' + cleaned;
  }
  
  // Si tiene otro prefijo internacional
  if (cleaned.length > 9) {
    return '+' + cleaned;
  }
  
  // Default: asumir España
  return '+34' + cleaned;
}

// ============================================
// 📱 FUNCIÓN: Enviar mensaje de WhatsApp
// ============================================
async function sendWhatsAppCodeNotification(checkin) {
  try {
    const twilio = require('twilio');
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    
    // Normalizar número
    const toNumber = normalizePhoneNumber(checkin.phone);
    
    if (!toNumber) {
      console.log(`⚠️ No phone number for checkin ${checkin.id}`);
      return { success: false, reason: 'no_phone' };
    }
    
    // Detectar idioma del huésped (con fallback a español)
    const lang = (checkin.guest_language || 'es').toLowerCase().substring(0, 2);
    
// Obtener mensaje de la base de datos
let message = await getFlowMessage('APARTMENT_READY', lang);
if (message) {
  // Generar link del portal
  const guestPortalLink = `https://rcscheckin.com/guest/${checkin.beds24_booking_id}`;
  
  // Reemplazar variables
  message = message
    .replace(/{door_code}/g, checkin.lock_code || '')
    .replace(/{lockbox_code}/g, checkin.lock_code || '')
    .replace(/{lock_code}/g, checkin.lock_code || '')
    .replace(/{address}/g, checkin.address || '')
    .replace(/{apartment_name}/g, checkin.apartment_name || checkin.room_name || 'Tu apartamento')
    .replace(/{guest_name}/g, checkin.full_name || '')
    .replace(/{guest_portal_link}/g, guestPortalLink);
} else {
  // Fallback si no existe en BD
  message = `✅ ¡Tu apartamento está limpio! Ya puedes entrar.\n\n🔑 Código de acceso: ${checkin.lock_code}\n📍 ${checkin.apartment_name || checkin.room_name || 'Tu apartamento'}\n\n¡Bienvenido! 😊`;
}
    
    const messageBody = message;
    
    // Enviar mensaje por WhatsApp
    const twilioMsg = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${toNumber}`,
      body: messageBody
    });
    
    console.log(`✅ WhatsApp sent to ${toNumber}: ${twilioMsg.sid}`);
    
    return { 
      success: true, 
      messageSid: message.sid,
      to: toNumber 
    };
    
  } catch (error) {
    console.error('❌ Error sending WhatsApp:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// ✅ SEGUNDO: Crear la app
const app = express();
app.set('trust proxy', 1);

// ✅ PRIMERO: Crear el pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ✅ TERCERO: Configurar sesiones (AHORA pool ya existe)
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'fallback-dev-only',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: true,  // ✅ Cambiar a true (porque estás en HTTPS)
    sameSite: 'lax'
  },
  proxy: true  // ✅ AÑADIR esta línea
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// MIDDLEWARE: Verificar rol
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/login');
    }

    try {
      const result = await pool.query(
        'SELECT role FROM users WHERE id = $1 AND is_active = true',
        [req.session.userId]
      );

      if (result.rows.length === 0) {
        req.session.destroy();
        return res.redirect('/login');
      }

      const userRole = result.rows[0].role;

      if (!allowedRoles.includes(userRole)) {
        return res.status(403).send(renderPage('Acceso Denegado', `
          <div class="card">
            <h1>🚫 Acceso Denegado</h1>
            <p>No tienes permisos para acceder a esta página.</p>
            <p><a href="/staff" class="btn-link">← Volver</a></p>
          </div>
        `));
      }

      req.userRole = userRole;
      next();
    } catch (e) {
      console.error('Error checking role:', e);
      return res.status(500).send('Error de autenticación');
    }
  };
}

// HELPER: Obtener usuario actual
async function getCurrentUser(req) {
  if (!req.session || !req.session.userId) {
    return null;
  }

  try {
    const result = await pool.query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
      [req.session.userId]
    );
    return result.rows[0] || null;
  } catch (e) {
    console.error('Error getting current user:', e);
    return null;
  }
}



// ============================================
// 🛡️ MIDDLEWARE: AUTORIZACIÓN POR ROL
// ============================================

// Roles hierarchy (mayor número = más permisos)
const ROLES = {
  STAFF_CLEANING: 1,
  CLEANING_MANAGER: 2,
  MANAGER: 3,
  ADMIN: 4
};

// Middleware: Requiere rol mínimo
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    
    const userRole = req.session.user.role || 'STAFF_CLEANING';
    const userLevel = ROLES[userRole] || 0;
    const minLevel = ROLES[minRole] || 999;
    
    if (userLevel >= minLevel) {
      next();
    } else {
      res.status(403).send(renderPage("Acceso Denegado", `
        <div class="card" style="max-width: 500px; margin: 100px auto; text-align: center;">
          <h1>🚫 Acceso Denegado</h1>
          <p>No tienes permisos para acceder a esta página.</p>
          <p>Tu rol: <strong>${userRole}</strong></p>
          <a href="/" style="color: #6366f1; text-decoration: none;">← Volver al inicio</a>
        </div>
      `));
    }
  };
}

function safeRedirect(res, url) {
  const fallback = '/staff/checkins';
  const target = url || fallback;
  if (typeof target === 'string' && target.startsWith('/')) {
    return res.redirect(303, target);
  }
  return res.redirect(303, fallback);
}
// ===================== STAFF: GUARDAR/BORRAR CÓDIGO =====================
app.post("/staff/checkins/:id/lock", requireAuth, requireRole('CLEANING_MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { lock_code, clear, returnTo } = req.body;
    
    // Si presionó "Clear", borrar código
    // Si no, guardar el código
    const newCode = clear ? null : (lock_code || null);
    
    await pool.query(
      `UPDATE checkins SET lock_code = $1 WHERE id = $2`,
      [newCode, id]
    );
    
    return safeRedirect(res, returnTo || req.headers.referer || "/staff/checkins");
    
  } catch (e) {
    console.error("Error en lock:", e);
    res.status(500).send("Error");
  }
});

app.post("/staff/checkins/:id/visibility", requireAuth, requireRole('CLEANING_MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { returnTo } = req.body;
    
    // Obtener datos completos del checkin
    const current = await pool.query(
      `SELECT 
  id, 
  lock_visible, 
  lock_code,
  phone,
  guest_language,
  full_name,
  apartment_name,
  room_name,
  beds24_booking_id
FROM checkins 
WHERE id = $1`,
      [id]
    );
    
    if (current.rows.length === 0) {
      return res.status(404).send("Not found");
    }
    
    const checkin = current.rows[0];
    const newVisible = !checkin.lock_visible;
    
    // Actualizar visibilidad
    await pool.query(
      `UPDATE checkins SET lock_visible = $1 WHERE id = $2`,
      [newVisible, id]
    );
    
    // 📱 SI SE ESTÁ MOSTRANDO EL CÓDIGO (newVisible = true), enviar WhatsApp
    if (newVisible && checkin.lock_code && checkin.phone) {
      console.log(`📱 Sending WhatsApp to ${checkin.full_name} (${checkin.phone})`);
      
      const result = await sendWhatsAppCodeNotification({
        ...checkin,
        lock_code: checkin.lock_code
      });
      
      if (result.success) {
        console.log(`✅ WhatsApp sent successfully to ${result.to}`);
      } else {
        console.log(`⚠️ WhatsApp not sent: ${result.reason || result.error}`);
      }
    }
    
    // Redirect normal
    return safeRedirect(res, returnTo || req.headers.referer || "/staff/checkins");
    
  } catch (e) {
    console.error("Error en visibility:", e);
    res.status(500).send("Error");
  }
});

// ===================== STAFF: TOGGLE LIMPIEZA =====================
app.post("/staff/checkins/:id/clean", requireAuth, requireRole('CLEANING_MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { returnTo } = req.body;
    
    await pool.query(
      `UPDATE checkins SET clean_ok = NOT COALESCE(clean_ok, false) WHERE id = $1`,
      [id]
    );
    
    return safeRedirect(res, returnTo || req.headers.referer || "/staff/checkins");
  } catch (e) {
    console.error("Error toggling clean status:", e);
    res.status(500).send("Error updating clean status");
  }
});

// ===================== STAFF: DELETE CHECKIN =====================
app.post("/staff/checkins/:id/delete", requireAuth, requireRole('CLEANING_MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { returnTo } = req.body;
    
    await pool.query(`DELETE FROM checkins WHERE id = $1`, [id]);
    
    return safeRedirect(res, returnTo || req.headers.referer || "/staff/checkins");
  } catch (e) {
    console.error("Error deleting checkin:", e);
    res.status(500).send("Error deleting checkin");
  }
});

// Helper: Verificar si el usuario tiene un rol específico o superior
function hasRole(req, minRole) {
  if (!req.session.user) return false;
  
  const userRole = req.session.user.role || 'STAFF_CLEANING';
  const userLevel = ROLES[userRole] || 0;
  const minLevel = ROLES[minRole] || 999;
  
  return userLevel >= minLevel;
}

async function beds24Get(endpoint, params = {}, propertyExternalId) {
  const accessToken = await getBeds24AccessToken(propertyExternalId);
  const url = new URL(`https://beds24.com/api/v2${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url, {
    headers: {
      accept: "application/json",
      token: accessToken,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Beds24 ${endpoint} error ${resp.status}: ${text.slice(0,500)}`);
  }
  return resp.json();
}

async function checkAutoReply(message, language, checkinId) {
  try {
    const bodyLower = message.toLowerCase().trim();
    console.log(`🔍 checkAutoReply: Buscando match para "${bodyLower}" (lang: ${language})`);
    // 🏢 Obtener apartamento del checkin
const checkinResult = await pool.query(`
  SELECT apartment_id FROM checkins WHERE id = $1
`, [checkinId]);

if (!checkinResult.rows.length) {
  console.log('❌ Checkin no encontrado');
  return null;
}

const apartmentId = checkinResult.rows[0].apartment_id;
console.log(`🏢 Apartamento del huésped: ${apartmentId}`);


    // Obtener autorespuestas activas
    const result = await pool.query(`
 SELECT id, category, keywords, response_es, response_en, response_fr, response_ru, priority, apartment_ids
FROM whatsapp_auto_replies
  WHERE active = true
  ORDER BY priority DESC
`);

    console.log(`📊 Encontradas ${result.rows.length} autorespuestas activas`);

    // Buscar match
    for (const reply of result.rows) {
      // 🏢 Verificar si esta respuesta aplica a este apartamento
let apartmentIdsArray = [];
try {
  apartmentIdsArray = reply.apartment_ids ? JSON.parse(reply.apartment_ids) : [];
} catch (e) {
  apartmentIdsArray = [];
}

// Si tiene apartamentos específicos y este no está en la lista, saltar
if (apartmentIdsArray.length > 0 && !apartmentIdsArray.includes(apartmentId)) {
  console.log(`⏭️ Reply ID ${reply.id} no aplica al apartamento ${apartmentId}`);
  continue;
}

console.log(`✅ Reply ID ${reply.id} aplica al apartamento ${apartmentId}`);
      let keywordsArray = [];
      
      if (typeof reply.keywords === 'string') {
        let cleaned = reply.keywords
          .replace(/^\{/, '').replace(/\}$/, '')
          .replace(/^\[/, '').replace(/\]$/, '')
          .replace(/"/g, '')
          .trim();
        keywordsArray = cleaned.split(',').map(k => k.trim()).filter(k => k.length > 0);
      } else if (Array.isArray(reply.keywords)) {
        keywordsArray = reply.keywords;
      }

      console.log(`🔑 Reply ID ${reply.id}: keywords =`, keywordsArray);

      // Buscar match
      const hasMatch = keywordsArray.some(keyword => {
        const keywordLower = keyword.toLowerCase().trim();
        return bodyLower.includes(keywordLower);
      });

      if (hasMatch) {
        console.log(`✅ Match encontrado en reply ID ${reply.id}`);
        
        // Obtener respuesta según idioma
        let response = reply[`response_${language}`] || reply.response_es;
        
        // 🆕 REEMPLAZAR VARIABLES
        response = await replaceVariables(response, checkinId);
        
        console.log(`📤 Enviando autorespuesta (${language}):`, response.substring(0, 100));
        return response;
      }
    }

    console.log(`❌ No se encontró match para "${bodyLower}"`);
    return null;

  } catch (error) {
    console.error('❌ Error en checkAutoReply:', error);
    return null;
  }
}

// 🆕 FUNCIÓN PARA REEMPLAZAR VARIABLES


async function getBeds24AccessToken(propertyExternalId) {
  const res = await pool.query(
    `SELECT credentials->>'refresh_token' AS refresh_token
     FROM provider_connections
     WHERE provider = 'beds24' AND property_external_id = $1 AND is_enabled = true`,
    [propertyExternalId]
  );
  const refreshToken = res.rows[0]?.refresh_token;
  if (!refreshToken) throw new Error("No refresh_token found");

  const resp = await fetch("https://beds24.com/api/v2/authentication/token", {
    method: "GET",
    headers: {
      accept: "application/json",
      refreshToken: refreshToken,  // header exacto
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Beds24 token error ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  const accessToken = json.token;

  // Opcional: guarda el access_token fresco en DB para cachear 24h
  await pool.query(
    `UPDATE provider_connections SET credentials = credentials || $1
     WHERE provider = 'beds24' AND property_external_id = $2`,
    [{ token: accessToken }, propertyExternalId]
  );

  return accessToken;
}

async function getProviderToken(provider, propertyExternalId) {
  const r = await pool.query(
    `
    SELECT credentials->>'token' AS token
    FROM provider_connections
    WHERE provider = $1
      AND property_external_id = $2
      AND is_enabled = true
    LIMIT 1
    `,
    [String(provider), String(propertyExternalId)]
  );

  const token = r.rows?.[0]?.token || "";
if (!token) throw new Error(`Token not found for provider=${provider}, property=${propertyExternalId}`);
  return token;
}

async function beds24SmokeTest(token) {
  const resp = await fetch("https://api.beds24.com/v2/bookings", {
    method: "GET",
    headers: {
      token: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { ok: resp.ok, status: resp.status, data };
}

const PORT = process.env.PORT || 3000;

// 🆕 AÑADE ESTAS LÍNEAS AQUÍ
pool.on('connect', (client) => {
  client.query('SET client_encoding TO UTF8');
});

async function initDb() {
  // --- base table ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      apartment_id TEXT NOT NULL,
      booking_token TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      arrival_date DATE NOT NULL,
      arrival_time TIME NOT NULL,
      departure_date DATE NOT NULL,
      departure_time TIME NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  
  // --- lock fields ---
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_code TEXT;`);
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_visible BOOLEAN NOT NULL DEFAULT FALSE;`);
  
  // --- clean status ---
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS clean_ok BOOLEAN NOT NULL DEFAULT FALSE;`);
  
  // --- Beds24 fields for admin columns ---
  await pool.query(`
    ALTER TABLE checkins
      ADD COLUMN IF NOT EXISTS beds24_booking_id BIGINT,
      ADD COLUMN IF NOT EXISTS beds24_room_id TEXT,
      ADD COLUMN IF NOT EXISTS apartment_name TEXT,
      ADD COLUMN IF NOT EXISTS booking_id TEXT,
      ADD COLUMN IF NOT EXISTS beds24_raw JSONB;
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_booking_id ON checkins(booking_id);`);
  
  // --- apartment_sections icon ---
  await pool.query(`
    ALTER TABLE apartment_sections 
    ADD COLUMN IF NOT EXISTS icon VARCHAR(10) DEFAULT '';
  `);
  console.log('✅ Columna icon verificada');
  
  // 🆕 AÑADIR COLUMNA BOT_STATE PARA EL BOT DE WHATSAPP
  await pool.query(`
    ALTER TABLE checkins 
    ADD COLUMN IF NOT EXISTS bot_state VARCHAR(50) DEFAULT 'IDLE';
  `);
  console.log('✅ Columna bot_state verificada');
  
  console.log("✅ DB ready: checkins table ok (+ lock_code, lock_visible, clean_ok, bot_state)");
}
// ====== MANAGER: Apartment Sections (Accordion content) ======
app.use('/manager', requireAuth);
app.get("/manager/apartment/sections", async (req, res) => {
  try {
    const roomId = String(req.query.room_id || "").trim();

    const aptRes = await pool.query(
      `SELECT id, apartment_name FROM beds24_rooms WHERE beds24_room_id::text = $1 LIMIT 1`,
      [roomId]
    );

    const apt = aptRes.rows[0] || null;
    const backHref = apt ? `/manager/apartment?id=${apt.id}` : `/manager`;

    // 🆕 CARGAR TAMBIÉN LAS TRADUCCIONES
    const secRes = await pool.query(
      `
      SELECT id, title, body, sort_order, is_active, new_media_type, new_media_url, icon, translations
      FROM apartment_sections
      WHERE room_id::text = $1
      ORDER BY sort_order ASC, id ASC
      `,
      [roomId]
    );

    // Opciones de iconos predefinidos
    const iconOptions = [
      { value: "", label: "Sin icono" },
      { value: "📍", label: "📍 Dirección" },
      { value: "🔑", label: "🔑 Llaves" },
      { value: "📶", label: "📶 WiFi" },
      { value: "☕", label: "☕ Cafetera" },
      { value: "🧳", label: "🧳 Maletas" },
      { value: "🎫", label: "🎫 Entradas" },
      { value: "🚗", label: "🚗 Parking" },
      { value: "♿", label: "♿ Accesibilidad" },
      { value: "🏊", label: "🏊 Piscina" },
      { value: "🍽️", label: "🍽️ Restaurantes" },
      { value: "🏖️", label: "🏖️ Playa" },
      { value: "🚿", label: "🚿 Baño" },
      { value: "🛏️", label: "🛏️ Dormitorio" },
      { value: "📺", label: "📺 TV" },
      { value: "❄️", label: "❄️ Aire acondicionado" },
      { value: "🔥", label: "🔥 Calefacción" },
      { value: "🧺", label: "🧺 Lavandería" },
      { value: "🍳", label: "🍳 Cocina" },
      { value: "🎮", label: "🎮 Entretenimiento" },
      { value: "📞", label: "📞 Contacto" },
      { value: "⏰", label: "⏰ Horarios" },
      { value: "ℹ️", label: "ℹ️ Información" },
      { value: "⚠️", label: "⚠️ Importante" },
    ];

    const createIconSelect = (selectedIcon, nameAttr) => {
      return `
        <select name="${nameAttr}" style="width:100%; margin-bottom:8px;">
          ${iconOptions.map(opt => 
            `<option value="${opt.value}" ${selectedIcon === opt.value ? 'selected' : ''}>${opt.label}</option>`
          ).join('')}
        </select>
      `;
    };

    // 🆕 HELPER PARA OBTENER TRADUCCIONES
    const getTranslation = (section, field, lang) => {
      if (!section.translations) return '';
      try {
        const trans = typeof section.translations === 'string' 
          ? JSON.parse(section.translations) 
          : section.translations;
        return trans[field] && trans[field][lang] ? trans[field][lang] : '';
      } catch (e) {
        return '';
      }
    };

    const accordionItems = secRes.rows
      .map((s, index) => {
        const checked = s.is_active ? "checked" : "";
        
        // Obtener traducciones para esta sección
        const titleEn = getTranslation(s, 'title', 'en');
        const titleFr = getTranslation(s, 'title', 'fr');
        const titleDe = getTranslation(s, 'title', 'de');
        const titleRu = getTranslation(s, 'title', 'ru');
        
        const bodyEn = getTranslation(s, 'body', 'en');
        const bodyFr = getTranslation(s, 'body', 'fr');
        const bodyDe = getTranslation(s, 'body', 'de');
        const bodyRu = getTranslation(s, 'body', 'ru');
        
        return `
          <div class="accordion-item">
            <div class="accordion-header" onclick="toggleAccordion(${s.id})">
              <div class="accordion-title">
                <span class="accordion-icon">${s.icon || '📄'}</span>
                <strong>${escapeHtml(s.title || `Sección #${index + 1}`)}</strong>
                <span class="accordion-badge ${s.is_active ? 'active' : 'inactive'}">
                  ${s.is_active ? '✓ Activa' : '✗ Inactiva'}
                </span>
              </div>
              <span class="accordion-arrow" id="arrow-${s.id}">▼</span>
            </div>
            
            <div class="accordion-content" id="content-${s.id}">
              <div class="accordion-body">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:16px;">
                  <div>
                    <label style="display:block; margin-bottom:4px;">Order</label>
                    <input name="sort_order_${s.id}" value="${Number(s.sort_order) || 0}" style="width:100%; box-sizing:border-box;" />
                  </div>
                  <div>
                    <label style="display:block; margin-bottom:4px;">Estado</label>
                    <label style="display:flex; gap:8px; align-items:center; padding:8px;">
                      <input type="checkbox" name="is_active_${s.id}" ${checked}/>
                      Activa
                    </label>
                  </div>
                </div>

                <div style="margin-bottom:12px;">
                  <label class="muted">Icono</label>
                  ${createIconSelect(s.icon || "", `icon_${s.id}`)}
                </div>
                
                <div style="margin-bottom:12px;">
                  <label class="muted">🇪🇸 Título (Español - idioma base)</label>
                  <div style="display:flex; gap:8px;">
                    <input name="title_${s.id}" value="${escapeHtml(s.title || "")}" class="sec-title" placeholder="Título opcional" style="flex:1;" />
                    <button type="button" onclick="translateSection(${s.id}, 'title')" style="padding:8px 16px; background:#6366f1; color:white; border:none; border-radius:6px; cursor:pointer; white-space:nowrap;">🌐 Traducir</button>
                  </div>
                  
                  <!-- 🆕 TRADUCCIONES DEL TÍTULO -->
                  <details style="margin-top:8px;">
                    <summary style="cursor:pointer; padding:8px; background:#f3f4f6; border-radius:6px; font-size:13px;">📝 Traducciones del título</summary>
                    <div style="display:grid; gap:8px; padding:12px; background:#f9fafb; border-radius:6px; margin-top:8px;">
                      <label>🇬🇧 English</label>
                      <textarea id="title_${s.id}_en" name="title_${s.id}_en" rows="1">${escapeHtml(titleEn)}</textarea>
                      
                      <label>🇫🇷 Français</label>
                      <textarea id="title_${s.id}_fr" name="title_${s.id}_fr" rows="1">${escapeHtml(titleFr)}</textarea>
                      
                      <label>🇩🇪 Deutsch</label>
                      <textarea id="title_${s.id}_de" name="title_${s.id}_de" rows="1">${escapeHtml(titleDe)}</textarea>
                      
                      <label>🇷🇺 Русский</label>
                      <textarea id="title_${s.id}_ru" name="title_${s.id}_ru" rows="1">${escapeHtml(titleRu)}</textarea>
                    </div>
                  </details>
                </div>
                
                <div style="margin-bottom:12px;">
                  <label class="muted">🇪🇸 Texto (Español - idioma base)</label>
                  <div style="display:flex; gap:8px; flex-direction:column;">
                    <textarea name="body_${s.id}" rows="5" class="sec-body" placeholder="Texto...">${escapeHtml(s.body || "")}</textarea>
                    <button type="button" onclick="translateSection(${s.id}, 'body')" style="padding:8px 16px; background:#6366f1; color:white; border:none; border-radius:6px; cursor:pointer; align-self:flex-start;">🌐 Traducir texto</button>
                  </div>
                  
                  <!-- 🆕 TRADUCCIONES DEL TEXTO -->
                  <details style="margin-top:8px;">
                    <summary style="cursor:pointer; padding:8px; background:#f3f4f6; border-radius:6px; font-size:13px;">📝 Traducciones del texto</summary>
                    <div style="display:grid; gap:8px; padding:12px; background:#f9fafb; border-radius:6px; margin-top:8px;">
                      <label>🇬🇧 English</label>
                      <textarea id="body_${s.id}_en" name="body_${s.id}_en" rows="3">${escapeHtml(bodyEn)}</textarea>
                      
                      <label>🇫🇷 Français</label>
                      <textarea id="body_${s.id}_fr" name="body_${s.id}_fr" rows="3">${escapeHtml(bodyFr)}</textarea>
                      
                      <label>🇩🇪 Deutsch</label>
                      <textarea id="body_${s.id}_de" name="body_${s.id}_de" rows="3">${escapeHtml(bodyDe)}</textarea>
                      
                      <label>🇷🇺 Русский</label>
                      <textarea id="body_${s.id}_ru" name="body_${s.id}_ru" rows="3">${escapeHtml(bodyRu)}</textarea>
                    </div>
                  </details>
                </div>

                <div style="display:grid; gap:8px; margin-bottom:16px;">
                  <label class="muted">Media type</label>
                  <select name="new_media_type_${s.id}">
                    <option value="none" ${String(s.new_media_type || "none") === "none" ? "selected" : ""}>None</option>
                    <option value="image" ${String(s.new_media_type || "") === "image" ? "selected" : ""}>Image</option>
                    <option value="video" ${String(s.new_media_type || "") === "video" ? "selected" : ""}>Video</option>
                    <option value="map" ${String(s.new_media_type || "") === "map" ? "selected" : ""}>🗺️ Map (Google Maps)</option>
                    <option value="link" ${String(s.new_media_type || "") === "link" ? "selected" : ""}>🔗 Link (External)</option>
                  </select>

                  <label class="muted">Media URL</label>
                  <textarea
                    name="new_media_url_${s.id}"
                    rows="3"
                    placeholder="One URL per line"
                    style="width:100%;"
                  >${escapeHtml(s.new_media_url || "")}</textarea>
                </div>

                <div style="display:flex; gap:8px; flex-wrap:wrap; padding-top:12px; border-top:1px solid #e5e7eb;">
                  <button class="btn-mini" type="submit" name="move" value="up:${s.id}">↑ Subir</button>
                  <button class="btn-mini" type="submit" name="move" value="down:${s.id}">↓ Bajar</button>
                  <button class="btn-mini danger" type="submit" name="delete" value="${s.id}" onclick="return confirm('¿Eliminar esta sección?')">🗑️ Eliminar</button>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    const html = `
      <style>
        .muted { opacity: 0.65; font-size: 12px; }
        .sec-title { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
        .sec-body { width: 100%; box-sizing: border-box; }
        .btn-mini { padding: 6px 10px; font-size: 14px; cursor: pointer; border: 1px solid #ddd; background: #f9f9f9; border-radius: 4px; }
        .btn-mini:hover { background: #e9e9e9; }
        .danger { background: #fee2e2; border-color: #fca5a5; }
        .danger:hover { background: #fecaca; }
        
        /* Estilos del acordeón */
        .accordion-item {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          margin-bottom: 8px;
          background: white;
          overflow: hidden;
        }
        
        .accordion-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          cursor: pointer;
          background: #f9fafb;
          transition: background 0.2s;
        }
        
        .accordion-header:hover {
          background: #f3f4f6;
        }
        
        .accordion-title {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
        }
        
        .accordion-icon {
          font-size: 20px;
        }
        
        .accordion-badge {
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 500;
        }
        
        .accordion-badge.active {
          background: #d1fae5;
          color: #065f46;
        }
        
        .lock-actions {
          display: flex;
          gap: 6px;
          margin-top: 4px;
        }

        .btn-danger {
          background: #fee2e2;
          color: #991b1b;
        }
        
        .accordion-badge.inactive {
          background: #fee2e2;
          color: #991b1b;
        }
        
        .accordion-arrow {
          transition: transform 0.3s;
          font-size: 12px;
          color: #6b7280;
        }
        
        .accordion-arrow.rotated {
          transform: rotate(-180deg);
        }
        
        .accordion-content {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease;
        }
        
        .accordion-content.open {
          max-height: 3000px;
        }
        
        .accordion-body {
          padding: 16px;
          border-top: 1px solid #e5e7eb;
        }
      </style>

      <script>
  function toggleAccordion(id) {
    const content = document.getElementById('content-' + id);
    const arrow = document.getElementById('arrow-' + id);
    content.classList.toggle('open');
    arrow.classList.toggle('rotated');
  }

  async function translateSection(sectionId, field, sourceLang = 'es') {
    const sourceText = document.querySelector(\`[name="\${field}_\${sectionId}"]\`).value;
    
    if (!sourceText.trim()) {
      alert('No hay texto para traducir');
      return;
    }

    const languages = ['en', 'fr', 'de', 'ru'].filter(lang => lang !== sourceLang);
    
    for (const targetLang of languages) {
      try {
        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sourceText, targetLang })
        });
        
        const data = await response.json();
        
        if (data.translated) {
          const textarea = document.getElementById(\`\${field}_\${sectionId}_\${targetLang}\`);
          if (textarea) {
            textarea.value = data.translated;
            textarea.style.background = '#d1fae5';
            setTimeout(() => textarea.style.background = '', 2000);
          }
        }
      } catch (e) {
        console.error('Translation error:', e);
        alert('Error traduciendo a ' + targetLang);
      }
    }
  }

  async function translateNewSection(field) {
    const sourceText = document.querySelector(\`[name="new_\${field}"]\`).value;
    
    if (!sourceText.trim()) {
      alert('No hay texto para traducir');
      return;
    }

    const languages = ['en', 'fr', 'de', 'ru'];
    
    for (const targetLang of languages) {
      try {
        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sourceText, targetLang })
        });
        
        const data = await response.json();
        
        if (data.translated) {
          const textarea = document.getElementById(\`new_\${field}_\${targetLang}\`);
          if (textarea) {
            textarea.value = data.translated;
            textarea.style.background = '#d1fae5';
            setTimeout(() => textarea.style.background = '', 2000);
          }
        }
      } catch (e) {
        console.error('Translation error:', e);
      }
    }
  }
</script>

      <h1>Apartment Sections</h1>

      <p class="muted">
        Apartment: <strong>${escapeHtml(apt?.apartment_name || "Unknown")}</strong>
      </p>
      <p class="muted">
        room_id: <strong>${escapeHtml(roomId)}</strong>
      </p>

      <p>
        <a class="btn-link" href="${backHref}">← Back</a>
      </p>

      <form method="POST" action="/manager/apartment/sections/save">
        <input type="hidden" name="room_id" value="${escapeHtml(roomId)}" />
       <div style="margin:12px 0; padding:12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
  <h2 style="margin:0 0 8px; font-size:16px;">➕ Añadir nueva sección</h2>
  <div style="display:grid; gap:8px;">
    <label>Icono</label>
    ${createIconSelect("", "new_icon")}

    <label>🇪🇸 Título (Español - idioma base)</label>
    <div style="display:flex; gap:8px;">
      <input name="new_title" placeholder="Título" style="flex:1;" />
      <button type="button" onclick="translateNewSection('title')" style="padding:8px 16px; background:#6366f1; color:white; border:none; border-radius:6px; cursor:pointer; white-space:nowrap;">🌐 Traducir</button>
    </div>

    <!-- Traducciones de título (ocultas por defecto) -->
    <details style="margin-top:8px;">
      <summary style="cursor:pointer; padding:8px; background:#f3f4f6; border-radius:6px; font-size:13px;">📝 Traducciones del título</summary>
      <div style="display:grid; gap:8px; padding:12px; background:#f9fafb; border-radius:6px; margin-top:8px;">
        <label>🇬🇧 English</label>
        <textarea id="new_title_en" name="new_title_en" rows="1" placeholder="Auto-translated..."></textarea>
        
        <label>🇫🇷 Français</label>
        <textarea id="new_title_fr" name="new_title_fr" rows="1" placeholder="Auto-translated..."></textarea>
        
        <label>🇩🇪 Deutsch</label>
        <textarea id="new_title_de" name="new_title_de" rows="1" placeholder="Auto-translated..."></textarea>
        
        <label>🇷🇺 Русский</label>
        <textarea id="new_title_ru" name="new_title_ru" rows="1" placeholder="Auto-translated..."></textarea>
      </div>
    </details>

    <label>🇪🇸 Texto (Español - idioma base)</label>
    <div style="display:flex; gap:8px; flex-direction:column;">
      <textarea name="new_body" rows="4" placeholder="Texto para huéspedes..."></textarea>
      <button type="button" onclick="translateNewSection('body')" style="padding:8px 16px; background:#6366f1; color:white; border:none; border-radius:6px; cursor:pointer; align-self:flex-start;">🌐 Traducir texto</button>
    </div>

    <!-- Traducciones de texto (ocultas por defecto) -->
    <details style="margin-top:8px;">
      <summary style="cursor:pointer; padding:8px; background:#f3f4f6; border-radius:6px; font-size:13px;">📝 Traducciones del texto</summary>
      <div style="display:grid; gap:8px; padding:12px; background:#f9fafb; border-radius:6px; margin-top:8px;">
        <label>🇬🇧 English</label>
        <textarea id="new_body_en" name="new_body_en" rows="3" placeholder="Auto-translated..."></textarea>
        
        <label>🇫🇷 Français</label>
        <textarea id="new_body_fr" name="new_body_fr" rows="3" placeholder="Auto-translated..."></textarea>
        
        <label>🇩🇪 Deutsch</label>
        <textarea id="new_body_de" name="new_body_de" rows="3" placeholder="Auto-translated..."></textarea>
        
        <label>🇷🇺 Русский</label>
        <textarea id="new_body_ru" name="new_body_ru" rows="3" placeholder="Auto-translated..."></textarea>
      </div>
    </details>

    <label class="muted">Media type</label>
    <select name="new_media_type">
      <option value="none" selected>None</option>
      <option value="image">Image</option>
      <option value="video">Video</option>
      <option value="map">🗺️ Map (Google Maps)</option>
      <option value="link">🔗 Link (External)</option>
    </select>

   <label>Media URL <span style="font-size:11px; color:#6b7280;">(una URL por línea para múltiples fotos)</span></label>
<div style="display:flex; gap:8px; align-items:start;">
  <textarea name="new_media_url" class="sec-media-url" placeholder="https://..."
            style="flex:1; min-height:100px; resize:vertical; padding:10px; border:1px solid #d1d5db; border-radius:6px; font-family:monospace; font-size:12px;"></textarea>
  
  <button type="button" onclick="uploadPhoto(this)" 
          class="upload-photo-btn"
          style="padding:10px 16px; background:#3b82f6; color:white; border:none; border-radius:6px; cursor:pointer; white-space:nowrap; font-weight:600;">
    📸 Subir foto
  </button>
</div>
<input type="file" accept="image/*" style="display:none;" class="photo-input" multiple />
<div style="font-size:11px; color:#6b7280; margin-top:4px;">
  💡 Máximo 5MB por foto. Soporta JPG, PNG, WEBP.
</div>

    <div style="display:flex; gap:10px; align-items:center;">
      <label class="muted">Order:</label>
      <input name="new_sort_order" value="1" style="width:80px;" />
      <label style="display:flex; gap:8px; align-items:center;">
        <input type="checkbox" name="new_is_active" checked />
        Active
      </label>
      <button type="submit" name="add" value="1">Add section</button>
    </div>
  </div>
</div>
  
        

        <div style="margin-top:12px; padding:12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
          <h2 style="margin:0 0 16px; font-size:16px;">📋 Secciones existentes</h2>

          <div class="accordion">
            ${accordionItems || `<p class="muted" style="padding:10px;">No hay secciones todavía.</p>`}
          </div>

          <div style="margin-top:16px;">
            <button type="submit" name="save" value="1" style="padding:10px 20px; font-size:16px;">💾 Guardar todos los cambios</button>
          </div>
        </div>
      </form>
            <script>
      // ============================================
      // 📸 UPLOAD DE FOTOS A CLOUDINARY
      // ============================================
      
      async function uploadPhoto(button) {
        const container = button.closest('div').parentElement;
        const textarea = container.querySelector('.sec-media-url');
        const fileInput = container.querySelector('.photo-input');
        
        fileInput.click();
        
        fileInput.onchange = async () => {
          const files = Array.from(fileInput.files);
          if (files.length === 0) return;
          
          const invalidFiles = files.filter(f => f.size > 5 * 1024 * 1024);
          if (invalidFiles.length > 0) {
            alert(\`❌ \${invalidFiles.length} foto(s) superan 5MB.\`);
            return;
          }
          
          button.disabled = true;
          const originalText = button.textContent;
          button.textContent = \`⏳ Subiendo \${files.length} foto(s)...\`;
          
          try {
            const uploadedUrls = [];
            
            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              button.textContent = \`⏳ Subiendo \${i + 1}/\${files.length}...\`;
              
              const formData = new FormData();
              formData.append('photo', file);
              
              const response = await fetch('/api/upload-photo', {
                method: 'POST',
                body: formData
              });
              
              const data = await response.json();
              
              if (data.success) {
                uploadedUrls.push(data.url);
              }
            }
            
            if (uploadedUrls.length > 0) {
              const currentUrls = textarea.value.trim();
              const newUrls = uploadedUrls.join('\\n');
              
              if (currentUrls) {
                textarea.value = currentUrls + '\\n' + newUrls;
              } else {
                textarea.value = newUrls;
              }
              
              alert(\`✅ \${uploadedUrls.length} foto(s) subidas\`);
            }
            
          } catch (error) {
            alert('❌ Error: ' + error.message);
          } finally {
            button.disabled = false;
            button.textContent = originalText;
            fileInput.value = '';
          }
        };
      }
      </script>
    `;

    return res.send(renderPage("Apartment Sections", html));
  } catch (e) {
    console.error("sections page error:", e);
    return res.status(500).send(
      "Cannot load sections: " + (e.detail || e.message || String(e))
    );
  }
});

// ============================================
// FUNCIONES HELPER PARA GUEST PANEL
// ============================================

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (e) {
    return dateStr;
  }
}

function fmtTime(timeStr) {
  if (!timeStr) return '';
  return String(timeStr).substring(0, 5);
}



function toYouTubeEmbed(url) {
  const u = String(url || "");
  
  // Formato 1: youtu.be/VIDEO_ID
  const m1 = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  
  // Formato 2: youtube.com/watch?v=VIDEO_ID
  const m2 = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  
  // Formato 3: youtube.com/shorts/VIDEO_ID ← ✅ AÑADIR ESTO
  const m3 = u.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
  
  const id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]);
  
  return id ? `https://www.youtube.com/embed/${id}` : null;
}

function toVimeoEmbed(url) {
  const u = String(url || "");
  const m = u.match(/vimeo\.com\/(\d+)/);
  const id = m && m[1];
  return id ? `https://player.vimeo.com/video/${id}` : null;
}
// ===================== HELPERS =====================
function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function calcNights(arrive, depart) {
  if (!arrive || !depart) return "";

  const a = new Date(arrive);
  const d = new Date(depart);

  if (isNaN(a) || isNaN(d)) return "";

  // обнуляем время
  a.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);

  const ms = d - a;
  const n = Math.floor(ms / 86400000);

  return n > 0 ? n : "";
}

// ============================================
// WHATSAPP BOT - MANEJO DE SOLICITUDES DE HORARIO
// ============================================

// Función auxiliar: Detectar si el mensaje es una hora válida
// ============================================
// FUNCIONES AUXILIARES - SOLICITUDES DE HORARIO
// ============================================

// Función 1: Detectar si el mensaje es una hora válida
function parseTime(text) {
  // Solo acepta números enteros (14, 15, 16, etc.)
  const match = text.trim().match(/^(\d{1,2})$/);
  
  if (match) {
    const hour = parseInt(match[1]);
    if (hour >= 0 && hour <= 23) {
      return hour;  // Devuelve número entero
    }
  }
  return null;
}

// Función 2: Calcular suplemento según reglas del apartamento
async function calculateSupplement(apartmentId, requestedHour, type) {
  console.log('🔍 calculateSupplement called:', { apartmentId, requestedHour, type });
  
  const { rows: [rules] } = await pool.query(
    `SELECT * FROM early_late_checkout_rules WHERE apartment_id = $1 AND is_active = true`,
    [apartmentId]
  );

  console.log('📊 Rules found:', rules ? 'YES' : 'NO');
  if (rules) console.log('📋 Rules data:', rules);

  if (!rules) {
    console.log('❌ No rules found, returning 0');
    return { supplement: 0, isEarly: false, isLate: false, options: [] };
  }

  const requested = requestedHour;
 const standardTime = type === 'checkin' ? rules.standard_checkin_time : rules.standard_checkout_time;
const standard = parseInt(String(standardTime).slice(0, 2));

  console.log('⏰ Hours:', { requested, standard });

  const isEarly = type === 'checkin' && requested < standard;
  const isLate = type === 'checkout' && requested > standard;

  console.log('📌 Status:', { isEarly, isLate });

  if (!isEarly && !isLate) {
    console.log('ℹ️ Not early/late, returning 0');
    return { supplement: 0, isEarly: false, isLate: false, options: [] };
  }

  const options = [];
  
 if (type === 'checkin' && isEarly) {
  console.log('🕐 Building early checkin options...');
  if (rules.early_checkin_option1_enabled && rules.early_checkin_option1_time) {
    const hour1 = parseInt(String(rules.early_checkin_option1_time).slice(0, 2));
    options.push({ 
      hour: hour1,
      price: parseFloat(rules.early_checkin_option1_price), 
      label: '1' 
    });
  }
  if (rules.early_checkin_option2_enabled && rules.early_checkin_option2_time) {
    const hour2 = parseInt(String(rules.early_checkin_option2_time).slice(0, 2));
    options.push({ 
      hour: hour2,
      price: parseFloat(rules.early_checkin_option2_price), 
      label: '2' 
    });
  }
  if (rules.early_checkin_option3_enabled && rules.early_checkin_option3_time) {
    const hour3 = parseInt(String(rules.early_checkin_option3_time).slice(0, 2));
    options.push({
      hour: hour3,
      price: parseFloat(rules.early_checkin_option3_price),
      label: '3'
    });
  }
}

if (type === 'checkout' && isLate) {
  console.log('🕐 Building late checkout options...');
  if (rules.late_checkout_option1_enabled && rules.late_checkout_option1_time) {
    const hour1 = parseInt(String(rules.late_checkout_option1_time).slice(0, 2));
    options.push({ 
      hour: hour1, 
      price: parseFloat(rules.late_checkout_option1_price), 
      label: '1' 
    });
  }
  if (rules.late_checkout_option2_enabled && rules.late_checkout_option2_time) {
    const hour2 = parseInt(String(rules.late_checkout_option2_time).slice(0, 2));
    options.push({ 
      hour: hour2, 
      price: parseFloat(rules.late_checkout_option2_price), 
      label: '2' 
    });
  }
  if (rules.late_checkout_option3_enabled && rules.late_checkout_option3_time) {
    const hour3 = parseInt(String(rules.late_checkout_option3_time).slice(0, 2));
    options.push({ 
      hour: hour3, 
      price: parseFloat(rules.late_checkout_option3_price), 
      label: '3' 
    });
  }
}

  console.log('🎯 Options built:', options);

  options.sort((a, b) => a.hour - b.hour);
  const exactMatch = options.find(opt => opt.hour === requested);
  
  console.log('✅ Exact match search:', { requested, exactMatch });

  if (exactMatch) {
    console.log('💰 Returning supplement:', exactMatch.price);
    return { supplement: exactMatch.price, isEarly, isLate, options, selectedOption: exactMatch };
  }

  console.log('⚠️ No exact match, returning 0');
  return {
    supplement: 0,
    isEarly,
    isLate,
    options,
    selectedOption: null,
    tooEarly: type === 'checkin' && requested < (rules.earliest_possible_checkin || 0),
    tooLate: type === 'checkout' && requested > (rules.latest_possible_checkout || 23)
  };
}

// ============================================



// ============================================

// Textos traducidos para solicitudes de horario
const timeRequestTexts = {
  es: {
    arrivalRequest: "Por favor, indica tu hora de LLEGADA.\n\nEscribe la hora en formato 24h:\nEjemplo: 14:00\n(o simplemente: 14)\n\nCheck-in estándar: {time}",
    arrivalConfirmed: "✅ Hora de llegada: {time}\nSuplemento: {price}€",
    standardCheckout: "\n\nAhora tu hora de SALIDA:\nEjemplo: 11\n\nCheck-out estándar: {time}",
    
    tooEarly: "⚠️ Lo siento, el check-in antes de las {time} no está disponible.\nPor favor, elige una hora entre las {earliest} y 20:00.",
    tooLate: "⚠️ Lo siento, el check-out después de las {time} no está disponible.\nPor favor, elige una hora entre 08:00 y las {latest}.",
    
    earlyCheckinOptions: "El check-in estándar es a las {standard}.\n\n" +
      "Para hacer check-in a las {requested}, hay un suplemento.\n\n" +
      "¿Qué hora prefieres?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Responde con el número (1, 2, 3, etc.):",
    
    lateCheckoutOptions: "El check-out estándar es a las {standard}.\n\n" +
      "Para hacer check-out a las {requested}, hay un suplemento.\n\n" +
      "¿Qué hora prefieres?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Responde con el número (1, 2, etc.):",
    
    requestReceived: "✅ Solicitud recibida\n\n" +
      "Hora de {type} solicitada: {time}\n" +
      "Suplemento: {price}€\n\n" +
      "Tu solicitud está siendo revisada.\n" +
      "Te confirmaremos la disponibilidad en breve.",
    
    standardTime: "Check-in estándar a las {time} (gratis)",
    standardTimeCheckout: "Check-out estándar a las {time} (gratis)",
    
    invalidTime: "⚠️ Formato de hora no válido.\nPor favor, escribe la hora en formato 24h (ejemplo: 17:00)"
  },
  
  en: {
    arrivalRequest: "Please indicate your ARRIVAL time.\n\nWrite the time in 24h format:\nExample: 14:00\n(or simply: 14)\n\nStandard check-in: {time}",
    arrivalConfirmed: "✅ Arrival time: {time}\nSupplement: {price}€",
    standardCheckout: "\n\nNow your DEPARTURE time:\nExample: 11\n\nStandard check-out: {time}",
    
    tooEarly: "⚠️ Sorry, check-in before {time} is not available.\nPlease choose a time between {earliest} and 20:00.",
    tooLate: "⚠️ Sorry, check-out after {time} is not available.\nPlease choose a time between 08:00 and {latest}.",
    
    earlyCheckinOptions: "Standard check-in is at {standard}.\n\n" +
      "For check-in at {requested}, there is a supplement.\n\n" +
      "What time do you prefer?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Reply with the number (1, 2, 3, etc.):",
    
    lateCheckoutOptions: "Standard check-out is at {standard}.\n\n" +
      "For check-out at {requested}, there is a supplement.\n\n" +
      "What time do you prefer?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Reply with the number (1, 2, etc.):",
    
    requestReceived: "✅ Request received\n\n" +
      "{type} time requested: {time}\n" +
      "Supplement: {price}€\n\n" +
      "Your request is being reviewed.\n" +
      "We will confirm availability shortly.",
    
    standardTime: "Standard check-in at {time} (free)",
    standardTimeCheckout: "Standard check-out at {time} (free)",
    
    invalidTime: "⚠️ Invalid time format.\nPlease enter time in 24h format (example: 17:00)"
  },
  
  fr: {
    arrivalRequest: "Veuillez indiquer votre heure d'ARRIVÉE.\n\nÉcrivez l'heure au format 24h:\nExemple: 14:00\n(ou simplement: 14)\n\nEnregistrement standard: {time}",
    arrivalConfirmed: "✅ Heure d'arrivée: {time}\nSupplément: {price}€",
    standardCheckout: "\n\nMaintenant votre heure de DÉPART:\nExemple: 11\n\nDépart standard: {time}",
    
    tooEarly: "⚠️ Désolé, l'enregistrement avant {time} n'est pas disponible.\nVeuillez choisir une heure entre {earliest} et 20:00.",
    tooLate: "⚠️ Désolé, le départ après {time} n'est pas disponible.\nVeuillez choisir une heure entre 08:00 et {latest}.",
    
    earlyCheckinOptions: "L'enregistrement standard est à {standard}.\n\n" +
      "Pour un enregistrement à {requested}, il y a un supplément.\n\n" +
      "Quelle heure préférez-vous?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Répondez avec le numéro (1, 2, 3, etc.):",
    
    lateCheckoutOptions: "Le départ standard est à {standard}.\n\n" +
      "Pour un départ à {requested}, il y a un supplément.\n\n" +
      "Quelle heure préférez-vous?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Répondez avec le numéro (1, 2, etc.):",
    
    requestReceived: "✅ Demande reçue\n\n" +
      "Heure de {type} demandée: {time}\n" +
      "Supplément: {price}€\n\n" +
      "Votre demande est en cours d'examen.\n" +
      "Nous vous confirmerons la disponibilité sous peu.",
    
    standardTime: "Enregistrement standard à {time} (gratuit)",
    standardTimeCheckout: "Départ standard à {time} (gratuit)",
    
    invalidTime: "⚠️ Format d'heure non valide.\nVeuillez entrer l'heure au format 24h (exemple: 17:00)"
  },
  
  ru: {
    arrivalRequest: "Пожалуйста, укажите время ПРИБЫТИЯ.\n\nНапишите время в формате 24ч:\nПример: 14:00\n(или просто: 14)\n\nСтандартный заезд: {time}",
    arrivalConfirmed: "✅ Время прибытия: {time}\nДоплата: {price}€",
    standardCheckout: "\n\nТеперь время ВЫЕЗДА:\nПример: 11\n\nСтандартный выезд: {time}",
    
    tooEarly: "⚠️ Извините, заезд до {time} недоступен.\nПожалуйста, выберите время между {earliest} и 20:00.",
    tooLate: "⚠️ Извините, выезд после {time} недоступен.\nПожалуйста, выберите время между 08:00 и {latest}.",
    
    earlyCheckinOptions: "Стандартный заезд в {standard}.\n\n" +
      "Для заезда в {requested} требуется доплата.\n\n" +
      "Какое время вы предпочитаете?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Ответьте номером (1, 2, 3 и т.д.):",
    
    lateCheckoutOptions: "Стандартный выезд в {standard}.\n\n" +
      "Для выезда в {requested} требуется доплата.\n\n" +
      "Какое время вы предпочитаете?\n\n" +
      "{options}\n" +
      "{standardOption}\n\n" +
      "Ответьте номером (1, 2 и т.д.):",
    
    requestReceived: "✅ Запрос получен\n\n" +
      "Запрошенное время {type}: {time}\n" +
      "Доплата: {price}€\n\n" +
      "Ваш запрос рассматривается.\n" +
      "Мы подтвердим доступность в ближайшее время.",
    
    standardTime: "Стандартный заезд в {time} (бесплатно)",
    standardTimeCheckout: "Стандартный выезд в {time} (бесплатно)",
    
    invalidTime: "⚠️ Неверный формат времени.\nПожалуйста, введите время в формате 24ч (пример: 17:00)"
  }
};



// ===================== TWILIO CLIENT =====================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

if (!twilioClient) {
  console.log("ℹ️ Twilio not configured yet (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
}

async function sendWhatsApp(toE164, text) {
  if (!twilioClient) {
    console.log("ℹ️ Twilio client is null. Skip send.");
    return;
  }

  const from = process.env.TWILIO_WHATSAPP_FROM || "";
  if (!from) {
    console.log("ℹ️ TWILIO_WHATSAPP_FROM missing. Skip send.");
    return;
  }

  const to = String(toE164).startsWith("whatsapp:")
    ? String(toE164)
    : `whatsapp:${String(toE164).trim()}`;

  const msg = await twilioClient.messages.create({
    from,
    to,
    body: text,
  });

  console.log("✅ WhatsApp sent:", msg.sid);
}

// Render usually runs in UTC. For Spain apartments we use Europe/Madrid.
function ymdInTz(date = new Date(), timeZone = "Europe/Madrid") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const yyyy = parts.find((p) => p.type === "year").value;
  const mm = parts.find((p) => p.type === "month").value;
  const dd = parts.find((p) => p.type === "day").value;
  return `${yyyy}-${mm}-${dd}`;
}

function hourOptions(selected = "") {
  let out = "";
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, "0");
    const value = `${hh}:00`;
    out += `<option value="${value}" ${value === selected ? "selected" : ""}>${hh}:00</option>`;
  }
  return out;
}
// ===================== HTML LAYOUT =====================
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("es-ES", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function fmtTime(t) {
  if (!t) return "";
  return String(t).slice(0, 5); // "17:00"
}

// ============================================
// HELPER: Menú de navegación unificado
// ============================================

function renderNavMenu(activePage = '', req = null) {
  // Si no hay req, asumir ADMIN por defecto (para compatibilidad)
  const user = req?.session?.user || { role: 'ADMIN' };
  const userRole = user.role || 'STAFF_CLEANING';
  
  // Definir qué puede ver cada rol
  const canSeeManager = ['ADMIN', 'MANAGER'].includes(userRole);
  const canSeeStaff = ['ADMIN', 'MANAGER', 'CLEANING_MANAGER'].includes(userRole);
  const canSeeWhatsApp = ['ADMIN', 'MANAGER'].includes(userRole);
  const canSeeApartments = ['ADMIN', 'MANAGER'].includes(userRole);
  
  // Construir links según permisos
  let links = '';
  
  if (canSeeManager) {
    links += `<a href="/manager" class="nav-link ${activePage === 'manager' ? 'active' : ''}">🏠 Manager</a>`;
  }
  
  if (canSeeStaff) {
    links += `<a href="/staff/checkins" class="nav-link ${activePage === 'staff' ? 'active' : ''}">📋 Staff</a>`;
  } else if (userRole === 'STAFF_CLEANING') {
    links += `<a href="/staff/my-cleanings" class="nav-link ${activePage === 'my-cleanings' ? 'active' : ''}">🧹 Mis Limpiezas</a>`;
  }
  
  if (canSeeWhatsApp) {
    links += `<a href="/manager/whatsapp" class="nav-link ${activePage === 'whatsapp' ? 'active' : ''}">💬 WhatsApp</a>`;
  }
  
  if (canSeeApartments) {
    links += `<a href="/manager/apartment" class="nav-link ${activePage === 'apartamentos' ? 'active' : ''}">🏢 Apartamentos</a>`;
  }
  if (canSeeManager) {
  links += `<a href="/manager/invoices" class="nav-link ${activePage === 'invoices' ? 'active' : ''}">💰 Contabilidad</a>`;
}
  
  return `
    <style>
      .nav-menu-container {
        background: #2d3748;
        padding: 16px 0;
        margin-bottom: 24px;
        border-radius: 12px;
      }
      
      .nav-menu-wrapper {
        max-width: 1200px;
        margin: 0 auto;
        padding: 0 16px;
        position: relative;
      }
      
      .nav-hamburger {
        display: none;
        background: transparent;
        border: none;
        color: white;
        font-size: 28px;
        cursor: pointer;
        padding: 8px;
      }
      
      .nav-menu-links {
        display: flex;
        justify-content: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      
      .nav-link {
        color: #e2e8f0;
        text-decoration: none;
        padding: 10px 20px;
        border-radius: 8px;
        font-weight: 400;
        transition: all 0.2s;
        display: inline-block;
      }
      
      .nav-link:hover {
        background: #4a5568;
        color: white;
      }
      
      .nav-link.active {
        background: #4299e1;
        color: white;
        font-weight: 600;
      }
      
      @media (max-width: 768px) {
        .nav-hamburger {
          display: block;
        }
        
        .nav-menu-links {
          display: none;
          flex-direction: column;
          width: 100%;
          margin-top: 16px;
        }
        
        .nav-menu-links.active {
          display: flex;
        }
        
        .nav-link {
          width: 100%;
          text-align: center;
        }
      }
    </style>
    
    <div class="nav-menu-container">
      <div class="nav-menu-wrapper">
        <button class="nav-hamburger" onclick="document.getElementById('navLinks').classList.toggle('active')">
          ☰
        </button>
        <div class="nav-menu-links" id="navLinks">
          ${links}
          <a href="/logout" class="nav-link" style="margin-left: auto;">🚪 Salir</a>
        </div>
      </div>
    </div>
  `;
}


function renderPage(title, innerHtml, currentPage = '', showNav = true) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>

  <style>
  /* === FORCE ONE-LINE CONTROLS IN TABLE === */
  .lock-form{
    display:flex;
    align-items:center;
    gap:6px;
    flex-wrap:nowrap;
    white-space:nowrap;
  }

  .lock-form .btn-small,
  .btn-small.btn-ghost {
  background: transparent;
  border: none;
  color: #6366f1; /* Индиго цвет как у ссылок */
  text-decoration: underline;
  padding: 4px 8px;
  font-size: 14px;
  cursor: pointer;
  transition: color 0.2s ease;
}
.btn-small.btn-ghost:hover {
  color: #4f46e5;
  text-decoration: underline;
  background: transparent;
}
.btn-small,
.btn-small.btn-ghost,
.btn-small.danger {
  font-family: inherit;
  outline: none;
}

.btn-small:focus,
.btn-small.btn-ghost:focus,
.btn-small.danger:focus {
  outline: 2px solid #e0e7ff;
  outline-offset: 2px;
}

  td form{ white-space:nowrap; }

  th.sticky-col, td.sticky-col{
    background: #fff;
    z-index: 2;
  }
  thead th.sticky-col{
    z-index: 3;
  }

  .table-wrap{
    overflow-x: auto;
    position: relative;
  }
  table{
    border-collapse: separate;
    border-spacing: 0;
  }
  .btn-base {
    height: 34px;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: none;
    cursor: pointer;
    white-space: nowrap;
  }

  /* Clean button — same style as other small buttons */
  .clean-btn{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    height:30px;
    min-width:44px;
    padding:0 10px;
    border:0;
    outline:0;
    box-shadow:none;
    appearance:none;
    border-radius:10px;
    background:#f2f2f2;
    font-size:14px;
    line-height:1;
    cursor:pointer;
  }
  
.apartment-cell.needs-clean {
  background: #f5f5f5 !important;
  font-weight: 600;
}

/* Override sticky-col background when needs cleaning */
td.sticky-col.needs-clean,
td.apartment-cell.needs-clean {
  background: #f5f5f5 !important;
}
  .clean-btn:focus{ outline:none; }
  .clean-btn.pill-yes{ color:#1a7f37; }
  .clean-btn.pill-no{ color:#b42318; }

  th.sticky-col,
  td.sticky-col {
    position: sticky;
    left: 0;
    z-index: 2;
    background: #fff;
  }

  thead th.sticky-col {
    z-index: 3;
  }

  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body{
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:#f6f7fb;
    color:#111827;
    margin:0;
    min-height:100vh;
    display:flex;
    justify-content:center;
    align-items:flex-start;
     padding: 0;
    margin: 0;
  }


  .table-wrap {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  table {
    min-width: 100%;
    border-collapse: collapse;
  }

  .page{ width:100%; max-width:1100px; padding:16px; }
  .card{
    background:#fff;
    border-radius:18px;
    padding:20px 18px 22px;
    box-shadow:0 10px 28px rgba(17,24,39,0.08);
    border:1px solid #e5e7eb;
  }

  h1{ margin:0 0 8px; font-size:22px; }
  h2{ margin:0 0 8px; font-size:16px; }
  p{ margin:0 0 10px; font-size:14px; color:#4b5563; }
  .muted{ font-size:12px; color:#6b7280; }
  label{ font-size:13px; display:block; margin-bottom:4px; color:#374151; }

  input, select{
    width:100%;
    padding:10px 12px;
    border-radius:12px;
    border:1px solid #d1d5db;
    background:#fff;
    color:#111827;
    font-size:14px;
  }
  input:focus, select:focus{
    outline:none;
    border-color:#2563eb;
    box-shadow:0 0 0 4px rgba(37,99,235,0.12);
  }

  .row{ display:flex; gap:10px; }
  .row > div{ flex:1; }

  .btn-primary, .btn-link, .btn{
  display:inline-block;
  border-radius:999px;
  padding:10px 18px;
  font-weight:700;
  font-size:14px;
  text-decoration:none;
  border:none;
  cursor:pointer;
  margin: 10px;
}

.btn-success {
  background: #22c55e;
  color: white;
  font-weight: 600;
}
 .btn-primary {
  background-color: #e8eef4;
  color: #2c4a66;
  border: 1px solid #d6dee8;
}
  .warnings{
    background:#fff7ed;
    border:1px solid #fed7aa;
    border-radius:12px;
    padding:10px 12px;
    margin-bottom:12px;
    color:#9a3412;
    font-size:13px;
    text-align:left;
  }
  .warnings p{ margin:4px 0; color:#9a3412; }

  /* компактнее таблица */
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  th{
    position:sticky;
    top:0;
    background:#f9fafb;
    text-align:left;
    padding:6px 8px;
    border-bottom:1px solid #e5e7eb;
    white-space:nowrap;
    color:#374151;
    font-size:12px;
  }
  td{
  padding:6px 8px;
  border-bottom:1px solid #f1f5f9;
  vertical-align:top;          /* лучше для textarea */
  white-space:normal;          /* ✅ главное: разрешаем перенос */
}
  tr:hover td{ background:#f9fafb; }

  /* компактнее статус-пилюли */
.pill {
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
}
  /* компактные таблицы — ТОЛЬКО там, где реально нужно */
.table-compact td,
.table-compact th {
  white-space: nowrap;
}

/* секции: поле с текстом должно быть гибким */
.sections-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.sections-table .td-text,
.sections-table .td-text input,
.sections-table .td-text textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
  .pill-yes{ background:#dcfce7; color:#166534; }
  .pill-no{ background:#fee2e2; color:#991b1b; }

  /* компактнее формы/кнопки */
  .lock-form{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; }

  /* Mobile fix: remove side padding */
@media (max-width: 640px) {
  body {
    padding: 1px !important;
  }

  .page,
  .container,
  .card {
    padding-left: 1px !important;
    padding-right: 1px !important;
    margin-left: 1px !important;
    margin-right: 1px !important;
    border-radius: 1px !important;
  }
}

  .lock-input{
    width:110px;
    min-width:110px;
    padding:8px 10px;
    border-radius:10px;
    border:1px solid #d1d5db;
    font-size:14px;
    letter-spacing:0.12em;
  }

 .btn-small {
  background: #f3f4f6; /* Очень светло-серый */
  border: 1px solid #e5e7eb;
  color: #6b7280; /* Серый текст */
  padding: 6px 14px;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 500;
}
.btn-small:hover {
  background: #e5e7eb;
  border-color: #d1d5db;
  color: #4b5563;
}
.btn-small.danger {
  background: #fef2f2; /* Очень бледный розовый */
  border: 1px solid #fecaca;
  color: #dc2626; /* Красный текст */
  padding: 6px 14px;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 500;
}
.btn-small.danger:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #b91c1c;
}
  .btn-ghost{ background:#eef2ff; color:#1e40af; }

  /* === ONE LINE IN CELLS (LOCK + VISIBLE) === */
  .lock-form,
  .vis-form{
    display:flex;
    align-items:center;
    gap:6px;
    flex-wrap:nowrap !important;
    white-space:nowrap;
  }
    /* ===== Sections table (fix shifting) ===== */
.sections-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.sections-table th,
.sections-table td {
  white-space: normal;      /* важно: не nowrap */
  vertical-align: top;
}
.sections-table .td-text { min-width: 0; }
.sections-table .sec-title,
.sections-table .sec-body {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  display: block;
}

  .lock-form button,
  .vis-form button,
  .lock-form .btn-small,
  .vis-form .btn-small{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    white-space:nowrap;
  }

  .lock-input{
    width:72px;
    min-width:72px;
  }
  /* Только для таблиц, где нужно всё в одну строку (lock/visibility) */
.table-compact td,
.table-compact th,
.lock-form,
.vis-form{
  white-space: nowrap;
}
/* ========================================
     🎨 COLOR CODING PARA EARLY/LATE CHECK-IN
     ======================================== */
  
  /* 🟠 Early check-in (llegada antes de 17:00) */
  tr.early-request {
    background-color: #fff3e0 !important;
    border-left: 4px solid #ff9800;
  }
  
  tr.early-request:hover td {
    background-color: #ffe0b2 !important;
  }

  /* 🔴 Late checkout (salida después de 11:00) */
  tr.late-request {
    background-color: #ffebee !important;
    border-left: 4px solid #f44336;
  }
  
  tr.late-request:hover td {
    background-color: #ffcdd2 !important;
  }

  /* 🟣 Ambos (early + late) */
  tr.early-late-both {
    background-color: #f3e5f5 !important;
    border-left: 4px solid #9c27b0;
  }
  
  tr.early-late-both:hover td {
    background-color: #e1bee7 !important;
  }

  /* Asegurar que sticky columns mantengan el color */
  tr.early-request td.sticky-col,
  tr.late-request td.sticky-col,
  tr.early-late-both td.sticky-col {
    background-color: inherit !important;
  }

  /* Prioridad: early/late sobre needs-clean */
  tr.early-request td.apartment-cell.needs-clean,
  tr.late-request td.apartment-cell.needs-clean,
  tr.early-late-both td.apartment-cell.needs-clean {
    background-color: inherit !important;
  }
  .nav-menu {
    background: #1f2937;
    padding: 12px 20px;
    margin-bottom: 16px;
    border-radius: 8px;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: center;
    position: relative;
  }
  
  .nav-links {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  
  .nav-link {
    color: #fff;
    text-decoration: none;
    padding: 8px 16px;
    border-radius: 6px;
    background: transparent;
    font-weight: 400;
    transition: all 0.2s;
  }
  
  .nav-link.active {
    color: #60a5fa;
    background: #374151;
    font-weight: 600;
  }
  
  .nav-link:hover {
    background: #374151;
  }
  
  .nav-toggle {
    display: none;
    background: transparent;
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    padding: 8px;
  }
  
  @media (max-width: 768px) {
    .nav-links {
      display: none;
      flex-direction: column;
      width: 100%;
      gap: 8px;
    }
    
    .nav-links.active {
      display: flex;
    }
    
    .nav-toggle {
      display: block;
      margin-left: auto;
    }
    
    .nav-link {
      width: 100%;
      text-align: left;
    }

  </style>
</head>
<body>
  <div class="page">
  ${showNav ? `
` : ''}    
    <div class="card">
      ${innerHtml}
    </div>
  </div>
</body>
</html>`;
}

// =====================================================
// ROUTES
// =====================================================

function toDateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.includes(" ")) return s.split(" ")[0]; // "YYYY-MM-DD HH:mm" -> date
  if (s.includes(":")) return null;            // "16:00" is NOT a date
  return s;                                    // "YYYY-MM-DD"
}

function toTimeOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.includes(" ")) return s.split(" ")[1] || null; // "YYYY-MM-DD HH:mm" -> time
  if (s.includes(":")) return s;                       // "16:00"
  return null;
}


function mapBeds24BookingToRow(b, roomNameFallback = "", roomIdFallback = "") {
  let roomName = b.roomName || roomNameFallback || "";
  let apartmentName = roomName;
  
  if (!apartmentName && b.apiMessage) {
    const match = String(b.apiMessage).match(/^Room:\s*(.+?)(\r?\n|$)/i);
    if (match) apartmentName = match[1].trim();
  }
  
  if (!apartmentName) {
    apartmentName = `Apartamento ${b.roomId || roomIdFallback || "sin id"}`;
  }

  const arrivalDate = toDateOnly(b.arrival || b.checkin_date || b.checkin);
  const arrivalTime = toTimeOnly(b.arrivalTime || b.checkin_time || b.checkin);
  const departureDate = toDateOnly(b.departure || b.checkout_date || b.checkout);
  const departureTime = toTimeOnly(b.departureTime || b.checkout_time || b.checkout);

  return {
    apartment_id: String(b.roomId || roomIdFallback || ""),
    apartment_name: apartmentName,
    room_name: roomName,
    booking_token: b.bookingToken || b.id ? `beds24_${b.id}` : `temp_${Date.now()}`,
    full_name: `${b.firstName || ""} ${b.lastName || ""}`.trim() || "Guest",
    email: b.email || "unknown@unknown.com",
    phone: b.phone || b.mobile || "+000000000",
    arrival_date: arrivalDate,
    arrival_time: arrivalTime,
    departure_date: departureDate,
    departure_time: departureTime,
    adults: Number(b.numAdult || 0),
    children: Number(b.numChild || 0),
    beds24_booking_id: b.id != null ? String(b.id) : null,
    beds24_room_id: String(b.roomId || roomIdFallback || ""),
    status: b.status || "confirmed",
    cancelled: String(b.status || "").toLowerCase() === "cancelled",
    beds24_raw: b,
    provider: "beds24",
  };
}

async function upsertCheckinFromBeds24(row) {
  // Must have dates
  if (!row.arrival_date || !row.departure_date) {
    return { skipped: true, reason: "missing_dates" };
  }
  const beds24RoomId = row.beds24_room_id != null ? String(row.beds24_room_id) : null;
  let apartmentId = row.apartment_id ? String(row.apartment_id) : null;
// Buscar el ID de beds24_rooms
let roomDbId = null;
if (beds24RoomId) {
  const roomRes = await pool.query(
    `SELECT id FROM beds24_rooms WHERE beds24_room_id::text = $1 LIMIT 1`,
    [beds24RoomId]
  );
  roomDbId = roomRes.rows?.[0]?.id ? String(roomRes.rows[0].id) : null;
}


  const bookingToken =
    row.booking_token != null && String(row.booking_token).trim() !== ""
      ? String(row.booking_token)
      : (row.beds24_booking_id != null ? `beds24_${String(row.beds24_booking_id)}` : null);

 await pool.query(
  `
  INSERT INTO checkins (
    apartment_id,
    room_id,
    booking_token,
    full_name,
    email,
    phone,
    arrival_date,
    arrival_time,
    departure_date,
    departure_time,
    adults,
    children,
    beds24_booking_id,
    beds24_room_id,
    apartment_name,
    room_name,
    beds24_raw
  )
  VALUES (
    $1,$2,$3,$4,$5,
    $6,$7,$8,$9,$10,
    $11,$12,$13,$14,$15,
    $16,$17::jsonb
  )
    ON CONFLICT (beds24_booking_id)
    DO UPDATE SET
      apartment_id     = EXCLUDED.apartment_id,
      room_id          = EXCLUDED.room_id,
      booking_token    = COALESCE(NULLIF(EXCLUDED.booking_token, ''), checkins.booking_token),
      apartment_name   = COALESCE(NULLIF(EXCLUDED.apartment_name, ''), checkins.apartment_name),
      room_name        = EXCLUDED.room_name,
    
      
      full_name        = COALESCE(NULLIF(checkins.full_name, ''), EXCLUDED.full_name),
      email            = COALESCE(NULLIF(checkins.email, ''), EXCLUDED.email),
      phone            = COALESCE(NULLIF(checkins.phone, ''), EXCLUDED.phone),

      arrival_date     = COALESCE(EXCLUDED.arrival_date, checkins.arrival_date),
      arrival_time     = COALESCE(EXCLUDED.arrival_time, checkins.arrival_time),
      departure_date   = COALESCE(EXCLUDED.departure_date, checkins.departure_date),
      departure_time   = COALESCE(EXCLUDED.departure_time, checkins.departure_time),

      adults           = COALESCE(EXCLUDED.adults, checkins.adults),
      children         = COALESCE(EXCLUDED.children, checkins.children),
    

      beds24_raw       = COALESCE(EXCLUDED.beds24_raw, checkins.beds24_raw)
    `,
    [
      null,                           // $1
      roomDbId,                          // $2 room_id
      bookingToken,                          // $3 booking_token
      row.full_name || null,                 // $4
      row.email || null,                     // $5
      row.phone || null,                     // $6
      row.arrival_date,                      // $7
      row.arrival_time || null,              // $8
      row.departure_date,                    // $9
      row.departure_time || null,            // $10
      row.adults != null ? Number(row.adults) : null,       // $11
      row.children != null ? Number(row.children) : null,   // $12
      row.beds24_booking_id != null ? String(row.beds24_booking_id) : null, // $13
      beds24RoomId,                          // $14 beds24_room_id
      row.apartment_name || null,            // $15
      row.room_name || null,                 // $16 🆕 NUEVO CAMPO
      row.beds24_raw ? JSON.stringify(row.beds24_raw) : null // $17::jsonb
    ]
  );

  return { ok: true };
}

//vremenno
async function beds24PostJson(url, body, apiKeyOverride) {
  const apiKey = apiKeyOverride || process.env.BEDS24_API_KEY;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token:apiKey
    },
    body: JSON.stringify(body || {}),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`Beds24 API HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return json;
}
app.get("/debug/beds24", async (req, res) => {
  try {
    const propertyId = "203178";

    const row = await pool.query(
      `
      SELECT
        credentials->>'refresh_token' AS refresh_token,
        credentials->>'token' AS token
      FROM provider_connections
      WHERE provider = 'beds24'
        AND property_external_id = $1
        AND is_enabled = true
      LIMIT 1
      `,
      [propertyId]
    );

    const refreshToken = row.rows?.[0]?.refresh_token;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: "refresh_token not found in DB (credentials->>'refresh_token')",
      });
    }

    // 1) get short-lived access token using refresh token
    const authResp = await fetch("https://beds24.com/api/v2/authentication/token", {
      method: "GET",
      headers: {
        accept: "application/json",
        refreshToken: refreshToken, // Beds24 expects this header name in v2
      },
    });

    const authJson = await authResp.json().catch(() => null);
    if (!authResp.ok) {
      return res.status(authResp.status).json({
        success: false,
        step: "authentication/token",
        authJson,
      });
    }

    const accessToken = authJson?.token;
    if (!accessToken) {
      return res.status(500).json({
        success: false,
        error: "No token returned from authentication/token",
        authJson,
      });
    }

    // 2) call bookings
    const bookingsResp = await fetch("https://beds24.com/api/v2/bookings?filter=arrivals", {
      method: "GET",
      headers: {
        accept: "application/json",
        token: accessToken, // ✅ correct header for Beds24 v2
      },
    });

    const text = await bookingsResp.text();
    return res.status(bookingsResp.status).send(text);
  } catch (err) {
    console.error("Beds24 debug error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== MANAGER: Menu =====================
// ===== MANAGER HOME: select apartment =====
app.get("/manager", requireAuth, requireRole('MANAGER'), async (req, res) => {
  try {
    const { rows: apartments } = await pool.query(`
 SELECT 
  id, 
  beds24_room_id,
  COALESCE(apartment_name, 'Apartment #' || id::text) as apartment_name  
FROM beds24_rooms
  WHERE is_active = true
  ORDER BY apartment_name ASC
`);
    
    const options = apartments
      .map((a) => 
        `<option value="${a.id}">${escapeHtml(a.apartment_name)}</option>`
      )
      .join("");
    
   const html = renderNavMenu('apartamentos', req) + `
     <h1>Manager</h1>
      <h3>Apartment settings</h3>
      <form method="GET" action="/manager/apartment">
        <label>Select apartment:</label><br/>
        <select name="id" style="min-width:320px; padding:6px;">
          ${options}
        </select>
        <button type="submit" style="padding:6px 10px;">Open</button>
      </form>
      <hr/>
      <h3>Quick links</h3>
     <ul>
  <li><a href="/manager/channels/sync">Sync Rooms</a></li>
  <li><a href="/manager/channels/bookingssync">Sync Bookings</a></li>
  <li><a href="staff/checkins">Staff · Check-ins</a></li>
  <li><a href="/manager/whatsapp">💬 WhatsApp Responses</a></li>
</ul>
    `;
    
    res.send(renderPage("Manager", html));
  } catch (e) {
    console.error("❌ /manager error:", e);
    res.status(500).send("Manager error");
  }
});

// ============================================
// 💰 MANAGER: FACTURAS / INVOICES
// ============================================

app.get("/manager/invoices", requireAuth, requireRole('MANAGER'), async (req, res) => {
  try {
    const { month, year, apartment, filterType, dateFrom, dateTo } = req.query;
    
    // Detectar tipo de filtro
    const isCustomFilter = filterType === 'custom';
    
    let startDate, endDate;
    let displayPeriod;
    
    if (isCustomFilter) {
      // Filtro custom (rango de fechas)
      startDate = dateFrom || '2025-01-01';
      endDate = dateTo || '2025-12-31';
      displayPeriod = `${startDate} → ${endDate}`;
    } else {
      // Filtro mensual (por defecto)
      const now = new Date();
      const selectedYear = year ? parseInt(year) : now.getFullYear();
      const selectedMonth = month ? parseInt(month) : now.getMonth() + 1;
      
      startDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
      endDate = selectedMonth === 12 
        ? `${selectedYear + 1}-01-01`
        : `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-01`;
      
      const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      displayPeriod = `${monthNames[selectedMonth - 1]} ${selectedYear}`;
    }
    
    const selectedApartment = apartment || 'all';
    
    // Obtener lista de apartamentos únicos
    const apartmentsResult = await pool.query(`
      SELECT DISTINCT 
        TRIM(REGEXP_REPLACE(apartment_name, '\\s+', ' ', 'g')) as apartment_name
      FROM checkins 
      WHERE apartment_name IS NOT NULL 
        AND apartment_name != ''
      ORDER BY apartment_name
    `);
    const apartments = apartmentsResult.rows.map(r => r.apartment_name);

    // Construir query con filtro opcional de apartamento
    let query = `
      SELECT 
        id,
        beds24_booking_id,
        full_name,
        arrival_date,
        departure_date,
        apartment_name,
        beds24_raw,
        created_at
      FROM checkins
      WHERE arrival_date >= $1
        AND arrival_date < $2
        AND cancelled = false
    `;
    
    const params = [startDate, endDate];
    
    if (selectedApartment !== 'all') {
      query += ` AND TRIM(REGEXP_REPLACE(apartment_name, '\\s+', ' ', 'g')) = $3`;
      params.push(selectedApartment);
    }
    
    query += ` ORDER BY arrival_date ASC`;

    const result = await pool.query(query, params);

    const bookings = result.rows.map(row => {
      const rawData = row.beds24_raw || {};
      const raw = rawData.booking || rawData;
      
      // Detectar plataforma
      const channel = (raw.channel || '').toLowerCase();
      const referer = raw.referer || '';
      let platform = 'unknown';
      
      if (channel === 'booking' || referer.includes('Booking')) {
        platform = 'booking';
      } else if (channel === 'airbnb' || referer.includes('Airbnb')) {
        platform = 'airbnb';
      } else if (referer.includes('iframe') || channel === 'iframe') {
        platform = 'direct';
      }

      // Extraer precio según plataforma
      let price = 0;
      
      if (platform === 'booking') {
        // ⚠️ IMPORTANTE: invoiceItems está en rawData (raíz), NO en raw (booking)
        const invoiceItems = rawData.invoiceItems || [];
        const roomItem = invoiceItems.find(item => item.subType === 8);
        
        if (roomItem) {
          price = roomItem.amount || 0;
        } else {
          // Fallback si no hay invoiceItems
          price = raw.price || 0;
        }
      } else {
        // Para Airbnb y otros: usar el precio normal
        price = raw.price || 0;
      }

      // Comisión de la plataforma
      const commission = raw.commission || 0;

      // Calcular Booking IVA (solo para Booking.com)
      const bookingIva = platform === 'booking' ? (price * 0.0472) : 0;

      // Calcular Rental Connect (30% del precio)
      const rentalConnect = price * 0.30;

      // Calcular Income (beneficio neto)
      const income = price - commission - bookingIva - rentalConnect;

      // Calcular noches
      const nights = row.departure_date && row.arrival_date
        ? Math.ceil((new Date(row.departure_date) - new Date(row.arrival_date)) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        id: row.id,
        beds24_booking_id: row.beds24_booking_id,
        full_name: row.full_name,
        arrival_date: row.arrival_date,
        departure_date: row.departure_date,
        apartment_name: row.apartment_name,
        platform,
        referer: referer,
        nights,
        price: price.toFixed(2),
        commission: commission.toFixed(2),
        bookingIva: bookingIva.toFixed(2),
        rentalConnect: rentalConnect.toFixed(2),
        income: income.toFixed(2)
      };
    });

    // Calcular totales
    const totals = {
      count: bookings.length,
      totalPrice: bookings.reduce((sum, b) => sum + parseFloat(b.price), 0).toFixed(2),
      totalCommission: bookings.reduce((sum, b) => sum + parseFloat(b.commission), 0).toFixed(2),
      totalBookingIva: bookings.reduce((sum, b) => sum + parseFloat(b.bookingIva), 0).toFixed(2),
      totalRentalConnect: bookings.reduce((sum, b) => sum + parseFloat(b.rentalConnect), 0).toFixed(2),
      totalIncome: bookings.reduce((sum, b) => sum + parseFloat(b.income), 0).toFixed(2)
    };

    // Generar selector de filtros con opción CUSTOM
    const selectedMonth = month ? parseInt(month) : new Date().getMonth() + 1;
    const selectedYear = year ? parseInt(year) : new Date().getFullYear();
    
    const filterForm = `
      <form method="GET" action="/manager/invoices" style="margin:20px 0;" id="filterForm">
        <div style="display:flex; gap:12px; align-items:end; flex-wrap:wrap;">
          <div>
            <label>Tipo de Filtro</label>
            <select name="filterType" class="form-input" id="filterType" onchange="toggleFilterType()">
              <option value="monthly" ${!filterType || filterType === 'monthly' ? 'selected' : ''}>Por Mes</option>
              <option value="custom" ${filterType === 'custom' ? 'selected' : ''}>Custom (Rango)</option>
            </select>
          </div>
          
          <!-- Filtros mensuales -->
          <div id="monthlyFilters" style="display:flex; gap:12px; align-items:end;">
            <div>
              <label>Mes</label>
              <select name="month" class="form-input">
                ${[1,2,3,4,5,6,7,8,9,10,11,12].map(m => `
                  <option value="${m}" ${m === selectedMonth ? 'selected' : ''}>
                    ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][m-1]}
                  </option>
                `).join('')}
              </select>
            </div>
            <div>
              <label>Año</label>
              <select name="year" class="form-input">
                ${[2024, 2025, 2026, 2027].map(y => `
                  <option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}</option>
                `).join('')}
              </select>
            </div>
          </div>
          
          <!-- Filtros custom -->
          <div id="customFilters" style="display:none; gap:12px; align-items:end;">
            <div>
              <label>Desde</label>
              <input type="date" name="dateFrom" class="form-input" value="${dateFrom || '2025-01-01'}" />
            </div>
            <div>
              <label>Hasta</label>
              <input type="date" name="dateTo" class="form-input" value="${dateTo || '2025-12-31'}" />
            </div>
          </div>
          
          <div>
            <label>Apartamento</label>
            <select name="apartment" class="form-input">
              <option value="all" ${selectedApartment === 'all' ? 'selected' : ''}>Todos</option>
              ${apartments.map(apt => `
                <option value="${escapeHtml(apt)}" ${selectedApartment === apt ? 'selected' : ''}>
                  ${escapeHtml(apt)}
                </option>
              `).join('')}
            </select>
          </div>
          <button type="submit" class="btn-primary">Filtrar</button>
          <a href="/manager/invoices/export?${new URLSearchParams(req.query).toString()}" class="btn-success">📊 Exportar Excel</a>
        </div>
      </form>
      
      <script>
        function toggleFilterType() {
          const filterType = document.getElementById('filterType').value;
          const monthlyFilters = document.getElementById('monthlyFilters');
          const customFilters = document.getElementById('customFilters');
          
          if (filterType === 'monthly') {
            monthlyFilters.style.display = 'flex';
            customFilters.style.display = 'none';
          } else {
            monthlyFilters.style.display = 'none';
            customFilters.style.display = 'flex';
          }
        }
        
        // Inicializar al cargar
        toggleFilterType();
      </script>
    `;

    // Generar tabla
    const tableHtml = `
      <div style="margin-bottom:16px;">
        <h2 style="margin:0; color:#374151;">Período: ${displayPeriod}</h2>
        ${selectedApartment !== 'all' ? `<p style="margin:4px 0 0; color:#6b7280;">Apartamento: ${escapeHtml(selectedApartment)}</p>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:40px;">Acción</th>
              <th>ID Booking</th>
              <th>Huésped</th>
              <th>Plataforma</th>
              <th>Check-in</th>
              <th>Check-out</th>
              <th>Noches</th>
              <th>Apartamento</th>
              <th>Precio</th>
              <th>Comisión</th>
              <th>Booking IVA</th>
              <th>Rental Connect</th>
              <th>Income</th>
            </tr>
          </thead>
          <tbody>
            ${bookings.length ? bookings.map(b => `
              <tr>
                <td>
                  <form method="POST" action="/manager/invoices/${b.id}/delete" onsubmit="return confirm('¿Seguro que quieres eliminar esta reserva de la facturación?');" style="margin:0;">
                    <button type="submit" class="btn-link" style="color:#dc2626; padding:4px;">🗑️</button>
                  </form>
                </td>
                <td style="font-family:monospace;">${escapeHtml(String(b.beds24_booking_id || b.id))}</td>
                <td>${escapeHtml(b.full_name)}</td>
                <td>
                  <span class="pill ${b.platform === 'booking' ? 'pill-primary' : b.platform === 'airbnb' ? 'pill-success' : 'pill-gray'}">
                    ${b.platform === 'booking' ? '🏨 Booking' : b.platform === 'airbnb' ? '🏠 Airbnb' : '📧 Directo'}
                  </span>
                </td>
                <td>${fmtDate(b.arrival_date)}</td>
                <td>${fmtDate(b.departure_date)}</td>
                <td>${b.nights}</td>
                <td>${escapeHtml(b.apartment_name)}</td>
                <td style="text-align:right; font-weight:600;">€${b.price}</td>
                <td style="text-align:right;">€${b.commission}</td>
                <td style="text-align:right; color:#dc2626;">€${b.bookingIva}</td>
                <td style="text-align:right; color:#059669; font-weight:600;">€${b.rentalConnect}</td>
                <td style="text-align:right; color:#0891b2; font-weight:700; background:#ecfeff;">€${b.income}</td>
              </tr>
            `).join('') : `
              <tr><td colspan="13" class="muted">No hay reservas en este período</td></tr>
            `}
          </tbody>
          <tfoot>
            <tr style="background:#f9fafb; font-weight:600;">
              <td colspan="8">TOTALES (${totals.count} reservas)</td>
              <td style="text-align:right;">€${totals.totalPrice}</td>
              <td style="text-align:right;">€${totals.totalCommission}</td>
              <td style="text-align:right; color:#dc2626;">€${totals.totalBookingIva}</td>
              <td style="text-align:right; color:#059669;">€${totals.totalRentalConnect}</td>
              <td style="text-align:right; color:#0891b2; font-weight:700; background:#ecfeff;">€${totals.totalIncome}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    const pageHtml = renderNavMenu('invoices', req) +
                     `<h1>💰 Facturas y Comisiones</h1>` +
                     filterForm + 
                     tableHtml;

    res.send(renderPage("Facturas", pageHtml, 'manager'));
  } catch (e) {
    console.error("Error en /manager/invoices:", e);
    res.status(500).send(renderPage("Error", `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error al cargar reporte</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a href="/manager/invoices" class="btn-link">Recargar</a></p>
      </div>
    `));
  }
});

// ============================================
// 📊 EXPORTAR FACTURAS A EXCEL
// ============================================

app.get("/manager/invoices/export", requireAuth, requireRole('MANAGER'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { month, year, apartment } = req.query;
    
    const selectedYear = year ? parseInt(year) : new Date().getFullYear();
    const selectedMonth = month ? parseInt(month) : new Date().getMonth() + 1;
    const selectedApartment = apartment || 'all';
    
    // ✅ DECLARAR AQUÍ AL INICIO
    const apartmentName = selectedApartment === 'all' ? 'Todos los Apartamentos' : selectedApartment;
    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthName = monthNames[selectedMonth - 1];
    
    const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
    const endDate = selectedMonth === 12 
      ? `${selectedYear + 1}-01-01`
      : `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-01`;

    // Query de bookings
    let query = `
      SELECT 
        id, beds24_booking_id, full_name, arrival_date, departure_date,
        apartment_name, beds24_raw, created_at
      FROM checkins
      WHERE arrival_date >= $1 AND arrival_date < $2 AND cancelled = false
    `;
    
    const params = [startDate, endDate];
    
    if (selectedApartment !== 'all') {
      query += ` AND TRIM(REGEXP_REPLACE(apartment_name, '\\\\s+', ' ', 'g')) = $3`;
      params.push(selectedApartment);
    }
    
    query += ` ORDER BY arrival_date ASC`;
    const result = await pool.query(query, params);

    // Procesar bookings
    // Procesar bookings
const bookings = result.rows.map(row => {
  const rawData = row.beds24_raw || {};
  const raw = rawData.booking || rawData;
  
  const channel = (raw.channel || '').toLowerCase();
  const referer = raw.referer || '';
  let platform = 'unknown';
  
  if (channel === 'booking' || referer.includes('Booking')) {
    platform = 'booking';
  } else if (channel === 'airbnb' || referer.includes('Airbnb')) {
    platform = 'airbnb';
  } else if (referer.includes('iframe') || channel === 'iframe') {
    platform = 'direct';
  }

  // Extraer precio según plataforma
  let price = 0;
  
  if (platform === 'booking') {
    // ⚠️ IMPORTANTE: invoiceItems está en rawData (raíz), NO en raw (booking)
    const invoiceItems = rawData.invoiceItems || [];
    const roomItem = invoiceItems.find(item => item.subType === 8);
    
    if (roomItem) {
      price = roomItem.amount || 0;
    } else {
      // Fallback si no hay invoiceItems
      price = raw.price || 0;
    }
  } else {
    // Para Airbnb y otros: usar el precio normal
    price = raw.price || 0;
  }

  const commission = raw.commission || 0;
  const bookingIva = platform === 'booking' ? (price * 0.0472) : 0;
  const rentalConnect = price * 0.30;
  const income = price - commission - bookingIva - rentalConnect;

  const nights = row.departure_date && row.arrival_date
    ? Math.ceil((new Date(row.departure_date) - new Date(row.arrival_date)) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    beds24_booking_id: row.beds24_booking_id,
    full_name: row.full_name,
    arrival_date: row.arrival_date,
    departure_date: row.departure_date,
    apartment_name: row.apartment_name,
    platform: platform === 'booking' ? 'Booking' : platform === 'airbnb' ? 'Airbnb' : 'Directo',
    nights,
    price: parseFloat(price.toFixed(2)),
    commission: parseFloat(commission.toFixed(2)),
    bookingIva: parseFloat(bookingIva.toFixed(2)),
    rentalConnect: parseFloat(rentalConnect.toFixed(2)),
    income: parseFloat(income.toFixed(2))
  };
});
    // Crear Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte');

    // CABECERA
    worksheet.mergeCells('A1:M1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `Reporte - ${apartmentName} - ${monthName} ${selectedYear}`;
    titleCell.font = { size: 16, bold: true };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    worksheet.getRow(1).height = 30;

    // Espacio
    worksheet.addRow([]);

    // ENCABEZADOS
    const headerRow = worksheet.addRow([
      'ID Booking',
      'Huésped',
      'Plataforma',
      'Check-in',
      'Check-out',
      'Noches',
      'Apartamento',
      'Precio',
      'Comisión',
      'Booking IVA',
      'Rental Connect',
      'Income'
    ]);
    
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF17375E' }
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 25;

    // DATOS
    bookings.forEach(b => {
      worksheet.addRow([
        b.beds24_booking_id,
        b.full_name,
        b.platform,
        b.arrival_date ? new Date(b.arrival_date).toLocaleDateString('es-ES') : '',
        b.departure_date ? new Date(b.departure_date).toLocaleDateString('es-ES') : '',
        b.nights,
        b.apartment_name,
        b.price,
        b.commission,
        b.bookingIva,
        b.rentalConnect,
        b.income
      ]);
    });

    // TOTALES
    const totals = {
      count: bookings.length,
      totalPrice: bookings.reduce((sum, b) => sum + b.price, 0),
      totalCommission: bookings.reduce((sum, b) => sum + b.commission, 0),
      totalBookingIva: bookings.reduce((sum, b) => sum + b.bookingIva, 0),
      totalRentalConnect: bookings.reduce((sum, b) => sum + b.rentalConnect, 0),
      totalIncome: bookings.reduce((sum, b) => sum + b.income, 0)
    };

    const totalRow = worksheet.addRow([
      '',
      `TOTALES (${totals.count} reservas)`,
      '', '', '', '', '',
      totals.totalPrice,
      totals.totalCommission,
      totals.totalBookingIva,
      totals.totalRentalConnect,
      totals.totalIncome
    ]);

    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF9FAFB' }
    };

    // FORMATO DE COLUMNAS
    worksheet.getColumn(1).width = 12;
    worksheet.getColumn(2).width = 25;
    worksheet.getColumn(3).width = 12;
    worksheet.getColumn(4).width = 12;
    worksheet.getColumn(5).width = 12;
    worksheet.getColumn(6).width = 8;
    worksheet.getColumn(7).width = 20;
    worksheet.getColumn(8).width = 12;
    worksheet.getColumn(9).width = 12;
    worksheet.getColumn(10).width = 12;
    worksheet.getColumn(11).width = 15;
    worksheet.getColumn(12).width = 12;

    // Formato de moneda
    [8, 9, 10, 11, 12].forEach(col => {
      worksheet.getColumn(col).numFmt = '€#,##0.00';
      worksheet.getColumn(col).alignment = { horizontal: 'right' };
    });

    // Generar archivo
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Reporte-${apartmentName.replace(/[^a-zA-Z0-9]/g, '_')}-${monthName}-${selectedYear}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    console.error("Error al exportar Excel:", e);
    res.status(500).send("Error al generar el archivo Excel");
  }
});

// ============================================
// 🗑️ ELIMINAR RESERVA DE FACTURACIÓN
// ============================================

app.post("/manager/invoices/:id/delete", requireAuth, requireRole('MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const returnTo = req.body.returnTo || req.get('Referer') || '/manager/invoices';

    await pool.query(
      'UPDATE checkins SET cancelled = true, cancelled_at = NOW() WHERE id = $1',
      [id]
    );

    res.redirect(returnTo);
  } catch (e) {
    console.error("Error eliminando reserva:", e);
    res.status(500).send("Error al eliminar");
  }
});


app.get("/manager/apartment", requireAuth, requireRole('MANAGER'), async (req, res) => {
  const html = renderNavMenu('apartamentos', req) + `
    <style>
      .container-apt { max-width: 1200px; margin: 0 auto; }
      .header-apt { margin-bottom: 24px; }
      .header-apt h1 { font-size: 28px; color: #1f2937; margin-bottom: 8px; }
      .header-apt p { color: #6b7280; font-size: 14px; }
      .back-link { display: inline-block; color: #6366f1; text-decoration: none; margin-bottom: 16px; font-size: 14px; }
      .back-link:hover { text-decoration: underline; }
      
      .apartment-selector {
        margin-bottom: 32px; padding: 20px; background: #f9fafb;
        border-radius: 12px; border: 2px solid #e5e7eb;
      }
      .apartment-selector label {
        display: block; font-weight: 600; color: #374151; margin-bottom: 8px;
      }
      .apartment-selector select {
        width: 100%; padding: 12px; border: 2px solid #e5e7eb;
        border-radius: 8px; font-size: 16px; background: white; cursor: pointer;
      }
      .apartment-selector select:focus {
        outline: none; border-color: #6366f1;
      }
      
      .quick-links { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
      .quick-link {
        padding: 10px 16px; background: #f3f4f6; color: #374151;
        text-decoration: none; border-radius: 8px; font-size: 14px;
        font-weight: 500; transition: all 0.2s;
      }
      .quick-link:hover { background: #e5e7eb; }
      
      .accordion-section {
        border: 1px solid #e5e7eb; border-radius: 12px;
        margin-bottom: 16px; overflow: hidden; transition: all 0.3s ease;
      }
      .accordion-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 20px; background: #f9fafb; cursor: pointer; user-select: none;
      }
      .accordion-header:hover { background: #f3f4f6; }
      .accordion-title {
        display: flex; align-items: center; gap: 12px;
        font-size: 18px; font-weight: 600; color: #1f2937;
      }
      .accordion-icon { font-size: 24px; }
      .accordion-arrow {
        font-size: 20px; transition: transform 0.3s ease; color: #6b7280;
      }
      .accordion-section.open .accordion-arrow { transform: rotate(180deg); }
      .accordion-content {
        max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
      }
      .accordion-section.open .accordion-content { max-height: 3000px; }
      .accordion-body { padding: 24px; background: white; }
      
      .form-grid {
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;
      }
      .form-grid.single { grid-template-columns: 1fr; }
      .form-group { display: flex; flex-direction: column; gap: 8px; }
      .form-group label { font-size: 14px; font-weight: 500; color: #374151; }
      .form-group input, .form-group textarea, .form-group select {
        padding: 10px 12px; border: 1px solid #d1d5db;
        border-radius: 8px; font-size: 14px; font-family: inherit;
      }
      .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
        outline: none; border-color: #6366f1;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
      }
      .form-group textarea { min-height: 80px; resize: vertical; }
      
      .checkbox-group {
        display: flex; align-items: center; gap: 8px; padding: 10px 0;
      }
      .checkbox-group input[type="checkbox"] {
        width: 20px; height: 20px; cursor: pointer;
      }
      .checkbox-group label {
        font-size: 14px; color: #374151; cursor: pointer;
      }
      
      .muted { color: #6b7280; font-size: 13px; }
      
      .form-actions {
        margin-top: 32px; display: flex; gap: 16px; justify-content: flex-end;
        padding: 20px; background: #f9fafb; border-radius: 12px;
        position: sticky; bottom: 20px;
      }
      .btn {
        padding: 12px 24px; border: none; border-radius: 8px;
        font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;
      }
      .btn-primary { background: #6366f1; color: white; }
      .btn-primary:hover { background: #4f46e5; }
      
      .alert {
        padding: 16px; border-radius: 8px; margin-bottom: 16px;
        font-size: 14px; display: none; width: 100%;
      }
      .alert.show { display: block; }
      .alert.success {
        background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7;
      }
      .alert.error {
        background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;
      }
      
      .loading { text-align: center; padding: 40px; color: #6b7280; }
      
      @media (max-width: 768px) {
        .form-grid { grid-template-columns: 1fr; }
      }
    </style>
    
    <div class="container-apt">
      <a href="/manager" class="back-link">← Volver a Manager</a>
      
      <div class="header-apt">
        <h1>🏠 Gestión de Apartamentos</h1>
        <p>Configura toda la información de tus apartamentos para usar variables en autorespuestas</p>
      </div>

      <div class="apartment-selector">
        <label>Selecciona un apartamento:</label>
        <select id="apartment-select">
          <option value="">Cargando apartamentos...</option>
        </select>
      </div>

      <div id="quick-links" class="quick-links" style="display: none;">
        <a href="#" class="quick-link" id="sections-link">🪗 Gestionar secciones acordeón</a>
      </div>

      <div id="loading" class="loading" style="display: none;">
        <p>⏳ Cargando información...</p>
      </div>

      <div id="form-container" style="display: none;">
        ${generateApartmentAccordions()}
        
        <div id="alert" class="alert"></div>
        
        <div class="form-actions">
          <button class="btn btn-primary" onclick="saveApartment()">
            💾 Guardar Cambios
          </button>
        </div>
      </div>
    </div>

    ${generateApartmentScript()}
  `;
  
  res.send(renderPage("Apartamentos", html));
});

// Helper: Generar acordeones
function generateApartmentAccordions() {
  const sections = [
    {
      icon: '📍',
      title: 'Información Básica y Beds24',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Nombre del apartamento</label>
            <input type="text" id="apartment_name">
            <p class="muted">Nombre que verán los huéspedes</p>
          </div>
          <div class="form-group">
            <label>Beds24 Room ID</label>
            <input type="text" id="beds24_room_id" readonly>
            <p class="muted">ID de Beds24 (solo lectura)</p>
          </div>
          <div class="form-group">
            <label>Registration link</label>
            <input type="url" id="registration_url">
          </div>
          <div class="form-group">
            <label>Payment link</label>
            <input type="url" id="payment_url">
          </div>
          <div class="form-group">
            <label>Keys / Instructions link</label>
            <input type="url" id="keys_instructions_url">
          </div>
        </div>
        <div class="form-grid">
          <div class="checkbox-group">
            <input type="checkbox" id="show_in_staff">
            <label for="show_in_staff">Mostrar en Staff Panel</label>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Dirección completa</label>
            <input type="text" id="address">
          </div>
          <div class="form-group">
            <label>Ciudad</label>
            <input type="text" id="city">
          </div>
          <div class="form-group">
            <label>Piso</label>
            <input type="text" id="floor">
          </div>
          <div class="form-group">
            <label>Número de puerta</label>
            <input type="text" id="door_number">
          </div>
        </div>
      `
    },
    {
      icon: '🔑',
      title: 'Acceso y Llaves',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Código caja de llaves</label>
            <input type="text" id="lockbox_code">
          </div>
          <div class="form-group">
            <label>Ubicación caja de llaves</label>
            <input type="text" id="lockbox_location">
          </div>
          <div class="form-group">
            <label>Código puerta principal</label>
            <input type="text" id="door_code">
          </div>
          <div class="form-group">
            <label>Código portón/verja</label>
            <input type="text" id="gate_code">
          </div>
        </div>
        <div class="form-grid single">
          <div class="form-group">
            <label>Instrucciones para las llaves</label>
            <textarea id="key_instructions"></textarea>
          </div>
        </div>
      `
    },
    {
      icon: '📶',
      title: 'WiFi e Internet',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Nombre red WiFi</label>
            <input type="text" id="wifi_network">
          </div>
          <div class="form-group">
            <label>Contraseña WiFi</label>
            <input type="text" id="wifi_password">
          </div>
        </div>
        <div class="form-grid single">
          <div class="form-group">
            <label>Qué hacer si no funciona WiFi</label>
            <textarea id="wifi_troubleshooting"></textarea>
          </div>
        </div>
      `
    },
    {
      icon: '⏰',
      title: 'Horarios',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Hora entrada estándar</label>
            <input type="time" id="checkin_time" value="17:00">
          </div>
          <div class="form-group">
            <label>Hora salida estándar</label>
            <input type="time" id="checkout_time" value="11:00">
          </div>
          <div class="form-group">
            <label>Precio entrada anticipada (€)</label>
            <input type="number" step="0.01" id="early_checkin_price">
          </div>
          <div class="form-group">
            <label>Precio salida tardía (€)</label>
            <input type="number" step="0.01" id="late_checkout_price">
          </div>
        </div>
      `
    },
    {
      icon: '💰',
      title: 'Precios y Depósitos',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Fianza/Depósito seguridad (€)</label>
            <input type="number" step="0.01" id="security_deposit_amount">
          </div>
          <div class="form-group">
            <label>Impuesto turístico (€)</label>
            <input type="number" step="0.01" id="tourist_tax_amount">
          </div>
        </div>
      `
    },
    {
      icon: '🚗',
      title: 'Parking',
      fields: `
        <div class="checkbox-group">
          <input type="checkbox" id="parking_available">
          <label for="parking_available">Parking disponible</label>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Ubicación parking</label>
            <input type="text" id="parking_location">
          </div>
          <div class="form-group">
            <label>Código acceso parking</label>
            <input type="text" id="parking_code">
          </div>
        </div>
        <div class="form-grid single">
          <div class="form-group">
            <label>Instrucciones parking</label>
            <textarea id="parking_instructions"></textarea>
          </div>
        </div>
      `
    },
    {
      icon: '🏊',
      title: 'Piscina',
      fields: `
        <div class="checkbox-group">
          <input type="checkbox" id="pool_available">
          <label for="pool_available">Piscina disponible</label>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Horario piscina</label>
            <input type="text" id="pool_hours" placeholder="10:00 - 21:00">
          </div>
          <div class="form-group">
            <label>Ubicación piscina</label>
            <input type="text" id="pool_location">
          </div>
        </div>
        <div class="form-grid single">
          <div class="form-group">
            <label>Normas de la piscina</label>
            <textarea id="pool_rules"></textarea>
          </div>
        </div>
      `
    },
    {
      icon: '📞',
      title: 'Contacto y Soporte',
      fields: `
        <div class="form-grid">
          <div class="form-group">
            <label>Teléfono soporte</label>
            <input type="tel" id="support_phone">
          </div>
          <div class="form-group">
            <label>WhatsApp soporte</label>
            <input type="tel" id="support_whatsapp">
          </div>
        </div>
      `
    }
  ];

  return sections.map((section, index) => `
    <div class="accordion-section ${index === 0 ? 'open' : ''}">
      <div class="accordion-header" onclick="toggleAccordion(this)">
        <div class="accordion-title">
          <span class="accordion-icon">${section.icon}</span>
          <span>${section.title}</span>
        </div>
        <span class="accordion-arrow">▼</span>
      </div>
      <div class="accordion-content">
        <div class="accordion-body">
          ${section.fields}
        </div>
      </div>
    </div>
  `).join('');
}

// Helper: Generar script
function generateApartmentScript() {
  return `
    <script>
      let apartments = [];
      let currentApartmentId = null;
      let beds24Data = null;

      async function loadApartments() {
        try {
          const response = await fetch('/api/beds24-rooms');
          const data = await response.json();
          
          if (data.success) {
            apartments = data.rooms;
            renderApartmentSelect();
            
            const urlParams = new URLSearchParams(window.location.search);
            const id = urlParams.get('id');
            if (id) {
              document.getElementById('apartment-select').value = id;
              await loadApartment(id);
            }
          }
        } catch (error) {
          console.error('Error loading apartments:', error);
          showAlert('Error al cargar apartamentos', 'error');
        }
      }

      function renderApartmentSelect() {
        const select = document.getElementById('apartment-select');
        select.innerHTML = '<option value="">Selecciona un apartamento...</option>';
        
        apartments.forEach(apt => {
          const option = document.createElement('option');
          option.value = apt.id;
          option.textContent = apt.apartment_name || apt.beds24_room_id || \`Apartamento #\${apt.id}\`;
          select.appendChild(option);
        });
      }

      document.getElementById('apartment-select')?.addEventListener('change', (e) => {
        const aptId = e.target.value;
        if (aptId) {
          const url = new URL(window.location);
          url.searchParams.set('id', aptId);
          window.history.pushState({}, '', url);
          loadApartment(aptId);
        } else {
          document.getElementById('form-container').style.display = 'none';
          document.getElementById('quick-links').style.display = 'none';
        }
      });

      async function loadApartment(beds24RoomId) {
        document.getElementById('loading').style.display = 'block';
        document.getElementById('form-container').style.display = 'none';
        
        try {
          const beds24Response = await fetch(\`/api/beds24-room/\${beds24RoomId}\`);
          const beds24Result = await beds24Response.json();
          
          if (!beds24Result.success) {
            showAlert('Error al cargar apartamento', 'error');
            return;
          }
          
          beds24Data = beds24Result.room;
          currentApartmentId = beds24RoomId;
          
          let apartmentData = null;
          if (beds24Data.apartment_id) {
            const aptResponse = await fetch(\`/api/apartment/\${beds24Data.apartment_id}\`);
            const aptResult = await aptResponse.json();
            if (aptResult.success) {
              apartmentData = aptResult.apartment;
            }
          }
          
          fillForm(beds24Data, apartmentData);
          
          document.getElementById('form-container').style.display = 'block';
          document.getElementById('quick-links').style.display = 'flex';
          document.getElementById('loading').style.display = 'none';
          
          if (beds24Data.beds24_room_id) {
            document.getElementById('sections-link').href = 
              \`/manager/apartment/sections?room_id=\${encodeURIComponent(beds24Data.beds24_room_id)}\`;
          }
          
        } catch (error) {
          console.error('Error loading apartment:', error);
          showAlert('Error al cargar apartamento', 'error');
          document.getElementById('loading').style.display = 'none';
        }
      }

      function fillForm(beds24, apartment) {
        setValue('apartment_name', apartment?.name || beds24.apartment_name || '');
        setValue('beds24_room_id', beds24.beds24_room_id || '');
        setValue('registration_url', beds24.registration_url || '');
        setValue('payment_url', beds24.payment_url || '');
        setValue('keys_instructions_url', beds24.keys_instructions_url || '');
        setChecked('show_in_staff', beds24.show_in_staff !== false);
        setValue('support_phone', beds24.support_phone || '');
        setValue('checkin_time', beds24.default_arrival_time || '17:00');
        setValue('checkout_time', beds24.default_departure_time || '11:00');
        
        if (!apartment) return;
        
        setValue('address', apartment.address);
        setValue('city', apartment.city);
        setValue('floor', apartment.floor);
        setValue('door_number', apartment.door_number);
        setValue('lockbox_code', apartment.lockbox_code);
        setValue('lockbox_location', apartment.lockbox_location);
        setValue('door_code', apartment.door_code);
        setValue('gate_code', apartment.gate_code);
        setValue('key_instructions', apartment.key_instructions);
        setValue('wifi_network', apartment.wifi_network);
        setValue('wifi_password', apartment.wifi_password);
        setValue('wifi_troubleshooting', apartment.wifi_troubleshooting);
        setValue('early_checkin_price', apartment.early_checkin_price);
        setValue('late_checkout_price', apartment.late_checkout_price);
        setValue('security_deposit_amount', apartment.security_deposit_amount);
        setValue('tourist_tax_amount', apartment.tourist_tax_amount);
        setChecked('parking_available', apartment.parking_available);
        setValue('parking_location', apartment.parking_location);
        setValue('parking_code', apartment.parking_code);
        setValue('parking_instructions', apartment.parking_instructions);
        setChecked('pool_available', apartment.pool_available);
        setValue('pool_hours', apartment.pool_hours);
        setValue('pool_location', apartment.pool_location);
        setValue('pool_rules', apartment.pool_rules);
        setValue('support_whatsapp', apartment.support_whatsapp);
      }

      function setValue(id, value) {
        const el = document.getElementById(id);
        if (el) el.value = value || '';
      }

      function setChecked(id, checked) {
        const el = document.getElementById(id);
        if (el) el.checked = checked || false;
      }

      function getValue(id) {
        const el = document.getElementById(id);
        return el ? el.value : null;
      }

      function getChecked(id) {
        const el = document.getElementById(id);
        return el ? el.checked : false;
      }

      async function saveApartment() {
        if (!currentApartmentId) {
          showAlert('No hay apartamento seleccionado', 'error');
          return;
        }
        
        try {
          const data = {
            beds24_room_id: currentApartmentId,
            name: getValue('apartment_name'),
            address: getValue('address'),
            city: getValue('city'),
            floor: getValue('floor'),
            door_number: getValue('door_number'),
            lockbox_code: getValue('lockbox_code'),
            lockbox_location: getValue('lockbox_location'),
            door_code: getValue('door_code'),
            gate_code: getValue('gate_code'),
            key_instructions: getValue('key_instructions'),
            wifi_network: getValue('wifi_network'),
            wifi_password: getValue('wifi_password'),
            wifi_troubleshooting: getValue('wifi_troubleshooting'),
            checkin_time: getValue('checkin_time'),
            checkout_time: getValue('checkout_time'),
            early_checkin_price: getValue('early_checkin_price') || null,
            late_checkout_price: getValue('late_checkout_price') || null,
            security_deposit_amount: getValue('security_deposit_amount') || null,
            tourist_tax_amount: getValue('tourist_tax_amount') || null,
            parking_available: getChecked('parking_available'),
            parking_location: getValue('parking_location'),
            parking_code: getValue('parking_code'),
            parking_instructions: getValue('parking_instructions'),
            pool_available: getChecked('pool_available'),
            pool_hours: getValue('pool_hours'),
            pool_location: getValue('pool_location'),
            pool_rules: getValue('pool_rules'),
            support_phone: getValue('support_phone'),
            support_whatsapp: getValue('support_whatsapp'),
            registration_url: getValue('registration_url'),
            payment_url: getValue('payment_url'),
            keys_instructions_url: getValue('keys_instructions_url'),
            show_in_staff: getChecked('show_in_staff')
          };
          
          const response = await fetch('/api/apartment/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          
          const result = await response.json();
          
          if (result.success) {
            showAlert('✅ Apartamento guardado correctamente', 'success');
          } else {
            showAlert('❌ Error al guardar: ' + result.error, 'error');
          }
        } catch (error) {
          console.error('Error saving:', error);
          showAlert('❌ Error al guardar apartamento', 'error');
        }
      }

      function toggleAccordion(header) {
        const section = header.parentElement;
        section.classList.toggle('open');
      }

      function showAlert(message, type) {
        const alert = document.getElementById('alert');
        alert.className = \`alert \${type} show\`;
        alert.textContent = message;
        
        setTimeout(() => {
          alert.classList.remove('show');
        }, 5000);
      }

      loadApartments();
    </script>
  `;
}


// ============================================
// RUTAS DEL MANAGER - CHECK-IN/CHECK-OUT RULES
// ============================================

// RUTA 1: Lista de apartamentos con enlace a configuración
app.get("/manager/checkin-rules", async (req, res) => {
  try {
    const { rows: apartments } = await pool.query(`
      SELECT 
        br.beds24_room_id,
        br.apartment_name,
        elr.id as has_rules,
        elr.standard_checkin_time,
        elr.standard_checkout_time,
        elr.is_active
      FROM beds24_rooms br
      LEFT JOIN early_late_checkout_rules elr ON elr.apartment_id = br.beds24_room_id
      WHERE br.is_active = true
      ORDER BY br.apartment_name ASC
    `);

    const html = `
      <h1>Configuración de Check-in/Check-out</h1>
      <p><a href="/manager">← Volver al Manager</a></p>

      <div style="margin-top:20px;">
        <table>
          <thead>
            <tr>
              <th>Apartamento</th>
              <th>Check-in Estándar</th>
              <th>Check-out Estándar</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${apartments.map(a => `
              <tr>
                <td><strong>${escapeHtml(a.apartment_name)}</strong></td>
                <td>${a.standard_checkin_time || '-'}</td>
                <td>${a.standard_checkout_time || '-'}</td>
                <td>
                  ${a.has_rules 
                    ? `<span class="pill ${a.is_active ? 'pill-yes' : 'pill-no'}">${a.is_active ? 'Activo' : 'Inactivo'}</span>`
                    : '<span class="muted">Sin configurar</span>'
                  }
                </td>
                <td>
                  <a href="/manager/checkin-rules/${encodeURIComponent(a.beds24_room_id)}" class="btn-small">
                    ${a.has_rules ? 'Editar' : 'Configurar'}
                  </a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    res.send(renderPage("Reglas de Check-in/Check-out", html));
  } catch (e) {
    console.error("Error en /manager/checkin-rules:", e);
    res.status(500).send("Error al cargar la página");
  }
});

// ============================================
// RUTAS DEL STAFF - APROBACIÓN DE SOLICITUDES
// ============================================
app.use('/staff', requireAuth);
app.get('/staff', async (req, res) => {
  const user = await getCurrentUser(req);

  if (!user) {
    return res.redirect('/logout');
  }

  const roleLabels = {
    'ADMIN': '👑 Administrador',
    'MANAGER': '💼 Manager',
    'CLEANING_MANAGER': '🧹 Jefe de Limpieza',
    'STAFF_CLEANING': '🧹 Personal de Limpieza'
  };

  const html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
      <div>
        <h1 style="margin:0 0 4px;">Panel de Control</h1>
        <p style="margin:0; color:#6b7280;">
          ${roleLabels[user.role] || user.role} · ${escapeHtml(user.full_name)}
        </p>
      </div>
      <a href="/logout" class="btn-base" style="background:#ef4444; color:white; text-decoration:none; padding:8px 16px; border-radius:8px;">
        Cerrar Sesión
      </a>
    </div>

    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:16px;">
      
      ${['ADMIN', 'MANAGER', 'CLEANING_MANAGER'].includes(user.role) ? `
        <a href="/staff/checkins" class="card" style="text-decoration:none; cursor:pointer; transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
          <h2 style="margin:0 0 8px; font-size:18px;">📅 Llegadas y Salidas</h2>
          <p style="margin:0; color:#6b7280; font-size:14px;">Gestionar check-ins y check-outs</p>
        </a>
      ` : ''}

      ${['ADMIN', 'MANAGER'].includes(user.role) ? `
        <a href="/manager/whatsapp" class="card" style="text-decoration:none; cursor:pointer; transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
          <h2 style="margin:0 0 8px; font-size:18px;">💬 WhatsApp Manager</h2>
          <p style="margin:0; color:#6b7280; font-size:14px;">Configurar mensajes automáticos</p>
        </a>
      ` : ''}

      ${['ADMIN', 'MANAGER'].includes(user.role) ? `
        <a href="/manager/apartments" class="card" style="text-decoration:none; cursor:pointer; transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
          <h2 style="margin:0 0 8px; font-size:18px;">🏠 Apartamentos</h2>
          <p style="margin:0; color:#6b7280; font-size:14px;">Gestionar información de apartamentos</p>
        </a>
      ` : ''}

    </div>
  `;

  res.send(renderPage('Panel de Control', html, 'staff'));
});
app.get("/staff/pending-requests", async (req, res) => {
  try {
    const { rows: requests } = await pool.query(`
      SELECT 
        cts.*,
        c.full_name,
        c.phone,
        c.arrival_date,
        c.departure_date,
        c.apartment_name,
        c.beds24_booking_id,
        br.apartment_name as room_name
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.room_id::text
      WHERE cts.approval_status = 'pending'
      ORDER BY cts.created_at DESC
    `);

    const html = `
      <style>
        .request-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
        }
        .request-header {
          display: flex;
          justify-content: space-between;
          align-items: start;
          margin-bottom: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid #e5e7eb;
        }
        .request-info {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
          margin-bottom: 16px;
        }
        .info-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .info-label {
          font-size: 12px;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .info-value {
          font-size: 16px;
          font-weight: 500;
        }
        .price-highlight {
          background: #fef3c7;
          color: #92400e;
          padding: 4px 12px;
          border-radius: 4px;
          font-weight: 600;
        }
        .approval-actions {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }
        .btn-approve {
          background: #10b981;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .btn-approve:hover { background: #059669; }
        .btn-reject {
          background: #ef4444;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .btn-reject:hover { background: #dc2626; }
        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #6b7280;
        }
        .empty-state svg {
          width: 80px;
          height: 80px;
          margin: 0 auto 20px;
          opacity: 0.3;
        }
      </style>

      <h1>📋 Solicitudes de Horario Pendientes</h1>
      <p><a href="/ckins">← Volver a Check-ins</a></p>

      ${requests.length === 0 ? `
        <div class="empty-state">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <h2>No hay solicitudes pendientes</h2>
          <p>Todas las solicitudes han sido procesadas</p>
        </div>
      ` : requests.map(r => {
        const arrivalRequested = r.requested_arrival_time ? r.requested_arrival_time.slice(0, 5) : null;
        const departureRequested = r.requested_departure_time ? r.requested_departure_time.slice(0, 5) : null;
        
        const hasEarlycheckin = r.early_checkin_supplement > 0;
        const hasLateCheckout = r.late_checkout_supplement > 0;

        return `
          <div class="request-card">
            <div class="request-header">
              <div>
                <h2 style="margin:0 0 4px;">${escapeHtml(r.full_name)}</h2>
                <p style="margin:0; color:#6b7280;">
                  ${escapeHtml(r.room_name || r.apartment_name || 'Apartamento')} • 
                  Reserva: ${escapeHtml(r.beds24_booking_id)}
                </p>
              </div>
              <div style="background:#fef3c7; padding:8px 16px; border-radius:6px; text-align:center;">
                <div style="font-size:12px; color:#92400e;">TOTAL SUPLEMENTO</div>
                <div style="font-size:24px; font-weight:700; color:#92400e;">${r.total_supplement}€</div>
              </div>
            </div>

            <div class="request-info">
              <div class="info-item">
                <div class="info-label">📅 Llegada</div>
                <div class="info-value">${fmtDate(r.arrival_date)}</div>
              </div>

              <div class="info-item">
                <div class="info-label">📱 Teléfono</div>
                <div class="info-value">${escapeHtml(r.whatsapp_phone || r.phone || '-')}</div>
              </div>

              <div class="info-item">
                <div class="info-label">📅 Salida</div>
                <div class="info-value">${fmtDate(r.departure_date)}</div>
              </div>
            </div>

            ${hasEarlycheckin ? `
              <div style="background:#dbeafe; padding:16px; border-radius:6px; margin-bottom:12px;">
                <strong>🕐 Check-in Anticipado Solicitado</strong><br>
                Hora solicitada: <strong>${arrivalRequested}</strong><br>
                Suplemento: <span class="price-highlight">${r.early_checkin_supplement}€</span>
              </div>
            ` : ''}

            ${hasLateCheckout ? `
              <div style="background:#fce7f3; padding:16px; border-radius:6px; margin-bottom:12px;">
                <strong>🕐 Check-out Tardío Solicitado</strong><br>
                Hora solicitada: <strong>${departureRequested}</strong><br>
                Suplemento: <span class="price-highlight">${r.late_checkout_supplement}€</span>
              </div>
            ` : ''}

            <form method="POST" action="/staff/pending-requests/${r.id}/process" style="margin-top:16px;">
              <div style="margin-bottom:12px;">
                <label style="display:block; margin-bottom:4px; font-weight:500;">📝 Notas del Manager (opcional)</label>
                <textarea name="manager_notes" rows="2" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;" placeholder="Comentarios internos..."></textarea>
              </div>

              <div class="approval-actions">
                <button type="submit" name="action" value="approve" class="btn-approve">
                  ✅ Aprobar y Enviar Enlace de Pago
                </button>
                <button type="submit" name="action" value="reject" class="btn-reject" onclick="return confirm('¿Seguro que quieres rechazar esta solicitud?')">
                  ❌ Rechazar Solicitud
                </button>
              </div>
            </form>
          </div>
        `;
      }).join('')}
    `;

    res.send(renderPage("Solicitudes Pendientes", html));
  } catch (e) {
    console.error("Error en /staff/pending-requests:", e);
    res.status(500).send("Error al cargar solicitudes");
  }
});

// ============================================

app.post("/staff/pending-requests/:id/process", async (req, res) => {
  try {
    const { id } = req.params;
    const { action, manager_notes } = req.body;

    // Obtener la solicitud
    const { rows: [request] } = await pool.query(
      `SELECT cts.*, c.phone, c.guest_language, c.full_name 
       FROM checkin_time_selections cts
       JOIN checkins c ON c.id = cts.checkin_id
       WHERE cts.id = $1`,
      [id]
    );

    if (!request) {
      return res.status(404).send("Solicitud no encontrada");
    }

    if (action === 'approve') {
      // Aprobar solicitud
      await pool.query(`
        UPDATE checkin_time_selections
        SET 
          approval_status = 'approved',
          approval_status_updated_at = NOW(),
          approved_by = 'manager',
          manager_notes = $1
        WHERE id = $2
      `, [manager_notes || null, id]);

      // TODO: Enviar mensaje de WhatsApp con enlace de pago
      // await sendWhatsAppApproval(request);

      console.log(`✅ Solicitud ${id} aprobada`);

    } else if (action === 'reject') {
      // Rechazar solicitud
      await pool.query(`
        UPDATE checkin_time_selections
        SET 
          approval_status = 'rejected',
          approval_status_updated_at = NOW(),
          approved_by = 'manager',
          manager_notes = $1,
          rejection_reason = $1
        WHERE id = $2
      `, [manager_notes || 'No disponible', id]);

      // TODO: Enviar mensaje de WhatsApp de rechazo
      // await sendWhatsAppRejection(request);

      console.log(`❌ Solicitud ${id} rechazada`);
    }

    res.redirect("/staff/pending-requests");
  } catch (e) {
    console.error("Error al procesar solicitud:", e);
    res.status(500).send("Error al procesar");
  }
});

// ============================================
// FIN DE LAS RUTAS DE APROBACIÓN
// ============================================
// ============================================

// RUTA 2: Configurar reglas para un apartamento específico
app.get("/manager/checkin-rules/:apartmentId", async (req, res) => {
  try {
    const { apartmentId } = req.params;

    // Obtener info del apartamento
    const { rows: [apartment] } = await pool.query(
      `SELECT apartment_name FROM beds24_rooms WHERE beds24_room_id = $1`,
      [apartmentId]
    );

    if (!apartment) {
      return res.status(404).send("Apartamento no encontrado");
    }

    // Obtener reglas existentes o valores por defecto
    const { rows: [rules] } = await pool.query(
      `SELECT * FROM early_late_checkout_rules WHERE apartment_id = $1`,
      [apartmentId]
    );

    const r = rules || {
      standard_checkin_time: '17:00',
      standard_checkout_time: '11:00',
      early_checkin_option1_time: '14:00',
      early_checkin_option1_price: 20,
      early_checkin_option1_enabled: true,
      early_checkin_option2_time: '15:00',
      early_checkin_option2_price: 15,
      early_checkin_option2_enabled: true,
      early_checkin_option3_time: '16:00',
      early_checkin_option3_price: 10,
      early_checkin_option3_enabled: true,
      late_checkout_option1_time: '12:00',
      late_checkout_option1_price: 10,
      late_checkout_option1_enabled: true,
      late_checkout_option2_time: '13:00',
      late_checkout_option2_price: 15,
      late_checkout_option2_enabled: true,
      late_checkout_option3_time: '14:00',
      late_checkout_option3_price: 20,
      late_checkout_option3_enabled: true,
      earliest_possible_checkin: '14:00',
      latest_possible_checkout: '14:00',
      is_active: true
    };

    const html = `
      <style>
        .config-section {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .config-section h2 {
          margin: 0 0 16px 0;
          font-size: 18px;
          color: #111827;
        }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .form-row {
          display: grid;
          grid-template-columns: 200px 100px 100px 80px;
          gap: 12px;
          align-items: center;
          padding: 12px;
          background: #f9fafb;
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .form-row label {
          font-weight: 500;
        }
        .form-row input[type="time"],
        .form-row input[type="number"] {
          padding: 8px;
          border: 1px solid #d1d5db;
          border-radius: 4px;
        }
        .form-row input[type="number"] {
          width: 80px;
        }
        @media (max-width: 768px) {
          .form-grid { grid-template-columns: 1fr; }
          .form-row {
            grid-template-columns: 1fr;
            gap: 8px;
          }
        }
      </style>

      <h1>Configurar Check-in/Check-out</h1>
      <h2 style="color:#6b7280; font-weight:normal; margin:-10px 0 20px;">${escapeHtml(apartment.apartment_name)}</h2>
      <p><a href="/manager/checkin-rules">← Volver a la lista</a></p>

      <form method="POST" action="/manager/checkin-rules/${encodeURIComponent(apartmentId)}/save">
        
        <!-- Horas Estándar -->
        <div class="config-section">
          <h2>⏰ Horas Estándar</h2>
          <div class="form-grid">
            <div>
              <label>Check-in estándar</label>
              <input type="time" name="standard_checkin_time" value="${r.standard_checkin_time}" required />
            </div>
            <div>
              <label>Check-out estándar</label>
              <input type="time" name="standard_checkout_time" value="${r.standard_checkout_time}" required />
            </div>
          </div>
        </div>

        <!-- Early Check-in -->
        <div class="config-section">
          <h2>🕐 Check-in Anticipado</h2>
          <p class="muted" style="margin:0 0 12px;">Opciones que se ofrecerán a los huéspedes cuando soliciten entrada temprana</p>
          
          <div class="form-row">
            <label>Opción 1</label>
            <input type="time" name="early_checkin_option1_time" value="${r.early_checkin_option1_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option1_price" value="${r.early_checkin_option1_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option1_enabled" ${r.early_checkin_option1_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 2</label>
            <input type="time" name="early_checkin_option2_time" value="${r.early_checkin_option2_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option2_price" value="${r.early_checkin_option2_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option2_enabled" ${r.early_checkin_option2_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 3</label>
            <input type="time" name="early_checkin_option3_time" value="${r.early_checkin_option3_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option3_price" value="${r.early_checkin_option3_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option3_enabled" ${r.early_checkin_option3_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>
        </div>

        <!-- Late Checkout -->
        <div class="config-section">
          <h2>🕐 Check-out Tardío</h2>
          <p class="muted" style="margin:0 0 12px;">Opciones que se ofrecerán a los huéspedes cuando soliciten salida tarde</p>
          
          <div class="form-row">
            <label>Opción 1</label>
            <input type="time" name="late_checkout_option1_time" value="${r.late_checkout_option1_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option1_price" value="${r.late_checkout_option1_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option1_enabled" ${r.late_checkout_option1_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 2</label>
            <input type="time" name="late_checkout_option2_time" value="${r.late_checkout_option2_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option2_price" value="${r.late_checkout_option2_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option2_enabled" ${r.late_checkout_option2_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 3</label>
            <input type="time" name="late_checkout_option3_time" value="${r.late_checkout_option3_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option3_price" value="${r.late_checkout_option3_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option3_enabled" ${r.late_checkout_option3_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>
        </div>

        <!-- Límites Absolutos -->
        <div class="config-section">
          <h2>⛔ Límites Absolutos</h2>
          <p class="muted" style="margin:0 0 12px;">Horas antes/después de las cuales NO se permite check-in/check-out bajo ninguna circunstancia</p>
          <div class="form-grid">
            <div>
              <label>Check-in más temprano posible</label>
              <input type="time" name="earliest_possible_checkin" value="${r.earliest_possible_checkin}" required />
            </div>
            <div>
              <label>Check-out más tardío posible</label>
              <input type="time" name="latest_possible_checkout" value="${r.latest_possible_checkout}" required />
            </div>
          </div>
        </div>

        <!-- Estado -->
        <div class="config-section">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="is_active" ${r.is_active ? 'checked' : ''} />
            <strong>Activar estas reglas para este apartamento</strong>
          </label>
        </div>

        <button type="submit" style="padding:12px 24px; font-size:16px;">💾 Guardar Configuración</button>
      </form>
    `;

    res.send(renderPage(`Configurar - ${apartment.apartment_name}`, html));
  } catch (e) {
    console.error("Error en /manager/checkin-rules/:apartmentId:", e);
    res.status(500).send("Error al cargar la configuración");
  }
});

// ============================================

// RUTA 3: Guardar configuración
app.post("/manager/checkin-rules/:apartmentId/save", async (req, res) => {
  try {
    const { apartmentId } = req.params;
    const {
      standard_checkin_time,
      standard_checkout_time,
      
      early_checkin_option1_time,
      early_checkin_option1_price,
      early_checkin_option1_enabled,
      
      early_checkin_option2_time,
      early_checkin_option2_price,
      early_checkin_option2_enabled,
      
      early_checkin_option3_time,
      early_checkin_option3_price,
      early_checkin_option3_enabled,
      
      late_checkout_option1_time,
      late_checkout_option1_price,
      late_checkout_option1_enabled,
      
      late_checkout_option2_time,
      late_checkout_option2_price,
      late_checkout_option2_enabled,
      
      late_checkout_option3_time,
      late_checkout_option3_price,
      late_checkout_option3_enabled,
      
      earliest_possible_checkin,
      latest_possible_checkout,
      is_active
    } = req.body;

    await pool.query(`
      INSERT INTO early_late_checkout_rules (
        apartment_id,
        standard_checkin_time,
        standard_checkout_time,
        early_checkin_option1_time,
        early_checkin_option1_price,
        early_checkin_option1_enabled,
        early_checkin_option2_time,
        early_checkin_option2_price,
        early_checkin_option2_enabled,
        early_checkin_option3_time,
        early_checkin_option3_price,
        early_checkin_option3_enabled,
        late_checkout_option1_time,
        late_checkout_option1_price,
        late_checkout_option1_enabled,
        late_checkout_option2_time,
        late_checkout_option2_price,
        late_checkout_option2_enabled,
        late_checkout_option3_time,
        late_checkout_option3_price,
        late_checkout_option3_enabled,
        earliest_possible_checkin,
        latest_possible_checkout,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (apartment_id)
      DO UPDATE SET
        standard_checkin_time = EXCLUDED.standard_checkin_time,
        standard_checkout_time = EXCLUDED.standard_checkout_time,
        early_checkin_option1_time = EXCLUDED.early_checkin_option1_time,
        early_checkin_option1_price = EXCLUDED.early_checkin_option1_price,
        early_checkin_option1_enabled = EXCLUDED.early_checkin_option1_enabled,
        early_checkin_option2_time = EXCLUDED.early_checkin_option2_time,
        early_checkin_option2_price = EXCLUDED.early_checkin_option2_price,
        early_checkin_option2_enabled = EXCLUDED.early_checkin_option2_enabled,
        early_checkin_option3_time = EXCLUDED.early_checkin_option3_time,
        early_checkin_option3_price = EXCLUDED.early_checkin_option3_price,
        early_checkin_option3_enabled = EXCLUDED.early_checkin_option3_enabled,
        late_checkout_option1_time = EXCLUDED.late_checkout_option1_time,
        late_checkout_option1_price = EXCLUDED.late_checkout_option1_price,
        late_checkout_option1_enabled = EXCLUDED.late_checkout_option1_enabled,
        late_checkout_option2_time = EXCLUDED.late_checkout_option2_time,
        late_checkout_option2_price = EXCLUDED.late_checkout_option2_price,
        late_checkout_option2_enabled = EXCLUDED.late_checkout_option2_enabled,
        late_checkout_option3_time = EXCLUDED.late_checkout_option3_time,
        late_checkout_option3_price = EXCLUDED.late_checkout_option3_price,
        late_checkout_option3_enabled = EXCLUDED.late_checkout_option3_enabled,
        earliest_possible_checkin = EXCLUDED.earliest_possible_checkin,
        latest_possible_checkout = EXCLUDED.latest_possible_checkout,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
    `, [
      apartmentId,
      standard_checkin_time,
      standard_checkout_time,
      early_checkin_option1_time || null,
      early_checkin_option1_price || 0,
      !!early_checkin_option1_enabled,
      early_checkin_option2_time || null,
      early_checkin_option2_price || 0,
      !!early_checkin_option2_enabled,
      early_checkin_option3_time || null,
      early_checkin_option3_price || 0,
      !!early_checkin_option3_enabled,
      late_checkout_option1_time || null,
      late_checkout_option1_price || 0,
      !!late_checkout_option1_enabled,
      late_checkout_option2_time || null,
      late_checkout_option2_price || 0,
      !!late_checkout_option2_enabled,
      late_checkout_option3_time || null,
      late_checkout_option3_price || 0,
      !!late_checkout_option3_enabled,
      earliest_possible_checkin,
      latest_possible_checkout,
      !!is_active
    ]);

    res.redirect(`/manager/checkin-rules/${apartmentId}?success=1`);
  } catch (e) {
    console.error("Error al guardar configuración:", e);
    res.status(500).send("Error al guardar");
  }
});

// ============================================
// FIN DE LAS RUTAS DE CONFIGURACIÓN
// ============================================

app.post("/manager/apartment/sections/save", async (req, res) => {
  try {
    const roomId = String(req.body.room_id || "").trim();
    if (!roomId) {
      return res.status(400).send("room_id required");
    }

    // 1) ADD new section
    if (req.body.add === "1") {
      const newTitle = String(req.body.new_title || "").trim();
      const newBody = String(req.body.new_body || "").trim();
      const newIcon = String(req.body.new_icon || "").trim();
      const newMediaType = String(req.body.new_media_type || "none").trim();
      const newMediaUrl = String(req.body.new_media_url || "").trim();
      const newSortOrder = parseInt(req.body.new_sort_order, 10) || 1;
      const newIsActive = req.body.new_is_active === "on";

      const translations = {
        title: {
          es: newTitle,
          en: String(req.body.new_title_en || "").trim(),
          fr: String(req.body.new_title_fr || "").trim(),
          de: String(req.body.new_title_de || "").trim(),
          ru: String(req.body.new_title_ru || "").trim()
        },
        body: {
          es: newBody,
          en: String(req.body.new_body_en || "").trim(),
          fr: String(req.body.new_body_fr || "").trim(),
          de: String(req.body.new_body_de || "").trim(),
          ru: String(req.body.new_body_ru || "").trim()
        }
      };

      await pool.query(
        `
        INSERT INTO apartment_sections 
          (room_id, title, body, icon, sort_order, is_active, new_media_type, new_media_url, translations)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          roomId,
          newTitle,
          newBody,
          newIcon,
          newSortOrder,
          newIsActive,
          newMediaType,
          newMediaUrl,
          JSON.stringify(translations)
        ]
      );

      return res.redirect(`/manager/apartment/sections?room_id=${roomId}`);
    }

    // 2) DELETE a section
    if (req.body.delete) {
      const deleteId = parseInt(req.body.delete, 10);
      await pool.query(
        `DELETE FROM apartment_sections WHERE id = $1 AND room_id::text = $2`,
        [deleteId, roomId]
      );
      return res.redirect(`/manager/apartment/sections?room_id=${roomId}`);
    }

    // 3) MOVE up/down
    if (req.body.move) {
      const [direction, idStr] = String(req.body.move).split(":");
      const moveId = parseInt(idStr, 10);

      const sections = await pool.query(
        `SELECT id, sort_order FROM apartment_sections WHERE room_id::text = $1 ORDER BY sort_order ASC, id ASC`,
        [roomId]
      );

      const arr = sections.rows;
      const idx = arr.findIndex((s) => s.id === moveId);

      if (idx !== -1) {
        if (direction === "up" && idx > 0) {
          const temp = arr[idx].sort_order;
          arr[idx].sort_order = arr[idx - 1].sort_order;
          arr[idx - 1].sort_order = temp;
        } else if (direction === "down" && idx < arr.length - 1) {
          const temp = arr[idx].sort_order;
          arr[idx].sort_order = arr[idx + 1].sort_order;
          arr[idx + 1].sort_order = temp;
        }

        for (const sec of arr) {
          await pool.query(
            `UPDATE apartment_sections SET sort_order = $1 WHERE id = $2`,
            [sec.sort_order, sec.id]
          );
        }
      }

      return res.redirect(`/manager/apartment/sections?room_id=${roomId}`);
    }

    // 4) SAVE all existing sections
    if (req.body.save === "1") {
      const allSections = await pool.query(
        `SELECT id FROM apartment_sections WHERE room_id::text = $1`,
        [roomId]
      );

      for (const sec of allSections.rows) {
        const id = sec.id;
        const sortOrder = parseInt(req.body[`sort_order_${id}`], 10) || 0;
        const isActive = req.body[`is_active_${id}`] === "on";
        const title = String(req.body[`title_${id}`] || "").trim();
        const body = String(req.body[`body_${id}`] || "").trim();
        const icon = String(req.body[`icon_${id}`] || "").trim();
        const mediaType = String(req.body[`new_media_type_${id}`] || "none").trim();
        const mediaUrl = String(req.body[`new_media_url_${id}`] || "").trim();

        const translations = {
          title: {
            es: title,
            en: String(req.body[`title_${id}_en`] || "").trim(),
            fr: String(req.body[`title_${id}_fr`] || "").trim(),
            de: String(req.body[`title_${id}_de`] || "").trim(),
            ru: String(req.body[`title_${id}_ru`] || "").trim()
          },
          body: {
            es: body,
            en: String(req.body[`body_${id}_en`] || "").trim(),
            fr: String(req.body[`body_${id}_fr`] || "").trim(),
            de: String(req.body[`body_${id}_de`] || "").trim(),
            ru: String(req.body[`body_${id}_ru`] || "").trim()
          }
        };

        await pool.query(
          `
          UPDATE apartment_sections
          SET 
            sort_order = $1,
            is_active = $2,
            title = $3,
            body = $4,
            icon = $5,
            new_media_type = $6,
            new_media_url = $7,
            translations = $8
          WHERE id = $9
          `,
          [
            sortOrder,
            isActive,
            title,
            body,
            icon,
            mediaType,
            mediaUrl,
            JSON.stringify(translations),
            id
          ]
        );
      }

      return res.redirect(`/manager/apartment/sections?room_id=${roomId}`);
    }

    return res.status(400).send("Unknown action");
  } catch (e) {
    console.error("sections save error:", e);
    return res.status(500).send(
      "Cannot save: " + (e.detail || e.message || String(e))
    );
  }
});

// AQUÍ DEBE EMPEZAR LA SIGUIENTE RUTA (NO MÁS CÓDIGO SUELTO)

// ===================== Beds24 Webhook (receiver) =====================

async function getProviderToken(provider, propertyExternalId) {
  const r = await pool.query(
    `
    SELECT credentials->>'token' AS token
    FROM provider_connections
    WHERE provider = $1
      AND property_external_id = $2
      AND is_enabled = true
    LIMIT 1
    `,
    [String(provider), String(propertyExternalId)]
  );

  const token = r.rows?.[0]?.token || "";
  if (!token) throw new Error(`Token not found for provider=${provider}, property=${propertyExternalId}`);
  return token;
}

async function beds24SmokeTest(token) {
  const resp = await fetch("https://api.beds24.com/v2/bookings", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { ok: resp.ok, status: resp.status, data };
}


app.post("/webhooks/beds24", async (req, res) => {
  try {
    const secret = String(req.query.key || "");
    if (secret !== String(process.env.BEDS24_SECRET || "")) {
      console.log("❌ Beds24 webhook: invalid secret");
      return res.status(401).send("Unauthorized");
    }
    // Detectar si la reserva está cancelada


    const payload = req.body || {};
    const booking = payload.booking || payload; // fallback

    if (!booking || !booking.id) {
      console.log("ℹ️ Beds24 webhook: no booking.id, ignored");
      return res.status(200).send("Ignored");
    }

    console.log("✅ Booking received:", booking.id);

    const isCancelled = (
  booking.status === 'cancelled' || 
  booking.status === 'canceled' ||
  booking.bookingStatus === 'cancelled' ||
  booking.bookingStatus === 'canceled'
);

console.log("📊 Booking status:", {
  id: booking.id,
  status: booking.status,
  bookingStatus: booking.bookingStatus,
  isCancelled: isCancelled
});
    
    // ---- room / apartment name ----
    const beds24RoomId = String(
      booking?.roomId ?? booking?.room?.id ?? booking?.unitId ?? ""
    );

    console.log("✅ webhook hit", { id: booking.id, roomId: beds24RoomId });

    let apartmentName = null;

    if (beds24RoomId) {
      const roomRes = await pool.query(
        `SELECT apartment_name
         FROM beds24_rooms
         WHERE beds24_room_id = $1 AND is_active = true
         LIMIT 1`,
        [beds24RoomId]
      );

      if (roomRes.rows.length) {
        apartmentName = roomRes.rows[0].apartment_name;
      }
    }

    // fallback — si en el manager aún no lo añadieron
    if (!apartmentName) {
      apartmentName =
        booking?.roomName ||
        booking?.unitName ||
        booking?.apartmentName ||
        booking?.room?.name ||
        booking?.unit?.name ||
        null;
    }

    const beds24BookingId = booking?.id ?? null;
    const beds24Raw = payload;
    
    // ---- guest fields ----
    const guest = payload.guest || booking.guest || booking.guestData || {};
    const fullName =
      guest.name ||
      [guest.firstName, guest.lastName].filter(Boolean).join(" ") ||
      guest.fullName ||
      booking.guestName ||
      booking.name ||
      [booking.firstName, booking.lastName].filter(Boolean).join(" ") ||
      "Beds24 Guest";

    const email = guest.email || guest.emailAddress || "unknown@beds24";

    const phone =
      guest.phone ||
      guest.mobile ||
      guest.phoneNumber ||
      booking.phone ||
      booking.mobile ||
      booking.phoneNumber ||
      "";

    // ---- 🌐 DETECTAR IDIOMA DEL HUÉSPED ----
// ---- 🌐 DETECTAR IDIOMA DEL HUÉSPED CON FALLBACK ----
const guestLanguageRaw = (
  payload.guestLanguage ||
  booking.guestLanguage || 
  guest.language || 
  booking.language || 
  booking.languageCode ||
  booking.locale ||
  'en'
).toLowerCase();

// Mapear códigos ISO a nuestros idiomas
const langMap = {
  'en': 'en', 'eng': 'en', 'english': 'en',
  'es': 'es', 'esp': 'es', 'spa': 'es', 'spanish': 'es',
  'fr': 'fr', 'fra': 'fr', 'fre': 'fr', 'french': 'fr',
  'de': 'de', 'deu': 'de', 'ger': 'de', 'german': 'de',
  'ru': 'ru', 'rus': 'ru', 'russian': 'ru'
};

// Idiomas soportados (alemán no soportado → inglés)
const supportedLangs = ['es', 'en', 'fr', 'ru'];

// Obtener código de 2 letras
let guestLanguage = langMap[guestLanguageRaw.substring(0, 3)] || 
                    langMap[guestLanguageRaw.substring(0, 2)] || 
                    'en';

// Si NO está soportado → fallback a inglés
const isFallback = !supportedLangs.includes(guestLanguage);
if (isFallback) {
  guestLanguage = 'en';
}

// 🔍 LOG - Ver detección de idioma
console.log("🌐 Language detection:", {
  raw: guestLanguageRaw,
  detected: guestLanguage,
  fallback: isFallback ? `(unsupported: ${guestLanguageRaw})` : false
});

    // ---- adults / children (Beds24) ----
    const adults = Number.isFinite(Number(booking?.numAdult)) ? Number(booking.numAdult) : 0;
    const children = Number.isFinite(Number(booking?.numChild)) ? Number(booking.numChild) : 0;

    console.log("👥 Guests parsed:", { adults, children, raw: { numAdult: booking?.numAdult, numChild: booking?.numChild } });

    const arrivalDate =
      booking?.arrival?.date ??
      booking?.arrivalDate ??
      booking?.checkin?.date ??
      booking?.checkinDate ??
      booking?.arrival ??
      null;

    const departureDate =
      booking?.departure?.date ??
      booking?.departureDate ??
      booking?.checkout?.date ??
      booking?.checkoutDate ??
      booking?.departure ??
      null;

    const arrivalTime = booking?.arrival?.time || booking?.arrivalTime || null;
    const departureTime = booking?.departure?.time || booking?.departureTime || null;

    // ---- save/refresh roomId -> apartmentName mapping (auto) ----
    if (beds24RoomId && beds24RoomId !== "undefined" && beds24RoomId !== "null") {
      await pool.query(
        `INSERT INTO beds24_rooms (beds24_room_id, apartment_name, is_active)
         VALUES ($1, COALESCE($2, ''), true)
         ON CONFLICT (beds24_room_id)
         DO UPDATE SET
           apartment_name = COALESCE(EXCLUDED.apartment_name, beds24_rooms.apartment_name),
           is_active = true,
           updated_at = NOW()`,
        [String(beds24RoomId), apartmentName ? String(apartmentName) : ""]
      );
    }

    // ---- upsert con guest_language ----
    await pool.query(
      `INSERT INTO checkins (
        apartment_id,
        booking_token,
        beds24_booking_id,
        beds24_room_id,
        apartment_name,
        full_name,
        email,
        phone,
        arrival_date,
        arrival_time,
        departure_date,
        departure_time,
        adults,
        children,
        beds24_raw,
        guest_language,
        cancelled
      )
     VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8,
  $9, $10, $11, $12,
  $13, $14,
  $15::jsonb,
  $16,
  $17
)
      ON CONFLICT (beds24_booking_id)
      DO UPDATE SET
        apartment_id        = EXCLUDED.apartment_id,
        beds24_booking_id   = EXCLUDED.beds24_booking_id,
        beds24_room_id      = COALESCE(EXCLUDED.beds24_room_id, checkins.beds24_room_id),
        apartment_name      = COALESCE(EXCLUDED.apartment_name, checkins.apartment_name),
        full_name           = EXCLUDED.full_name,
        email               = EXCLUDED.email,
        phone               = EXCLUDED.phone,
        arrival_date        = COALESCE(EXCLUDED.arrival_date, checkins.arrival_date),
        arrival_time        = COALESCE(EXCLUDED.arrival_time, checkins.arrival_time),
        departure_date      = COALESCE(EXCLUDED.departure_date, checkins.departure_date),
        departure_time      = COALESCE(EXCLUDED.departure_time, checkins.departure_time),
        adults              = COALESCE(EXCLUDED.adults, checkins.adults),
        children            = COALESCE(EXCLUDED.children, checkins.children),
        beds24_raw          = COALESCE(EXCLUDED.beds24_raw, checkins.beds24_raw),
        guest_language      = EXCLUDED.guest_language,
         cancelled           = EXCLUDED.cancelled
        `,
      
      
      [
        String(beds24RoomId || ""),           // $1  apartment_id
        `beds24_${String(booking.id || "")}`, // $2  booking_token  
        beds24BookingId,                      // $3  beds24_booking_id
        String(beds24RoomId || ""),           // $4  beds24_room_id
        apartmentName,                        // $5  apartment_name
        fullName,                             // $6
        email,                                // $7
        phone,                                // $8
        arrivalDate,                          // $9
        arrivalTime,                          // $10
        departureDate,                        // $11
        departureTime,                        // $12
        adults,                               // $13
        children,                             // $14
        JSON.stringify(beds24Raw),            // $15
        guestLanguage,                         // $16 🌐 NUEVO
        isCancelled 
      ]
    );

    console.log("✅ webhook upsert done", booking.id);
    console.log("✅ Booking saved:", booking.id, "| Language:", guestLanguage);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ DB insert error:", err);
    res.status(500).send("DB error");
  }
});

// ===================== GUEST ROUTES =====================

app.get("/", (req, res) => {
  // Si ya está autenticado, redirigir según rol
  if (req.session.user) {
    const role = req.session.user.role;
    
    if (role === 'STAFF_CLEANING') {
      return res.redirect('/staff/my-cleanings');
    } else if (role === 'CLEANING_MANAGER') {
      return res.redirect('/staff/checkins');
    } else {
      return res.redirect('/manager');
    }
  }

  // Landing page para usuarios no autenticados
  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>RCS Check-in - Rental Connect Solutions</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        
        .landing-container {
          text-align: center;
          color: white;
          max-width: 500px;
        }
        
        .logo {
          font-size: 80px;
          margin-bottom: 20px;
          animation: float 3s ease-in-out infinite;
        }
        
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        
        h1 {
          font-size: 48px;
          font-weight: 700;
          margin-bottom: 10px;
          text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        
        .subtitle {
          font-size: 18px;
          opacity: 0.9;
          margin-bottom: 30px;
          font-weight: 300;
        }
        
        .company {
          font-size: 14px;
          opacity: 0.8;
          margin-bottom: 40px;
          font-weight: 400;
          letter-spacing: 1px;
        }
        
        .btn-login {
          display: inline-block;
          padding: 16px 40px;
          background: white;
          color: #667eea;
          text-decoration: none;
          border-radius: 50px;
          font-weight: 600;
          font-size: 16px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.2);
          transition: all 0.3s ease;
        }
        
        .btn-login:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0,0,0,0.3);
        }
        
        .features {
          margin-top: 50px;
          font-size: 14px;
          opacity: 0.85;
          line-height: 1.8;
        }
        
        @media (max-width: 600px) {
          h1 { font-size: 36px; }
          .logo { font-size: 60px; }
          .subtitle { font-size: 16px; }
        }
      </style>
    </head>
    <body>
      <div class="landing-container">
        <div class="logo">🔐</div>
        <h1>RCS Check-in</h1>
        <p class="company">by Rental Connect Solutions</p>
        <p class="subtitle">Sistema de gestión para alquileres vacacionales</p>
        
        <a href="/login" class="btn-login">Iniciar Sesión →</a>
        
        <div class="features">
          <p>Gestiona tus propiedades, automatiza WhatsApp, y más</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  res.send(html);
});



app.get("/guest/:bookingId", async (req, res) => {
  const { bookingId } = req.params;
  console.log("🔍 Request for bookingId:", bookingId);
  
  // Detectar idioma
  const lang = String(req.query.lang || 'es').toLowerCase().substring(0, 2);
  const validLangs = ['es', 'en', 'fr', 'de', 'ru'];
  const currentLang = validLangs.includes(lang) ? lang : 'es';
  
  try {
    // Buscar la reserva
    const result = await pool.query(
      `SELECT c.*, 
              br.apartment_name as apartment_from_rooms,
              br.beds24_room_id as room_id_from_rooms
       FROM checkins c
       LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.apartment_id::text
       WHERE (
         REPLACE(c.beds24_booking_id::text, ' ', '') = $1
         OR c.booking_token = $2
         OR c.booking_token = $3
       )
       AND (c.cancelled IS NULL OR c.cancelled = false)
       AND c.departure_date + INTERVAL '1 day 18 hours' >= NOW()
       LIMIT 1`,
      [bookingId, bookingId, `beds24_${bookingId}`]
    );
    
    console.log("📊 Query result:", result.rows.length);
    
    if (result.rows.length === 0) {
      console.log("❌ Booking not found for:", bookingId);
      return res.status(404).send(renderPage("Not Found", `
        <h1>❌ Reserva no encontrada</h1>
        <p>La reserva ${bookingId} no existe.</p>
        <p><a href="/" class="btn-link">← Volver</a></p>
      `));
    }
    
    const r = result.rows[0];
    const apartmentName = r.apartment_name || r.apartment_from_rooms || 'N/A';
    
    // Usar beds24_room_id en lugar de room_id interno
const roomIdToUse = r.beds24_room_id || r.apartment_id || '0';
    
    console.log("✅ Booking data:", {
      id: r.beds24_booking_id,
      name: r.full_name,
      room_id: r.room_id,
      room_id_from_rooms: r.room_id_from_rooms,
      room_id_to_use: roomIdToUse,
      apartment: apartmentName
    });
    
    // Cargar secciones del apartamento
    const secRes = await pool.query(
      `SELECT id, title, body, icon, new_media_type, new_media_url, translations
       FROM apartment_sections
       WHERE room_id::text = $1
         AND is_active = true
       ORDER BY sort_order ASC, id ASC`,
      [String(roomIdToUse)]
    );
    
    console.log("📋 Sections found:", secRes.rows.length, "for room_id:", roomIdToUse);
    
    // Textos traducidos

    const uiText = {
  es: {
    welcome: 'Bienvenido',
    apartment: 'Apartamento',
    guest: 'Huésped',
    reservation: 'Reserva',
    arrival: 'Llegada',
    departure: 'Salida',
    guests: 'Huéspedes',
    adults: 'adultos',
    children: 'niños',
    people: 'personas',
    accessCode: 'Código de acceso',
    codeWillAppear: 'Tu código aparecerá el día de tu llegada cuando el apartamento esté limpio.', 
    showCode: 'Mostrar código',
    noShareCode: 'No compartas este código con terceros.',
    apartmentInfo: 'Información del apartamento',
    noInfo: 'Todavía no hay información para este apartamento.',
  },
  en: {
    welcome: 'Welcome',
    apartment: 'Apartment',
    guest: 'Guest',
    reservation: 'Reservation',
    arrival: 'Arrival',
    departure: 'Departure',
    guests: 'Guests',
    adults: 'adults',
    children: 'children',
    people: 'people',
    accessCode: 'Access code',
    codeWillAppear: 'Your code will appear on your arrival day when the apartment is clean.',
    showCode: 'Show code',
    noShareCode: 'Do not share this code with third parties.',
    apartmentInfo: 'Apartment information',
    noInfo: 'No information available yet for this apartment.',
  },
  ru: {
    welcome: 'Добро пожаловать',
    apartment: 'Квартира',
    guest: 'Гость',
    reservation: 'Бронирование',
    arrival: 'Прибытие',
    departure: 'Отъезд',
    guests: 'Гости',
    adults: 'взрослых',
    children: 'детей',
    people: 'человек',
    accessCode: 'Код доступа',
    codeWillAppear: 'Ваш код появится в день заезда, когда квартира будет убрана.',
    showCode: 'Показать код',
    noShareCode: 'Не делитесь этим кодом с третьими лицами.',
    apartmentInfo: 'Информация о квартире',
    noInfo: 'Информация для этой квартиры пока недоступна.',
  },
  fr: {
    welcome: 'Bienvenue',
    apartment: 'Appartement',
    guest: 'Invité',
    reservation: 'Réservation',
    arrival: 'Arrivée',
    departure: 'Départ',
    guests: 'Invités',
    adults: 'adultes',
    children: 'enfants',
    people: 'personnes',
    accessCode: "Code d'accès",
    codeWillAppear: "Votre code apparaîtra le jour de votre arrivée lorsque l'appartement sera propre.",
    showCode: 'Afficher le code',
    noShareCode: 'Ne partagez pas ce code avec des tiers.',
    apartmentInfo: "Informations sur l'appartement",
    noInfo: "Aucune information disponible pour cet appartement pour le moment.",
  },
  de: {
    welcome: 'Willkommen',
    apartment: 'Wohnung',
    guest: 'Gast',
    reservation: 'Reservierung',
    arrival: 'Ankunft',
    departure: 'Abreise',
    guests: 'Gäste',
    adults: 'Erwachsene',
    children: 'Kinder',
    people: 'Personen',
    accessCode: 'Zugangscode',
    codeWillAppear: 'Ihr Code wird am Tag Ihrer Ankunft erscheinen, wenn die Wohnung sauber ist.',
    showCode: 'Code anzeigen',
    noShareCode: 'Teilen Sie diesen Code nicht mit Dritten.',
    apartmentInfo: 'Wohnungsinformationen',
    noInfo: 'Für diese Wohnung sind noch keine Informationen verfügbar.',
  },
};

    
    const t = uiText[currentLang] || uiText.es;
    const totalGuests = (Number(r.adults) || 0) + (Number(r.children) || 0);
    
    // Helper para traducciones
    function getTranslatedText(section, field, lang) {
      // Si no hay traducciones, usar el campo base
      if (!section.translations) return section[field] || '';
      
      try {
        const trans = typeof section.translations === 'string' 
          ? JSON.parse(section.translations) 
          : section.translations;
        
        // Buscar traducción en el idioma solicitado
        if (trans[field] && trans[field][lang]) {
          const text = trans[field][lang].trim();
          if (text) return text; // Si tiene contenido, usarlo
        }
        
        // Fallback: intentar español primero
        if (trans[field] && trans[field]['es']) {
          const text = trans[field]['es'].trim();
          if (text) return text;
        }
        
        // Fallback: intentar inglés
        if (trans[field] && trans[field]['en']) {
          const text = trans[field]['en'].trim();
          if (text) return text;
        }
      } catch (e) {
        console.error('Translation parse error:', e);
      }
      
      // Último fallback: campo base
      return section[field] || '';
    }
    
    // 🆕 Helper para convertir URLs de YouTube
   function getYouTubeEmbedUrl(url) {
  if (!url) return null;
  
  // Detectar si es un video directo (.mp4, .webm, .ogg)
  if (url.match(/\.(mp4|webm|ogg|mov)(\?|$)/i)) {
    return { type: 'direct', url: url };
  }
  
  // Detectar Vimeo
  const vimeoMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:player\.)?vimeo\.com\/(?:video\/|channels\/\w+\/)?(\d+)/);
  if (vimeoMatch && vimeoMatch[1]) {
    return { type: 'vimeo', url: `https://player.vimeo.com/video/${vimeoMatch[1]}` };
  }
  
  // Patrones de YouTube (incluyendo Shorts)
  const youtubePatterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/
  ];
  
  for (const pattern of youtubePatterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return { type: 'youtube', url: `https://www.youtube.com/embed/${match[1]}` };
    }
  }
  
  return null;
}
    
    // Generar HTML de secciones
    const sectionsHtml = secRes.rows.length === 0
      ? `<div class="muted">${t.noInfo}</div>`
      : `<h2 style="margin-top:18px;">${t.apartmentInfo}</h2>
         <div id="guest-accordion">
           ${secRes.rows.map((s) => {
             const icon = s.icon ? `${s.icon} ` : '';
             const translatedTitle = getTranslatedText(s, 'title', currentLang);
             const title = icon + escapeHtml(translatedTitle);
             const rawBody = getTranslatedText(s, 'body', currentLang);
             
             const bodyHtml = escapeHtml(rawBody)
               .replace(/\n/g, "<br/>")
               .replace(/(https?:\/\/[^\s<]+)/g, (url) => {
                 const safeUrl = escapeHtml(url);
                 return `<a href="${safeUrl}" target="_blank" rel="noopener" class="btn-link">${safeUrl}</a>`;
               });
             
             // 🆕 Generar HTML para media (video/imagen/mapa/enlace)
             let mediaHtml = '';
             if (s.new_media_url && s.new_media_type) {
               const mediaUrl = String(s.new_media_url).trim();
               
              if (s.new_media_type === 'video') {
  const embedResult = getYouTubeEmbedUrl(mediaUrl);
  
  if (embedResult) {
    if (embedResult.type === 'youtube' || embedResult.type === 'vimeo') {
      // YouTube o Vimeo - usar iframe
      mediaHtml = `
        <div style="margin-top:16px;">
          <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;background:#000;border-radius:8px;">
            <iframe 
              src="${escapeHtml(embedResult.url)}" 
              style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
              allowfullscreen>
            </iframe>
          </div>
        </div>
      `;
    } 
    else if (embedResult.type === 'direct') {
      // Video directo (.mp4, .webm, etc.) - usar <video> tag
      mediaHtml = `
        <div style="margin-top:16px;">
          <video 
            controls 
            style="width:100%;max-width:100%;border-radius:8px;display:block;background:#000;"
            preload="metadata">
            <source src="${escapeHtml(embedResult.url)}" type="video/mp4">
            Your browser does not support the video tag.
          </video>
        </div>
      `;
    }
    }
              } else if (s.new_media_type === 'image') {
  // Soportar múltiples imágenes separadas por saltos de línea
  const imageUrls = mediaUrl.split('\n').map(url => url.trim()).filter(url => url.length > 0);
  
  if (imageUrls.length === 1) {
    // Una sola imagen
    mediaHtml = `
      <div style="margin-top:16px;">
        <img 
          src="${escapeHtml(imageUrls[0])}" 
          alt="${escapeHtml(translatedTitle)}"
          style="max-width:100%;height:auto;border-radius:8px;display:block;"
          loading="lazy"
        />
      </div>
    `;
  } else if (imageUrls.length > 1) {
    // Múltiples imágenes en galería (2 columnas)
    const galleryImages = imageUrls.map(url => `
      <div style="flex:0 0 48%;margin-bottom:12px;">
        <img 
          src="${escapeHtml(url)}" 
          alt="${escapeHtml(translatedTitle)}"
          style="width:100%;height:auto;border-radius:8px;display:block;object-fit:cover;"
          loading="lazy"
        />
      </div>
    `).join('');
    
    mediaHtml = `
      <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:4%;">
        ${galleryImages}
      </div>
    `;
  }
} else if (s.new_media_type === 'map') {
                 // Google Maps embebido
                 mediaHtml = `
                   <div style="margin-top:16px;">
                     <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;background:#f3f4f6;border-radius:8px;">
                       <iframe 
                         src="${escapeHtml(mediaUrl)}" 
                         style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
                         allowfullscreen 
                         loading="lazy">
                       </iframe>
                     </div>
                   </div>
                 `;
               } else if (s.new_media_type === 'link') {
                 // Enlace externo como botón
                 mediaHtml = `
                   <div style="margin-top:16px;">
                     <a 
                       href="${escapeHtml(mediaUrl)}" 
                       target="_blank" 
                       rel="noopener noreferrer"
                       style="display:inline-block;padding:12px 24px;background:#3b82f6;color:white;text-decoration:none;border-radius:8px;font-weight:600;transition:background 0.2s;"
                       onmouseover="this.style.background='#2563eb'" 
                       onmouseout="this.style.background='#3b82f6'">
                       🔗 Open link
                     </a>
                   </div>
                 `;
               }
             }
             
             const panelId = `acc_${s.id}`;
             
             return `
               <div style="border:1px solid #e5e7eb;border-radius:14px;margin:10px 0;overflow:hidden;background:#fff;">
                 <button type="button" data-acc-btn="${panelId}"
                   style="width:100%;text-align:left;padding:12px 14px;border:0;background:#f9fafb;cursor:pointer;font-weight:600;">
                   ${title}
                 </button>
                 <div id="${panelId}" style="display:none;padding:12px 14px;">
                   <div>${bodyHtml}</div>
                   ${mediaHtml}
                 </div>
               </div>
             `;
           }).join('')}
         </div>
         <script>
           (function () {
             var buttons = document.querySelectorAll("[data-acc-btn]");
             buttons.forEach(function (btn) {
               btn.addEventListener("click", function () {
                 var id = btn.getAttribute("data-acc-btn");
                 var panel = document.getElementById(id);
                 if (!panel) return;
                 panel.style.display = (panel.style.display === "block") ? "none" : "block";
               });
             });
           })();
         </script>`;
    
    // Renderizar página
    const html = `
      <div style="text-align:right; margin-bottom:12px;">
        <select onchange="window.location.href = window.location.pathname + '?lang=' + this.value" 
                style="padding:6px 10px; border-radius:8px; border:1px solid #d1d5db; background:#fff; font-size:18px; cursor:pointer; width:80px;">
          <option value="es" ${currentLang === 'es' ? 'selected' : ''}>🇪🇸</option>
          <option value="en" ${currentLang === 'en' ? 'selected' : ''}>🇬🇧</option>
          <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>🇫🇷</option>
          <option value="de" ${currentLang === 'de' ? 'selected' : ''}>🇩🇪</option>
          <option value="ru" ${currentLang === 'ru' ? 'selected' : ''}>🇷🇺</option>
        </select>
      </div>
      
      <div class="card">
        <!-- ✅ HEADER COMPACTO -->
        <div style="text-align:center; margin-bottom:20px;">
          <h1 style="margin-bottom:4px; font-size:24px;">${t.welcome}</h1>
          <div style="font-size:16px; color:#6b7280; margin-bottom:2px;">${escapeHtml(apartmentName)}</div>
          <div style="font-size:11px; color:#9ca3af;">${t.reservation}: ${escapeHtml(String(r.beds24_booking_id || ""))}</div>
        </div>
        
        <!-- ✅ CARD COMPACTA CON GRID -->
        <div style="border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:16px;">
          
          <!-- Nombre del huésped - MÁS COMPACTO -->
          <div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid #e5e7eb;">
            <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:6px;">${t.guest}</div>
            ${formatGuestName(r.full_name)}
          </div>
          
          <!-- Grid de fechas - 2 columnas en móvil también -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid #e5e7eb;">
            <div>
              <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.arrival}</div>
              <div style="font-size:15px; font-weight:600;">${fmtDate(r.arrival_date)}</div>
              ${r.arrival_time ? `<div style="color:#6b7280; font-size:13px;">${fmtTime(r.arrival_time)}</div>` : ''}
            </div>
            <div>
              <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.departure}</div>
              <div style="font-size:15px; font-weight:600;">${fmtDate(r.departure_date)}</div>
              ${r.departure_time ? `<div style="color:#6b7280; font-size:13px;">${fmtTime(r.departure_time)}</div>` : ''}
            </div>
          </div>
          
          <!-- Huéspedes - Más compacto -->
          <div>
            <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.guests}</div>
            <div style="font-size:15px;"><span style="font-weight:600;">${totalGuests}</span> ${t.people} <span style="color:#d1d5db;">•</span> ${Number(r.adults) || 0} ${t.adults}, ${Number(r.children) || 0} ${t.children}</div>
          </div>
        </div>
        
    ${r.lock_visible && r.lock_code ? `
  <div style="border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:16px; background:#f9fafb;">
    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:6px;">
      🔑 ${t.accessCode}
    </div>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <span id="lockCodeMasked" style="font-size:20px; letter-spacing:2px; color:#374151; font-family:monospace;">••••</span>
      <span id="lockCodeValue" style="display:none; font-size:24px; font-weight:700; letter-spacing:2px; color:#374151; font-family:monospace;">
        ${escapeHtml(String(r.lock_code))}
      </span>
      <button type="button" onclick="toggleLockCode()"
        style="display:inline-block; padding:8px 14px; background:#3b82f6; color:white; border:0; border-radius:8px; font-weight:600; cursor:pointer; font-size:14px;">
        ${t.showCode}
      </button>
    </div>
    <p style="margin:8px 0 0; color:#6b7280; font-size:12px;">${t.noShareCode}</p>
  </div>
` : !r.lock_visible ? `
  <div style="border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:16px; background:#f9fafb;">
    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:6px;">
      🔑 ${t.accessCode}
    </div>
    <p style="margin:8px 0 0; color:#6b7280; font-size:13px; font-style:italic;">
      ℹ️ ${t.codeWillAppear}
    </p>
  </div>
        ` : ''}
        
        ${sectionsHtml}
        
        <script>
          function toggleLockCode() {
            var masked = document.getElementById("lockCodeMasked");
            var value = document.getElementById("lockCodeValue");
            if (!masked || !value) return;
            var isHidden = value.style.display === "none";
            value.style.display = isHidden ? "inline" : "none";
            masked.style.display = isHidden ? "none" : "inline";
          }
        </script>
      </div>
    `;
    
    return res.send(renderPage("Panel del huésped", html, '', false));
    
  } catch (e) {
    console.error("❌ Guest dashboard error:", e);
    console.error("Stack:", e.stack);
    return res.status(500).send(renderPage("Error", `
      <div class="card">
        <h1>Error</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
      </div>
    `));
  }
});


// ============ FORMATEAR NOMBRE CON INICIALES ============
function formatGuestName(fullName) {
  if (!fullName) return '—';
  
  const parts = String(fullName).trim().split(/\s+/);
  
  if (parts.length === 1) {
    // Solo un nombre
    return escapeHtml(parts[0]);
  }
  
  // Primera parte completa + iniciales del resto
  const firstName = parts[0];
  const initials = parts.slice(1).map(p => p.charAt(0).toUpperCase() + '.').join(' ');
  
  return escapeHtml(`${firstName} ${initials}`);
}
// ===================== STAFF: CHECKINS LIST (FIXED) =====================

app.get('/login', (req, res) => {
  const redirect = req.query.redirect || '/staff';
  const error = req.query.error;

  const html = `
    <div class="card" style="max-width:400px; margin:100px auto;">
      <div style="text-align:center; margin-bottom:30px;">
        <h1 style="font-size:28px; margin-bottom:8px;">🔐 RCS Check-in</h1>
        <p style="color:#6b7280; font-size:14px;">Inicia sesión para continuar</p>
      </div>

      ${error ? `
        <div style="background:#fee2e2; border:1px solid #fca5a5; padding:12px; border-radius:8px; margin-bottom:20px; color:#991b1b;">
          ❌ ${error === 'invalid' ? 'Email o contraseña incorrectos' : 'Error al iniciar sesión'}
        </div>
      ` : ''}

      <form method="POST" action="/login" style="display:flex; flex-direction:column; gap:16px;">
        <input type="hidden" name="redirect" value="${escapeHtml(redirect)}" />

        <div>
          <label style="display:block; font-size:14px; font-weight:600; margin-bottom:6px; color:#374151;">
            Email
          </label>
          <input 
            type="email" 
            name="email" 
            required 
            autofocus
            placeholder="tu@email.com"
            style="width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:15px;"
          />
        </div>

        <div>
          <label style="display:block; font-size:14px; font-weight:600; margin-bottom:6px; color:#374151;">
            Contraseña
          </label>
          <input 
            type="password" 
            name="password" 
            required
            placeholder="••••••••"
            style="width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:15px;"
          />
        </div>

        <button 
          type="submit" 
          style="width:100%; padding:12px; background:#3b82f6; color:white; border:0; border-radius:8px; font-size:16px; font-weight:600; cursor:pointer; margin-top:8px;">
          Iniciar Sesión
        </button>
      </form>

      <p style="text-align:center; margin-top:24px; font-size:13px; color:#9ca3af;">
        ¿Problemas? Contacta al administrador
      </p>
    </div>
  `;

  res.send(renderPage('Iniciar Sesión', html, '', false));
});

// ============================================
// RUTA: Procesar Login (POST)
// ============================================

app.post('/login', async (req, res) => {
  const { email, password, redirect = '/staff' } = req.body;
  
  if (!email || !password) {
    return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirect));
  }
  
  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    
    if (result.rows.length === 0) {
      console.log('❌ Login failed: User not found -', email);
      return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirect));
    }
    
    const user = result.rows[0];
    
    if (!user.is_active) {
      console.log('❌ Login failed: User inactive -', email);
      return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirect));
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordMatch) {
      console.log('❌ Login failed: Wrong password -', email);
      return res.redirect('/login?error=invalid&redirect=' + encodeURIComponent(redirect));
    }
    
   // ✅ Login exitoso
req.session.userId = user.id;
req.session.userEmail = user.email;
req.session.userRole = user.role || 'STAFF_CLEANING'; // ✅ AÑADIR
req.session.userName = user.full_name;

// ✅ AÑADIR: Objeto user completo para facilitar acceso
req.session.user = {
  id: user.id,
  email: user.email,
  name: user.full_name,
  role: user.role || 'STAFF_CLEANING'
};
    
    console.log('✅ Login successful:', user.email, '-', user.role);
    
    // ⚠️ IMPORTANTE: Guardar sesión antes de redirigir
    req.session.save((err) => {
      if (err) {
        console.error('❌ Error saving session:', err);
        return res.redirect('/login?error=system');
      }
      console.log('✅ Session saved, redirecting to:', redirect);
      return res.redirect(redirect);
    });
    
  } catch (e) {
    console.error('❌ Login error:', e);
    return res.redirect('/login?error=system&redirect=' + encodeURIComponent(redirect));
  }
});

// ============================================
// RUTA: Logout
// ============================================

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});
app.get('/staff', async (req, res) => {
  const user = await getCurrentUser(req);

  if (!user) {
    return res.redirect('/logout');
  }

  const roleLabels = {
    'ADMIN': '👑 Administrador',
    'MANAGER': '💼 Manager',
    'CLEANING_MANAGER': '🧹 Jefe de Limpieza',
    'STAFF_CLEANING': '🧹 Personal de Limpieza'
  };

  const html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
      <div>
        <h1 style="margin:0 0 4px;">Panel de Control</h1>
        <p style="margin:0; color:#6b7280;">
          ${roleLabels[user.role] || user.role} · ${escapeHtml(user.full_name)}
        </p>
      </div>
      <a href="/logout" style="background:#ef4444; color:white; text-decoration:none; padding:8px 16px; border-radius:8px; font-weight:600;">
        Cerrar Sesión
      </a>
    </div>

    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:16px;">
      
      <a href="/staff/checkins" class="card" style="text-decoration:none;">
        <h2 style="margin:0 0 8px; font-size:18px;">📅 Llegadas y Salidas</h2>
        <p style="margin:0; color:#6b7280; font-size:14px;">Gestionar check-ins y check-outs</p>
      </a>

      <a href="/manager/whatsapp" class="card" style="text-decoration:none;">
        <h2 style="margin:0 0 8px; font-size:18px;">💬 WhatsApp Manager</h2>
        <p style="margin:0; color:#6b7280; font-size:14px;">Configurar mensajes automáticos</p>
      </a>

      <a href="/manager/apartments" class="card" style="text-decoration:none;">
        <h2 style="margin:0 0 8px; font-size:18px;">🏠 Apartamentos</h2>
        <p style="margin:0; color:#6b7280; font-size:14px;">Gestionar información</p>
      </a>

    </div>
  `;

  res.send(renderPage('Panel de Control', html, 'staff'));
});


// Calcular estado de pago desde beds24_raw
function getPaymentStatus(beds24Raw) {
  try {
    if (!beds24Raw) return { paid: false, pending: 0 };
    
    const data = typeof beds24Raw === 'string' ? JSON.parse(beds24Raw) : beds24Raw;
    const invoiceItems = data.invoiceItems || [];
    
    let totalCharges = 0;
    let totalPayments = 0;
    
    for (const item of invoiceItems) {
      if (item.type === 'charge') {
        totalCharges += parseFloat(item.lineTotal || item.amount || 0);
      } else if (item.type === 'payment') {
        totalPayments += parseFloat(item.amount || 0);
      }
    }
    
    const pending = Math.round((totalCharges - totalPayments) * 100) / 100;
    
    return {
      paid: pending <= 0,
      pending: pending > 0 ? pending : 0,
      totalCharges,
      totalPayments
    };
  } catch (e) {
    console.error('Error parsing payment status:', e);
    return { paid: false, pending: 0 };
  }
}


app.get("/staff/checkins", requireAuth, requireRole('CLEANING_MANAGER'), async (req, res) => {
  try {
    const { from, to, quick: quickRaw } = req.query;

    const tz = "Europe/Madrid";
    const today = ymdInTz(new Date(), tz);
    const tomorrow = ymdInTz(new Date(Date.now() + 86400000), tz);
    const yesterday = ymdInTz(new Date(Date.now() - 86400000), tz);

    const hasAnyFilter = Boolean(from || to || quickRaw);
    const quickCandidate = hasAnyFilter ? quickRaw : "today";
    const quick = ["yesterday", "today", "tomorrow"].includes(quickCandidate) ? quickCandidate : "";

    let fromDate = from;
    let toDate = to;
    if (quick) {
      if (quick === "yesterday") { fromDate = yesterday; toDate = yesterday; }
      else if (quick === "today") { fromDate = today; toDate = today; }
      else if (quick === "tomorrow") { fromDate = tomorrow; toDate = tomorrow; }
    }

   function buildWhereFor(fieldName) {
  const where = [];
  const params = [];

  if (fromDate) {
    params.push(fromDate);
    where.push(`${fieldName} >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`${fieldName} <= $${params.length}`);
  }

  // IMPORTANT: return only "AND ..." fragment (no WHERE)
  const andSql = where.length ? ` AND ${where.join(" AND ")}` : "";
  return { andSql, params };
}

const wArr = buildWhereFor("c.arrival_date");
const wDep = buildWhereFor("c.departure_date");

// Arrivals
const arrivalsRes = await pool.query(
  `
  SELECT
    c.id,
    c.booking_token,
    c.beds24_booking_id,
    c.apartment_id,
    c.apartment_name,
    c.room_name,
    c.full_name,
    c.phone,
    c.arrival_date,
    c.arrival_time,
    c.departure_date,
    c.departure_time,
    c.adults,
    c.children,
    c.lock_code,
    c.lock_visible AS lock_code_visible,
    c.clean_ok,
    c.room_id,
  c.early_checkin_requested,
c.late_checkout_requested,
c.registration_completed_at,
c.beds24_raw
FROM checkins c
  LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.apartment_id::text  -- ✅ AÑADIR ESTA LÍNEA
  WHERE (c.cancelled = false OR c.cancelled IS NULL)
    AND c.arrival_date IS NOT NULL
    AND (br.show_in_staff IS NULL OR br.show_in_staff = true)  -- ✅ AÑADIR ESTA LÍNEA
    ${wArr.andSql}
  ORDER BY c.arrival_date ASC, c.arrival_time ASC, c.id DESC
  LIMIT 300
  `,
  wArr.params
);

// QUERY DE DEPARTURES - Añadir JOIN y filtro:
const departuresRes = await pool.query(
  `
  SELECT
    c.id,
    c.booking_token,
    c.beds24_booking_id,
    c.apartment_id,
    c.apartment_name,
    c.room_name,
    c.full_name,
    c.phone,
    c.arrival_date,
    c.arrival_time,
    c.departure_date,
    c.departure_time,
    c.adults,
    c.children,
    c.lock_code,
    c.lock_visible AS lock_code_visible,
    c.clean_ok,
    c.room_id,
    c.early_checkin_requested,  
    c.late_checkout_requested 
  FROM checkins c
  LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.apartment_id::text  -- ✅ AÑADIR ESTA LÍNEA
  WHERE c.cancelled = false
    AND c.departure_date IS NOT NULL
    AND (br.show_in_staff IS NULL OR br.show_in_staff = true)  -- ✅ AÑADIR ESTA LÍNEA
    ${wDep.andSql}
  ORDER BY c.departure_date ASC, c.departure_time ASC, c.id DESC
  LIMIT 300
  `,
  wDep.params
);
    const arrivals = arrivalsRes.rows || [];
  // 🔍 DEBUG - Ver qué datos llegan
console.log('📊 ARRIVALS DEBUG:');
arrivals.slice(0, 3).forEach(r => {
  console.log(`  ID: ${r.id}, Name: ${r.full_name}`);
  console.log(`    arrival_time: ${r.arrival_time}`);
  console.log(`    departure_time: ${r.departure_time}`);
  console.log(`    early_checkin_requested: ${r.early_checkin_requested}`);  // ✅ AÑADIR
  console.log(`    late_checkout_requested: ${r.late_checkout_requested}`);  // ✅ AÑADIR
});
    const departures = departuresRes.rows || [];

    // Color logic
    const yesterdayStr = yesterday;
// Build needsCleanSet
// Color logic (CHECKINS-only)
const { rows: needsCleanRows } = await pool.query(
  `
  SELECT DISTINCT c_today.apartment_id
  FROM checkins c_today
  JOIN checkins c_yesterday
    ON c_today.apartment_id = c_yesterday.apartment_id
  WHERE c_today.cancelled = false
    AND c_yesterday.cancelled = false

    -- check-in today
    AND c_today.arrival_date = $1::date

    -- occupied yesterday (stayed overnight into today)
    AND c_yesterday.arrival_date <= $2::date
    AND c_yesterday.departure_date > $2::date
  `,
  [today, yesterday]
);

const needsCleanSet = new Set(needsCleanRows.map(r => String(r.apartment_id)));

function getColumnClass(id) {
  if (!id) return "";
  if (needsCleanSet.has(String(id))) return "needs-clean"; // 🩶
  return ""; // ⚪
}

// 🎨 NUEVA FUNCIÓN - Color coding para early/late check-in
function getEarlyLateClass(checkin) {
  const hasEarly = checkin.early_checkin_requested === true;
  const hasLate = checkin.late_checkout_requested === true;
  
  if (hasEarly && hasLate) return "early-late-both"; // 🟣 Morado
  if (hasEarly) return "early-request";               // 🟠 Naranja
  if (hasLate) return "late-request";                 // 🔴 Rojo
  return "";                                           // ⚪ Normal
}

// Toolbar
const toolbar = `
  <h1>Staff · Llegadas y Salidas</h1>
  <p class="muted">Zona horaria: España (Europe/Madrid)</p>
  
  <!-- 🎨 LEYENDA DE COLORES -->
  <div style="display:flex; gap:16px; margin:12px 0; padding:12px; background:#f9f9f9; border-radius:8px; flex-wrap:wrap;">
    <div style="display:flex; align-items:center; gap:8px;">
      <div style="width:20px; height:20px; background:#fff3e0; border-left:4px solid #ff9800; border-radius:4px;"></div>
      <span style="font-size:14px;">🟠 Early check-in (&lt;17:00)</span>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <div style="width:20px; height:20px; background:#ffebee; border-left:4px solid #f44336; border-radius:4px;"></div>
      <span style="font-size:14px;">🔴 Late checkout (&gt;11:00)</span>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <div style="width:20px; height:20px; background:#f3e5f5; border-left:4px solid #9c27b0; border-radius:4px;"></div>
      <span style="font-size:14px;">🟣 Ambos</span>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <div style="width:20px; height:20px; background:#f5f5f5; border-left:4px solid #9e9e9e; border-radius:4px;"></div>
      <span style="font-size:14px;">🩶 Requiere limpieza</span>
    </div>
  </div>
  
  <form method="GET" action="/staff/checkins" style="margin:20px 0;">
    <div style="display:flex; gap:12px; align-items:end; flex-wrap:wrap;">
      <div>
        <label>Desde</label>
        <input type="date" name="from" value="${fromDate || ""}" />
      </div>
      <div>
        <label>Hasta</label>
        <input type="date" name="to" value="${toDate || ""}" />
      </div>
      <button type="submit" class="btn-primary">Filtrar</button>
      <a href="/staff/checkins" class="btn-link">Resetear</a>
    </div>
    <div style="margin-top:12px;">
      <p class="muted" style="margin:0 0 8px;">Filtros rápidos</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="?quick=yesterday" class="btn-base ${quick === "yesterday" ? "btn-success" : ""}">Ayer</a>
        <a href="?quick=today" class="btn-base ${quick === "today" ? "btn-success" : ""}">Hoy</a>
        <a href="?quick=tomorrow" class="btn-base ${quick === "tomorrow" ? "btn-success" : ""}">Mañana</a>
      </div>
    </div>
  </form>
`;
  // REORDERED TABLE - Replace in your renderTable() function

function renderTable(rows, mode) {
  const title = mode === "departures" 
    ? `Salidas <span class="muted">(${rows.length})</span>` 
    : `Llegadas <span class="muted">(${rows.length})</span>`;
  const dateColTitle = mode === "departures" ? "Salida" : "Llegada";
  
  const tbody = rows.length ? rows.map(r => {
    const mainDate = mode === "departures" 
      ? `${fmtDate(r.departure_date)} ${fmtTime(r.departure_time)}`
      : `${fmtDate(r.arrival_date)} ${fmtTime(r.arrival_time)}`;
    
    const bookingId = r.beds24_booking_id 
      ? String(r.beds24_booking_id).replace(/\s/g, '')
      : r.booking_token || r.id;

    const guestPortalUrl = bookingId
      ? `/guest/${encodeURIComponent(bookingId)}`
      : null;

    const guestBtn = guestPortalUrl
      ? `<a class="btn-small btn-ghost" href="${guestPortalUrl}" target="_blank">Abrir</a>`
      : `<span class="muted">Sin link</span>`;
    
    const earlyLateClass = getEarlyLateClass(r);

    return `
      <tr class="${earlyLateClass}" id="checkin-${r.id}">
        <!-- 1. Limpieza -->
        <td class="sticky-col">
          <form method="POST" action="/staff/checkins/${r.id}/clean">
            <button type="submit" class="clean-btn ${r.clean_ok ? "pill-yes" : "pill-no"}">
              ${r.clean_ok ? "✓" : ""}
            </button>
          </form>
        </td>
        
        <td style="font-family:monospace; font-size:13px;">
          ${escapeHtml(String(r.beds24_booking_id || r.booking_token || r.id))}
        </td>
        
       <!-- 2. Huésped -->
<td>${guestBtn}</td>
<td>${r.registration_completed_at ? '✅' : '⏳'}</td>
<td>${(() => {
  const payment = getPaymentStatus(r.beds24_raw);
  return payment.paid ? '✅' : `⏳ ${payment.pending}€`;
})()}</td>
<td>${formatGuestName(r.full_name)}</td>
        
        <!-- 3. Llegada -->
        <td>${mainDate}</td>
        
        <!-- 4. Noches -->
        <td>${calcNights(r.arrival_date, r.departure_date)}</td>
        
        <!-- 5. A|C -->
        <td style="white-space:nowrap;">${(r.adults || 0)}&nbsp;|&nbsp;${(r.children || 0)}</td>
        
        <!-- 6. Apartamento -->
        <td class="apartment-cell ${getColumnClass(r.apartment_id)}">
          ${escapeHtml(r.room_name || r.apartment_name || "Sin nombre")}
        </td>
        
        <!-- 7. Código - CON BOTONES INDIVIDUALES -->
        <td>
          <form method="POST" action="/staff/checkins/${r.id}/lock" class="lock-form">
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}#checkin-${r.id}" />
            
            <input
              type="text"
              class="lock-input"
              name="lock_code"
              value="${escapeHtml(r.lock_code || "")}"
              placeholder="0000"
              inputmode="numeric"
              pattern="[0-9]*"
            />

            <div class="lock-actions">
              <button type="submit" class="btn-small btn-primary">
                Guardar
              </button>

              <button
                type="submit"
                name="clear"
                value="1"
                class="btn-small btn-danger"
              >
                Clear
              </button>
            </div>
          </form>
        </td>
        
        <!-- 8. Visible -->
        <td>
          <form method="POST" action="/staff/checkins/${r.id}/visibility" class="vis-form">
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}#checkin-${r.id}" />

            <span class="pill ${r.lock_code_visible ? "pill-yes" : "pill-no"}">
              ${r.lock_code_visible ? "Sí" : "No"}
            </span>

            <button type="submit" class="btn-small ${r.lock_code_visible ? "btn-ghost" : ""}">
              ${r.lock_code_visible ? "Ocultar" : "Mostrar"}
            </button>
          </form>
        </td>
        <!-- WhatsApp -->
<td>
  ${r.phone ? `
    <button type="button" 
            class="btn-small btn-primary" 
            onclick="openWhatsAppModal(${r.id}, '${escapeHtml(r.phone)}', '${escapeHtml(r.full_name)}')"
            title="Enviar WhatsApp">
      📱
    </button>
  ` : '<span class="muted">Sin tel</span>'}
</td>
        <!-- 9. Acciones -->
        <td>
          <form method="POST" action="/staff/checkins/${r.id}/delete"
                onsubmit="return confirm('¿Seguro que quieres borrar esta reserva?');">
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}#checkin-${r.id}" />
            <button type="submit" class="btn-small danger">Borrar</button>
          </form>
        </td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="14" class="muted">No hay registros</td></tr>`;

  // 🆕 BOTÓN GUARDAR TODOS - SOLO PARA LLEGADAS (mode === "arrivals")
  const saveAllButton = (rows.length && mode === "arrivals") ? `
    <div style="margin-top:16px; padding:16px; background:#f9fafb; border-radius:8px; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap;">
      <div>
        <p style="margin:0; font-weight:600;">💾 Guardar todos los códigos</p>
        <p style="margin:4px 0 0; font-size:13px; color:#6b7280;">Guarda todos los códigos de esta tabla en una sola acción</p>
      </div>
      <button 
        type="button" 
        onclick="saveAllLockCodes()"
        class="btn-primary"
        style="white-space:nowrap; padding:12px 24px;">
        💾 Guardar Todos
      </button>
    </div>
  ` : '';

  return `
    <h2 style="margin:24px 0 12px;">${title}</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sticky-col">Limpieza</th>
    <th>ID</th>
    <th>Portal</th>
    <th>Reg</th>
<th>Pago</th>
<th>Huésped</th>
    <th>${dateColTitle}</th>
    <th>Noches</th>
    <th>A|C</th>
    <th>Apartamento</th>
    <th>Código</th>
   <th>Visible</th>
<th>WhatsApp</th>
<th>Acciones</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    ${saveAllButton}
  `;
}

const whatsappModal = `
  <!-- Modal WhatsApp -->
  <div id="whatsapp-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:1000; justify-content:center; align-items:center;">
    <div style="background:white; padding:24px; border-radius:12px; max-width:500px; width:90%; max-height:80vh; overflow-y:auto;">
      <h3 style="margin:0 0 16px;">📱 Enviar WhatsApp</h3>
      <p style="margin:0 0 8px; color:#6b7280;">Para: <strong id="modal-guest-name"></strong></p>
      <p style="margin:0 0 16px; color:#6b7280;">Tel: <span id="modal-phone"></span></p>
      
      <label style="display:block; margin-bottom:8px; font-weight:500;">Mensaje:</label>
      <textarea id="whatsapp-message" rows="5" style="width:100%; padding:12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; resize:vertical;" placeholder="Escribe tu mensaje..."></textarea>
      
      <div style="margin-top:12px; padding:12px; background:#f0f9ff; border-radius:8px;">
        <p style="margin:0 0 8px; font-size:13px; color:#0369a1; font-weight:500;">Mensajes rápidos:</p>
        <button type="button" onclick="setQuickMessage('checkout')" class="btn-small" style="margin:4px;">🚪 Recordar checkout</button>
        <button type="button" onclick="setQuickMessage('late')" class="btn-small" style="margin:4px;">⏰ Salida tardía</button>
        <button type="button" onclick="setQuickMessage('keys')" class="btn-small" style="margin:4px;">🔑 Dejar llaves</button>
      </div>
      
      <input type="hidden" id="modal-checkin-id" />
      
      <div style="display:flex; gap:12px; margin-top:20px; justify-content:flex-end;">
        <button type="button" onclick="closeWhatsAppModal()" class="btn-small">Cancelar</button>
        <button type="button" onclick="sendWhatsAppFromModal()" class="btn-small btn-success" style="background:#22c55e; color:white;">📤 Enviar</button>
      </div>
    </div>
  </div>

  <script>
    const quickMessages = {
      checkout: 'Hola! Te recordamos que el checkout es a las 11:00h. Por favor, deja las llaves dentro del apartamento y cierra bien la puerta. ¡Gracias por tu estancia!',
      late: 'Hola! Vemos que ya ha pasado la hora de salida (11:00h). Por favor, contacta con nosotros si necesitas más tiempo. Gracias.',
      keys: 'Hola! Recuerda dejar las llaves dentro del apartamento antes de salir. ¡Gracias!'
    };

    function openWhatsAppModal(checkinId, phone, guestName) {
      document.getElementById('modal-checkin-id').value = checkinId;
      document.getElementById('modal-phone').textContent = phone;
      document.getElementById('modal-guest-name').textContent = guestName;
      document.getElementById('whatsapp-message').value = '';
      document.getElementById('whatsapp-modal').style.display = 'flex';
    }

    function closeWhatsAppModal() {
      document.getElementById('whatsapp-modal').style.display = 'none';
    }

    function setQuickMessage(type) {
      document.getElementById('whatsapp-message').value = quickMessages[type] || '';
    }

    async function sendWhatsAppFromModal() {
      const checkinId = document.getElementById('modal-checkin-id').value;
      const message = document.getElementById('whatsapp-message').value.trim();
      
      if (!message) {
        alert('Por favor, escribe un mensaje');
        return;
      }
      
      try {
        const response = await fetch('/api/whatsapp/send-manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkinId, message })
        });
        
        const data = await response.json();
        
        if (data.success) {
          alert('✅ Mensaje enviado correctamente');
          closeWhatsAppModal();
        } else {
          alert('❌ Error: ' + (data.error || 'No se pudo enviar'));
        }
      } catch (error) {
        alert('❌ Error de conexión');
        console.error(error);
      }
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeWhatsAppModal();
    });
  </script>
`;

    
   const pageHtml = renderNavMenu('staff', req) + toolbar + 
         renderTable(arrivals, "arrivals") + 
         `<div style="height:24px;"></div>` + 
         renderTable(departures, "departures") +
         whatsappModal;
                 `                 
                 `;
    
    res.send(renderPage("Staff · Llegadas y Salidas", pageHtml, 'staff'));
  } catch (e) {
    console.error("Error en staff/checkins:", e);
    res.status(500).send(renderPage("Error", `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error al cargar la lista</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a href="/staff/checkins" class="btn-link">Recargar</a></p>
      </div>
    `));
  }
});

function safeRedirect(res, returnTo, fallback = "/staff/checkins") {
  const target = String(returnTo || "").trim();
  // allow only internal relative paths
  if (target.startsWith("/")) return res.redirect(target);
  return res.redirect(fallback);
}

// ============================================
// 🧹 STAFF: MIS LIMPIEZAS (solo asignadas al usuario)
// ============================================

app.get("/staff/my-cleanings", requireAuth, requireRole('STAFF_CLEANING'), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { from, to, quick: quickRaw } = req.query;

    const tz = "Europe/Madrid";
    const today = ymdInTz(new Date(), tz);
    const tomorrow = ymdInTz(new Date(Date.now() + 86400000), tz);
    const yesterday = ymdInTz(new Date(Date.now() - 86400000), tz);

    const hasAnyFilter = Boolean(from || to || quickRaw);
    const quickCandidate = hasAnyFilter ? quickRaw : "today";
    const quick = ["yesterday", "today", "tomorrow"].includes(quickCandidate) ? quickCandidate : "";

    let fromDate = from;
    let toDate = to;
    if (quick) {
      if (quick === "yesterday") { fromDate = yesterday; toDate = yesterday; }
      else if (quick === "today") { fromDate = today; toDate = today; }
      else if (quick === "tomorrow") { fromDate = tomorrow; toDate = tomorrow; }
    }

    function buildWhereFor(fieldName) {
      const where = [];
      const params = [userId]; // Primer parámetro siempre es userId

      if (fromDate) {
        params.push(fromDate);
        where.push(`${fieldName} >= $${params.length}`);
      }
      if (toDate) {
        params.push(toDate);
        where.push(`${fieldName} <= $${params.length}`);
      }

      const andSql = where.length ? ` AND ${where.join(" AND ")}` : "";
      return { andSql, params };
    }

    const wArr = buildWhereFor("c.arrival_date");
    const wDep = buildWhereFor("c.departure_date");

    // Arrivals asignados a este usuario
    const arrivalsRes = await pool.query(
      `
      SELECT
        c.id,
        c.booking_token,
        c.beds24_booking_id,
        c.apartment_id,
        c.apartment_name,
        c.room_name,
        c.full_name,
        c.arrival_date,
        c.arrival_time,
        c.departure_date,
        c.departure_time,
        c.adults,
        c.children,
        c.lock_code,
        c.clean_ok
      FROM checkins c
      WHERE (c.cancelled = false OR c.cancelled IS NULL)
        AND c.arrival_date IS NOT NULL
        AND c.assigned_to = $1
        ${wArr.andSql}
      ORDER BY c.arrival_date ASC, c.arrival_time ASC
      LIMIT 100
      `,
      wArr.params
    );

    // Departures asignados a este usuario
    const departuresRes = await pool.query(
      `
      SELECT
        c.id,
        c.booking_token,
        c.beds24_booking_id,
        c.apartment_id,
        c.apartment_name,
        c.room_name,
        c.full_name,
        c.arrival_date,
        c.arrival_time,
        c.departure_date,
        c.departure_time,
        c.adults,
        c.children,
        c.lock_code,
        c.clean_ok
      FROM checkins c
      WHERE c.cancelled = false
        AND c.departure_date IS NOT NULL
        AND c.assigned_to = $1
        ${wDep.andSql}
      ORDER BY c.departure_date ASC, c.departure_time ASC
      LIMIT 100
      `,
      wDep.params
    );

    const arrivals = arrivalsRes.rows || [];
    const departures = departuresRes.rows || [];

    // Toolbar
    const toolbar = `
      <h1>🧹 Mis Limpiezas</h1>
      <p class="muted">Limpiezas asignadas a: ${escapeHtml(req.session.user.name)}</p>
      
      <form method="GET" action="/staff/my-cleanings" style="margin:20px 0;">
        <div style="display:flex; gap:12px; align-items:end; flex-wrap:wrap;">
          <div>
            <label>Desde</label>
            <input type="date" name="from" value="${fromDate || ""}" />
          </div>
          <div>
            <label>Hasta</label>
            <input type="date" name="to" value="${toDate || ""}" />
          </div>
          <button type="submit" class="btn-primary">Filtrar</button>
          <a href="/staff/my-cleanings" class="btn-link">Resetear</a>
        </div>
        <div style="margin-top:12px;">
          <p class="muted" style="margin:0 0 8px;">Filtros rápidos</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <a href="?quick=yesterday" class="btn-base ${quick === "yesterday" ? "btn-success" : ""}">Ayer</a>
            <a href="?quick=today" class="btn-base ${quick === "today" ? "btn-success" : ""}">Hoy</a>
            <a href="?quick=tomorrow" class="btn-base ${quick === "tomorrow" ? "btn-success" : ""}">Mañana</a>
          </div>
        </div>
      </form>
    `;

    function renderMyCleaningsTable(rows, mode) {
      const title = mode === "departures" 
        ? `Salidas <span class="muted">(${rows.length})</span>` 
        : `Llegadas <span class="muted">(${rows.length})</span>`;
      const dateColTitle = mode === "departures" ? "Salida" : "Llegada";
      
      const tbody = rows.length ? rows.map(r => {
        const mainDate = mode === "departures" 
          ? `${fmtDate(r.departure_date)} ${fmtTime(r.departure_time)}`
          : `${fmtDate(r.arrival_date)} ${fmtTime(r.arrival_time)}`;
        
        return `
          <tr>
            <td>
              <form method="POST" action="/staff/checkins/${r.id}/clean">
                <button type="submit" class="clean-btn ${r.clean_ok ? "pill-yes" : "pill-no"}">
                  ${r.clean_ok ? "✓" : ""}
                </button>
              </form>
            </td>
            <td style="font-family:monospace; font-size:13px;">
              ${escapeHtml(String(r.beds24_booking_id || r.booking_token || r.id))}
            </td>
            <td>${formatGuestName(r.full_name)}</td>
            <td>${mainDate}</td>
            <td>${calcNights(r.arrival_date, r.departure_date)}</td>
            <td style="white-space:nowrap;">${(r.adults || 0)}&nbsp;|&nbsp;${(r.children || 0)}</td>
            <td>${escapeHtml(r.room_name || r.apartment_name || "Sin nombre")}</td>
            <td style="font-family:monospace; font-weight:600; color:#1f2937;">
              ${escapeHtml(r.lock_code || "—")}
            </td>
          </tr>
        `;
      }).join("") : `<tr><td colspan="8" class="muted">No tienes limpiezas asignadas</td></tr>`;

      return `
        <h2 style="margin:24px 0 12px;">${title}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Limpieza</th>
                <th>ID</th>
                <th>Huésped</th>
                <th>${dateColTitle}</th>
                <th>Noches</th>
                <th>A|C</th>
                <th>Apartamento</th>
                <th>Código</th>
              </tr>
            </thead>
            <tbody>${tbody}</tbody>
          </table>
        </div>
      `;
    }
    const pageHtml = renderNavMenu('staff', req) + toolbar + 
         renderTable(arrivals, "arrivals") + 
         `<div style="height:24px;"></div>` + 
         renderTable(departures, "departures") +
         whatsappModal;

    res.send(renderPage("Staff · Llegadas y Salidas", pageHtml, 'staff'));
  } catch (e) {
    console.error("Error en staff/checkins:", e);
    res.status(500).send(renderPage("Error", `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error al cargar la lista</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a href="/staff/checkins" class="btn-link">Recargar</a></p>
      </div>
    `));
  }
});

function safeRedirect(res, returnTo, fallback = "/staff/checkins") {
  const target = String(returnTo || "").trim();
  if (target.startsWith("/")) return res.redirect(target);
  return res.redirect(fallback);
}
  

// ============================================
// 🔄 SYNC: Página con formulario
// ============================================

app.get("/manager/channels/bookingssync", requireAuth, requireRole('MANAGER'), async (req, res) => {
  try {
    // Si no hay parámetros, mostrar formulario
    if (!req.query.action) {
      // Obtener lista de apartamentos para el filtro
      const apartmentsResult = await pool.query(`
        SELECT DISTINCT 
          TRIM(REGEXP_REPLACE(apartment_name, '\\s+', ' ', 'g')) as apartment_name
        FROM checkins 
        WHERE apartment_name IS NOT NULL 
          AND apartment_name != ''
        ORDER BY apartment_name
      `);
      const apartments = apartmentsResult.rows.map(r => r.apartment_name);
      
      const syncForm = `
        <div class="card" style="max-width:600px; margin:40px auto;">
          <h1 style="margin:0 0 20px;">🔄 Sincronizar Reservas desde Beds24</h1>
          <p class="muted">Importa reservas de un rango de fechas específico desde Beds24 a tu base de datos.</p>
          
          <form method="GET" action="/manager/channels/bookingssync" style="margin-top:24px;">
            <input type="hidden" name="action" value="sync" />
            
            <div style="margin-bottom:16px;">
              <label style="display:block; margin-bottom:6px; font-weight:600;">Apartamento (opcional)</label>
              <select name="apartment" class="form-input" style="width:100%;">
                <option value="">Todos los apartamentos</option>
                ${apartments.map(apt => `
                  <option value="${escapeHtml(apt)}">${escapeHtml(apt)}</option>
                `).join('')}
              </select>
              <small class="muted">Deja en blanco para sincronizar todos</small>
            </div>
            
            <div style="margin-bottom:16px;">
              <label style="display:block; margin-bottom:6px; font-weight:600;">Desde (Check-in)</label>
              <input type="date" name="from" value="2025-12-01" required class="form-input" style="width:100%;" />
            </div>
            
            <div style="margin-bottom:16px;">
              <label style="display:block; margin-bottom:6px; font-weight:600;">Hasta (Check-in)</label>
              <input type="date" name="to" value="2025-12-31" required class="form-input" style="width:100%;" />
            </div>
            
            <div style="margin-bottom:24px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" name="includeCancelled" value="true" />
                <span>Incluir reservas canceladas</span>
              </label>
            </div>
            
            <div style="margin-bottom:24px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" name="debug" value="true" checked />
                <span>Mostrar debug detallado</span>
              </label>
            </div>
            
            <button type="submit" class="btn-primary" style="width:100%; padding:12px;">
              🔄 Iniciar Sincronización
            </button>
          </form>
          
          <hr style="margin:24px 0;" />
          
          <div style="background:#f0f9ff; padding:16px; border-radius:8px; border-left:4px solid #0284c7;">
            <p style="margin:0 0 8px; font-weight:600;">💡 Consejo</p>
            <p style="margin:0; font-size:14px;">
              Usa esta herramienta para importar reservas antiguas o recuperar datos que no llegaron por webhook.
              La sincronización puede tardar varios minutos dependiendo del número de reservas.
            </p>
          </div>
          
          <p style="margin-top:24px; text-align:center;">
            <a href="/manager" class="btn-link">← Volver al Manager</a>
          </p>
        </div>
      `;
      
      return res.send(renderPage("Sincronizar Reservas", syncForm, 'manager'));
    }
    
    // Si hay parámetros, ejecutar sincronización
    const propertyIdForToken = "203178";
    const token = await getBeds24AccessToken(propertyIdForToken);
    
    const fromDate = String(req.query.from || "2000-01-01");
    const toDate = String(req.query.to || "2027-12-31");
    const includeCancelled = String(req.query.includeCancelled || "false");
    const filterApartment = String(req.query.apartment || "");
    const showDebug = String(req.query.debug || "false") === "true";
    
    let debugLog = [];
    const log = (msg) => {
      console.log(msg);
      if (showDebug) debugLog.push(msg);
    };
    
    log(`🔍 === INICIO SINCRONIZACIÓN ===`);
    log(`📅 Rango: ${fromDate} → ${toDate}`);
    log(`🏠 Apartamento filtro: ${filterApartment || 'TODOS'}`);
    log(`❌ Incluir canceladas: ${includeCancelled}`);
    
    // Obtener properties
    const propsResp = await fetch("https://beds24.com/api/v2/properties?includeAllRooms=true", {
      headers: { accept: "application/json", token },
    });
    
    if (!propsResp.ok) {
      const text = await propsResp.text();
      throw new Error(`Beds24 properties error ${propsResp.status}: ${text.slice(0, 300)}`);
    }
    
    const propsJson = await propsResp.json();
    const properties = Array.isArray(propsJson) ? propsJson : (propsJson.data || []);
    const propIds = properties
      .map((p) => p.id || p.propId || p.propertyId)
      .filter((x) => x != null)
      .map((x) => String(x));
      
    log(`🏢 Properties encontradas: ${propIds.length}`);
    
    if (!propIds.length) {
      return res.send(renderPage("Sync Bookings", `
        <div class="card">
          <h1 style="margin:0 0 10px;">ℹ️ No properties found</h1>
          <p>Could not load properties from API.</p>
          <p><a class="btn-link" href="/manager/channels/bookingssync">← Volver</a></p>
        </div>
      `, 'manager'));
    }
    
    // Mapear rooms
    const roomsMap = new Map();
    for (const prop of properties) {
      const roomTypes = prop.roomTypes || [];
      log(`🏨 Property ${prop.id}: ${roomTypes.length} rooms`);
      
      for (const room of roomTypes) {
        const roomId = String(room.id || room.roomId || "");
        const roomName = room.name || room.roomName || "";
        if (roomId && roomName) {
          roomsMap.set(roomId, roomName);
          log(`  ✓ RoomID "${roomId}" → "${roomName}"`);
        }
      }
    }
    
    log(`📊 TOTAL: ${roomsMap.size} rooms mapeadas`);
    
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let filteredOut = 0;
    
    const bookingsDetails = [];
    
    for (const propId of propIds) {
     const url =
  `https://beds24.com/api/v2/bookings` +
  `?propertyId=${encodeURIComponent(propId)}` +
  `&includeInvoiceItems=true` +
  `&arrivalFrom=${encodeURIComponent(fromDate)}` +
  `&arrivalTo=${encodeURIComponent(toDate)}`;
      
      log(`\n🔗 Fetching bookings para property ${propId}...`);
      
      const bookingsResp = await fetch(url, {
        headers: { accept: "application/json", token },
      });
      
      if (!bookingsResp.ok) {
        const text = await bookingsResp.text();
        log(`❌ Error fetching property ${propId}: ${text.slice(0, 200)}`);
        errors++;
        continue;
      }
      
      const data = await bookingsResp.json();
      const bookings = Array.isArray(data) ? data : (data.bookings || data.data || []);
      
      log(`📦 Recibidas ${bookings.length} reservas de property ${propId}`);
      
      for (const b of bookings) {
        const arrival = new Date(b.arrival || b.arrivalDate);
        const departure = new Date(b.departure || b.departureDate);
        const from = new Date(fromDate);
        const to = new Date(toDate);
        
        // Filtro por fecha
        if (arrival < from || arrival > to) {
          log(`  ⏭️  Booking ${b.id}: fuera de rango (${b.arrival})`);
          filteredOut++;
          continue;
        }
        
        // Filtro por cancelación
        if (includeCancelled === "false" && 
            (b.status === "cancelled" || b.status === "canceled")) {
          log(`  ❌ Booking ${b.id}: cancelada`);
          filteredOut++;
          continue;
        }
        
        const roomId = String(b.roomId || "");
        const realRoomName = roomsMap.get(roomId) || "";
        
        // Filtro por apartamento
        if (filterApartment && realRoomName !== filterApartment) {
          log(`  🏠 Booking ${b.id}: apartamento no coincide ("${realRoomName}" ≠ "${filterApartment}")`);
          filteredOut++;
          continue;
        }
        
        log(`\n  ✅ Procesando Booking ${b.id}:`);
        log(`     - RoomID: ${roomId}`);
        log(`     - Apartamento: ${realRoomName}`);
        log(`     - Guest: ${b.firstName} ${b.lastName}`);
        log(`     - Check-in: ${b.arrival}`);
        log(`     - Status: ${b.status}`);
        
        // Preparar datos para guardar
        const guestLanguage = (b.guestLanguage || b.lang || 'en').toLowerCase().substring(0, 2);
        const isCancelled = (b.status === 'cancelled' || b.status === 'canceled');
        
        const insertData = {
          beds24_booking_id: b.id,
          beds24_room_id: roomId,
          apartment_name: realRoomName,
          full_name: `${b.firstName || ''} ${b.lastName || ''}`.trim() || 'Unknown Guest',
          email: b.email || 'unknown@beds24',
          phone: b.phone || b.mobile || '',
          arrival_date: b.arrival || null,
          arrival_time: b.arrivalTime || null,
          departure_date: b.departure || null,
          departure_time: null,
          adults: b.numAdult || 0,
          children: b.numChild || 0,
          beds24_raw: b,
          guest_language: guestLanguage,
          cancelled: isCancelled
        };
        
        log(`     - Datos preparados para insertar en DB`);
        
        try {
          // Intentar insertar/actualizar
          const result = await pool.query(
            `INSERT INTO checkins (
              apartment_id,
              booking_token,
              beds24_booking_id,
              beds24_room_id,
              apartment_name,
              full_name,
              email,
              phone,
              arrival_date,
              arrival_time,
              departure_date,
              departure_time,
              adults,
              children,
              beds24_raw,
              guest_language,
              cancelled
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
            ON CONFLICT (beds24_booking_id)
            DO UPDATE SET
              apartment_name = EXCLUDED.apartment_name,
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              phone = EXCLUDED.phone,
              arrival_date = COALESCE(EXCLUDED.arrival_date, checkins.arrival_date),
              departure_date = COALESCE(EXCLUDED.departure_date, checkins.departure_date),
              adults = COALESCE(EXCLUDED.adults, checkins.adults),
              children = COALESCE(EXCLUDED.children, checkins.children),
              beds24_raw = COALESCE(EXCLUDED.beds24_raw, checkins.beds24_raw),
              guest_language = EXCLUDED.guest_language,
              cancelled = EXCLUDED.cancelled
            RETURNING id, (xmax = 0) AS inserted`,
            [
              roomId,
              `beds24_${b.id}`,
              b.id,
              roomId,
              realRoomName,
              insertData.full_name,
              insertData.email,
              insertData.phone,
              insertData.arrival_date,
              insertData.arrival_time,
              insertData.departure_date,
              insertData.departure_time,
              insertData.adults,
              insertData.children,
              JSON.stringify(insertData.beds24_raw),
              insertData.guest_language,
              insertData.cancelled
            ]
          );
          
          const wasInserted = result.rows[0]?.inserted;
          
          if (wasInserted) {
            log(`     ✅ INSERTADA en DB (ID: ${result.rows[0].id})`);
            inserted++;
            bookingsDetails.push({
              id: b.id,
              guest: insertData.full_name,
              apartment: realRoomName,
              arrival: b.arrival,
              action: 'INSERTADA'
            });
          } else {
            log(`     🔄 ACTUALIZADA en DB`);
            updated++;
            bookingsDetails.push({
              id: b.id,
              guest: insertData.full_name,
              apartment: realRoomName,
              arrival: b.arrival,
              action: 'ACTUALIZADA'
            });
          }
          
          processed++;
          
        } catch (dbError) {
          log(`     ❌ ERROR DB: ${dbError.message}`);
          errors++;
        }
      }
    }
    
    log(`\n📊 === RESUMEN FINAL ===`);
    log(`✅ Procesadas: ${processed}`);
    log(`➕ Insertadas: ${inserted}`);
    log(`🔄 Actualizadas: ${updated}`);
    log(`⏭️  Filtradas: ${filteredOut}`);
    log(`❌ Errores: ${errors}`);
    
    // Generar HTML del reporte
    const bookingsTableHtml = bookingsDetails.length ? `
      <div style="margin-top:24px; overflow-x:auto;">
        <h3 style="margin:0 0 12px;">📋 Reservas Procesadas</h3>
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:8px; text-align:left; border-bottom:2px solid #e5e7eb;">ID</th>
              <th style="padding:8px; text-align:left; border-bottom:2px solid #e5e7eb;">Huésped</th>
              <th style="padding:8px; text-align:left; border-bottom:2px solid #e5e7eb;">Apartamento</th>
              <th style="padding:8px; text-align:left; border-bottom:2px solid #e5e7eb;">Check-in</th>
              <th style="padding:8px; text-align:left; border-bottom:2px solid #e5e7eb;">Acción</th>
            </tr>
          </thead>
          <tbody>
            ${bookingsDetails.map(b => `
              <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:8px;">${b.id}</td>
                <td style="padding:8px;">${escapeHtml(b.guest)}</td>
                <td style="padding:8px;">${escapeHtml(b.apartment)}</td>
                <td style="padding:8px;">${b.arrival}</td>
                <td style="padding:8px;">
                  <span style="padding:4px 8px; border-radius:4px; font-size:12px; font-weight:600; 
                    background:${b.action === 'INSERTADA' ? '#dcfce7' : '#fef3c7'};
                    color:${b.action === 'INSERTADA' ? '#15803d' : '#a16207'};">
                    ${b.action}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '';
    
    const debugHtml = showDebug ? `
      <div style="margin-top:24px;">
        <h3 style="margin:0 0 12px;">🔍 Debug Log</h3>
        <div style="background:#1f2937; color:#f3f4f6; padding:16px; border-radius:8px; max-height:400px; overflow-y:auto; font-family:monospace; font-size:12px; white-space:pre-wrap;">
${debugLog.join('\n')}
        </div>
      </div>
    ` : '';
    
    return res.send(renderPage("Sync Bookings", `
      <div class="card" style="max-width:900px; margin:40px auto;">
        <h1 style="margin:0 0 20px;">✅ Sincronización Completada</h1>
        
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:16px; margin-bottom:24px;">
          <div style="background:#f0fdf4; padding:16px; border-radius:8px; border-left:4px solid #22c55e;">
            <div style="font-size:32px; font-weight:700; color:#16a34a;">${inserted}</div>
            <div style="color:#15803d; font-size:14px;">Nuevas</div>
          </div>
          <div style="background:#fef3c7; padding:16px; border-radius:8px; border-left:4px solid #eab308;">
            <div style="font-size:32px; font-weight:700; color:#ca8a04;">${updated}</div>
            <div style="color:#a16207; font-size:14px;">Actualizadas</div>
          </div>
          <div style="background:#f3f4f6; padding:16px; border-radius:8px; border-left:4px solid #9ca3af;">
            <div style="font-size:32px; font-weight:700; color:#6b7280;">${filteredOut}</div>
            <div style="color:#4b5563; font-size:14px;">Filtradas</div>
          </div>
          <div style="background:#fee2e2; padding:16px; border-radius:8px; border-left:4px solid #ef4444;">
            <div style="font-size:32px; font-weight:700; color:#dc2626;">${errors}</div>
            <div style="color:#991b1b; font-size:14px;">Errores</div>
          </div>
        </div>
        
        <div style="background:#f9fafb; padding:16px; border-radius:8px; margin-bottom:24px;">
          <p style="margin:0 0 8px;"><strong>Total procesadas:</strong> ${processed}</p>
          <p style="margin:0 0 8px;"><strong>Properties:</strong> ${propIds.length} · <strong>Rooms:</strong> ${roomsMap.size}</p>
          <p style="margin:0; color:#6b7280; font-size:14px;">
            Rango: ${escapeHtml(fromDate)} → ${escapeHtml(toDate)}
            ${filterApartment ? ` · Apartamento: ${escapeHtml(filterApartment)}` : ''}
            ${includeCancelled === 'true' ? ' · Incluye canceladas' : ''}
          </p>
        </div>
        
        ${bookingsTableHtml}
        ${debugHtml}
        
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:24px;">
          <a href="/manager/invoices" class="btn-primary">💰 Ver Facturas</a>
          <a href="/staff/checkins" class="btn-primary">📋 Ver Check-ins</a>
          <a href="/manager/channels/bookingssync" class="btn-link">🔄 Nueva Sync</a>
        </div>
        
        <p style="margin-top:24px; text-align:center;">
          <a href="/manager" class="btn-link">← Volver al Manager</a>
        </p>
      </div>
    `, 'manager'));
  } catch (e) {
    console.error("Sync error:", e);
    return res.status(500).send(renderPage("Error Sync", `
      <div class="card" style="max-width:600px; margin:40px auto;">
        <h1 style="color:#991b1b; margin:0 0 16px;">❌ Error en Sincronización</h1>
        <div style="background:#fee2e2; padding:16px; border-radius:8px; border-left:4px solid #dc2626;">
          <p style="margin:0; color:#991b1b; white-space:pre-wrap;">${escapeHtml(e.message || String(e))}\n\n${escapeHtml(e.stack || '')}</p>
        </div>
        <p style="margin-top:24px; text-align:center;">
          <a href="/manager/channels/bookingssync" class="btn-link">← Volver a intentar</a>
        </p>
      </div>
    `, 'manager'));
  }
});
// ===================== MANAGER: one page for apartments + defaults =====================

// helper: safe value
function safeTime(val) {
  const s = String(val || "");
  return s.length >= 5 ? s.slice(0, 5) : "";
}


// save global defaults
app.post("/manager/defaults/save", async (req, res) => {
  try {
    const { brand_name, default_arrival_time, default_departure_time } = req.body;

    await pool.query(
      `
      UPDATE app_settings
      SET
        brand_name = $1,
        default_arrival_time = $2,
        default_departure_time = $3,
        updated_at = now()
      WHERE id = 1
      `,
      [brand_name, default_arrival_time, default_departure_time]
    );

    res.redirect("/manager");
  } catch (err) {
    console.error("❌ /manager/defaults/save error:", err);
    res.status(500).send("Save defaults error");
  }
});

// save apartment settings


// optional: keep old URL working
app.get("/manager/settings", (req, res) => res.redirect("/manager"));
app.post("/manager/settings", (req, res) => res.redirect("/manager"));
//vremenno
// toggle active
app.post("/manager/settings/apartments/toggle", async (req, res) => {
  try {
    const id = Number(req.body.id);

    await pool.query(
      `
      UPDATE beds24_rooms
      SET is_active = NOT is_active,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    res.redirect("/manager/settings/apartments");
  } catch (err) {
    console.error("❌ toggle apartment mapping error:", err);
    res.status(500).send("DB error");
  }
});

// tiny helper (если у тебя уже есть — НЕ добавляй второй раз)
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
//vremenno3
function maskKey(k) {
  k = String(k || "");
  if (!k) return "";
  if (k.length <= 10) return k;
  return k.slice(0, 4) + "…" + k.slice(-4);
}

// ============================================
// FUNCIONES AUXILIARES - SOLICITUDES DE HORARIO
// ============================================

// RUTA 1: Lista de apartamentos con enlace a configuración
app.get("/manager/checkin-rules", async (req, res) => {
  try {
    const { rows: apartments } = await pool.query(`
      SELECT 
        br.beds24_room_id,
        br.apartment_name,
        elr.id as has_rules,
        elr.standard_checkin_time,
        elr.standard_checkout_time,
        elr.is_active
      FROM beds24_rooms br
      LEFT JOIN early_late_checkout_rules elr ON elr.apartment_id = br.beds24_room_id
      WHERE br.is_active = true
      ORDER BY br.apartment_name ASC
    `);

    const html = `
      <h1>Configuración de Check-in/Check-out</h1>
      <p><a href="/manager">← Volver al Manager</a></p>

      <div style="margin-top:20px;">
        <table>
          <thead>
            <tr>
              <th>Apartamento</th>
              <th>Check-in Estándar</th>
              <th>Check-out Estándar</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${apartments.map(a => `
              <tr>
                <td><strong>${escapeHtml(a.apartment_name)}</strong></td>
                <td>${a.standard_checkin_time || '-'}</td>
                <td>${a.standard_checkout_time || '-'}</td>
                <td>
                  ${a.has_rules 
                    ? `<span class="pill ${a.is_active ? 'pill-yes' : 'pill-no'}">${a.is_active ? 'Activo' : 'Inactivo'}</span>`
                    : '<span class="muted">Sin configurar</span>'
                  }
                </td>
                <td>
                  <a href="/manager/checkin-rules/${encodeURIComponent(a.beds24_room_id)}" class="btn-small">
                    ${a.has_rules ? 'Editar' : 'Configurar'}
                  </a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    res.send(renderPage("Reglas de Check-in/Check-out", html));
  } catch (e) {
    console.error("Error en /manager/checkin-rules:", e);
    res.status(500).send("Error al cargar la página");
  }
});

// RUTA 2: Configurar reglas para un apartamento específico
app.get("/manager/checkin-rules/:apartmentId", async (req, res) => {
  try {
    const { apartmentId } = req.params;

    const { rows: [apartment] } = await pool.query(
      `SELECT apartment_name FROM beds24_rooms WHERE beds24_room_id = $1`,
      [apartmentId]
    );

    if (!apartment) {
      return res.status(404).send("Apartamento no encontrado");
    }

    const { rows: [rules] } = await pool.query(
      `SELECT * FROM early_late_checkout_rules WHERE apartment_id = $1`,
      [apartmentId]
    );

    const r = rules || {
      standard_checkin_time: '17:00',
      standard_checkout_time: '11:00',
      early_checkin_option1_time: '14:00',
      early_checkin_option1_price: 20,
      early_checkin_option1_enabled: true,
      early_checkin_option2_time: '15:00',
      early_checkin_option2_price: 15,
      early_checkin_option2_enabled: true,
      early_checkin_option3_time: '16:00',
      early_checkin_option3_price: 10,
      early_checkin_option3_enabled: true,
      late_checkout_option1_time: '12:00',
      late_checkout_option1_price: 10,
      late_checkout_option1_enabled: true,
      late_checkout_option2_time: '13:00',
      late_checkout_option2_price: 15,
      late_checkout_option2_enabled: true,
      late_checkout_option3_time: '14:00',
      late_checkout_option3_price: 20,
      late_checkout_option3_enabled: true,
      earliest_possible_checkin: '14:00',
      latest_possible_checkout: '14:00',
      is_active: true
    };

    const html = `
      <style>
        .config-section {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .config-section h2 {
          margin: 0 0 16px 0;
          font-size: 18px;
          color: #111827;
        }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .form-row {
          display: grid;
          grid-template-columns: 200px 100px 100px 80px;
          gap: 12px;
          align-items: center;
          padding: 12px;
          background: #f9fafb;
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .form-row label {
          font-weight: 500;
        }
        .form-row input[type="time"],
        .form-row input[type="number"] {
          padding: 8px;
          border: 1px solid #d1d5db;
          border-radius: 4px;
        }
        .form-row input[type="number"] {
          width: 80px;
        }
        @media (max-width: 768px) {
          .form-grid { grid-template-columns: 1fr; }
          .form-row {
            grid-template-columns: 1fr;
            gap: 8px;
          }
        }
      </style>

      <h1>Configurar Check-in/Check-out</h1>
      <h2 style="color:#6b7280; font-weight:normal; margin:-10px 0 20px;">${escapeHtml(apartment.apartment_name)}</h2>
      <p><a href="/manager/checkin-rules">← Volver a la lista</a></p>

      <form method="POST" action="/manager/checkin-rules/${encodeURIComponent(apartmentId)}/save">
        
        <div class="config-section">
          <h2>⏰ Horas Estándar</h2>
          <div class="form-grid">
            <div>
              <label>Check-in estándar</label>
              <input type="time" name="standard_checkin_time" value="${r.standard_checkin_time}" required />
            </div>
            <div>
              <label>Check-out estándar</label>
              <input type="time" name="standard_checkout_time" value="${r.standard_checkout_time}" required />
            </div>
          </div>
        </div>

        <div class="config-section">
          <h2>🕐 Check-in Anticipado</h2>
          <p class="muted" style="margin:0 0 12px;">Opciones que se ofrecerán a los huéspedes</p>
          
          <div class="form-row">
            <label>Opción 1</label>
            <input type="time" name="early_checkin_option1_time" value="${r.early_checkin_option1_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option1_price" value="${r.early_checkin_option1_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option1_enabled" ${r.early_checkin_option1_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 2</label>
            <input type="time" name="early_checkin_option2_time" value="${r.early_checkin_option2_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option2_price" value="${r.early_checkin_option2_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option2_enabled" ${r.early_checkin_option2_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 3</label>
            <input type="time" name="early_checkin_option3_time" value="${r.early_checkin_option3_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="early_checkin_option3_price" value="${r.early_checkin_option3_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="early_checkin_option3_enabled" ${r.early_checkin_option3_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>
        </div>

        <div class="config-section">
          <h2>🕐 Check-out Tardío</h2>
          <p class="muted" style="margin:0 0 12px;">Opciones que se ofrecerán a los huéspedes</p>
          
          <div class="form-row">
            <label>Opción 1</label>
            <input type="time" name="late_checkout_option1_time" value="${r.late_checkout_option1_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option1_price" value="${r.late_checkout_option1_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option1_enabled" ${r.late_checkout_option1_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 2</label>
            <input type="time" name="late_checkout_option2_time" value="${r.late_checkout_option2_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option2_price" value="${r.late_checkout_option2_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option2_enabled" ${r.late_checkout_option2_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>

          <div class="form-row">
            <label>Opción 3</label>
            <input type="time" name="late_checkout_option3_time" value="${r.late_checkout_option3_time || ''}" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" name="late_checkout_option3_price" value="${r.late_checkout_option3_price || 0}" min="0" step="0.01" />
              <span>€</span>
            </div>
            <label style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" name="late_checkout_option3_enabled" ${r.late_checkout_option3_enabled ? 'checked' : ''} />
              Activa
            </label>
          </div>
        </div>

        <div class="config-section">
          <h2>⛔ Límites Absolutos</h2>
          <p class="muted" style="margin:0 0 12px;">Horas antes/después de las cuales NO se permite</p>
          <div class="form-grid">
            <div>
              <label>Check-in más temprano posible</label>
              <input type="time" name="earliest_possible_checkin" value="${r.earliest_possible_checkin}" required />
            </div>
            <div>
              <label>Check-out más tardío posible</label>
              <input type="time" name="latest_possible_checkout" value="${r.latest_possible_checkout}" required />
            </div>
          </div>
        </div>

        <div class="config-section">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="is_active" ${r.is_active ? 'checked' : ''} />
            <strong>Activar estas reglas para este apartamento</strong>
          </label>
        </div>

        <button type="submit" style="padding:12px 24px; font-size:16px;">💾 Guardar Configuración</button>
      </form>
    `;

    res.send(renderPage(`Configurar - ${apartment.apartment_name}`, html));
  } catch (e) {
    console.error("Error en /manager/checkin-rules/:apartmentId:", e);
    res.status(500).send("Error al cargar la configuración");
  }
});

// RUTA 3: Guardar configuración
app.post("/manager/checkin-rules/:apartmentId/save", async (req, res) => {
  try {
    const { apartmentId } = req.params;
    const {
      standard_checkin_time, standard_checkout_time,
      early_checkin_option1_time, early_checkin_option1_price, early_checkin_option1_enabled,
      early_checkin_option2_time, early_checkin_option2_price, early_checkin_option2_enabled,
      early_checkin_option3_time, early_checkin_option3_price, early_checkin_option3_enabled,
      late_checkout_option1_time, late_checkout_option1_price, late_checkout_option1_enabled,
      late_checkout_option2_time, late_checkout_option2_price, late_checkout_option2_enabled,
      late_checkout_option3_time, late_checkout_option3_price, late_checkout_option3_enabled,
      earliest_possible_checkin, latest_possible_checkout, is_active
    } = req.body;

    await pool.query(`
      INSERT INTO early_late_checkout_rules (
        apartment_id, standard_checkin_time, standard_checkout_time,
        early_checkin_option1_time, early_checkin_option1_price, early_checkin_option1_enabled,
        early_checkin_option2_time, early_checkin_option2_price, early_checkin_option2_enabled,
        early_checkin_option3_time, early_checkin_option3_price, early_checkin_option3_enabled,
        late_checkout_option1_time, late_checkout_option1_price, late_checkout_option1_enabled,
        late_checkout_option2_time, late_checkout_option2_price, late_checkout_option2_enabled,
        late_checkout_option3_time, late_checkout_option3_price, late_checkout_option3_enabled,
        earliest_possible_checkin, latest_possible_checkout, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (apartment_id)
      DO UPDATE SET
        standard_checkin_time = EXCLUDED.standard_checkin_time,
        standard_checkout_time = EXCLUDED.standard_checkout_time,
        early_checkin_option1_time = EXCLUDED.early_checkin_option1_time,
        early_checkin_option1_price = EXCLUDED.early_checkin_option1_price,
        early_checkin_option1_enabled = EXCLUDED.early_checkin_option1_enabled,
        early_checkin_option2_time = EXCLUDED.early_checkin_option2_time,
        early_checkin_option2_price = EXCLUDED.early_checkin_option2_price,
        early_checkin_option2_enabled = EXCLUDED.early_checkin_option2_enabled,
        early_checkin_option3_time = EXCLUDED.early_checkin_option3_time,
        early_checkin_option3_price = EXCLUDED.early_checkin_option3_price,
        early_checkin_option3_enabled = EXCLUDED.early_checkin_option3_enabled,
        late_checkout_option1_time = EXCLUDED.late_checkout_option1_time,
        late_checkout_option1_price = EXCLUDED.late_checkout_option1_price,
        late_checkout_option1_enabled = EXCLUDED.late_checkout_option1_enabled,
        late_checkout_option2_time = EXCLUDED.late_checkout_option2_time,
        late_checkout_option2_price = EXCLUDED.late_checkout_option2_price,
        late_checkout_option2_enabled = EXCLUDED.late_checkout_option2_enabled,
        late_checkout_option3_time = EXCLUDED.late_checkout_option3_time,
        late_checkout_option3_price = EXCLUDED.late_checkout_option3_price,
        late_checkout_option3_enabled = EXCLUDED.late_checkout_option3_enabled,
        earliest_possible_checkin = EXCLUDED.earliest_possible_checkin,
        latest_possible_checkout = EXCLUDED.latest_possible_checkout,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
    `, [
      apartmentId, standard_checkin_time, standard_checkout_time,
      early_checkin_option1_time || null, early_checkin_option1_price || 0, !!early_checkin_option1_enabled,
      early_checkin_option2_time || null, early_checkin_option2_price || 0, !!early_checkin_option2_enabled,
      early_checkin_option3_time || null, early_checkin_option3_price || 0, !!early_checkin_option3_enabled,
      late_checkout_option1_time || null, late_checkout_option1_price || 0, !!late_checkout_option1_enabled,
      late_checkout_option2_time || null, late_checkout_option2_price || 0, !!late_checkout_option2_enabled,
      late_checkout_option3_time || null, late_checkout_option3_price || 0, !!late_checkout_option3_enabled,
      earliest_possible_checkin, latest_possible_checkout, !!is_active
    ]);

    res.redirect(`/manager/checkin-rules/${apartmentId}?success=1`);
  } catch (e) {
    console.error("Error al guardar configuración:", e);
    res.status(500).send("Error al guardar");
  }
});

// ============================================
// RUTAS DEL STAFF - APROBACIÓN DE SOLICITUDES
// ============================================

// RUTA 1: Ver solicitudes pendientes

app.get("/staff/pending-requests", async (req, res) => {
  try {
    const { rows: requests } = await pool.query(`
      SELECT 
        cts.*,
        c.full_name, c.phone, c.arrival_date, c.departure_date,
        c.apartment_name, c.beds24_booking_id,
        br.apartment_name as room_name
      FROM checkin_time_selections cts
      JOIN checkins c ON c.id = cts.checkin_id
      LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.room_id::text
      WHERE cts.approval_status = 'pending'
      ORDER BY cts.created_at DESC
    `);

    const fmtDate = (d) => d ? String(d).slice(0, 10) : '-';

    const html = `
      <style>
        .request-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
        }
        .request-header {
          display: flex;
          justify-content: space-between;
          align-items: start;
          margin-bottom: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid #e5e7eb;
        }
        .btn-approve {
          background: #10b981;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .btn-approve:hover { background: #059669; }
        .btn-reject {
          background: #ef4444;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        .btn-reject:hover { background: #dc2626; }
        .empty-state {
          text-align: center;
          padding: 60px 20px;
          color: #6b7280;
        }
      </style>

      <h1>📋 Solicitudes de Horario Pendientes</h1>
      <p><a href="/staff/checkins">← Volver a Check-ins</a></p>

      ${requests.length === 0 ? `
        <div class="empty-state">
          <h2>No hay solicitudes pendientes</h2>
          <p>Todas las solicitudes han sido procesadas</p>
        </div>
      ` : requests.map(r => {
        const arrivalRequested = r.requested_arrival_time ? r.requested_arrival_time.slice(0, 5) : null;
        const departureRequested = r.requested_departure_time ? r.requested_departure_time.slice(0, 5) : null;
        const hasEarlycheckin = r.early_checkin_supplement > 0;
        const hasLateCheckout = r.late_checkout_supplement > 0;

        return `
          <div class="request-card">
            <div class="request-header">
              <div>
                <h2 style="margin:0 0 4px;">${escapeHtml(r.full_name)}</h2>
                <p style="margin:0; color:#6b7280;">
                  ${escapeHtml(r.room_name || r.apartment_name || 'Apartamento')} • 
                  Reserva: ${escapeHtml(r.beds24_booking_id)}
                </p>
              </div>
              <div style="background:#fef3c7; padding:8px 16px; border-radius:6px; text-align:center;">
                <div style="font-size:12px; color:#92400e;">TOTAL</div>
                <div style="font-size:24px; font-weight:700; color:#92400e;">${r.total_supplement}€</div>
              </div>
            </div>

            ${hasEarlycheckin ? `
              <div style="background:#dbeafe; padding:16px; border-radius:6px; margin-bottom:12px;">
                <strong>🕐 Check-in Anticipado</strong><br>
                Hora: <strong>${arrivalRequested}</strong> | Suplemento: <strong>${r.early_checkin_supplement}€</strong>
              </div>
            ` : ''}

            ${hasLateCheckout ? `
              <div style="background:#fce7f3; padding:16px; border-radius:6px; margin-bottom:12px;">
                <strong>🕐 Check-out Tardío</strong><br>
                Hora: <strong>${departureRequested}</strong> | Suplemento: <strong>${r.late_checkout_supplement}€</strong>
              </div>
            ` : ''}

            <form method="POST" action="/staff/pending-requests/${r.id}/process" style="margin-top:16px;">
              <div style="margin-bottom:12px;">
                <label style="display:block; margin-bottom:4px; font-weight:500;">📝 Notas (opcional)</label>
                <textarea name="manager_notes" rows="2" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
              </div>
              <button type="submit" name="action" value="approve" class="btn-approve">✅ Aprobar</button>
              <button type="submit" name="action" value="reject" class="btn-reject" onclick="return confirm('¿Rechazar?')">❌ Rechazar</button>
            </form>
          </div>
        `;
      }).join('')}
    `;

    res.send(renderPage("Solicitudes Pendientes", html));
  } catch (e) {
    console.error("Error en /staff/pending-requests:", e);
    res.status(500).send("Error");
  }
});

// RUTA 2: Procesar aprobación/rechazo

app.post("/staff/pending-requests/:id/process", async (req, res) => {
  try {
    const { id } = req.params;
    const { action, manager_notes } = req.body;
    
    const { rows: [request] } = await pool.query(
      `SELECT cts.*, c.phone, c.guest_language, c.full_name 
       FROM checkin_time_selections cts
       JOIN checkins c ON c.id = cts.checkin_id
       WHERE cts.id = $1`,
      [id]
    );
    
    if (!request) {
      return res.status(404).send("Solicitud no encontrada");
    }
    
    if (action === 'approve') {
      await pool.query(`
        UPDATE checkin_time_selections
        SET approval_status = 'approved', approval_status_updated_at = NOW(),
            approved_by = 'manager', manager_notes = $1
        WHERE id = $2
      `, [manager_notes || null, id]);
      
      console.log(`✅ Solicitud ${id} aprobada`);
    } else if (action === 'reject') {
      await pool.query(`
        UPDATE checkin_time_selections
        SET approval_status = 'rejected', approval_status_updated_at = NOW(),
            approved_by = 'manager', manager_notes = $1, rejection_reason = $1
        WHERE id = $2
      `, [manager_notes || 'No disponible', id]);
      
      console.log(`❌ Solicitud ${id} rechazada`);
    }
    
    res.redirect("/staff/pending-requests");
  } catch (e) {
    console.error("Error al procesar solicitud:", e);
    res.status(500).send("Error");
  }
});


app.get("/manager/whatsapp", requireAuth, requireRole('MANAGER'), (req, res) => {
  try {
    const htmlFilePath = path.join(__dirname, 'manager-whatsapp.html');
    const fileContent = fs.readFileSync(htmlFilePath, 'utf8');
    
    const styleMatch = fileContent.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const styles = styleMatch ? `<style>${styleMatch[1]}</style>` : '';
    
    // Solo tomar el PRIMER script, no todos
    const scriptMatch = fileContent.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    const scripts = scriptMatch ? `<script>${scriptMatch[1]}</script>` : '';
    
    const bodyMatch = fileContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    let bodyContent = bodyMatch ? bodyMatch[1] : fileContent;
    
    bodyContent = bodyContent.replace(/<nav class="nav-menu">[\s\S]*?<\/nav>/i, '');
    bodyContent = bodyContent.replace(/<script[\s\S]*?<\/script>/gi, ''); // Quitar scripts del body
    
    const html = styles + renderNavMenu('whatsapp', req) + bodyContent + scripts;
    
    res.send(renderPage("WhatsApp Manager", html));
  } catch (e) {
    console.error('Error loading manager-whatsapp.html:', e);
    const html = renderNavMenu('whatsapp', req) + `
      <div class="card">
        <h1>❌ Error</h1>
        <p>No se pudo cargar el contenido de WhatsApp Manager.</p>
      </div>
    `;
    res.send(renderPage("WhatsApp Manager", html));
  }
});


// Enviar WhatsApp manual desde Staff Panel
app.post("/api/whatsapp/send-manual", requireAuth, async (req, res) => {
  try {
    const { checkinId, message } = req.body;
    
    if (!checkinId || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'checkinId y message son requeridos' 
      });
    }
    
    // Obtener datos del checkin
    const result = await pool.query(`
      SELECT phone, full_name FROM checkins WHERE id = $1
    `, [checkinId]);
    
    if (!result.rows.length) {
      return res.status(404).json({ 
        success: false, 
        error: 'Checkin no encontrado' 
      });
    }
    
    const { phone, full_name } = result.rows[0];
    
    if (!phone) {
      return res.status(400).json({ 
        success: false, 
        error: 'El huésped no tiene teléfono registrado' 
      });
    }
    
    // Formatear número
    let formattedPhone = phone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('34') && formattedPhone.length === 9) {
      formattedPhone = '34' + formattedPhone;
    }
    
    // Enviar por Twilio
    await sendWhatsAppMessage(`whatsapp:+${formattedPhone}`, message);
    
    console.log(`📱 WhatsApp manual enviado a ${full_name} (${phone})`);
    
    res.json({ 
      success: true, 
      message: 'Mensaje enviado correctamente' 
    });
    
  } catch (error) {
    console.error('❌ Error enviando WhatsApp manual:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});


// API: Obtener mensajes del flujo principal (START, REGOK, PAYOK)
app.get("/api/whatsapp/flow-messages", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT message_key, content_es, content_en, content_fr, content_ru, active
      FROM whatsapp_flow_messages
      WHERE message_key IN ('START', 'REGOK', 'PAYOK', 'ASK_ARRIVAL', 'ASK_DEPARTURE', 'ASK_RULES', 'CONFIRMATION', 'EARLY_CHECKIN_NOTICE', 'LATE_CHECKOUT_NOTICE', 'APARTMENT_READY', 'BOOKING_CANCELLED')
      ORDER BY 
        CASE message_key
          WHEN 'START' THEN 1
          WHEN 'REGOK' THEN 2
          WHEN 'PAYOK' THEN 3
          WHEN 'ASK_ARRIVAL' THEN 4
          WHEN 'ASK_DEPARTURE' THEN 5
          WHEN 'ASK_RULES' THEN 6
          WHEN 'CONFIRMATION' THEN 7
          WHEN 'EARLY_CHECKIN_NOTICE' THEN 8
          WHEN 'LATE_CHECKOUT_NOTICE' THEN 9
        END
    `);
    
    res.json({
      success: true,
      messages: result.rows
    });
  } catch (error) {
    console.error('Error fetching flow messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Guardar mensajes del flujo
app.post("/api/whatsapp/flow-messages", requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Messages array is required' 
      });
    }
    
    console.log('📝 Guardando mensajes del flujo:', messages.length);
    
    for (const msg of messages) {
      await pool.query(`
        INSERT INTO whatsapp_flow_messages 
          (message_key, content_es, content_en, content_fr, content_ru, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (message_key) 
        DO UPDATE SET
          content_es = EXCLUDED.content_es,
          content_en = EXCLUDED.content_en,
          content_fr = EXCLUDED.content_fr,
          content_ru = EXCLUDED.content_ru,
          updated_at = CURRENT_TIMESTAMP
      `, [
        msg.message_key,
        msg.content_es || '',
        msg.content_en || '',
        msg.content_fr || '',
        msg.content_ru || ''
      ]);
      
      console.log(`✅ Guardado: ${msg.message_key}`);
    }
    
    res.json({
      success: true,
      message: 'Mensajes guardados correctamente'
    });
    
  } catch (error) {
    console.error('❌ Error guardando mensajes:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
// ===================== API: TRADUCCIÓN CON DEEPL =====================
app.post("/api/translate", requireAuth, async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    
    if (!text || !targetLang) {
      return res.status(400).json({ 
        success: false, 
        error: 'Text and targetLang are required' 
      });
    }
    
    // Verificar que existe la API key de DeepL
    if (!process.env.DEEPL_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'DeepL API key not configured' 
      });
    }
     const variablePattern = /\{[a-zA-Z_]+\}/g;
    const variables = text.match(variablePattern) || [];
    const placeholders = {};
    
    let protectedText = text;
    variables.forEach((variable, index) => {
      const placeholder = `VARIABLE${index}`;
      placeholders[placeholder] = variable;
      protectedText = protectedText.replace(variable, placeholder);
    });
    const deeplUrl = 'https://api-free.deepl.com/v2/translate';
    
    const response = await fetch(deeplUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        auth_key: process.env.DEEPL_API_KEY,
         text: protectedText,
        target_lang: targetLang,
        source_lang: 'ES'
      })
    });
    
   const data = await response.json();
    
    // 🔓 Restaurar variables en el texto traducido
    let translatedText = data.translations[0].text;
    Object.keys(placeholders).forEach(placeholder => {
      translatedText = translatedText.replace(new RegExp(placeholder, 'g'), placeholders[placeholder]);
    });
    
    if (!response.ok) {
      console.error('DeepL API error:', data);
      return res.status(500).json({ 
        success: false, 
        error: data.message || 'Translation failed' 
      });
    }
    
    res.json({
      success: true,
      translated: translatedText
    });
    
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});




// ============================================
// 📸 CLOUDINARY PHOTO UPLOAD
// ============================================

const cloudinary = require('cloudinary').v2;
const multer = require('multer');

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configurar Multer (almacenamiento en memoria)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB por foto
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes'));
    }
  }
});

// Endpoint de upload
app.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ninguna foto' });
    }

    console.log('📸 Subiendo foto:', {
      name: req.file.originalname,
      size: `${(req.file.size / 1024).toFixed(2)} KB`,
      type: req.file.mimetype
    });

    // Subir a Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'rcs-apartments',
          resource_type: 'image',
          transformation: [
            { width: 1200, crop: 'limit' }, // Máximo 1200px de ancho
            { quality: 'auto' } // Optimización automática
          ]
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      uploadStream.end(req.file.buffer);
    });

    console.log('✅ Foto subida a Cloudinary:', {
      url: result.secure_url,
      size: `${(result.bytes / 1024).toFixed(2)} KB`
    });

    res.json({
      success: true,
      url: result.secure_url,
      size: result.bytes
    });

  } catch (error) {
    console.error('❌ Error subiendo foto:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// API: Obtener configuración de Early/Late
app.get("/api/whatsapp/early-late-config", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        config_type,
        enabled,
        standard_time,
        price_1h,
        price_2h,
        price_3h,
        price_4h,
        message_es,
        message_en,
        message_fr,
        message_ru,
        requires_approval
      FROM early_late_config
      ORDER BY 
        CASE config_type
          WHEN 'early_checkin' THEN 1
          WHEN 'late_checkout' THEN 2
        END
    `);

    res.json({
      success: true,
      configs: result.rows
    });
  } catch (error) {
    console.error('Error fetching early/late config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Guardar configuración de Early/Late
app.post("/api/whatsapp/early-late-config", async (req, res) => {
  const { configs } = req.body;

  try {
    for (const config of configs) {
      await pool.query(`
        UPDATE early_late_config
        SET 
          enabled = $1,
          standard_time = $2,
          price_1h = $3,
          price_2h = $4,
          price_3h = $5,
          price_4h = $6,
          message_es = $7,
          message_en = $8,
          message_fr = $9,
          message_ru = $10,
          requires_approval = $11,
          updated_at = CURRENT_TIMESTAMP
        WHERE config_type = $12
      `, [
        config.enabled,
        config.standard_time,
        config.price_1h,
        config.price_2h,
        config.price_3h,
        config.price_4h,
        config.message_es,
        config.message_en,
        config.message_fr,
        config.message_ru,
        config.requires_approval,
        config.config_type
      ]);
    }

    res.json({
      success: true,
      message: 'Configuration updated successfully'
    });
  } catch (error) {
    console.error('Error saving early/late config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Obtener solicitudes pendientes de aprobación
app.get("/api/whatsapp/pending-requests", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.*,
        c.full_name as guest_name,
        c.email as guest_email,
        c.apartment_name
      FROM early_late_requests r
      JOIN checkins c ON r.checkin_id = c.id
      WHERE r.status = 'pending'
      ORDER BY r.created_at DESC
    `);

    res.json({
      success: true,
      requests: result.rows
    });
  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Aprobar/Rechazar solicitud
app.post("/api/whatsapp/approve-request/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const { action, approved_by, rejection_reason } = req.body;

  try {
    const status = action === 'approve' ? 'approved' : 'rejected';

    await pool.query(`
      UPDATE early_late_requests
      SET 
        status = $1,
        approved_by = $2,
        approved_at = CURRENT_TIMESTAMP,
        rejection_reason = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [status, approved_by, rejection_reason || null, requestId]);

    res.json({
      success: true,
      message: `Request ${status} successfully`
    });
  } catch (error) {
    console.error('Error approving/rejecting request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// 🏠 APARTMENT DATA API (SIMPLIFIED)
// ============================================

// GET: Obtener rooms de beds24
app.get("/api/beds24-rooms", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, apartment_name, beds24_room_id, apartment_id
      FROM beds24_rooms
      ORDER BY apartment_name ASC
    `);

    res.json({
      success: true,
      rooms: result.rows
    });
  } catch (error) {
    console.error('Error fetching beds24 rooms:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET: Obtener un room de beds24
app.get("/api/beds24-room/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT * FROM beds24_rooms WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    res.json({
      success: true,
      room: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET: Obtener apartment por ID
app.get("/api/apartment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT * FROM apartments WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Apartment not found' });
    }

    res.json({
      success: true,
      apartment: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching apartment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Guardar apartment (upsert)
app.post("/api/apartment/save", async (req, res) => {
  try {
    const data = req.body;
    
    console.log('💾 Guardando apartment para beds24_room:', data.beds24_room_id);
    
    // Verificar si existe apartment para este beds24_room
    const roomCheck = await pool.query(`
      SELECT apartment_id FROM beds24_rooms WHERE id = $1
    `, [data.beds24_room_id]);
    
    if (roomCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Beds24 room not found' });
    }
    
    const apartmentId = roomCheck.rows[0].apartment_id;
    
    let result;
    
    if (apartmentId) {
      // UPDATE apartment existente
      result = await pool.query(`
        UPDATE apartments SET
          name = $1, address = $2, city = $3, floor = $4, door_number = $5,
          lockbox_code = $6, lockbox_location = $7, door_code = $8, gate_code = $9,
          key_instructions = $10, wifi_network = $11, wifi_password = $12,
          wifi_troubleshooting = $13, checkin_time = $14, checkout_time = $15,
          early_checkin_price = $16, late_checkout_price = $17,
          security_deposit_amount = $18, tourist_tax_amount = $19,
          parking_available = $20, parking_location = $21, parking_code = $22,
          parking_instructions = $23, pool_available = $24, pool_hours = $25,
          pool_location = $26, pool_rules = $27, support_phone = $28,
          support_whatsapp = $29, updated_at = NOW()
        WHERE id = $30
        RETURNING id
      `, [
        data.name, data.address, data.city, data.floor, data.door_number,
        data.lockbox_code, data.lockbox_location, data.door_code, data.gate_code,
        data.key_instructions, data.wifi_network, data.wifi_password,
        data.wifi_troubleshooting, data.checkin_time, data.checkout_time,
        data.early_checkin_price, data.late_checkout_price,
        data.security_deposit_amount, data.tourist_tax_amount,
        data.parking_available, data.parking_location, data.parking_code,
        data.parking_instructions, data.pool_available, data.pool_hours,
        data.pool_location, data.pool_rules, data.support_phone,
        data.support_whatsapp, apartmentId
      ]);
      
      console.log('✅ Apartment actualizado:', apartmentId);
      
    } else {
      // INSERT nuevo apartment
      result = await pool.query(`
        INSERT INTO apartments (
          name, address, city, floor, door_number,
          lockbox_code, lockbox_location, door_code, gate_code,
          key_instructions, wifi_network, wifi_password,
          wifi_troubleshooting, checkin_time, checkout_time,
          early_checkin_price, late_checkout_price,
          security_deposit_amount, tourist_tax_amount,
          parking_available, parking_location, parking_code,
          parking_instructions, pool_available, pool_hours,
          pool_location, pool_rules, support_phone, support_whatsapp
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27, $28, $29
        )
        RETURNING id
      `, [
        data.name, data.address, data.city, data.floor, data.door_number,
        data.lockbox_code, data.lockbox_location, data.door_code, data.gate_code,
        data.key_instructions, data.wifi_network, data.wifi_password,
        data.wifi_troubleshooting, data.checkin_time, data.checkout_time,
        data.early_checkin_price, data.late_checkout_price,
        data.security_deposit_amount, data.tourist_tax_amount,
        data.parking_available, data.parking_location, data.parking_code,
        data.parking_instructions, data.pool_available, data.pool_hours,
        data.pool_location, data.pool_rules, data.support_phone, data.support_whatsapp
      ]);
      
      const newApartmentId = result.rows[0].id;
      console.log('✅ Apartment creado:', newApartmentId);
      
      // Actualizar apartment_id en beds24_rooms
      await pool.query(`
        UPDATE beds24_rooms SET apartment_id = $1 WHERE id = $2
      `, [newApartmentId, data.beds24_room_id]);
      
      console.log('✅ Relación creada: beds24_room → apartment');
    }
    
    // Actualizar también beds24_rooms
    await pool.query(`
      UPDATE beds24_rooms SET
        apartment_name = $1,
        support_phone = $2,
        default_arrival_time = $3,
        default_departure_time = $4,
        registration_url = $5,
        payment_url = $6,
        keys_instructions_url = $7,
        show_in_staff = $8,
        updated_at = NOW()
      WHERE id = $9
    `, [
      data.name,
      data.support_phone,
      data.checkin_time,
      data.checkout_time,
      data.registration_url,
      data.payment_url,
      data.keys_instructions_url,
      data.show_in_staff,
      data.beds24_room_id
    ]);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Error saving apartment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============== API: RESPUESTAS AUTOMÁTICAS WHATSAPP ===============

// ============================================================
// 📋 API: AUTORESPUESTAS (KEYWORDS)
// ============================================================

// GET: Obtener todas las autorespuestas
app.get("/api/whatsapp/auto-replies", async (req, res) => {
  try {
    const result = await pool.query(`
     SELECT 
  id,
  category,
  keywords,
  response_es,
  response_en,
  response_fr,
  response_ru,
  active,
  priority,
  apartment_ids,
  created_at,
  updated_at
FROM whatsapp_auto_replies
ORDER BY priority DESC, category ASC
    `);

   // Parsear apartment_ids de JSON string a array
const repliesWithParsedIds = result.rows.map(reply => ({
  ...reply,
  apartment_ids: reply.apartment_ids ? JSON.parse(reply.apartment_ids) : []
}));

res.json({
  success: true,
  replies: repliesWithParsedIds
});
  } catch (error) {
    console.error('Error fetching auto-replies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Listar apartamentos disponibles
app.get("/api/apartments/list", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, beds24_room_id, apartment_name, is_active
      FROM beds24_rooms
      WHERE is_active = true
      ORDER BY apartment_name ASC
    `);
    
    res.json({
      success: true,
      apartments: result.rows
    });
  } catch (error) {
    console.error('Error loading apartments:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});


app.post("/api/whatsapp/auto-replies", async (req, res) => {
  try {
    let { category, keywords, response_es, response_en, response_fr, response_ru, active, priority } = req.body;

    console.log('📥 Keywords recibidos:', keywords, typeof keywords);

    // ✅ Convertir keywords a string limpio
    let keywordsText = '';
    
    if (Array.isArray(keywords)) {
      // Si es array: ['wifi', 'password'] → 'wifi,password'
      keywordsText = keywords.filter(k => k && k.trim()).join(',');
    } else if (typeof keywords === 'string') {
      // Si es string, limpiar
      keywordsText = keywords.trim();
    }

    console.log('💾 Keywords a guardar (string):', keywordsText);

    const result = await pool.query(`
     INSERT INTO whatsapp_auto_replies
  (category, keywords, response_es, response_en, response_fr, response_ru, active, priority, apartment_ids)
VALUES ($1, $2::text, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      category || 'custom',
    category || 'custom',
  keywordsText,
  response_es,
  response_en || response_es,
  response_fr || response_es,
  response_ru || response_es,
  active !== false,
  priority || 0,
  JSON.stringify(apartment_ids || [])
    ]);

    console.log(`✅ Guardado: ${msg.message_key}`);

    res.json({ success: true, reply: result.rows[0] });
  } catch (error) {
    console.error('❌ Error creating auto-reply:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put("/api/whatsapp/auto-replies/:id", async (req, res) => {
  try {
    const { id } = req.params;
   let { category, keywords, response_es, response_en, response_fr, response_ru, active, priority, apartment_ids } = req.body;
    console.log('📝 Keywords recibidos:', keywords, typeof keywords);

    // ✅ Convertir keywords a string limpio
    let keywordsText = '';
    
    if (Array.isArray(keywords)) {
      keywordsText = keywords.filter(k => k && k.trim()).join(',');
    } else if (typeof keywords === 'string') {
      keywordsText = keywords.trim();
    }

    console.log('💾 Keywords a actualizar (string):', keywordsText);

    const result = await pool.query(`
      UPDATE whatsapp_auto_replies
      SET
        category = $1,
  keywords = $2::text,
  response_es = $3,
  response_en = $4,
  response_fr = $5,
  response_ru = $6,
  active = $7,
  priority = $8,
  apartment_ids = $9,
  updated_at = NOW()
WHERE id = $10
      RETURNING *
    `, [
     category,
  keywordsText,
  response_es,
  response_en,
  response_fr,
  response_ru,
  active,
  priority || 0,
  JSON.stringify(apartment_ids || []),
  id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Auto-reply not found' });
    }

    console.log('✅ Actualizado:', result.rows[0].keywords);

    res.json({ success: true, reply: result.rows[0] });
  } catch (error) {
    console.error('❌ Error updating:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// DELETE: Eliminar autorespuesta
app.delete("/api/whatsapp/auto-replies/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      DELETE FROM whatsapp_auto_replies
      WHERE id = $1
      RETURNING id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Auto-reply not found'
      });
    }

    res.json({
      success: true,
      message: 'Auto-reply deleted'
    });
  } catch (error) {
    console.error('Error deleting auto-reply:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================================================================================
// 🤖 WEBHOOK DE WHATSAPP - CON SISTEMA DE SESIONES
// ================================================================================
// 
// FLUJO:
// 1. Usuario envía START_123456 desde cualquier número → Crea sesión
// 2. Bot vincula ese número con esa reserva en whatsapp_sessions
// 3. Usuario puede usar REGOK, PAYOK, enviar horas, etc.
// 4. OTRO número puede enviar START_123456 y también trabajar con esa reserva
//
// Estados posibles en bot_state:
// - IDLE: Sin actividad
// - WAITING_REGOK: Esperando que complete registro
// - WAITING_PAYOK: Esperando confirmación de pago
// - WAITING_ARRIVAL: Esperando hora de llegada
// - WAITING_DEPARTURE: Esperando hora de salida
// - DONE: Flujo completado
// ================================================================================

// ============ WEBHOOK DE WHATSAPP - PROCESAR MENSAJES ENTRANTES ============

app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  try {
    const { From, Body, MessageSid } = req.body;
    
    console.log(`📱 WhatsApp mensaje recibido de ${From}: ${Body}`);
    
    // Responder a Twilio inmediatamente (200 OK)
    res.status(200).send('OK');
    
    // Procesar mensaje en segundo plano
    processWhatsAppMessage(From, Body, MessageSid).catch(err => {
      console.error('❌ Error procesando mensaje WhatsApp:', err);
    });
    
  } catch (error) {
    console.error('❌ Error en webhook WhatsApp:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ FUNCIÓN PRINCIPAL PARA PROCESAR MENSAJES ============

async function processWhatsAppMessage(from, body, messageId) {
  try {
    // Normalizar número de teléfono (quitar whatsapp: y +)
    const phoneNumber = from.replace('whatsapp:', '').replace('+', '');
    
    console.log(`🔍 Procesando mensaje de: ${phoneNumber}`);
    
    // Normalizar texto del mensaje
    const bodyUpper = body.toUpperCase().trim();
    const bodyLower = body.toLowerCase().trim();
    
    // ========== PRIORIDAD 1: COMANDO START (CREAR/ACTUALIZAR SESIÓN) ==========
    
    const startMatch = bodyUpper.match(/^START[\s_:-]*([0-9]+)[\s_:-]*([A-Z]{2})?\s*$/);
    
    if (startMatch) {
      await handleStartCommand(from, phoneNumber, startMatch, body);
      return;
    }
    
    // ========== PRIORIDAD 2: BUSCAR SESIÓN ACTIVA ==========
    
    const checkin = await getSessionCheckin(phoneNumber);
    
    if (!checkin) {
      console.log(`⚠️ No hay sesión activa para ${phoneNumber}`);
      await sendWhatsAppMessage(from, 
        '⚠️ No encuentro tu reserva.\n\nPor favor, envía:\nSTART [número de reserva]\n\nEjemplo: START 80271139'
      );
      return;
    }
    
    console.log(`✅ Sesión encontrada: ${checkin.full_name} (ID: ${checkin.id}, Estado: ${checkin.bot_state})`);
    
    // Detectar idioma del guest (desde Beds24 o default español)
    const language = detectLanguage(checkin.guest_language);
    console.log(`🌐 Idioma detectado: ${language}`);
    
   
    // ========== PRIORIDAD 4: COMANDOS ESPECIALES ==========
    
    // COMANDO: REGOK
    if (bodyLower === 'regok') {
      await handleRegOk(from, checkin, language);
      return;
    }
    
    // COMANDO: PAYOK
    if (bodyLower === 'payok' || bodyLower.includes('he pagado') || bodyLower.includes('pagado')) {
      await handlePayOk(from, checkin, language);
      return;
    }
    
    // ========== PRIORIDAD 5: PROCESAR SEGÚN ESTADO DEL BOT ==========
    
    const currentState = checkin.bot_state || 'IDLE';

    switch (currentState) {
      case 'WAITING_ARRIVAL':
        await handleArrivalTime(from, checkin, body, language);
        break;
        
      case 'WAITING_DEPARTURE':
        await handleDepartureTime(from, checkin, body, language);
        break;
        
      case 'WAITING_RULES':
        await handleRulesAcceptance(from, checkin, body, language);
        break;
        
      case 'DONE':
        console.log(`✅ Flujo ya completado para checkin ${checkin.id}`);
        break;
        
      default:
        console.log(`💬 Mensaje libre sin acción específica (estado: ${currentState})`);
        break;
    }

    // ============================================
    // 🤖 AUTO-REPLIES: Detectar keywords
    // ============================================

    const canCheckAutoReply = true; // ✅ SIEMPRE activo

    if (canCheckAutoReply && body && body.trim().length > 0) {
    const autoReplyResponse = await checkAutoReply(
  body, 
  language || 'es',
  checkin.id  // ✅ Pasar checkin ID
);

      if (autoReplyResponse) {
        await sendWhatsAppMessage(from, autoReplyResponse);
        console.log(`🤖 Auto-reply sent to ${from}: keyword matched`);
      }
    }

  } catch (error) {
    console.error('❌ Error procesando mensaje WhatsApp:', error);
  }
}  // ✅ AÑADIDO: Cierre de la función processWhatsAppMessage

// ============ MANEJAR COMANDO START ============

async function handleStartCommand(from, phoneNumber, startMatch, originalBody) {
  try {
    const bookingId = String(startMatch[1] || "").trim();
    const langCode = (startMatch[2] || 'es').toLowerCase();
    const supportedLangs = ['es', 'en', 'fr', 'ru'];
    const language = supportedLangs.includes(langCode) ? langCode : 'es';
    
    console.log(`🎯 Comando START recibido: booking=${bookingId}, lang=${language}`);
    
    // Buscar el checkin por booking ID
    const result = await pool.query(`
      SELECT * FROM checkins
      WHERE booking_token = $1 
         OR beds24_booking_id::text = $1 
         OR REPLACE(beds24_booking_id::text, ' ', '') = $1
         OR booking_id_from_start = $1
      ORDER BY id DESC 
      LIMIT 1
    `, [bookingId]);
    
    if (result.rows.length === 0) {
      console.log(`⚠️ No se encontró booking: ${bookingId}`);
      await sendWhatsAppMessage(from, 
        `❌ No encuentro la reserva ${bookingId}.\n\nVerifica el número y vuelve a intentar.`
      );
      return;
    }
    
    const checkin = result.rows[0];
    console.log(`✅ Booking encontrado: ${checkin.full_name} (ID: ${checkin.id})`);
   if (checkin.cancelled) {
  console.log(`❌ Reserva cancelada: ${bookingId}`);
  
 // Obtener mensaje de la base de datos
let cancelledMessage = await getFlowMessage('BOOKING_CANCELLED', language);

if (!cancelledMessage) {
  // Fallback si no existe en BD
  cancelledMessage = '❌ Esta reserva ha sido cancelada.\n\nSi tienes una nueva reserva, por favor usa el nuevo enlace de WhatsApp que recibiste.';
} else {
  // Reemplazar variables
  cancelledMessage = cancelledMessage
    .replace(/{support_whatsapp}/g, process.env.SUPPORT_WHATSAPP || '+34600000000')
    .replace(/{support_phone}/g, process.env.SUPPORT_PHONE || '+34600000000');
}

await sendWhatsAppMessage(from, cancelledMessage);
    
    // Actualizar idioma si se especificó
    if (startMatch[2]) {
      await pool.query(
        `UPDATE checkins SET guest_language = $1 WHERE id = $2`,
        [language, checkin.id]
      );
      console.log(`🌐 Idioma actualizado a: ${language}`);
    }
    
    // CREAR/ACTUALIZAR SESIÓN: vincular este número con este checkin
    await setSessionCheckin(phoneNumber, checkin.id);
    console.log(`🔗 Sesión creada: ${phoneNumber} → checkin ${checkin.id}`);
    
    // Actualizar el teléfono en el checkin si está vacío
    await pool.query(
      `UPDATE checkins SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE id = $2`,
      [phoneNumber, checkin.id]
    );
    
 // Obtener mensaje START de la DB
const roomResult = await pool.query(`
  SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
  FROM beds24_rooms 
  WHERE beds24_room_id = $1 
  LIMIT 1
`, [checkin.beds24_room_id]);

const room = roomResult.rows[0] || {};

let msg = await getFlowMessage('START', language);

if (msg) {
  msg = await replaceVariables(msg, checkin, room);
  await sendWhatsAppMessage(from, msg);
  console.log('✅ Enviado mensaje START');
  
  // Actualizar estado
  await pool.query(`
    UPDATE checkins 
    SET bot_state = 'WAITING_REGOK' 
    WHERE id = $1
  `, [checkin.id]);
}
    
  } catch (error) {
    console.error('❌ Error en handleStartCommand:', error);
  }
}
// ============ REEMPLAZAR VARIABLES EN MENSAJES ============

async function replaceVariables(message, checkinIdOrObject, roomObject) {
  try {
    if (!message) return message;
    
    let checkin, room, apartmentData;
    
    // Caso 1: Se llamó desde checkAutoReply (solo checkinId)
    if (typeof checkinIdOrObject === 'number' && !roomObject) {
      console.log(`🔄 Reemplazando variables para checkin ID ${checkinIdOrObject}`);
      
      // Obtener datos completos
      const result = await pool.query(`
        SELECT 
          c.*,
          br.beds24_room_id,
          br.apartment_id,
          br.registration_url,
          br.payment_url,
          br.default_arrival_time,
          br.default_departure_time,
          a.*
        FROM checkins c
        LEFT JOIN beds24_rooms br ON c.beds24_room_id = br.beds24_room_id
        LEFT JOIN apartments a ON br.apartment_id = a.id
        WHERE c.id = $1
      `, [checkinIdOrObject]);
      
      if (result.rows.length === 0) {
        console.log(`⚠️ No se encontró checkin ${checkinIdOrObject}`);
        return message;
      }
      
      const data = result.rows[0];
      checkin = data;
      room = {
        registration_url: data.registration_url,
        payment_url: data.payment_url,
        default_arrival_time: data.default_arrival_time,
        default_departure_time: data.default_departure_time
      };
      apartmentData = data;
      
    } 
    // Caso 2: Se llamó desde flujo del bot (checkin object + room object)
    else {
      checkin = checkinIdOrObject;
      room = roomObject || {};
      apartmentData = null;
    }
    
    // Variables básicas
    const bookIdForLinks = String(
      checkin.beds24_booking_id || 
      checkin.booking_id_from_start || 
      checkin.booking_token || ""
    ).replace(/\s/g, '');
    
    const regLink = (room.registration_url || "").replace(/\[BOOKID\]/g, bookIdForLinks);
    const payLink = (room.payment_url || "").replace(/\[BOOKID\]/g, bookIdForLinks);
    
    const name = checkin.full_name || "";
    const apt = checkin.apartment_name || checkin.apartment_id || "";
    const arriveDate = checkin.arrival_date ? String(checkin.arrival_date).slice(0, 10) : "";
    const departDate = checkin.departure_date ? String(checkin.departure_date).slice(0, 10) : "";
    
    const arriveTime = (checkin.arrival_time ? String(checkin.arrival_time).slice(0, 2) : "") || 
                       String(room.default_arrival_time || "").slice(0, 2) || "17";
    const departTime = (checkin.departure_time ? String(checkin.departure_time).slice(0, 2) : "") || 
                       String(room.default_departure_time || "").slice(0, 2) || "11";
    
    const adults = Number(checkin.adults || 0);
    const children = Number(checkin.children || 0);
    
    let guestsText = "";
    if (adults > 0 || children > 0) {
      const lang = checkin.guest_language?.toLowerCase() || 'es';
      const adultsWord = lang === 'en' ? 'adults' : 
                         lang === 'fr' ? 'adultes' : 
                         lang === 'ru' ? 'взрослых' : 'adultos';
      const childrenWord = lang === 'en' ? 'children' : 
                           lang === 'fr' ? 'enfants' : 
                           lang === 'ru' ? 'детей' : 'niños';
      
      guestsText = `${adults} ${adultsWord}`;
      if (children > 0) {
        guestsText += `, ${children} ${childrenWord}`;
      }
    }
    
    // Reemplazar variables básicas
    let result_text = message
      .replace(/\{booking_id\}/g, bookIdForLinks)
      .replace(/\[BOOKID\]/g, bookIdForLinks)
      .replace(/\{guest_name\}/g, name)
      .replace(/\{apartment_name\}/g, apt)
      .replace(/\{apartment_id\}/g, checkin.apartment_id || "")
      .replace(/\{arrival_date\}/g, arriveDate)
      .replace(/\{departure_date\}/g, departDate)
      .replace(/\{arrival_time\}/g, arriveTime)
      .replace(/\{departure_time\}/g, departTime)
      .replace(/\{adults\}/g, String(adults))
      .replace(/\{children\}/g, String(children))
      .replace(/\{guests_text\}/g, guestsText || "—")
      .replace(/\{registration_url\}/g, regLink || "—")
      .replace(/\{payment_url\}/g, payLink || "—");
    
    // Variables de apartments (solo si tenemos datos)
 // Variables de apartments (solo si tenemos datos)
if (apartmentData && apartmentData.apartment_id) {
  console.log(`✅ Reemplazando variables de apartment ID ${apartmentData.apartment_id}`);
  
  // Detectar idioma del huésped
  const guestLanguage = checkin.guest_language || 'es';
  
  // Campos que NO necesitan traducción (datos puros)
  const pureDataFields = {
    address: apartmentData.address || '',
    city: apartmentData.city || '',
    floor: apartmentData.floor || '',
    door_number: apartmentData.door_number || '',
    lockbox_code: apartmentData.lockbox_code || '',
    door_code: apartmentData.door_code || '',
    gate_code: apartmentData.gate_code || '',
    wifi_network: apartmentData.wifi_network || '',
    wifi_password: apartmentData.wifi_password || '',
    checkin_time: apartmentData.checkin_time || apartmentData.default_checkin_time || '',
    checkout_time: apartmentData.checkout_time || apartmentData.default_checkout_time || '',
    security_deposit_amount: apartmentData.security_deposit_amount || '',
    tourist_tax_amount: apartmentData.tourist_tax_amount || '',
    early_checkin_price: apartmentData.early_checkin_price || '',
    late_checkout_price: apartmentData.late_checkout_price || '',
    parking_code: apartmentData.parking_code || '',
    support_phone: apartmentData.support_phone || '',
    support_whatsapp: apartmentData.support_whatsapp || ''
  };
  
  // Campos que SÍ necesitan traducción (textos)
  const textFields = {
    lockbox_location: apartmentData.lockbox_location || '',
    key_instructions: apartmentData.key_instructions || '',
    wifi_troubleshooting: apartmentData.wifi_troubleshooting || '',
    parking_location: apartmentData.parking_location || '',
    parking_instructions: apartmentData.parking_instructions || '',
    pool_hours: apartmentData.pool_hours || '',
    pool_location: apartmentData.pool_location || '',
    pool_rules: apartmentData.pool_rules || ''
  };
  
  // Si el idioma NO es español, traducir campos de texto
  if (guestLanguage !== 'es') {
    console.log(`🌐 Traduciendo campos de texto a: ${guestLanguage}`);
    
    for (const [key, value] of Object.entries(textFields)) {
      if (value && value.trim()) {
        try {
          const translated = await translateWithDeepL(value, guestLanguage.toUpperCase());
          textFields[key] = translated || value; // Fallback al original si falla
        } catch (error) {
          console.error(`❌ Error traduciendo ${key}:`, error);
          // Mantener texto original si falla traducción
        }
      }
    }
  }
  
  // Combinar campos puros + campos traducidos
  const apartmentVars = { ...pureDataFields, ...textFields };
  
  // Reemplazar variables
  for (const [key, value] of Object.entries(apartmentVars)) {
    if (value) {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      result_text = result_text.replace(regex, value);
    }
  }
}
    
    return result_text;
    
  } catch (error) {
    console.error('❌ Error en replaceVariables:', error);
    return message;
  }
}
// ============ OBTENER SESIÓN ACTIVA ============

async function getSessionCheckin(phoneNumber) {
  try {
    const result = await pool.query(`
      SELECT c.* 
      FROM whatsapp_sessions ws
      JOIN checkins c ON c.id = ws.checkin_id
      WHERE ws.phone = $1 
      ORDER BY ws.updated_at DESC 
      LIMIT 1
    `, [phoneNumber]);
    
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Error obteniendo sesión:', error);
    return null;
  }
}

// ============ CREAR/ACTUALIZAR SESIÓN ============

async function setSessionCheckin(phoneNumber, checkinId) {
  try {
    await pool.query(`
      INSERT INTO whatsapp_sessions (phone, checkin_id, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (phone) 
      DO UPDATE SET 
        checkin_id = EXCLUDED.checkin_id, 
        updated_at = NOW()
    `, [phoneNumber, checkinId]);
    
    console.log(`✅ Sesión guardada: ${phoneNumber} → checkin ${checkinId}`);
  } catch (error) {
    console.error('❌ Error guardando sesión:', error);
  }
}

// ============ DETECTAR IDIOMA DEL GUEST ============

function detectLanguage(guestLanguage) {
  if (!guestLanguage) return 'es';
  
  const langLower = guestLanguage.toLowerCase();
  
  // Mapeo de códigos comunes de Beds24
  if (langLower.includes('en') || langLower.includes('english')) return 'en';
  if (langLower.includes('fr') || langLower.includes('french') || langLower.includes('français')) return 'fr';
  if (langLower.includes('ru') || langLower.includes('russian') || langLower.includes('русский')) return 'ru';
  
  return 'es'; // Default español
}

// ============ MANEJAR COMANDO: REGOK ============

async function handleRegOk(from, checkin, language) {
  console.log(`✅ Procesando REGOK para checkin ${checkin.id}`);
  
  // Obtener configuración del apartamento
  const roomResult = await pool.query(
    `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
     FROM beds24_rooms 
     WHERE beds24_room_id = $1 OR id::text = $1 
     LIMIT 1`,
    [String(checkin.apartment_id || "")]
  );
  
  const room = roomResult.rows[0] || {};
  
  // Obtener mensaje REGOK de la DB
  let msg = await getFlowMessage('REGOK', language);
  
  if (msg) {
    // Reemplazar variables en el mensaje
    msg = await replaceVariables(msg, checkin, room);
    
    await sendWhatsAppMessage(from, msg);
    console.log(`✅ Enviado mensaje REGOK con variables reemplazadas`);
    
    // Actualizar estado
    await pool.query(`
  UPDATE checkins 
  SET bot_state = 'WAITING_PAYOK',
      registration_completed_at = NOW()
  WHERE id = $1
`, [checkin.id]);
console.log(`✅ Registro completado marcado para checkin ${checkin.id}`);
  }
}

// ============ MANEJAR COMANDO: PAYOK ============

async function handlePayOk(from, checkin, language) {
  console.log(`✅ Procesando PAYOK para checkin ${checkin.id}`);
  
  // Obtener configuración del apartamento
  const roomResult = await pool.query(
    `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
     FROM beds24_rooms 
     WHERE beds24_room_id = $1 OR id::text = $1 
     LIMIT 1`,
    [String(checkin.apartment_id || "")]
  );
  
  const room = roomResult.rows[0] || {};
  
  // 1. Enviar mensaje PAYOK
  let payokMsg = await getFlowMessage('PAYOK', language);
  if (payokMsg) {
    payokMsg = await replaceVariables(payokMsg, checkin, room);
    await sendWhatsAppMessage(from, payokMsg);
    console.log(`✅ Enviado mensaje PAYOK`);
    
    // 2. Esperar 2 segundos
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 3. Enviar ASK_ARRIVAL automáticamente
    let askArrivalMsg = await getFlowMessage('ASK_ARRIVAL', language);
    if (askArrivalMsg) {
      askArrivalMsg = await replaceVariables(askArrivalMsg, checkin, room);
      await sendWhatsAppMessage(from, askArrivalMsg);
      console.log(`✅ Enviado mensaje ASK_ARRIVAL automáticamente`);
      
      // 4. Actualizar estado a WAITING_ARRIVAL
      await pool.query(`
        UPDATE checkins 
        SET bot_state = 'WAITING_ARRIVAL' 
        WHERE id = $1
      `, [checkin.id]);
      
      console.log(`🔄 Estado actualizado a WAITING_ARRIVAL`);
    }
  }
}

// ============ MANEJAR HORA DE LLEGADA ============


async function handleArrivalTime(from, checkin, body, language) {
  console.log(`⏰ Procesando hora de llegada: "${body}"`);
  
  // Validar y parsear hora
  const parsedTime = parseTimeInput(body);
  
  if (!parsedTime) {
    const errorMsg = getErrorMessage('INVALID_TIME', language);
    await sendWhatsAppMessage(from, errorMsg);
    console.log(`⚠️ Hora inválida: "${body}"`);
    return;
  }
  
  console.log(`✅ Hora válida parseada: ${parsedTime}`);
  
  // Extraer la hora (sin minutos)
  const hour = parseInt(parsedTime.split(':')[0]);
  const STANDARD_CHECKIN_HOUR = 17; // 5pm
  
  // Obtener configuración del apartamento
  const roomResult = await pool.query(
    `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
     FROM beds24_rooms 
     WHERE beds24_room_id = $1 OR id::text = $1 
     LIMIT 1`,
    [String(checkin.apartment_id || "")]
  );
  
  const room = roomResult.rows[0] || {};
  
  // VERIFICAR SI ES EARLY CHECK-IN
  if (hour < STANDARD_CHECKIN_HOUR) {
    console.log(`🕐 Early check-in solicitado: ${parsedTime} (estándar: ${STANDARD_CHECKIN_HOUR}:00)`);
    
    // Guardar hora y marcar como early check-in solicitado
    await pool.query(`
      UPDATE checkins 
      SET 
        arrival_time = $1,
        early_checkin_requested = true,
        bot_state = 'WAITING_DEPARTURE'
      WHERE id = $2
    `, [parsedTime, checkin.id]);
    
    // Crear solicitud en early_late_requests
   // Crear solicitud en early_late_requests
const hoursDiff = STANDARD_CHECKIN_HOUR - hour;
await pool.query(`
  INSERT INTO early_late_requests 
    (checkin_id, request_type, requested_time, hours_difference, status, guest_phone, created_at)
  VALUES ($1, 'early_checkin', $2, $3, 'pending', $4, NOW())
`, [checkin.id, parsedTime, hoursDiff, from]);
    
    console.log(`📝 Solicitud de early check-in creada (${hoursDiff}h antes)`);
    
    // Enviar mensaje de early check-in
    let earlyMsg = await getFlowMessage('EARLY_CHECKIN_NOTICE', language);
    if (earlyMsg) {
      earlyMsg = await replaceVariables(earlyMsg, checkin, room);
      await sendWhatsAppMessage(from, earlyMsg);
      console.log(`✅ Enviado mensaje EARLY_CHECKIN_NOTICE`);
    }
    
  } else {
    // HORARIO NORMAL - Continuar flujo
    console.log(`✅ Horario normal: ${parsedTime}`);
    
    await pool.query(`
      UPDATE checkins 
      SET 
        arrival_time = $1,
        bot_state = 'WAITING_DEPARTURE'
      WHERE id = $2
    `, [parsedTime, checkin.id]);
    
    console.log(`💾 Hora de llegada guardada: ${parsedTime}`);
  }
  
  // Esperar 1 segundo
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Enviar ASK_DEPARTURE (en ambos casos)
  let askDepartureMsg = await getFlowMessage('ASK_DEPARTURE', language);
  if (askDepartureMsg) {
    askDepartureMsg = await replaceVariables(askDepartureMsg, checkin, room);
    await sendWhatsAppMessage(from, askDepartureMsg);
    console.log(`✅ Enviado mensaje ASK_DEPARTURE`);
  }
}

// ============ MANEJAR HORA DE SALIDA ============

async function handleDepartureTime(from, checkin, body, language) {
  console.log(`⏰ Procesando hora de salida: "${body}"`);
  
  // Validar y parsear hora
  const parsedTime = parseTimeInput(body);
  
  if (!parsedTime) {
    const errorMsg = getErrorMessage('INVALID_TIME', language);
    await sendWhatsAppMessage(from, errorMsg);
    console.log(`⚠️ Hora inválida: "${body}"`);
    return;
  }
  
  console.log(`✅ Hora válida parseada: ${parsedTime}`);
  
  // Extraer la hora (sin minutos)
  const hour = parseInt(parsedTime.split(':')[0]);
  const STANDARD_CHECKOUT_HOUR = 11; // 11am
  
  // Obtener configuración del apartamento
  const roomResult = await pool.query(
    `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
     FROM beds24_rooms 
     WHERE beds24_room_id = $1 OR id::text = $1 
     LIMIT 1`,
    [String(checkin.apartment_id || "")]
  );
  
  const room = roomResult.rows[0] || {};
  
  // VERIFICAR SI ES LATE CHECKOUT
  if (hour > STANDARD_CHECKOUT_HOUR) {
    console.log(`🕐 Late checkout solicitado: ${parsedTime} (estándar: ${STANDARD_CHECKOUT_HOUR}:00)`);
    
    // Guardar hora y marcar como late checkout solicitado
    await pool.query(`
      UPDATE checkins 
      SET 
        departure_time = $1,
        late_checkout_requested = true,
        bot_state = 'WAITING_RULES'
      WHERE id = $2
    `, [parsedTime, checkin.id]);
    
    // Crear solicitud en early_late_requests
    const hoursDiff = hour - STANDARD_CHECKOUT_HOUR;
    await pool.query(`
      INSERT INTO early_late_requests 
        (checkin_id, request_type, requested_time, hours_difference, status, guest_phone, created_at)
      VALUES ($1, 'late_checkout', $2, $3, 'pending', $4, NOW())
    `, [checkin.id, parsedTime, hoursDiff, from]);
    
    console.log(`📝 Solicitud de late checkout creada (${hoursDiff}h después)`);
    
    // Enviar mensaje de late checkout
    let lateMsg = await getFlowMessage('LATE_CHECKOUT_NOTICE', language);
    if (lateMsg) {
      lateMsg = await replaceVariables(lateMsg, checkin, room);
      await sendWhatsAppMessage(from, lateMsg);
      console.log(`✅ Enviado mensaje LATE_CHECKOUT_NOTICE`);
    }
    
  } else {
    // HORARIO NORMAL - Continuar flujo
    console.log(`✅ Horario normal: ${parsedTime}`);
    
    await pool.query(`
      UPDATE checkins 
      SET 
        departure_time = $1,
        bot_state = 'WAITING_RULES'
      WHERE id = $2
    `, [parsedTime, checkin.id]);
    
    console.log(`💾 Hora de salida guardada: ${parsedTime}`);
  }
  
  // Esperar 1 segundo
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Enviar ASK_RULES (en ambos casos)
  let askRulesMsg = await getFlowMessage('ASK_RULES', language);
  if (askRulesMsg) {
    askRulesMsg = await replaceVariables(askRulesMsg, checkin, room);
    await sendWhatsAppMessage(from, askRulesMsg);
    console.log(`✅ Enviado mensaje ASK_RULES`);
  }
}
// ============ MANEJAR ACEPTACIÓN DE NORMAS ============
async function handleRulesAcceptance(from, checkin, body, language) {
  console.log(`📋 Procesando aceptación de normas: "${body}"`);
  
  // Validar si el usuario aceptó (en cualquier idioma)
  const accepted = /^(acepto|accept|accepte|принимаю|si|yes|oui|да)$/i.test(body.trim());
  
  if (accepted) {
    console.log(`✅ Usuario aceptó las normas`);
    
    // Obtener configuración del apartamento
    const roomResult = await pool.query(
      `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
       FROM beds24_rooms 
       WHERE beds24_room_id = $1 OR id::text = $1 
       LIMIT 1`,
      [String(checkin.apartment_id || "")]
    );
    
    const room = roomResult.rows[0] || {};
    
    // Guardar que aceptó y cambiar estado a DONE
    await pool.query(`
      UPDATE checkins 
      SET 
        bot_state = 'DONE'
      WHERE id = $1
    `, [checkin.id]);
    
    console.log(`💾 Estado cambiado a DONE`);
    
    // Esperar 1 segundo
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Enviar mensaje CONFIRMATION con las instrucciones
    let confirmMsg = await getFlowMessage('CONFIRMATION', language);
    if (confirmMsg) {
      confirmMsg = await replaceVariables(confirmMsg, checkin, room);
      await sendWhatsAppMessage(from, confirmMsg);
      console.log(`✅ Enviado mensaje CONFIRMATION`);
    }
    
    console.log(`🎉 FLUJO COMPLETADO para checkin ${checkin.id}`);
    
  } else {
    // Usuario NO aceptó o escribió algo incorrecto
    console.log(`⚠️ Usuario no aceptó las normas`);
    
    const retryMessages = {
      es: '⚠️ Para continuar, debes escribir: ACEPTO',
      en: '⚠️ To continue, you must write: ACCEPT',
      fr: '⚠️ Pour continuer, vous devez écrire: J\'ACCEPTE',
      ru: '⚠️ Чтобы продолжить, напишите: ПРИНИМАЮ'
    };
    
    const retryMsg = retryMessages[language] || retryMessages.es;
    await sendWhatsAppMessage(from, retryMsg);
    console.log(`✅ Enviado mensaje de reintento`);
  }
}
// ============ PARSEAR ENTRADA DE HORA ============

function parseTimeInput(input) {
  // Normalizar entrada (quitar espacios)
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '');
  
  // ✅ Formato 1: HHMM (4 dígitos) - ej: "1700", "2330", "0100"
  let match = normalized.match(/^(\d{4})$/);
  if (match) {
    const hour = parseInt(match[1].substring(0, 2));
    const minute = parseInt(match[1].substring(2, 4));
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    return null;
  }
  
  // ✅ Formato 2: HMM (3 dígitos) - ej: "900" → "09:00"
  match = normalized.match(/^(\d{3})$/);
  if (match) {
    const hour = parseInt(match[1].substring(0, 1));
    const minute = parseInt(match[1].substring(1, 3));
    if (hour >= 0 && hour <= 9 && minute >= 0 && minute <= 59) {
      return `0${hour}:${minute.toString().padStart(2, '0')}`;
    }
    return null;
  }
  
  // ✅ Formato 3: HH (2 dígitos) - ej: "17" → "17:00"
  match = normalized.match(/^(\d{2})$/);
  if (match) {
    const hour = parseInt(match[1]);
    if (hour >= 0 && hour <= 23) {
      return `${hour.toString().padStart(2, '0')}:00`;
    }
    return null;
  }
  
  // ✅ Formato 4: H (1 dígito) - ej: "5" → "05:00"
  match = normalized.match(/^(\d{1})$/);
  if (match) {
    const hour = parseInt(match[1]);
    if (hour >= 0 && hour <= 9) {
      return `0${hour}:00`;
    }
    return null;
  }
  
  // ✅ Formato 5: HH:MM o HH.MM - ej: "17:30", "17.30"
  match = normalized.match(/^(\d{1,2})[:\.h](\d{2})$/);
  if (match) {
    const hour = parseInt(match[1]);
    const minute = parseInt(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    return null;
  }
  
  // ✅ Formato 6: 12h con AM/PM - ej: "5pm", "5:30pm"
  match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match) {
    let hour = parseInt(match[1]);
    const minute = match[2] ? parseInt(match[2]) : 0;
    const meridiem = match[3];
    
    if (hour < 1 || hour > 12 || minute > 59) return null;
    
    // Convertir a formato 24h
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  }
  
  // No se reconoce el formato
  return null;
}

// ============ OBTENER MENSAJES DE ERROR ============

function getErrorMessage(errorType, language) {
  const messages = {
    INVALID_TIME: {
      es: '⚠️ Por favor, indica la hora en formato válido. Ejemplos: 17, 18:30, 5pm',
      en: '⚠️ Please provide the time in a valid format. Examples: 17, 18:30, 5pm',
      fr: '⚠️ Veuillez indiquer l\'heure dans un format valide. Exemples: 17, 18:30, 17h',
      ru: '⚠️ Пожалуйста, укажите время в правильном формате. Примеры: 17, 18:30'
    }
  };
  
  return messages[errorType]?.[language] || messages[errorType]?.es || 'Error';
}


// ============ OBTENER MENSAJE DEL FLUJO ============

async function getFlowMessage(messageType, language = 'es') {
  const validLangs = ['es', 'en', 'fr', 'ru'];
  const lang = validLangs.includes(language) ? language : 'es';
  
  try {
    const result = await pool.query(`
      SELECT * FROM whatsapp_flow_messages 
      WHERE message_key = $1
    `, [messageType]);
    
    if (result.rows.length > 0) {
      return result.rows[0][`content_${lang}`] || result.rows[0].content_es;
    }
    return null;
  } catch (error) {
    console.error('❌ Error obteniendo mensaje de flujo:', error);
    return null;
  }
}

// ============ ENVIAR MENSAJE DE WHATSAPP ============

async function sendWhatsAppMessage(to, message) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_NUMBER;
    
    if (!accountSid || !authToken || !fromNumber) {
      console.error('❌ Faltan credenciales de Twilio en variables de entorno');
      return;
    }
    
    const client = twilio(accountSid, authToken);
    
    const msg = await client.messages.create({
      from: fromNumber,
      to: to,
      body: message
    });
    
    console.log(`✅ WhatsApp enviado a ${to}: ${msg.sid}`);
    return msg;
    
  } catch (error) {
    console.error(`❌ Error enviando WhatsApp a ${to}:`, error.message);
    throw error;
  }
}

// ================================================================================
// FIN DEL CÓDIGO CON SESIONES
// ================================================================================

// ===================== START =====================
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => console.log("✅ running on port", PORT));
  } catch (e) {
    console.error("❌ DB init error:", e);
    process.exit(1);
  }
})();















































































































































































































































































































































































































































































































































































































































































































































































