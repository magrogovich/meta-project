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

// Streaming variant for the voice coach: chunks arrive token-by-token so the
// bot can start speaking the first sentence while the rest still generates
// (waiting for the full reply made coach turns take ~30s). max_tokens caps
// generation length; a short spoken reply should never need more.
export async function streamText(system: string, user: string, onChunk: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; mock: boolean }> {
  if (isMock) { const t = mockText(system, user); onChunk(t); return { text: t, mock: true }; }
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      // max_tokens must leave room for Muse Spark's hidden reasoning
      // (~360 tokens even for a one-sentence reply) PLUS the visible text,
      // or the completion comes back empty — 220 (and even 1200 with the full coaching prompt) starved it completely.
      model: LLM_MODEL, temperature: 0.1, max_tokens: 4000, stream: true,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Muse stream HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content || "";
        if (delta) { full += delta; onChunk(delta); }
      } catch { /* partial JSON across chunks: ignore */ }
    }
  }
  if (!full) throw new Error("Muse stream: empty response");
  return { text: full, mock: false };
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

// --- Default criteria (fallback when no approved set exists yet) ---
export const DEFAULT_CRITERIA: Criterion[] = [
  { id: "greeting", name: "Greeting & Intro", description: "Greets customer, states name/company, offers help.", weight: 15, guidance: "Pass if agent greets within first 30s with name + company." },
  { id: "empathy", name: "Empathy & Listening", description: "Acknowledges feelings, no interrupting.", weight: 20, guidance: "Pass if at least one empathetic acknowledgement." },
  { id: "compliance", name: "Compliance & Accuracy", description: "No false promises, follows policy, verifies identity where needed.", weight: 25, guidance: "Fail on any false statement or skipped verification.", mustPass: true },
  { id: "resolution", name: "Resolution & Next steps", description: " Solves issue or sets clear next step with timeline.", weight: 25, guidance: "Pass if outcome or dated next step stated." },
  { id: "closing", name: "Closing & Upsell", description: "Summarizes, asks if anything else, polite close.", weight: 15, guidance: "Pass if summary + close present." },
];

// --- Deterministic fallback scorer: guarantees verbatim quotes ---
export function deterministicScore(transcript: TLine[], criteria: Criterion[], language = "en") {
  const agentLines = transcript.filter((l) => l.speaker === "Agent");
  const custLines = transcript.filter((l) => l.speaker === "Customer");
  const allText = agentLines.map((l) => l.text).join(" ").toLowerCase();
  const custText = custLines.map((l) => l.text).join(" ").toLowerCase();
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
  // Conversation-outcome heuristics (verbatim evidence, verified downstream).
  const firstCust = custLines[0] || transcript.find((l) => l.speaker === "Customer") || transcript[0];
  const lastCust = custLines[custLines.length - 1] || firstCust;
  const neg = (t: string) => /wrong|angry|furious|terrible|awful|waiting.*week|frustrat|upset|complaint|supervisor|manager/i.test(t);
  const pos = (t: string) => /thank|great|perfect|wonderful|happy|resolved|appreciat/i.test(t);
  const sentimentOf = (t: string) => (neg(t) ? "negative" : pos(t) ? "positive" : "neutral");
  const supLine = transcript.find((l) => /supervisor|manager|escalate/i.test(l.text));
  const resLine = transcript.find((l) => /resolved|fixed|refund|replacement|i will .* by|sorted/i.test(l.text));
  const unresLine = transcript.find((l) => /cannot|can't|not possible|call back later|don't know/i.test(l.text));
  return {
    language, summary,
    wentWell: results.filter((r) => r.result === "pass").map((r) => `${r.criterionName}: "${r.evidenceQuote.slice(0, 80)}"`).slice(0, 3),
    wentWrong: results.filter((r) => r.result !== "pass").map((r) => `${r.criterionName} (${r.result}, ${r.score})`).slice(0, 3),
    tags: criteria.map((c) => c.id).slice(0, 5),
    results, total,
    customerSentimentStart: sentimentOf(firstCust?.text || ""),
    customerSentimentStartQuote: firstCust?.text || "",
    customerSentimentStartAt: firstCust?.start || 0,
    customerSentimentEnd: sentimentOf(lastCust?.text || ""),
    customerSentimentEndQuote: lastCust?.text || "",
    customerSentimentEndAt: lastCust?.start || 0,
    issueResolved: resLine ? "yes" : unresLine ? "no" : custText.includes("thank") || total >= 75 ? "yes" : "unclear",
    issueResolvedQuote: (resLine || unresLine || lastCust)?.text || "",
    issueResolvedAt: (resLine || unresLine || lastCust)?.start || 0,
    customerRequestedSupervisor: !!supLine,
    supervisorQuote: supLine?.text || "",
    supervisorAt: supLine?.start || 0,
  };
}

