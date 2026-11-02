// OpenAI TTS wrapper for the coach voice. Mock when no key (never throws).
// POST https://api.openai.com/v1/audio/speech {model, voice, input, instructions, response_format: pcm}
export async function ttsSpeak(sentence: string): Promise<{ pcm: Buffer; mock: boolean; chars: number }> {
  const key = process.env.OPENAI_API_KEY || "";
  const chars = sentence.length;
  if (!key) return { pcm: Buffer.alloc(0), mock: true, chars };
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts-2025-12-15",
        voice: process.env.OPENAI_TTS_VOICE || "coral",
        input: sentence,
        instructions: process.env.OPENAI_TTS_INSTRUCTIONS || "Warm, calm, supportive coach. Natural pace.",
        response_format: "pcm",
      }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { pcm: buf, mock: false, chars };
  } catch {
    return { pcm: Buffer.alloc(0), mock: true, chars };
  }
}

// Split streaming LLM text into speakable sentences.
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+["']?\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
}
