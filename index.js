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
// ====== MANAGER: Apartment Sections (Accordion content) ======
app.get("/manager/apartment/sections", async (req, res) => {
  try {
    const aptId = Number(req.query.id);
    if (!aptId) return res.status(400).send("Missing id");

    // Load unit info (UI uses aptId). We also need room_id for sections.
    const aptRes = await pool.query(
      `SELECT id, apartment_name, beds24_room_id
       FROM beds24_rooms
       WHERE id = $1
       LIMIT 1`,
      [aptId]
    );

    if (!aptRes.rows.length) return res.status(404).send("Apartment not found");
    const apt = aptRes.rows[0];

    const room_id = String(apt.beds24_room_id || "").trim();
    if (!room_id) {
      return res.status(500).send("Missing room_id for this apartment");
    }

    // ✅ Load sections by room_id (not apartment_id)
    const secRes = await pool.query(
      `
      SELECT id, title, body, sort_order, is_active, new_media_type, new_media_url
      FROM apartment_sections
      WHERE room_id = $1
      ORDER BY sort_order ASC, id ASC
      `,
      [room_id]
    );

    const rowsHtml = secRes.rows
      .map((s) => {
        const checked = s.is_active ? "checked" : "";
        return `
          <tr>
            <td style="width:90px;">
              <input name="sort_order_${s.id}" value="${Number(s.sort_order)}" style="width:70px; box-sizing:border-box;" />
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
                <input name="new_media_url_${s.id}" value="${escapeHtml(s.new_media_url || "")}" placeholder="https://..." style="width:100%;" />
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    const html = `
      <style>
        .muted { opacity: 0.65; font-size: 12px; }
      </style>

      <h1>Apartment Sections</h1>
      <p class="muted">
        Apartment: <strong>${escapeHtml(apt.apartment_name || String(apt.id))}</strong>
      </p>
      <p class="muted">
        room_id: <strong>${escapeHtml(room_id)}</strong>
      </p>

      <p>
        <a class="btn-link" href="/manager/apartment?id=${aptId}">← Back to Apartment Settings</a>
      </p>

      <form method="POST" action="/manager/apartment/sections/save">
        <input type="hidden" name="apartment_id" value="${aptId}" />

        <label>Media type</label><br/>
        <select name="new_media_type">
          <option value="none">None</option>
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        <br/><br/>

        <label>Media URL (image or video link)</label><br/>
        <input name="new_media_url" placeholder="https://..." style="width:100%;" />
        <br/><br/>

        <div style="margin:12px 0; padding:12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
          <h2 style="margin:0 0 8px; font-size:16px;">Add new section</h2>
          <div style="display:grid; gap:8px;">
            <label>Title</label>
            <input name="new_title" placeholder="Title" />
            <textarea name="new_body" rows="4" placeholder="Text for guests..."></textarea>

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
    return res
      .status(500)
      .send("Cannot load sections: " + (e.detail || e.message || String(e)));
  }
});

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
// ===================== MANAGER: Sync Bookings =====================
app.get("/manager/channels/bookingssync", async (req, res) => {
  try {
    const from = String(req.query.from || "2025-01-01");
    const to = String(req.query.to || "2026-12-31");

    // берём все активные квартиры с prop key
    const aptsRes = await pool.query(`
      SELECT beds24_room_id, beds24_prop_key, apartment_name
      FROM beds24_rooms
      WHERE is_active = true AND beds24_prop_key IS NOT NULL
      ORDER BY apartment_name ASC
    `);
    const apts = aptsRes.rows || [];
    if (!apts.length) {
      return res.send("No active apartments with channel key (beds24_prop_key).");
    }

    let totalFetched = 0;
    let totalUpserted = 0;
    const perApt = [];

    for (const apt of apts) {
      // получаем брони по этой квартире
      const resp = await beds24PostJson(
        "https://api.beds24.com/json/getBookings",
        { from, to },
        apt.beds24_prop_key
      );

      // пытаемся достать массив броней (формат бывает разный)
      const bookings =
        resp?.data?.getBookings ||
        resp?.data?.bookings ||
        resp?.getBookings ||
        resp?.bookings ||
        [];

      const list = Array.isArray(bookings) ? bookings : [];
      totalFetched += list.length;

      // здесь пока просто считаем, апсерт сделаем следующим шагом (чтобы не сломать)
      perApt.push({
        name: apt.apartment_name,
        roomId: apt.beds24_room_id,
        count: list.length,
      });

      // TODO: upsert в checkins (сделаем отдельным шагом)
      // totalUpserted += ...
    }

    const rowsHtml = perApt
      .map(
        (x) =>
          `<tr><td>${escapeHtml(x.name || "")}</td><td>${escapeHtml(x.roomId || "")}</td><td>${x.count}</td></tr>`
      )
      .join("");

    return res.send(renderPage("Sync Bookings", `
      <p style="margin:0 0 12px;"><a class="btn-link" href="/manager">← Manager</a></p>
      <h2>Sync Bookings</h2>
      <p class="muted">from=${escapeHtml(from)} to=${escapeHtml(to)}</p>
      <p>Total fetched: <strong>${totalFetched}</strong></p>
      <table border="1" cellpadding="8" cellspacing="0">
        <thead><tr><th>Apartment</th><th>Room ID</th><th>Bookings</th></tr></thead>
        <tbody>${rowsHtml || ""}</tbody>
      </table>
    `));
  } catch (e) {
    console.error("bookingssync error:", e);
    return res.status(500).send("Sync Bookings failed: " + (e.message || String(e)));
  }
});

app.get("/manager/channels/sync", async (req, res) => {
  try {
    const from = String(req.query.from || "2025-01-01");
    const to = String(req.query.to || "2026-12-31");

    const { rows: rooms } = await pool.query(`
      SELECT beds24_room_id, beds24_prop_key, apartment_name
      FROM beds24_rooms
      WHERE is_active = true AND beds24_prop_key IS NOT NULL
      ORDER BY apartment_name ASC
    `);

    let totalBookings = 0;
    let saved = 0;
    let skipped = 0;
    const errors = [];

    for (const r of rooms) {
      try {
        const resp = await beds24PostJson(
          "https://api.beds24.com/json/getBookings",
          { from, to },
          r.beds24_prop_key
        );

        const list = Array.isArray(resp) ? resp : (resp?.data || resp?.bookings || []);
        totalBookings += Array.isArray(list) ? list.length : 0;

        for (const b of list) {
          const row = mapBeds24BookingToRow(b, r.apartment_name, r.beds24_room_id);
          const result = await upsertCheckinFromBeds24(row);
          if (result?.skipped) skipped++;
          else saved++;
        }
      } catch (e) {
        errors.push({ roomId: r.beds24_room_id, message: String(e.message || e) });
      }
    }

    return res.send(`
      <h1>Sync done</h1>
      <p>from=${escapeHtml(from)} to=${escapeHtml(to)}</p>
      <p>rooms=${rooms.length}</p>
      <p>totalBookings=${totalBookings}</p>
      <p>saved=${saved}</p>
      <p>skipped=${skipped}</p>
      <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(errors, null, 2))}</pre>
    `);
  } catch (e) {
    console.error("❌ sync error:", e);
    return res.status(500).send("Sync failed: " + escapeHtml(e.message || String(e)));
  }
});
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
    // ✅ 1) СНАЧАЛА всегда объявляем всё, что будем использовать
    const from = String(req.body.From || ""); // "whatsapp:+34..."
    const body = String(req.body.Body || "").trim();
    const phone = from.replace("whatsapp:", "").trim(); // "+34..."
    const textUpper = body.toUpperCase();

    console.log("📩 Twilio WhatsApp inbound:", { from, body });

    // ✅ helper: получить последнюю бронь по телефону (для REGOK / PAYOK / LISTO)
    const getLastCheckinByPhone = async () => {
      const q = await pool.query(
        `
        SELECT
          id,
          apartment_id,
          apartment_name,
          booking_token,
          full_name,
          arrival_date,
          arrival_time,
          departure_date,
          departure_time,
          adults,
          children,
          beds24_booking_id,
          booking_id_from_start,
          reg_done,
          pay_done
        FROM checkins
        WHERE phone = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [phone]
      );
      return q.rows[0] || null;
    };

    // ✅ helper: получить ссылки/дефолты из beds24_rooms по apartment_id
    const getRoomSettings = async (apartmentId) => {
      const roomRes = await pool.query(
        `
        SELECT
          registration_url,
          payment_url,
          keys_instructions_url,
          default_arrival_time,
          default_departure_time,
          support_phone
        FROM beds24_rooms
        WHERE beds24_room_id = $1
           OR id::text = $1
        LIMIT 1
        `,
        [String(apartmentId || "")]
      );
      return roomRes.rows[0] || {};
    };

    // ✅ helper: подстановка [BOOKID]
    const applyTpl = (tpl, bookId) =>
      String(tpl || "").replace(/\[BOOKID\]/g, String(bookId || ""));

    // ----------------- REGOK -----------------
    if (textUpper === "REGOK") {
      const last = await getLastCheckinByPhone();
      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START_XXXX");
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

    // ----------------- PAYOK -----------------
    if (textUpper === "PAYOK") {
      const last = await getLastCheckinByPhone();
      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START_XXXX");
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

    // ----------------- START_<ID> -----------------
    if (textUpper.startsWith("START_")) {
      const bookingId = textUpper.replace("START_", "").trim();
      console.log("🟢 START bookingId:", bookingId);

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
          children,
          beds24_booking_id,
          booking_id_from_start,
          reg_done,
          pay_done
        FROM checkins
        WHERE booking_token = $1
           OR booking_id_from_start = $1
           OR beds24_booking_id::text = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [bookingId]
      );

      if (!bookingResult.rows.length) {
        await sendWhatsApp(
          from,
          `Gracias 🙂
No encuentro tu reserva todavía.
Si acabas de reservar, espera un momento y vuelve a enviar:
START_${bookingId}`
        );
        return res.status(200).send("OK");
      }

      const r = bookingResult.rows[0];
       // привязать телефон к найденной записи
const upd = await pool.query(
  `UPDATE checkins
   SET phone = $1
   WHERE id = $2
   RETURNING id, phone`,
  [phone, r.id]
);

console.log("📌 phone bind result:", {
  bookingRowId: r.id,
  phone,
  rowCount: upd.rowCount,
  returned: upd.rows[0],
});

      // settings
      const room = await getRoomSettings(r.apartment_id);

      // links
      const regTpl = String(room.registration_url || "");
      const payTpl = String(room.payment_url || "");
      const keysTpl = String(room.keys_instructions_url || "");

       const supportPhoneRaw = room.support_phone || "";
const supportPhoneClean = supportPhoneRaw.replace(/\D/g, "");
const supportLink = supportPhoneClean
  ? `https://wa.me/${supportPhoneClean}`
  : "—";

      const bookIdForPayment = String(
        r.beds24_booking_id || r.booking_id_from_start || r.booking_token || ""
      );

      const regLink = applyTpl(regTpl, bookIdForPayment);
      const payLink = applyTpl(payTpl, bookIdForPayment);
      const keysLink = applyTpl(keysTpl, bookIdForPayment);

      // data
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

      // 🔒 ключи показываем только если оба true (и всё равно окончательно выдадим на LISTO)
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

2️⃣ Pago (tasa turística + depósito segun la plataforma):
${payLink || "—"}
Después escribe: PAYOK

3️⃣ Llaves:
${showKeys ? (keysLink || "—") : "🔒 Se mostrarán después de completar REGISTRO y PAGO"}

👨‍💬  Soporte humano:
${supportLink}

Cuando lo tengas listo, escribe: LISTO`
      );

      return res.status(200).send("OK");
    }

    // ----------------- LISTO -----------------
    if (textUpper === "LISTO") {
      const last = await getLastCheckinByPhone();

      if (!last) {
        await sendWhatsApp(from, "No encuentro tu reserva. Envía primero: START_XXXX");
        return res.status(200).send("OK");
      }

      // если не выполнены шаги — просим их сделать
      if (!last.reg_done || !last.pay_done) {
        await sendWhatsApp(
          from,
          `Casi listo 🙂 
Antes necesito:
1) Registro (después escribe REGOK)
2) Pago (después escribe PAYOK)`
        );
        return res.status(200).send("OK");
      }

      // ✅ оба шага выполнены → отправляем ключи
      const room = await getRoomSettings(last.apartment_id);

      const keysTpl = String(room.keys_instructions_url || "");
      const bookIdForPayment = String(
        last.beds24_booking_id || last.booking_id_from_start || last.booking_token || ""
      );
      const keysLink = applyTpl(keysTpl, bookIdForPayment);

      await sendWhatsApp(from, `✅ Perfecto 🙌

Aquí tienes el enlace con toda la información del apartamento:
📘 instrucciones de llegada
📶 Wi-Fi
❄️ aire acondicionado
🚗 parking (si aplica)
y otros detalles importantes para tu estancia.

🔐 Código de la caja de llaves  
El código se mostrará automáticamente en este mismo enlace el día de llegada,
✅ siempre que el registro de huéspedes y el pago estén completados correctamente.

Guarda este enlace, lo necesitarás durante tu estancia 😊 \n${keysLink || "—"}`);
      return res.status(200).send("OK");
    }

    // ----------------- default -----------------
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
  
  /* подсветка ячейки Apartment */
td.apartment-cell.red { background: #f0f0f0; }
td.apartment-cell.green { background: #e7ffe7; }

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
  vertical-align:top;          /* лучше для textarea */
  white-space:normal;          /* ✅ главное: разрешаем перенос */
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

function mapBeds24BookingToRow(b, apartmentName = "", apartmentId = "") {
  const bookingId = String(b.bookId || b.id || "").trim();
  const roomId = String(b.roomId || "").trim();

  // dates
  const arrivalDate = String(b.firstNight || b.arrival || "").slice(0, 10);
  const departureDate = String(b.lastNight || b.departure || "").slice(0, 10);

  // guests
  const adults = Number(b.numAdult ?? b.adults ?? 0) || 0;
  const children = Number(b.numChild ?? b.children ?? 0) || 0;

  // guest info
  const fullName = String(
    [b.guestFirstName, b.guestName].filter(Boolean).join(" ").trim() || "Guest"
  );
  const email = String(b.guestEmail || "").trim() || "unknown@unknown";
  const phone = String(b.guestPhone || b.guestMobile || "").trim() || "+000";

  // times (если нет — ставим дефолт)
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
//vremenno
app.get("/manager/channels/beds24key", (req, res) => {
  const k = String(process.env.BEDS24_API_KEY || "").trim();
  const masked = k.length <= 8 ? k : `${k.slice(0, 4)}…${k.slice(-4)}`;
  res.send({
    hasKey: Boolean(k),
    keyLen: k.length,
    keyMasked: masked,
  });
});

//vremenno
app.get("/debug/rooms", async (req, res) => {
  try {
    const a = await pool.query(`
      SELECT count(*)::int AS cnt FROM beds24_rooms
    `);
    const b = await pool.query(`
      SELECT id, apartment_name, beds24_room_id,
             CASE WHEN beds24_prop_key IS NULL THEN 'NULL' ELSE 'SET' END AS prop_key
      FROM beds24_rooms
      ORDER BY apartment_name ASC
      LIMIT 20
    `);
    res.json({ count: a.rows[0].cnt, sample: b.rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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

    const html = `
      <h1>Apartment Settings</h1>
      <p><a href="/manager">← Back to Manager</a></p>

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
  <a class="btn-link" href="/manager/apartment/sections?id=${a.id}">🪗 Manage guest accordion sections</a>
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
      default_arrival_time = $2,
      default_departure_time = $3,
      registration_url = $4,
      payment_url = $5,
      keys_instructions_url = $6,
      updated_at = now()
    WHERE id = $7
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
    const apartment_id = Number(req.body.apartment_id);
    if (!apartment_id) return res.status(400).send("Missing apartment_id");

    async function getRoomIdForApartment(apartmentId) {
  const q = await pool.query(
    `SELECT beds24_room_id
     FROM beds24_rooms
     WHERE id = $1
     LIMIT 1`,
    [apartmentId]
  );

  return String(q.rows?.[0]?.beds24_room_id || "").trim();

      const q2 = await pool.query(
        `SELECT beds24_room_id
           FROM beds24_rooms
          WHERE id = $1
          LIMIT 1`,
        [apartmentId]
      );
      return String(q2.rows?.[0]?.beds24_room_id || "").trim();
    }

    const room_id = await getRoomIdForApartment(apartment_id);
    if (!room_id) return res.status(400).send("Missing room_id mapping");

    // 1) DELETE
    if (req.body.delete) {
      const id = Number(req.body.delete);
      if (!id) return res.status(400).send("Missing id");

      await pool.query(
        `DELETE FROM apartment_sections WHERE id = $1 AND room_id = $2`,
        [id, room_id]
      );

      return res.redirect(`/manager/apartment/sections?id=${apartment_id}`);
    }

    // 2) MOVE up/down
    if (req.body.move) {
      const [dir, idStr] = String(req.body.move).split(":");
      const id = Number(idStr);
      if (!id || (dir !== "up" && dir !== "down")) {
        return res.status(400).send("Bad move");
      }

      await pool.query(
        `
        UPDATE apartment_sections
        SET sort_order = GREATEST(1, sort_order + $1),
            updated_at = NOW()
        WHERE id = $2 AND room_id = $3
        `,
        [dir === "up" ? -1 : 1, id, room_id]
      );

      return res.redirect(`/manager/apartment/sections?id=${apartment_id}`);
    }

    // 3) ADD new section
    if (String(req.body.add) === "1") {
      const title = String(req.body.new_title || "").trim();
      const body = String(req.body.new_body || "").trim();
      const sort_order = Number(req.body.new_sort_order || 1);
      const is_active = req.body.new_is_active ? true : false;
       const room_id = await getRoomIdForApartment(apartment_id);
console.log("DEBUG ADD:", { apartment_id, room_id });

if (!room_id) {
  return res.status(400).send("Room ID not found for this apartment");
}

      const new_media_url = String(req.body.new_media_url || "").trim();
      const new_media_type_in = String(req.body.new_media_type || "none").trim();

      if (!title && !body && !new_media_url) {
        return res.status(400).send("Empty section");
      }

      const new_media_type = new_media_url
        ? (new_media_type_in === "video" ? "video" : "image")
        : "none";

      await pool.query(
        `
        INSERT INTO apartment_sections
          ( room_id, title, body, sort_order, is_active, new_media_type, new_media_url)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,)
        `,
        [room_id, title, body, sort_order, is_active, new_media_type, new_media_url]
      );

      return res.redirect(`/manager/apartment/sections?id=${apartment_id}`);
    }

    // 4) SAVE ALL edits
    const secRes = await pool.query(
      `SELECT id FROM apartment_sections WHERE room_id = $1 ORDER BY id ASC`,
      [room_id]
    );

    for (const row of secRes.rows) {
      const id = row.id;

      const title = String(req.body[`title_${id}`] || "").trim();
      const body = String(req.body[`body_${id}`] || "");
      const sort_order = Number(req.body[`sort_order_${id}`] || 1);
      const is_active = req.body[`is_active_${id}`] ? true : false;

      const new_media_type_in = String(req.body[`new_media_type_${id}`] || "none").trim();
      const new_media_url = String(req.body[`new_media_url_${id}`] || "").trim();

      const new_media_type = new_media_url
        ? (new_media_type_in === "video" ? "video" : "image")
        : "none";

      await pool.query(
        `
        UPDATE apartment_sections
        SET title = $1,
            body = $2,
            sort_order = $3,
            is_active = $4,
            new_media_type = $5,
            new_media_url = $6,
            updated_at = NOW()
        WHERE id = $7 AND room_id = $8
        `,
        [title, body, sort_order, is_active, new_media_type, new_media_url, id, room_id]
      );
    }

    return res.redirect(`/manager/apartment/sections?id=${apartment_id}`);
  } catch (e) {
    console.error("sections save error:", e);
    return res.status(500).send("Cannot save sections");
  }
});
   
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
        id, apartment_id, apartment_name, booking_token,
        full_name, email, phone,
        arrival_date, arrival_time,
        departure_date, departure_time,
        adults, children,
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

     const secRes = await pool.query(
  `
  SELECT title, body
  FROM apartment_sections
  WHERE apartment_id = $1 AND is_active = true
  ORDER BY sort_order ASC, id ASC
  `,
  [aptId]
);

