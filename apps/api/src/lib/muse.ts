// Single provider module for ALL Meta Muse model calls (per spec: swap by config).
//
//   LLM (reasoning/scoring/reports/coaching): Muse Spark 1.3 Contributor
//     -> POST {MUSE_BASE_URL}/v1/chat/completions   (https://dev.meta.ai/docs/models#muse-spark)
//   STT (call transcription): Muse Voice Transcribe 1.0
//     -> POST {MUSE_BASE_URL}/v1/asr/transcribe     (https://dev.meta.ai/docs/speech-to-text)
//     multipart: `request` JSON {mode, model, audioEncoding, languageBias, keywords} + `audio` WAV.
//     Per-channel ENDPOINTING gives turn-level timestamps; mixed mono falls back to DIARIZATION.
//   TTS: NO Muse speech-synthesis model exists (Voice Transcribe is STT-only), so coach
//     voice output stays on browser speechSynthesis. Nothing to configure here.
//
// Auth: one MODEL_API_KEY for everything. No key (or MUSE_MOCK=true) => deterministic
// mock paths, always labeled via the returned `mock: true` flags.
import { splitChannels, turnsToLines, type Turn } from "./audio.js";

export type Criterion = { id: string; name: string; description: string; weight: number; guidance: string; mustPass?: boolean };
export type TLine = { speaker: string; text: string; start: number; end: number };

const BASE = (process.env.MUSE_BASE_URL || "https://api.meta.ai").replace(/\/$/, "");
const KEY = process.env.MODEL_API_KEY || process.env.MUSE_API_KEY || "";
export const LLM_MODEL = process.env.MUSE_LLM_MODEL || "muse-spark-1.3-contributor";
export const STT_MODEL = process.env.MUSE_STT_MODEL || "muse-voice-transcribe-1.0";
export const isMock = !KEY || (process.env.MUSE_MOCK || "false") === "true";

// ---------- LLM: Muse Spark 1.3 (Chat Completions) ----------
async function llm(system: string, user: string, json: boolean): Promise<string> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.1,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Muse LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Muse LLM: empty response");
  return text;
}

export async function completeText(system: string, user: string): Promise<{ text: string; mock: boolean }> {
  if (isMock) return { text: mockText(system, user), mock: true };
  try {
    return { text: await llm(system, user, false), mock: false };
  } catch {
    return { text: mockText(system, user), mock: true };
  }
}

function mockText(system: string, user: string): string {
  if (system.includes("AI voice coach")) {
    return "Thanks for sharing that. Let's dig into one specific moment from your calls, then do a quick role-play so you leave with 2-3 concrete actions. What felt hardest about that call from your side?";
  }
  return "Mock Muse response (no MODEL_API_KEY configured). " + user.slice(0, 200);
}

// ---------- STT: Muse Voice Transcribe 1.0 (file endpoint) ----------
const LANG_NAMES: Record<string, string> = { en: "English", fr: "French", de: "German", es: "Spanish" };

type SttResponse = { transcript: string; audioDurationMs?: number; turns?: Turn[] };

