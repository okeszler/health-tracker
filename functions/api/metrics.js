// GET  /api/metrics                -> alle Einträge, neueste zuerst
// POST /api/metrics                -> Eintrag anlegen/aktualisieren (upsert nach Datum)
// DELETE /api/metrics?date=YYYY-MM-DD -> Eintrag löschen

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM metrics ORDER BY entry_date DESC"
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const {
    entry_date,
    weight_kg = null,
    body_fat_pct = null,
    muscle_pct = null,
    body_water_pct = null,
    bp_systolic = null,
    bp_diastolic = null,
    pulse = null,
    note = null,
  } = body;

  if (!entry_date) {
    return new Response(JSON.stringify({ error: "entry_date fehlt" }), { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO metrics (entry_date, weight_kg, body_fat_pct, muscle_pct, body_water_pct, bp_systolic, bp_diastolic, pulse, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET
       weight_kg = excluded.weight_kg,
       body_fat_pct = excluded.body_fat_pct,
       muscle_pct = excluded.muscle_pct,
       body_water_pct = excluded.body_water_pct,
       bp_systolic = excluded.bp_systolic,
       bp_diastolic = excluded.bp_diastolic,
       pulse = excluded.pulse,
       note = excluded.note`
  )
    .bind(entry_date, weight_kg, body_fat_pct, muscle_pct, body_water_pct, bp_systolic, bp_diastolic, pulse, note)
    .run();

  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date) return new Response(JSON.stringify({ error: "date fehlt" }), { status: 400 });

  await env.DB.prepare("DELETE FROM metrics WHERE entry_date = ?").bind(date).run();
  return Response.json({ ok: true });
}