const accordionHtml = secRes.rows.map((s, idx) => `
  <details style="border:1px solid #e5e7eb; border-radius:14px; padding:10px 12px; background:#fff; margin-top:10px;">
    <summary style="cursor:pointer; font-weight:700;">
      ${escapeHtml(s.title || `Section ${idx + 1}`)}
    </summary>
    <div style="margin-top:10px; white-space:pre-wrap; line-height:1.45;">
      ${escapeHtml(s.body || "")}
    </div>
  </details>
`).join("");

    // ✅ apartment name (fallback to aptId if empty)
    const aptName = String(r.apartment_name || "").trim() || String(aptId);

    // ✅ guests line
    const adults = Number(r.adults ?? 0);
    const children = Number(r.children ?? 0);

    let guestsLine = "—";
    if (adults || children) {
      const parts = [];
      if (adults) parts.push(`${adults} adulto${adults === 1 ? "" : "s"}`);
      if (children) parts.push(`${children} niño${children === 1 ? "" : "s"}`);
      guestsLine = parts.join(", ");
    }

    // Spain date for "today"
    const todayES = ymdInTz(new Date(), "Europe/Madrid");

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
      <p class="muted">Booking: <strong>${token}</strong> • Apartment: <strong>${aptName}</strong></p>

      <div style="margin-top:12px; padding:14px; border:1px solid #e5e7eb; background:#fff; border-radius:14px;">
        <h2 style="margin:0 0 10px; font-size:16px;">Your stay</h2>
        <p style="margin:0 0 6px;"><strong>Arrival:</strong> ${arrive}</p>
        <p style="margin:0 0 6px;"><strong>Departure:</strong> ${depart}</p>
        <p style="margin:0;"><strong>Guests:</strong> ${guestsLine}</p>
      </div>

      ${codeBlock}
      ${accordionHtml}

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

     function aptColor(apartmentId) {
  // временно ничего не красим для arrivals — только для departures сделаем отдельно
  return "";
}
     function aptColorById(apartmentId) {
  const id = String(apartmentId || "");
  if (!id) return "";

  // если сегодня есть выезд — красный (уборка нужна)
  if (departSet.has(id)) return "red";

  // если сегодня НЕТ выезда и НЕТ заезда — считаем “вчера пусто” -> зелёный
  // (это приближение. идеальную проверку “вчера пусто” сделаем следующим шагом через запрос на вчерашние брони)
  if (!arriveSet.has(id)) return "green";

  return "";
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

     // ===== apartment color (safe) =====

// 1) квартиры с выездом СЕГОДНЯ -> red
const depTodaySet = new Set(
  departures
    .filter(r => String(r.departure_date || "").slice(0, 10) === today)
    .map(r => String(r.apartment_id))
);

// 2) квартиры, которые были заняты ВЧЕРА (чтобы понять "пусто/не пусто")
const { rows: occ } = await pool.query(
  `
  SELECT DISTINCT apartment_id
  FROM checkins
  WHERE cancelled IS DISTINCT FROM true
    AND arrival_date <= $1::date
    AND departure_date > $1::date
  `,
  [yesterday]
);
const occupiedYesterdaySet = new Set(occ.map(r => String(r.apartment_id)));

// 3) функция цвета для таблицы
function aptColor(apartmentId) {
  const id = String(apartmentId || "");
  if (!id) return "";
  if (depTodaySet.has(id)) return "red";
  if (!occupiedYesterdaySet.has(id)) return "green";
  return "";
}

   // 1) какие квартиры выезжают сегодня (значит убирать) -> красный
const departSet = new Set(departures.map(r => String(r.apartment_id)));

// 2) какие квартиры приезжают сегодня
const arriveSet = new Set(arrivals.map(r => String(r.apartment_id)));

function aptColorById(apartmentId) {
  const id = String(apartmentId || "");
  if (departSet.has(id)) return "red";          // есть выезд -> красный
  if (!arriveSet.has(id)) return "green";       // нет заезда (и нет выезда) -> зелёный
  return "";
}

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

    
// 2) квартиры, которые были ЗАНЯТЫ ВЧЕРА
const { rows: occ2 } = await pool.query(
  `
  SELECT DISTINCT apartment_id
  FROM checkins
  WHERE cancelled IS DISTINCT FROM true
    AND arrival_date <= $1::date
    AND departure_date > $1::date
  `,
  [yesterday]
);
     
// 3) функция цвета для таблицы
function aptColor(apartmentId) {
  const id = String(apartmentId);

  if (depTodaySet.has(id)) return "red";
  if (!occupiedYesterdaySet.has(id)) return "green";
  return "";
}


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
                    <td class="apartment-cell ${aptColorById(r.apartment_id)}">
  ${r.apartment_name ?? ""}
</td>
                    <td>${(r.adults ?? 0)}|${(r.children ?? 0)}</td>
                    <td>${mainDate}</td>

<td>${calcNights(r.arrival_date, r.departure_date)}</td> <!-- N -->

<td>

  <a class="btn-small btn-ghost"

     href="/guest/${r.apartment_id}/${r.booking_token}"

     target="_blank">

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
                          placeholder=""
                        />
                        <button class="btn-base" type="submit">Save</button>
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
          : `<tr><td colspan="12" class="muted">No records</td></tr>`;

      return `
        <h2 style="margin:18px 0 10px;">${title}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sticky-col">Clean</th>
                <th>Id</th>
                <th>Apartment</th>
                <th>A|C</th>
                <th>${dateColTitle}</th>
                <th>N</th>
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
return res.send(renderPage("Staff • Arrivals & Departures", pageHtml));
  } catch (e) {
    console.error("Staff list error:", e);
    res.status(500).send("❌ Cannot load checkins");
  }
});

// --- DELETE checkin ---
app.post("/staff/checkins/:id/delete", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send("Missing id");

    // куда возвращаться после удаления (мы это поле уже отправляем из формы)
    const returnTo = String(req.body.returnTo || "/staff/checkins");

    await pool.query(`DELETE FROM checkins WHERE id = $1`, [id]);

    return res.redirect(returnTo);
  } catch (e) {
    console.error("delete checkin error:", e);
    return res.status(500).send("Cannot delete checkin");
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
app.get("/manager/channels/bookings", async (req, res) => {
  try {
    const from = String(req.query.from || "2025-01-01");
    const to = String(req.query.to || "2026-12-31");

    const roomId = String(req.query.roomId || "").trim();

    const q = roomId
      ? `
        SELECT beds24_room_id, beds24_prop_key, apartment_name
        FROM beds24_rooms
        WHERE beds24_room_id = $1 AND beds24_prop_key IS NOT NULL
        LIMIT 1
      `
      : `
        SELECT beds24_room_id, beds24_prop_key, apartment_name
        FROM beds24_rooms
        WHERE is_active = true AND beds24_prop_key IS NOT NULL
        ORDER BY apartment_name ASC
        LIMIT 1
      `;

    const params = roomId ? [roomId] : [];
    const { rows } = await pool.query(q, params);

    if (!rows.length) {
      return res.send("❌ No apartment found with beds24_prop_key (set it in /manager/settings/apartments)");
    }

    const apt = rows[0];
    const propKey = apt.beds24_prop_key;

    const resp = await beds24PostJson(
      "https://api.beds24.com/json/getBookings",
      { from, to },
      propKey
    );

    return res.send(`
      <h2>Bookings</h2>
      <p>Apartment: ${escapeHtml(apt.apartment_name || "")} (roomId=${escapeHtml(apt.beds24_room_id || "")})</p>
      <p>from=${escapeHtml(from)} to=${escapeHtml(to)}</p>
      <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(resp, null, 2))}</pre>
    `);
  } catch (e) {
    console.error("❌ bookings debug error:", e);
    return res.status(500).send("Bookings failed: " + escapeHtml(e.message || String(e)));
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

// GET /manager (dropdown + form)
app.get("/manager", async (req, res) => {
  try {
    // 1) global settings (defaults)
    const sRes = await pool.query(`SELECT * FROM app_settings WHERE id = 1 LIMIT 1`);
    const s = sRes.rows[0] || {};

    // 2) apartments list
    const listRes = await pool.query(`
      SELECT id, apartment_name, beds24_room_id
      FROM beds24_rooms
      ORDER BY apartment_name ASC
    `);
    const apts = listRes.rows || [];

    // which apt is selected?
    const selectedIdRaw = req.query.aptId;
    const selectedId =
      selectedIdRaw != null && String(selectedIdRaw).trim() !== ""
        ? Number(selectedIdRaw)
        : (apts[0]?.id ?? null);

 // load selected apt
let apt = null;
if (selectedId) {
  const aptRes = await pool.query(
    `
    SELECT *
    FROM beds24_rooms
    WHERE id = $1
    LIMIT 1
    `,
    [selectedId]
  );
  apt = aptRes.rows[0] || null;
}

    // dropdown html
    const optionsHtml = apts
      .map((r) => {
        const label = r.apartment_name || `Room ${r.beds24_room_id || r.id}`;
        const sel = String(r.id) === String(selectedId) ? "selected" : "";
        return `<option value="${escapeHtml(r.id)}" ${sel}>${escapeHtml(label)}</option>`;
      })
      .join("");

    // current values (apt overrides or empty)
    const aptName = apt?.apartment_name ?? "";
    const aptArrive = safeTime(apt?.default_arrival_time);
    const aptDepart = safeTime(apt?.default_departure_time);

    const regUrl = apt?.registration_url ?? "";
    const payUrl = apt?.payment_url ?? "";
    const keysUrl = apt?.keys_instructions_url ?? "";

    // global defaults (shown for reference)
    const brand = s.brand_name ?? "";
    const defArr = safeTime(s.default_arrival_time) || "17:00";
    const defDep = safeTime(s.default_departure_time) || "11:00";

    res.send(`
      <h1>Manager</h1>

      <div style="margin-bottom:16px; padding:12px; border:1px solid #ddd;">
        <b>Global defaults</b> (если в апартаменте пусто — можно использовать эти)<br/><br/>
        <form method="POST" action="/manager/defaults/save">
          <label>Brand name</label><br/>
          <input name="brand_name" value="${escapeHtml(brand)}" style="width:320px" /><br/><br/>

          <label>Default arrival time</label><br/>
          <input type="time" name="default_arrival_time" value="${escapeHtml(defArr)}" /><br/><br/>

          <label>Default departure time</label><br/>
          <input type="time" name="default_departure_time" value="${escapeHtml(defDep)}" /><br/><br/>

          <button type="submit">Save defaults</button>
        </form>
      </div>

      <div style="margin-bottom:16px; padding:12px; border:1px solid #ddd;">
        <b>Apartment settings</b><br/><br/>

        <form method="GET" action="/manager">
          <label>Select apartment</label><br/>
          <select name="aptId" onchange="this.form.submit()" style="width:360px">
            ${optionsHtml}
          </select>
        </form>

        <hr style="margin:16px 0;" />

        ${
          !apt
            ? `<div>Нет апартаментов в базе (beds24_rooms пустая).</div>`
            : `
          <form method="POST" action="/manager/apartment/save">
            <input type="hidden" name="id" value="${escapeHtml(apt.id)}" />
          
            <label>Apartment name</label><br/>
            <input name="apartment_name" value="${escapeHtml(aptName)}" style="width:360px" /><br/><br/>

            <label>Arrival time (optional)</label><br/>
            <input type="time" name="default_arrival_time" value="${escapeHtml(aptArrive)}" />
            <small style="margin-left:8px;">(если пусто — будет ${escapeHtml(defArr)})</small>
            <br/><br/>

            <label>Departure time (optional)</label><br/>
            <input type="time" name="default_departure_time" value="${escapeHtml(aptDepart)}" />
            <small style="margin-left:8px;">(если пусто — будет ${escapeHtml(defDep)})</small>
            <br/><br/>

            <label>Registration link</label><br/>
            <input name="registration_url" value="${escapeHtml(regUrl)}" style="width:100%" />
            <br/><small>Можно хранить готовую ссылку под этот апарт.</small><br/><br/>

            <label>Payment link (template)</label><br/>
            <input name="payment_url" value="${escapeHtml(payUrl)}" style="width:100%" />
            <br/><small>Шаблон. Например: https://pay.site/checkout?booking={{BOOKING}}</small><br/><br/>

            <label>Keys / Instructions link</label><br/>
            <input name="keys_instructions_url" value="${escapeHtml(keysUrl)}" style="width:100%" />
            <br/><small>Ссылка на инструкции/ключи (пока можно пусто).</small><br/><br/>

            <button type="submit">Save apartment</button>
          </form>
        `
        }
      </div>
    `);
  } catch (err) {
    console.error("❌ /manager error:", err);
    res.status(500).send("Manager error");
  }
});

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






























































































































































































































