// GET  /api/sync  -> Status: letzte Syncs pro Kategorie
// POST /api/sync  -> liest neue Dateien aus den "Health Sync ..."-Google-Drive-
//                     Ordnern (per Service Account) und schreibt Messungen/
//                     Aktivitäten in D1. Bereits verarbeitete Dateien werden über
//                     sync_files übersprungen, ein Sync ist also idempotent.
//
// Schreib-Sparsamkeit (D1 Free: 100.000 geschriebene Zeilen pro Tag für das
// GANZE Cloudflare-Konto, also auch für die anderen Apps!):
// Health Sync legt täglich zusätzlich zur Tagesdatei eine rollierende 30-Tage-
// Datei ab ("Puls 2026.07.19-2026.08.18 ...", am nächsten Tag "...07.20-08.19").
// Früher wurde bei jeder Datei jeder enthaltene Tag gelöscht und neu geschrieben
// -- bei ~750 Pulsmessungen pro Tag mehr als 100.000 Zeilen pro Datei. Jetzt:
//   1. pro Kategorie+Tag wird ein Fingerabdruck (Hash) des Inhalts gespeichert;
//      nur Tage, deren Inhalt sich wirklich geändert hat, werden neu geschrieben
//   2. ein Tagesbudget (SYNC_DAILY_WRITE_BUDGET) begrenzt die Schreibvorgänge des
//      Syncs -- ist es erreicht, geht es am nächsten Tag weiter, und die anderen
//      Apps im Konto behalten genug Luft

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

// Cloudflare begrenzt externe Anfragen pro Aufruf (Free-Plan: 50). Token +
// 6 Ordnersuchen + 6 Listings = 13, bleiben ~37 -- mit Puffer max. 30 Downloads
// pro Aufruf. Liegen mehr neue Dateien vor (z.B. nach Wochen ohne Sync), meldet
// die Antwort "remaining" > 0 und das Frontend ruft einfach erneut auf.
const MAX_DOWNLOADS_PER_RUN = 30;

// max. geschriebene D1-Zeilen pro Tag (UTC) durch den Sync -- deutlich unter dem
// Konto-Limit von 100.000, damit die anderen Apps nie blockiert werden
const SYNC_DAILY_WRITE_BUDGET = 40000;

// D1: max. 100 gebundene Parameter pro Query
const MAX_PARAMS = 90;

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

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sync_day_hashes (
         category TEXT NOT NULL, entry_date TEXT NOT NULL, hash TEXT NOT NULL,
         PRIMARY KEY (category, entry_date)) WITHOUT ROWID`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sync_usage (
         day TEXT PRIMARY KEY, rows_written INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`
    ),
  ]);
}

// Zählt die tatsächlich geschriebenen Zeilen (D1 meldet sie pro Statement in
// meta.rows_written) und gleicht sie mit dem Tagesbudget ab.
class WriteUsage {
  constructor(day, used) {
    this.day = day;
    this.used = used;
    this.added = 0;
    this.incomplete = false;
  }
  static async load(env) {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare("SELECT rows_written FROM sync_usage WHERE day = ?").bind(day).first();
    return new WriteUsage(day, row?.rows_written || 0);
  }
  track(results) {
    for (const r of [].concat(results)) {
      const n = r?.meta?.rows_written || 0;
      this.used += n;
      this.added += n;
    }
  }
  get exhausted() {
    return this.used >= SYNC_DAILY_WRITE_BUDGET;
  }
  async save(env) {
    if (!this.added) return;
    await env.DB.prepare(
      `INSERT INTO sync_usage (day, rows_written) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET rows_written = rows_written + excluded.rows_written`
    )
      .bind(this.day, this.added)
      .run();
    // alte Tage aufräumen
    await env.DB.prepare("DELETE FROM sync_usage WHERE day < date('now', '-14 days')").run();
  }
}

export async function onRequestPost({ env }) {
  let token;
  try {
    token = await getGoogleAccessToken(env);
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 500 });
  }

  let usage;
  try {
    await ensureTables(env);
    usage = await WriteUsage.load(env);
  } catch (err) {
    return Response.json({ error: `Datenbank nicht beschreibbar: ${err.message || err}` }, { status: 503 });
  }
  if (usage.exhausted) {
    return Response.json({ ok: true, summary: {}, remaining: 0, budgetExhausted: true });
  }

  const summary = {};
  const budget = { left: MAX_DOWNLOADS_PER_RUN };
  let remaining = 0;

  for (const cat of CATEGORIES) {
    try {
      summary[cat.key] = await syncCategory(env, token, cat, budget, usage);
      remaining += summary[cat.key].remaining || 0;
    } catch (err) {
      summary[cat.key] = { error: String(err.message || err) };
    }
  }

  try { await usage.save(env); } catch (err) { /* Limit erreicht -- Zählung geht verloren, Daten nicht */ }

  return Response.json({
    ok: true,
    summary,
    remaining: usage.exhausted ? 0 : remaining,
    pendingTomorrow: usage.exhausted ? remaining : 0,
    budgetExhausted: usage.exhausted,
    rowsWritten: usage.added,
  });
}

