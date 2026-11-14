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
  try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch (e) { return {}; }
};
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const mask = (n) => { n = String(n || "").trim(); return (n.length > 2 ? n.slice(0, 2) : n.slice(0, 1)) + "***"; };

// ---------- daftar pesanan: elzo:<id> (JSON), elzoidx (list id terbaru di depan), elzq (cache antrian) ----------
async function loadOrders(max) {
  const ids = await r(["LRANGE", "elzoidx", 0, max - 1]);
  if (!ids || !ids.length) return [];
  const vals = await r(["MGET", ...ids.map((i) => "elzo:" + i)]);
  return vals.filter(Boolean).map((v) => JSON.parse(v));
}
async function rebuildQueue() {
  const list = (await loadOrders(60)).reverse(); // lama -> baru
  const q = list.map((o) => ({ id: o.id, n: mask(o.nm), prod: o.prod, pkg: o.pkg, q: o.q, status: o.status, ts: o.ts }));
  const s = JSON.stringify({ queue: q });
  await r(["SET", "elzq", s]);
  return s;
}

// ---------- harga resmi (sama dengan ep() di web) untuk penjaga pembayaran ----------
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
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};

    if (req.method === "GET") {
      // antrian publik (tanpa nama lengkap)
      if (q.view === "queue") {
        const s = (await r(["GET", "elzq"])) || (await rebuildQueue());
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(s);
      }
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      if (q.proof) {
        const id = String(q.proof).replace(/[^a-z0-9]/g, "");
        const p = await r(["GET", "elzoproof:" + id]);
        return res.status(200).json({ proof: p || null });
      }
      const orders = await loadOrders(300);
      return res.status(200).json({ orders });
    }

    if (req.method === "POST" && !isAdmin(req)) {
      const b = body(req);
      const nm = clip(b.nm, 60).trim();
      const wa = clip(b.wa, 20).replace(/[^\d+]/g, "");
      const prod = clip(b.prod, 80).trim();
      const pkg = clip(b.pkg, 80).trim();
      let qty = Math.floor(+b.q);
      let price = Math.max(0, Math.round(+b.price || 0));
      if (!nm || wa.length < 8 || !prod || !pkg) return res.status(400).json({ ok: false, error: "data tidak lengkap" });
      if (!(qty >= 1 && qty <= 1000)) return res.status(400).json({ ok: false, error: "jumlah tidak valid" });

      // batas kirim: 1 pesanan per 3 detik per alamat
      const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim().slice(0, 45).replace(/[^\w.:]/g, "");
      if ((await r(["SET", "elzrl:" + ip, "1", "NX", "EX", 3])) !== "OK") return res.status(429).json({ ok: false, error: "terlalu cepat" });

      // penjaga pembayaran (hanya mode "Otomatis saja")
      let usedKey = null;
      const raw = await r(["GET", "elzdata"]);
      const DATA = raw ? JSON.parse(raw).DATA : null;
      if (DATA && DATA.__paymode === "auto") {
        const off = officialPrice(DATA, prod, pkg);
        if (!off) return res.status(400).json({ ok: false, error: "produk tidak dikenal" });
        if (off.soldOut) return res.status(409).json({ ok: false, error: "produk sold out" });
        price = off.price;
        if (price * qty > 0) {
          const rid = String(b.payrid || "");
          if (!/^[a-f0-9]{12,32}$/.test(rid)) return res.status(402).json({ ok: false, error: "pembayaran belum terdeteksi" });
          const paid = +(await r(["GET", "elzpaid:" + rid]));
          if (!(paid >= price * qty)) return res.status(402).json({ ok: false, error: "pembayaran belum terdeteksi atau kurang" });
          if ((await r(["SET", "elzused:" + rid, "1", "NX", "EX", 604800])) !== "OK")
            return res.status(409).json({ ok: false, error: "pembayaran ini sudah dipakai" });
          usedKey = "elzused:" + rid;
        }
      }

      const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      const proof = typeof b.proof === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.proof) && b.proof.length < 700000 ? b.proof : null;
      const order = {
        id, ts: Date.now(), status: "menunggu", nm, wa, prod, pkg, q: qty, price, total: price * qty,
        note: clip(b.note, 300), lk: clip(b.lk, 300), proof: !!proof,
      };
      try {
        await r(["SET", "elzo:" + id, JSON.stringify(order)]);
        if (proof) await r(["SET", "elzoproof:" + id, proof, "EX", 1209600]);
        await r(["LPUSH", "elzoidx", id]);
        await r(["LTRIM", "elzoidx", 0, 999]);
        await rebuildQueue();
      } catch (e) {
        if (usedKey) await r(["DEL", usedKey]).catch(() => {});
        throw e;
      }
      return res.status(200).json({ ok: true, id, code: id.toUpperCase() });
    }

    // ---- sisanya khusus admin ----
    if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
    const b = body(req);
    const id = String(b.id || "").replace(/[^a-z0-9]/g, "");
    if (!id) return res.status(400).json({ error: "id tidak valid" });

    if (req.method === "PUT") {
      const v = await r(["GET", "elzo:" + id]);
      if (!v) return res.status(404).json({ error: "pesanan tidak ada" });
      const o = JSON.parse(v);
      if (b.status === "selesai") { o.status = "selesai"; o.doneAt = Date.now(); }
      else if (b.status === "menunggu") { o.status = "menunggu"; delete o.doneAt; }
      else return res.status(400).json({ error: "status tidak valid" });
      await r(["SET", "elzo:" + id, JSON.stringify(o)]);
      await rebuildQueue();
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      await r(["DEL", "elzo:" + id, "elzoproof:" + id]);
      await r(["LREM", "elzoidx", 0, id]);
      await rebuildQueue();
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server error" });
  }
};
