// ====================================================
// RCS Guest Portal — Stable organized single-file version
// (same logic, only reorganized and labeled)
// ====================================================

// ===================== CONFIG ====================
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");


const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
async function beds24Get(endpoint, params = {}, propertyExternalId) {
  const accessToken = await getBeds24AccessToken(propertyExternalId);
  const url = new URL(`https://beds24.com/api/v2${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const resp = await fetch(url, {
    headers: {
      accept: "application/json",
      token: accessToken,  // header clave
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Beds24 ${endpoint} error ${resp.status}: ${text.slice(0,500)}`);
  }
  return resp.json();
}

// ============================================
// 🤖 AUTO-REPLY: Detectar keywords
// ============================================
async function checkAutoReply(message, apartmentId, lang = 'es') {
  try {
    const messageLower = message.toLowerCase().trim();
    console.log(`🔍 checkAutoReply: Buscando match para "${messageLower}" (lang: ${lang})`);
    
    // Buscar autorespuestas activas
    const result = await pool.query(`
      SELECT 
        id,
        keywords,
        response_es,
        response_en,
        response_fr,
        response_ru,
        priority
      FROM whatsapp_auto_replies
      WHERE active = true
      ORDER BY priority DESC
    `);

    console.log(`📊 Encontradas ${result.rows.length} autorespuestas activas`);

    // Buscar coincidencia con keywords
    for (const reply of result.rows) {
      let keywordsArray = [];
      
      // Convertir keywords a array limpio
      if (Array.isArray(reply.keywords)) {
        // Si ya es array de JavaScript
        keywordsArray = reply.keywords;
      } else if (typeof reply.keywords === 'string') {
        // Si es string con formato PostgreSQL: {wifi,password,internet}
        // O string con comas: wifi, password, internet
        
        let keywordsStr = reply.keywords;
        
        // Limpiar llaves de PostgreSQL array
        keywordsStr = keywordsStr.replace(/^\{/, '').replace(/\}$/, '');
        
        // Separar por comas
        keywordsArray = keywordsStr.split(',').map(k => k.trim());
      }
      
      console.log(`🔑 Reply ID ${reply.id}: keywords = [${keywordsArray.slice(0, 3).join(', ')}...]`);
      
      // Buscar coincidencia
      for (const keyword of keywordsArray) {
        if (keyword && messageLower.includes(keyword.toLowerCase())) {
          const langKey = `response_${lang}`;
          const response = reply[langKey] || reply.response_es;
          
          console.log(`✅ MATCH! keyword="${keyword}", reply_id=${reply.id}`);
          console.log(`📤 Enviando respuesta...`);
          
          return response;
        }
      }
    }

    console.log(`❌ No se encontró match para "${messageLower}"`);
    return null;
  } catch (error) {
    console.error('❌ Error checking auto-reply:', error);
    return null;
  }
}

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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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

    <label class="muted">Media URL</label>
    <input name="new_media_url" placeholder="https://..." style="width:100%;" />

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
function renderPage(title, innerHtml) {
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

  </style>
</head>
<body>
  <div class="page">
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
app.get("/manager", async (req, res) => {
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
    
    const html = `
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
// ===== EDIT APARTMENT SETTINGS PAGE =====

app.get("/manager/apartment", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).send("Missing id");
    
    const { rows } = await pool.query(
      `
      SELECT
        id,
        apartment_name,
        beds24_room_id,
        support_phone,
        default_arrival_time,
        default_departure_time,
        registration_url,
        payment_url,
        keys_instructions_url,
        show_in_staff
      FROM beds24_rooms
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    
    if (!rows.length) return res.status(404).send("Apartment not found");
    const a = rows[0];
    
    const roomId = String(a.beds24_room_id || "").trim();
    const beds24Name = a.apartment_name || "";
    const displayName = a.apartment_name || beds24Name || `Apartment #${a.id}`;
    
    const html = `
      <h1>Apartment Settings</h1>
      <p><a href="/manager">← Back to Manager</a></p>
      
      ${roomId
        ? `<a class="btn-link" href="/manager/apartment/sections?room_id=${encodeURIComponent(roomId)}">
             🪗 Manage guest accordion sections
           </a>`
        : `<span class="muted">⚠ Missing room_id for this apartment</span>`
      }
      
      <form method="POST" action="/manager/apartment">
        <input type="hidden" name="id" value="${a.id}" />
        
        <label>Apartment name</label><br/>
        <p class="muted" style="margin:4px 0 8px;">
          Room ID: <strong>${escapeHtml(roomId || 'N/A')}</strong>
          ${beds24Name ? ` · Beds24: <strong>${escapeHtml(beds24Name)}</strong>` : ''}
        </p>
        <input 
          name="apartment_name" 
          value="${escapeHtml(a.apartment_name || beds24Name || '')}"
          placeholder="Nombre del apartamento"
          style="width:100%; max-width:700px;" 
        />
        <p class="muted" style="margin:4px 0 12px;">Leave empty to use the Beds24 name automatically</p>
        
        <label>Support WhatsApp (human)</label><br/>
        <input
          name="support_phone"
          value="${escapeHtml(a?.support_phone || "")}"
          placeholder="+34 600 123 456"
          style="width:320px"
        />
        <br/><br/>
        
        <label>Default arrival time</label><br/>
        <input type="time" name="default_arrival_time" value="${escapeHtml(String(a.default_arrival_time || "").slice(0,5))}" />
        <br/><br/>
        
        <label>Default departure time</label><br/>
        <input type="time" name="default_departure_time" value="${escapeHtml(String(a.default_departure_time || "").slice(0,5))}" />
        <br/><br/>
        
        <!-- 🆕 CHECKBOX SHOW IN STAFF -->
        <div style="margin:16px 0; padding:12px; border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb;">
          <label style="display:flex; gap:12px; align-items:center; cursor:pointer;">
            <input 
              type="checkbox" 
              name="show_in_staff" 
              ${a.show_in_staff !== false ? 'checked' : ''}
              style="width:20px; height:20px;"
            />
            <div>
              <strong>👥 Mostrar en Staff Panel</strong>
              <p class="muted" style="margin:4px 0 0;">Si está activado, este apartamento aparecerá en el panel de llegadas/salidas del staff</p>
            </div>
          </label>
        </div>
        
        <label>Registration link</label><br/>
        <input name="registration_url" value="${escapeHtml(a.registration_url || "")}" style="width:100%; max-width:700px;" />
        <br/><br/>
        
        <label>Payment link</label><br/>
        <input name="payment_url" value="${escapeHtml(a.payment_url || "")}" style="width:100%; max-width:700px;" />
        <br/><br/>
        
        <label>Keys / Instructions link</label><br/>
        <input name="keys_instructions_url" value="${escapeHtml(a.keys_instructions_url || "")}" style="width:100%; max-width:700px;" />
        <br/><br/>
        
        <button type="submit">Save</button>
      </form>
    `;
    
    res.send(renderPage("Apartment Settings", html));
  } catch (e) {
    console.error("❌ /manager/apartment error:", e);
    res.status(500).send("Error");
  }
});