async function syncCategory(env, token, cat, budget, usage) {
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

  // newFiles ist nach modifiedTime sortiert (listDriveFiles) -- ältere zuerst,
  // damit bei Aufteilung auf mehrere Aufrufe die neueste Datei pro Tag gewinnt
  let done = 0;
  let changedDays = 0;
  for (const file of newFiles) {
    if (budget.left <= 0 || usage.exhausted) break;
    budget.left--;
    const text = await downloadDriveFile(token, file.id);
    const rows = parseCsv(text);
    changedDays += (await importRows(env, cat.key, rows, usage)) || 0;
    if (usage.incomplete) break; // Budget mitten in der Datei erreicht -> morgen weiter
    usage.track(
      await env.DB.prepare(
        "INSERT INTO sync_files (category, drive_file_id, file_name, modified_time) VALUES (?, ?, ?, ?)"
      )
        .bind(cat.key, file.id, file.name, file.modifiedTime || null)
        .run()
    );
    done++;
  }

  return { newFiles: done, changedDays, remaining: newFiles.length - done };
}

function importRows(env, categoryKey, rows, usage) {
  if (categoryKey === "puls") return importPuls(env, rows, usage);
  if (categoryKey === "schritte") return importSchritte(env, rows, usage);
  if (categoryKey === "schlaf") return importSchlaf(env, rows, usage);
  if (categoryKey === "aktivitaeten") return importAktivitaeten(env, rows, usage);
  if (categoryKey === "gewicht") return importGewicht(env, rows, usage);
  if (categoryKey === "blutdruck") return importBlutdruck(env, rows, usage);
}

