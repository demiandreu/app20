// ===================== CONFIG =====================
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// ======================
// Beds24 Webhook (receiver)
// ======================
app.post("/webhooks/beds24", async (req, res) => {
  const secret = String(req.query.key || "");
  if (secret !== String(process.env.BEDS24_SECRET)) {
    console.log("❌ Beds24 webhook: invalid secret");
    return res.status(401).send("Unauthorized");
  }

  const payload = req.body;
  // debug: сохраним сырой webhook в БД (и/или залогируем)
console.log("📦 Beds24 payload keys:", Object.keys(payload || {}));
  const booking = payload.booking || payload; // на всякий случай
  // --- dates / ids from Beds24 ---

const beds24Raw = payload;
  const guest = payload.guest || booking.guest || booking.guestData || {};

const fullName =
  guest.name ||
  [guest.firstName, guest.lastName].filter(Boolean).join(" ") ||
  guest.fullName ||
  "Beds24 Guest";

const email =
  guest.email ||
  guest.emailAddress ||
  "unknown@beds24";

const phone =
  guest.phone ||
  guest.mobile ||
  guest.phoneNumber ||
  "";

  if (!booking || !booking.id) {
    console.log("ℹ️ Beds24 webhook: no booking object, ignored");
    return res.status(200).send("Ignored");
  }

  console.log("✅ Booking received:", booking.id);
  
const arrivalDate =
  booking?.arrival?.date ||
  booking?.arrivalDate ||
  booking?.checkin?.date ||
  booking?.checkinDate ||
  null;

const departureDate =
  booking?.departure?.date ||
  booking?.departureDate ||
  booking?.checkout?.date ||
  booking?.checkoutDate ||
  null;

const arrivalTime = booking?.arrival?.time || booking?.arrivalTime || null;
const departureTime = booking?.departure?.time || booking?.departureTime || null;
  
  try {

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
    beds24_raw
  )
  VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8,
    $9, $10, $11, $12,
    $13::jsonb
  )
  ON CONFLICT (booking_token)
  DO UPDATE SET
    apartment_id = EXCLUDED.apartment_id,

    beds24_booking_id = COALESCE(
      EXCLUDED.beds24_booking_id,
      checkins.beds24_booking_id
    ),
    beds24_room_id = COALESCE(
      EXCLUDED.beds24_room_id,
      checkins.beds24_room_id
    ),
    apartment_name = COALESCE(
      EXCLUDED.apartment_name,
      checkins.apartment_name
    ),

    full_name = EXCLUDED.full_name,
    email     = EXCLUDED.email,
    phone     = EXCLUDED.phone,

    arrival_date = COALESCE(
      EXCLUDED.arrival_date,
      checkins.arrival_date
    ),
    arrival_time = COALESCE(
      EXCLUDED.arrival_time,
      checkins.arrival_time
    ),
    departure_date = COALESCE(
      EXCLUDED.departure_date,
      checkins.departure_date
    ),
    departure_time = COALESCE(
      EXCLUDED.departure_time,
      checkins.departure_time
    ),

    beds24_raw = COALESCE(
      EXCLUDED.beds24_raw,
      checkins.beds24_raw
    )
  `,
  [
    String(beds24RoomId || booking?.roomId || ""), // apartment_id
    String(booking?.id || ""),                     // booking_token
    beds24BookingId,                               // beds24_booking_id
    String(beds24RoomId || ""),                    // beds24_room_id
    apartmentName,                                 // apartment_name

    fullName,
    email,
    phone,

    arrivalDate,
    arrivalTime,
    departureDate,
    departureTime,

    JSON.stringify(beds24Raw)                      // jsonb
  ]
);
    
  /* await pool.query(
  `
  INSERT INTO checkins (
    apartment_id,
    booking_token,
    beds24_booking_id,
    beds24_room_id,
    full_name,
    email,
    phone,
    arrival_date,
    arrival_time,
    departure_date,
    departure_time
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT DO NOTHING
  `, 
  [
    String(booking.roomId),
    String(booking.id),
    booking.id,
    booking.roomId,
    fullName,
    email,
    phone,
    arrivalDate,
    arrivalTime,
    departureDate,
    departureTime
  ]
);*/
    console.log("✅ Booking saved:", booking.id);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ DB insert error:", err);
    res.status(500).send("DB error");
  }
});

const PORT = process.env.PORT || 3000;

// ===================== DB =====================
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
  
  /* dima // --- lock fields ---
 await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_code TEXT;`);
   await pool.query( `ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_visible BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query (`
ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS beds24_booking_id BIGINT,
  ADD COLUMN IF NOT EXISTS beds24_room_id TEXT,
  ADD COLUMN IF NOT EXISTS apartment_name TEXT;
   `);
  // --- clean status ---
  await pool.query(
    `ALTER TABLE checkins ADD COLUMN IF NOT EXISTS clean_ok BOOLEAN NOT NULL DEFAULT FALSE;`
  ); */ 
// ===================== MIGRATION: Beds24 support =====================
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

// ===================== BLOCK: DATE HELPERS (TIMEZONE) =====================
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

// ===================== BLOCK: HTML LAYOUT =====================
function renderPage(title, innerHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
  th.sticky-col,
td.sticky-col {
  position: sticky;
  left: 0;
  z-index: 2;
  background: #fff;
}

thead th.sticky-col {
  z-index: 3; /* чтобы заголовок был поверх */
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
  min-width: 1100px; /* важно для mobile */
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

   table-wrap{
  overflow:auto;
  border:1px solid #e5e7eb;
  border-radius:12px;
  background:#fff;
}

/* компактнее таблица */
table{ width:100%; border-collapse:collapse; font-size:12px; }
th{
  position:sticky;
  top:0;
  background:#f9fafb;
  text-align:left;
  padding:6px 8px;            /* было 10px */
  border-bottom:1px solid #e5e7eb;
  white-space:nowrap;
  color:#374151;
  font-size:12px;
}
td{
  padding:6px 8px;            /* было 10px */
  border-bottom:1px solid #f1f5f9;
  white-space:nowrap;
  vertical-align:middle;
}
tr:hover td{ background:#f9fafb; }

/* компактнее статус-пилюли */
.pill{
  display:inline-block;
  padding:4px 8px;            /* было 6px 10px */
  border-radius:999px;
  font-weight:800;
  font-size:11px;             /* было 12px */
  line-height:1;
}
.pill-yes{ background:#dcfce7; color:#166534; }
.pill-no{ background:#fee2e2; color:#991b1b; }

/* компактнее формы/кнопки */
.lock-form{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; }

.lock-input{
  width:110px;                /* было 150px */
  min-width:110px;
  padding:8px 10px;           /* было 10px 12px */
  border-radius:10px;
  border:1px solid #d1d5db;
  font-size:14px;             /* было 16px */
  letter-spacing:0.12em;
}

.btn-small{
  border-radius:999px;
  padding:7px 10px;           /* было 10px 12px */
  font-weight:700;
  border:none;
  cursor:pointer;
  background:#2563eb;
  color:#fff;
  font-size:12px;
  line-height:1;
}
.btn-ghost{ background:#eef2ff; color:#1e40af; }
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

// ===================== GUEST ROUTES =====================

// --- Home ---
app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p class="muted">Example entry:</p>
    <p><a class="btn-primary" href="/booking/apt1/TESTTOKEN123">Open booking example</a></p>
    <p class="muted">Admin: <a class="btn-link" href="/admin/checkins">/admin/checkins</a></p>
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

      <button type="submit" class="btn-primary">Submit</button>
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
    const arrivalDate   = req.body.arrivalDate;
    const arrivalTime   = req.body.arrivalTime || "16:00";
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

    // ===================== BLOCK: AFTER CHECKIN -> REDIRECT TO DASHBOARD =====================
    return res.redirect(`/guest/${aptId}/${token}`);
  } catch (e) {
    console.error("DB insert error:", e);
    res.status(500).send("❌ DB error while saving check-in");
  }
});

// ===================== BLOCK: GUEST DASHBOARD =====================
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

    // Spain date for "today"
    const todayES = ymdInTz(new Date(), "Europe/Madrid");

    // show code only when:
    // 1) admin enabled lock_visible
    // 2) today >= arrival_date
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

// ===================== ADMIN ROUTES =====================

// --- LIST + FILTER ---
app.get("/admin/checkins", async (req, res) => {
  try {
  const { from, to, quick: quickRaw } = req.query;

const tz = "Europe/Madrid";
const today = ymdInTz(new Date(), tz);
const tomorrow = ymdInTz(new Date(Date.now() + 86400000), tz);
const yesterday = ymdInTz(new Date(Date.now() - 86400000), tz);

// quick выбран?
const quick = (quickRaw === "yesterday" || quickRaw === "today" || quickRaw === "tomorrow") ? quickRaw : "";

// ✅ Приоритет: если quick выбран — он главнее дат
let fromDate = from;
let toDate = to;

if (quick) {
  if (quick === "yesterday") {
    fromDate = yesterday; toDate = yesterday;
  } else if (quick === "today") {
    fromDate = today; toDate = today;
  } else if (quick === "tomorrow") {
    fromDate = tomorrow; toDate = tomorrow;
  }
}

    const where = [];
    const params = [];
    if (fromDate) {
      params.push(fromDate);
      where.push(`arrival_date >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      where.push(`arrival_date <= $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
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
    lock_code,
    lock_visible,
    clean_ok
FROM checkins
      ${whereSql}
      ORDER BY arrival_date ASC, arrival_time ASC, id DESC
      LIMIT 300
      `,
      params
    );

    const toolbar = `
      <h1>Admin • Check-ins</h1>
      <p class="muted">Filter by arrival date</p>

      <form class="toolbar" method="GET" action="/admin/checkins">
        <div>
          <label>From</label>
          <input type="date" name="from" value="${fromDate || ""}">
        </div>
        <div>
          <label>To</label>
          <input type="date" name="to" value="${toDate || ""}">
        </div>
        <div>
          <label>Quick</label>
<select name="quick">
  <option value="" ${!quick ? "selected" : ""}>-</option>
  <option value="yesterday" ${quick==="yesterday"?"selected":""}>Yesterday</option>
  <option value="today" ${quick==="today"?"selected":""}>Today</option>
  <option value="tomorrow" ${quick==="tomorrow"?"selected":""}>Tomorrow</option>
</select>
        </div>

        <button class="btn" type="submit">Show</button>
        <a class="btn-link" href="/admin/checkins">Reset</a>
      </form>
    `;
const returnTo = req.originalUrl;
    const table = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
             <th class="sticky-col">Clean</th>
<th>Beds24 Booking</th>
<th>Apartment</th>
<th>Apt ID</th>
<th>Name</th>
<th>Phone</th>
<th>Arrive</th>
<th>Depart</th>
<th>Guest</th>
<th>Lock code</th>
<th>Visible</th>
            </tr>
          </thead>

          <tbody>
            ${
              rows.length
                ? rows
                    .map((r) => {
                      const arrive = `${String(r.arrival_date).slice(0, 10)} ${String(r.arrival_time).slice(0, 5)}`;
                      const depart = `${String(r.departure_date).slice(0, 10)} ${String(r.departure_time).slice(0, 5)}`;

                      return `
                        <tr>
                          <td class="sticky-col">
                            <form method="POST" action="/admin/checkins/${r.id}/clean">
                              <button type="submit" class="pill ${r.clean_ok ? "pill-yes" : "pill-no"}">
                                ${r.clean_ok ? "✅ CLEAN" : "❌ NOT CLEAN"}
                              </button>
                            </form>
                          </td>

                        <td>${r.booking_id ?? ""}</td>
<td>${r.apartment_name ?? ""}</td>
<td>${r.apartment_id}</td>
<td>${r.full_name}</td>
<td>${r.phone}</td>
<td>${arrive}</td>
<td>${depart}</td>
<td>
  <a class="btn-small btn-ghost" href="/guest/${r.apartment_id}/${r.booking_token}" target="_blank">
    Open
  </a>
</td>

                          <td>
                            <form method="POST" action="/admin/checkins/${r.id}/lock" class="lock-form">
                              <input
                                class="lock-input"
                                name="lock_code"
                                value="${r.lock_code ?? ""}"
                                inputmode="numeric"
                                pattern="\\d{4}"
                                maxlength="4"
                                placeholder="1234"
                              />
                              <button class="btn-small" type="submit">Save</button>
                              <button class="btn-small btn-ghost" type="submit" name="clear" value="1">Clear</button>
                            </form>
                          </td>

                          <td>
                            <form method="POST" action="/admin/checkins/${r.id}/visibility" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                              <span class="pill ${r.lock_visible ? "pill-yes" : "pill-no"}">${r.lock_visible ? "🔓 YES" : "🔒 NO"}</span>
                              <button class="btn-small ${r.lock_visible ? "btn-ghost" : ""}" type="submit" name="makeVisible" value="${r.lock_visible ? "0" : "1"}">
                                ${r.lock_visible ? "Hide" : "Show"}
                              </button>
                            </form>
                          </td>
                        </tr>
                      `;
                    })
                    .join("")
                : `<tr><td colspan="8" class="muted">No records</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `;

    res.send(renderPage("Admin • Check-ins", toolbar + table));
  } catch (e) {
    console.error("Admin list error:", e);
    res.status(500).send("❌ Cannot load checkins");
  }
});

