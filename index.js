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

   //vremenno
// ===================== MANAGER: Debug =====================
app.get("/manager/channels/debug", (req, res) => {
  res.send(`
    <h1>Debug</h1>
    <p>OK</p>
    <ul>
      <li><a href="/manager/channels/sync">Sync</a></li>
      <li><a href="/manager/settings/apartments">Apartments</a></li>
    </ul>
  `);
});
    //vremenno

//vremenno
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
//vremenno

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

// ===================== DB INIT / MIGRATIONS =====================
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

// ===================== APP SETTINGS / DATA =====================
const PARTEE_LINKS = {
  apt1: "https://u.partee.es/3636642/Cd78OQqWOB63wMJLFmB0JzdLL",
  // apt2: "...",
};

// ===================== HELPERS =====================
function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ===================== TWILIO WHATSAPP INBOUND (START_<id> + LISTO) =====================
app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  try {
    const from = String(req.body.From || ""); // "whatsapp:+34..."
    const body = String(req.body.Body || "").trim();

    console.log("📩 Twilio WhatsApp inbound:", { from, body });

    const phone = from.replace("whatsapp:", "").trim(); // "+34..."
    const textUpper = body.toUpperCase();

    // ----------------- 1) START_<ID> -----------------
    if (textUpper.startsWith("START_")) {
      const bookingId = textUpper.replace("START_", "").trim();

      const bookingResult = await pool.query(
        `
        SELECT
          apartment_id,
          apartment_name,
          booking_token,
          full_name,
          arrival_date,
          arrival_time,
          departure_date,
          departure_time,
          adults,
          children
        FROM checkins
        WHERE booking_token = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [bookingId]
      );

      if (!bookingResult.rows.length) {
        await sendWhatsApp(
          from,
          `Gracias 😊  
Aún no encuentro tu reserva en el sistema.

Si acabas de reservar, espera unos minutos y vuelve a enviar:
START_${bookingId}`
        );
        return res.status(200).send("OK");
      }

      const r = bookingResult.rows[0];

    // ---- data from DB (checkins table) ----
const adults = r.adults ?? 0;
const children = r.children ?? 0;

const arrivalDate = r.arrival_date;
const arrivalTime = r.arrival_time;
const departureDate = r.departure_date;
const departureTime = r.departure_time;

console.log("👥 Guests from DB:", { adults, children });

      
//vremenno

      let guestsLine = "";
      if (adults || children) {
        const parts = [];
        if (adults) parts.push(`${adults} adulto${adults === 1 ? "" : "s"}`);
        if (children) parts.push(`${children} niño${children === 1 ? "" : "s"}`);
        guestsLine = `Huéspedes: ${parts.join(", ")}\n`;
      }

      // Manager defaults (times)
      const settingsResult = await pool.query(
        `SELECT default_arrival_time, default_departure_time FROM app_settings WHERE id = 1 LIMIT 1`
      );

      const settings = settingsResult.rows[0] || {
        default_arrival_time: "15:00",
        default_departure_time: "11:00",
      };

      const arrivalTimeFinal = r.arrival_time || settings.default_arrival_time;
      const departureTimeFinal = r.departure_time || settings.default_departure_time;

      const name = r.full_name || "Hola";
      const apt = r.apartment_name || r.apartment_id || "";

      const arrive = `${String(r.arrival_date).slice(0, 10)} ${String(arrivalTimeFinal).slice(0, 5)}`;
      const depart = `${String(r.departure_date).slice(0, 10)} ${String(departureTimeFinal).slice(0, 5)}`;

      await sendWhatsApp(
        from,
        `Hola, ${name} 👋

Tu reserva está confirmada ✅
Apartamento: ${apt}
Entrada: ${arrive}
Salida: ${depart}
${guestsLine}
Para enviarte las instrucciones de acceso y el código de la caja de llaves, primero necesito 2 pasos:

1) Registro de huéspedes
2) Pago (tasa turística + depósito, según la plataforma)

Cuando lo tengas listo, responde aquí: LISTO`
      );

      return res.status(200).send("OK");
    }

    // ----------------- 2) LISTO -----------------
    if (textUpper === "LISTO") {
      const result = await pool.query(
        `
        SELECT apartment_id, booking_token
        FROM checkins
        WHERE phone = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [phone]
      );

      if (!result.rows.length) {
        await sendWhatsApp(
          from,
          `Gracias 😊  
Aún no encuentro tu reserva en el sistema.
Si acabas de reservar, espera unos minutos y vuelve a escribir LISTO.`
        );
        return res.status(200).send("OK");
      }

      const { apartment_id, booking_token } = result.rows[0];

      const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      const link = `${base}/guest/${encodeURIComponent(apartment_id)}/${encodeURIComponent(booking_token)}`;

      await sendWhatsApp(
        from,
        `Perfecto ✅

Aquí tienes tu portal con la información del apartamento:
${link}

ℹ️ El código de acceso aparecerá el día de llegada cuando el anfitrión lo active.`
      );

      return res.status(200).send("OK");
    }

    // ----------------- 3) default -----------------
    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ WhatsApp inbound error:", err);
    return res.status(200).send("OK");
  }
});


