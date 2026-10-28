import test from "node:test";
import assert from "node:assert";
import { deterministicScore } from "./lib/muse.js";
import { DEFAULT_CRITERIA } from "./lib/muse.js";

test("weighted score computed in code, quotes verbatim", () => {
  const tr = [
    { speaker: "Agent", text: "Hello, thank you for calling Arocall, my name is Ana.", start: 0, end: 3 },
    { speaker: "Customer", text: "My bill is wrong.", start: 3, end: 5 },
    { speaker: "Agent", text: "I understand, I am sorry. I will fix this by tomorrow.", start: 5, end: 9 },
    { speaker: "Agent", text: "Is there anything else? Thank you, goodbye!", start: 9, end: 12 },
  ];
  const r: any = deterministicScore(tr, DEFAULT_CRITERIA, "en");
  assert.ok(r.total >= 0 && r.total <= 100);
  const full = tr.map((t) => t.text).join("\n");
  for (const x of r.results) assert.ok(full.includes(x.evidenceQuote), `quote missing for ${x.criterionId}`);
  const num = r.results.reduce((a: number, x: any) => a + x.score * (DEFAULT_CRITERIA.find((c) => c.id === x.criterionId)?.weight ?? 0), 0);
  assert.equal(r.total, Math.round((num / 100) * 10) / 10);
});
test("bad call scores lower than good call", async () => {
  const good: any = deterministicScore([{ speaker: "Agent", text: "Hello my name is Ana, I understand and I am sorry, I will fix by tomorrow, anything else? thank you goodbye!", start: 0, end: 5 }], DEFAULT_CRITERIA);
  const bad: any = deterministicScore([{ speaker: "Agent", text: "Yeah whatever, not my problem, bye.", start: 0, end: 5 }], DEFAULT_CRITERIA);
  assert.ok(good.total > bad.total);
});
