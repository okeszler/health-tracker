// GET /api/sync-data -> aggregierte Health-Sync-Daten fürs Dashboard
// (Schritte/Puls/Ruhepuls pro Tag, Schlaf als Rohmessungen, Blutdruck/Aktivitäten-Log)
//
// Schritte/Puls/Gewicht werden aus Einzelmessungen live aggregiert statt aus
// vorab akkumulierten Tabellen -- siehe migration_sync_v2.sql für den Hintergrund.
// Schlaf kommt roh (chronologisch) statt nach Kalendertag aggregiert, weil eine
// Nacht über Mitternacht zwei Kalendertage überspannt -- die Gruppierung zu
// zusammenhängenden Nächten passiert auch im Frontend (siehe groupSleepIntoNights
// in index.html), hier zusätzlich serverseitig, um den Ruhepuls (Ø-Puls während der
// Schlafnacht) zu berechnen -- der Tagesdurchschnitt inkl. wacher Aktivität (Sport
// etc.) ist als "Ruhepuls" nicht aussagekräftig.

const SLEEP_GAP_HOURS = 4;

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
      current = { bedtime: r.start, waketime: r.end };
      nights.push(current);
    }
    current.waketime = Math.max(current.waketime, r.end);
  }
  return nights;
}

function toSqlDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const NIGHT_MIN_HOURS = 3; // kurze Nickerchen tagsüber sollen die echte Nacht am selben Wachtag nicht überschreiben

async function computeRestingHr(env, sleepReadings) {
  const nights = groupSleepIntoNights(sleepReadings).filter(
    (n) => n.waketime - n.bedtime >= NIGHT_MIN_HOURS * 3600 * 1000
  );
  const restingByDate = {};
  for (const night of nights) {
    const wakeDate = new Date(night.waketime).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT AVG(bpm) AS avg_bpm, COUNT(*) AS samples FROM sync_pulse_readings
       WHERE (entry_date || ' ' || reading_time) BETWEEN ? AND ?`
    )
      .bind(toSqlDateTime(night.bedtime), toSqlDateTime(night.waketime))
      .all();
    const row = results[0];
    if (row && row.samples) {
      restingByDate[wakeDate] = { resting_bpm: Math.round(row.avg_bpm * 10) / 10, resting_samples: row.samples };
    }
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
      `SELECT sw.entry_date, sw.weight_kg
       FROM sync_weight_readings sw
       WHERE sw.reading_time = (
         SELECT MAX(reading_time) FROM sync_weight_readings sw2 WHERE sw2.entry_date = sw.entry_date
       )
       GROUP BY sw.entry_date
       ORDER BY sw.entry_date DESC`
    ).all(),
    env.DB.prepare("SELECT * FROM sync_bp_readings ORDER BY entry_date DESC, reading_time DESC").all(),
  ]);

  const restingByDate = await computeRestingHr(env, sleep.results);

  return Response.json({
    steps: steps.results,
    pulse: pulse.results.map((p) => ({
      ...p,
      avg_bpm: p.samples ? Math.round((p.sum_bpm / p.samples) * 10) / 10 : null,
      resting_bpm: restingByDate[p.entry_date]?.resting_bpm ?? null,
    })),
    sleep: sleep.results,
    activities: activities.results,
    weight: weight.results,
    bp: bp.results,
  });
}
