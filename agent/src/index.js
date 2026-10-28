// Background agent: watchdog loop. Production captures WASAPI loopback (Windows) + mic;
// MVP watches ./inbox for .wav files (drop a recording = simulated call) and uploads chunked.
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
const cfgPath = new URL("./config.json", import.meta.url);
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { console.error("No config. Run 'npm run setup' first."); process.exit(1); }
const API = process.env.API_URL || cfg.apiUrl || "http://localhost:4000";
const inbox = new URL("../inbox/", import.meta.url);
if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });
console.log(`agent running for ${cfg.employee?.name} -> ${API} | status: connected | ● indicator shown during upload`);
async function uploadFile(path, name) {
  const buf = readFileSync(path);
  const CH = 256 * 1024, total = Math.max(1, Math.ceil(buf.length / CH)), uploadId = randomUUID();
  console.log(`● RECORDING upload ${name} (${buf.length} bytes, ${total} chunks)`);
  for (let i = 0; i < total; i++) {
    const chunk = buf.subarray(i * CH, (i + 1) * CH);
    const fd = new FormData();
    fd.append("chunk", new Blob([chunk]), "chunk.wav");
    fd.append("uploadId", uploadId); fd.append("index", String(i)); fd.append("total", String(total));
    fd.append("sessionKey", cfg.sessionKey); fd.append("language", "en");
    const r = await fetch(`${API}/api/agent/upload-chunk`, { method: "POST", headers: { "X-Session-Key": cfg.sessionKey }, body: fd });
    if (!r.ok) throw new Error("upload failed " + r.status);
    const j = await r.json();
    if (j.done) console.log(`uploaded -> call ${j.callId}`);
  }
  unlinkSync(path); // delete local after success
}
setInterval(async () => {
  try {
    const files = readdirSync(inbox).filter((f) => f.endsWith(".wav"));
    for (const f of files) { try { await uploadFile(new URL(`../inbox/${f}`, import.meta.url), f); } catch (e) { console.error("retry later:", e.message); } }
  } catch {}
}, 5000);
// crash watchdog: exit code nonzero -> supervisor restarts (pm2 / Task Scheduler / launchd)
process.on("uncaughtException", (e) => { console.error("error status:", e.message); process.exit(1); });
