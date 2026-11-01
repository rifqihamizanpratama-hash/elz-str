const crypto = require("crypto");
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

const IMG = /^data:image\/(jpeg|png|webp|gif);base64,/;
const MAX_IMG = 600000; // batas 1 foto (karakter)

// Pindahkan foto base64 besar ke key terpisah, ganti dengan link /api/img?id=...
async function externalize(data) {
  const jobs = [];
  let tooBig = false;
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.length > 3000 && IMG.test(v)) {
        if (v.length > MAX_IMG) { tooBig = true; return v; }
        const id = crypto.createHash("sha1").update(v).digest("hex").slice(0, 24);
        jobs.push(r(["SET", "elzimg:" + id, v]));
        return "/api/img?id=" + id;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  const out = walk(data);
  if (tooBig) return { tooBig: true };
  await Promise.all(jobs);
  return { out };
}

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
      const ex = await externalize(b.DATA);
      if (ex.tooBig) return res.status(413).json({ error: "satu foto terlalu besar" });
      const s = JSON.stringify({ DATA: ex.out });
      if (s.length > 900000) return res.status(413).json({ error: "terlalu besar" });
      await r(["SET", "elzdata", s]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