// ===================== TWILIO WHATSAPP INBOUND (LISTO -> ACK) =====================
/* app.post("/webhooks/twilio/whatsapp", async (req, res) => {
  try {
    const from = String(req.body.From || ""); // "whatsapp:+34..."
    const body = String(req.body.Body || "");
    console.log("📩 Twilio WhatsApp inbound:", { from, body });

    // нормализация текста
    const text = body.trim().toLowerCase();

    // пока реагируем только на "listo"
    if (text !== "listo") {
      return res.status(200).send("OK");
    }

    // ответ тестовый (пока без ссылки/логики)
    if (!twilioClient) {
      console.log("ℹ️ twilioClient is null (missing creds), cannot reply");
      return res.status(200).send("OK");
    }

    const fromNumber = process.env.TWILIO_WHATSAPP_FROM || "";
    if (!fromNumber) {
      console.log("ℹ️ TWILIO_WHATSAPP_FROM missing, cannot reply");
      return res.status(200).send("OK");
    }

    await twilioClient.messages.create({
      from: fromNumber,      // должен быть "whatsapp:+1937..."
      to: from,              // ответим тому же отправителю
      body: "Perfecto ✅ Hemos recibido tu mensaje. En breve te envío el enlace al portal.",
    });

    console.log("✅ Replied to WhatsApp:", from);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ Twilio inbound handler error:", e);
    return res.status(200).send("OK");
  }
}); */



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
  .lock-form .btn-small.btn-ghost,
  .lock-form button{
    white-space:nowrap;
  }

  td{
    white-space:nowrap;
    vertical-align:middle;
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
  }

  .table-wrap {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  table {
    min-width: 1100px;
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

  .btn-primary, .btn-success, .btn-link, .btn{
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
  .btn-primary{ background:#2563eb; color:#fff; }
  .btn-success{ background:#16a34a; color:#fff; }
  .btn-link{
    background:transparent;
    color:#2563eb;
    padding:0;
    font-weight:600;
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
    white-space:nowrap;
    vertical-align:middle;
  }
  tr:hover td{ background:#f9fafb; }

  /* компактнее статус-пилюли */
  .pill{
    display:inline-block;
    padding:4px 8px;
    border-radius:999px;
    font-weight:800;
    font-size:11px;
    line-height:1;
  }
  .pill-yes{ background:#dcfce7; color:#166534; }
  .pill-no{ background:#fee2e2; color:#991b1b; }

  /* компактнее формы/кнопки */
  .lock-form{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; }

  .lock-input{
    width:110px;
    min-width:110px;
    padding:8px 10px;
    border-radius:10px;
    border:1px solid #d1d5db;
    font-size:14px;
    letter-spacing:0.12em;
  }

  .btn-small{
    border-radius:999px;
    padding:7px 10px;
    font-weight:700;
    border:none;
    cursor:pointer;
    background:#2563eb;
    color:#fff;
    font-size:12px;
    line-height:1;
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
//vremenno
async function beds24PostJson(url, data) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Beds24 API non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    throw new Error(`Beds24 API HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}
//vremenno
// ===================== Beds24 Webhook (receiver) =====================


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
app.get("/guest/:aptId/:token", async (req, res) => {
  const { aptId, token } = req.params;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id, apartment_id, booking_token,
        full_name, email, phone,
        arrival_date, arrival_time,
        departure_date, departure_time,
        lock_code, lock_visible
      FROM checkins
      WHERE apartment_id = $1 AND booking_token = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [aptId, token]
    );

    if (!rows.length) {
      const html = `
        <h1>Guest Dashboard</h1>
        <p class="muted">No check-in record found for this booking.</p>
        <p><a class="btn-link" href="/">← Back</a></p>
      `;
      return res.send(renderPage("Guest Dashboard", html));
    }

  const r = rows[0];

    const adults = Number(r.adults ?? 0);
const children = Number(r.children ?? 0);

let guestsLine = "";
if (adults || children) {
  const parts = [];
  if (adults) parts.push(`${adults} adulto${adults === 1 ? "" : "s"}`);
  if (children) parts.push(`${children} niño${children === 1 ? "" : "s"}`);
  guestsLine = `Huéspedes: ${parts.join(", ")}\n`;
}


    // Spain date for "today"
    const todayES = ymdInTz(new Date(), "Europe/Madrid");

    // show code only when:
    // 1) admin enabled lock_visible
    // 2) today >= arrival_date (NOTE: comment only; current behavior checks only visible+code)
    const arrivalYmd = String(r.arrival_date).slice(0, 10);
    const canShowCode = Boolean(r.lock_visible) && r.lock_code;

    const arrive = `${String(r.arrival_date).slice(0, 10)} ${String(r.arrival_time).slice(0, 5)}`;
    const depart = `${String(r.departure_date).slice(0, 10)} ${String(r.departure_time).slice(0, 5)}`;

    const codeBlock = canShowCode
      ? `
        <div style="margin-top:14px; padding:14px; border:1px solid #bbf7d0; background:#f0fdf4; border-radius:14px;">
          <h2 style="margin:0 0 6px; font-size:16px;">Key box code</h2>
          <p class="muted" style="margin-bottom:10px;">Keep it private.</p>
          <div style="font-size:28px; font-weight:900; letter-spacing:0.18em;">${String(r.lock_code)}</div>
        </div>
      `
      : `
        <div style="margin-top:14px; padding:14px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:14px;">
          <h2 style="margin:0 0 6px; font-size:16px;">Key box code</h2>
          <p class="muted" style="margin:0;">
            The code will appear here on the arrival day after all steps are completed.
          </p>
        </div>
      `;

    const html = `
      <h1>Guest Dashboard</h1>
      <p class="muted">Booking: <strong>${token}</strong> • Apartment: <strong>${aptId}</strong></p>

      <div style="margin-top:12px; padding:14px; border:1px solid #e5e7eb; background:#fff; border-radius:14px;">
        <h2 style="margin:0 0 10px; font-size:16px;">Your stay</h2>
        <p style="margin:0 0 6px;"><strong>Arrival:</strong> ${arrive}</p>
        <p style="margin:0;"><strong>Departure:</strong> ${depart}</p>
      </div>

      ${codeBlock}

      <p style="margin-top:16px;">
        <a class="btn-link" href="/">← Back</a>
      </p>
    `;

    res.send(renderPage("Guest Dashboard", html));
  } catch (e) {
    console.error("Guest dashboard error:", e);
    res.status(500).send("❌ Cannot load guest dashboard");
  }
});

// --- LIST + FILTER ---
app.get("/staff/checkins", async (req, res) => {
  try {
    // --- read query ---
    const { from, to, quick: quickRaw } = req.query;

    // --- timezone helpers for Spain ---
    const tz = "Europe/Madrid";
    const today = ymdInTz(new Date(), tz);
    const tomorrow = ymdInTz(new Date(Date.now() + 86400000), tz);
    const yesterday = ymdInTz(new Date(Date.now() - 86400000), tz);

    // ✅ Default: if opened without filters, show "today"
    const hasAnyFilter = Boolean(from || to || quickRaw);
    const quickCandidate = hasAnyFilter ? quickRaw : "today";

    const quick =
      quickCandidate === "yesterday" ||
      quickCandidate === "today" ||
      quickCandidate === "tomorrow"
        ? quickCandidate
        : "";

    // ✅ Приоритет: если quick выбран — он главнее дат
    let fromDate = from;
    let toDate = to;

    if (quick) {
      if (quick === "yesterday") {
        fromDate = yesterday;
        toDate = yesterday;
      } else if (quick === "today") {
        fromDate = today;
        toDate = today;
      } else if (quick === "tomorrow") {
        fromDate = tomorrow;
        toDate = tomorrow;
      }
    }

    // ----------------------------
    // helpers: build WHERE for field
    // ----------------------------
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

    // ----------------------------
    // ARRIVALS query (arrival_date)
    // ----------------------------
    const wArr = buildWhereFor("arrival_date");
    const arrivalsRes = await pool.query(
      `
      SELECT
        id,
        beds24_booking_id,
        apartment_name,
        apartment_id,
        booking_token,
        full_name,
        phone,
        arrival_date,
        arrival_time,
        departure_date,
        departure_time,
        adults,
        children,
        lock_code,
        lock_visible,
        clean_ok
      FROM checkins
      ${wArr.whereSql}
      ORDER BY arrival_date ASC, arrival_time ASC, id DESC
      LIMIT 300
      `,
      wArr.params
    );

    // ----------------------------
    // DEPARTURES query (departure_date)
    // ----------------------------
    const wDep = buildWhereFor("departure_date");
    const departuresRes = await pool.query(
      `
      SELECT
        id,
        beds24_booking_id,
        apartment_name,
        apartment_id,
        booking_token,
        full_name,
        phone,
        arrival_date,
        arrival_time,
        departure_date,
        departure_time,
        adults,
        children,
        lock_code,
        lock_visible,
        clean_ok
      FROM checkins
      ${wDep.whereSql}
      ORDER BY departure_date ASC, departure_time ASC, id DESC
      LIMIT 300
      `,
      wDep.params
    );

    const arrivals = arrivalsRes.rows || [];
    const departures = departuresRes.rows || [];

    // ----------------------------
    // UI Toolbar (общий диапазон дат)
    // ----------------------------
    const toolbar = `
      <h1>Staff • Arrivals & Departures</h1>
      <p class="muted">Choose date range (Spain timezone)</p>

      <form class="toolbar" method="GET" action="/staff/checkins">
        <div>
          <label>Date range (from → to)</label>
          <div style="display:flex; gap:6px; align-items:center;">
            <input type="date" name="from" value="${fromDate || ""}" style="max-width:140px;" />
            <span style="opacity:0.6;">→</span>
            <input type="date" name="to" value="${toDate || ""}" style="max-width:140px;" />
          </div>
        </div>

        <div style="display:flex; gap:10px; align-items:flex-end;">
          <button class="btn-base" type="submit">Show</button>
          <a class="btn-link" href="/staff/checkins">Reset</a>
        </div>

        <div style="flex-basis:100%; height:8px;"></div>

        <div>
          <p class="muted" style="margin:0 0 8px;">Quick filters</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <a class="btn-base ${quick === "yesterday" ? "btn-ghost" : ""}" href="/staff/checkins?quick=yesterday">Yesterday</a>
            <a class="btn-base ${quick === "today" ? "btn-ghost" : ""}" href="/staff/checkins?quick=today">Today</a>
            <a class="btn-base ${quick === "tomorrow" ? "btn-ghost" : ""}" href="/staff/checkins?quick=tomorrow">Tomorrow</a>
          </div>
        </div>
      </form>
    `;

    // ----------------------------
    // Table renderer (одна функция для обеих таблиц)
    // mode: "arrivals" | "departures"
    // ----------------------------
    function renderTable(rows, mode) {
      const title =
        mode === "departures"
          ? `Departures <span class="muted">(${rows.length})</span>`
          : `Arrivals <span class="muted">(${rows.length})</span>`;

      const dateColTitle = mode === "departures" ? "Depart" : "Arrive";

      const tbody =
        rows.length
          ? rows
              .map((r) => {
                const arrive = `${String(r.arrival_date).slice(0, 10)} ${String(r.arrival_time).slice(0, 5)}`;
                const depart = `${String(r.departure_date).slice(0, 10)} ${String(r.departure_time).slice(0, 5)}`;
                const mainDate = mode === "departures" ? depart : arrive;

                return `
                  <tr>
                    <td class="sticky-col">
                      <form method="POST" action="/staff/checkins/${r.id}/clean">
                        <button
                          type="submit"
                          class="clean-btn ${r.clean_ok ? "pill-yes" : "pill-no"}"
                          title="${r.clean_ok ? "Clean" : "Not clean"}"
                        >
                          ${r.clean_ok ? "✓" : ""}
                        </button>
                      </form>
                    </td>

                    <td>${r.booking_token ?? ""}</td>
                    <td>${r.apartment_name ?? ""}</td>
                    <td>${r.full_name ?? ""}</td>
                    <td>${r.phone ?? ""}</td>
                    <td>${(r.adults ?? 0)}|${(r.children ?? 0)}</td>

                    <td>${mainDate}</td>

                    <td>
                      <a class="btn-small btn-ghost" href="/guest/${r.apartment_id}/${r.booking_token}" target="_blank">
                        Open
                      </a>
                    </td>

                    <td>
                      <form method="POST" action="/staff/checkins/${r.id}/lock" class="lock-form">
                        <input
                          class="lock-input"
                          name="lock_code"
                          value="${r.lock_code ?? ""}"
                          inputmode="numeric"
                          pattern="\\d{4}"
                          maxlength="4"
                          placeholder="1234"
                        />
                        <button class="btn-base" type="submit">Save</button>
                        <button class="btn-base btn-ghost" type="submit" name="clear" value="1">Clear</button>
                      </form>
                    </td>

                    <td>
                      <form method="POST" action="/staff/checkins/${r.id}/visibility" class="vis-form">
                        <span class="pill ${r.lock_visible ? "pill-yes" : "pill-no"}">${r.lock_visible ? "🔓 YES" : "🔒 NO"}</span>
                        <button class="btn-small ${r.lock_visible ? "btn-ghost" : ""}" type="submit" name="makeVisible" value="${r.lock_visible ? "0" : "1"}">
                          ${r.lock_visible ? "Hide" : "Show"}
                        </button>
                      </form>
                    </td>

                    <td>
                      <form method="POST" action="/staff/checkins/${r.id}/delete"
                        onsubmit="return confirm('Are you sure you want to delete this booking?');">
                        <input type="hidden" name="returnTo" value="${escapeHtml(req.originalUrl)}" />
                        <button class="btn-small btn-ghost" type="submit">Delete</button>
                      </form>
                    </td>
                  </tr>
                `;
              })
              .join("")
          : `<tr><td colspan="11" class="muted">No records</td></tr>`;

      return `
        <h2 style="margin:18px 0 10px;">${title}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sticky-col">Clean</th>
                <th>Id</th>
                <th>Apartment</th>
                <th>Name</th>
                <th>Phone</th>
                <th>A|C</th>
                <th>${dateColTitle}</th>
                <th>Guest</th>
                <th>Lock code</th>
                <th>Visible</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>${tbody}</tbody>
          </table>
        </div>
      `;
    }

    const pageHtml =
      toolbar +
      renderTable(arrivals, "arrivals") +
      `<div style="height:18px;"></div>` +
      renderTable(departures, "departures");

    // ✅ title тоже исправляем
    res.send(renderPage("Staff • Arrivals & Departures", pageHtml));
  } catch (e) {
    console.error("Staff list error:", e);
    res.status(500).send("❌ Cannot load checkins");
  }
});


// ===================== ADMIN: LOCK CODE SAVE (REPLACE, NOT APPEND) =====================
app.post("/staff/checkins/:id/lock", async (req, res) => {
  const id = Number(req.params.id);

  // ✅ sometimes body can become array; take last
  const raw = req.body.lock_code;
  const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;

  let lockCode = String(last ?? "").trim();
  if (req.body.clear === "1") lockCode = "";

  // ✅ digits only + max 4
  lockCode = lockCode.replace(/\D/g, "").slice(0, 4);

  try {
    await pool.query(`UPDATE checkins SET lock_code = $1 WHERE id = $2`, [
      lockCode || null,
      id,
    ]);
    const back = req.body.returnTo || req.get("referer") || "/staff/checkins";
    res.redirect(back);
  } catch (e) {
    console.error("Lock code update error:", e);
    res.status(500).send("❌ Cannot update lock code");
  }
});

// ===================== ADMIN: SET VISIBILITY =====================
app.post("/staff/checkins/:id/visibility", async (req, res) => {
  const id = Number(req.params.id);
  const makeVisible = String(req.body.makeVisible) === "1";

  try {
    await pool.query(`UPDATE checkins SET lock_visible = $1 WHERE id = $2`, [
      makeVisible,
      id,
    ]);
    const back = req.body.returnTo || req.get("referer") || "/staff/checkins";
    res.redirect(back);
  } catch (e) {
    console.error("Visibility update error:", e);
    res.status(500).send("❌ Cannot update visibility");
  }
});

// ===================== ADMIN: CLEAN TOGGLE =====================
app.post("/staff/checkins/:id/clean", async (req, res) => {
  const id = Number(req.params.id);

  try {
    await pool.query(`UPDATE checkins SET clean_ok = NOT clean_ok WHERE id = $1`, [id]);
    const back = req.body.returnTo || req.get("referer") || "/staff/checkins";
    res.redirect(back);
  } catch (e) {
    console.error("Clean toggle error:", e);
    res.status(500).send("❌ Cannot toggle clean status");
  }
});
// ===================== MANAGER SETTINGS =====================

//vremenno1
// ===================== MANAGER: Sync Beds24 Rooms =====================

app.get("/manager/channels/sync", async (req, res) => {
  try {
    const API_KEY = process.env.BEDS24_API_KEY;
    if (!API_KEY) {
      return res.status(500).send("❌ BEDS24_API_KEY not set");
    }

    const propertiesResp = await beds24PostJson(
      "https://api.beds24.com/json/getProperties",
      {
        authentication: { apiKey: API_KEY },
      }
    );
 

    const properties = Array.isArray(propertiesResp?.getProperties)
      ? propertiesResp.getProperties
      : [];

    if (!properties.length) {
      return res.send("⚠️ No properties found in Beds24");
    }

    const rooms = [];

    for (const p of properties) {
      const propertyName = p?.name || "";
      const roomTypes = Array.isArray(p?.roomTypes) ? p.roomTypes : [];

      for (const rt of roomTypes) {
        if (!rt?.roomId) continue;

        rooms.push({
          beds24_room_id: String(rt.roomId),
          apartment_name: (rt.name || propertyName || "").trim(),
        });
      }
    }

    if (!rooms.length) {
      return res.send("⚠️ No roomTypes found in Beds24");
    }

    let inserted = 0;
    let updated = 0;

    for (const r of rooms) {
      const result = await pool.query(
        `
        INSERT INTO beds24_rooms (beds24_room_id, apartment_name, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (beds24_room_id)
        DO UPDATE SET
          apartment_name = EXCLUDED.apartment_name,
          is_active = true,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
        `,
        [r.beds24_room_id, r.apartment_name]
      );

      if (result.rows[0].inserted) inserted++;
      else updated++;
    }

    res.send(
      `✅ Sync done. Rooms: ${rooms.length}. Inserted: ${inserted}, Updated: ${updated}`
    );
  } catch (err) {
    console.error("❌ Beds24 sync error:", err);
    res.status(500).send("Beds24 sync failed");
  }
});
    
// ===================== MANAGER: Beds24 Rooms mapping =====================

// страница со списком и формой добавления
app.get("/manager/settings/apartments", async (req, res) => {
  try {
    const rows = await pool.query(
      `
      SELECT id, beds24_room_id, apartment_name, is_active, created_at, updated_at
      FROM beds24_rooms
      ORDER BY apartment_name ASC
      `
    );

    const listHtml = rows.rows
      .map(
        (r) => `
        <tr>
          <td>${escapeHtml(r.beds24_room_id)}</td>
          <td>${escapeHtml(r.apartment_name)}</td>
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
      <h2>Apartments (synced) from your channel manager</h2>
      <table border="1" cellpadding="8" cellspacing="0">
        <thead>
          <tr>
            <th>beds24_room_id</th>
            <th>apartment_name</th>
            <th>active</th>
            <th>action</th>
          </tr>
        </thead>
        <tbody>${listHtml || ""}</tbody>
      </table>
    `);
  } catch (err) {
    console.error("❌ manager apartments page error:", err);
    res.status(500).send("Error");
  }
});

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
//vremenno
// показать настройки
app.get("/manager/settings", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM app_settings WHERE id = 1`
  );

  const s = rows[0];

  res.send(`
    <h1>Manager Settings</h1>

    <form method="POST">
      <label>Brand name</label><br/>
      <input name="brand_name" value="${s.brand_name}" /><br/><br/>

      <label>Default arrival time</label><br/>
      <input type="time" name="default_arrival_time" value="${s.default_arrival_time.slice(0,5)}" /><br/><br/>

      <label>Default departure time</label><br/>
      <input type="time" name="default_departure_time" value="${s.default_departure_time.slice(0,5)}" /><br/><br/>

      <button type="submit">Save</button>
    </form>
  `);
});
// сохранить настройки
app.post("/manager/settings", async (req, res) => {
  const {
    brand_name,
    default_arrival_time,
    default_departure_time
  } = req.body;

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

  res.redirect("/manager/settings");
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
















































































