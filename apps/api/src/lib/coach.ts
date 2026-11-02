// Coach transport abstraction + session lifecycle helpers.
// Keeps existing coachSystemPrompt / safety rules / summary flow untouched.
export type CoachTransport = "meet" | "inapp";
export type CoachStatus = "waiting_for_employee" | "live" | "ended" | "expired" | "failed";

export const coachEnv = {
  transport: (process.env.COACH_TRANSPORT === "inapp" ? "inapp" : "meet") as CoachTransport,
  maxSessionMin: Number(process.env.COACH_MAX_SESSION_MIN || 25),
  joinTimeoutMin: Number(process.env.COACH_JOIN_TIMEOUT_MIN || 10),
  botSecret: process.env.COACH_BOT_SECRET || "dev-bot-secret",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirect: process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/api/settings/integrations/google/callback",
  ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts-2025-12-15",
  ttsVoice: process.env.OPENAI_TTS_VOICE || "coral",
  ttsInstructions: process.env.OPENAI_TTS_INSTRUCTIONS || "Warm, calm, supportive coach. Natural pace.",
};

// MeetTransport interface: bot service implements start/end; backend only queues.
export interface MeetTransport {
  kind: "meet" | "inapp";
  startSession(sessionId: string, meetUrl: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
}

// Default no-op: bot polls / queue. Real dispatch = fire-and-forget callback;
// the Python/Node bot long-polls pending sessions via bot callbacks.
export const InAppTransport: MeetTransport = {
  kind: "inapp",
  async startSession() {},
  async endSession() {},
};

export const MeetTransportImpl: MeetTransport = {
  kind: "meet",
  async startSession() {
    // Queued: coach-bot picks up sessions with status=waiting_for_employee via
    // GET /api/coach/bot/pending (auth: x-bot-secret). No direct RPC needed.
  },
  async endSession() {},
};

export function transportFor(override?: string): MeetTransport {
  const t = (override || coachEnv.transport) as CoachTransport;
  return t === "inapp" ? InAppTransport : MeetTransportImpl;
}

// ---- history trimming: keep full history under token budget ----
export function trimHistory(
  turns: { role: string; text: string }[],
  budgetChars = 12000,
): { turns: { role: string; text: string }[]; summarized: number } {
  let total = turns.reduce((a, t) => a + t.text.length, 0);
  if (total <= budgetChars) return { turns, summarized: 0 };
  // Summarize oldest turns into one stub (LLM summarization happens upstream;
  // here we collapse deterministically so tests + offline work).
  let summarized = 0;
  const kept = [...turns];
  while (kept.length > 2 && total > budgetChars) {
    const first = kept.shift()!;
    total -= first.text.length;
    summarized++;
  }
  if (summarized > 0) {
    kept.unshift({
      role: "coach",
      text: `[Earlier in this session (${summarized} turns summarized): coaching on greeting, empathy and closing with one role-play.]`,
    });
  }
  return { turns: kept, summarized };
}

export const HUMAN_REGEX = /harass|complaint|health|sick|anxiet|unfair|manager.*(yelled|abuse)|human.*(evaluator|manager)|i want.*human/i;
export const GOODBYE_REGEX = /\b(goodbye|bye\b|that's all|we'?re done|end.*session)\b/i;
