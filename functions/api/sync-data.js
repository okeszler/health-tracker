// GET /api/sync-data -> aggregierte Health-Sync-Daten fürs Dashboard
// (Schritte/Puls/Ruhepuls pro Tag, Schlaf als gruppierte Nächte, Blutdruck/
// Aktivitäten-Log)
//
// Schritte/Puls/Gewicht werden aus Einzelmessungen live aggregiert statt aus
// vorab akkumulierten Tabellen -- siehe migration_sync_v2.sql für den Hintergrund.
// Schlaf wird HIER (serverseitig) zu zusammenhängenden Nächten gruppiert (eine
// Nacht überspannt oft zwei Kalendertage) und fertig gruppiert an den Client
// geschickt -- vorher gab es dieselbe Gruppierungslogik zusätzlich nochmal im
// Frontend, was dazu geführt hat, dass ein Bug in beiden Kopien gleichzeitig
// steckte. Jetzt gibt es nur noch diese eine Implementierung.

const SLEEP_GAP_HOURS = 4;
const NIGHT_MIN_HOURS = 3; // kurze Nickerchen tagsüber sollen die echte Nacht am selben Wachtag nicht überschreiben (Ruhepuls-Berechnung)

function groupSleepIntoNights(readings) {
  const withTimes = readings
    .map((r) => {
      const start = new Date(`${r.entry_date}T${r.reading_time}`).getTime();
      return { ...r, start, end: start + r.duration_seconds * 1000 };
    })
    .filter((r) => !isNaN(r.start))
    .sort((a, b) => a.start - b.start);

  const nights = [];
  let current = null;
  for (const r of withTimes) {
    if (!current || r.start - current.waketime > SLEEP_GAP_HOURS * 3600 * 1000) {
      current = { segments: [], bedtime: r.start, waketime: r.end };
      nights.push(current);
    }
    current.segments.push(r);
    current.waketime = Math.max(current.waketime, r.end);
  }
  return nights;
}

function toSqlDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Ein SELECT über alle Nächte statt einer Query pro Nacht: die Bettzeit-Fenster
// werden per nummerierten Parametern (?1/?2, ?3/?4, ...) sowohl im CASE (zur
// Zuordnung jeder Pulsmessung zu ihrer Nacht) als auch im WHERE (zum Filtern)
// wiederverwendet.
async function computeRestingHr(env, nights) {
  const eligible = nights.filter((n) => n.waketime - n.bedtime >= NIGHT_MIN_HOURS * 3600 * 1000);
  if (!eligible.length) return {};

  const caseWhen = [];
  const whereOr = [];
  const binds = [];
  eligible.forEach((n, i) => {
    const p1 = i * 2 + 1;
    const p2 = i * 2 + 2;
    caseWhen.push(`WHEN (entry_date || ' ' || reading_time) BETWEEN ?${p1} AND ?${p2} THEN ${i}`);
    whereOr.push(`(entry_date || ' ' || reading_time) BETWEEN ?${p1} AND ?${p2}`);
    binds.push(toSqlDateTime(n.bedtime), toSqlDateTime(n.waketime));
  });

  const { results } = await env.DB.prepare(
    `SELECT CASE ${caseWhen.join(" ")} END AS night_idx, AVG(bpm) AS avg_bpm, COUNT(*) AS samples
     FROM sync_pulse_readings
     WHERE ${whereOr.join(" OR ")}
     GROUP BY night_idx`
  )
    .bind(...binds)
    .all();

  const restingByDate = {};
  for (const row of results) {
    const night = eligible[row.night_idx];
    if (!night || !row.samples) continue;
    const wakeDate = new Date(night.waketime).toISOString().slice(0, 10);
    restingByDate[wakeDate] = { resting_bpm: Math.round(row.avg_bpm * 10) / 10, resting_samples: row.samples };
  }
  return restingByDate;
}

export async function onRequestGet({ env }) {
  const [steps, pulse, sleep, activities, weight, bp] = await Promise.all([
    env.DB.prepare(
      "SELECT entry_date, SUM(steps) AS steps FROM sync_steps_readings GROUP BY entry_date ORDER BY entry_date DESC"
    ).all(),
    env.DB.prepare(
      `SELECT entry_date, SUM(bpm) AS sum_bpm, COUNT(*) AS samples, MIN(bpm) AS min_bpm, MAX(bpm) AS max_bpm
       FROM sync_pulse_readings GROUP BY entry_date ORDER BY entry_date DESC`
    ).all(),
    env.DB.prepare(
      "SELECT entry_date, reading_time, duration_seconds, stage FROM sync_sleep_readings ORDER BY entry_date, reading_time"
    ).all(),
    env.DB.prepare("SELECT * FROM sync_activities ORDER BY entry_date DESC, start_time DESC").all(),
    env.DB.prepare(
      `SELECT sw.entry_date,
         (SELECT weight_kg FROM sync_weight_readings sw3
          WHERE sw3.entry_date = sw.entry_date ORDER BY reading_time DESC LIMIT 1) AS weight_kg,
         MAX(body_fat_pct) AS body_fat_pct,
         MAX(muscle_pct) AS muscle_pct
       FROM sync_weight_readings sw
       GROUP BY sw.entry_date
       ORDER BY sw.entry_date DESC`
    ).all(),
    env.DB.prepare("SELECT * FROM sync_bp_readings ORDER BY entry_date DESC, reading_time DESC").all(),
  ]);

  const nights = groupSleepIntoNights(sleep.results);
  const restingByDate = await computeRestingHr(env, nights);

  return Response.json({
    steps: steps.results,
    pulse: pulse.results.map((p) => ({
      ...p,
      avg_bpm: p.samples ? Math.round((p.sum_bpm / p.samples) * 10) / 10 : null,
      resting_bpm: restingByDate[p.entry_date]?.resting_bpm ?? null,
    })),
    sleep: sleep.results,
    nights: nights.map((n) => ({
      bedtime: n.bedtime,
      waketime: n.waketime,
      segments: n.segments.map((s) => ({ start: s.start, end: s.end, stage: s.stage })),
    })),
    activities: activities.results,
    weight: weight.results,
    bp: bp.results,
  });
}
