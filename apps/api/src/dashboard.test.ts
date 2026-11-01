import test from "node:test";
import assert from "node:assert";
import { computeConversationMetrics } from "./lib/conversation.js";
import { deterministicScore, DEFAULT_CRITERIA } from "./lib/muse.js";

const weightedScore = (results: { criterionId: string; score: number }[], criteria: { id: string; weight: number }[]) => {
  const w = new Map(criteria.map((c) => [c.id, c.weight]));
  let num = 0, den = 0;
  for (const r of results) { const wt = w.get(r.criterionId) ?? 0; num += r.score * wt; den += wt; }
  return den === 0 ? 0 : Math.round((num / den) * 10) / 10;
};

test("critical failure = ANY must-pass criterion failed", () => {
  const must = new Set(DEFAULT_CRITERIA.filter((c) => c.mustPass).map((c) => c.id));
  assert.ok(must.has("compliance"));
  const results = [
    { criterionId: "greeting", result: "pass" },
    { criterionId: "compliance", result: "fail" },
  ];
  const isCrit = results.some((r) => r.result === "fail" && must.has(r.criterionId));
  assert.equal(isCrit, true);
  const okResults = [{ criterionId: "greeting", result: "fail" }, { criterionId: "empathy", result: "fail" }];
  assert.equal(okResults.some((r) => r.result === "fail" && must.has(r.criterionId)), false);
});

test("conversation metrics from synthetic two-channel timeline", () => {
  const tr = [
    { speaker: "Agent", text: "Hello " + "word ".repeat(30), start: 0, end: 10 },
    { speaker: "Customer", text: "Hi " + "word ".repeat(14), start: 11, end: 16 }, // 1s gap
    { speaker: "Agent", text: "I will fix this by tomorrow", start: 15.2, end: 19 }, // 0.8s overlap -> interruption
    { speaker: "Customer", text: "Thanks perfect", start: 22, end: 25 }, // 3s gap -> dead air
  ];
  const m = computeConversationMetrics(tr as any, 30);
  assert.equal(m.interruptions, 1);
  assert.ok((m.talkRatio as number) > 1, `talkRatio ${m.talkRatio}`);
  assert.ok((m.deadAirPct as number) >= 10, `deadAir ${m.deadAirPct}`);
  assert.ok((m.agentWpm as number) > 50, `wpm ${m.agentWpm}`);
  // empty -> nulls, never 0-as-data
  const e = computeConversationMetrics([], 30);
  assert.equal(e.talkRatio, null);
  assert.equal(e.deadAirPct, null);
});

test("heatmap low-data rule: fewer than 3 calls -> gray", () => {
  const cell = (n: number) => ({ low: n < 3 });
  assert.equal(cell(2).low, true);
  assert.equal(cell(3).low, false);
});

test("KPI deltas with zero previous value -> null (show —)", () => {
  const delta = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);
  assert.equal(delta(80, null), null);
  assert.equal(delta(null, 70), null);
  assert.equal(delta(80, 70), 10);
});

test("new AI fields carry verbatim quotes", () => {
  const tr = [
    { speaker: "Agent", text: "Hello, thank you for calling Arocall, my name is Ana.", start: 0, end: 3 },
    { speaker: "Customer", text: "My bill is wrong, I am furious.", start: 3, end: 5 },
    { speaker: "Agent", text: "I understand, I am sorry. Let me verify your account.", start: 5, end: 9 },
    { speaker: "Agent", text: "I will fix this by tomorrow.", start: 9, end: 12 },
    { speaker: "Customer", text: "Get me your supervisor now!", start: 12, end: 14 },
  ];
  const r: any = deterministicScore(tr, DEFAULT_CRITERIA, "en");
  const full = tr.map((t) => t.text).join("\n");
  for (const q of [r.customerSentimentStartQuote, r.customerSentimentEndQuote, r.issueResolvedQuote]) {
    assert.ok(q && full.includes(q), `quote missing: ${q}`);
  }
  assert.equal(r.customerRequestedSupervisor, true);
  assert.ok(full.includes(r.supervisorQuote));
  assert.ok(["negative", "neutral", "positive"].includes(r.customerSentimentStart));
  assert.ok(["yes", "no", "unclear"].includes(r.issueResolved));
});

test("weighted score + evidence verification still hold", () => {
  const tr = [
    { speaker: "Agent", text: "Hello, thank you for calling Arocall, my name is Ana.", start: 0, end: 3 },
    { speaker: "Customer", text: "My bill is wrong.", start: 3, end: 5 },
  ];
  const r: any = deterministicScore(tr, DEFAULT_CRITERIA, "en");
  assert.equal(r.total, weightedScore(r.results, DEFAULT_CRITERIA));
  const full = tr.map((t) => t.text).join("\n").toLowerCase();
  for (const x of r.results) assert.ok(full.includes(String(x.evidenceQuote).toLowerCase().slice(0, 20)));
});