async function sttRequest(wav: Buffer, opts: { mode: "ENDPOINTING" | "DIARIZATION"; language?: string }): Promise<SttResponse> {
  const request = {
    mode: opts.mode, model: STT_MODEL, audioEncoding: "WAV",
    languageBias: [LANG_NAMES[opts.language || "en"] || "English"],
    keywords: ["Arocall"],
  };
  const fd = new FormData();
  fd.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  fd.append("audio", new Blob([wav as any], { type: "audio/wav" }), "call.wav");
  const res = await fetch(`${BASE}/v1/asr/transcribe?sessionId=arocall-${Date.now()}`, {
    method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd,
  });
  if (!res.ok) throw new Error(`Muse STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as SttResponse;
}

// Transcribe a call recording. Stereo (Agent=L, Customer=R) is split and each channel is
// transcribed with ENDPOINTING, so speaker labels come from channel identity. Mixed mono
// falls back to DIARIZATION (A -> Agent = whoever speaks first, B -> Customer). Throws on
// failure so the pipeline can use its mock transcript path.
export async function transcribeCallAudio(wav: Buffer, language = "en"): Promise<{ lines: TLine[]; mock: boolean }> {
  if (isMock) throw new Error("mock mode: no MODEL_API_KEY");
  const channels = splitChannels(wav);
  if (channels.length === 2) {
    const [agent, customer] = await Promise.all([
      sttRequest(channels[0], { mode: "ENDPOINTING", language }),
      sttRequest(channels[1], { mode: "ENDPOINTING", language }),
    ]);
    const lines = [
      ...turnsToLines(agent.turns || [], "Agent"),
      ...turnsToLines(customer.turns || [], "Customer"),
    ].sort((a, b) => a.start - b.start);
    if (!lines.length) throw new Error("Muse STT: no turns returned");
    return { lines, mock: false };
  }
  const mixed = await sttRequest(wav, { mode: "DIARIZATION", language });
  const bySpeaker: Record<string, TLine[]> = {};
  for (const t of mixed.turns || []) {
    const line = turnsToLines([t], t.speaker === "B" ? "__B__" : "__A__")[0];
    if (line) (bySpeaker[line.speaker] = bySpeaker[line.speaker] || []).push(line);
  }
  // Channel identity unknown for mixed mono: first speaker (= agent greeting) -> Agent.
  const labels = Object.keys(bySpeaker);
  const firstStart = (ls: TLine[]) => Math.min(...ls.map((l) => l.start));
  labels.sort((a, b) => firstStart(bySpeaker[a]) - firstStart(bySpeaker[b]));
  const map: Record<string, string> = {};
  labels.forEach((l, i) => (map[l] = i === 0 ? "Agent" : "Customer"));
  const lines = Object.entries(bySpeaker)
    .flatMap(([l, ls]) => ls.map((x) => ({ ...x, speaker: map[l] })))
    .sort((a, b) => a.start - b.start);
  if (!lines.length) throw new Error("Muse STT: no turns returned");
  return { lines, mock: false };
}

// --- Scorecard extraction ---
export const DEFAULT_CRITERIA: Criterion[] = [
  { id: "greeting", name: "Greeting & Intro", description: "Greets customer, states name/company, offers help.", weight: 15, guidance: "Pass if agent greets within first 30s with name + company." },
  { id: "empathy", name: "Empathy & Listening", description: "Acknowledges feelings, no interrupting.", weight: 20, guidance: "Pass if at least one empathetic acknowledgement." },
  { id: "compliance", name: "Compliance & Accuracy", description: "No false promises, follows policy, verifies identity where needed.", weight: 25, guidance: "Fail on any false statement or skipped verification.", mustPass: true },
  { id: "resolution", name: "Resolution & Next steps", description: " Solves issue or sets clear next step with timeline.", weight: 25, guidance: "Pass if outcome or dated next step stated." },
  { id: "closing", name: "Closing & Upsell", description: "Summarizes, asks if anything else, polite close.", weight: 15, guidance: "Pass if summary + close present." },
];

export async function scorecardFromPolicy(policyText: string): Promise<{ criteria: Criterion[]; mock: boolean }> {
  if (!isMock) {
    try {
      const raw = await llm(
        "You convert QA policies to scorecard JSON. Reply ONLY JSON: {\"criteria\":[{\"id\",\"name\",\"description\",\"weight\",\"guidance\"}]} weights sum to 100.",
        policyText.slice(0, 8000), true);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      if (Array.isArray(parsed.criteria) && parsed.criteria.length) {
        const sum = parsed.criteria.reduce((a: number, c: any) => a + Number(c.weight || 0), 0) || 100;
        const criteria = parsed.criteria.map((c: any, i: number) => ({
          id: String(c.id || c.name || `c${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          name: String(c.name || `Criterion ${i + 1}`), description: String(c.description || ""),
          weight: Math.round((Number(c.weight) || 0) * 100 / sum), guidance: String(c.guidance || ""),
        }));
        return { criteria, mock: false };
      }
    } catch { /* fall through to mock */ }
  }
  const t = policyText.toLowerCase();
  const picks = DEFAULT_CRITERIA.filter((c) => t.includes(c.id.slice(0, 4)) || t.length < 50);
  return { criteria: picks.length ? picks : DEFAULT_CRITERIA, mock: true };
}

