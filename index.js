require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- DB ---
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

// ----- Partee links -----
const PARTEE_LINKS = {
  apt1: "https://u.partee.es/3636642/Cd78OQqWOB63wMJLFmB0JzdLL",
  // apt2: "...",
};

// ----- Helpers -----
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
      background: #fff;
      border-radius: 18px;
      padding: 20px 18px 22px;
      box-shadow: 0 10px 28px rgba(17,24,39,0.08);
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
      background: #fff;
      color: #111827;
      font-size: 14px;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 4px rgba(37,99,235,0.12);
    }
    .row { display: flex; gap: 10px; }
    .row > div { flex: 1; }
    .btn-primary, .btn-success, .btn-link, .btn {
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

    /* admin table */
    .toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:12px 0 14px;}
    .table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:12px;background:#fff;}
    table{width:100%;border-collapse:collapse;font-size:14px;}
    th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;color:#374151;}
    td{padding:10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;}
    tr:hover td{background:#f9fafb;}
    .pill {display:inline-block;padding:6px 10px;border-radius:999px;font-weight:800;font-size:12px;}
    .pill-yes {background:#dcfce7;color:#166534;}
    .pill-no {background:#fee2e2;color:#991b1b;}
    .mini {padding:8px 12px;border-radius:12px;border:1px solid #d1d5db;background:#fff;}
    .btn-small {padding:8px 12px;}
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

function hourOptions(selected = "") {
  let out = "";
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, "0");
    const value = `${hh}:00`;
    out += `<option value="${value}" ${value === selected ? "selected" : ""}>${hh}:00</option>`;
  }
  return out;
}

function ymd(d) {
  // Date -> YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ----- DB init / migrate -----
async function initDb() {
  // 1) базовая таблица
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

  // 2) миграция под lock code
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_code TEXT;`);
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS lock_visible BOOLEAN NOT NULL DEFAULT FALSE;`);

  console.log("✅ DB ready: checkins table ok (+ lock_code, lock_visible)");
}

// ===================== ROUTES =====================

// Home
app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p class="muted">Пример входа:</p>
    <p><a class="btn-primary" href="/booking/apt1/TESTTOKEN123">Open booking example</a></p>
    <p class="muted">Admin: <a class="btn-link" href="/admin/checkins">/admin/checkins</a></p>
  `;
  res.send(renderPage("Home", html));
});

// Booking page
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

// Check-in form
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

// Check-in submit -> DB
app.post("/checkin/:aptId/:token", async (req, res) => {
  const { aptId, token } = req.params;

  try {
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

    const warnings = [];
    const arrivalHour = parseInt(String(req.body.arrivalTime || "").split(":")[0], 10);
    if (!Number.isNaN(arrivalHour) && arrivalHour < 17) {
      warnings.push("El check-in es a partir de las 17:00. Si desea llegar antes, por favor contacte con nosotros.");
    }
    const departureHour = parseInt(String(req.body.departureTime || "").split(":")[0], 10);
    if (!Number.isNaN(departureHour) && departureHour > 11) {
      warnings.push("El check-out es hasta las 11:00. Si necesita salir más tarde, por favor contacte con nosotros.");
    }

    const parteeUrl = PARTEE_LINKS[aptId];
    const warningHtml =
      warnings.length > 0
        ? `<div class="warnings">${warnings.map((w) => `<p>${w}</p>`).join("")}</div>`
        : "";

    const html = `
      <h1>¡Gracias!</h1>
      ${warningHtml}
      <p>Check-in data received for <strong>${token}</strong> • <strong>${aptId}</strong>.</p>
      ${
        parteeUrl
          ? `<p>Continue registration here:</p>
             <p><a class="btn-success" href="${parteeUrl}">Open Partee</a></p>`
          : `<p style="color:#f97316;">No Partee link for this apartment (${aptId}).</p>`
      }
      <p class="muted">You can close this page.</p>
      <p><a class="btn-link" href="/">← Back</a></p>
    `;

    res.send(renderPage("Done", html));
  } catch (e) {
    console.error("DB insert error:", e);
    res.status(500).send("❌ DB error while saving check-in");
  }
});

// ADMIN: list + filter
app.get("/admin/checkins", async (req, res) => {
  try {
    const { from, to, days } = req.query;

    const today = new Date();
    const todayStr = ymd(today);

    let fromDate = from || "";
    let toDate = to || "";

    if (days && !from && !to) {
      const n = Math.max(0, parseInt(days, 10) || 0);
      const t2 = new Date(today);
      t2.setDate(today.getDate() + n);
      fromDate = todayStr;
      toDate = ymd(t2);
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
        apartment_id,
        full_name,
        phone,
        arrival_date,
        arrival_time,
        departure_date,
        departure_time,
        lock_code,
        lock_visible
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
          <select name="days">
            <option value="">—</option>
            ${[0, 1, 3, 5, 7, 14, 30]
              .map(
                (n) =>
                  `<option value="${n}" ${
                    String(days || "") === String(n) ? "selected" : ""
                  }>Today + ${n}</option>`
              )
              .join("")}
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
              <th>Lock code</th>
              <th>Visible</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map((r) => {
                      const arrive = `${String(r.arrival_date).slice(0, 10)} ${String(r.arrival_time).slice(0, 5)}`;
                      const depart = `${String(r.departure_date).slice(0, 10)} ${String(r.departure_time).slice(0, 5)}`;
                      const vis = r.lock_visible ? `<span class="pill pill-yes">🔓 YES</span>` : `<span class="pill pill-no">🔒 NO</span>`;
                      return `
                        <tr>
                          <td>${r.id}</td>
                          <td>${r.apartment_id}</td>
                          <td>${r.full_name}</td>
                          <td>${r.phone}</td>
                          <td>${arrive}</td>
                          <td>${depart}</td>
                          <td>${r.lock_code ?? "—"}</td>
                          <td>${vis}</td>
                          <td>
                            <form method="POST" action="/admin/checkins/${r.id}/lock" style="display:flex;gap:8px;align-items:center;">
                              <input class="mini" name="lock_code" placeholder="Code" value="${r.lock_code ?? ""}" />
                              <button class="btn btn-small" type="submit">Save</button>
                            </form>
                            <form method="POST" action="/admin/checkins/${r.id}/toggle" style="margin-top:8px;">
                              <button class="btn btn-small" type="submit">${r.lock_visible ? "Hide" : "Show"}</button>
                            </form>
                          </td>
                        </tr>
                      `;
                    })
                    .join("")
                : `<tr><td colspan="9" class="muted">No records</td></tr>`
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

// ADMIN: save lock code
app.post("/admin/checkins/:id/lock", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const lockCode = String(req.body.lock_code || "").trim() || null;

    await pool.query(
      `UPDATE checkins SET lock_code = $1 WHERE id = $2`,
      [lockCode, id]
    );

    res.redirect("/admin/checkins");
  } catch (e) {
    console.error("Lock save error:", e);
    res.status(500).send("❌ Cannot save lock code");
  }
});

// ADMIN: toggle visibility
app.post("/admin/checkins/:id/toggle", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      `UPDATE checkins SET lock_visible = NOT lock_visible WHERE id = $1`,
      [id]
    );
    res.redirect("/admin/checkins");
  } catch (e) {
    console.error("Toggle error:", e);
    res.status(500).send("❌ Cannot toggle");
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
