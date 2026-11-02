import test from "node:test";
import assert from "node:assert";
import { newLoop, step } from "./lib/coachingLoop.js";
import { trimHistory, HUMAN_REGEX, GOODBYE_REGEX } from "./lib/coach.js";
import { splitSentences } from "./lib/openaiTts.js";

test("normal turn: utterance -> llmDone queues sentences, played -> listening", () => {
  const ctx = newLoop(25, 0);
  step(ctx, { type: "utterance", text: "My closing felt weak.", ms: 1000 });
  assert.equal(ctx.state, "THINKING");
  const r = step(ctx, { type: "llmDone", text: "Thanks. Let's practice. First, open with empathy." });
  assert.equal(ctx.state, "SPEAKING");
  assert.ok(r.say.length >= 2);
  assert.equal(ctx.ttsChars, "Thanks. Let's practice. First, open with empathy.".length);
  for (const s of [...r.say]) step(ctx, { type: "sentencePlayed", sentence: s, ms: 100 });
  assert.equal(ctx.state, "LISTENING");
});

test("barge-in interrupts playback and marks turn", () => {
  const ctx = newLoop(25, 0);
  step(ctx, { type: "utterance", text: "hi", ms: 10 });
  step(ctx, { type: "llmDone", text: "Long reply here. Second sentence here." });
  assert.equal(ctx.state, "SPEAKING");
  const r = step(ctx, { type: "bargeIn" });
  assert.ok(r.endPlayback);
  assert.equal(ctx.state, "LISTENING");
  assert.ok(ctx.history.find((t) => t.role === "coach")?.interrupted);
});

test("failure fallback then 3 strikes ends session", () => {
  const ctx = newLoop(25, 0);
  let r = step(ctx, { type: "ttsError" });
  assert.deepEqual(r.say, ["Sorry, I lost you for a second. Could you repeat that?"]);
  step(ctx, { type: "llmError" });
  step(ctx, { type: "sttError" });
  assert.equal(ctx.ended?.reason, "failed");
});

test("history trimming under budget + regexes", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "coach" : "employee", text: "x".repeat(1000) }));
  const { turns: kept, summarized } = trimHistory(turns, 5000);
  assert.ok(kept.join("").length < 20000 && summarized > 0);
  assert.ok(kept[0].text.includes("summarized"));
  assert.ok(HUMAN_REGEX.test("I want a human evaluator please"));
  assert.ok(GOODBYE_REGEX.test("ok goodbye, thanks"));
});

test("max duration ends session; goodbye ends after 2+ turns", () => {
  const ctx = newLoop(0.001, 0); // ~60ms
  step(ctx, { type: "tick", nowMs: 120000 });
  assert.equal(ctx.ended?.reason, "max_duration");
  const c2 = newLoop(25, 0);
  step(c2, { type: "utterance", text: "hello", ms: 1 });
  step(c2, { type: "llmDone", text: "Hi there." });
  step(c2, { type: "utterance", text: "goodbye thanks!", ms: 2 });
  assert.equal(c2.ended?.reason, "goodbye");
});

test("sentence splitter", () => {
  assert.deepEqual(splitSentences("Hello! How are you? Fine."), ["Hello!", "How are you?", "Fine."]);
});
