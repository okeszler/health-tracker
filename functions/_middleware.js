// Passwortschutz für die gesamte App (Seiten + /api/*).
// Aktiv, sobald der Secret APP_PASSWORD gesetzt ist:
//   npx wrangler pages secret put APP_PASSWORD --project-name=health-tracker
// Ohne gesetztes Secret bleibt die App offen (z.B. für lokale Entwicklung).

const COOKIE_NAME = "ht_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage
const RATE_LIMIT_WINDOW_MIN = 15;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

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

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anmelden — Health Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #FAF3E9; --surface: #FFFFFF; --line: #E9D6BC;
    --text: #3A2A1E; --text-dim: #9C7F63; --terracotta: #D24136; --honey: #EB8A3E;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--ink); color: var(--text); font-family: 'IBM Plex Sans', sans-serif;
  }
  form {
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
    padding: 32px 28px; width: 100%; max-width: 320px; box-shadow: 0 8px 24px rgba(58,42,30,0.08);
  }
  .eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terracotta); }
  h1 { font-size: 22px; margin: 6px 0 20px; font-weight: 600; }
  label { display: block; font-size: 12px; color: var(--text-dim); font-family: 'IBM Plex Mono', monospace; margin-bottom: 6px; }
  input {
    width: 100%; background: var(--ink); border: 1px solid var(--line); border-radius: 6px; color: var(--text);
    padding: 10px 12px; font-family: 'IBM Plex Mono', monospace; font-size: 14px; margin-bottom: 14px;
  }
  input:focus { outline: none; border-color: var(--honey); }
  button {
    width: 100%; background: var(--honey); color: #1a1206; border: none; border-radius: 6px;
    padding: 11px; font-weight: 600; font-size: 14px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .error { color: var(--terracotta); font-size: 13px; margin-bottom: 14px; font-family: 'IBM Plex Mono', monospace; }
</style>
</head>
<body>
  <form id="loginForm">
    <div class="eyebrow">Health Tracker</div>
    <h1>Anmelden</h1>
    <div class="error" id="loginError" style="${error ? "" : "display:none"}">${error || ""}</div>
    <label for="password">Passwort</label>
    <input type="password" id="password" name="password" autofocus required>
    <button type="submit">Einloggen</button>
  </form>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errEl = document.getElementById('loginError');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || 'Falsches Passwort — bitte erneut versuchen.';
        errEl.style.display = 'block';
      }
    });
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

  if (url.pathname === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (env.DB) {
      const { results } = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND attempted_at > datetime('now', ?)`
      )
        .bind(ip, `-${RATE_LIMIT_WINDOW_MIN} minutes`)
        .all();
      if ((results[0]?.n || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return new Response(
          JSON.stringify({ ok: false, error: `Zu viele Versuche. Bitte in ${RATE_LIMIT_WINDOW_MIN} Minuten erneut versuchen.` }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const body = await request.json().catch(() => ({}));
    if (body.password === password) {
      if (env.DB) await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
      const token = await sessionToken(password);
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`
      );
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    if (env.DB) await env.DB.prepare("INSERT INTO login_attempts (ip) VALUES (?)").bind(ip).run();
    return new Response(JSON.stringify({ ok: false, error: "Falsches Passwort" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cookies = parseCookies(request.headers.get("Cookie"));
  const expected = await sessionToken(password);

  if (cookies[COOKIE_NAME] === expected) {
    return next();
  }

  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const error = url.searchParams.get("error") ? "Falsches Passwort — bitte erneut versuchen." : null;
  return new Response(loginPage(error), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
