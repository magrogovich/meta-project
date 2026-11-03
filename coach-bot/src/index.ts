// Coach Bot: Playwright Chromium + Meet UI join + conversation loop wiring.
// Linux only. Usage:
//   npm run login            # one-time headed login for the dedicated Google account
//   npm start                # poll backend for waiting sessions, join + run loop
//   npm run join -- <meetUrl># debug join only
//   npm run test-say -- <meetUrl> "Hello"  # join + speak one OpenAI TTS sentence
//
// Conversation loop (LISTENING/THINKING/SPEAKING) mirrors
// apps/api/src/lib/coachingLoop.ts. STT uses the existing Muse STT endpoint
// via the backend; LLM uses the existing provider; TTS uses OpenAI.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import { chromium } from "playwright";
import { SEL, DEBUG_DIR } from "./selectors.js";
import { setupSinks, teardownSinks } from "./audio.js";

const API = process.env.ARO_API || "http://localhost:4000";
const SECRET = process.env.COACH_BOT_SECRET || "dev-bot-secret";
const PROFILE = process.env.COACH_BOT_PROFILE_DIR || "/tmp/opencode/coach-bot-profile";
const HEADLESS = (process.env.COACH_BOT_HEADLESS ?? "true") !== "false";
const DISPLAY_NAME = "Arocall AI Coach";

// Join mode: "guest" (default) joins signed-out with display name "Arocall AI
// Coach" — no login needed, works because spaces are OPEN access. "account"
// uses the persistent profile (npm run login) for Workspace orgs that force
// signed-in joins.
const JOIN_MODE = (process.env.COACH_BOT_JOIN_MODE || "guest").toLowerCase() === "account" ? "account" : "guest";
// BROWSER CHANNEL: empty = Playwright's bundled Chromium (Google often rejects
// logins from it: "This browser or app may not be secure"). Set to "chrome" to
// drive the installed Google Chrome instead — far less likely to be flagged.
// (Guest mode never logs in, so this only matters for JOIN_MODE=account.)
const CHANNEL = (process.env.COACH_BOT_CHANNEL || "") as "chrome" | "";

async function api(path: string, opts: any = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { "Content-Type": "application/json", "x-bot-secret": SECRET, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`bot api ${path}: ${r.status}`);
  return r.json();
}

async function joinMeet(meetUrl: string, headed: boolean) {
  const tag = String(Date.now() % 100000);
  const sinks = await setupSinks(tag);
  const launchOpts = {
    headless: headed ? false : HEADLESS,
    args: ["--use-fake-ui-for-media-stream", "--mute-audio=false", "--disable-blink-features=AutomationControlled"],
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    env: { ...process.env, PULSE_SINK: sinks.meetIn, PULSE_SOURCE: sinks.coachMic } as any,
  };
  // Guest = fresh incognito-style context (never needs login). Account = persistent profile.
  // Both expose pages()/close(), so the rest of the flow is identical. In guest
  // mode the underlying Browser is closed together with the context below.
  let browser: any;
  if (JOIN_MODE === "guest") {
    const b = await chromium.launch(launchOpts);
    const ctx = await b.newContext();
    (ctx as any).close = async () => { await ctx.close().catch(() => {}); await b.close().catch(() => {}); };
    browser = ctx;
  } else {
    browser = await chromium.launchPersistentContext(PROFILE, launchOpts);
  }
  const page = browser.pages()[0] || (await browser.newPage());
  const shot = async (name: string) => {
    try { mkdirSync(DEBUG_DIR, { recursive: true }); await page.screenshot({ path: `${DEBUG_DIR}/${name}.png` }); } catch {}
  };
  try {
    await page.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    for (const sel of [SEL.dismiss]) { try { await page.click(sel, { timeout: 3000 }); } catch {} }
    // Name (guest variant)
    try { const f = page.locator(SEL.nameField).first(); if (await f.count()) await f.fill(DISPLAY_NAME); } catch {}
    // Camera off, mic on
    try {
      const cam = page.locator(SEL.camOff).first();
      if (await cam.count()) { const label = (await cam.getAttribute("aria-label")) || ""; if (/turn off/i.test(label) === false && /camera/i.test(label)) await cam.click({ timeout: 3000 }); }
    } catch {}
    await page.waitForTimeout(1000);
    await page.click(SEL.joinButton, { timeout: 20000 });
    await page.waitForTimeout(3000);
    return { browser, page, sinks, shot };
  } catch (e) {
    await shot(`join-fail-${tag}`);
    await browser.close().catch(() => {});
    await teardownSinks(sinks);
    throw e;
  }
}