app.post("/manager/apartment", async (req, res) => {
  const {
    id,
    apartment_name,
    beds_room_id,
    support_phone,
    default_arrival_time,
    default_departure_time,
    registration_url,
    payment_url,
    keys_instructions_url,
    show_in_staff
  } = req.body;

  // El checkbox envía "on" si está marcado, undefined si no
  const showInStaff = show_in_staff === 'on';

  await pool.query(`
    UPDATE beds24_rooms
    SET
        apartment_name = $1,
        support_phone = $2,
        default_arrival_time = $3,
        default_departure_time = $4,
        registration_url = $5,
        payment_url = $6,
        keys_instructions_url = $7,
        show_in_staff = $8,
        updated_at = now()
      WHERE id = $9
    `,
    [
      apartment_name,
      support_phone,
      default_arrival_time,
      default_departure_time,
      registration_url,
      payment_url,
      keys_instructions_url,
      showInStaff,
      id
    ]
  );

  return res.redirect(`/manager/apartment?id=${id}`);
});

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

// RUTA 1: Ver solicitudes pendientes
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

// RUTA 2: Procesar aprobación/rechazo
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

    const payload = req.body || {};
    const booking = payload.booking || payload; // fallback

    if (!booking || !booking.id) {
      console.log("ℹ️ Beds24 webhook: no booking.id, ignored");
      return res.status(200).send("Ignored");
    }

    console.log("✅ Booking received:", booking.id);
    
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
        guest_language
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14,
        $15::jsonb,
        $16
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
        guest_language      = EXCLUDED.guest_language`,
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
        guestLanguage                         // $16 🌐 NUEVO
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

// --- Home ---
app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p class="muted">Example entry:</p>
    <p><a class="btn-primary" href="/booking/apt1/TESTTOKEN123">Open booking example</a></p>
    <p class="muted">Admin: <a class="btn-link" href="/ckins">/ckins</a></p>
  `;
  res.send(renderPage("Home", html));
});

// --- Booking page ---
// ✅ RUTAS CORREGIDAS - Solo con bookingId
// ✅ RUTAS SIMPLES - Solo con token
app.get("/booking/:token", async (req, res) => {
  const { token } = req.params;
  
  // Buscar la reserva por token
  const result = await pool.query(
    'SELECT * FROM checkins WHERE booking_token = $1',
    [token]
  );
  
  if (result.rows.length === 0) {
    return res.status(404).send("Booking not found");
  }
  
  const booking = result.rows[0];
  
  const html = `
    <h1>Booking ${token}</h1>
    <p>Apartment: <strong>${booking.apartment_name || 'N/A'}</strong></p>
    <p><a href="/checkin/${token}" class="btn-primary">Go to check-in</a></p>
    <p><a href="/" class="btn-link">← Back</a></p>
  `;
  res.send(renderPage("Booking " + token, html));
});

