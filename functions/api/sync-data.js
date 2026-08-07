// GET /api/sync-data -> aggregierte Health-Sync-Daten fürs Dashboard
// (Schritte/Puls/Schlaf/Gewicht pro Tag, Blutdruck/Aktivitäten-Log)
//
// Schritte/Puls/Schlaf/Gewicht werden aus Einzelmessungen live aggregiert statt aus
// vorab akkumulierten Tabellen -- siehe migration_sync_v2.sql für den Hintergrund.

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
      `SELECT entry_date,
         SUM(duration_seconds) AS total_seconds,
         SUM(CASE WHEN stage = 'deep' THEN duration_seconds ELSE 0 END) AS deep_seconds,
         SUM(CASE WHEN stage = 'light' THEN duration_seconds ELSE 0 END) AS light_seconds,
         SUM(CASE WHEN stage = 'rem' THEN duration_seconds ELSE 0 END) AS rem_seconds,
         SUM(CASE WHEN stage = 'awake' THEN duration_seconds ELSE 0 END) AS awake_seconds
       FROM sync_sleep_readings GROUP BY entry_date ORDER BY entry_date DESC`
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

  return Response.json({
    steps: steps.results,
    pulse: pulse.results.map((p) => ({
      ...p,
      avg_bpm: p.samples ? Math.round((p.sum_bpm / p.samples) * 10) / 10 : null,
    })),
    sleep: sleep.results,
    activities: activities.results,
    weight: weight.results,
    bp: bp.results,
  });
}
