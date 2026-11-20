// Statistik pengunjung web: kunjungan, pengunjung unik, dan yang sedang online.
const U = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const T = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function post(url, data) {
  const x = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + T, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return x.json();
}
async function r(cmd) {
  const j = await post(U, cmd);
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function pipe(cmds) {
  const j = await post(U.replace(/\/$/, "") + "/pipeline", cmds);
  if (!Array.isArray(j)) throw new Error("pipeline gagal");
  return j.map((x) => x.result);
}
const isAdmin = (req) => !!process.env.ADMIN_PASSWORD && req.headers["x-admin-pw"] === process.env.ADMIN_PASSWORD;
const body = (req) => {
  try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch (e) { return {}; }
};
const wib = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10); // tanggal WIB

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    // dicatat dari halaman web
    if (req.method === "POST") {
      const b = body(req);
      const v = String(b.v || "");
      if (!/^[a-z0-9]{12,40}$/.test(v)) return res.status(400).json({ ok: false });
      const now = Date.now();
      const day = wib(now);
      const cmds = [["ZADD", "elzonl", now, v]];
      if (+b.n === 1) {
        // satu kunjungan dihitung per pengunjung per 10 menit (cegah refresh berulang)
        const fresh = await r(["SET", "elzvr:" + v, "1", "NX", "EX", 600]);
        if (fresh === "OK") {
          cmds.push(["INCR", "elzv:" + day], ["EXPIRE", "elzv:" + day, 8640000]);
          cmds.push(["PFADD", "elzu:" + day, v], ["EXPIRE", "elzu:" + day, 8640000]);
          cmds.push(["PFADD", "elzuall", v], ["INCR", "elzvall"]);
        }
      }
      await pipe(cmds);
      return res.status(200).json({ ok: true });
    }
    // laporan untuk admin
    if (req.method === "GET") {
      if (!isAdmin(req)) return res.status(401).json({ error: "password salah" });
      const now = Date.now();
      const days = Array.from({ length: 14 }, (_, i) => wib(now - i * 86400000)); // hari ini -> 13 hari lalu
      const cmds = [];
      days.forEach((d) => cmds.push(["GET", "elzv:" + d], ["PFCOUNT", "elzu:" + d]));
      cmds.push(["PFCOUNT", ...days.slice(0, 7).map((d) => "elzu:" + d)]);
      cmds.push(["GET", "elzvall"], ["PFCOUNT", "elzuall"]);
      cmds.push(["ZCOUNT", "elzonl", now - 5 * 60000, "+inf"]);
      cmds.push(["ZREMRANGEBYSCORE", "elzonl", "-inf", now - 3600000]);
      const out = await pipe(cmds);
      const list = days.map((d, i) => ({ d, views: +out[i * 2] || 0, uniq: +out[i * 2 + 1] || 0 }));
      const k = days.length * 2;
      return res.status(200).json({
        days: list,
        today: list[0],
        week: { views: list.slice(0, 7).reduce((a, x) => a + x.views, 0), uniq: +out[k] || 0 },
        total: { views: +out[k + 1] || 0, uniq: +out[k + 2] || 0 },
        online: +out[k + 3] || 0,
      });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
