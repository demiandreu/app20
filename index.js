function renderAdminPage(title, innerHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }

  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:#f6f7fb;
    color:#111827;
    margin:0;
    min-height:100vh;
    display:flex;
    justify-content:center;
    align-items:flex-start;
  }

  .page{
    width:100%;
    max-width:1200px; /* ПК */
    padding:16px;
  }

  .card{
    background:#ffffff;
    border-radius:18px;
    padding:20px 18px 22px;
    border:1px solid #e5e7eb;
    box-shadow:0 10px 28px rgba(17,24,39,0.08);
  }

  h1{ margin:0 0 8px; font-size:22px; }
  p{ margin:0 0 10px; font-size:14px; color:#4b5563; }
  .muted{ font-size:12px; color:#6b7280; }

  .toolbar{
    display:flex; flex-wrap:wrap; gap:10px; align-items:end;
    margin:12px 0 14px;
  }

  label{ font-size:12px; color:#374151; display:block; margin-bottom:4px; }

  input, select{
    padding:10px 12px;
    border-radius:12px;
    border:1px solid #d1d5db;
    background:#ffffff;
    color:#111827;
    font-size:14px;
  }
  input:focus, select:focus{
    outline:none;
    border-color:#2563eb;
    box-shadow:0 0 0 4px rgba(37,99,235,0.12);
  }

  .btn{
    border-radius:999px;
    padding:10px 16px;
    font-weight:700;
    border:none;
    cursor:pointer;
    background:#2563eb;
    color:#fff;
  }

  .btn-link{
    background:transparent;
    color:#2563eb;
    text-decoration:none;
    font-weight:700;
  }

  .table-wrap{
    overflow:auto;
    border:1px solid #e5e7eb;
    border-radius:12px;
    background:#ffffff;
  }

  table{ width:100%; border-collapse:collapse; font-size:14px; }
  th{
    text-align:left;
    padding:10px 10px;
    border-bottom:1px solid #e5e7eb;
    color:#374151;
    position:sticky;
    top:0;
    background:#f9fafb;
    white-space:nowrap;
  }
  td{
    padding:10px 10px;
    border-bottom:1px solid #f1f5f9;
    white-space:nowrap;
    color:#111827;
  }
  tr:hover td{ background:#f9fafb; }

  @media (min-width: 640px){
    .page{ padding:24px; }
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
function hourOptions(selected = "") {
  let out = "";
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, "0");
    const value = `${hh}:00`; // минуты всегда 00
    const isSel = value === selected ? "selected" : "";
    out += `<option value="${value}" ${isSel}>${hh}:00</option>`;
  }
  return out;
}
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/admin/checkins", async (req, res) => {
  try {
    // ✅ фильтры:
    // /admin/checkins?from=2025-12-18&to=2025-12-25
    // /admin/checkins?days=5  (покажет заезды от сегодня до сегодня+5)
    const { from, to, days } = req.query;

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;

    let fromDate = from || "";
    let toDate = to || "";

    if (days && !from && !to) {
      const n = Math.max(0, parseInt(days, 10) || 0);
      const t2 = new Date(today);
      t2.setDate(today.getDate() + n);
      const y2 = t2.getFullYear();
      const m2 = String(t2.getMonth() + 1).padStart(2, "0");
      const d2 = String(t2.getDate()).padStart(2, "0");
      fromDate = todayStr;
      toDate = `${y2}-${m2}-${d2}`;
    }

    // ✅ строим WHERE только если есть фильтр
    const where = [];
    const params = [];
    if (fromDate) { params.push(fromDate); where.push(`arrival_date >= $${params.length}`); }
    if (toDate) { params.push(toDate); where.push(`arrival_date <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT id, apartment_id, full_name, phone,
             arrival_date, arrival_time, departure_date, departure_time, created_at
      FROM checkins
      ${whereSql}
      ORDER BY arrival_date ASC, arrival_time ASC, created_at DESC
      LIMIT 200
      `,
      params
    );

    const rows = result.rows;

    const toolbar = `
      <h1>Admin • Check-ins</h1>
      <p class="muted">Фильтр по дате заезда (arrival_date)</p>

      <form class="toolbar" method="GET" action="/admin/checkins">
        <div>
          <label>From (arrival)</label>
          <input type="date" name="from" value="${fromDate || ""}">
        </div>
        <div>
          <label>To (arrival)</label>
          <input type="date" name="to" value="${toDate || ""}">
        </div>
        <div>
          <label>Quick (days ahead)</label>
          <select name="days">
            <option value="">—</option>
            ${[0,1,3,5,7,14,30].map(n => `<option value="${n}" ${String(days||"")===String(n) ? "selected":""}>Today + ${n}</option>`).join("")}
          </select>
        </div>
        <button class="btn" type="submit">Show</button>
        <a class="btn-link" href="/admin/checkins">Reset</a>
        <a class="btn-link" href="/">Back</a>
      </form>
    `;

    const table = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Apt</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Arrive</th>
              <th>Depart</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${r.id}</td>
                <td>${r.apartment_id}</td>
                <td>${r.full_name}</td>
                <td>${r.phone}</td>
                <td>${String(r.arrival_date).slice(0,10)} ${String(r.arrival_time).slice(0,5)}</td>
                <td>${String(r.departure_date).slice(0,10)} ${String(r.departure_time).slice(0,5)}</td>
                <td>${String(r.created_at)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    res.send(renderAdminPage("Admin • Check-ins", toolbar + table));
  } catch (e) {
    console.error("Admin list error:", e);
    res.status(500).send("❌ Cannot load checkins");
  }
});
app.listen(PORT, () => console.log("running"));

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in env");
  process.exit(1);
}

console.log(
  "ENV DATABASE_URL starts with:",
  (process.env.DATABASE_URL || "").slice(0, 30)
);

// ✅ SSL только там, где он реально нужен (Render / прод)
// Локально чаще всего SSL НЕ нужен и мешает.
const isLocalDb =
  process.env.DATABASE_URL.includes("localhost") ||
  process.env.DATABASE_URL.includes("127.0.0.1");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb
    ? false
    : { rejectUnauthorized: false }, // Render / managed postgres
});