// ===================== ADMIN: LOCK CODE SAVE (REPLACE, NOT APPEND) =====================
app.post("/admin/checkins/:id/lock", async (req, res) => {
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
    const back = req.body.returnTo || req.get("referer") || "/admin/checkins";
res.redirect(back);
  } catch (e) {
    console.error("Lock code update error:", e);
    res.status(500).send("❌ Cannot update lock code");
  }
});

// ===================== ADMIN: SET VISIBILITY =====================
app.post("/admin/checkins/:id/visibility", async (req, res) => {
  const id = Number(req.params.id);
  const makeVisible = String(req.body.makeVisible) === "1";

  try {
    await pool.query(`UPDATE checkins SET lock_visible = $1 WHERE id = $2`, [
      makeVisible,
      id,
    ]);
   const back = req.body.returnTo || req.get("referer") || "/admin/checkins";
res.redirect(back);
  } catch (e) {
    console.error("Visibility update error:", e);
    res.status(500).send("❌ Cannot update visibility");
  }
});

// ===================== ADMIN: CLEAN TOGGLE =====================
app.post("/admin/checkins/:id/clean", async (req, res) => {
  const id = Number(req.params.id);

  try {
    await pool.query(`UPDATE checkins SET clean_ok = NOT clean_ok WHERE id = $1`, [id]);
   const back = req.body.returnTo || req.get("referer") || "/admin/checkins";
res.redirect(back);
  } catch (e) {
    console.error("Clean toggle error:", e);
    res.status(500).send("❌ Cannot toggle clean status");
  }
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











































