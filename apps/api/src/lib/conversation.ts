import type { TLine } from "./muse.js";

export type ConvMetrics = {
  talkRatio: number | null;
  deadAirPct: number | null;
  interruptions: number;
  agentWpm: number | null;
};

// Compute conversation metrics from transcript timestamps in code, never LLM.
// - talkRatio = agent speaking time / customer speaking time
// - deadAirPct = silence >= 2s / call duration * 100
// - interruptions = agent starts while customer still speaking with >0.5s overlap
// - agentWpm = agent words / agent minutes
export function computeConversationMetrics(transcript: TLine[], durationSec: number): ConvMetrics {
  if (!transcript?.length || !durationSec || durationSec <= 0) {
    return { talkRatio: null, deadAirPct: null, interruptions: 0, agentWpm: null };
  }
  const lines = [...transcript].sort((a, b) => a.start - b.start);
  let agentTime = 0, custTime = 0, agentWords = 0;
  for (const l of lines) {
    const d = Math.max(0, (l.end || l.start) - l.start);
    if (l.speaker === "Agent") {
      agentTime += d;
      agentWords += String(l.text || "").trim().split(/\s+/).filter(Boolean).length;
    } else {
      custTime += d;
    }
  }
  // dead air: gaps between consecutive lines >= 2s
  let dead = 0;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].start - Math.max(lines[i - 1].end, lines[i - 1].start);
    if (gap >= 2) dead += gap;
  }
  // trailing silence
  const lastEnd = Math.max(...lines.map((l) => l.end || l.start));
  if (durationSec > lastEnd + 2) dead += durationSec - lastEnd;
  // interruptions: agent line starts >0.5s before previous customer line ends
  let interruptions = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], cur = lines[i];
    if (cur.speaker === "Agent" && prev.speaker === "Customer") {
      if (prev.end - cur.start > 0.5) interruptions++;
    }
  }
  return {
    talkRatio: custTime > 0 ? Math.round((agentTime / custTime) * 100) / 100 : agentTime > 0 ? 99 : null,
    deadAirPct: Math.round((Math.min(dead, durationSec) / durationSec) * 1000) / 10,
    interruptions,
    agentWpm: agentTime > 0 ? Math.round((agentWords / (agentTime / 60)) * 10) / 10 : null,
  };
}
