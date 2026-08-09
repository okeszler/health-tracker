// Google Service Account: JWT bauen, Access-Token holen, Drive-Dateien lesen.
// Gleiches Muster wie dagoberts-geldspeicher/functions/api/_utils.js, nur mit
// Drive-Readonly-Scope statt Sheets.

function base64url(input) {
  let str;
  if (typeof input === "string") str = btoa(input);
  else str = btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function getGoogleAccessToken(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON ist nicht gesetzt");
  const creds = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await importPrivateKey(creds.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google OAuth Fehler: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Findet einen mit dem Service Account geteilten Ordner per Name.
export async function findDriveFolderId(token, name) {
  const q = encodeURIComponent(
    `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=5`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive-Suche fehlgeschlagen (${name}): ${await res.text()}`);
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

// Listet alle Dateien direkt in einem Ordner (kein Rekursion nötig hier).
export async function listDriveFiles(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime&pageSize=1000`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive-Listing fehlgeschlagen: ${await res.text()}`);
  const data = await res.json();
  return data.files || [];
}

export async function downloadDriveFile(token, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive-Download fehlgeschlagen (${fileId}): ${await res.text()}`);
  return res.text();
}

// CSV-Parser für die Health-Sync-Exporte: Kommas, optionale Anführungszeichen,
// inkl. RFC4180-Escaping ("" innerhalb eines gequoteten Felds -> ein literales ").
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const obj = {};
    header.forEach((h, i) => (obj[h] = cells[i] ?? ""));
    return obj;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++; // escapte Anführungszeichen ("") -> ein literales "
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// "2026.08.07 20:08:01" -> { date: "2026-08-07", time: "20:08:01" }
export function splitHealthSyncTimestamp(value) {
  const [datePart, timePart] = String(value || "").split(" ");
  return { date: (datePart || "").replace(/\./g, "-"), time: timePart || "" };
}

export function toFloat(v) {
  if (v === undefined || v === null || v === "" || v === "null") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

export function toInt(v) {
  const n = toFloat(v);
  return n === null ? null : Math.round(n);
}