export async function scoreCall(transcript: TLine[], criteria: (Criterion & { guidelineRefs?: string[] })[], language = "en", guidelinesText = "") {
  if (!isMock) {
    try {
      const raw = await llm(
        "You are a call-center QA scorer. Reply ONLY JSON {\"language\",\"summary\",\"wentWell\":[],\"wentWrong\":[],\"tags\":[],\"results\":[{\"criterionId\",\"result\":\"pass|partial|fail\",\"score\":0-100,\"evidenceQuote\":\"verbatim line\",\"evidenceStart\":number,\"guidelineRef\":\"guidelineId:sectionId\"}],\"customerSentimentStart\":\"negative|neutral|positive\",\"customerSentimentStartQuote\":\"verbatim customer line\",\"customerSentimentStartAt\":number,\"customerSentimentEnd\":\"negative|neutral|positive\",\"customerSentimentEndQuote\":\"verbatim customer line\",\"customerSentimentEndAt\":number,\"issueResolved\":\"yes|no|unclear\",\"issueResolvedQuote\":\"verbatim line\",\"issueResolvedAt\":number,\"customerRequestedSupervisor\":bool,\"supervisorQuote\":\"verbatim line or empty\",\"supervisorAt\":number}. Every *Quote MUST be a verbatim transcript line. Every guidelineRef MUST be one of the criterion's cited sections.",
        JSON.stringify({ guidelines: guidelinesText.slice(0, 20000), criteria, transcript }).slice(0, 24000), true);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const full = transcript.map((t) => t.text);
      const norm = (s: string) => s.trim().toLowerCase();
      const fixQuote = (q: string, fbSpeaker?: string) => {
        if (q && full.some((t) => norm(t).includes(norm(String(q)).slice(0, 24)))) return q;
        const fb = (fbSpeaker ? transcript.find((t) => t.speaker === fbSpeaker) : null) || transcript.find((t) => t.speaker === "Agent") || transcript[0];
        return fb?.text || "";
      };
      const atOf = (q: string) => transcript.find((t) => t.text === q)?.start || 0;
      for (const r of parsed.results || []) {
        const ok = full.some((t) => norm(t).includes(norm(String(r.evidenceQuote || "")).slice(0, 24)) && r.evidenceQuote);
        if (!ok) {
          const fb = transcript.find((t) => t.speaker === "Agent") || transcript[0];
          r.evidenceQuote = fb.text; r.evidenceStart = fb.start;
        }
        const crit = criteria.find((c) => c.id === r.criterionId);
        if (!crit?.guidelineRefs?.includes(r.guidelineRef)) r.guidelineRef = crit?.guidelineRefs?.[0] || "";
      }
      // Verify new AI-estimate quotes are verbatim.
      parsed.customerSentimentStartQuote = fixQuote(parsed.customerSentimentStartQuote, "Customer");
      parsed.customerSentimentEndQuote = fixQuote(parsed.customerSentimentEndQuote, "Customer");
      parsed.issueResolvedQuote = fixQuote(parsed.issueResolvedQuote);
      if (parsed.customerRequestedSupervisor) parsed.supervisorQuote = fixQuote(parsed.supervisorQuote);
      else { parsed.supervisorQuote = ""; parsed.supervisorAt = 0; }
      if (!parsed.customerSentimentStartAt) parsed.customerSentimentStartAt = atOf(parsed.customerSentimentStartQuote);
      if (!parsed.customerSentimentEndAt) parsed.customerSentimentEndAt = atOf(parsed.customerSentimentEndQuote);
      if (!parsed.issueResolvedAt) parsed.issueResolvedAt = atOf(parsed.issueResolvedQuote);
      if (parsed.customerRequestedSupervisor && !parsed.supervisorAt) parsed.supervisorAt = atOf(parsed.supervisorQuote);
      const num = (parsed.results || []).reduce((a: number, r: any) => a + r.score * (criteria.find((c) => c.id === r.criterionId)?.weight ?? 0), 0);
      const den = criteria.reduce((a, c) => a + c.weight, 0) || 1;
      return { ...parsed, total: Math.round((num / den) * 10) / 10, mock: false };
    } catch { /* fallback */ }
  }
  const d = deterministicScore(transcript, criteria, language);
  return { ...d, results: d.results.map((r: any) => ({ ...r, guidelineRef: criteria.find((c) => c.id === r.criterionId)?.guidelineRefs?.[0] || "" })), mock: true };
}

