import readline from "readline";
import { writeFileSync } from "fs";
const API = process.env.API_URL || "http://localhost:4000";
console.log("=== Arocall agent setup ===");
console.log("CONSENT NOTICE (one-time): this app records calls for QA while a call is active. A recording indicator is shown. Ask your admin for the 'call recording notice' text.");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste session key: ", async (key) => {
  const r = await fetch(`${API}/api/agent/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey: key.trim() }) });
  if (!r.ok) { console.error("Invalid key. Ask admin to regenerate."); process.exit(1); }
  const j = await r.json();
  writeFileSync(new URL("./config.json", import.meta.url), JSON.stringify({ apiUrl: API, sessionKey: key.trim(), employee: j.employee }, null, 2));
  console.log(`Validated for ${j.employee.name}. Config saved. Run 'npm start' (autostart: add to Startup folder / LaunchAgents).`);
  rl.close();
});
