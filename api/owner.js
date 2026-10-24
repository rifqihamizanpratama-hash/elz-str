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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return res.status(500).json({ error: "database belum tersambung" });
  try {
    const id = String((req.query || {}).id || "");
    const v = await r(["HGET", "jaspot", id]);
    if (!v) return res.status(404).json({ error: "tidak ada" });
    const it = JSON.parse(v);
    if (it.status !== "acc" && it.status !== "sold") return res.status(404).json({ error: "tidak ada" });
    let d = String(it.wa || "").replace(/\D/g, "");
    if (d[0] === "0") d = "62" + d.slice(1);
    else if (d[0] === "8") d = "62" + d;
    return res.status(200).json({ wa: d, title: it.title });
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