app.get("/checkin/:token", async (req, res) => {
  const { token } = req.params;
  
  const result = await pool.query(
    'SELECT * FROM checkins WHERE booking_token = $1',
    [token]
  );
  
  if (result.rows.length === 0) {
    return res.status(404).send("Booking not found");
  }
  
  const now = new Date();
  const today = ymd(now);
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  const tomorrow = ymd(tmr);
  
  const html = `
    <h1>Check-in • ${token}</h1>
    <form method="POST" action="/checkin/${token}">
      <div style="margin-bottom:12px;">
        <label>Full name</label>
        <input name="fullName" required />
      </div>
      <div style="margin-bottom:12px;">
        <label>Email</label>
        <input type="email" name="email" required />
      </div>
      <div style="margin-bottom:12px;">
        <label>Phone (WhatsApp)</label>
        <input name="phone" required />
      </div>
      <div class="row" style="margin-bottom:12px;">
        <div>
          <label>Arrival date</label>
          <input type="date" name="arrivalDate" required value="${today}" min="${today}" />
        </div>
        <div>
          <label>Arrival time</label>
          <select name="arrivalTime" required>
            ${hourOptions("17:00")}
          </select>
        </div>
      </div>
      <div class="row" style="margin-bottom:12px;">
        <div>
          <label>Departure date</label>
          <input type="date" name="departureDate" required value="${tomorrow}" min="${today}" />
        </div>
        <div>
          <label>Departure time</label>
          <select name="departureTime" required>
            ${hourOptions("11:00")}
          </select>
        </div>
      </div>
      <button type="submit" class="btn-primary">Submit</button>
    </form>
    <p style="margin-top:16px;"><a href="/booking/${token}" class="btn-link">← Back</a></p>
  `;
  res.send(renderPage("Check-in", html));
});

app.post("/checkin/:token", async (req, res) => {
  const { token } = req.params;
  
  try {
    await pool.query(
      `UPDATE checkins 
       SET full_name = $1, email = $2, phone = $3,
           arrival_date = $4, arrival_time = $5, 
           departure_date = $6, departure_time = $7
       WHERE booking_token = $8`,
      [
        req.body.fullName,
        req.body.email,
        req.body.phone,
        req.body.arrivalDate,
        req.body.arrivalTime || "16:00",
        req.body.departureDate,
        req.body.departureTime || "11:00",
        token
      ]
    );
    
    return res.redirect(`/guest/${token}`);
  } catch (e) {
    console.error("DB update error:", e);
    res.status(500).send("❌ DB error while saving check-in");
  }
});

