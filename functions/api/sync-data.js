// GET /api/sync-data -> aggregierte Health-Sync-Daten fürs Dashboard
// (Schritte/Puls/Schlaf pro Tag, Aktivitäten-Log, Gewicht pro Tag)

export async function onRequestGet({ env }) {
  const [steps, pulse, sleep, activities, weight, bp] = await Promise.all([
    env.DB.prepare("SELECT * FROM sync_steps_daily ORDER BY entry_date DESC").all(),
    env.DB.prepare("SELECT * FROM sync_pulse_daily ORDER BY entry_date DESC").all(),
    env.DB.prepare("SELECT * FROM sync_sleep_daily ORDER BY entry_date DESC").all(),
    env.DB.prepare("SELECT * FROM sync_activities ORDER BY entry_date DESC, start_time DESC").all(),
    env.DB.prepare("SELECT * FROM sync_weight_daily ORDER BY entry_date DESC").all(),
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
