// Penjaga pesanan: file orders.js ASLI diganti namanya menjadi _orders.js (tetap dipakai).
// File ini memeriksa pembayaran dulu, lalu meneruskan pesanan ke _orders.js.
const orders = require("./_orders.js");

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
const parse = (req) => {
  try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch (e) { return null; }
};

// harga resmi dari data toko (sama dengan fungsi ep() di web)
function officialPrice(DATA, prod, pkg) {
  const key = String(prod || "").replace(/^TOP UP /, "");
  const d = DATA[key];
  if (!d || !Array.isArray(d.p)) return null;
  const it = d.p.find((x) => x[0] === pkg);
  if (!it) return null;
  if (d.so || (d.sp || []).includes(pkg)) return { soldOut: true };
  let pct = d.pd && d.pd[pkg] != null ? d.pd[pkg] : d.disc || 0;
  pct = Math.max(0, Math.min(99, +pct || 0));
  return { price: Math.round((+it[1] * (100 - pct)) / 100) };
}

module.exports = async (req, res) => {
  let usedKey = null;
  try {
    if (req.method === "POST" && U && T && !isAdmin(req)) {
      const b = parse(req);
      if (b && b.prod) {
        const raw = await r(["GET", "elzdata"]);
        const DATA = raw ? JSON.parse(raw).DATA : null;
        if (DATA && DATA.__paymode === "auto") {
          const off = officialPrice(DATA, b.prod, b.pkg);
          if (!off) return res.status(400).json({ ok: false, error: "produk tidak dikenal" });
          if (off.soldOut) return res.status(409).json({ ok: false, error: "produk sold out" });
          const q = Math.floor(+b.q);
          if (!(q >= 1 && q <= 1000)) return res.status(400).json({ ok: false, error: "jumlah tidak valid" });
          const total = off.price * q;
          if (total > 0) {
            const rid = String(b.payrid || "");
            if (!/^[a-f0-9]{12,32}$/.test(rid)) return res.status(402).json({ ok: false, error: "pembayaran belum terdeteksi" });
            const paid = +(await r(["GET", "elzpaid:" + rid]));
            if (!(paid >= total)) return res.status(402).json({ ok: false, error: "pembayaran belum terdeteksi atau kurang" });
            if ((await r(["SET", "elzused:" + rid, "1", "NX", "EX", 604800])) !== "OK")
              return res.status(409).json({ ok: false, error: "pembayaran ini sudah dipakai" });
            usedKey = "elzused:" + rid;
          }
          // paksa memakai harga resmi, bukan harga kiriman pembeli
          req.body = Object.assign({}, b, { price: off.price, q });
        }
      }
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server error" });
  }
  await orders(req, res);
  // kalau pesanan gagal disimpan, pembayaran boleh dipakai lagi
  try { if (usedKey && res.statusCode >= 400) await r(["DEL", usedKey]); } catch (e) {}
};
