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
const body = (req) => {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch (e) { return { text: req.body }; }
  }
  return req.body || {};
};
const TTL = 1800; // reservasi nominal berlaku 30 menit

// ambil semua nominal "Rp 5.003" dari teks notifikasi
function amounts(text) {
  const out = [];
  const re = /Rp\.?\s*(\d[\d.,]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    const s = m[1].replace(/[.,]00$/, "");
    const n = parseInt(s.replace(/[^\d]/g, ""), 10);
    if (n > 0) out.push(n);
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};
    // Pembeli mengecek apakah pembayarannya sudah masuk
    if (req.method === "GET") {
      const id = String(q.id || "");
      if (!/^[a-f0-9]{12,32}$/.test(id)) return res.status(400).json({ error: "id tidak valid" });
      if (await r(["GET", "elzpaid:" + id])) return res.status(200).json({ paid: true });
      const amt = await r(["GET", "elzrid:" + id]);
      if (!amt) return res.status(200).json({ expired: true });
      return res.status(200).json({ paid: false, amount: +amt });
    }
    if (req.method === "POST") {
      // Pembeli mengunci nominal: pakai nominal asli, tambah Rp 1, 2, 3... hanya kalau bentrok
      if (q.op === "reserve") {
        const base = Math.round(+body(req).base);
        if (!(base > 0 && base <= 10000000)) return res.status(400).json({ error: "nominal tidak valid" });
        const rid = crypto.randomBytes(8).toString("hex");
        for (let k = 0; k < 100; k++) {
          const amount = base + k;
          if ((await r(["SET", "elzpay:" + amount, rid, "NX", "EX", TTL])) === "OK") {
            await r(["SET", "elzrid:" + rid, String(amount), "EX", TTL]);
            return res.status(200).json({ rid, amount, k });
          }
        }
        return res.status(429).json({ error: "sedang ramai, coba lagi sebentar" });
      }
      // HP admin (MacroDroid/Tasker) mengirim isi notifikasi uang masuk
      if (q.op === "notif") {
        if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
        const b = body(req);
        const text = String(b.text || b.notif || b.message || b.msg || b.body || "");
        if (/mengirim|dikirim|kirim ke|bayar ke|transfer ke|top ?up|isi saldo/i.test(text))
          return res.status(200).json({ ok: true, matched: false, skipped: true });
        for (const n of amounts(text)) {
          const rid = await r(["GET", "elzpay:" + n]);
          if (rid) {
            await r(["SET", "elzpaid:" + rid, String(n), "EX", 86400]);
            await r(["DEL", "elzpay:" + n]);
            return res.status(200).json({ ok: true, matched: true, amount: n });
          }
        }
        return res.status(200).json({ ok: true, matched: false });
      }
      return res.status(400).json({ error: "op tidak dikenal" });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
