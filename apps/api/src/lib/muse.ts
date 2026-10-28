// Single provider abstraction for all Meta Muse model calls.
// Swap by config: set MUSE_API_URL + MUSE_API_KEY to use a real endpoint,
// otherwise deterministic mock runs (labeled in UI/README).
export type Criterion = { id: string; name: string; description: string; weight: number; guidance: string };
export type TLine = { speaker: string; text: string; start: number; end: number };

const URL = process.env.MUSE_API_URL || "";
const KEY = process.env.MUSE_API_KEY || "";
const MODEL = process.env.MUSE_MODEL || "muse-4";
export const isMock = !URL || !KEY || (process.env.MUSE_MOCK || "true") === "true";

async function realComplete(system: string, user: string, json: boolean): Promise<string> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, system, messages: [{ role: "user", content: user }], temperature: 0.1, response_format: json ? { type: "json_object" } : undefined }),
  });
  if (!res.ok) throw new Error(`Muse HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? data?.output_text ?? JSON.stringify(data).slice(0, 4000);
}

export async function completeText(system: string, user: string): Promise<{ text: string; mock: boolean }> {
  if (isMock) return { text: mockText(system, user), mock: true };
  try {
    const text = await realComplete(system, user, false);
    return { text, mock: false };
  } catch {
    return { text: mockText(system, user), mock: true };
  }
}

function mockText(system: string, user: string): string {
  if (system.includes("coach")) {
    return "Thanks for sharing that. Let's dig into one specific moment from your calls, then do a quick role-play so you leave with 2-3 concrete actions. What felt hardest about that call from your side?";
  }
  return "Mock Muse response (no API key configured). " + user.slice(0, 200);
}

// --- Scorecard extraction (mock: keyword scan -> default criteria) ---
export const DEFAULT_CRITERIA: Criterion[] = [
  { id: "greeting", name: "Greeting & Intro", description: "Greets customer, states name/company, offers help.", weight: 15, guidance: "Pass if agent greets within first 30s with name + company." },
  { id: "empathy", name: "Empathy & Listening", description: "Acknowledges feelings, no interrupting.", weight: 20, guidance: "Pass if at least one empathetic acknowledgement." },
  { id: "compliance", name: "Compliance & Accuracy", description: "No false promises, follows policy, verifies identity where needed.", weight: 25, guidance: "Fail on any false statement or skipped verification." },
  { id: "resolution", name: "Resolution & Next steps", description: " Solves issue or sets clear next step with timeline.", weight: 25, guidance: "Pass if outcome or dated next step stated." },
  { id: "closing", name: "Closing & Upsell", description: "Summarizes, asks if anything else, polite close.", weight: 15, guidance: "Pass if summary + close present." },
];

export async function scorecardFromPolicy(policyText: string): Promise<{ criteria: Criterion[]; mock: boolean }> {
  if (!isMock) {
    try {
      const raw = await realComplete(
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
  // Deterministic mock: pick criteria whose keywords appear, else defaults
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
  const rules: Record<string, { needles: string[]; score: number; result: "pass" | "partial" | "fail" }[]> = {};
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
      const raw = await realComplete(
        "You are a call-center QA scorer. Reply ONLY JSON {\"language\",\"summary\",\"wentWell\":[],\"wentWrong\":[],\"tags\":[],\"results\":[{\"criterionId\",\"result\":\"pass|partial|fail\",\"score\":0-100,\"evidenceQuote\":\"verbatim line\",\"evidenceStart\":number}]}. Every evidenceQuote MUST be a verbatim transcript line.",
        JSON.stringify({ criteria, transcript }).slice(0, 12000), true);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      // validate quotes verbatim, drop/repair failures
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
  return `You are Arrow, a supportive English-only AI voice coach for call-center agent ${ctx.employee}. RULES: reference real call examples only from EVIDENCE below, never invent calls; never make employment decisions (no firing/warning/pay/promotion); ask the agent's perspective; role-play one difficult customer scenario; end agreeing 2-3 action items; if complaints/harassment/health issues arise, offer to flag a human evaluator. SCORES: ${ctx.scores}. MEMO: ${ctx.memo}. EVIDENCE: ${ctx.evidence}. POLICY: ${ctx.policy.slice(0, 2000)}. Language: English (config COACH_LANG for future).`;
}
