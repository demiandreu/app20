// =====================================================
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

const PORT = process.env.PORT || 3000;

// ===================== DB: ENV CHECK =====================
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in env");
  process.exit(1);
}

const isLocalDb =
  process.env.DATABASE_URL.includes("localhost") ||
  process.env.DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// ===================== HELPER FUNCTIONS =====================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
  a.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const ms = d - a;
  const n = Math.floor(ms / 86400000);
  return n > 0 ? n : "";
}

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

function maskKey(k) {
  k = String(k || "");
  if (!k) return "";
  if (k.length <= 10) return k;
  return k.slice(0, 4) + "…" + k.slice(-4);
}

function safeTime(val) {
  const s = String(val || "");
  return s.length >= 5 ? s.slice(0, 5) : "";
}

// ===================== DB INIT / MIGRATIONS =====================
async function initDb() {
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

  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_code TEXT;`);
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_visible BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS clean_ok BOOLEAN NOT NULL DEFAULT FALSE;`);
  
  await pool.query(`
    ALTER TABLE checkins
      ADD COLUMN IF NOT EXISTS beds24_booking_id BIGINT,
      ADD COLUMN IF NOT EXISTS beds24_room_id TEXT,
      ADD COLUMN IF NOT EXISTS apartment_name TEXT,
      ADD COLUMN IF NOT EXISTS booking_id TEXT,
      ADD COLUMN IF NOT EXISTS beds24_raw JSONB,
      ADD COLUMN IF NOT EXISTS adults INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS children INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS booking_id_from_start TEXT,
      ADD COLUMN IF NOT EXISTS reg_done BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS pay_done BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reg_done_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pay_done_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_booking_id ON checkins(booking_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_booking_token ON checkins(booking_token);`);

  console.log("✅ DB ready: checkins table ok");
}

// ===================== TWILIO CLIENT =====================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

if (!twilioClient) {
  console.log("ℹ️ Twilio not configured yet");
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

// ===================== BEDS24 API =====================
async function beds24PostJson(url, body, apiKeyOverride) {
  const apiKey = apiKeyOverride || process.env.BEDS24_API_KEY;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token: apiKey
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

function mapBeds24BookingToRow(b, apartmentName = "", apartmentId = "") {
  const bookingId = String(b.bookId || b.id || "").trim();
  const roomId = String(b.roomId || "").trim();

  const arrivalDate = String(b.firstNight || b.arrival || "").slice(0, 10);
  const departureDate = String(b.lastNight || b.departure || "").slice(0, 10);

  const adults = Number(b.numAdult ?? b.adults ?? 0) || 0;
  const children = Number(b.numChild ?? b.children ?? 0) || 0;

  const fullName = String(
    [b.guestFirstName, b.guestName].filter(Boolean).join(" ").trim() || "Guest"
  );
  const email = String(b.guestEmail || "").trim() || "unknown@unknown";
  const phone = String(b.guestPhone || b.guestMobile || "").trim() || "+000";

  const arrivalTime = String(b.guestArrivalTime || "16:00").slice(0, 5) + ":00";
  const departureTime = "11:00:00";

  return {
    beds24_booking_id: bookingId ? Number(bookingId) : null,
    beds24_room_id: roomId || null,
    apartment_name: apartmentName || null,
    apartment_id: apartmentId || roomId || "unknown",
    booking_token: bookingId || (roomId + "-" + Date.now()),
    full_name: fullName,
    email,
    phone,
    arrival_date: arrivalDate,
    arrival_time: arrivalTime,
    departure_date: departureDate,
    departure_time: departureTime,
    adults,
    children,
    beds24_raw: b,
  };
}

async function upsertCheckinFromBeds24(row) {
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

// ===================== HTML LAYOUT =====================
function renderPage(title, innerHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      background: #f6f7fb;
      color: #111827;
      margin: 0;
      padding: 16px;
    }
    .card {
      background: #fff;
      border-radius: 18px;
      padding: 20px;
      max-width: 1100px;
      margin: 0 auto;
    }
    h1 { font-size: 22px; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f9fafb; padding: 8px; text-align: left; }
    td { padding: 8px; border-bottom: 1px solid #f1f5f9; }
    input, select { padding: 8px; border-radius: 8px; border: 1px solid #ddd; }
    button { padding: 8px 16px; border-radius: 8px; border: none; background: #2563eb; color: #fff; cursor: pointer; }
    .btn-link { color: #2563eb; text-decoration: none; }
    .muted { color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    ${innerHtml}
  </div>
</body>
</html>`;
}

// ===================== ROUTES =====================

app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p class="muted">Admin: <a class="btn-link" href="/staff/checkins">Staff Check-ins</a></p>
    <p class="muted">Manager: <a class="btn-link" href="/manager">Manager</a></p>
  `;
  res.send(renderPage("Home", html));
});

// ===================== STAFF ROUTES =====================

app.get("/staff/checkins", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM checkins
      ORDER BY arrival_date DESC
      LIMIT 100
    `);

    const tbody = rows.map(r => `
      <tr>
        <td>${r.id}</td>
        <td>${r.apartment_name || r.apartment_id}</td>
        <td>${r.full_name}</td>
        <td>${r.arrival_date}</td>
        <td>${r.departure_date}</td>
      </tr>
    `).join("");

    const html = `
      <h1>Staff Check-ins</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Apartment</th>
            <th>Guest</th>
            <th>Arrival</th>
            <th>Departure</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    `;

    res.send(renderPage("Staff Check-ins", html));
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// ===================== MANAGER ROUTES =====================

app.get("/manager", async (req, res) => {
  const html = `
    <h1>Manager</h1>
    <ul>
      <li><a href="/staff/checkins">Staff Check-ins</a></li>
    </ul>
  `;
  res.send(renderPage("Manager", html));
});

// ===================== WEBHOOKS =====================

app.post("/webhooks/beds24", async (req, res) => {
  try {
    const secret = String(req.query.key || "");
    if (secret !== String(process.env.BEDS24_SECRET || "")) {
      console.log("❌ Beds24 webhook: invalid secret");
      return res.status(401).send("Unauthorized");
    }

    const payload = req.body || {};
    const booking = payload.booking || payload;

    if (!booking || !booking.id) {
      console.log("ℹ️ Beds24 webhook: no booking.id, ignored");
      return res.status(200).send("Ignored");
    }

    console.log("✅ Booking received:", booking.id);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
  }
});

app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  console.log("🔥 TWILIO HIT", req.body);
  res.status(200).send("OK");
});

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
