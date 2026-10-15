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
const mask = (n) => { n = String(n || "").trim(); return n.length <= 2 ? n.charAt(0) + "*" : n.slice(0, 2) + "***"; };
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
    // Publik: pembeli membuat pesanan
    if (req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
      const rk = "rl:" + ip;
      const n = await r(["INCR", rk]);
      if (n === 1) await r(["EXPIRE", rk, 3600]);
      if (n > 20) return res.status(429).json({ error: "terlalu banyak" });
      const b = body(req);
      const o = {
        nm: str(b.nm, 60), wa: str(b.wa, 25), lk: str(b.lk, 300),
        prod: str(b.prod, 80), pkg: str(b.pkg, 80), note: str(b.note, 60),
        price: num(b.price, 10000000), q: num(b.q, 100000),
      };
      if (!o.nm || o.wa.replace(/\D/g, "").length < 9 || !o.lk || !o.prod || !o.q) {
        return res.status(400).json({ error: "data tidak lengkap" });
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const hasProof = typeof b.proof === "string" && b.proof.startsWith("data:image/") && b.proof.length <= 450000;
      if (hasProof) await r(["SET", "p:" + id, b.proof, "EX", 5184000]);
      const order = { id, ts: Date.now(), ...o, total: o.price * o.q, status: "menunggu", proof: hasProof };
      await r(["HSET", "orders", id, JSON.stringify(order)]);
      return res.status(200).json({ ok: true, id, code: id.slice(-6).toUpperCase() });
    }
    // Publik: antrian dengan nama disamarkan
    if (req.method === "GET" && q.view === "queue") {
      const list = pairs(await r(["HGETALL", "orders"]))
        .sort((a, b) => b.ts - a.ts).slice(0, 60)
        .map((o) => ({ id: o.id, n: mask(o.nm), prod: o.prod, pkg: o.pkg, q: o.q, status: o.status, ts: o.ts }));
      return res.status(200).json({ queue: list });
    }
    // Admin
    if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
    if (req.method === "GET") {
      if (q.proof) {
        const v = await r(["GET", "p:" + String(q.proof)]);
        return res.status(200).json({ proof: v || null });
      }
      const list = pairs(await r(["HGETALL", "orders"])).sort((a, b) => b.ts - a.ts).slice(0, 500);
      return res.status(200).json({ orders: list });
    }
    const b = body(req);
    if (req.method === "PUT") {
      const v = await r(["HGET", "orders", String(b.id)]);
      if (!v) return res.status(404).json({ error: "tidak ada" });
      const o = JSON.parse(v);
      o.status = b.status === "selesai" ? "selesai" : "menunggu";
      o.doneAt = o.status === "selesai" ? Date.now() : null;
      await r(["HSET", "orders", o.id, JSON.stringify(o)]);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      await r(["HDEL", "orders", String(b.id)]);
      await r(["DEL", "p:" + String(b.id)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
