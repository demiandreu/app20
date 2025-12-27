// ====================================================
// RCS Guest Portal — Stable organized single-file version
// (same logic, only reorganized and labeled)
// =====================================================

// ===================== CONFIG =====================
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
  await pool.query(
    `ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_visible BOOLEAN NOT NULL DEFAULT FALSE;`
  );

  // --- clean status ---
  await pool.query(
    `ALTER TABLE checkins ADD COLUMN IF NOT EXISTS clean_ok BOOLEAN NOT NULL DEFAULT FALSE;`
  );

  // --- Beds24 fields for admin columns ---
  await pool.query(`
    ALTER TABLE checkins
      ADD COLUMN IF NOT EXISTS beds24_booking_id BIGINT,
      ADD COLUMN IF NOT EXISTS beds24_room_id TEXT,
      ADD COLUMN IF NOT EXISTS apartment_name TEXT,
      ADD COLUMN IF NOT EXISTS booking_id TEXT,
      ADD COLUMN IF NOT EXISTS beds24_raw JSONB;
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkins_booking_id ON checkins(booking_id);`
  );

  console.log("✅ DB ready: checkins table ok (+ lock_code, lock_visible, clean_ok)");
}

   //vremenno
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

    const secRes = await pool.query(
      `
      SELECT id, title, body, sort_order, is_active, new_media_type, new_media_url
      FROM apartment_sections
      WHERE room_id::text = $1
      ORDER BY sort_order ASC, id ASC
      `,
      [roomId]
    );

    const rowsHtml = secRes.rows
      .map((s) => {
        const checked = s.is_active ? "checked" : "";
        return `
          <tr>
            <td style="width:90px;">
              <input name="sort_order_${s.id}" value="${Number(s.sort_order) || 0}" style="width:70px; box-sizing:border-box;" />
            </td>
            <td style="width:180px;">
              <label style="display:flex; gap:8px; align-items:center;">
                <input type="checkbox" name="is_active_${s.id}" ${checked}/>
                Active
              </label>
              <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap;">
                <button class="btn-mini" type="submit" name="move" value="up:${s.id}">↑</button>
                <button class="btn-mini" type="submit" name="move" value="down:${s.id}">↓</button>
                <button class="btn-mini danger" type="submit" name="delete" value="${s.id}">Delete</button>
              </div>
            </td>
            <td class="td-text">
              <input name="title_${s.id}" value="${escapeHtml(s.title || "")}" class="sec-title" placeholder="(optional title)" />
              <textarea name="body_${s.id}" rows="5" class="sec-body" placeholder="Text...">${escapeHtml(s.body || "")}</textarea>

              <div style="margin-top:10px; display:grid; gap:6px;">
                <label class="muted">Media type</label>
                <select name="new_media_type_${s.id}">
                  <option value="none" ${String(s.new_media_type || "none") === "none" ? "selected" : ""}>None</option>
                  <option value="image" ${String(s.new_media_type || "") === "image" ? "selected" : ""}>Image</option>
                  <option value="video" ${String(s.new_media_type || "") === "video" ? "selected" : ""}>Video</option>
                </select>

                <label class="muted">Media URL</label>
                <textarea
  name="new_media_url_${s.id}"
  rows="3"
  placeholder="One URL per line"
  style="width:100%;"
>${escapeHtml(s.new_media_url || "")}</textarea>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    const html = `
      <style>
        .muted { opacity: 0.65; font-size: 12px; }
        .sections-table { width:100%; border-collapse: collapse; }
        .sections-table th, .sections-table td { border-top: 1px solid #e5e7eb; padding: 10px; vertical-align: top; }
        .sec-title { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
        .sec-body { width: 100%; box-sizing: border-box; }
        .btn-mini { padding: 6px 10px; }
        .danger { background: #fee2e2; }
      </style>

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
          <h2 style="margin:0 0 8px; font-size:16px;">Add new section</h2>
          <div style="display:grid; gap:8px;">
            <label>Title</label>
            <input name="new_title" placeholder="Title" />

            <label>Text</label>
            <textarea name="new_body" rows="4" placeholder="Text for guests..."></textarea>

            <label class="muted">Media type</label>
            <select name="new_media_type">
              <option value="none" selected>None</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
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
          <h2 style="margin:0 0 10px; font-size:16px;">Existing sections</h2>

          <table class="sections-table">
            <thead>
              <tr>
                <th style="width:90px;">Order</th>
                <th style="width:180px;">Actions</th>
                <th>Title & Text</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || `<tr><td colspan="3" class="muted" style="padding:10px;">No sections yet.</td></tr>`}
            </tbody>
          </table>

          <div style="margin-top:12px;">
            <button type="submit" name="save" value="1">Save all</button>
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

app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  console.log("🔥 TWILIO HIT", req.body);

  try {
    const from = String(req.body.From || ""); // "whatsapp:+34..."
    const body = String(req.body.Body || "").trim();
    const phone = from.replace("whatsapp:", "").trim(); // "+34..."
    const textUpper = body.toUpperCase().trim();

    console.log("📩 Twilio WhatsApp inbound:", { from, body });

    // ===== Session helpers (phone -> checkin) =====
    const getSessionCheckin = async () => {
      const q = await pool.query(
        `
        SELECT c.*
        FROM whatsapp_sessions ws
        JOIN checkins c ON c.id = ws.checkin_id
        WHERE ws.phone = $1
        ORDER BY ws.updated_at DESC
        LIMIT 1
        `,
        [phone]
      );
      return q.rows[0] || null;
    };

    const setSessionCheckin = async (checkinId) => {
      await pool.query(
        `
        INSERT INTO whatsapp_sessions (phone, checkin_id, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (phone)
        DO UPDATE SET
          checkin_id = EXCLUDED.checkin_id,
          updated_at = NOW()
        `,
        [phone, checkinId]
      );
    };

    // ===== Room settings =====
    const getRoomSettings = async (apartmentId) => {
      const roomRes = await pool.query(
        `
        SELECT
          registration_url,
          payment_url,
          keys_instructions_url,
          default_arrival_time,
          default_departure_time
        FROM beds24_rooms
        WHERE beds24_room_id = $1
           OR id::text = $1
        LIMIT 1
        `,
        [String(apartmentId || "")]
      );
      return roomRes.rows[0] || {};
    };

    const applyTpl = (tpl, bookId) =>
      String(tpl || "").replace(/\[BOOKID\]/g, String(bookId || ""));

    // ================== REGOK ==================
    if (textUpper === "REGOK") {
      const last = await getSessionCheckin();
      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START 123456");
        return res.status(200).send("OK");
      }

      await pool.query(
        `
        UPDATE checkins
        SET reg_done = true,
            reg_done_at = NOW()
        WHERE id = $1
        `,
        [last.id]
      );

      await sendWhatsApp(from, "✅ Registro confirmado.\nAhora realiza el pago y luego escribe: PAYOK");
      return res.status(200).send("OK");
    }

    // ================== PAYOK ==================
    if (textUpper === "PAYOK") {
      const last = await getSessionCheckin();
      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START 123456");
        return res.status(200).send("OK");
      }

      await pool.query(
        `
        UPDATE checkins
        SET pay_done = true,
            pay_done_at = NOW()
        WHERE id = $1
        `,
        [last.id]
      );

      await sendWhatsApp(from, "✅ Pago confirmado.\nCuando tengas todo listo, escribe: LISTO");
      return res.status(200).send("OK");
    }

    // ================== START (accept START 123 / START_123 / start-123) ==================
    const startMatch = textUpper.match(/^START[\s_:-]*([0-9]+)\s*$/);
    if (startMatch) {
      const bookingId = String(startMatch[1] || "").trim();
      console.log("🟢 START bookingId:", bookingId);

      const bookingResult = await pool.query(
        `
        SELECT *
        FROM checkins
        WHERE booking_token = $1
           OR beds24_booking_id::text = $1
           OR booking_id_from_start = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [bookingId]
      );

      if (!bookingResult.rows.length) {
        await sendWhatsApp(
          from,
          `Gracias 🙂\nNo encuentro tu reserva todavía.\nVerifica el número y vuelve a enviar:\nSTART ${bookingId}`
        );
        return res.status(200).send("OK");
      }

      const r = bookingResult.rows[0];

      // ✅ Bind session (this phone can continue REGOK/PAYOK/LISTO)
      await setSessionCheckin(r.id);

      // ✅ Optional: store phone only if empty (do not overwrite)
      await pool.query(
        `
        UPDATE checkins
        SET phone = COALESCE(NULLIF(phone, ''), $1)
        WHERE id = $2
        `,
        [phone, r.id]
      );

      const room = await getRoomSettings(r.apartment_id);

      const regTpl = String(room.registration_url || "");
      const payTpl = String(room.payment_url || "");
      const keysTpl = String(room.keys_instructions_url || "");

      const bookIdForLinks = String(
        r.beds24_booking_id || r.booking_id_from_start || r.booking_token || ""
      );

      const regLink = applyTpl(regTpl, bookIdForLinks);
      const payLink = applyTpl(payTpl, bookIdForLinks);
      const keysLink = applyTpl(keysTpl, bookIdForLinks);

      const name = r.full_name || "";
      const apt = r.apartment_name || r.apartment_id || "";

      const arriveDate = r.arrival_date ? String(r.arrival_date).slice(0, 10) : "";
      const departDate = r.departure_date ? String(r.departure_date).slice(0, 10) : "";

      const arriveTime =
        (r.arrival_time ? String(r.arrival_time).slice(0, 5) : "") ||
        String(room.default_arrival_time || "").slice(0, 5) ||
        "17:00";

      const departTime =
        (r.departure_time ? String(r.departure_time).slice(0, 5) : "") ||
        String(room.default_departure_time || "").slice(0, 5) ||
        "11:00";

      const adults = Number(r.adults || 0);
      const children = Number(r.children || 0);
      const guestsText =
        adults || children ? `${adults} adultos${children ? `, ${children} niños` : ""}` : "—";

      const showKeys = !!(r.reg_done && r.pay_done);

      await sendWhatsApp(
        from,
        `Hola, ${name} 👋
Tu reserva está confirmada ✅
🏠 Apartamento: ${apt}
📅 Entrada: ${arriveDate} ${arriveTime}
📅 Salida: ${departDate} ${departTime}
👥 Huéspedes: ${guestsText}

Para enviarte las instrucciones de acceso y el código de la caja de llaves, necesito 2 pasos:

1️⃣ Registro de huéspedes:
${regLink || "—"}
Después escribe: REGOK

2️⃣ Pago (tasa turística + depósito según la plataforma):
${payLink || "—"}
Después escribe: PAYOK

3️⃣ Llaves:
${showKeys ? (keysLink || "—") : "🔒 Se mostrarán después de completar REGISTRO y PAGO"}

Cuando lo tengas listo, escribe: LISTO`
      );

      return res.status(200).send("OK");
    }

    // ================== LISTO ==================
    if (textUpper === "LISTO") {
      const last = await getSessionCheckin();
      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START 123456");
        return res.status(200).send("OK");
      }

      if (!last.reg_done || !last.pay_done) {
        await sendWhatsApp(
          from,
          `Casi listo 🙂\nAntes necesito:\n1) Registro (después escribe REGOK)\n2) Pago (después escribe PAYOK)`
        );
        return res.status(200).send("OK");
      }

      const room = await getRoomSettings(last.apartment_id);
      const keysTpl = String(room.keys_instructions_url || "");

      const bookIdForLinks = String(
        last.beds24_booking_id || last.booking_id_from_start || last.booking_token || ""
      );

      const keysLink = applyTpl(keysTpl, bookIdForLinks);

      await sendWhatsApp(
        from,
        `✅ Perfecto 🙌
Aquí tienes el enlace con toda la información del apartamento:
📘 instrucciones de llegada
📶 Wi-Fi
❄️ aire acondicionado
🚗 parking (si aplica)
y otros detalles importantes para tu estancia.

🔐 Código de la caja de llaves
El código se mostrará automáticamente en este mismo enlace el día de llegada,
✅ siempre que el registro de huéspedes y el pago estén completados correctamente.

Guarda este enlace, lo necesitarás durante tu estancia 😊
${keysLink || "—"}`
      );

      return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ WhatsApp inbound error:", err);
    return res.status(200).send("OK");
  }
});

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
/* =====================================================
   RCS GUEST PORTAL - CLEAN CSS
   No duplicates, proper SaaS architecture
   ===================================================== */

/* === ROOT & RESET === */
:root {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f7fb;
  color: #111827;
  margin: 0;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

/* === LAYOUT === */
.page {
  width: 100%;
  max-width: 1100px;
  padding: 16px;
}

.card {
  background: #fff;
  border-radius: 18px;
  padding: 20px 18px 22px;
  box-shadow: 0 10px 28px rgba(17, 24, 39, 0.08);
  border: 1px solid #e5e7eb;
}

/* === TYPOGRAPHY === */
h1 {
  margin: 0 0 8px;
  font-size: 22px;
}

h2 {
  margin: 0 0 8px;
  font-size: 16px;
}

p {
  margin: 0 0 10px;
  font-size: 14px;
  color: #4b5563;
}

.muted {
  font-size: 12px;
  color: #6b7280;
}

label {
  font-size: 13px;
  display: block;
  margin-bottom: 4px;
  color: #374151;
}

/* === FORM CONTROLS === */
input,
select {
  width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  font-size: 14px;
}

input:focus,
select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
}

.lock-input {
  width: 72px;
  min-width: 72px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #d1d5db;
  font-size: 14px;
  letter-spacing: 0.12em;
}

/* =====================================================
   MODERN BUTTON STYLES - Replace in your CSS
   Subtle colors, rounded corners (not fully round)
   ===================================================== */

/* === PRIMARY BUTTONS === */
.btn-primary,
.btn-success,
.btn {
  display: inline-block;
  border-radius: 8px; /* Less rounded */
  padding: 10px 16px;
  font-weight: 600; /* Less bold */
  font-size: 14px;
  text-decoration: none;
  border: none;
  cursor: pointer;
  margin: 10px;
  transition: all 0.2s ease;
}

.btn-primary {
  background: #3b82f6;
  color: #fff;
}

.btn-primary:hover {
  background: #2563eb;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

.btn-success {
  background: #10b981;
  color: #fff;
}

.btn-success:hover {
  background: #059669;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
}

/* === SMALL BUTTONS IN TABLE === */
.btn-small {
  border-radius: 6px; /* Subtle rounded */
  padding: 6px 12px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  transition: all 0.2s ease;
}

/* Guardar button - subtle blue */
.btn-small:not(.btn-ghost):not(.danger) {
  background: #dbeafe;
  color: #1e40af;
  border: 1px solid #93c5fd;
}

.btn-small:not(.btn-ghost):not(.danger):hover {
  background: #bfdbfe;
  border-color: #60a5fa;
  transform: translateY(-1px);
}

/* Mostrar button - subtle purple */
.btn-ghost {
  background: #ede9fe;
  color: #6d28d9;
  border: 1px solid #c4b5fd;
}

.btn-ghost:hover {
  background: #ddd6fe;
  border-color: #a78bfa;
  transform: translateY(-1px);
}

/* Borrar button - subtle red */
.btn-small.danger {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}

.btn-small.danger:hover {
  background: #fecaca;
  border-color: #f87171;
  transform: translateY(-1px);
}

/* Abrir button - subtle gray */
.btn-small.btn-ghost {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
}

.btn-small.btn-ghost:hover {
  background: #e5e7eb;
  border-color: #9ca3af;
}

/* === ACTION BUTTONS (Guardar in forms) === */
button[type="submit"]:not(.clean-btn):not(.btn-small) {
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

button[type="submit"]:not(.clean-btn):not(.btn-small):hover {
  background: #2563eb;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}

/* === PILLS (No / Sí indicators) === */
.pill {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 6px; /* Less rounded */
  font-weight: 600;
  font-size: 11px;
  line-height: 1.4;
  border: 1px solid transparent;
}

.pill-yes {
  background: #d1fae5;
  color: #065f46;
  border-color: #6ee7b7;
}

.pill-no {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}

/* === CLEAN BUTTON === */
.clean-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 1px solid #e5e7eb;
  outline: 0;
  box-shadow: none;
  appearance: none;
  border-radius: 6px;
  background: #fff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s ease;
}

.clean-btn:hover {
  background: #f9fafb;
  border-color: #d1d5db;
  transform: scale(1.05);
}

.clean-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.clean-btn.pill-yes {
  background: #d1fae5;
  color: #065f46;
  border-color: #6ee7b7;
}

.clean-btn.pill-yes:hover {
  background: #a7f3d0;
}

.clean-btn.pill-no {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}

.clean-btn.pill-no:hover {
  background: #fecaca;
}

/* === BASE BUTTON (for filters) === */
.btn-base {
  height: 36px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  cursor: pointer;
  white-space: nowrap;
  font-weight: 500;
  transition: all 0.2s ease;
}

.btn-base:hover {
  background: #f9fafb;
  border-color: #9ca3af;
  transform: translateY(-1px);
}

.btn-base.btn-success {
  background: #d1fae5;
  color: #065f46;
  border-color: #6ee7b7;
}

.btn-base.btn-success:hover {
  background: #a7f3d0;
  border-color: #34d399;
}

/* === LINK BUTTON === */
.btn-link {
  background: transparent;
  color: #3b82f6;
  padding: 0;
  font-weight: 500;
  text-decoration: none;
  border: none;
  transition: color 0.2s ease;
}

.btn-link:hover {
  color: #2563eb;
  text-decoration: underline;
}

/* === WARNINGS === */
.warnings {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 12px;
  color: #9a3412;
  font-size: 13px;
  text-align: left;
}

.warnings p {
  margin: 4px 0;
  color: #9a3412;
}

/* === LAYOUT HELPERS === */
.row {
  display: flex;
  gap: 10px;
}

.row > div {
  flex: 1;
}

/* === TABLES === */
.table-wrap {
  width: 100%;
  overflow-x: auto;
  position: relative;
  -webkit-overflow-scrolling: touch;
}

table {
  width: 100%;
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}
/* Draggable column styles */
th[draggable="true"] {
  cursor: move;
  user-select: none;
  position: relative;
}

th[draggable="true"]:hover {
  background: #e5e7eb;
}

th[draggable="true"]::before {
  content: "⋮⋮";
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  color: #9ca3af;
  opacity: 0;
  transition: opacity 0.2s;
}

th[draggable="true"]:hover::before {
  opacity: 1;
}

th.dragging {
  opacity: 0.5;
  background: #dbeafe;
}

th.drag-over {
  background: #dbeafe;
  border-left: 3px solid #2563eb;
}

th.sticky-col {
  cursor: default !important;
}

th.sticky-col::before {
  display: none !important;
}

th {
  position: sticky;
  top: 0;
  background: #f9fafb;
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
  color: #374151;
  font-size: 12px;
}

td {
  padding: 6px 8px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
  white-space: normal;
}

tr:hover td {
  background: #f9fafb;
}

/* === STICKY COLUMNS === */
th.sticky-col,
td.sticky-col {
  position: sticky;
  left: 0;
  z-index: 2;
}

thead th.sticky-col {
  z-index: 3;
}

/* Default background for sticky columns (non-cleaning) */
th.sticky-col:not(.needs-clean),
td.sticky-col:not(.needs-clean) {
  background: #fff;
}

/* Hover state for sticky columns */
tr:hover td.sticky-col:not(.needs-clean) {
  background: #f9fafb;
}

/* === APARTMENT CELL STATES === */

/* Default apartment cell */
.apartment-cell {
  transition: background 0.2s;
}

/* Apartment needs cleaning (occupied yesterday) */
.apartment-cell.needs-clean {
  background: #f5f5f5 !important;
  font-weight: 600;
}

/* Sticky column when needs cleaning */
td.sticky-col.needs-clean {
  background: #f5f5f5 !important;
}

/* Hover state for cleaning cells */
tr:hover .apartment-cell.needs-clean,
tr:hover td.sticky-col.needs-clean {
  background: #e5e7eb !important;
}

/* === FORMS IN TABLE CELLS === */
td form {
  white-space: nowrap;
}

.lock-form,
.vis-form {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.lock-form button,
.vis-form button,
.lock-form .btn-small,
.vis-form .btn-small {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}

/* === COMPACT TABLES (for specific use cases) === */
.table-compact td,
.table-compact th {
  white-space: nowrap;
}

/* === SECTIONS TABLE (for apartment content management) === */
.sections-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.sections-table th,
.sections-table td {
  white-space: normal;
  vertical-align: top;
}

.sections-table .td-text {
  min-width: 0;
}

.sections-table .td-text,
.sections-table .td-text input,
.sections-table .td-text textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.sections-table .sec-title,
.sections-table .sec-body {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  display: block;
}
</style>
</head>
<body>
  <div class="page">
    <div class="card">
      ${innerHtml}
    </div>
  </div>

  <!-- Script AFTER content -->
  <script>
  (function() {
    'use strict';

    const STORAGE_KEY = 'rcs_table_column_order';
    let draggedColumn = null;
    let draggedIndex = null;

    function getColumnOrder() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : null;
      } catch (e) {
        console.error('Failed to load column order:', e);
        return null;
      }
    }

    function saveColumnOrder(order) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
      } catch (e) {
        console.error('Failed to save column order:', e);
      }
    }

    function getCurrentOrder(table) {
      const headers = Array.from(table.querySelectorAll('thead th'));
      return headers.map(th => ({
        text: th.textContent.trim(),
        index: Array.from(th.parentNode.children).indexOf(th)
      }));
    }

    function reorderColumns(table, order) {
      const headerRow = table.querySelector('thead tr');
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      
      if (!headerRow) return;

      const oldToNew = {};
      order.forEach((col, newIdx) => {
        oldToNew[col.index] = newIdx;
      });

      const newHeaders = new Array(order.length);
      Array.from(headerRow.children).forEach((th, oldIdx) => {
        const newIdx = oldToNew[oldIdx];
        if (newIdx !== undefined) {
          newHeaders[newIdx] = th;
        }
      });
      
      headerRow.innerHTML = '';
      newHeaders.forEach(th => th && headerRow.appendChild(th));

      bodyRows.forEach(row => {
        const newCells = new Array(order.length);
        Array.from(row.children).forEach((td, oldIdx) => {
          const newIdx = oldToNew[oldIdx];
          if (newIdx !== undefined) {
            newCells[newIdx] = td;
          }
        });
        
        row.innerHTML = '';
        newCells.forEach(td => td && row.appendChild(td));
      });
    }

    function initDragDrop(table) {
      const headers = table.querySelectorAll('thead th');
      
      headers.forEach((th, index) => {
        if (th.classList.contains('sticky-col')) {
          return;
        }

        th.setAttribute('draggable', 'true');

        th.addEventListener('dragstart', function(e) {
          draggedColumn = this;
          draggedIndex = Array.from(this.parentNode.children).indexOf(this);
          this.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/html', this.innerHTML);
        });

        th.addEventListener('dragover', function(e) {
          if (e.preventDefault) {
            e.preventDefault();
          }
          
          if (this.classList.contains('sticky-col')) {
            return false;
          }

          e.dataTransfer.dropEffect = 'move';
          
          if (draggedColumn !== this) {
            this.classList.add('drag-over');
          }
          
          return false;
        });

        th.addEventListener('dragenter', function(e) {
          if (!this.classList.contains('sticky-col') && draggedColumn !== this) {
            this.classList.add('drag-over');
          }
        });

        th.addEventListener('dragleave', function(e) {
          this.classList.remove('drag-over');
        });

        th.addEventListener('drop', function(e) {
          if (e.stopPropagation) {
            e.stopPropagation();
          }

          if (this.classList.contains('sticky-col')) {
            return false;
          }

          this.classList.remove('drag-over');

          if (draggedColumn !== this) {
            const dropIndex = Array.from(this.parentNode.children).indexOf(this);
            const allRows = Array.from(table.querySelectorAll('tbody tr'));

            if (draggedIndex < dropIndex) {
              this.parentNode.insertBefore(draggedColumn, this.nextSibling);
            } else {
              this.parentNode.insertBefore(draggedColumn, this);
            }

            allRows.forEach(row => {
              const cells = Array.from(row.children);
              const draggedCell = cells[draggedIndex];
              const dropCell = cells[dropIndex];

              if (draggedCell && dropCell) {
                if (draggedIndex < dropIndex) {
                  row.insertBefore(draggedCell, dropCell.nextSibling);
                } else {
                  row.insertBefore(draggedCell, dropCell);
                }
              }
            });

            const newOrder = getCurrentOrder(table);
            saveColumnOrder(newOrder);
          }

          return false;
        });

        th.addEventListener('dragend', function(e) {
          this.classList.remove('dragging');
          
          headers.forEach(header => {
            header.classList.remove('drag-over');
          });

          draggedColumn = null;
          draggedIndex = null;
        });
      });
    }

    function init() {
      const tables = document.querySelectorAll('table');
      
      tables.forEach(table => {
        const savedOrder = getColumnOrder();
        if (savedOrder && savedOrder.length > 0) {
          try {
            reorderColumns(table, savedOrder);
          } catch (e) {
            console.error('Failed to apply saved column order:', e);
          }
        }

        initDragDrop(table);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

    window.resetColumnOrder = function() {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    };

    console.log('✅ Draggable columns initialized');
  })();
  </script>

</body>
</html>`;
}

// =====================================================
// ROUTES
// =====================================================

function mapBeds24BookingToRow(b, roomNameFallback = "", roomIdFallback = "") {
  // Extraer nombre del apartamento de forma inteligente
  // Extraer nombre del apartamento del payload de Beds24
  let apartmentName = b.roomName || ""; // si Beds24 lo envía directamente

  if (!apartmentName && b.apiMessage) {
    // Beds24 siempre pone "Room: Nombre del apartamento" al principio
    const match = b.apiMessage.match(/^Room:\s*(.+?)(?:\n|$)/i);
    if (match) {
      apartmentName = match[1].trim();
    }
  }

  // Fallback bonito si no encontramos nada
  if (!apartmentName) {
    apartmentName = `Apartamento ${b.roomId || "sin ID"}`;
  }

  return {
    apartment_id: String(b.roomId || roomIdFallback || ""),
    apartment_name: apartmentName,
    booking_token: b.bookingToken || null,
    full_name: `${b.firstName || ""} ${b.lastName || ""}`.trim() || "Guest",
    email: b.email || "unknown@unknown",
    phone: b.phone || b.mobile || "+000",
    arrival_date: b.arrival || null,
    arrival_time: b.arrivalTime ? b.arrivalTime.slice(0, 5) : "16:00",
    departure_date: b.departure || null,
    departure_time: b.departureTime ? b.departureTime.slice(0, 5) : "11:00",
    adults: b.numAdult || 0,
    children: b.numChild || 0,
    beds24_booking_id: b.id ? BigInt(b.id) : null,
    beds24_room_id: String(b.roomId || ""),
    status: b.status || "confirmed",
    cancelled: b.status === "cancelled",
    lock_code: null,
    lock_visible: false,
    clean_ok: false,
    beds24_raw: b, // payload completo
    provider: "beds24",
    // otros campos...
  };
}
async function upsertCheckinFromBeds24(row) {
  // если дат нет — пропускаем (без дат нельзя вставить в checkins)
  if (!row.arrival_date || !row.departure_date) return { skipped: true };

  await pool.query(
    `
    INSERT INTO checkins (
      apartment_id, booking_token, full_name, email, phone,
      arrival_date, arrival_time, departure_date, departure_time,
      adults, children,
      beds24_booking_id, beds24_room_id, apartment_name, beds24_raw
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,
      $10,$11,
      $12,$13,$14,$15
    )
    ON CONFLICT (beds24_booking_id)
    DO UPDATE SET
      apartment_id = EXCLUDED.apartment_id,
      booking_token = EXCLUDED.booking_token,
      full_name = EXCLUDED.full_name,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      arrival_date = EXCLUDED.arrival_date,
      arrival_time = EXCLUDED.arrival_time,
      departure_date = EXCLUDED.departure_date,
      departure_time = EXCLUDED.departure_time,
      adults = EXCLUDED.adults,
      children = EXCLUDED.children,
      beds24_room_id = EXCLUDED.beds24_room_id,
      apartment_name = EXCLUDED.apartment_name,
      beds24_raw = EXCLUDED.beds24_raw
    `,
    [
      row.apartment_id,
      row.booking_token,
      row.full_name,
      row.email,
      row.phone,
      row.arrival_date,
      row.arrival_time,
      row.departure_date,
      row.departure_time,
      row.adults,
      row.children,
      row.beds24_booking_id,
      row.beds24_room_id,
      row.apartment_name,
      row.beds24_raw,
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
app.get("/manager/channels/bookingssync", async (req, res) => {
  try {
    const propertyId = "203178"; // tu property_external_id

    const accessToken = await getBeds24AccessToken(propertyId);

    // Traemos reservas desde 2024 hasta 2027 (para cubrir antiguas y futuras)
    const fromDate = "2024-01-01";
    const toDate = "2027-12-31";

    const bookingsResp = await fetch(
      `https://beds24.com/api/v2/bookings?from=${fromDate}&to=${toDate}&includeCancelled=true`,
      {
        headers: {
          accept: "application/json",
          token: accessToken,
        },
      }
    );

    if (!bookingsResp.ok) {
      const text = await bookingsResp.text();
      throw new Error(`Error Beds24: ${bookingsResp.status} - ${text.slice(0, 300)}`);
    }

    const data = await bookingsResp.json();

    const bookings = Array.isArray(data) ? data : (data.bookings || data.data || []);

    if (bookings.length === 0) {
      return res.send(renderPage("Sync Bookings", `
        <div class="card">
          <h1>ℹ️ No hay reservas en el rango</h1>
          <p>No se encontraron bookings entre ${fromDate} y ${toDate}.</p>
          <p><a href="/manager" class="btn-link">← Volver</a></p>
        </div>
      `));
    }

    let synced = 0;
    let updated = 0;
    let newOnes = 0;

    for (const b of bookings) {
      const row = mapBeds24BookingToRow(b, b.roomName || "", b.roomId || "");
      const result = await upsertCheckinFromBeds24(row);
      synced++;
      if (result.ok) newOnes++;
      else updated++;
    }

    res.send(renderPage("Sync Bookings", `
      <div class="card">
        <h1 style="color:#16a34a;">✅ Sync completado</h1>
        <p>Se procesaron <strong>${synced}</strong> reservas de Beds24 (desde ${fromDate}).</p>
        <p>Nuevas: ${newOnes} | Actualizadas: ${updated}</p>
        <hr/>
        <p><a href="/staff/checkins" class="btn-primary">Ver lista completa</a></p>
        <p><a href="/manager" class="btn-link">← Volver al Manager</a></p>
      </div>
    `));
  } catch (e) {
    console.error("Sync error:", e);
    res.status(500).send(renderPage("Error Sync", `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a href="/manager" class="btn-link">← Volver</a></p>
      </div>
    `));
  }
});
// ===================== MANAGER: Menu =====================
// ===== MANAGER HOME: select apartment =====
app.get("/manager", async (req, res) => {
  try {
    const { rows: apartments } = await pool.query(`
      SELECT id, apartment_name
      FROM beds24_rooms
      ORDER BY apartment_name ASC
    `);

    const options = apartments
      .map(
        (a) =>
          `<option value="${a.id}">${escapeHtml(a.apartment_name || ("Apartment #" + a.id))}</option>`
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
        <li><a href="/staff/checkins">Staff · Check-ins</a></li>
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
  keys_instructions_url
FROM beds24_rooms
WHERE id = $1
LIMIT 1
      `,
      [id]
    );

    if (!rows.length) return res.status(404).send("Apartment not found");
    const a = rows[0];
    
const roomId = String(a.beds24_room_id || "").trim();

    const html = `
      <h1>Apartment Settings</h1>
      <p><a href="/manager">← Back to Manager</a></p>
       ${roomId
  ? `<a class="btn-link" href="/manager/apartment/sections?room_id=${encodeURIComponent(roomId)}">
       🪗 Manage guest accordion sections
     </a>`
  : `<span class="muted">⚠ Missing room_id for this apartment</span>`
}

      <form method="POST" action="/manager/apartment/save">
        <input type="hidden" name="id" value="${a.id}" />

        <label>Apartment name</label><br/>
        <input name="apartment_name" value="${escapeHtml(a.apartment_name || "")}" style="width:100%; max-width:700px;" />
        <br/><br/>
                    <label>Support WhatsApp (human)</label><br/>
<input
  name="support_phone"
  value="${escapeHtml(a?.support_phone || "")}"
  placeholder="+34 600 123 456"
  style="width:320px"
/>

        <label>Default arrival time</label><br/>
        <input type="time" name="default_arrival_time" value="${escapeHtml(String(a.default_arrival_time || "").slice(0,5))}" />
        <br/><br/>

        <label>Default departure time</label><br/>
        <input type="time" name="default_departure_time" value="${escapeHtml(String(a.default_departure_time || "").slice(0,5))}" />
        <br/><br/>

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
      <p style="margin-top:10px;">

</p>
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
    keys_instructions_url
  } = req.body;

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
      updated_at = now()
    WHERE id = $8
  `, [
    apartment_name,
    support_phone,
    default_arrival_time,
    default_departure_time,
    registration_url,
    payment_url,
    keys_instructions_url,
    id
  ]);

  res.redirect(`/manager/apartment?id=${id}`);
});


// ========== POST: create new accordion section ==========
// CREATE new section (from manager page)

app.post("/manager/apartment/sections/save", async (req, res) => {
  try {
    const room_id = String(req.body.room_id || "").trim();
    if (!room_id) return res.status(400).send("Missing room_id");

    // 1) DELETE
    if (req.body.delete) {
      const deleteId = Number(req.body.delete);
      await pool.query(
        `DELETE FROM apartment_sections WHERE id=$1 AND room_id=$2`,
        [deleteId, room_id]
      );
      return res.redirect(`/manager/apartment/sections?room_id=${encodeURIComponent(room_id)}`);
    }

    // 2) MOVE (up/down) — optional, if you already have logic keep it but use room_id in WHERE
    if (req.body.move) {
      // Keep your existing move logic, but every query must filter by room_id, not apartment_id.
      // Example: SELECT id, sort_order FROM apartment_sections WHERE room_id=$1 ...
    }

    // 3) ADD new section
    if (String(req.body.add) === "1") {
      const title = String(req.body.new_title || "").trim();
      const body = String(req.body.new_body || "").trim();
      const sort_order = Number(req.body.new_sort_order || 1);
      const is_active = req.body.new_is_active ? true : false;

      const new_media_type = String(req.body.new_media_type || "none").trim();
      const new_media_url = String(req.body.new_media_url || "").trim();

      // Prevent fully empty section
      if (!title && !body && !new_media_url) {
        return res.status(400).send("Empty section");
      }

      // If URL exists but type is none -> normalize
      const final_media_type = new_media_url
        ? (new_media_type === "video" ? "video" : "image")
        : "none";

      await pool.query(
        `
        INSERT INTO apartment_sections
          (room_id, title, body, sort_order, is_active, new_media_type, new_media_url)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7)
        `,
        [room_id, title, body, sort_order, is_active, final_media_type, new_media_url]
      );

      return res.redirect(`/manager/apartment/sections?room_id=${encodeURIComponent(room_id)}`);
    }

    // 4) SAVE ALL edits
    if (req.body.save) {
      const secRes = await pool.query(
        `SELECT id FROM apartment_sections WHERE room_id=$1 ORDER BY id ASC`,
        [room_id]
      );

      for (const row of secRes.rows) {
        const id = row.id;

        const title = String(req.body[`title_${id}`] || "").trim();
        const body = String(req.body[`body_${id}`] || "");
        const sort_order = Number(req.body[`sort_order_${id}`] || 1);
        const is_active = req.body[`is_active_${id}`] ? true : false;

        const new_media_type = String(req.body[`new_media_type_${id}`] || "none").trim();
        const new_media_url = String(req.body[`new_media_url_${id}`] || "").trim();

        const final_media_type = new_media_url
          ? (new_media_type === "video" ? "video" : "image")
          : "none";

        await pool.query(
          `
          UPDATE apartment_sections
          SET title=$1,
              body=$2,
              sort_order=$3,
              is_active=$4,
              new_media_type=$5,
              new_media_url=$6,
              updated_at=NOW()
          WHERE id=$7 AND room_id=$8
          `,
          [title, body, sort_order, is_active, final_media_type, new_media_url, id, room_id]
        );
      }

      return res.redirect(`/manager/apartment/sections?room_id=${encodeURIComponent(room_id)}`);
    }

    return res.redirect(`/manager/apartment/sections?room_id=${encodeURIComponent(room_id)}`);
  } catch (e) {
    console.error("sections save error:", e);
    return res.status(500).send("Cannot save sections: " + (e.detail || e.message || String(e)));
  }
});
   
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
    //vremenno
// ---- room / apartment (from DB mapping) ----
const beds24RoomId = String(
  booking?.roomId ?? booking?.room?.id ?? booking?.unitId ?? ""
);

let apartmentName = null;

if (beds24RoomId) {
  const roomRes = await pool.query(
    `
    SELECT apartment_name
    FROM beds24_rooms
    WHERE beds24_room_id = $1
      AND is_active = true
    LIMIT 1
    `,
    [beds24RoomId]
  );

  if (roomRes.rows.length) {
    apartmentName = roomRes.rows[0].apartment_name;
  }
}

// fallback — если в менеджере ещё не добавили
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
     //vremenno
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

    //vremenno
// ---- save/refresh roomId -> apartmentName mapping (auto) ----
if (beds24RoomId && beds24RoomId !== "undefined" && beds24RoomId !== "null") {
  await pool.query(
    `
    INSERT INTO beds24_rooms (beds24_room_id, apartment_name, is_active)
    VALUES ($1, COALESCE($2, ''), true)
    ON CONFLICT (beds24_room_id)
    DO UPDATE SET
      apartment_name = COALESCE(EXCLUDED.apartment_name, beds24_rooms.apartment_name),
      is_active = true,
      updated_at = NOW()
    `,
    [String(beds24RoomId), apartmentName ? String(apartmentName) : ""]
  );
}
 //vremenno

// ---- upsert ----
await pool.query(
  `
  INSERT INTO checkins (
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
    beds24_raw
  )
  VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8,
    $9, $10, $11, $12,
    $13, $14,
    $15::jsonb
  )
  ON CONFLICT (booking_token)
  DO UPDATE SET
    apartment_id       = EXCLUDED.apartment_id,
    beds24_booking_id  = COALESCE(EXCLUDED.beds24_booking_id, checkins.beds24_booking_id),
    beds24_room_id     = COALESCE(EXCLUDED.beds24_room_id,    checkins.beds24_room_id),
    apartment_name     = COALESCE(EXCLUDED.apartment_name,    checkins.apartment_name),
    full_name          = EXCLUDED.full_name,
    email              = EXCLUDED.email,
    phone              = EXCLUDED.phone,
    arrival_date       = COALESCE(EXCLUDED.arrival_date,   checkins.arrival_date),
    arrival_time       = COALESCE(EXCLUDED.arrival_time,   checkins.arrival_time),
    departure_date     = COALESCE(EXCLUDED.departure_date, checkins.departure_date),
    departure_time     = COALESCE(EXCLUDED.departure_time, checkins.departure_time),
    adults             = COALESCE(EXCLUDED.adults,   checkins.adults),
    children           = COALESCE(EXCLUDED.children, checkins.children),
    beds24_raw         = COALESCE(EXCLUDED.beds24_raw, checkins.beds24_raw)
  `,
  [
    String(beds24RoomId || ""), // apartment_id
    String(booking.id || ""),   // booking_token
    beds24BookingId,            // beds24_booking_id
    String(beds24RoomId || ""), // beds24_room_id
    apartmentName,              // apartment_name
    fullName,
    email,
    phone,
    arrivalDate,
    arrivalTime,
    departureDate,
    departureTime,
    adults,
    children,
    JSON.stringify(beds24Raw),
  ]
);


    console.log("✅ Booking saved:", booking.id);
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
    <p class="muted">Admin: <a class="btn-link" href="/staff/checkins">/staff/checkins</a></p>
  `;
  res.send(renderPage("Home", html));
});

// --- Booking page ---
app.get("/booking/:aptId/:token", (req, res) => {
  const { aptId, token } = req.params;
  const html = `
    <h1>Booking ${token}</h1>
    <p>Apartment: <strong>${aptId}</strong></p>
    <p><a href="/checkin/${aptId}/${token}" class="btn-primary">Go to check-in</a></p>
    <p><a href="/" class="btn-link">← Back</a></p>
  `;
  res.send(renderPage(`Booking ${token}`, html));
});

// --- Check-in form ---
app.get("/checkin/:aptId/:token", (req, res) => {
  const { aptId, token } = req.params;
  const now = new Date();
  const today = ymd(now);
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  const tomorrow = ymd(tmr);

  const html = `
    <h1>Check-in • ${token}</h1>
    <p class="muted">Apartment: <strong>${aptId}</strong></p>

    <form method="POST" action="/checkin/${aptId}/${token}">
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

      <button class="btn-base" "type="submit" class="btn-primary">Submit</button>
    </form>

    <p style="margin-top:16px;"><a href="/booking/${aptId}/${token}" class="btn-link">← Back</a></p>
  `;

  res.send(renderPage("Check-in", html));
});

// --- Check-in submit -> DB ---
app.post("/checkin/:aptId/:token", async (req, res) => {
  const { aptId, token } = req.params;



  try {
    // 👉 НОРМАЛИЗАЦИЯ ДАННЫХ (ОБЯЗАТЕЛЬНО)
    const arrivalDate = req.body.arrivalDate;
    const arrivalTime = req.body.arrivalTime || "16:00";
    const departureDate = req.body.departureDate;
    const departureTime = req.body.departureTime || "11:00";

    await pool.query(
      `
      INSERT INTO checkins (
        apartment_id, booking_token, full_name, email, phone,
        arrival_date, arrival_time, departure_date, departure_time
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        aptId,
        token,
        req.body.fullName,
        req.body.email,
        req.body.phone,
        req.body.arrivalDate,
        req.body.arrivalTime,
        req.body.departureDate,
        req.body.departureTime,
      ]
    );

    // AFTER CHECKIN -> REDIRECT TO DASHBOARD
    return res.redirect(`/guest/${aptId}/${token}`);
  } catch (e) {
    console.error("DB insert error:", e);
    res.status(500).send("❌ DB error while saving check-in");
  }
});

// ===================== GUEST DASHBOARD =====================
// Guest opens: /guest/:aptId/:token
// We show last submitted record for this booking token.
app.get("/guest/:roomId/:token", async (req, res) => {
  const { roomId, token } = req.params;

  function toYouTubeEmbed(url) {
    const u = String(url || "");
    const m1 = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    const m2 = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    const id = (m1 && m1[1]) || (m2 && m2[1]);
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }

  function toVimeoEmbed(url) {
    const u = String(url || "");
    const m = u.match(/vimeo\.com\/(\d+)/);
    const id = m && m[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }

  try {
    // 1) Load check-in record
  // 1) Load check-in record (robust matching after DB changes)
const checkinRes = await pool.query(
  `
  SELECT
    id,
    booking_token,
    booking_id,
    booking_id_from_start,
    beds24_booking_id,
    beds24_room_id,
    apartment_id,
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
    lock_code,
    lock_visible,
    cancelled
  FROM checkins
  WHERE cancelled IS DISTINCT FROM true
    AND (
      beds24_room_id::text = $1
      OR apartment_id::text = $1
      OR external_room_id::text = $1
    )
    AND (
      booking_token = $2
      OR booking_id_from_start = $2
      OR booking_id = $2
      OR beds24_booking_id::text = $2
      OR provider_booking_id = $2
      OR external_booking_id = $2
    )
  ORDER BY id DESC
  LIMIT 1
  `,
  [String(roomId), String(token)]
);

    if (!checkinRes.rows.length) {
      const html = `
        <h1>Guest Dashboard</h1>
        <p class="muted">No check-in record found for this booking.</p>
        <p><a class="btn-link" href="/">← Back</a></p>
      `;
      return res.send(renderPage("Guest Dashboard", html));
    }

    const r = checkinRes.rows[0];

    // 2) Load apartment sections
    const secRes = await pool.query(
      `
      SELECT
        id,
        title,
        body,
        new_media_type,
        new_media_url
      FROM apartment_sections
      WHERE room_id::text = $1
        AND is_active = true
      ORDER BY sort_order ASC, id ASC
      `,
      [String(roomId)]
    );

    const totalGuests = (Number(r.adults) || 0) + (Number(r.children) || 0);

    // 3) Lock code visibility via ?show=1
    const show = req.query.show === "1";
    const lockCodeHtml =
      r.lock_visible && r.lock_code
        ? show
          ? `
            <hr/>
            <div>Lock Code: <strong style="font-size:22px;letter-spacing:2px;">${escapeHtml(
              String(r.lock_code)
            )}</strong></div>
          `
          : `
            <hr/>
            <a class="btn-link" href="/guest/${encodeURIComponent(
              String(roomId)
            )}/${encodeURIComponent(String(token))}?show=1">Show code</a>
          `
        : "";

    // 4) Accordion sections
    const sectionsHtml =
      secRes.rows.length === 0
        ? `<div class="muted">No information sections for this apartment yet.</div>`
        : `
          <h2 style="margin-top:18px;">Guest info</h2>
          <div id="guest-accordion">
           ${secRes.rows
  .map((s) => {
    const title = escapeHtml(s.title || "");
    const rawBody = String(s.body || "");

const bodyHtml = escapeHtml(rawBody)
  .replace(/\n/g, "<br/>")
  .replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener" class="btn-link">${safeUrl}</a>`;
  });

    const mediaType = String(s.new_media_type || "").toLowerCase().trim();
    const mediaUrlRaw = String(s.new_media_url || "").trim();

    let media = "";

    if (mediaUrlRaw) {
      if (mediaType === "image") {
        const images = mediaUrlRaw
          .split(/\r?\n/)
          .map((u) => u.trim())
          .filter(Boolean);

        media = images
          .map(
            (url) => `
              <div style="margin-top:10px;">
                <img src="${escapeHtml(url)}" style="max-width:100%;border-radius:12px;display:block;" loading="lazy" />
              </div>
            `
          )
          .join("");
      } else if (mediaType === "video") {
        const lower = mediaUrlRaw.toLowerCase();

        if (lower.endsWith(".mp4")) {
          media = `
            <div style="margin-top:10px;">
              <video controls playsinline style="width:100%;border-radius:12px;">
                <source src="${escapeHtml(mediaUrlRaw)}" type="video/mp4">
              </video>
            </div>
          `;
        } else {
          const yt = toYouTubeEmbed(mediaUrlRaw);
          const vm = toVimeoEmbed(mediaUrlRaw);
          const embed = yt || vm;

          media = embed
            ? `
              <div style="margin-top:10px;">
                <iframe
                  src="${escapeHtml(embed)}"
                  style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                ></iframe>
              </div>
            `
            : `
              <div style="margin-top:10px;">
                <a href="${escapeHtml(mediaUrlRaw)}" target="_blank" rel="noopener" class="btn-link">
                  ▶ Abrir video
                </a>
              </div>
            `;
        }
      } else {
        media = `
          <div style="margin-top:10px;">
            <a href="${escapeHtml(mediaUrlRaw)}" target="_blank" rel="noopener" class="btn-link">
              🔗 Abrir enlace
            </a>
          </div>
        `;
      }
    }

    const panelId = `acc_${s.id}`;

    return `
      <div style="border:1px solid #e5e7eb;border-radius:14px;margin:10px 0;overflow:hidden;background:#fff;">
        <button
          type="button"
          data-acc-btn="${panelId}"
          style="width:100%;text-align:left;padding:12px 14px;border:0;background:#f9fafb;cursor:pointer;font-weight:600;"
        >
          ${title}
        </button>
        <div id="${panelId}" style="display:none;padding:12px 14px;">
          <div>${bodyHtml}</div>
          ${media}
        </div>
      </div>
    `;
  })
  .join("")}
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
          </script>
        `;

    // 5) Page HTML
    const html = `
      <div class="card">
        <h1>Guest Dashboard</h1>
        <div class="muted">Apartment: <strong>${escapeHtml(r.apartment_name || "")}</strong></div>
        <div class="muted">Booking ID: <strong>${escapeHtml(
          String(r.beds24_booking_id || r.booking_token || "")
        )}</strong></div>
        <hr/>
        <div>Arrival: <strong>${fmtDate(r.arrival_date)}${
          r.arrival_time ? " " + fmtTime(r.arrival_time) : ""
        }</strong></div>
        <div>Departure: <strong>${fmtDate(r.departure_date)}${
          r.departure_time ? " " + fmtTime(r.departure_time) : ""
        }</strong></div>
        <div>Guests: <strong>${totalGuests}</strong> (adults: ${Number(r.adults) || 0}, children: ${
          Number(r.children) || 0
        })</div>
        ${lockCodeHtml}
        ${sectionsHtml}
      </div>
    `;

    return res.send(renderPage("Guest Dashboard", html));
  } catch (e) {
    console.error("Guest dashboard error:", e);
    return res.status(500).send("Cannot load guest dashboard: " + (e.detail || e.message || String(e)));
  }
});
// --- LIST + FILTER ---
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
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return { whereSql, params };
    }

    const wArr = buildWhereFor("b.checkin_date");
    const wDep = buildWhereFor("b.checkout_date");

    // Arrivals query
    const arrivalsRes = await pool.query(
      `
      SELECT
        b.id,
        b.booking_reference,
        a.name as apartment_name,
        a.id as apartment_id,
        b.guest_name as full_name,
        b.guest_phone as phone,
        b.checkin_date as arrival_date,
        b.checkin_time as arrival_time,
        b.checkout_date as departure_date,
        b.checkout_time as departure_time,
        b.num_adults as adults,
        b.num_children as children,
        b.lock_code,
        b.lock_code_visible,
        b.cleaning_completed as clean_ok
      FROM bookings b
      JOIN apartments a ON a.id = b.apartment_id
      WHERE b.is_cancelled = false
        ${wArr.whereSql ? " AND " + wArr.whereSql.substring(6) : ""}
      ORDER BY b.checkin_date ASC, b.checkin_time ASC, b.id DESC
      LIMIT 300
      `,
      wArr.params
    );

    // Departures query
    const departuresRes = await pool.query(
      `
      SELECT
        b.id,
        b.booking_reference,
        a.name as apartment_name,
        a.id as apartment_id,
        b.guest_name as full_name,
        b.guest_phone as phone,
        b.checkin_date as arrival_date,
        b.checkin_time as arrival_time,
        b.checkout_date as departure_date,
        b.checkout_time as departure_time,
        b.num_adults as adults,
        b.num_children as children,
        b.lock_code,
        b.lock_code_visible,
        b.cleaning_completed as clean_ok
      FROM bookings b
      JOIN apartments a ON a.id = b.apartment_id
      WHERE b.is_cancelled = false
        ${wDep.whereSql ? " AND " + wDep.whereSql.substring(6) : ""}
      ORDER BY b.checkout_date ASC, b.checkout_time ASC, b.id DESC
      LIMIT 300
      `,
      wDep.params
    );

    const arrivals = arrivalsRes.rows || [];
    const departures = departuresRes.rows || [];

   // Color logic: grey ONLY if (occupied yesterday) AND (has checkout today)
const yesterdayStr = yesterday;
const todayStr = today;

// 1) apartments occupied yesterday (someone slept there)
const { rows: occupiedYesterdayRows } = await pool.query(
  `
  SELECT DISTINCT b.apartment_id
  FROM bookings b
  WHERE b.is_cancelled = false
    AND b.checkin_date <= $1::date
    AND b.checkout_date > $1::date
  `,
  [yesterdayStr]
);
const occupiedYesterdaySet = new Set(occupiedYesterdayRows.map(r => String(r.apartment_id)));

// 2) apartments that have a departure today (need cleaning today)
const { rows: departuresTodayRows } = await pool.query(
  `
  SELECT DISTINCT b.apartment_id
  FROM bookings b
  WHERE b.is_cancelled = false
    AND b.checkout_date = $1::date
  `,
  [todayStr]
);
const departuresTodaySet = new Set(departuresTodayRows.map(r => String(r.apartment_id)));

function aptColorClass(apartmentId) {
  const id = String(apartmentId || "");
  if (!id) return "";
  if (occupiedYesterdaySet.has(id) && departuresTodaySet.has(id)) {
    return "needs-clean";
  }
  return "";
}
    // Toolbar
    const toolbar = `
      <h1>Staff · Llegadas y Salidas</h1>
      <p class="muted">Zona horaria: España (Europe/Madrid)</p>
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

    function renderTable(rows, mode) {
      const title = mode === "departures" 
        ? `Salidas <span class="muted">(${rows.length})</span>` 
        : `Llegadas <span class="muted">(${rows.length})</span>`;
      const dateColTitle = mode === "departures" ? "Salida" : "Llegada";

      const tbody = rows.length ? rows.map(r => {
        const mainDate = mode === "departures" 
          ? `${fmtDate(r.departure_date)} ${fmtTime(r.departure_time)}`
          : `${fmtDate(r.arrival_date)} ${fmtTime(r.arrival_time)}`;

        const guestPortalUrl = `/guest/${r.apartment_id}/${r.booking_reference}`;

        return `
          <tr>
            <td class="sticky-col">
              <form method="POST" action="/staff/bookings/${r.id}/clean">
                <button type="submit" class="clean-btn ${r.clean_ok ? "pill-yes" : "pill-no"}">
                  ${r.clean_ok ? "✓" : ""}
                </button>
              </form>
            </td>
            <td class="apartment-cell ${aptColorClass(r.apartment_id)}">
              ${escapeHtml(r.apartment_name || "Sin nombre")}
            </td>
            <td>${(r.adults || 0)} | ${(r.children || 0)}</td>
            <td>${mainDate}</td>
            <td>${calcNights(r.arrival_date, r.departure_date)}</td>
            <td><a class="btn-small btn-ghost" href="${guestPortalUrl}" target="_blank">Abrir</a></td>
            <td>
              <form method="POST" action="/staff/bookings/${r.id}/lock" class="lock-form">
                <input class="lock-input" name="lock_code" value="${r.lock_code || ""}" placeholder="0000" />
                <button type="submit" class="btn-small">Guardar</button>
              </form>
            </td>
            <td>
              <form method="POST" action="/staff/bookings/${r.id}/visibility" class="vis-form">
                <span class="pill ${r.lock_code_visible ? "pill-yes" : "pill-no"}">${r.lock_code_visible ? "Sí" : "No"}</span>
                <button type="submit" class="btn-small ${r.lock_code_visible ? "btn-ghost" : ""}">
                  ${r.lock_code_visible ? "Ocultar" : "Mostrar"}
                </button>
              </form>
            </td>
            <td>
              <form method="POST" action="/staff/bookings/${r.id}/delete"
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
                <th>Apartamento</th>
                <th>A|C</th>
                <th>${dateColTitle}</th>
                <th>Noches</th>
                <th>Huésped</th>
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
// ===================== ADMIN: SET VISIBILITY =====================
app.post("/staff/bookings/:id/visibility", async (req, res) => {
  const id = Number(req.params.id);
  try {
    // Toggle visibility
    await pool.query(`UPDATE bookings SET lock_code_visible = NOT lock_code_visible WHERE id = $1`, [id]);
    const back = req.body.returnTo || req.get("referer") || "/staff/checkins";
    res.redirect(back);
  } catch (e) {
    console.error("Visibility update error:", e);
    res.status(500).send("❌ Cannot update visibility");
  }
});

// ===================== ADMIN: CLEAN TOGGLE =====================
app.post("/staff/bookings/:id/clean", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query(`UPDATE bookings SET cleaning_completed = NOT cleaning_completed WHERE id = $1`, [id]);
    const back = req.body.returnTo || req.get("referer") || "/staff/checkins";
    res.redirect(back);
  } catch (e) {
    console.error("Clean toggle error:", e);
    res.status(500).send("❌ Cannot toggle clean status");
  }
});

// ===================== MANAGER SETTINGS =====================
// ===================== MANAGER: Sync Bookings manual =====================
app.get("/manager/channels/bookingssync", async (req, res) => {
  try {
    // Cambia '203178' por tu property_external_id si tienes varios
    const propertyId = "203178";

    const accessToken = await getBeds24AccessToken(propertyId);

    // Puedes agregar filtros: ?modifiedSince=2025-01-01 o ?includeCancelled=true
    const bookingsResp = await fetch("https://beds24.com/api/v2/bookings", {
      headers: {
        accept: "application/json",
        token: accessToken,
      },
    });

    if (!bookingsResp.ok) {
      const text = await bookingsResp.text();
      throw new Error(`Error al obtener bookings: ${bookingsResp.status} - ${text.slice(0, 300)}`);
    }

    const bookings = await bookingsResp.json();

    let synced = 0;
    for (const b of bookings) {
      const row = mapBeds24BookingToRow(b, b.roomName || "", b.roomId || "");
      await upsertCheckinFromBeds24(row);
      synced++;
    }

    const html = `
      <div class="card">
        <h1 style="color:#16a34a;">✅ Sync completado</h1>
        <p>Se sincronizaron <strong>${synced}</strong> reservas desde Beds24.</p>
        <p>Fecha: ${new Date().toLocaleString('es-ES')}</p>
        <hr/>
        <p><a href="/staff/checkins" class="btn-primary">Ver check-ins actualizados</a></p>
        <p><a href="/manager" class="btn-link">← Volver al Manager</a></p>
      </div>
    `;
    res.send(renderPage("Sync Bookings", html));
  } catch (e) {
    console.error("❌ Sync bookings error:", e);
    const html = `
      <div class="card">
        <h1 style="color:#991b1b;">❌ Error en sync</h1>
        <p>${escapeHtml(e.message || String(e))}</p>
        <p><a href="/manager" class="btn-link">← Volver</a></p>
      </div>
    `;
    res.status(500).send(renderPage("Error Sync", html));
  }
});
//vremenno45

app.get("/manager/channels/bookings-all", async (req, res) => {
  try {
    const from = String(req.query.from || "2025-01-01");
    const to = String(req.query.to || "2026-12-31");

    const rooms = await pool.query(`
      SELECT beds24_room_id, beds24_prop_key, apartment_name
      FROM beds24_rooms
      WHERE is_active = true AND beds24_prop_key IS NOT NULL
      ORDER BY apartment_name ASC
    `);

    const out = [];

    for (const r of rooms.rows) {
      try {
        const url = "https://api.beds24.com/json/getBookings"; // если у тебя другой endpoint — оставь тот, который сейчас работает
        const payload = {
          propKey: r.beds24_prop_key,
          roomId: String(r.beds24_room_id),
          from,
          to,
        };

        const data = await beds24PostJson(url, payload);

        const count = Array.isArray(data) ? data.length : (data?.bookings?.length || 0);

        out.push({
          apartment: r.apartment_name,
          roomId: r.beds24_room_id,
          count,
          sample: Array.isArray(data)
            ? data.slice(0, 2).map(x => ({ bookId: x.bookId, firstNight: x.firstNight, lastNight: x.lastNight, status: x.status }))
            : (data?.bookings || []).slice(0, 2).map(x => ({ bookId: x.bookId, firstNight: x.firstNight, lastNight: x.lastNight, status: x.status })),
        });
      } catch (e) {
        out.push({
          apartment: r.apartment_name,
          roomId: r.beds24_room_id,
          error: String(e.message || e),
        });
      }
    }

    res.json({ from, to, rooms: rooms.rows.length, out });
  } catch (err) {
    console.error(err);
    res.status(500).send(String(err.message || err));
  }
});
//vremenno45
// страница со списком апартаментов (Beds24 rooms mapping)
app.get("/manager/settings/apartments", async (req, res) => {
  try {
    const top = `<p style="margin:0 0 12px;"><a class="btn-link" href="/manager">← Manager</a></p>`;

    const { rows } = await pool.query(`
      SELECT id, beds24_room_id, beds24_prop_key, apartment_name, is_active
      FROM beds24_rooms
      ORDER BY apartment_name ASC
    `);

    const listHtml = rows
      .map(
        (r) => `
          <tr>
            <td>${escapeHtml(maskKey(r.beds24_prop_key))}</td>
            <td>${escapeHtml(String(r.beds24_room_id ?? ""))}</td>
            <td>${escapeHtml(r.apartment_name ?? "")}</td>
            <td>${r.is_active ? "✅" : "❌"}</td>
            <td>
              <form method="POST" action="/manager/settings/apartments/toggle" style="display:inline;">
                <input type="hidden" name="id" value="${r.id}">
                <button type="submit">${r.is_active ? "Disable" : "Enable"}</button>
              </form>
            </td>
          </tr>
        `
      )
      .join("");

    res.send(`
      ${top}
      <h2>Apartments (synced) from your channel manager</h2>
      < border="1" cellpadding="8" cellspacing="0">
        <thead>
          <tr>
            <th>Property key</th>
            <th>Room ID</th>
            <th>Apartment</th>
            <th>Active</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${listHtml}
        </tbody>
      </>
    `);
  } catch (err) {
    console.error("❌ manager apartments page error:", err);
    res.status(500).send("Error");
  }
});
//vremenno
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
app.post("/manager/apartment/save", async (req, res) => {
  try {
    const id = Number(req.body.id);

    const {
      apartment_name,
      default_arrival_time,
      default_departure_time,
      registration_url,
      payment_url,
      keys_instructions_url,
    } = req.body;

    await pool.query(
      `
      UPDATE beds24_rooms
      SET
        apartment_name = $2,
        default_arrival_time = $3,
        default_departure_time = $4,
        registration_url = $5,
        payment_url = $6,
        keys_instructions_url = $7,
        updated_at = now()
      WHERE id = $1
      `,
      [
        id,
        apartment_name,
        default_arrival_time,
        default_departure_time,
        registration_url,
        payment_url,
        keys_instructions_url,
      ]
    );

    res.redirect(`/manager?aptId=${encodeURIComponent(String(id))}`);
  } catch (err) {
    console.error("❌ /manager/apartment/save error:", err);
    res.status(500).send("Save apartment error");
  }
});

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
//vremenno3
//vremenno
// показать настройки

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

















































































































































































































































































































































