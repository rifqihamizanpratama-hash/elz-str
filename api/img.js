const U = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const T = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function r(cmd) {
  const x = await fetch(U, {
    method: "POST",
    headers: { Authorization: "Bearer " + T, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await x.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

module.exports = async (req, res) => {
  if (!U || !T) return res.status(500).end();
  try {
    const id = String((req.query && req.query.id) || "").replace(/[^a-f0-9]/g, "").slice(0, 40);
    if (!id) return res.status(400).end();
    const v = await r(["GET", "elzimg:" + id]);
    if (!v) return res.status(404).end();
    const m = String(v).match(/^data:(image\/[a-z]+);base64,([\s\S]*)$/);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(Buffer.from(m[2], "base64"));
  } catch (e) {
    return res.status(500).end();
  }
};