async function sha(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Inhalt eines Tages in eine stabile Textform bringen (sortiert, ohne Duplikate)
// -- identisch für frisch geparste Zeilen und für Zeilen aus der Datenbank
const normalizeDay = (rows, fields) =>
  [...new Set(rows.map((r) => fields.map((f) => (r[f] === null || r[f] === undefined ? "" : String(r[f]))).join("|")))]
    .sort()
    .join("\n");

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Ersetzt die Messungen einer Kategorie tageweise -- aber nur für Tage, deren
// Inhalt sich gegenüber dem gespeicherten Stand geändert hat.
//
// Warum überhaupt "Tag ersetzen" statt Zeilen anhängen: Health Sync liefert
// dieselben Tage in mehreren Dateien mit teils minimal abweichenden Zeitstempeln
// -- reines Anhängen hat Tage doppelt gezählt. Die zuletzt importierte Datei
// gewinnt pro Tag.
async function replaceChangedDays(env, usage, { category, table, fields, rows }) {
  const byDay = {};
  for (const r of rows) (byDay[r.entry_date] ||= []).push(r);
  const dates = Object.keys(byDay);
  if (!dates.length) return 0;

  const newHash = {};
  for (const d of dates) newHash[d] = await sha(normalizeDay(byDay[d], fields));

  // gespeicherte Fingerabdrücke laden
  const stored = {};
  for (const part of chunks(dates, MAX_PARAMS - 1)) {
    const { results } = await env.DB.prepare(
      `SELECT entry_date, hash FROM sync_day_hashes WHERE category = ? AND entry_date IN (${part.map(() => "?").join(",")})`
    )
      .bind(category, ...part)
      .all();
    for (const r of results) stored[r.entry_date] = r.hash;
  }

  // Tage ohne gespeicherten Fingerabdruck (Daten von vor dieser Umstellung):
  // aus den vorhandenen Zeilen berechnen -- kostet nur Lesevorgänge, und
  // unveränderte Tage müssen dann nicht neu geschrieben werden
  const unknown = dates.filter((d) => stored[d] === undefined);
  const dbRowsByDay = {};
  for (const part of chunks(unknown, MAX_PARAMS)) {
    const { results } = await env.DB.prepare(
      `SELECT entry_date, ${fields.join(", ")} FROM ${table} WHERE entry_date IN (${part.map(() => "?").join(",")})`
    )
      .bind(...part)
      .all();
    for (const r of results) (dbRowsByDay[r.entry_date] ||= []).push(r);
  }
  for (const d of unknown) {
    if (dbRowsByDay[d]) stored[d] = await sha(normalizeDay(dbRowsByDay[d], fields));
  }

  const changed = dates.filter((d) => stored[d] !== newHash[d]);
  const seedOnly = unknown.filter((d) => stored[d] === newHash[d]);

  const hashStmt = env.DB.prepare(
    `INSERT INTO sync_day_hashes (category, entry_date, hash) VALUES (?, ?, ?)
     ON CONFLICT(category, entry_date) DO UPDATE SET hash = excluded.hash`
  );
  if (seedOnly.length) usage.track(await env.DB.batch(seedOnly.map((d) => hashStmt.bind(category, d, newHash[d]))));

  // mehrzeilige INSERTs (so viele Zeilen wie unter das Parameter-Limit passen)
  const perInsert = Math.floor(MAX_PARAMS / (fields.length + 1));
  const rowPlaceholder = `(${["?", ...fields.map(() => "?")].join(", ")})`;
  let written = 0;
  for (const d of changed) {
    // Budget vor JEDEM Tag prüfen (nicht nur pro Datei) -- eine rollierende
    // 30-Tage-Datei kann sonst allein das Budget weit überschreiten. Bricht der
    // Import hier ab, wird die Datei nicht als erledigt markiert und morgen
    // fortgesetzt; schon geschriebene Tage werden dann per Hash übersprungen.
    if (usage.exhausted) {
      usage.incomplete = true;
      break;
    }
    const statements = [env.DB.prepare(`DELETE FROM ${table} WHERE entry_date = ?`).bind(d)];
    const unique = [...new Map(byDay[d].map((r) => [fields.map((f) => r[f]).join("|"), r])).values()];
    for (const part of chunks(unique, perInsert)) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ${table} (entry_date, ${fields.join(", ")}) VALUES ${part.map(() => rowPlaceholder).join(", ")}`
        ).bind(...part.flatMap((r) => [d, ...fields.map((f) => r[f] ?? null)]))
      );
    }
    statements.push(hashStmt.bind(category, d, newHash[d]));
    // ein Batch pro Tag: D1-Batches laufen als Transaktion, ein Tag wird also
    // immer ganz oder gar nicht ersetzt
    usage.track(await env.DB.batch(statements));
    written++;
  }
  return written;
}

function importPuls(env, rows, usage) {
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const bpm = toInt(r["Puls"]);
    if (!date || bpm === null) continue;
    parsed.push({ entry_date: date, reading_time: time, bpm });
  }
  return replaceChangedDays(env, usage, { category: "puls", table: "sync_pulse_readings", fields: ["reading_time", "bpm"], rows: parsed });
}

// Die Schritte-CSV hat -- anders als Puls -- keine Datenquellen-Spalte. Wenn
// Health Connect mehrere Quellen (z.B. Handy-Sensor + Google Fit) parallel
// mitschreibt, tauchen für denselben Moment mehrere unabhängige Zählungen auf,
// die sich nicht als exakte Duplikate erkennen lassen und die Tagessumme massiv
// aufblähen. Ohne Quellen-Info bleibt nur eine Heuristik: pro Minute wird nur der
// höchste gemeldete Wert übernommen (nicht die Summe aller Quellen für diese
// Minute) -- eine Annäherung, aber deutlich näher an der Realität als rohes
// Aufsummieren.
function importSchritte(env, rows, usage) {
  const perMinute = new Map();
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const steps = toInt(r["Schritte"]);
    if (!date || steps === null) continue;
    const minuteKey = `${date}|${time.slice(0, 5)}`;
    const existing = perMinute.get(minuteKey);
    if (!existing || steps > existing.steps) {
      perMinute.set(minuteKey, { entry_date: date, reading_time: time, steps });
    }
  }
  return replaceChangedDays(env, usage, { category: "schritte", table: "sync_steps_readings", fields: ["reading_time", "steps"], rows: [...perMinute.values()] });
}

function importSchlaf(env, rows, usage) {
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const durationKey = Object.keys(r).find((k) => /sekund|second|urée|duration/i.test(k));
    const seconds = toInt(r[durationKey]);
    const stage = (r["Schlafstadium"] || "").toLowerCase() || null;
    if (!date || seconds === null) continue;
    parsed.push({ entry_date: date, reading_time: time, duration_seconds: seconds, stage });
  }
  return replaceChangedDays(env, usage, { category: "schlaf", table: "sync_sleep_readings", fields: ["reading_time", "duration_seconds", "stage"], rows: parsed });
}

async function importAktivitaeten(env, rows, usage) {
  // ON CONFLICT DO UPDATE statt IGNORE: liefert Health Sync später eine korrigierte
  // Version derselben Aktivität (gleiches Datum/Startzeit/Typ, aber z.B. andere
  // Distanz/Kalorien), soll die neue Version die alte ersetzen. Das WHERE sorgt
  // dafür, dass unveränderte Aktivitäten (kommen in jeder Datei wieder vor) keinen
  // Schreibvorgang kosten.
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
       max_hr = excluded.max_hr
     WHERE source_app IS NOT excluded.source_app
        OR elapsed_seconds IS NOT excluded.elapsed_seconds
        OR active_seconds IS NOT excluded.active_seconds
        OR distance_km IS NOT excluded.distance_km
        OR calories IS NOT excluded.calories
        OR steps IS NOT excluded.steps
        OR avg_hr IS NOT excluded.avg_hr
        OR max_hr IS NOT excluded.max_hr`
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
  if (batch.length) usage.track(await env.DB.batch(batch));
  return 0;
}

// Samsung Health exportiert in der Gewicht-CSV neben dem Gewicht auch
// Körperfettanteil (schon Prozent), Skelettmuskelmasse und Gesamtkörperwasser
// -- die beiden letzteren aber in KG, nicht Prozent (Samsung Health zeigt sie
// auch in der eigenen App als kg an). Fürs einheitliche "%"-Format in Chart und
// Kacheln wird hier auf den Anteil am Körpergewicht umgerechnet (kg /
// Gewicht * 100). Die Waage liefert (noch) nicht immer alle Werte, Samsung Health
// trägt dafür 0.0 als Platzhalter ein -- das wird als "nicht gemessen" (null)
// behandelt statt als echter 0%-Wert.
function nonZero(v) {
  return v === null || v === 0 ? null : v;
}

function kgToPct(kg, weight) {
  const v = nonZero(kg);
  return v != null ? Math.round((v / weight) * 1000) / 10 : null;
}

function importGewicht(env, rows, usage) {
  const parsed = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const weight = toFloat(r["Gewicht"] ?? r["Weight"]);
    if (!date || weight === null) continue;
    parsed.push({
      entry_date: date,
      reading_time: time,
      weight_kg: weight,
      body_fat_pct: nonZero(toFloat(r["Körperfettanteil"])),
      muscle_pct: kgToPct(toFloat(r["Skelettmuskelmasse"]), weight),
      body_water_pct: kgToPct(toFloat(r["Gesamtkörperwasser"]), weight),
    });
  }
  return replaceChangedDays(env, usage, {
    category: "gewicht",
    table: "sync_weight_readings",
    fields: ["reading_time", "weight_kg", "body_fat_pct", "muscle_pct", "body_water_pct"],
    rows: parsed,
  });
}

// Die Blutdruck-Exportdateien sind Monats-/Wochen-Sammlungen, die sich überlappen
// können (dieselbe Messung taucht in mehreren Dateien auf) -- deshalb Einzelzeilen
// mit UNIQUE-Constraint statt Tages-Aggregation. Aktualisiert wird nur, wenn sich
// Puls/Kommentar wirklich geändert haben (sonst kostet jede Datei Schreibvorgänge).
async function importBlutdruck(env, rows, usage) {
  const stmt = env.DB.prepare(
    `INSERT INTO sync_bp_readings (entry_date, reading_time, systolic, diastolic, pulse, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date, reading_time, systolic, diastolic) DO UPDATE SET
       pulse = excluded.pulse,
       note = excluded.note
     WHERE pulse IS NOT excluded.pulse OR note IS NOT excluded.note`
  );
  const batch = [];
  for (const r of rows) {
    const { date, time } = splitHealthSyncTimestamp(r["Datum"]);
    const systolic = toFloat(r["Systolisch"]);
    const diastolic = toFloat(r["Diastolisch"]);
    if (!date || systolic === null || diastolic === null) continue;
    batch.push(stmt.bind(date, time, systolic, diastolic, toFloat(r["Puls"]), r["Kommentar"] || null));
  }
  if (batch.length) usage.track(await env.DB.batch(batch));
  return 0;
}
