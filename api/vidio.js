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
const okId = (s) => /^[a-z0-9]{6,30}$/.test(s);
const MAXLEN = 3 * 1024 * 1024;

module.exports = async (req, res) => {
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};
    const id = String(q.id || "");
    if (!okId(id)) return res.status(400).json({ error: "id tidak valid" });

    if (req.method === "POST") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const b = body(req);
      if (q.op === "chunk") {
        const n = parseInt(q.n, 10);
        if (!(n >= 0 && n < 300) || typeof b.data !== "string" || b.data.length > 760000) {
          return res.status(400).json({ error: "data tidak valid" });
        }
        await r(["SET", "v:" + id + ":" + n, b.data]);
        return res.status(200).json({ ok: true });
      }
      if (q.op === "done") {
        const meta = { size: Number(b.size), type: /^video\//.test(String(b.type)) ? String(b.type) : "video/mp4", chunks: Number(b.chunks), cs: Number(b.cs) || 524288 };
        if (!(meta.size > 0) || !(meta.chunks > 0 && meta.chunks <= 300)) return res.status(400).json({ error: "data tidak valid" });
        await r(["SET", "v:meta:" + id, JSON.stringify(meta)]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "op tidak dikenal" });
    }

    if (req.method === "GET") {
      const mv = await r(["GET", "v:meta:" + id]);
      if (!mv) return res.status(404).end();
      const m = JSON.parse(mv);
      let a = 0, b = m.size - 1;
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (rg) {
        if (rg[1] !== "") { a = Number(rg[1]); if (rg[2] !== "") b = Number(rg[2]); }
        else if (rg[2] !== "") { a = Math.max(0, m.size - Number(rg[2])); }
      }
      if (a >= m.size || a > b) {
        res.setHeader("Content-Range", "bytes */" + m.size);
        return res.status(416).end();
      }
      b = Math.min(b, m.size - 1, a + MAXLEN - 1);
      const c0 = Math.floor(a / m.cs), c1 = Math.floor(b / m.cs);
      const keys = [];
      for (let i = c0; i <= c1; i++) keys.push("v:" + id + ":" + i);
      const parts = await r(["MGET", ...keys]);
      const buf = Buffer.concat(parts.map((x) => Buffer.from(x || "", "base64")));
      const off = a - c0 * m.cs;
      const out = buf.subarray(off, off + (b - a + 1));
      const partial = !!rg || m.size > MAXLEN;
      res.setHeader("Content-Type", m.type);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (partial) res.setHeader("Content-Range", "bytes " + a + "-" + b + "/" + m.size);
      return res.status(partial ? 206 : 200).send(out);
    }

    if (req.method === "DELETE") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const mv = await r(["GET", "v:meta:" + id]);
      const n = mv ? JSON.parse(mv).chunks : 0;
      for (let i = 0; i < n; i++) await r(["DEL", "v:" + id + ":" + i]);
      await r(["DEL", "v:meta:" + id]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
