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
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const num = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
function pairs(flat) {
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch (e) {}
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};
    // Publik: pelanggan mengajukan titipan
    if (req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
      const rk = "rl:j:" + ip;
      const n = await r(["INCR", rk]);
      if (n === 1) await r(["EXPIRE", rk, 3600]);
      if (n > 10) return res.status(429).json({ error: "terlalu banyak" });
      const b = body(req);
      const o = { nm: str(b.nm, 60), wa: str(b.wa, 25), title: str(b.title, 80), desc: str(b.desc, 300), price: num(b.price, 100000000) };
      const okPhoto = typeof b.photo === "string" && b.photo.startsWith("data:image/") && b.photo.length <= 450000;
      if (!o.nm || o.wa.replace(/\D/g, "").length < 9 || !o.title || !o.price || !okPhoto) {
        return res.status(400).json({ error: "data tidak lengkap" });
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await r(["SET", "jp:" + id, b.photo]);
      await r(["HSET", "jaspot", id, JSON.stringify({ id, ts: Date.now(), ...o, status: "pending", photo: true })]);
      return res.status(200).json({ ok: true, id });
    }
    // Publik: foto titipan yang sudah di-ACC
    if (req.method === "GET" && q.img) {
      const id = String(q.img);
      const v = await r(["HGET", "jaspot", id]);
      if (!v) return res.status(404).end();
      const it = JSON.parse(v);
      if (it.status !== "acc" && it.status !== "sold") return res.status(404).end();
      const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec((await r(["GET", "jp:" + id])) || "");
      if (!m) return res.status(404).end();
      res.setHeader("Content-Type", m[1]);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(Buffer.from(m[2], "base64"));
    }
    // Publik: daftar titipan yang sudah di-ACC
    if (req.method === "GET" && !q.all && !q.photo) {
      const items = pairs(await r(["HGETALL", "jaspot"]))
        .filter((o) => o.status === "acc" || o.status === "sold")
        .sort((a, b) => b.ts - a.ts).slice(0, 60)
        .map((o) => ({ id: o.id, title: o.title, desc: o.desc, price: o.price, ts: o.ts, status: o.status, photo: !!o.photo }));
      return res.status(200).json({ items });
    }
    // Admin
    if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
    if (req.method === "GET") {
      if (q.photo) {
        const v = await r(["GET", "jp:" + String(q.photo)]);
        return res.status(200).json({ photo: v || null });
      }
      const items = pairs(await r(["HGETALL", "jaspot"])).sort((a, b) => b.ts - a.ts).slice(0, 300);
      return res.status(200).json({ items });
    }
    const b = body(req);
    if (req.method === "PUT") {
      const v = await r(["HGET", "jaspot", String(b.id)]);
      if (!v) return res.status(404).json({ error: "tidak ada" });
      const it = JSON.parse(v);
      if (["pending", "acc", "tolak", "sold"].includes(b.status)) it.status = b.status;
      await r(["HSET", "jaspot", it.id, JSON.stringify(it)]);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      await r(["HDEL", "jaspot", String(b.id)]);
      await r(["DEL", "jp:" + String(b.id)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