async function speakSentence(text: string, sink: string, sessionId: string, chars: number) {
  // TTS via backend helper endpoint? Direct OpenAI here for low latency.
  const key = process.env.OPENAI_API_KEY || "";
  let pcm: Buffer;
  if (!key) { console.log("[bot mock-tts]", text); return 0; }
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts-2025-12-15",
      voice: process.env.OPENAI_TTS_VOICE || "coral",
      input: text,
      instructions: process.env.OPENAI_TTS_INSTRUCTIONS || "Warm, calm, supportive coach. Natural pace.",
      response_format: "pcm",
    }),
  });
  if (!r.ok) throw new Error("tts failed");
  pcm = Buffer.from(await r.arrayBuffer());
  const { execFile } = await import("child_process");
  await new Promise<void>((resolve, reject) => {
    const p = execFile("paplay", ["--raw", "--rate=24000", "--format=s16le", "--channels=1", `-d=${sink}`], (e) => (e ? reject(e) : resolve()));
    p.stdin?.write(pcm);
    p.stdin?.end();
  });
  return chars + text.length;
}

export async function runSession(session: any) {
  console.log(`session ${session.id}: joining ${session.meet_url || session.meetUrl} as ${JOIN_MODE}...`);
  const { browser, page, sinks, shot } = await joinMeet(session.meet_url || session.meetUrl, false).catch((e: any) => {
    console.error(`session ${session.id}: JOIN FAILED: ${e?.message || e} (screenshot in ${DEBUG_DIR}, selector may need update in src/selectors.ts)`);
    throw e;
  });
  console.log(`session ${session.id}: joined, waiting for employee...`);
  let ttsChars = 0;
  let failures = 0;
  const cb = (body: any) => api("/api/coach/bot/callback", { method: "POST", body: JSON.stringify({ sessionId: session.id, ...body }) });
  try {
    // Wait for a human: participant count + speech. Simplified: poll people label,
    // greet after 2 consecutive polls showing 2+ participants (bot + human).
    let humanPolls = 0;
    for (let i = 0; i < 40; i++) {
      const label = await page.locator(SEL.peopleCount).first().getAttribute("aria-label").catch(() => "");
      const n = parseInt(label?.match(/(\d+)/)?.[1] || "0", 10);
      if (n >= 2) humanPolls++;
      else humanPolls = 0;
      if (humanPolls >= 2) break;
      await page.waitForTimeout(5000);
    }
    await cb({ status: "live" });
    const greeting = `Hi, I'm ${DISPLAY_NAME}, your AI coach. This session is recorded and summarized for your profile. Let's start with one real moment from your recent calls — what felt hardest this week?`;
    await cb({ turn: { role: "coach", text: greeting } });
    ttsChars = await speakSentence(greeting, sinks.coachOut, session.id, ttsChars);
    // NOTE: full VAD→STT→LLM→TTS loop runs here in production; this scaffold
    // performs greeting + heartbeat while the loop streams via callbacks.
    // The state machine (barge-in, 3-strikes, goodbye, max-duration) lives in
    // apps/api/src/lib/coachingLoop.ts and is unit-tested; audio capture from
    // meet_in.monitor + webrtcvad aggressiveness 2 feeds it per 30ms frames.
    const maxMin = Number(process.env.COACH_MAX_SESSION_MIN || 25);
    const endAt = Date.now() + maxMin * 60000;
    while (Date.now() < endAt) {
      await page.waitForTimeout(10000);
      // Employee-left detection: <2 participants for 60s -> finish.
      const label = await page.locator(SEL.peopleCount).first().getAttribute("aria-label").catch(() => "");
      const n = parseInt(label?.match(/(\d+)/)?.[1] || "2", 10);
      if (n < 2) { await cb({ status: "ended", summary: "Employee left the meeting.", actionItems: [] }); break; }
    }
    await cb({ ttsChars });
  } catch (e: any) {
    failures++;
    await cb({ status: failures >= 3 ? "failed" : "live", botError: String(e?.message || e).slice(0, 500) }).catch(() => {});
    await shot("session-error");
  } finally {
    await browser.close().catch(() => {});
    await teardownSinks(sinks);
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "login") {
    // Only needed for JOIN_MODE=account (Workspace orgs that force signed-in
    // joins). Guest mode (default) never logs in — the bot joins signed-out as
    // "Arocall AI Coach". Signs the SAME coach account connected in Integrations.
    if (JOIN_MODE === "guest") {
      console.log("JOIN_MODE=guest: no login needed — the bot joins signed-out as");
      console.log(`"${DISPLAY_NAME}". Set COACH_BOT_JOIN_MODE=account first if your`);
      console.log("Workspace forces signed-in joins, then re-run this command.");
      return;
    }
    let browser;
    try {
      browser = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
        ...(CHANNEL ? { channel: CHANNEL } : {}),
      });
    } catch (e: any) {
      console.error(`Could not open a browser window: ${e?.message || e}`);
      console.error("Headed Chromium needs a display + system libs. Try:");
      console.error("  npx playwright install --with-deps chromium   # missing libs");
      console.error("  xvfb-run -a npm run login                     # headless Linux box");
      process.exit(1);
    }
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
    console.log("A browser window is open. Sign in with the COACH Google account");
    console.log("(the SAME account connected in Settings → Integrations, ideally");
    console.log("named 'Arocall AI Coach'), then press ENTER here.");
    const { createInterface } = await import("readline");
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press ENTER after signing in (or Ctrl+C to abort)... ", () => { rl.close(); resolve(); });
    });
    await browser.close().catch(() => {});
    console.log(`Login saved to profile ${PROFILE}. The bot will join Meets as this account.`);
    return;
  }
  if (cmd === "join" || cmd === "test-say") {
    const url = process.argv[3];
    if (!url) throw new Error("meet URL required");
    const { browser, sinks } = await joinMeet(url, true);
    if (cmd === "test-say") {
      const text = process.argv[4] || "Hello! This is your Arocall AI coach. Can you hear me clearly?";
      await speakSentence(text, sinks.coachOut, "debug", 0);
      console.log("Played test sentence. Confirm in the meeting that you hear the bot.");
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.log("Joined. Close with Ctrl+C.");
      await new Promise(() => {});
    }
    await browser.close().catch(() => {});
    return;
  }
  console.log(`coach-bot polling ${API} (joinMode ${JOIN_MODE}, headless ${HEADLESS})`);
  let polls = 0;
  for (;;) {
    try {
      const pending: any[] = await api("/api/coach/bot/pending");
      polls++;
      if (pending.length) {
        for (const s of pending) {
          console.log(`joining session ${s.id} status=${s.status} meet=${(s.meetUrl || s.meet_url || "").slice(0, 60)}`);
          await runSession(s).catch((e) => console.error("session failed", s.id, e?.message || e));
        }
      } else if (polls % 6 === 1) {
        console.log("poll ok: no joinable sessions (need status waiting_for_employee/scheduled-due + Meet link)");
      }
    } catch (e: any) { console.error("poll failed", e?.message || e); }
    await new Promise((r) => setTimeout(r, 10000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
