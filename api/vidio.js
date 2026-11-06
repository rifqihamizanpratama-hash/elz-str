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
const ID = /^[a-z0-9]{6,40}$/;
const MAX_RESP = 3 * 1024 * 1024; // batas respons Vercel ~4,5 MB, kirim per potongan 3 MB (browser otomatis minta lanjutannya)

module.exports = async (req, res) => {
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};
    const id = String(q.id || "");
    if (!ID.test(id)) return res.status(400).json({ error: "id tidak valid" });

    if (req.method === "POST") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const b = body(req);
      if (q.op === "chunk") {
        const n = parseInt(q.n, 10);
        const d = String(b.data || "");
        if (!(n >= 0 && n < 400) || !d || d.length > 900000) return res.status(400).json({ error: "potongan tidak valid" });
        await r(["SET", "elzvc:" + id + ":" + n, d]);
        return res.status(200).json({ ok: true });
      }
      if (q.op === "done") {
        const chunks = +b.chunks, cs = +b.cs, size = +b.size;
        if (!(chunks > 0 && chunks <= 400 && cs > 0 && size > 0)) return res.status(400).json({ error: "data tidak valid" });
        const keys = Array.from({ length: chunks }, (_, i) => "elzvc:" + id + ":" + i);
        const have = await r(["EXISTS", ...keys]);
        if (have !== chunks) return res.status(409).json({ error: "ada potongan yang hilang, ulangi upload" });
        await r(["SET", "elzvm:" + id, JSON.stringify({ size, type: String(b.type || "video/mp4").slice(0, 40), chunks, cs })]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "op tidak dikenal" });
    }

    if (req.method === "DELETE") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const meta = await r(["GET", "elzvm:" + id]);
      if (meta) {
        const m = JSON.parse(meta);
        await r(["DEL", "elzvm:" + id, ...Array.from({ length: m.chunks }, (_, i) => "elzvc:" + id + ":" + i)]);
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const meta = await r(["GET", "elzvm:" + id]);
      if (!meta) return res.status(404).end();
      const m = JSON.parse(meta);
      let start = 0, end = m.size - 1;
      const rg = req.headers.range;
      const mm = rg && /bytes=(\d*)-(\d*)/.exec(rg);
      if (mm) {
        if (mm[1] !== "") { start = +mm[1]; if (mm[2] !== "") end = Math.min(+mm[2], m.size - 1); }
        else if (mm[2] !== "") { start = Math.max(0, m.size - +mm[2]); }
      }
      if (start > end || start >= m.size) {
        res.setHeader("Content-Range", "bytes */" + m.size);
        return res.status(416).end();
      }
      end = Math.min(end, start + MAX_RESP - 1);
      const c0 = Math.floor(start / m.cs), c1 = Math.floor(end / m.cs);
      const parts = [];
      for (let c = c0; c <= c1; c++) {
        const b64 = await r(["GET", "elzvc:" + id + ":" + c]);
        if (!b64) return res.status(404).end();
        parts.push(Buffer.from(b64, "base64"));
      }
      const off = start - c0 * m.cs;
      const out = Buffer.concat(parts).subarray(off, off + (end - start + 1));
      res.setHeader("Content-Type", m.type);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Content-Length", out.length);
      if (mm || out.length < m.size) {
        res.setHeader("Content-Range", "bytes " + start + "-" + (start + out.length - 1) + "/" + m.size);
        res.status(206);
      } else res.status(200);
      return res.send(out);
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
