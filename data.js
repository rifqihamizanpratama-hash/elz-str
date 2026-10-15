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
const isAdmin = (req) => !!process.env.ADMIN_PASSWORD && req.headers["x-admin-pw"] === process.env.ADMIN_PASSWORD;
const body = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {});

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    if (req.method === "GET") {
      const v = await r(["GET", "elzdata"]);
      if (!v) return res.status(204).end();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(v);
    }
    if (req.method === "POST") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const b = body(req);
      if (!b.DATA || typeof b.DATA !== "object") return res.status(400).json({ error: "data tidak valid" });
      const s = JSON.stringify({ DATA: b.DATA });
      if (s.length > 900000) return res.status(413).json({ error: "terlalu besar" });
      await r(["SET", "elzdata", s]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
