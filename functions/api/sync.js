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

async function importPuls(env, rows) {
  const perDay = new Map();
  for (const r of rows) {
    const { date } = splitHealthSyncTimestamp(r["Datum"]);
    const bpm = toFloat(r["Puls"]);
    if (!date || bpm === null) continue;
    const agg = perDay.get(date) || { sum: 0, count: 0, min: bpm, max: bpm };
    agg.sum += bpm;
    agg.count += 1;
    agg.min = Math.min(agg.min, bpm);
    agg.max = Math.max(agg.max, bpm);
    perDay.set(date, agg);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO sync_pulse_daily (entry_date, sum_bpm, samples, min_bpm, max_bpm)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET
       sum_bpm = sum_bpm + excluded.sum_bpm,
       samples = samples + excluded.samples,
       min_bpm = MIN(min_bpm, excluded.min_bpm),
       max_bpm = MAX(max_bpm, excluded.max_bpm)`
  );
  const batch = [...perDay.entries()].map(([date, a]) =>
    stmt.bind(date, a.sum, a.count, a.min, a.max)
  );
  if (batch.length) await env.DB.batch(batch);
}

async function importSchritte(env, rows) {
  const perDay = new Map();
  for (const r of rows) {
    const { date } = splitHealthSyncTimestamp(r["Datum"]);
    const steps = toInt(r["Schritte"]);
    if (!date || steps === null) continue;
    perDay.set(date, (perDay.get(date) || 0) + steps);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO sync_steps_daily (entry_date, steps) VALUES (?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET steps = steps + excluded.steps`
  );
  const batch = [...perDay.entries()].map(([date, steps]) => stmt.bind(date, steps));
  if (batch.length) await env.DB.batch(batch);
}

const SLEEP_STAGE_COLUMN = {
  light: "light_seconds",
  deep: "deep_seconds",
  rem: "rem_seconds",
  awake: "awake_seconds",
};

async function importSchlaf(env, rows) {
  const perDay = new Map();
  for (const r of rows) {
    const { date } = splitHealthSyncTimestamp(r["Datum"]);
    const durationKey = Object.keys(r).find((k) => /sekund|second|urée|duration/i.test(k));
    const seconds = toInt(r[durationKey]);
    const stage = (r["Schlafstadium"] || "").toLowerCase();
    if (!date || seconds === null) continue;
    const agg =
      perDay.get(date) || { total: 0, deep: 0, light: 0, rem: 0, awake: 0, other: 0 };
    agg.total += seconds;
    const bucket = SLEEP_STAGE_COLUMN[stage];
    if (bucket === "deep_seconds") agg.deep += seconds;
    else if (bucket === "light_seconds") agg.light += seconds;
    else if (bucket === "rem_seconds") agg.rem += seconds;
    else if (bucket === "awake_seconds") agg.awake += seconds;
    else agg.other += seconds;
    perDay.set(date, agg);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO sync_sleep_daily (entry_date, total_seconds, deep_seconds, light_seconds, rem_seconds, awake_seconds, other_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET
       total_seconds = total_seconds + excluded.total_seconds,
       deep_seconds = deep_seconds + excluded.deep_seconds,
       light_seconds = light_seconds + excluded.light_seconds,
       rem_seconds = rem_seconds + excluded.rem_seconds,
       awake_seconds = awake_seconds + excluded.awake_seconds,
       other_seconds = other_seconds + excluded.other_seconds`
  );
  const batch = [...perDay.entries()].map(([date, a]) =>
    stmt.bind(date, a.total, a.deep, a.light, a.rem, a.awake, a.other)
  );
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
  const perDay = new Map();
  for (const r of rows) {
    const { date } = splitHealthSyncTimestamp(r["Datum"]);
    const weight = toFloat(r["Gewicht"] ?? r["Weight"]);
    if (!date || weight === null) continue;
    perDay.set(date, weight); // letzter Wert des Tages gewinnt (Zeilen sind zeitlich sortiert)
  }
  const stmt = env.DB.prepare(
    `INSERT INTO sync_weight_daily (entry_date, weight_kg) VALUES (?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET weight_kg = excluded.weight_kg`
  );
  const batch = [...perDay.entries()].map(([date, w]) => stmt.bind(date, w));
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
