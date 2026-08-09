// GET    /api/labs               -> alle Laborwerte, neueste zuerst
// POST   /api/labs                -> neuen Laborwert anlegen (auch rückwirkend)
// PUT    /api/labs                -> bestehenden Laborwert bearbeiten (id Pflicht)
// DELETE /api/labs?id=123         -> Laborwert löschen

// Laborwerte sind frei benannt (beliebiger Testname + Einheit), deshalb keine
// festen Wertebereiche -- nur Grundplausibilität (Datum, endliche Zahl).
function validateLab({ entry_date, test_name, value }) {
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) return "entry_date fehlt oder ungültig (YYYY-MM-DD)";
  if (!test_name || !String(test_name).trim()) return "test_name fehlt";
  if (typeof value !== "number" || !isFinite(value)) return "value muss eine Zahl sein";
  return null;
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM lab_results ORDER BY entry_date DESC, id DESC"
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { entry_date, test_name, value, unit = null, note = null } = body;

  const validationError = validateLab({ entry_date, test_name, value });
  if (validationError) {
    return new Response(JSON.stringify({ error: validationError }), { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO lab_results (entry_date, test_name, value, unit, note)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(entry_date, test_name.trim(), value, unit, note)
    .run();

  return Response.json({ ok: true });
}

export async function onRequestPut({ request, env }) {
  const body = await request.json();
  const { id, entry_date, test_name, value, unit = null, note = null } = body;

  if (!id) {
    return new Response(JSON.stringify({ error: "id fehlt" }), { status: 400 });
  }
  const validationError = validateLab({ entry_date, test_name, value });
  if (validationError) {
    return new Response(JSON.stringify({ error: validationError }), { status: 400 });
  }

  await env.DB.prepare(
    `UPDATE lab_results SET entry_date = ?, test_name = ?, value = ?, unit = ?, note = ?
     WHERE id = ?`
  )
    .bind(entry_date, test_name.trim(), value, unit, note, id)
    .run();

  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response(JSON.stringify({ error: "id fehlt" }), { status: 400 });

  await env.DB.prepare("DELETE FROM lab_results WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
