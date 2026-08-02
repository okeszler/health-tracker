// GET    /api/labs               -> alle Laborwerte, neueste zuerst
// POST   /api/labs                -> neuen Laborwert anlegen (auch rückwirkend)
// PUT    /api/labs                -> bestehenden Laborwert bearbeiten (id Pflicht)
// DELETE /api/labs?id=123         -> Laborwert löschen

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM lab_results ORDER BY entry_date DESC, id DESC"
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { entry_date, test_name, value, unit = null, note = null } = body;

  if (!entry_date || !test_name || value === undefined || value === null) {
    return new Response(
      JSON.stringify({ error: "entry_date, test_name und value sind Pflicht" }),
      { status: 400 }
    );
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

  if (!id || !entry_date || !test_name || value === undefined || value === null) {
    return new Response(
      JSON.stringify({ error: "id, entry_date, test_name und value sind Pflicht" }),
      { status: 400 }
    );
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
