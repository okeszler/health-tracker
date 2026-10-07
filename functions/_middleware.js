// Passwortschutz für die gesamte App (Seiten + /api/*).
// Aktiv, sobald der Secret APP_PASSWORD gesetzt ist:
//   npx wrangler pages secret put APP_PASSWORD --project-name=oliver-health-tracker
// Ohne gesetztes Secret bleibt die App offen (z.B. für lokale Entwicklung).
//
// Besteht APP_PASSWORD nur aus Ziffern, zeigt die Login-Seite ein PIN-Tastenfeld
// (sendet automatisch ab, sobald alle Stellen eingegeben sind), sonst ein normales
// Passwortfeld.
//
// SYNC_TOKEN (optional, Secret): erlaubt dem Cron-Worker (cron-worker/) den
// automatischen Health-Sync per "Authorization: Bearer <SYNC_TOKEN>" -- nur für
// POST /api/sync, alles andere braucht weiterhin den Login.

const COOKIE_NAME = "ht_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage
const RATE_LIMIT_WINDOW_MIN = 15;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

// ohne Login erreichbar: App-Icons/Manifest (für die Login-Seite und "Zum
// Startbildschirm hinzufügen") -- enthalten keine Gesundheitsdaten
const PUBLIC_PATHS = [/^\/manifest\.json$/, /^\/favicon\.ico$/, /^\/icons\//];

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionToken(password) {
  return sha256Hex(`ht-session:${password}`);
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function loginPage(pinLength) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Anmelden — Health Tracker</title>
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<meta name="theme-color" content="#FAF3E9">
<script>
  (function() {
    var saved = null;
    try { saved = localStorage.getItem('ht-theme'); } catch (e) {}
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#1C140F' : '#FAF3E9');
  })();
</script>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #FAF3E9; --surface: #FFFFFF; --surface-2: #FBEEDF; --line: #E9D6BC;
    --text: #3A2A1E; --text-dim: #9C7F63; --terracotta: #D24136; --honey: #EB8A3E;
  }
  html[data-theme="dark"] {
    color-scheme: dark;
    --ink: #1C140F; --surface: #241A13; --surface-2: #2E2117; --line: #3D2C20;
    --text: #F3E9DC; --text-dim: #B79A80; --terracotta: #E8564A;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; align-items: center; justify-content: center;
    background: var(--ink); color: var(--text); font-family: 'IBM Plex Sans', sans-serif;
    padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom);
    -webkit-user-select: none; user-select: none;
  }
  .card { width: 100%; max-width: 340px; text-align: center; animation: rise .5s cubic-bezier(.2,.8,.2,1) both; }
  .logo { width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 14px; display: block; box-shadow: 0 6px 18px rgba(210,65,54,.25); }
  .eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); }
  h1 { font-size: 22px; margin: 6px 0 26px; font-weight: 600; }
  .dots { display: flex; justify-content: center; gap: 14px; margin-bottom: 14px; min-height: 16px; }
  .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--text-dim); transition: background .15s, border-color .15s, transform .15s; }
  .dot.filled { background: var(--honey); border-color: var(--honey); transform: scale(1.1); }
  .dots.shake { animation: shake .4s; }
  .dots.ok .dot { background: #4A7A6D; border-color: #4A7A6D; }
  .error { color: var(--terracotta); font-size: 13px; min-height: 20px; margin-bottom: 18px; font-family: 'IBM Plex Mono', monospace; }
  .pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px 22px; justify-items: center; }
  .key {
    width: 74px; height: 74px; border-radius: 50%; border: 1px solid var(--line); background: var(--surface);
    color: var(--text); font-family: 'IBM Plex Sans', sans-serif; font-size: 28px; font-weight: 500; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: background .12s, transform .08s;
    touch-action: manipulation;
  }
  .key:active, .key.pressed { background: var(--surface-2); transform: scale(.94); }
  .key.ghost { border-color: transparent; background: none; font-size: 15px; color: var(--text-dim); }
  .key:disabled { opacity: .45; }
  form.pw input {
    width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--text);
    padding: 12px; font-family: 'IBM Plex Mono', monospace; font-size: 16px; margin-bottom: 12px;
  }
  form.pw input:focus { outline: none; border-color: var(--honey); }
  form.pw button { width: 100%; background: var(--honey); color: #1a1206; border: none; border-radius: 8px; padding: 12px; font-weight: 600; font-size: 15px; cursor: pointer; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @keyframes shake { 10%, 90% { transform: translateX(-2px); } 20%, 80% { transform: translateX(4px); } 30%, 50%, 70% { transform: translateX(-8px); } 40%, 60% { transform: translateX(8px); } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/icons/icon-192.png" alt="">
    <div class="eyebrow">Health Tracker</div>
    <h1>${pinLength ? "PIN eingeben" : "Anmelden"}</h1>
    ${
      pinLength
        ? `<div class="dots" id="dots" aria-live="polite">${'<span class="dot"></span>'.repeat(pinLength)}</div>
    <div class="error" id="loginError" role="alert"></div>
    <div class="pad" id="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="key" type="button" data-key="${n}">${n}</button>`).join("")}
      <span></span>
      <button class="key" type="button" data-key="0">0</button>
      <button class="key ghost" type="button" data-key="del" aria-label="Löschen">⌫</button>
    </div>`
        : `<form class="pw" id="pwForm">
      <div class="error" id="loginError" role="alert"></div>
      <input type="password" id="password" autocomplete="current-password" autofocus required aria-label="Passwort">
      <button type="submit">Einloggen</button>
    </form>`
    }
  </div>
  <script>
    const PIN_LENGTH = ${pinLength || 0};
    const errEl = document.getElementById('loginError');
    let busy = false;

    async function tryLogin(password) {
      busy = true;
      errEl.textContent = '';
      let res;
      try {
        res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
      } catch (err) {
        busy = false;
        return { ok: false, error: 'Keine Verbindung — bitte erneut versuchen.' };
      }
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => ({}));
      busy = false;
      return { ok: false, error: data.error || 'Falsch — bitte erneut versuchen.' };
    }

    if (PIN_LENGTH) {
      const dots = document.getElementById('dots');
      const keys = document.querySelectorAll('.key');
      let pin = '';
      const paint = () => dots.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('filled', i < pin.length));

      async function press(key) {
        if (busy) return;
        if (navigator.vibrate) navigator.vibrate(8);
        if (key === 'del') { pin = pin.slice(0, -1); paint(); return; }
        if (pin.length >= PIN_LENGTH) return;
        pin += key;
        paint();
        if (pin.length < PIN_LENGTH) return;
        const result = await tryLogin(pin);
        if (result.ok) {
          dots.classList.add('ok');
          setTimeout(() => location.reload(), 180);
          return;
        }
        if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
        errEl.textContent = result.error;
        dots.classList.remove('shake');
        void dots.offsetWidth; // Animation neu starten
        dots.classList.add('shake');
        setTimeout(() => { pin = ''; paint(); }, 350);
      }

      keys.forEach((k) => k.addEventListener('click', () => press(k.dataset.key)));
      // auch per Hardware-Tastatur bedienbar (Desktop)
      document.addEventListener('keydown', (e) => {
        const key = /^[0-9]$/.test(e.key) ? e.key : e.key === 'Backspace' ? 'del' : null;
        if (!key) return;
        const btn = document.querySelector('.key[data-key="' + key + '"]');
        if (btn) { btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 100); }
        press(key);
      });
    } else {
      document.getElementById('pwForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const result = await tryLogin(document.getElementById('password').value);
        if (result.ok) location.reload();
        else errEl.textContent = result.error;
      });
    }
  </script>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const password = env.APP_PASSWORD;

  // Kein Secret gesetzt -> App bleibt offen (z.B. lokale Entwicklung).
  if (!password) return next();

  const url = new URL(request.url);

  if (PUBLIC_PATHS.some((re) => re.test(url.pathname))) return next();

  if (url.pathname === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (env.DB) {
      // alte Fehlversuche aufräumen, sonst wächst die Tabelle unbegrenzt
      await env.DB.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')").run();
      const { results } = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND attempted_at > datetime('now', ?)`
      )
        .bind(ip, `-${RATE_LIMIT_WINDOW_MIN} minutes`)
        .all();
      if ((results[0]?.n || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return json({ ok: false, error: `Zu viele Versuche. Bitte in ${RATE_LIMIT_WINDOW_MIN} Minuten erneut versuchen.` }, 429);
      }
    }

    const body = await request.json().catch(() => ({}));
    if (body.password === password) {
      if (env.DB) await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
      const token = await sessionToken(password);
      return json({ ok: true }, 200, {
        "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`,
      });
    }
    if (env.DB) await env.DB.prepare("INSERT INTO login_attempts (ip) VALUES (?)").bind(ip).run();
    return json({ ok: false, error: /^\d+$/.test(password) ? "Falsche PIN" : "Falsches Passwort" }, 401);
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  if (
    url.pathname === "/api/sync" &&
    request.method === "POST" &&
    env.SYNC_TOKEN &&
    request.headers.get("Authorization") === `Bearer ${env.SYNC_TOKEN}`
  ) {
    return next();
  }

  const cookies = parseCookies(request.headers.get("Cookie"));
  const expected = await sessionToken(password);

  if (cookies[COOKIE_NAME] === expected) {
    return next();
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Nicht angemeldet" }, 401);
  }

  const pinLength = /^\d+$/.test(password) ? password.length : 0;
  return new Response(loginPage(pinLength), {
    status: 200,
    // X-Login-Page: der Service Worker soll die Login-Seite nicht als App-Shell cachen
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Login-Page": "1" },
  });
}