// ----- Partee ссылки для апартаментов -----
const PARTEE_LINKS = {
  apt1: "https://u.partee.es/3636642/Cd78OQqWOB63wMJLFmB0JzdLL",
  // apt2: "https://u.partee.es/XXXXXXX/XXXXXXXXXXXX",
};

// ----- Общий шаблон страницы (адаптивный) -----
function renderPage(title, innerHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }

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

  .page { width: 100%; max-width: 1100px; padding: 16px; }

  .card {
    background: #ffffff;
    border-radius: 18px;
    padding: 20px 18px 22px;
    box-shadow: 0 10px 28px rgba(17, 24, 39, 0.08);
    border: 1px solid #e5e7eb;
  }

  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0 0 10px; font-size: 14px; color: #4b5563; }

  label { font-size: 13px; display: block; margin-bottom: 4px; color:#374151; }

  input, select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #111827;
    font-size: 14px;
  }

  input:focus, select:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
  }

  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }

  .btn-primary, .btn-success, .btn-link {
    display: inline-block;
    border-radius: 999px;
    padding: 10px 18px;
    font-weight: 700;
    font-size: 14px;
    text-decoration: none;
    border: none;
    cursor: pointer;
  }

  .btn-primary { background: #2563eb; color: #fff; }
  .btn-success { background: #16a34a; color: #fff; }

  .btn-link {
    background: transparent;
    color: #2563eb;
    padding: 0;
    font-weight: 600;
  }

  .muted { font-size: 12px; color: #6b7280; }

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

  .warnings p { margin: 4px 0; color: #9a3412; }

  /* таблицы (для админки) — если у тебя есть <table> */
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { padding: 10px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 14px; }
  th { color:#374151; font-weight: 700; background: #f9fafb; }
  tr:hover td { background: #f9fafb; }

  @media (min-width: 640px) {
    body { align-items: center; }
    .page { padding: 24px; }
    .card { padding: 24px 22px 24px; }
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

// ✅ Главная (чтобы "/" не был 404)
app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p class="muted">Пример входа (замени aptId и token под свои):</p>
    <p>
      <a class="btn-primary" href="/booking/apt1/TESTTOKEN123">Open booking example</a>
    </p>
    <p class="muted">Доступные aptId: ${Object.keys(PARTEE_LINKS).join(", ") || "—"}</p>
  `;
  res.send(renderPage("Home", html));
});

// ----- Страница брони -----
app.get("/booking/:aptId/:token", (req, res) => {
  const { aptId, token } = req.params;

  const html = `
    <h1>Booking ${token}</h1>
    <p>Apartment: <strong>${aptId}</strong></p>
    <p>Это начало вашего персонального гостевого портала.</p>
    <p>
      <a href="/checkin/${aptId}/${token}" class="btn-primary">Перейти к check-in</a>
    </p>
    <p>
      <a href="/" class="btn-link">← Назад на главную</a>
    </p>
  `;
  res.send(renderPage(`Booking ${token} • ${aptId}`, html));
});

// ----- Страница формы check-in -----
app.get("/checkin/:aptId/:token", (req, res) => {
  const { aptId, token } = req.params;

  const now = new Date();
  const pad = (n) => (n < 10 ? "0" + n : n);

  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}`;

  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(now.getDate() + 1);

  const tomorrow = `${tomorrowDate.getFullYear()}-${pad(
    tomorrowDate.getMonth() + 1
  )}-${pad(tomorrowDate.getDate())}`;

  const html = `
    <h1>Check-in for booking ${token}</h1>
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

      <button type="submit" class="btn-primary">Submit check-in</button>
    </form>

    <p style="margin-top:16px;">
      <a href="/booking/${aptId}/${token}" class="btn-link">← Back to booking page</a>
    </p>
  `;

  res.send(renderPage(`Check-in • ${aptId} • ${token}`, html));
});

// ----- Обработка формы check-in -----
app.post("/checkin/:aptId/:token", async (req, res) => {
  const { aptId, token } = req.params;

  const guestData = {
    apartmentId: aptId,
    bookingToken: token,
    fullName: req.body.fullName,
    email: req.body.email,
    phone: req.body.phone,
    arrivalDate: req.body.arrivalDate,
    arrivalTime: req.body.arrivalTime,
    departureDate: req.body.departureDate,
    departureTime: req.body.departureTime,
  };

  console.log("Received check-in data:", guestData);

  try {
    await pool.query(
      `
      INSERT INTO checkins (
        apartment_id,
        booking_token,
        full_name,
        email,
        phone,
        arrival_date,
        arrival_time,
        departure_date,
        departure_time
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        aptId,
        token,
        guestData.fullName,
        guestData.email,
        guestData.phone,
        guestData.arrivalDate,
        guestData.arrivalTime,
        guestData.departureDate,
        guestData.departureTime,
      ]
    );

    // проверки времени
    const warnings = [];

    if (req.body.arrivalTime) {
      const arrivalHour = parseInt(req.body.arrivalTime.split(":")[0], 10);
      if (!Number.isNaN(arrivalHour) && arrivalHour < 17) {
        warnings.push(
          "El check-in es a partir de las 17:00. Si desea llegar antes, por favor contacte con nosotros."
        );
      }
    }

    if (req.body.departureTime) {
      const departureHour = parseInt(req.body.departureTime.split(":")[0], 10);
      if (!Number.isNaN(departureHour) && departureHour > 11) {
        warnings.push(
          "El check-out es hasta las 11:00. Si necesita salir más tarde, por favor contacte con nosotros."
        );
      }
    }

    const parteeUrl = PARTEE_LINKS[aptId];

    const warningHtml =
      warnings.length > 0
        ? `<div class="warnings">
             ${warnings.map((w) => `<p>${w}</p>`).join("")}
           </div>`
        : "";

    const html = `
      <h1>¡Gracias!</h1>

      ${warningHtml}

      <p>Hemos recibido sus datos de check-in para la reserva <strong>${token}</strong> en <strong>${aptId}</strong>.</p>

      ${
        parteeUrl
          ? `<p>Para completar el registro oficial de viajeros, por favor continúe aquí:</p>
             <p><a href="${parteeUrl}" class="btn-success">Completar registro en Partee</a></p>`
          : `<p style="color:#f97316;">No se ha configurado un enlace de Partee para este apartamento (${aptId}).</p>`
      }

      <p class="muted" style="margin-top:16px;">Puede cerrar esta página después de completar el proceso.</p>
      <p><a href="/" class="btn-link">← Back to home</a></p>
    `;

    res.send(renderPage("Check-in completado", html));
  } catch (e) {
    console.error("DB insert error:", e);
    res.status(500).send("❌ DB error while saving check-in");
  }
});

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

  console.log("✅ DB ready: checkins table ok");
}

// ✅ Стартуем сервер только после DB init
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`RCS Guest Portal running at http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error("❌ DB init error:", e);
    process.exit(1);
  }
})();