/* app.get("/guest/:token", async (req, res) => {
  const { token } = req.params;
  
  const result = await pool.query(
    'SELECT * FROM checkins WHERE booking_token = $1',
    [token]
  );
  
  if (result.rows.length === 0) {
    return res.status(404).send("Booking not found");
  }
  
  const booking = result.rows[0];

}); */

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
    
    // Usar room_id si existe, si no usar el de beds24_rooms
    const roomIdToUse = r.room_id || r.room_id_from_rooms;
    
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
        reservation: 'Reserva',
        arrival: 'Llegada',
        departure: 'Salida',
        guests: 'Huéspedes',
        adults: 'adultos',
        children: 'niños',
        people: 'personas',
        accessCode: 'Código de acceso',
        showCode: 'Mostrar código',
        noShareCode: 'No compartas este código con terceros.',
        apartmentInfo: 'Información del apartamento',
        noInfo: 'Todavía no hay información para este apartamento.',
      },
      en: {
        welcome: 'Welcome',
        reservation: 'Reservation',
        arrival: 'Arrival',
        departure: 'Departure',
        guests: 'Guests',
        adults: 'adults',
        children: 'children',
        people: 'people',
        accessCode: 'Access code',
        showCode: 'Show code',
        noShareCode: 'Do not share this code with third parties.',
        apartmentInfo: 'Apartment information',
        noInfo: 'No information available yet for this apartment.',
      },
      ru: {
        welcome: 'Добро пожаловать',
        reservation: 'Бронирование',
        arrival: 'Прибытие',
        departure: 'Отъезд',
        guests: 'Гости',
        adults: 'взрослых',
        children: 'детей',
        people: 'человек',
        accessCode: 'Код доступа',
        showCode: 'Показать код',
        noShareCode: 'Не делитесь этим кодом с третьими лицами.',
        apartmentInfo: 'Информация о квартире',
        noInfo: 'Информация для этой квартиры пока недоступна.',
      },
      fr: {
        welcome: 'Bienvenue',
        reservation: 'Réservation',
        arrival: 'Arrivée',
        departure: 'Départ',
        guests: 'Invités',
        adults: 'adultes',
        children: 'enfants',
        people: 'personnes',
        accessCode: "Code d'accès",
        showCode: 'Afficher le code',
        noShareCode: 'Ne partagez pas ce code avec des tiers.',
        apartmentInfo: "Informations sur l'appartement",
        noInfo: "Aucune information disponible pour cet appartement pour le moment.",
      },
      de: {
        welcome: 'Willkommen',
        reservation: 'Reservierung',
        arrival: 'Ankunft',
        departure: 'Abreise',
        guests: 'Gäste',
        adults: 'Erwachsene',
        children: 'Kinder',
        people: 'Personen',
        accessCode: 'Zugangscode',
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
      
      // Patrones de YouTube
      const patterns = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
        /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/
      ];
      
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          return `https://www.youtube.com/embed/${match[1]}`;
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
                 const embedUrl = getYouTubeEmbedUrl(mediaUrl);
                 if (embedUrl) {
                   mediaHtml = `
                     <div style="margin-top:16px;">
                       <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;background:#000;border-radius:8px;">
                         <iframe 
                           src="${escapeHtml(embedUrl)}" 
                           style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
                           allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                           allowfullscreen>
                         </iframe>
                       </div>
                     </div>
                   `;
                 }
               } else if (s.new_media_type === 'image') {
                 mediaHtml = `
                   <div style="margin-top:16px;">
                     <img 
                       src="${escapeHtml(mediaUrl)}" 
                       alt="${escapeHtml(translatedTitle)}"
                       style="max-width:100%;height:auto;border-radius:8px;display:block;"
                       loading="lazy"
                     />
                   </div>
                 `;
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
      <div style="text-align:right; margin-bottom:16px;">
        <select onchange="window.location.href = window.location.pathname + '?lang=' + this.value" 
                style="padding:8px 12px; border-radius:8px; border:1px solid #d1d5db; background:#fff; font-size:20px; cursor:pointer; width:100px;">
          <option value="es" ${currentLang === 'es' ? 'selected' : ''}>🇪🇸</option>
          <option value="en" ${currentLang === 'en' ? 'selected' : ''}>🇬🇧</option>
          <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>🇫🇷</option>
          <option value="de" ${currentLang === 'de' ? 'selected' : ''}>🇩🇪</option>
          <option value="ru" ${currentLang === 'ru' ? 'selected' : ''}>🇷🇺</option>
        </select>
      </div>
      
      <div class="card">
        <div style="text-align:center; margin-bottom:30px;">
          <h1 style="margin-bottom:8px; font-size:28px;">${t.welcome}</h1>
          <div style="font-size:18px; color:#6b7280;">${escapeHtml(apartmentName)}</div>
          <div style="font-size:13px; color:#9ca3af; margin-top:8px;">${t.reservation}: ${escapeHtml(String(r.beds24_booking_id || ""))}</div>
        </div>
        
        <div style="border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:16px;">
            <div style="flex:1; min-width:140px;">
              <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.arrival}</div>
              <div style="font-size:16px; font-weight:600;">${fmtDate(r.arrival_date)}</div>
              ${r.arrival_time ? `<div style="color:#6b7280; font-size:14px;">${fmtTime(r.arrival_time)}</div>` : ''}
            </div>
            <div style="width:1px; background:#e5e7eb;"></div>
            <div style="flex:1; min-width:140px;">
              <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.departure}</div>
              <div style="font-size:16px; font-weight:600;">${fmtDate(r.departure_date)}</div>
              ${r.departure_time ? `<div style="color:#6b7280; font-size:14px;">${fmtTime(r.departure_time)}</div>` : ''}
            </div>
          </div>
          
          <div style="border-top:1px solid #e5e7eb; padding-top:16px;">
            <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:4px;">${t.guests}</div>
            <div style="font-size:16px;"><span style="font-weight:600;">${totalGuests}</span> ${t.people} <span style="color:#9ca3af;">•</span> ${Number(r.adults) || 0} ${t.adults}, ${Number(r.children) || 0} ${t.children}</div>
          </div>
        </div>
        
        ${r.lock_visible && r.lock_code ? `
          <div style="border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:20px; background:#f9fafb;">
            <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#9ca3af; margin-bottom:8px;">
              🔑 ${t.accessCode}
            </div>
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
              <span id="lockCodeMasked" style="font-size:22px; letter-spacing:3px; color:#374151; font-family:monospace;">••••</span>
              <span id="lockCodeValue" style="display:none; font-size:28px; font-weight:700; letter-spacing:3px; color:#374151; font-family:monospace;">
                ${escapeHtml(String(r.lock_code))}
              </span>
              <button type="button" onclick="toggleLockCode()"
                style="display:inline-block; padding:10px 16px; background:#3b82f6; color:white; border:0; border-radius:8px; font-weight:600; cursor:pointer;">
                ${t.showCode}
              </button>
            </div>
            <p style="margin:10px 0 0; color:#6b7280; font-size:13px;">${t.noShareCode}</p>
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
    
    return res.send(renderPage("Panel del huésped", html));
    
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




// ===================== STAFF: CHECKINS LIST (FIXED) =====================
app.get("/staff/checkins", async (req, res) => {
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
    c.late_checkout_requested  
  FROM checkins c
  LEFT JOIN beds24_rooms br ON br.beds24_room_id::text = c.apartment_id::text  -- ✅ AÑADIR ESTA LÍNEA
  WHERE c.cancelled = false
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
    
    // ✅ NUEVO - Determinar bookingId y URL del guest panel
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
  <tr class="${earlyLateClass}">
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
        
        <!-- 7. Código -->
        <td>
          <form method="POST" action="/staff/checkins/${r.id}/lock" class="lock-form">
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}" />
            
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
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}" />

            <span class="pill ${r.lock_code_visible ? "pill-yes" : "pill-no"}">
              ${r.lock_code_visible ? "Sí" : "No"}
            </span>

            <button type="submit" class="btn-small ${r.lock_code_visible ? "btn-ghost" : ""}">
              ${r.lock_code_visible ? "Ocultar" : "Mostrar"}
            </button>
          </form>
        </td>
        
        <!-- 9. Acciones -->
        <td>
          <form method="POST" action="/staff/checkins/${r.id}/delete"
                onsubmit="return confirm('¿Seguro que quieres borrar esta reserva?');">
            <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}" />
            <button type="submit" class="btn-small danger">Borrar</button>
          </form>
        </td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="9" class="muted">No hay registros</td></tr>`;

  return `
    <h2 style="margin:24px 0 12px;">${title}</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sticky-col">Limpieza</th>
            <th>ID</th>
            <th>Portal</th>
            <th>${dateColTitle}</th>
            <th>Noches</th>
            <th>A|C</th>
            <th>Apartamento</th>
            <th>Código</th>
            <th>Visible</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  `;
}

    const pageHtml = toolbar + renderTable(arrivals, "arrivals") + `<div style="height:24px;"></div>` + renderTable(departures, "departures");

    res.send(renderPage("Staff · Llegadas y Salidas", pageHtml));
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
// ===================== ADMIN: SET VISIBILITY =====================
app.post("/staff/checkins/:id/lock", async (req, res) => {
  try {
    const checkinId = req.params.id;
    const { lock_code, clear } = req.body;

    if (clear === "1") {
      // Clear lock code
      await pool.query(
        `
        UPDATE checkins
        SET lock_code = NULL, lock_visible = false
        WHERE id = $1
        `,
        [checkinId]
      );
    } else {
      // Update lock code
      await pool.query(
        `
        UPDATE checkins
        SET lock_code = $1
        WHERE id = $2
        `,
        [lock_code || null, checkinId]
      );
    }

    return safeRedirect(res, req.body.returnTo || req.headers.referer);
  } catch (e) {
    console.error("Error saving lock code:", e);
    return res.status(500).send("Error saving lock code");
  }
});
// ===================== ADMIN: VISIBILITY TOGGLE =====================
app.post("/staff/checkins/:id/visibility", async (req, res) => {
  try {
    const checkinId = req.params.id;

    await pool.query(
      `
      UPDATE checkins
      SET lock_visible = NOT COALESCE(lock_visible, false)
      WHERE id = $1
      `,
      [checkinId]
    );

    return safeRedirect(res, req.body.returnTo || req.headers.referer);
  } catch (e) {
    console.error("Error toggling visibility:", e);
    return res.status(500).send("Error updating visibility");
  }
});
// ========== DEEPL TRANSLATION API ==========
async function translateText(text, targetLang) {
  const apiKey = process.env.DEEPL_API_KEY;
  
  if (!apiKey) {
    throw new Error('DEEPL_API_KEY not configured');
  }

  const response = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: [text],
      target_lang: targetLang.toUpperCase(),
      source_lang: 'ES',
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepL API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.translations[0].text;
}