export function coachSystemPrompt(ctx: { employee: string; scores: string; memo: string; evidence: string; policy: string }) {
  return `You are Aro, a supportive English-only AI voice coach for call-center agent ${ctx.employee}. RULES: reference real call examples only from EVIDENCE below, never invent calls; never make employment decisions (no firing/warning/pay/promotion); ask the agent's perspective; role-play one difficult customer scenario; end agreeing 2-3 action items; if complaints/harassment/health issues arise, offer to flag a human evaluator. SCORES: ${ctx.scores}. MEMO: ${ctx.memo}. EVIDENCE: ${ctx.evidence}. POLICY: ${ctx.policy.slice(0, 2000)}. Language: English (config COACH_LANG for future).`;
}

export type GenCriterion = { id: string; name: string; description: string; weight: number; mustPass?: boolean; guidance: string; guidelineRefs?: string[] };

// Draft evaluation criteria from guideline documents. Never invents rules outside the docs:
// every criterion must cite the section(s) it comes from (validated below).
export async function generateCriteria(parts: { guidelineId: string; version: number; markdown: string }[]): Promise<{ criteria: GenCriterion[]; mock: boolean }> {
  const validRefs = new Set<string>();
  const { splitSections } = await import("./guidelines.js");
  for (const p of parts) for (const sec of splitSections(p.markdown)) validRefs.add(`${p.guidelineId}:${sec.id}`);
  const clean = (list: any[]): GenCriterion[] => {
    const out: GenCriterion[] = [];
    for (const c of list || []) {
      const refs = (c.guidelineRefs || []).filter((r: string) => validRefs.has(r));
      if (!refs.length) continue; // no invented rules: drop criteria citing nothing real
      out.push({
        id: String(c.id || c.name || `c${out.length + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: String(c.name || "Criterion"), description: String(c.description || ""),
        weight: Number(c.weight) || 10, mustPass: !!c.mustPass,
        guidance: String(c.guidance || ""), guidelineRefs: refs,
      });
    }
    const sum = out.reduce((a, c) => a + c.weight, 0) || 1;
    for (const c of out) c.weight = Math.round((c.weight / sum) * 100);
    return out;
  };
  if (!isMock) {
    try {
      const raw = await llm(
        "You draft call-center evaluation criteria from guideline documents. Reply ONLY JSON {\"criteria\":[{\"id\",\"name\",\"description\",\"weight\",\"mustPass\":bool,\"guidance\",\"guidelineRefs\":[\"guidelineId:sectionId\"]}]}. RULES: every criterion MUST cite at least one real section id from the input via guidelineRefs; never invent rules not present in the documents; weights sum to 100.",
        JSON.stringify(parts.map((p) => ({ guidelineId: p.guidelineId, version: p.version, markdown: p.markdown.slice(0, 6000) }))).slice(0, 20000), true);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const criteria = clean(parsed.criteria);
      if (criteria.length) return { criteria, mock: false };
    } catch { /* fall through */ }
  }
  // Deterministic mock: map known section topics to criteria, citing real sections.
  const topics: { match: RegExp; base: Omit<GenCriterion, "guidelineRefs"> }[] = [
    { match: /greet|intro/i, base: { id: "greeting", name: "Greeting & Intro", description: "Greets customer, states name/company, offers help.", weight: 15, guidance: "Pass if agent greets within first 30s with name + company." } },
    { match: /empathy|tone|listen/i, base: { id: "empathy", name: "Empathy & Listening", description: "Acknowledges feelings, no interrupting.", weight: 20, guidance: "Pass if at least one empathetic acknowledgement." } },
    { match: /complian|identif|consent|do.*n.t|don't/i, base: { id: "compliance", name: "Compliance & Accuracy", description: "No false promises, follows policy, verifies identity.", weight: 25, mustPass: true, guidance: "Fail on any false statement or skipped verification." } },
    { match: /resol|escalat|next step|do's/i, base: { id: "resolution", name: "Resolution & Next steps", description: "Solves issue or sets clear next step with timeline.", weight: 25, guidance: "Pass if outcome or dated next step stated." } },
    { match: /clos/i, base: { id: "closing", name: "Closing", description: "Summarizes, asks if anything else, polite close.", weight: 15, guidance: "Pass if summary + close present." } },
  ];
  const mock: GenCriterion[] = [];
  for (const p of parts) {
    for (const sec of splitSections(p.markdown)) {
      const t = topics.find((x) => x.match.test(sec.title + " " + sec.body.slice(0, 300)));
      if (t && !mock.some((m) => m.id === t.base.id)) mock.push({ ...t.base, guidelineRefs: [`${p.guidelineId}:${sec.id}`] });
    }
  }
  const criteria = clean(mock.length ? mock : [{ ...topics[0].base, guidelineRefs: [`${parts[0].guidelineId}:${splitSections(parts[0].markdown)[0].id}`] }]);
  return { criteria, mock: true };
}
