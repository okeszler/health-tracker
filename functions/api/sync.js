// GET  /api/sync  -> Status: letzte Syncs pro Kategorie
// POST /api/sync  -> liest neue Dateien aus den 5 "Health Sync ..."-Google-Drive-
//                     Ordnern (per Service Account) und schreibt Tages-Aggregate/
//                     Aktivitäten in D1. Bereits verarbeitete Dateien werden über
//                     sync_files übersprungen, ein Sync ist also idempotent.

import {
  getGoogleAccessToken,
  findDriveFolderId,
  listDriveFiles,
  downloadDriveFile,
  parseCsv,
  splitHealthSyncTimestamp,
  toFloat,
  toInt,
} from "./_google.js";

const CATEGORIES = [
  { key: "puls", folder: "Health Sync Puls" },
  { key: "schritte", folder: "Health Sync Schritte" },
  { key: "schlaf", folder: "Health Sync Schlaf" },
  { key: "aktivitaeten", folder: "Health Sync Aktivitäten" },
  { key: "gewicht", folder: "Health Sync Gewicht" },
  { key: "blutdruck", folder: "Health Sync Blutdruck" },
];

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT category, COUNT(*) AS files, MAX(imported_at) AS last_imported_at
     FROM sync_files GROUP BY category`
  ).all();
  const byCategory = {};
  for (const row of results) byCategory[row.category] = row;
  return Response.json({
    categories: CATEGORIES.map((c) => ({
      key: c.key,
      folder: c.folder,
      filesImported: byCategory[c.key]?.files || 0,
      lastImportedAt: byCategory[c.key]?.last_imported_at || null,
    })),
  });
}

export async function onRequestPost({ env }) {
  let token;
  try {
    token = await getGoogleAccessToken(env);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 500 });
  }

  const summary = {};

  for (const cat of CATEGORIES) {
    try {
      summary[cat.key] = await syncCategory(env, token, cat);
    } catch (err) {
      summary[cat.key] = { error: String(err.message || err) };
    }
  }

  return Response.json({ ok: true, summary });
}

async function syncCategory(env, token, cat) {
  const folderId = await findDriveFolderId(token, cat.folder);
  if (!folderId) {
    return { skipped: true, reason: "Ordner nicht gefunden oder nicht mit dem Service Account geteilt" };
  }

  const files = (await listDriveFiles(token, folderId)).filter((f) => f.name.toLowerCase().endsWith(".csv"));
  if (!files.length) return { newFiles: 0 };

  const { results: already } = await env.DB.prepare(
    "SELECT drive_file_id FROM sync_files WHERE category = ?"
  )
    .bind(cat.key)
    .all();
  const knownIds = new Set(already.map((r) => r.drive_file_id));
  const newFiles = files.filter((f) => !knownIds.has(f.id));
  if (!newFiles.length) return { newFiles: 0 };

  for (const file of newFiles) {
    const text = await downloadDriveFile(token, file.id);
    const rows = parseCsv(text);
    await importRows(env, cat.key, rows);
    await env.DB.prepare(
      "INSERT INTO sync_files (category, drive_file_id, file_name, modified_time) VALUES (?, ?, ?, ?)"
    )
      .bind(cat.key, file.id, file.name, file.modifiedTime || null)
      .run();
  }

  return { newFiles: newFiles.length };
}

async function importRows(env, categoryKey, rows) {
  if (categoryKey === "puls") return importPuls(env, rows);
  if (categoryKey === "schritte") return importSchritte(env, rows);
  if (categoryKey === "schlaf") return importSchlaf(env, rows);
  if (categoryKey === "aktivitaeten") return importAktivitaeten(env, rows);
  if (categoryKey === "gewicht") return importGewicht(env, rows);
  if (categoryKey === "blutdruck") return importBlutdruck(env, rows);
}

// Health Sync ersetzt seine Tagesdateien offenbar periodisch komplett durch eine
// neue Datei mit neuer Drive-ID statt nur neue Minuten anzuhängen. Statt "bei jeder
// neuen Datei draufaddieren" (zählt denselben Tag dann mehrfach) werden Einzel-
// messungen mit UNIQUE-Constraint gespeichert -- Mehrfachimporte derselben Zeile
// sind dadurch automatisch harmlos, Aggregation passiert live beim Lesen.
async function importPuls(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_pulse_readings (entry_date, reading_time, bpm) VALUES (?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const bpm = toInt(r["Puls"]);
    if (!date || bpm === null) continue;
    batch.push(stmt.bind(date, time, bpm));
  }
  if (batch.length) await env.DB.batch(batch);
}

async function importSchritte(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_steps_readings (entry_date, reading_time, steps) VALUES (?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const steps = toInt(r["Schritte"]);
    if (!date || steps === null) continue;
    batch.push(stmt.bind(date, time, steps));
  }
  if (batch.length) await env.DB.batch(batch);
}

async function importSchlaf(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_sleep_readings (entry_date, reading_time, duration_seconds, stage) VALUES (?, ?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const durationKey = Object.keys(r).find((k) => /sekund|second|urée|duration/i.test(k));
    const seconds = toInt(r[durationKey]);
    const stage = (r["Schlafstadium"] || "").toLowerCase() || null;
    if (!date || seconds === null) continue;
    batch.push(stmt.bind(date, time, seconds, stage));
  }
  if (batch.length) await env.DB.batch(batch);
}

async function importAktivitaeten(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_activities
       (entry_date, start_time, activity_type, source_app, elapsed_seconds, active_seconds, distance_km, calories, steps, avg_hr, max_hr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    if (!date) continue;
    batch.push(
      stmt.bind(
        date,
        time,
        r["Aktivitätstyp"] || null,
        r["Quell-App"] || null,
        toInt(r["Verstrichene Zeit"]),
        toInt(r["Aktive Zeit"]),
        toFloat(r["Entfernung (km)"]),
        toFloat(r["Kalorien (kcal)"]),
        toInt(r["Schritte"]),
        toFloat(r["Durchschnittliche Herzfrequenz"]),
        toFloat(r["Maximale Herzfrequenz"])
      )
    );
  }
  if (batch.length) await env.DB.batch(batch);
}

async function importGewicht(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_weight_readings (entry_date, reading_time, weight_kg) VALUES (?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const weight = toFloat(r["Gewicht"] ?? r["Weight"]);
    if (!date || weight === null) continue;
    batch.push(stmt.bind(date, time, weight));
  }
  if (batch.length) await env.DB.batch(batch);
}

// Die Blutdruck-Exportdateien sind Monats-/Wochen-Sammlungen, die sich überlappen
// können (dieselbe Messung taucht in mehreren Dateien auf) -- deshalb Einzelzeilen
// mit UNIQUE-Constraint statt Tages-Aggregation, INSERT OR IGNORE verhindert Dubletten.
async function importBlutdruck(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_bp_readings (entry_date, reading_time, systolic, diastolic, pulse, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const systolic = toFloat(r["Systolisch"]);
    const diastolic = toFloat(r["Diastolisch"]);
    if (!date || systolic === null || diastolic === null) continue;
    batch.push(
      stmt.bind(date, time, systolic, diastolic, toFloat(r["Puls"]), r["Kommentar"] || null)
    );
  }
  if (batch.length) await env.DB.batch(batch);
}
