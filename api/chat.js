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
const okId = (s) => /^[A-Za-z0-9]{16,40}$/.test(s);

async function getMeta(cid) {
  const v = await r(["HGET", "chat:meta", cid]);
  return v ? JSON.parse(v) : { cid, name: "", wa: "", last: "", lastTs: 0, unreadAdmin: 0, unreadUser: 0 };
}
const saveMeta = (m) => r(["HSET", "chat:meta", m.cid, JSON.stringify(m)]);
async function getMsgs(cid) {
  return ((await r(["LRANGE", "chat:m:" + cid, 0, -1])) || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}
async function push(cid, msg) {
  await r(["RPUSH", "chat:m:" + cid, JSON.stringify(msg)]);
  await r(["LTRIM", "chat:m:" + cid, -100, -1]);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const q = req.query || {};
    const adm = isAdmin(req);
    if (req.method === "GET") {
      if (q.list) {
        if (!adm) return res.status(401).json({ error: "password salah" });
        const flat = (await r(["HGETALL", "chat:meta"])) || [];
        const chats = [];
        for (let i = 0; i < flat.length; i += 2) { try { chats.push(JSON.parse(flat[i + 1])); } catch (e) {} }
        chats.sort((a, b) => b.lastTs - a.lastTs);
        return res.status(200).json({ chats: chats.slice(0, 100) });
      }
      const cid = String(q.cid || "");
      if (!okId(cid)) return res.status(400).json({ error: "id tidak valid" });
      const m = await getMeta(cid);
      if (q.peek) return res.status(200).json({ unread: m.unreadUser || 0 });
      if (q.admin) {
        if (!adm) return res.status(401).json({ error: "password salah" });
        const msgs = await getMsgs(cid);
        if (m.unreadAdmin) { m.unreadAdmin = 0; await saveMeta(m); }
        return res.status(200).json({ msgs, meta: m });
      }
      const msgs = await getMsgs(cid);
      if (m.unreadUser) { m.unreadUser = 0; await saveMeta(m); }
      return res.status(200).json({ msgs });
    }
    if (req.method === "POST") {
      const b = body(req);
      const cid = String(b.cid || "");
      const text = str(b.text, 500);
      if (!okId(cid) || !text) return res.status(400).json({ error: "data tidak valid" });
      const m = await getMeta(cid);
      if (b.admin) {
        if (!adm) return res.status(401).json({ error: "password salah" });
        await push(cid, { r: "a", t: text, ts: Date.now() });
        m.unreadUser = (m.unreadUser || 0) + 1;
      } else {
        const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
        const rk = "rl:c:" + ip;
        const n = await r(["INCR", rk]);
        if (n === 1) await r(["EXPIRE", rk, 600]);
        if (n > 60) return res.status(429).json({ error: "terlalu banyak" });
        const sys = b.sys === true && text.indexOf("🧾") === 0;
        await push(cid, { r: sys ? "s" : "u", t: text, ts: Date.now() });
        if (!sys) m.unreadAdmin = (m.unreadAdmin || 0) + 1;
        if (str(b.name, 40)) m.name = str(b.name, 40);
        if (sys && str(b.wa, 25)) m.wa = str(b.wa, 25);
      }
      m.last = text.slice(0, 80);
      m.lastTs = Date.now();
      await saveMeta(m);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      if (!adm) return res.status(401).json({ error: "password salah" });
      const cid = String(body(req).cid || "");
      await r(["HDEL", "chat:meta", cid]);
      await r(["DEL", "chat:m:" + cid]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
