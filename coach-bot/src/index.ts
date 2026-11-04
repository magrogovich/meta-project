// Coach Bot: Playwright Chromium + Meet UI join + conversation loop.
// Linux only. Usage:
//   npm run login            # one-time headed login (account join mode only)
//   npm start                # poll backend for waiting sessions, join + run loop
//   npm run join -- <meetUrl># debug join only
//   npm run test-say -- <meetUrl> "Hello"  # join + speak one OpenAI TTS sentence
//
// Audio: parec records meet_in.monitor (employee voice). Energy VAD segments
// utterances (30ms frames, ends after ~800ms silence, <300ms ignored).
// Utterances go to the backend (POST /api/coach/bot/:id/transcribe + /reply),
// which owns all Muse calls and the coaching prompt. Replies are spoken
// sentence-by-sentence with OpenAI TTS; speech during playback = barge-in.
import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
// api.openai.com often resolves IPv6-first; with no IPv6 route, undici
// fetch fails intermittently ("fetch failed") exactly when the machine is
// busy (session start). IPv4-first makes TTS/STT fetches deterministic.
setDefaultResultOrder("ipv4first");
import { mkdirSync, unlinkSync, writeFileSync, readFileSync, existsSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { chromium } from "playwright";
import { SEL, DEBUG_DIR } from "./selectors.js";
import { setupSinks, teardownSinks, moveChromeStreams, type Sinks } from "./audio.js";

const API = process.env.ARO_API || "http://localhost:4000";
const SECRET = process.env.COACH_BOT_SECRET || "dev-bot-secret";
const PROFILE = process.env.COACH_BOT_PROFILE_DIR || `${process.env.HOME || "/tmp"}/.arocall/coach-bot-profile`;
const HEADLESS = (process.env.COACH_BOT_HEADLESS ?? "true") !== "false";
const DISPLAY_NAME = "Arocall AI Coach";
const JOIN_TIMEOUT_MS = Number(process.env.COACH_JOIN_TIMEOUT_MIN || 10) * 60000;
const MAX_SESSION_MS = Number(process.env.COACH_MAX_SESSION_MIN || 25) * 60000;
const VAD_RMS = Number(process.env.COACH_VAD_RMS || 350);

// Join mode: "account" (default) uses the persistent profile logged into the
// dedicated coach account (npm run login) — that account created the space,
// so it is admitted as host. "guest" joins signed-out with a display name;
// spaces are OPEN, but Google frequently rejects signed-out automation with
// "You can't join this video call", so guest is only a fallback.
const JOIN_MODE = (process.env.COACH_BOT_JOIN_MODE || "account").toLowerCase() === "guest" ? "guest" : "account";
const CHANNEL = (process.env.COACH_BOT_CHANNEL || "") as "chrome" | "";

async function api(path: string, opts: any = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { "Content-Type": "application/json", "x-bot-secret": SECRET, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`bot api ${path}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}
const cb = (sessionId: string, body: any) => api("/api/coach/bot/callback", { method: "POST", body: JSON.stringify({ sessionId, ...body }) });

// ---------- WAV encode (16kHz mono s16le -> WAV for the STT endpoint) ----------
function encodeWav(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// ---------- Capture: parec + energy VAD over 30ms frames ----------
const FRAME_BYTES = 480 * 2; // 30ms @ 16kHz s16le
class Capture {
  proc: ChildProcess;
  buf = Buffer.alloc(0);
  frames: Buffer[] = [];
  inSpeech = false;
  silenceMs = 0;
  speechMs = 0;
  queue: { pcm: Buffer; ms: number }[] = [];
  speaking = false;       // bot TTS is playing (barge-in window)
  barged = false;         // barge-in fired for the current playback
  onBargeIn: () => void = () => {};
  lastSpeechAt = 0;
  peakRms = 0;            // diagnostics: loudest frame since last read

  constructor(source: string) {
    this.proc = spawn("parec", [`--device=${source}`, "--raw", "--rate=16000", "--format=s16le", "--channels=1", "--latency-msec=30"]);
    this.proc.on("error", () => {}); // a dead recorder must not crash the bot
    this.proc.stdout?.on("data", (d: Buffer) => this.feed(d));
    this.proc.stderr?.on("data", () => {});
  }
  feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= FRAME_BYTES) {
      const frame = this.buf.subarray(0, FRAME_BYTES);
      this.buf = this.buf.subarray(FRAME_BYTES);
      this.frame(frame);
    }
  }
  frame(frame: Buffer) {
    let sum = 0;
    for (let i = 0; i + 1 < frame.length; i += 2) { const v = frame.readInt16LE(i); sum += v * v; }
    const rms = Math.sqrt(sum / (frame.length / 2));
    if (rms > this.peakRms) this.peakRms = rms;
    const speech = rms >= VAD_RMS;
    if (speech) {
      this.lastSpeechAt = Date.now();
      if (!this.inSpeech) { this.inSpeech = true; this.frames = []; this.speechMs = 0; }
      this.frames.push(Buffer.from(frame));
      this.speechMs += 30;
      this.silenceMs = 0;
      // Barge-in: sustained employee speech while the coach is speaking.
      if (this.speaking && !this.barged && this.speechMs > 300) {
        this.barged = true;
        this.onBargeIn();
      }
    } else if (this.inSpeech) {
      this.frames.push(Buffer.from(frame));
      this.silenceMs += 30;
      if (this.silenceMs >= 550) { // end-of-turn: responsive, still above a breath pause
        const ms = this.frames.length * 30 - this.silenceMs;
        if (ms >= 300) this.queue.push({ pcm: Buffer.concat(this.frames), ms });
        this.inSpeech = false; this.frames = []; this.silenceMs = 0; this.speechMs = 0;
      }
    }
  }
  // Next utterance, or null after timeoutMs (so callers can check end flags).
  async next(timeoutMs: number): Promise<{ pcm: Buffer; ms: number } | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.queue.length) return this.queue.shift()!;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.queue.shift() || null;
  }
  stop() { try { this.proc.kill("SIGKILL"); } catch {} }
}

// ---------- TTS playback (killable for barge-in) ----------
class Speaker {
  proc: ChildProcess | null = null;
  ttsChars = 0;
  async tts(text: string): Promise<Buffer> {
    const key = process.env.OPENAI_API_KEY || "";
    if (!key) { console.log("[bot mock-tts]", text); return Buffer.alloc(0); }
    // One retry: a single transient network failure must not kill a session.
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { return await this.ttsOnce(text, key); } catch (e: any) { lastErr = e; console.warn(`tts attempt ${attempt} failed: ${e?.message || e} (${e?.cause?.code || e?.cause?.message || ""})`); if (attempt < 2) await new Promise((r) => setTimeout(r, 1500)); }
    }
    throw lastErr;
  }
  async ttsOnce(text: string, key: string): Promise<Buffer> {
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
    if (!r.ok) throw new Error(`tts HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  play(pcm: Buffer, sink: string): Promise<void> {
    if (!pcm.length) return new Promise((r) => setTimeout(r, 400)); // mock TTS pause
    return new Promise((resolve, reject) => {
      // --device=, NOT -d: real PulseAudio (container) rejects `-d <sink>`
      // with "Stream error: Invalid argument" and exits instantly — which
      // then crashed the whole bot with an unhandled EPIPE on stdin.
      const p = spawn("paplay", ["--raw", "--rate=24000", "--format=s16le", "--channels=1", `--device=${sink}`]);
      this.proc = p;
      let errOut = "";
      p.stderr?.on("data", (d) => { errOut += String(d).slice(0, 200); });
      p.on("close", (code) => {
        if (this.proc === p) this.proc = null;
        if (code && code !== 0) reject(new Error(`paplay exited ${code}: ${errOut.trim()}`));
        else resolve();
      });
      p.on("error", (e) => { if (this.proc === p) this.proc = null; reject(e); });
      p.stdin?.on("error", () => {}); // EPIPE: close handler will reject
      p.stdin?.end(pcm);
    });
  }
  stop() { try { this.proc?.kill("SIGKILL"); } catch {} this.proc = null; }
  // Speak full text sentence-by-sentence, pipelining TTS of sentence N+1
  // while N plays. Returns true when playback was barged into.
  async speak(text: string, sink: string, capture: Capture): Promise<boolean> {
    const sents = (text.match(/[^.!?]+[.!?]+["']?\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    capture.speaking = true; capture.barged = false;
    try {
      let nextPcm: Promise<Buffer> | null = sents.length ? this.tts(sents[0]) : null;
      for (let i = 0; i < sents.length; i++) {
        const pcm = await nextPcm!;
        this.ttsChars += sents[i].length;
        nextPcm = i + 1 < sents.length ? this.tts(sents[i + 1]) : null;
        nextPcm?.catch(() => {});
        await this.play(pcm, sink);
        if (capture.barged) return true;
      }
      return capture.barged;
    } finally {
      capture.speaking = false;
    }
  }
}

// Kill any Chrome still holding the bot profile. Failed join attempts can
// leave orphaned Chrome mains behind (Playwright's close() returns while
// the processes linger); every later launch then dies with
// ProcessSingleton — observed burning a whole session's join window.
async function killProfileChromes() {
  const { execFile } = await import("child_process");
  const pat = `[u]ser-data-dir=${PROFILE}`;
  await new Promise<void>((r) => execFile("pkill", ["-f", pat], () => r()));
  await new Promise((r) => setTimeout(r, 1500));
  await new Promise<void>((r) => execFile("pkill", ["-9", "-f", pat], () => r()));
}

// Playwright truncates the useful part of launch errors: Chrome's stderr
// line ("Failed to create /profile/SingletonLock: Permission denied (13)")
// sits deep in the call log, past the 240 chars previously sent to the room,
// so an unwritable profile masqueraded as "profile already in use" and the
// retry loop hid it. Extract that line, and preflight writability so the
// failure is immediate, named, and non-retryable.
export function summarizeJoinError(e: any): string {
  const msg = String(e?.message || e || "");
  const detail = msg.match(/Failed to create [^\n]*Singleton[^\n]*/)?.[0] || msg.match(/[^\n]*Permission denied[^\n]*/)?.[0];
  const head = msg.split("\n")[0].slice(0, 160);
  return (detail && !head.includes(detail) ? `${head} — ${detail.trim()}` : head).slice(0, 300);
}

function assertProfileWritable() {
  const probe = `${PROFILE}/.arocall-write-test`;
  try {
    mkdirSync(PROFILE, { recursive: true });
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (e: any) {
    throw new Error(`meet_profile_unwritable: Chrome profile ${PROFILE} is not writable by uid ${process.getuid?.() ?? "?"} (${e?.code || e?.message || e}). In Docker this means the mounted host profile is root-owned or the wrong home is mounted (compose started via sudo expands $HOME to /root). Fix: cd coach-bot && docker compose down && docker compose up -d bot (without sudo), or set COACH_BOT_HOST_HOME to the host user's home in coach-bot/.env. Retrying cannot fix this.`);
  }
}

// ---------- Meet join ----------
async function hasVisibleButton(page: any, pattern: RegExp): Promise<boolean> {
  try {
    const all = page.locator("button[aria-label]");
    const count = await all.count();
    for (let i = 0; i < count; i++) {
      const label = (await all.nth(i).getAttribute("aria-label").catch(() => "")) || "";
      if (pattern.test(label) && await all.nth(i).isVisible().catch(() => false)) return true;
    }
  } catch {}
  return false;
}

async function participantCount(page: any): Promise<number> {
  try {
    return await page.evaluate(() => {
      // Primary: participant tiles carry data-participant-id (locale-proof —
      // the coach account's Meet UI is not English, so aria-label text
      // matching silently returned 0 and the bot never detected the employee).
      const ids = new Set<string>();
      document.querySelectorAll("[data-participant-id]").forEach((el) => {
        const id = el.getAttribute("data-participant-id");
        if (id) ids.add(id);
      });
      if (ids.size) return ids.size;
      let n = 0;
      document.querySelectorAll("[aria-label]").forEach((el) => {
        const m = (el.getAttribute("aria-label") || "").match(/(\d+)\s*(participant|people)/i);
        if (m) n = Math.max(n, parseInt(m[1], 10));
      });
      return n;
    });
  } catch { return 0; }
}

async function clickByLabel(page: any, pattern: RegExp, timeout = 2500): Promise<boolean> {
  try {
    const all = page.locator("button[aria-label]");
    const count = await all.count();
    for (let i = 0; i < count; i++) {
      const label = (await all.nth(i).getAttribute("aria-label").catch(() => "")) || "";
      if (pattern.test(label) && await all.nth(i).isVisible().catch(() => false)) { await all.nth(i).click({ timeout }); return true; }
    }
  } catch {}
  return false;
}

async function joinMeet(meetUrl: string, headed: boolean) {
  const tag = String(Date.now() % 100000);
  const sinks = await setupSinks(tag);
  const launchOpts = {
    headless: headed ? false : HEADLESS,
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    env: { ...process.env, PULSE_SINK: sinks.meetIn, PULSE_SOURCE: sinks.coachMic } as any,
  };
  let browser: any;
  try {
    if (JOIN_MODE === "guest") {
      const b = await chromium.launch(launchOpts);
      const ctx = await b.newContext({ permissions: ["microphone", "camera"], locale: "en-US" });
      const origClose = ctx.close.bind(ctx); // capture first: self-reference recursed forever
      (ctx as any).close = async () => { await origClose().catch(() => {}); await b.close().catch(() => {}); };
      browser = ctx;
    } else {
      // A killed login/bot Chrome leaves stale Singleton locks that make every
      // later launch fail with ProcessSingleton. The bot runs one session at
      // a time, so any lock present here is stale — and any Chrome still
      // holding the profile is an orphan: kill it first. But a lock that
      // cannot be removed because the directory itself is unwritable is a
      // different failure (Permission denied, not "already in use") — check
      // that first so it fails fast with its real name.
      assertProfileWritable();
      await killProfileChromes();
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try { unlinkSync(`${PROFILE}/${f}`); } catch {}
      }
      browser = await chromium.launchPersistentContext(PROFILE, { ...launchOpts, permissions: ["microphone", "camera"], locale: "en-US" } as any);
    }
  } catch (e) {
    await killProfileChromes();
    await teardownSinks(sinks); // launch happens before the join try block
    throw e;
  }
  // The profile may have persisted a denied camera permission for Meet
  // (which makes Meet show the blocking modal) — re-grant explicitly.
  try { await browser.grantPermissions(["microphone", "camera"], { origin: "https://meet.google.com" }); } catch {}
  const page = browser.pages()[0] || (await browser.newPage());
  const shot = async (name: string) => {
    try { mkdirSync(DEBUG_DIR, { recursive: true }); await page.screenshot({ path: `${DEBUG_DIR}/${name}.png` }); } catch {}
  };
  try {
    await page.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Meet interstitials ("Do you want people to see/hear you?" -> Continue
    // without camera/microphone, permission nags) can appear seconds after
    // load and block the pre-join screen. Keep dismissing until Join shows.
    for (let i = 0; i < 20; i++) {
      let clicked = false;
      // Generic permission-blocked modal ("Meet has been blocked from using
      // your camera") covers the Join button — close it via its X first.
      try {
        const x = page.locator('button[aria-label*="close" i]').first();
        if (await x.count() && await x.isVisible()) { await x.click({ timeout: 1500 }); clicked = true; }
      } catch {}
      for (const text of ["Continue without camera and microphone", "Continue without camera", "Continue without microphone", "Dismiss", "Got it"]) {
        try {
          const el = page.locator(`button, [role="button"]`).filter({ hasText: text }).first();
          if (await el.count() && await el.isVisible()) { await el.click({ timeout: 2000 }); clicked = true; }
        } catch {}
      }
      const joinVisible = await page.locator(SEL.joinButton).first().isVisible().catch(() => false);
      const nameVisible = await page.locator(SEL.nameField).first().isVisible().catch(() => false);
      if (joinVisible || nameVisible) break;
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/that’s an error|that's an error/i.test(bodyText)) {
        throw new Error("meet_google_error: Google returned an error page (rate-limited after repeated automated joins — wait a few minutes and retry).");
      }
      if (/you can't join this video call/i.test(bodyText)) {
        throw new Error(JOIN_MODE === "guest"
          ? "meet_join_rejected: Google rejected the signed-out guest join. Switch to account mode: set COACH_BOT_JOIN_MODE=account in coach-bot/.env, run npm run login (coach account), restart the bot."
          : "meet_join_rejected: Google refused the join (often: the host/employee has not entered yet, or the coach account needs to re-login).");
      }
      await page.waitForTimeout(clicked ? 1000 : 1500);
    }
    // Name (guest variant): required before Meet enables Join.
    try {
      const f = page.locator(SEL.nameField).first();
      if (await f.count()) { await f.fill(DISPLAY_NAME); await page.waitForTimeout(500); }
    } catch {}
    // Pre-join toggles state-read from aria-labels: "Turn off X" = X is ON.
    await clickByLabel(page, /turn off camera/i).catch(() => {});       // camera on -> off
    await clickByLabel(page, /turn on microphone/i).catch(() => {});    // mic off -> on
    if (page.url().includes("accounts.google.com")) {
      throw new Error("meet_join_needs_login: bot profile is not signed in. Run: cd coach-bot && npm run login (sign in with the coach account), then restart the bot.");
    }
    await page.waitForTimeout(800);
    await page.click(SEL.joinButton, { timeout: 20000 });
    // Verify we actually entered the call (Leave-call control appears);
    // a silent pre-join stall was the old "bot never showed up" failure.
    // Fail fast on Google's explicit rejection / sign-in walls instead.
    const leaveBtn = page.locator('[aria-label*="Leave call" i]').first();
    const joinDeadline = Date.now() + 45000;
    for (;;) {
      if (await leaveBtn.isVisible().catch(() => false)) break;
      // Post-click interstitials (headed Chrome shows them after Join):
      // "Do you want people to see you?" -> Continue without camera;
      // the microphone twin -> Use microphone (bot must be audible).
      try {
        const x = page.locator('button[aria-label*="close" i]').first();
        if (await x.count() && await x.isVisible()) await x.click({ timeout: 1500 });
      } catch {}
      for (const text of ["Continue without camera", "Use microphone"]) {
        try {
          const el = page.locator(`button, [role="button"]`).filter({ hasText: text }).first();
          if (await el.count() && await el.isVisible()) await el.click({ timeout: 2000 });
        } catch {}
      }
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/that’s an error|that's an error/i.test(bodyText)) {
        throw new Error("meet_google_error: Google returned an error page (rate-limited after repeated automated joins — wait a few minutes and retry).");
      }
      if (/you can't join this video call/i.test(bodyText)) {
        throw new Error(JOIN_MODE === "guest"
          ? "meet_join_rejected: Google rejected the signed-out guest join. Switch to account mode: set COACH_BOT_JOIN_MODE=account in coach-bot/.env, run npm run login (coach account), restart the bot."
          : "meet_join_rejected: Google refused the join. Check the debug screenshot; the coach account may need to re-login (npm run login).");
      }
      if (page.url().includes("accounts.google.com")) {
        throw new Error("meet_join_needs_login: bot profile is not signed in. Run: cd coach-bot && npm run login (sign in with the coach account), then restart the bot.");
      }
      if (Date.now() > joinDeadline) throw new Error("meet_join_timeout: clicked Join but never entered the call (see debug screenshot)");
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1000);
    return { browser, page, sinks, shot };
  } catch (e) {
    await shot(`join-fail-${tag}`);
    await browser.close().catch(() => {});
    await killProfileChromes();
    await teardownSinks(sinks);
    throw e;
  }
}

async function ttsTest(text: string, sink: string) {
  const sp = new Speaker();
  const pcm = await sp.tts(text);
  sp.ttsChars += text.length;
  await sp.play(pcm, sink);
}

// ---------- Session ----------
export async function runSession(session: any) {
  const sessionId = session.id;
  const meetUrl = session.meetUrl || session.meet_url;
  console.log(`session ${sessionId}: joining ${meetUrl} as ${JOIN_MODE}...`);
  const speaker = new Speaker();
  let joined: Awaited<ReturnType<typeof joinMeet>> | null = null;
  let lastErr: any = null;
  // Keep retrying across the join window: with consumer-created spaces a
  // non-host bot is rejected ("can't join") until the host/employee has
  // entered, so an early rejection is expected, not fatal. Only a missing
  // login aborts immediately (retrying cannot fix it).
  const joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
  for (let attempt = 1; !joined && Date.now() < joinDeadline; attempt++) {
    try { joined = await joinMeet(meetUrl, false); }
    catch (e: any) {
      lastErr = e;
      console.error(`session ${sessionId}: join attempt ${attempt} failed: ${e?.message || e}`);
      const fatal = /meet_join_needs_login|meet_profile_unwritable/.test(String(e?.message || e));
      await cb(sessionId, { botError: `join attempt ${attempt} failed${fatal ? " (fatal, not retrying)" : " (retrying until the employee arrives or the window closes)"}: ${summarizeJoinError(e)}` }).catch(() => {});
      if (fatal) break;
      // Stop retrying if the session was ended/expired from the room meanwhile.
      const st = await api(`/api/coach/bot/${sessionId}/status`).catch(() => null);
      if (st && ["ended", "expired", "failed"].includes(st.status)) { console.log(`session ${sessionId}: ${st.status} while joining, giving up`); return; }
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  if (!joined) {
    await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "failed", botError: `join failed: ${summarizeJoinError(lastErr)}`, ttsChars: 0 }) }).catch(() => {});
    return;
  }
  let activeAbort: AbortController | null = null;
  const { browser, page, sinks, shot } = joined;
  // Route Chrome's live call streams onto the virtual devices (belt and
  // braces with the default-device switch in setupSinks).
  await moveChromeStreams(sinks).catch(() => {});
  const capture = new Capture(`${sinks.meetIn}.monitor`);
  capture.onBargeIn = () => { console.log(`session ${sessionId}: barge-in, stopping playback`); speaker.stop(); try { activeAbort?.abort(); } catch {} };
  let externalEnd = false;
  let employeeGoneSince = 0;
  let employeeLeft = false;
  const watcher = setInterval(async () => {
    try {
      const st = await api(`/api/coach/bot/${sessionId}/status`);
      if (["ended", "expired", "failed"].includes(st.status)) externalEnd = true;
      // Employee-gone detection uses Meet's own "You're the only one here"
      // empty-call state (UI is forced to en-US). Participant tile counts
      // proved unusable: in speaker view with the bot's camera off, Meet
      // unmounts tiles and the count reads 1 while the employee is present,
      // which killed live sessions right after the greeting.
      const alone = await page.evaluate(() => /only one here/i.test(document.body?.innerText || "")).catch(() => false);
      if (alone) { if (!employeeGoneSince) employeeGoneSince = Date.now(); if (Date.now() - employeeGoneSince > 60000) employeeLeft = true; }
      else employeeGoneSince = 0;
    } catch {}
  }, 5000);
  const startedAt = Date.now();
  try {
    // Wait for the employee: participant count >=2 twice in a row.
    let humanPolls = 0;
    while (Date.now() - startedAt < JOIN_TIMEOUT_MS) {
      if (externalEnd) return;
      const n = await participantCount(page);
      humanPolls = n >= 2 ? humanPolls + 1 : 0;
      if (humanPolls >= 2) break;
      await page.waitForTimeout(2000);
    }
    if (humanPolls < 2) {
      console.log(`session ${sessionId}: employee never joined`);
      await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "no_show", ttsChars: speaker.ttsChars }) }).catch(() => {});
      return;
    }
    // Give speech a brief chance to start (spec), but greet regardless so a
    // silent employee still hears the coach first.
    const speechWaitEnd = Date.now() + 15000;
    while (!capture.lastSpeechAt && Date.now() < speechWaitEnd && !externalEnd) await new Promise((r) => setTimeout(r, 300));
    await cb(sessionId, { status: "live" });
    console.log(`session ${sessionId}: employee present, session live`);
    // The Meet mic can still be muted in-call (pre-join toggle state does
    // not always carry over). A muted mic transmits nothing no matter how
    // much TTS we play — unmute explicitly and log the resulting state.
    const unmuted = await clickByLabel(page, /turn on microphone/i).catch(() => false);
    const micOn = await hasVisibleButton(page, /turn off microphone/i); // label present = mic is on (read-only check)
    console.log(`session ${sessionId}: mic ${unmuted ? "unmuted by click" : micOn ? "already on" : "state unknown"}`);
    const { execFile } = await import("child_process");
    execFile("pactl", ["list", "source-outputs"], (e: any, out: string) => {
      if (e || !out) return;
      for (const block of out.split(/\n(?=\w+ #)/)) {
        if (/application\.name = "(Google Chrome|Chromium|Chrome)"/.test(block)) {
          console.log(`session ${sessionId}: Chrome mic stream source: ${block.match(/Source: (\S+)/)?.[1] || "?"} (want ${sinks.coachMic})`);
        }
      }
    });
    const greet = await api(`/api/coach/bot/${sessionId}/greeting`, { method: "POST", body: "{}" });
    console.log(`session ${sessionId}: speaking greeting (${greet.text.length} chars)`);
    try {
      await speaker.speak(greet.text, sinks.coachOut, capture);
    } catch (e: any) {
      // A failed greeting (TTS/network) must not end the session: log it
      // and continue to the listening loop — the employee can still talk.
      console.error(`session ${sessionId}: greeting playback failed (continuing): ${e?.message || e}`);
      await cb(sessionId, { botError: `greeting playback failed: ${String(e?.message || e).slice(0, 240)}` }).catch(() => {});
    }

    let failures = 0;
    const fail = async (kind: string, e: any) => {
      failures++;
      console.error(`session ${sessionId}: ${kind} failure ${failures}/3: ${e?.message || e}`);
      if (failures >= 3) throw Object.assign(new Error(`${kind} failed 3x`), { finishReason: "failed" });
      if (kind !== "tts") await speaker.speak("Sorry, I lost you for a second. Could you repeat that?", sinks.coachOut, capture).catch(() => {});
    };
    // The greeting is spoken exactly once, the moment the bot thinks the
    // employee is present. An employee who joins (or unmutes) after it hears
    // only silence from a camera-off participant and reasonably concludes
    // "nobody is in the call". Until the first real employee utterance,
    // re-announce periodically so late arrivals hear the coach.
    let heardEmployee = false;
    let lastGreetAt = Date.now();
    while (Date.now() - startedAt < MAX_SESSION_MS) {
      if (externalEnd) { console.log(`session ${sessionId}: ended from room/admin`); return; }
      if (employeeLeft) {
        await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "employee_left", ttsChars: speaker.ttsChars }) }).catch(() => {});
        return;
      }
      let utt = await capture.next(5000);
      if (!utt) {
        if (capture.peakRms > 0) { console.log(`session ${sessionId}: audio peak RMS ${Math.round(capture.peakRms)} (VAD threshold ${VAD_RMS})`); capture.peakRms = 0; }
        if (!heardEmployee && Date.now() - lastGreetAt > 45000) {
          lastGreetAt = Date.now();
          console.log(`session ${sessionId}: no employee speech yet, repeating greeting`);
          await speaker.speak("Hi, I'm Aro, your AI coach. I'm here and listening. Tell me about a call that felt hard this week.", sinks.coachOut, capture).catch(() => {});
        }
        continue;
      }
      heardEmployee = true;
      // Merge speech fragments into ONE human turn: people pause mid-
      // thought, and answering each fragment separately (one STT+LLM+TTS
      // cycle each) makes the coach lag a full beat behind the human.
      {
        const parts = [utt.pcm];
        let totalMs = utt.ms;
        // Wait up to 1.2s for continuation fragments, but only while the
        // employee is actually mid-utterance or a fragment is queued —
        // a clean single turn pays only a 250ms grace window.
        const mergeEnd = Date.now() + 1200;
        const graceEnd = Date.now() + 250;
        while (Date.now() < mergeEnd) {
          if (capture.queue.length) { const q = capture.queue.shift()!; parts.push(q.pcm); totalMs += q.ms; }
          else if (!capture.inSpeech && Date.now() > graceEnd) break;
          else await new Promise((r) => setTimeout(r, 100));
        }
        if (parts.length > 1) console.log(`session ${sessionId}: merged ${parts.length} fragments into one turn`);
        utt = { pcm: Buffer.concat(parts), ms: totalMs };
      }
      console.log(`session ${sessionId}: utterance captured ${utt.ms}ms, transcribing...`);
      let text = "";
      try {
        const fd = new FormData();
        fd.append("audio", new Blob([encodeWav(utt.pcm) as any], { type: "audio/wav" }), "utterance.wav");
        const r = await fetch(`${API}/api/coach/bot/${sessionId}/transcribe`, { method: "POST", headers: { "x-bot-secret": SECRET }, body: fd });
        if (!r.ok) throw new Error(`transcribe HTTP ${r.status}`);
        text = ((await r.json()) as any).text || "";
      } catch (e) {
        // Short blips (<1.5s: "yeah", coughs, barge-in remnants) often fail
        // STT outright. Silently dropping them beats the coach saying
        // "could you repeat that?" at noise — and no failure strike.
        if (utt.ms < 1500) { console.log(`session ${sessionId}: ignoring ${utt.ms}ms blip (STT failed)`); continue; }
        await fail("stt", e); continue;
      }
      if (!text.trim()) { console.log(`session ${sessionId}: STT returned empty for ${utt.ms}ms utterance`); continue; }
      console.log(`session ${sessionId}: employee: ${text.slice(0, 100)}`);
      // Streamed reply: speak sentences as Muse generates them instead
      // of waiting for the full reply (was ~30s per coach turn).
      failures = 0;
      let shouldEnd = false;
      try {
        const t0 = Date.now();
        const ac = new AbortController();
        activeAbort = ac;
        const resp = await fetch(`${API}/api/coach/bot/${sessionId}/reply-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-bot-secret": SECRET },
          body: JSON.stringify({ text, audioMs: utt.ms }),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`reply-stream HTTP ${resp.status}`);
        capture.speaking = true; capture.barged = false;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let sseBuf = "", pendingText = "", playedText = "", streamErr = "";
        let doneInfo: any = null;
        let firstAudioLogged = false;
        let playChain: Promise<void> = Promise.resolve();
        const enqueueSentence = (sent: string) => {
          playChain = playChain.then(async () => {
            if (capture.barged) return;
            const pcm = await speaker.tts(sent);
            speaker.ttsChars += sent.length;
            if (!firstAudioLogged) { console.log(`session ${sessionId}: first reply audio after ${Date.now() - t0}ms`); firstAudioLogged = true; }
            await speaker.play(pcm, sinks.coachOut);
            if (!capture.barged) playedText += (playedText ? " " : "") + sent;
          }).catch((e) => { streamErr = streamErr || String(e?.message || e); });
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
              const line = sseBuf.slice(0, idx).trim();
              sseBuf = sseBuf.slice(idx + 2);
              if (!line.startsWith("data:")) continue;
              let evt: any = {};
              try { evt = JSON.parse(line.slice(5)); } catch { continue; }
              if (evt.chunk) {
                pendingText += evt.chunk;
                let m;
                while ((m = pendingText.match(/^[\s\S]*?[.!?]+["']?\s+/))) {
                  enqueueSentence(m[0].trim());
                  pendingText = pendingText.slice(m[0].length);
                }
              }
              if (evt.done) doneInfo = evt;
              if (evt.error) streamErr = evt.error;
            }
            if (capture.barged) break;
          }
        } catch { /* aborted on barge-in: handled below */ }
        if (!capture.barged && pendingText.trim()) enqueueSentence(pendingText.trim());
        await playChain;
        capture.speaking = false;
        activeAbort = null;
        if (capture.barged) {
          speaker.stop();
          try { ac.abort(); } catch {}
          await cb(sessionId, { interruptLastCoach: true }).catch(() => {});
          if (!doneInfo) {
            await api(`/api/coach/bot/${sessionId}/commit-turn`, { method: "POST", body: JSON.stringify({ employeeText: text, audioMs: utt.ms, coachText: playedText }) }).catch(() => {});
          }
          console.log(`session ${sessionId}: barged in; played portion committed (${playedText.length} chars)`);
        } else if (streamErr && !playedText && !doneInfo) {
          throw new Error(`stream failed: ${streamErr}`);
        }
        shouldEnd = !!doneInfo?.shouldEnd;
      } catch (e) { await fail("llm", e); continue; }
      if (shouldEnd) {
        await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "goodbye", ttsChars: speaker.ttsChars }) }).catch(() => {});
        return;
      }
    }
    console.log(`session ${sessionId}: max duration reached`);
    await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "max_duration", ttsChars: speaker.ttsChars }) }).catch(() => {});
  } catch (e: any) {
    if (e?.finishReason === "failed") {
      await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "failed", botError: String(e.message).slice(0, 300), ttsChars: speaker.ttsChars }) }).catch(() => {});
    } else {
      console.error(`session ${sessionId}: error`, e?.message || e);
      // Bot is leaving: close the session out as failed instead of
      // abandoning it in a stale "live" state in the dashboard.
      await api(`/api/coach/bot/${sessionId}/finish`, { method: "POST", body: JSON.stringify({ reason: "failed", botError: String(e?.message || e).slice(0, 400), ttsChars: speaker.ttsChars }) }).catch(async () => {
        await cb(sessionId, { botError: String(e?.message || e).slice(0, 500) }).catch(() => {});
      });
      await shot("session-error").catch(() => {});
    }
  } finally {
    clearInterval(watcher);
    speaker.stop();
    capture.stop();
    await browser.close().catch(() => {});
    await killProfileChromes();
    await teardownSinks(sinks);
    console.log(`session ${sessionId}: bot left, sinks removed`);
  }
}

// Single-instance guard: two bots on one profile/session corrupt each
// other's joins (observed repeatedly in testing). Refuse to start twice.
function acquireInstanceLock() {
  const lock = process.env.COACH_BOT_LOCK || "/tmp/opencode/coach-bot.lock";
  if (existsSync(lock)) {
    const pid = parseInt(readFileSync(lock, "utf8").trim(), 10);
    if (pid && pid !== process.pid) {
      // Refuse only if that pid is genuinely a bot process — after a
      // container/host restart the lock file survives while pids get
      // reused by unrelated processes, which crash-looped the bot.
      let isBot = false;
      try { isBot = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("src/index.ts"); } catch { isBot = false; }
      if (isBot) { console.error(`coach-bot already running (pid ${pid}, lock ${lock}). Stop it first — two bots on one profile break Meet joins.`); process.exit(1); }
    }
  }
  mkdirSync("/tmp/opencode", { recursive: true });
  writeFileSync(lock, String(process.pid));
  const release = () => { try { unlinkSync(lock); } catch {} };
  process.on("exit", release);
  process.on("SIGTERM", () => { release(); process.exit(0); });
  process.on("SIGINT", () => { release(); process.exit(0); });
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) acquireInstanceLock();
  if (cmd === "login") {
    if (JOIN_MODE === "guest") {
      console.log("JOIN_MODE=guest: no login needed — the bot joins signed-out.");
      console.log("Note: Google often rejects signed-out automation joins. Account");
      console.log("mode (default) is recommended: COACH_BOT_JOIN_MODE=account.");
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
    console.log("(the SAME account connected in Settings → Integrations), then press ENTER here.");
    const { createInterface } = await import("readline");
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press ENTER after signing in (or Ctrl+C to abort)... ", () => { rl.close(); resolve(); });
    });
    await browser.close().catch(() => {});
    console.log(`Login saved to profile ${PROFILE}.`);
    return;
  }
  if (cmd === "join" || cmd === "test-say") {
    const url = process.argv[3];
    if (!url) throw new Error("meet URL required");
    const { browser, sinks } = await joinMeet(url, true);
    if (cmd === "test-say") {
      await ttsTest(process.argv[4] || "Hello! This is your Arocall AI coach. Can you hear me clearly?", sinks.coachOut);
      console.log("Played test sentence. Confirm in the meeting that you hear the bot.");
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      console.log("Joined. Close with Ctrl+C.");
      await new Promise(() => {});
    }
    await browser.close().catch(() => {});
    await teardownSinks(sinks);
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
          try {
            await api("/api/coach/bot/claim", { method: "POST", body: JSON.stringify({ sessionId: s.id }) });
          } catch (e: any) { console.log(`session ${s.id}: not claimable (${e?.message || e}), skipping`); continue; }
          console.log(`claimed session ${s.id} status=${s.status} meet=${(s.meetUrl || s.meet_url || "").slice(0, 60)}`);
          await runSession(s).catch((e) => console.error("session failed", s.id, e?.message || e));
        }
      } else if (polls % 6 === 1) {
        console.log("poll ok: no joinable sessions (need status waiting_for_employee/scheduled-due + Meet link + unclaimed)");
      }
    } catch (e: any) { console.error("poll failed", e?.message || e); }
    await new Promise((r) => setTimeout(r, 10000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
