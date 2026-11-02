// Pure, testable conversation-loop state machine (no audio I/O here).
// States: LISTENING -> THINKING -> SPEAKING -> LISTENING, with barge-in,
// failure fallback + 3-strikes end, goodbye/max-duration/expired handling.
export type LoopState = "LISTENING" | "THINKING" | "SPEAKING";
export type LoopEvent =
  | { type: "utterance"; text: string; ms: number }
  | { type: "llmChunk"; text: string }
  | { type: "llmDone"; text: string }
  | { type: "sentencePlayed"; sentence: string; ms: number }
  | { type: "bargeIn" }
  | { type: "sttError" | "llmError" | "ttsError" }
  | { type: "tick"; nowMs: number };

export interface LoopCtx {
  state: LoopState;
  history: { role: "employee" | "coach"; text: string; interrupted?: boolean }[];
  pendingCoachText: string;
  playedQueue: string[];
  consecutiveFailures: number;
  ended: null | { reason: string };
  humanFlag: boolean;
  ttsChars: number;
  startedMs: number;
  maxMs: number;
  fallbackLine: string;
}

export function newLoop(maxMin = 25, nowMs = Date.now()): LoopCtx {
  return {
    state: "LISTENING", history: [], pendingCoachText: "", playedQueue: [],
    consecutiveFailures: 0, ended: null, humanFlag: false, ttsChars: 0,
    startedMs: nowMs, maxMs: maxMin * 60_000,
    fallbackLine: "Sorry, I lost you for a second. Could you repeat that?",
  };
}

export function step(ctx: LoopCtx, ev: LoopEvent, nowMs = Date.now()): { say: string[]; endPlayback: boolean } {
  const say: string[] = [];
  let endPlayback = false;
  if (ctx.ended) return { say, endPlayback };
  if (ev.type === "tick") {
    if (nowMs - ctx.startedMs >= ctx.maxMs) ctx.ended = { reason: "max_duration" };
    return { say, endPlayback };
  }
  if (ev.type === "bargeIn" && ctx.state === "SPEAKING") {
    // Mark last coach turn interrupted, drop pending TTS, back to listening.
    const last = [...ctx.history].reverse().find((t) => t.role === "coach");
    if (last) last.interrupted = true;
    ctx.pendingCoachText = "";
    ctx.playedQueue = [];
    ctx.state = "LISTENING";
    endPlayback = true;
    return { say, endPlayback };
  }
  if (ev.type === "utterance") {
    if (/harass|complaint|health|sick|human.*evaluator|i want.*human/i.test(ev.text)) ctx.humanFlag = true;
    ctx.history.push({ role: "employee", text: ev.text });
    if (/\b(goodbye|bye\b|we'?re done|end.*session)\b/i.test(ev.text) && ctx.history.length >= 2) {
      ctx.ended = { reason: "goodbye" };
      return { say, endPlayback };
    }
    ctx.state = "THINKING";
    return { say, endPlayback };
  }
  if (ev.type === "llmChunk") {
    ctx.pendingCoachText += ev.text;
    return { say, endPlayback };
  }
  if (ev.type === "llmDone") {
    ctx.consecutiveFailures = 0;
    ctx.state = "SPEAKING";
    const sents = (ev.text.match(/[^.!?]+[.!?]+["']?\s*/g) || [ev.text]).map((s) => s.trim()).filter(Boolean);
    ctx.playedQueue = sents;
    ctx.history.push({ role: "coach", text: ev.text });
    ctx.ttsChars += ev.text.length;
    say.push(...sents);
    return { say, endPlayback };
  }
  if (ev.type === "sentencePlayed") {
    ctx.playedQueue.shift();
    if (!ctx.playedQueue.length) ctx.state = "LISTENING";
    return { say, endPlayback };
  }
  if (ev.type === "sttError" || ev.type === "llmError" || ev.type === "ttsError") {
    ctx.consecutiveFailures++;
    if (ctx.consecutiveFailures >= 3) {
      ctx.ended = { reason: "failed" };
      return { say, endPlayback };
    }
    ctx.state = "SPEAKING";
    ctx.history.push({ role: "coach", text: ctx.fallbackLine });
    ctx.playedQueue = [ctx.fallbackLine];
    say.push(ctx.fallbackLine);
    return { say, endPlayback };
  }
  return { say, endPlayback };
}
