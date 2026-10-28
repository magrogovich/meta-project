// WAV helpers: split stereo (Agent=L, Customer=R) into mono channel buffers.
// Speaker labels come from channel identity, per spec — not ML diarization.
export type WavInfo = { channels: number; sampleRate: number; bits: number; data: Buffer };

export function parseWav(buf: Buffer): WavInfo {
  if (buf.subarray(0, 4).toString() !== "RIFF" || buf.subarray(8, 12).toString() !== "WAVE") throw new Error("not a WAV file");
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  // find the 'data' chunk (skip extra chunks like LIST)
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return { channels, sampleRate, bits, data: buf.subarray(off + 8, off + 8 + size) };
    off += 8 + size;
  }
  throw new Error("WAV data chunk not found");
}

export function encodeWav(samples: Buffer, sampleRate: number, channels = 1, bits = 16): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + samples.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22); head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  head.writeUInt16LE((channels * bits) / 8, 32); head.writeUInt16LE(bits, 34);
  head.write("data", 36); head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}

// Returns one mono WAV per channel: [agent, customer] for stereo, [mono] otherwise.
// Only 16-bit PCM supported for splitting; anything else is returned as-is (single).
export function splitChannels(wav: Buffer): Buffer[] {
  const info = parseWav(wav);
  if (info.channels !== 2 || info.bits !== 16) return [wav];
  const n = Math.floor(info.data.length / 4);
  const left = Buffer.alloc(n * 2), right = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    info.data.copy(left, i * 2, i * 4, i * 4 + 2);
    info.data.copy(right, i * 2, i * 4 + 2, i * 4 + 4);
  }
  return [encodeWav(left, info.sampleRate), encodeWav(right, info.sampleRate)];
}

export type Turn = { turnId: number; startMs: number; endMs: number; transcript: string; speaker?: string };

// STT turns -> speaker-labeled transcript lines (seconds).
export function turnsToLines(turns: Turn[], speaker: string): { speaker: string; text: string; start: number; end: number }[] {
  return (turns || [])
    .filter((t) => t.transcript?.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((t) => ({ speaker, text: t.transcript.trim(), start: Math.round((t.startMs / 1000) * 10) / 10, end: Math.round((t.endMs / 1000) * 10) / 10 }));
}
