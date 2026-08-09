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

// Health Sync exportiert Tage nicht stabil: dieselbe Datei wird mit neuer Drive-ID
// neu geschrieben, und gelegentlich taucht zusätzlich eine große Backfill-Datei auf
// (z.B. "Schritte 2026.07.08-2026.08.07...csv"), die denselben Zeitraum nochmal mit
// leicht abweichenden Zeitstempeln liefert. Ein reines UNIQUE-Constraint auf
// (Datum, Zeit, Wert) fängt das nicht ab, wenn sich die Zeitstempel minimal
// unterscheiden -- das hat Tage doppelt gezählt. Deshalb jetzt: pro Datei zuerst
// alle bestehenden Messungen für die in der Datei vorkommenden Tage löschen, dann
// die Datei-Zeilen einfügen. Dateien werden chronologisch nach modifiedTime
// verarbeitet (siehe listDriveFiles), die zuletzt importierte Datei "gewinnt" also
// pro Tag -- unabhängig davon, ob sie eine Tages- oder eine Backfill-Datei ist.
async function replaceByDate(env, table, dateColumn, rows) {
  const dates = [...new Set(rows.map((r) => r._date))];
  if (!dates.length) return;
  const placeholders = dates.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM ${table} WHERE ${dateColumn} IN (${placeholders})`)
    .bind(...dates)
    .run();
}

async function importPuls(env, rows) {
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const bpm = toInt(r["Puls"]);
    if (!date || bpm === null) continue;
    parsed.push({ _date: date, time, bpm });
  }
  await replaceByDate(env, "sync_pulse_readings", "entry_date", parsed);
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_pulse_readings (entry_date, reading_time, bpm) VALUES (?, ?, ?)`
  );
  const batch = parsed.map((p) => stmt.bind(p._date, p.time, p.bpm));
  if (batch.length) await env.DB.batch(batch);
}

// Die Schritte-CSV hat -- anders als Puls -- keine Datenquellen-Spalte. Wenn
// Health Connect mehrere Quellen (z.B. Handy-Sensor + Google Fit) parallel
// mitschreibt, tauchen für denselben Moment mehrere unabhängige Zählungen auf,
// die sich nicht als exakte Duplikate erkennen lassen und die Tagessumme massiv
// aufblähen. Ohne Quellen-Info bleibt nur eine Heuristik: pro Minute wird nur der
// höchste gemeldete Wert übernommen (nicht die Summe aller Quellen für diese
// Minute) -- eine Annäherung, aber deutlich näher an der Realität als rohes
// Aufsummieren.
async function importSchritte(env, rows) {
  const perMinute = new Map();
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const steps = toInt(r["Schritte"]);
    if (!date || steps === null) continue;
    const minuteKey = `${date}|${time.slice(0, 5)}`;
    const existing = perMinute.get(minuteKey);
    if (!existing || steps > existing.steps) {
      perMinute.set(minuteKey, { _date: date, time, steps });
    }
  }
  const parsed = [...perMinute.values()];
  await replaceByDate(env, "sync_steps_readings", "entry_date", parsed);
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_steps_readings (entry_date, reading_time, steps) VALUES (?, ?, ?)`
  );
  const batch = parsed.map((p) => stmt.bind(p._date, p.time, p.steps));
  if (batch.length) await env.DB.batch(batch);
}

async function importSchlaf(env, rows) {
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const durationKey = Object.keys(r).find((k) => /sekund|second|urée|duration/i.test(k));
    const seconds = toInt(r[durationKey]);
    const stage = (r["Schlafstadium"] || "").toLowerCase() || null;
    if (!date || seconds === null) continue;
    parsed.push({ _date: date, time, seconds, stage });
  }
  await replaceByDate(env, "sync_sleep_readings", "entry_date", parsed);
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_sleep_readings (entry_date, reading_time, duration_seconds, stage) VALUES (?, ?, ?, ?)`
  );
  const batch = parsed.map((p) => stmt.bind(p._date, p.time, p.seconds, p.stage));
  if (batch.length) await env.DB.batch(batch);
}

async function importAktivitaeten(env, rows) {
  // ON CONFLICT DO UPDATE statt IGNORE: liefert Health Sync später eine korrigierte
  // Version derselben Aktivität (gleiches Datum/Startzeit/Typ, aber z.B. andere
  // Distanz/Kalorien), soll die neue Version die alte ersetzen statt ignoriert zu werden.
  const stmt = env.DB.prepare(
    `INSERT INTO sync_activities
       (entry_date, start_time, activity_type, source_app, elapsed_seconds, active_seconds, distance_km, calories, steps, avg_hr, max_hr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date, start_time, activity_type) DO UPDATE SET
       source_app = excluded.source_app,
       elapsed_seconds = excluded.elapsed_seconds,
       active_seconds = excluded.active_seconds,
       distance_km = excluded.distance_km,
       calories = excluded.calories,
       steps = excluded.steps,
       avg_hr = excluded.avg_hr,
       max_hr = excluded.max_hr`
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
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const weight = toFloat(r["Gewicht"] ?? r["Weight"]);
    if (!date || weight === null) continue;
    parsed.push({ _date: date, time, weight });
  }
  await replaceByDate(env, "sync_weight_readings", "entry_date", parsed);
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sync_weight_readings (entry_date, reading_time, weight_kg) VALUES (?, ?, ?)`
  );
  const batch = parsed.map((p) => stmt.bind(p._date, p.time, p.weight));
  if (batch.length) await env.DB.batch(batch);
}

// Die Blutdruck-Exportdateien sind Monats-/Wochen-Sammlungen, die sich überlappen
// können (dieselbe Messung taucht in mehreren Dateien auf) -- deshalb Einzelzeilen
// mit UNIQUE-Constraint statt Tages-Aggregation. ON CONFLICT DO UPDATE statt IGNORE,
// damit sich Puls/Kommentar aktualisieren, falls eine spätere Datei dieselbe Messung
// (gleiche Zeit + systolisch/diastolisch) mit ergänzten Werten liefert.
async function importBlutdruck(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT INTO sync_bp_readings (entry_date, reading_time, systolic, diastolic, pulse, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date, reading_time, systolic, diastolic) DO UPDATE SET
       pulse = excluded.pulse,
       note = excluded.note`
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
