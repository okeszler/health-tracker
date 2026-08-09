// GET  /api/metrics                -> alle Einträge, neueste zuerst
// POST /api/metrics                -> Eintrag anlegen/aktualisieren (upsert nach Datum,
//                                      fehlende/leere Felder überschreiben bestehende
//                                      Werte NICHT -- so kann man tagsüber schrittweise
//                                      einzelne Werte nachtragen, ohne die anderen zu
//                                      löschen. Um einen Wert wirklich zu löschen, den
//                                      ganzen Tageseintrag löschen und neu anlegen.)
// DELETE /api/metrics?date=YYYY-MM-DD -> Eintrag löschen

// grobe Plausibilitätsgrenzen, nicht medizinisch exakt -- sollen nur Tippfehler
// abfangen (z.B. Gewicht 8,5kg statt 85kg, Blutdruck 1200 statt 120)
const RANGES = {
  weight_kg: [20, 400],
  body_fat_pct: [2, 70],
  muscle_pct: [5, 80],
  body_water_pct: [20, 80],
  bp_systolic: [50, 260],
  bp_diastolic: [30, 160],
  pulse: [20, 250],
};

function validateRanges(body) {
  for (const [field, [min, max]] of Object.entries(RANGES)) {
    const v = body[field];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || isNaN(v) || v < min || v > max) {
      return `${field} sollte zwischen ${min} und ${max} liegen`;
    }
  }
  return null;
}

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

  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
    return new Response(JSON.stringify({ error: "entry_date fehlt oder ungültig (YYYY-MM-DD)" }), { status: 400 });
  }

  const rangeError = validateRanges({ weight_kg, body_fat_pct, muscle_pct, body_water_pct, bp_systolic, bp_diastolic, pulse });
  if (rangeError) {
    return new Response(JSON.stringify({ error: rangeError }), { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO metrics (entry_date, weight_kg, body_fat_pct, muscle_pct, body_water_pct, bp_systolic, bp_diastolic, pulse, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_date) DO UPDATE SET
       weight_kg = COALESCE(excluded.weight_kg, metrics.weight_kg),
       body_fat_pct = COALESCE(excluded.body_fat_pct, metrics.body_fat_pct),
       muscle_pct = COALESCE(excluded.muscle_pct, metrics.muscle_pct),
       body_water_pct = COALESCE(excluded.body_water_pct, metrics.body_water_pct),
       bp_systolic = COALESCE(excluded.bp_systolic, metrics.bp_systolic),
       bp_diastolic = COALESCE(excluded.bp_diastolic, metrics.bp_diastolic),
       pulse = COALESCE(excluded.pulse, metrics.pulse),
       note = COALESCE(excluded.note, metrics.note)`
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
