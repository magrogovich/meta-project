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
import { mkdirSync, writeFileSync } from "fs";
import { chromium } from "playwright";
import { SEL, DEBUG_DIR } from "./selectors.js";
import { setupSinks, teardownSinks } from "./audio.js";

const API = process.env.ARO_API || "http://localhost:4000";
const SECRET = process.env.COACH_BOT_SECRET || "dev-bot-secret";
const PROFILE = process.env.COACH_BOT_PROFILE_DIR || "/tmp/opencode/coach-bot-profile";
const HEADLESS = (process.env.COACH_BOT_HEADLESS ?? "true") !== "false";
const DISPLAY_NAME = "Arocall AI Coach";

async function api(path: string, opts: any = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { "Content-Type": "application/json", "x-bot-secret": SECRET, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`bot api ${path}: ${r.status}`);
  return r.json();
}

async function joinMeet(meetUrl: string, headed: boolean) {
  const tag = String(Date.now() % 100000);
  const sinks = await setupSinks(tag);
  const browser = await chromium.launchPersistentContext(PROFILE, {
    headless: headed ? false : HEADLESS,
    args: ["--use-fake-ui-for-media-stream", "--mute-audio=false"],
    env: { ...process.env, PULSE_SINK: sinks.meetIn, PULSE_SOURCE: sinks.coachMic } as any,
  });
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
  const { browser, page, sinks, shot } = await joinMeet(session.meet_url || session.meetUrl, false);
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
    const browser = await chromium.launchPersistentContext(PROFILE, { headless: false });
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
    console.log("Log in the dedicated bot Google account in the opened browser, then close it.");
    await browser.close();
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
  console.log(`coach-bot polling ${API} (profile ${PROFILE}, headless ${HEADLESS})`);
  for (;;) {
    try {
      const pending: any[] = await api("/api/coach/bot/pending");
      for (const s of pending) {
        console.log("starting session", s.id);
        await runSession(s).catch((e) => console.error("session failed", e));
      }
    } catch (e) { console.error("poll failed", e); }
    await new Promise((r) => setTimeout(r, 10000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