// API endpoint para traducir desde el frontend
app.post("/api/translate", async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    
    if (!text || !targetLang) {
      return res.status(400).json({ error: 'Missing text or targetLang' });
    }

    const translated = await translateText(text, targetLang);
    
    res.json({ translated });
  } catch (e) {
    console.error('❌ Translation error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ===================== MANAGER SETTINGS =====================

app.post("/staff/checkins/:id/clean", async (req, res) => {
  try {
    const checkinId = req.params.id;

    await pool.query(
      `
      UPDATE checkins
      SET clean_ok = NOT COALESCE(clean_ok, false)
      WHERE id = $1
      `,
      [checkinId]
    );

    return safeRedirect(res, req.body.returnTo || req.headers.referer);
  } catch (e) {
    console.error("Error toggling clean status:", e);
    return res.status(500).send("Error updating clean status");
  }
});

// ===================== ADMIN: DELETE CHECKIN =====================
app.post("/staff/checkins/:id/delete", async (req, res) => {
  try {
    const checkinId = req.params.id;

    await pool.query(
      `
      DELETE FROM checkins
      WHERE id = $1
      `,
      [checkinId]
    );

    return safeRedirect(res, req.body.returnTo || req.headers.referer);
  } catch (e) {
    console.error("Error deleting checkin:", e);
    return res.status(500).send("Error deleting checkin");
  }
});
// ===================== MANAGER: Sync Bookings manual =====================
app.get("/manager/channels/bookingssync", async (req, res) => {
  try {
    const propertyIdForToken = "203178";
    const token = await getBeds24AccessToken(propertyIdForToken);
    
    const fromDate = String(req.query.from || "2000-01-01");
    const toDate = String(req.query.to || "2027-12-31");
    const includeCancelled = String(req.query.includeCancelled || "true");
    
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
      
    if (!propIds.length) {
      return res.send(renderPage("Sync Bookings", `
        <div class="card">
          <h1 style="margin:0 0 10px;">ℹ️ No properties found</h1>
          <p>Could not load properties from API.</p>
          <p><a class="btn-link" href="/manager">← Volver</a></p>
        </div>
      `));
    }
    
    const roomsMap = new Map();
    for (const prop of properties) {
      const roomTypes = prop.roomTypes || [];
      console.log(`Property ${prop.id}: found ${roomTypes.length} roomTypes`);
      
      for (const room of roomTypes) {
        const roomId = String(room.id || room.roomId || "");
        const roomName = room.name || room.roomName || "";
        if (roomId && roomName) {
          roomsMap.set(roomId, roomName);
          console.log(`  ✓ Mapped roomId "${roomId}" -> "${roomName}"`);
        }
      }
    }
    
    console.log(`=== TOTAL: Loaded ${roomsMap.size} room names from ${properties.length} properties ===`);
    console.log('All roomIds in map:', Array.from(roomsMap.keys()));
    
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const propId of propIds) {
      const url =
        `https://beds24.com/api/v2/bookings` +
        `?propertyId=${encodeURIComponent(propId)}` +
        `&includeInvoiceItems=true`;
      
      const bookingsResp = await fetch(url, {
        headers: { accept: "application/json", token },
      });
      
      if (!bookingsResp.ok) {
        const text = await bookingsResp.text();
        console.error(`Beds24 bookings error for propId=${propId}:`, text.slice(0, 300));
        errors++;
        continue;
      }
      
      const data = await bookingsResp.json();
      const bookings = Array.isArray(data) ? data : (data.bookings || data.data || []);
      
      for (const b of bookings) {
        const arrival = new Date(b.arrival || b.arrivalDate);
        const departure = new Date(b.departure || b.departureDate);
        const from = new Date(fromDate);
        const to = new Date(toDate);
        
        if (arrival < from || arrival > to) {
          continue;
        }
        
        if (includeCancelled === "false" && 
            (b.status === "cancelled" || b.status === "canceled")) {
          continue;
        }
        
        const roomId = String(b.roomId || "");
        const realRoomName = roomsMap.get(roomId) || "";
        
        console.log(`Booking ${b.id}: roomId="${roomId}" (type: ${typeof roomId}), found name="${realRoomName}"`);
        
        const row = mapBeds24BookingToRow(b, realRoomName, roomId);
        console.log(`  -> row.room_name="${row.room_name}"`);
        
        const result = await upsertCheckinFromBeds24(row);
        processed++;
        if (result?.skipped) skipped++;
        else if (result?.inserted) inserted++;
        else if (result?.updated) updated++;
        else if (result?.ok) inserted++;
      }
    }
    
    return res.send(renderPage("Sync Bookings", `
      <div class="card">
        <h1 style="margin:0 0 10px;">✅ Sincronización completada</h1>
        <p>Properties: <strong>${propIds.length}</strong> · Rooms: <strong>${roomsMap.size}</strong> · Errors: <strong>${errors}</strong></p>
        <p>Reservas procesadas: <strong>${processed}</strong></p>
        <p>Nuevas: <strong>${inserted}</strong> · Actualizadas: <strong>${updated}</strong> · Omitidas: <strong>${skipped}</strong></p>
        <p class="muted">Rango: ${escapeHtml(fromDate)} — ${escapeHtml(toDate)} · Canceladas: ${escapeHtml(includeCancelled)}</p>
        <hr/>
        <p><a class="btn-primary" href="/staff/checkins">Ver staff check-ins</a></p>
        <p><a class="btn-link" href="/manager">← Volver al manager</a></p>
      </div>
    `));
  } catch (e) {
    console.error("Sync error:", e);
    return res.status(500).send(renderPage("Error Sync", `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error en sincronización</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a class="btn-link" href="/manager">← Volver</a></p>
      </div>
    `));
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
app.get("/manager/whatsapp", (req, res) => {
  res.sendFile(require('path').join(__dirname, 'manager-whatsapp.html'));
});

// API: Obtener mensajes del flujo principal (START, REGOK, PAYOK)
app.get("/api/whatsapp/flow-messages", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT message_key, content_es, content_en, content_fr, content_ru, active
      FROM whatsapp_flow_messages
      WHERE message_key IN ('START', 'REGOK', 'PAYOK', 'ASK_ARRIVAL', 'ASK_DEPARTURE', 'ASK_RULES', 'CONFIRMATION', 'EARLY_CHECKIN_NOTICE', 'LATE_CHECKOUT_NOTICE')
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



// =============== MANAGER: WhatsApp Bot Configuration ===============
app.get("/manager/whatsapp", (req, res) => {
  res.sendFile(require('path').join(__dirname, 'manager-whatsapp.html'));
});

app.post("/api/whatsapp/flow-messages", async (req, res) => {
  const { messages } = req.body;
  
  try {
    console.log('📝 Guardando mensajes:', messages);
    
    for (const msg of messages) {
      await pool.query(`
        INSERT INTO whatsapp_flow_messages 
          (message_key, content_es, content_en, content_fr, content_ru, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
      
      console.log(`✅ Guardado ${msg.message_key}`);
    }
    
    console.log('✅ Todos los mensajes guardados');
    res.json({
      success: true,
      message: 'Messages updated successfully'
    });
  } catch (error) {
    console.error('❌ Error saving flow messages:', error);
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
        created_at,
        updated_at
      FROM whatsapp_auto_replies
      ORDER BY priority DESC, category ASC
    `);

    res.json({
      success: true,
      replies: result.rows
    });
  } catch (error) {
    console.error('Error fetching auto-replies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/whatsapp/auto-replies", async (req, res) => {
  try {
    const {
      category,
      keywords,
      response_es,
      response_en,
      response_fr,
      response_ru,
      active,
      priority
    } = req.body;

    console.log('📥 Recibiendo nueva autorespuesta:', { keywords });

    // ✅ Convertir keywords correctamente
    let keywordsText = '';
    
    if (Array.isArray(keywords)) {
      // Si es array, unir con comas SIN espacios extra
      keywordsText = keywords.filter(k => k && k.trim()).join(',');
    } else if (typeof keywords === 'string') {
      // Si es string, limpiar espacios
      keywordsText = keywords.trim();
    }

    console.log('💾 Keywords a guardar:', keywordsText);

    const result = await pool.query(`
      INSERT INTO whatsapp_auto_replies
        (category, keywords, response_es, response_en, response_fr, response_ru, active, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      category || 'custom',
      keywordsText,
      response_es,
      response_en || response_es,
      response_fr || response_es,
      response_ru || response_es,
      active !== false,
      priority || 0
    ]);

    console.log('✅ Guardado con keywords:', result.rows[0].keywords);

    res.json({
      success: true,
      reply: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Error creating auto-reply:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.put("/api/whatsapp/auto-replies/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category,
      keywords,
      response_es,
      response_en,
      response_fr,
      response_ru,
      active,
      priority
    } = req.body;

    const result = await pool.query(`
      UPDATE whatsapp_auto_replies
      SET
        category = $1,
        keywords = $2,
        response_es = $3,
        response_en = $4,
        response_fr = $5,
        response_ru = $6,
        active = $7,
        priority = $8,
        updated_at = NOW()
      WHERE id = $9
      RETURNING *
    `, [
      category,
      keywords,
      response_es,
      response_en,
      response_fr,
      response_ru,
      active,
      priority || 0,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Auto-reply not found'
      });
    }

    res.json({
      success: true,
      reply: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating auto-reply:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
    
    // ========== PRIORIDAD 3: RESPUESTAS AUTOMÁTICAS (FAQ) ==========
    
    const autoReply = await findAutoReply(bodyLower, language);
    if (autoReply) {
      console.log(`🤖 Enviando respuesta automática (FAQ)`);
      await sendWhatsAppMessage(from, autoReply);
      return;
    }
    
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
        checkin.apartment_id, 
        language || 'es'
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
    
    // Enviar mensaje de bienvenida START
    await sendStartMessage(from, checkin, language);
    
  } catch (error) {
    console.error('❌ Error en handleStartCommand:', error);
  }
}
// ============ REEMPLAZAR VARIABLES EN MENSAJES ============

function replaceVariables(message, checkin, room) {
  if (!message) return message;
  
  // Preparar datos
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
  
  // Solo horas (sin minutos)
  const arriveTime = (checkin.arrival_time ? String(checkin.arrival_time).slice(0, 2) : "") || 
                     String(room.default_arrival_time || "").slice(0, 2) || "17";
  const departTime = (checkin.departure_time ? String(checkin.departure_time).slice(0, 2) : "") || 
                     String(room.default_departure_time || "").slice(0, 2) || "11";
  
  const adults = Number(checkin.adults || 0);
  const children = Number(checkin.children || 0);
  
  // Construir texto de huéspedes
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
  
  // Reemplazar todas las variables
  return message
    .replace(/\{booking_id\}/g, bookIdForLinks)           // ← AÑADIR ESTA LÍNEA
    .replace(/\[BOOKID\]/g, bookIdForLinks)               // ← AÑADIR ESTA LÍNEA
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
}

// ============ ENVIAR MENSAJE START ============

async function sendStartMessage(from, checkin, language) {
  try {
    // Obtener configuración del apartamento
    const roomResult = await pool.query(
      `SELECT registration_url, payment_url, default_arrival_time, default_departure_time 
       FROM beds24_rooms 
       WHERE beds24_room_id = $1 OR id::text = $1 
       LIMIT 1`,
      [String(checkin.apartment_id || "")]
    );
    
    const room = roomResult.rows[0] || {};
    
    // Obtener mensaje START personalizado de la DB
    const startMsg = await getFlowMessage('START', language);
    
    // Textos por defecto si no hay mensaje en DB
    const translations = {
      es: {
        greeting: "¡Hola",
        confirmed: "Tu reserva está confirmada ✅",
        apartment: "🏠 Apartamento",
        checkin: "📅 Entrada",
        checkout: "📅 Salida",
        guests: "👥 Huéspedes",
        adults: "adultos",
        children: "niños",
        instructions: "PASO 1\n📝 El registro es obligatorio para todos los huéspedes.\n🔗 Puedes compartir este enlace para que cada huésped se registre:",
        afterReg: "Cuando termines, escribe: REGOK"
      },
      en: {
        greeting: "Hello",
        confirmed: "Your booking is confirmed ✅",
        apartment: "🏠 Apartment",
        checkin: "📅 Check-in",
        checkout: "📅 Check-out",
        guests: "👥 Guests",
        adults: "adults",
        children: "children",
        instructions: "STEP 1\n📝 Registration is mandatory for all guests.\n🔗 You can share this link for each guest to register:",
        afterReg: "When done, write: REGOK"
      },
      fr: {
        greeting: "Bonjour",
        confirmed: "Votre réservation est confirmée ✅",
        apartment: "🏠 Appartement",
        checkin: "📅 Arrivée",
        checkout: "📅 Départ",
        guests: "👥 Invités",
        adults: "adultes",
        children: "enfants",
        instructions: "ÉTAPE 1\n📝 L'enregistrement est obligatoire pour tous les invités.\n🔗 Vous pouvez partager ce lien pour que chaque invité s'enregistre:",
        afterReg: "Quand c'est fait, écrivez: REGOK"
      },
      ru: {
        greeting: "Здравствуйте",
        confirmed: "Ваше бронирование подтверждено ✅",
        apartment: "🏠 Апартамент",
        checkin: "📅 Заезд",
        checkout: "📅 Выезд",
        guests: "👥 Гости",
        adults: "взрослых",
        children: "детей",
        instructions: "ШАГ 1\n📝 Регистрация обязательна для всех гостей.\n🔗 Вы можете поделиться этой ссылкой для регистрации каждого гостя:",
        afterReg: "Когда закончите, напишите: REGOK"
      }
    };
    
    //  Si hay mensaje personalizado en DB, reemplazar variables
    let finalMessage;
    
    if (startMsg) {
      // Usar mensaje de la DB y reemplazar variables
      finalMessage = replaceVariables(startMsg, checkin, room);
    } else {
      // Usar mensaje por defecto (fallback)
      const t = translations[language] || translations.es;
      
      const bookIdForLinks = String(
        checkin.beds24_booking_id || 
        checkin.booking_id_from_start || 
        checkin.booking_token || ""
      ).replace(/\s/g, '');
      
      const regLink = (room.registration_url || "").replace(/\[BOOKID\]/g, bookIdForLinks);
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
      const guestsText = adults || children ? 
        `${adults} ${t.adults}${children ? `, ${children} ${t.children}` : ""}` : "—";
      
      finalMessage = `${t.greeting}, ${name} 👋

${t.confirmed}

${t.apartment}: ${apt}
${t.checkin}: ${arriveDate}, ${arriveTime}h
${t.checkout}: ${departDate}, ${departTime}h
${t.guests}: ${guestsText}

${t.instructions}
${regLink || "—"}

${t.afterReg}`;
    }
    
    await sendWhatsAppMessage(from, finalMessage);
    console.log(`✅ Mensaje START enviado`);
    
  } catch (error) {
    console.error('❌ Error en sendStartMessage:', error);
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
    msg = replaceVariables(msg, checkin, room);
    
    await sendWhatsAppMessage(from, msg);
    console.log(`✅ Enviado mensaje REGOK con variables reemplazadas`);
    
    // Actualizar estado
    await pool.query(`
      UPDATE checkins 
      SET bot_state = 'WAITING_PAYOK' 
      WHERE id = $1
    `, [checkin.id]);
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
    payokMsg = replaceVariables(payokMsg, checkin, room);
    await sendWhatsAppMessage(from, payokMsg);
    console.log(`✅ Enviado mensaje PAYOK`);
    
    // 2. Esperar 2 segundos
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 3. Enviar ASK_ARRIVAL automáticamente
    let askArrivalMsg = await getFlowMessage('ASK_ARRIVAL', language);
    if (askArrivalMsg) {
      askArrivalMsg = replaceVariables(askArrivalMsg, checkin, room);
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
      earlyMsg = replaceVariables(earlyMsg, checkin, room);
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
    askDepartureMsg = replaceVariables(askDepartureMsg, checkin, room);
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
      lateMsg = replaceVariables(lateMsg, checkin, room);
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
    askRulesMsg = replaceVariables(askRulesMsg, checkin, room);
    await sendWhatsAppMessage(from, askRulesMsg);
    console.log(`✅ Enviado mensaje ASK_RULES`);
  }
}
// ============ MANEJAR ACEPTACIÓN DE NORMAS ============
async function handleRulesAcceptance(from, checkin, body, language) {
  console.log(`📋 Procesando aceptación de normas: "${body}"`);
  
  // Validar si el usuario aceptó (en cualquier idioma)
  const accepted = /^(acepto|accept|j'accepte|принимаю|si|yes|oui|да)$/i.test(body.trim());
  
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
      confirmMsg = replaceVariables(confirmMsg, checkin, room);
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
  // Normalizar entrada
  const normalized = input.trim().toLowerCase();
  
  // Formato 1: Solo número (17, 23)
  let match = normalized.match(/^(\d{1,2})$/);
  if (match) {
    const hour = parseInt(match[1]);
    if (hour >= 0 && hour <= 23) {
      return `${hour.toString().padStart(2, '0')}:00`;
    }
    return null;
  }
  
  // Formato 2: HH:MM o HH.MM o HHhMM
  match = normalized.match(/^(\d{1,2})[:\.h](\d{2})$/);
  if (match) {
    const hour = parseInt(match[1]);
    const minute = parseInt(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    return null;
  }
  
  // Formato 3: 12h con AM/PM (5pm, 5:30pm)
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

// ============ BUSCAR RESPUESTA AUTOMÁTICA (FAQ) ============

async function findAutoReply(text, language = 'es') {
  const validLangs = ['es', 'en', 'fr', 'ru'];
  const lang = validLangs.includes(language) ? language : 'es';
  
  try {
    // Obtener todas las respuestas activas
    const result = await pool.query(`
      SELECT * FROM whatsapp_auto_replies 
      WHERE active = true
    `);
    
    const textLower = text.toLowerCase().trim();
    
    // Buscar coincidencia con keywords
    for (const reply of result.rows) {
      if (!reply.keywords) continue;
      
      const keywords = reply.keywords.split(',').map(k => k.trim().toLowerCase());
      
      for (const keyword of keywords) {
        // Coincidencia exacta de palabra completa
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(textLower)) {
          // Retornar respuesta en el idioma correcto
          const response = reply[`response_${lang}`] || reply.response_es;
          console.log(`🎯 Keyword encontrada: "${keyword}" → Respuesta FAQ`);
          return response;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error buscando auto-reply:', error);
    return null;
  }
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


































































































































































































































































































































































































































































































































































































































