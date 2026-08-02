export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM goals").all();
  const goals = {};
  for (const row of results) goals[row.key] = row.value;
  return Response.json(goals);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const stmt = env.DB.prepare(
    "INSERT INTO goals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const batch = Object.entries(body).map(([key, value]) => stmt.bind(key, value));
  await env.DB.batch(batch);
  return Response.json({ ok: true });
}
