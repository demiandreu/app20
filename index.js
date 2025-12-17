const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ----- Partee ссылки для апартаментов -----
const PARTEE_LINKS = {
  // ВСТАВЬ СВОИ ССЫЛКИ
  // Пример:
  apt1: "https://u.partee.es/3636642/Cd78OQqWOB63wMJLFmB0JzdLL",
  // apt2: "https://u.partee.es/XXXXXXX/XXXXXXXXXXXX",
  // ...
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
    :root { color-scheme: dark; }

    * { box-sizing: border-box; }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#020617;
      color:#e5e7eb;
      margin:0;
      min-height:100vh;
      display:flex;
      justify-content:center;
      align-items:flex-start;
    }
    .page {
      width:100%;
      max-width:480px;
      padding:16px;
    }
    .card {
      background:#020617;
      border-radius:18px;
      padding:20px 18px 22px;
      box-shadow:0 18px 40px rgba(0,0,0,0.55);
    }
    h1 {
      margin:0 0 8px;
      font-size:20px;
    }
    h2 {
      margin:0 0 6px;
      font-size:16px;
    }
    p {
      margin:0 0 10px;
      font-size:14px;
      color:#9ca3af;
    }
    label {
      font-size:13px;
      display:block;
      margin-bottom:4px;
    }
    input, select {
      width:100%;
      padding:8px 10px;
      border-radius:10px;
      border:1px solid #1f2937;
      background:#020617;
      color:#e5e7eb;
      font-size:14px;
    }
    input:focus, select:focus {
      outline:none;
      border-color:#2563eb;
    }
    .row {
      display:flex;
      gap:8px;
    }
    .row > div { flex:1; }

    .btn-primary,
    .btn-success,
    .btn-link {
      display:inline-block;
      border-radius:999px;
      padding:9px 18px;
      font-weight:600;
      font-size:14px;
      text-decoration:none;
      border:none;
      cursor:pointer;
    }
    .btn-primary { background:#2563eb; color:#fff; }
    .btn-success { background:#22c55e; color:#fff; }
    .btn-link {
      background:transparent;
      color:#9ca3af;
      padding:0;
    }
    .muted { font-size:12px; color:#6b7280; }

    .warnings {
      background:#7f1d1d;
      border-radius:12px;
      padding:10px 12px;
      margin-bottom:12px;
      color:#fecaca;
      font-size:13px;
      text-align:left;
    }
    .warnings p {
      margin:4px 0;
      color:#fecaca;
    }

    @media (min-width: 640px) {
      body { align-items:center; }
      .page { padding:24px; }
      .card { padding:24px 22px 24px; }
      h1 { font-size:22px; }
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

// ----- Главная -----
app.get("/", (req, res) => {
  const html = `
    <h1>RCS Guest Portal</h1>
    <p>Тестовая главная страница портала гостей.</p>
    <p class="muted">Ниже пример ссылки для апартамента <strong>apt1</strong> и брони <strong>ABC123</strong>.</p>
    <p>
      <a href="/booking/apt1/ABC123" class="btn-primary">Открыть пример брони</a>
    </p>
  `;
  res.send(renderPage("RCS Guest Portal", html));
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

  // сегодня и завтра в формате YYYY-MM-DD
  const now = new Date();
  const pad = (n) => (n < 10 ? "0" + n : n);
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const today = `${y}-${m}-${d}`;

  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(now.getDate() + 1);
  const ty = tomorrowDate.getFullYear();
  const tm = pad(tomorrowDate.getMonth() + 1);
  const td = pad(tomorrowDate.getDate());
  const tomorrow = `${ty}-${tm}-${td}`;

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
          <input type="time" name="arrivalTime" required />
        </div>
      </div>

      <div class="row" style="margin-bottom:12px;">
        <div>
          <label>Departure date</label>
          <input type="date" name="departureDate" required value="${tomorrow}" min="${today}" />
        </div>
        <div>
          <label>Departure time</label>
          <input type="time" name="departureTime" required />
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
app.post("/checkin/:aptId/:token", (req, res) => {
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

  // проверки времени
  const warnings = [];
  if (req.body.arrivalTime) {
    const arrivalHour = parseInt(req.body.arrivalTime.split(":")[0], 10);
    if (!Number.isNaN(arrivalHour) && arrivalHour < 17) {
      warnings.push("El check-in es a partir de las 17:00. Si desea llegar antes, por favor contacte con nosotros.");
    }
  }
  if (req.body.departureTime) {
    const departureHour = parseInt(req.body.departureTime.split(":")[0], 10);
    if (!Number.isNaN(departureHour) && departureHour > 11) {
      warnings.push("El check-out es hasta las 11:00. Si necesita salir más tarde, por favor contacte con nosotros.");
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
  `;

  res.send(renderPage("Check-in completado", html));
});

// ----- Запуск сервера -----
app.listen(PORT, () => {
  console.log(`RCS Guest Portal running at http://localhost:${PORT}`);
});
