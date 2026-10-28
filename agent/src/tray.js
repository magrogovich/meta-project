// Minimal tray/menu stub: console menu (Electron Tray in production).
import readline from "readline";
console.log("[tray] status: connected | menu: (1) Enter session key (2) Status (3) Quit (needs ADMIN_PASSWORD)");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (l) => {
  if (l.trim() === "2") console.log("[tray] connected, watching inbox/");
  if (l.trim() === "3") { if (process.env.ADMIN_PASSWORD) { console.log("quit disabled without admin password — set ADMIN_PASSWORD to allow"); } else rl.close(); }
});