// --- Deterministic fallback scorer: guarantees verbatim quotes ---
export function deterministicScore(transcript: TLine[], criteria: Criterion[], language = "en") {
  const agentLines = transcript.filter((l) => l.speaker === "Agent");
  const allText = agentLines.map((l) => l.text).join(" ").toLowerCase();
  const pick = (needles: string[], fallbackIdx: number) => {
    for (const l of agentLines) { const low = l.text.toLowerCase(); if (needles.some((n) => low.includes(n))) return l; }
    return agentLines[Math.min(fallbackIdx, agentLines.length - 1)] || transcript[0];
  };
  const has = (...needles: string[]) => needles.some((n) => allText.includes(n));
  const results = criteria.map((c, i) => {
    const id = c.id.toLowerCase();
    let needles: string[] = [c.name.toLowerCase().split(" ")[0]];
    let score = 70, result: "pass" | "partial" | "fail" = "partial";
    if (id.includes("greet")) { needles = ["hello", "hi", "welcome", "my name", "bonjour", "guten", "hola"]; score = has(...needles) ? 95 : 35; }
    else if (id.includes("empath") || id.includes("listen")) { needles = ["understand", "sorry", "apolog", "i hear", "makes sense", "comprends", "verstehe", "entiendo"]; score = has(...needles) ? 90 : 40; }
    else if (id.includes("complian")) { needles = ["verify", "confirm", "policy", "consent", "record"]; score = has("guarantee", "promise you will", "definitely refund") ? 30 : 85; }
    else if (id.includes("resol")) { needles = ["i will", "next step", "timeline", "by tomorrow", "refund", "replacement", "solution"]; score = has(...needles) ? 88 : 45; }
    else if (id.includes("clos") || id.includes("upsell")) { needles = ["anything else", "thank you", "goodbye", "summary", "merci", "danke", "gracias"]; score = has(...needles) ? 92 : 50; }
    result = score >= 80 ? "pass" : score >= 55 ? "partial" : "fail";
    const ev = pick(needles, i % Math.max(1, agentLines.length));
    return { criterionId: c.id, criterionName: c.name, result, score, evidenceQuote: ev.text, evidenceStart: ev.start };
  });
  const num = results.reduce((a, r) => a + r.score * (criteria.find((c) => c.id === r.criterionId)?.weight ?? 0), 0);
  const den = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  const total = Math.round((num / den) * 10) / 10;
  const summary = total >= 80 ? "Strong call: policy followed with clear resolution." : total >= 60 ? "Average call: basics covered, empathy or closing gaps." : "Weak call: missed key QA steps, needs coaching.";
  return {
    language, summary,
    wentWell: results.filter((r) => r.result === "pass").map((r) => `${r.criterionName}: "${r.evidenceQuote.slice(0, 80)}"`).slice(0, 3),
    wentWrong: results.filter((r) => r.result !== "pass").map((r) => `${r.criterionName} (${r.result}, ${r.score})`).slice(0, 3),
    tags: criteria.map((c) => c.id).slice(0, 5),
    results, total,
  };
}

export async function scoreCall(transcript: TLine[], criteria: Criterion[], language = "en") {
  if (!isMock) {
    try {
      const raw = await llm(
        "You are a call-center QA scorer. Reply ONLY JSON {\"language\",\"summary\",\"wentWell\":[],\"wentWrong\":[],\"tags\":[],\"results\":[{\"criterionId\",\"result\":\"pass|partial|fail\",\"score\":0-100,\"evidenceQuote\":\"verbatim line\",\"evidenceStart\":number}]}. Every evidenceQuote MUST be a verbatim transcript line.",
        JSON.stringify({ criteria, transcript }).slice(0, 12000), true);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const full = transcript.map((t) => t.text);
      const norm = (s: string) => s.trim().toLowerCase();
      for (const r of parsed.results || []) {
        const ok = full.some((t) => norm(t).includes(norm(String(r.evidenceQuote || "")).slice(0, 24)) && r.evidenceQuote);
        if (!ok) {
          const fb = transcript.find((t) => t.speaker === "Agent") || transcript[0];
          r.evidenceQuote = fb.text; r.evidenceStart = fb.start;
        }
      }
      const num = (parsed.results || []).reduce((a: number, r: any) => a + r.score * (criteria.find((c) => c.id === r.criterionId)?.weight ?? 0), 0);
      const den = criteria.reduce((a, c) => a + c.weight, 0) || 1;
      return { ...parsed, total: Math.round((num / den) * 10) / 10, mock: false };
    } catch { /* fallback */ }
  }
  return { ...deterministicScore(transcript, criteria, language), mock: true };
}

export function coachSystemPrompt(ctx: { employee: string; scores: string; memo: string; evidence: string; policy: string }) {
  return `You are Aro, a supportive English-only AI voice coach for call-center agent ${ctx.employee}. RULES: reference real call examples only from EVIDENCE below, never invent calls; never make employment decisions (no firing/warning/pay/promotion); ask the agent's perspective; role-play one difficult customer scenario; end agreeing 2-3 action items; if complaints/harassment/health issues arise, offer to flag a human evaluator. SCORES: ${ctx.scores}. MEMO: ${ctx.memo}. EVIDENCE: ${ctx.evidence}. POLICY: ${ctx.policy.slice(0, 2000)}. Language: English (config COACH_LANG for future).`;
}
