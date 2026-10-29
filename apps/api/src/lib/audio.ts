import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

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

// Merge two mono track buffers (agent + customer) into one stereo WAV
// (Agent=L, Customer=R) for the existing transcribe/pipeline path.
// Pure-PCM WAV inputs are interleaved directly; anything else (e.g. Opus)
// is decoded with system ffmpeg when available.
export function tracksToStereo(agent: Buffer, customer: Buffer): Buffer {
  try {
    const a = parseWav(agent), c = parseWav(customer);
    if (a.channels !== 1 || c.channels !== 1 || a.bits !== 16 || c.bits !== 16) throw new Error("need mono 16-bit");
    if (a.sampleRate !== c.sampleRate) throw new Error("sample rate mismatch");
    const n = Math.min(a.data.length, c.data.length) & ~3;
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 2) {
      a.data.copy(data, i * 2, i, i + 2);
      c.data.copy(data, i * 2 + 2, i, i + 2);
    }
    const head = Buffer.alloc(44);
    head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
    head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
    head.writeUInt16LE(2, 22); head.writeUInt32LE(a.sampleRate, 24); head.writeUInt32LE(a.sampleRate * 4, 28);
    head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  } catch {
    return ffmpegToStereo(agent, customer);
  }
}

let _ffmpeg: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (_ffmpeg !== null) return _ffmpeg;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    _ffmpeg = true;
  } catch { _ffmpeg = false; }
  return _ffmpeg;
}

function ffmpegToStereo(agent: Buffer, customer: Buffer): Buffer {
  if (!ffmpegAvailable()) throw new Error("non-WAV tracks need ffmpeg (not installed)");
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const aIn = join(tmpdir(), `arocall_${tag}_a`), cIn = join(tmpdir(), `arocall_${tag}_c`);
  const aRaw = join(tmpdir(), `arocall_${tag}_a.raw`), cRaw = join(tmpdir(), `arocall_${tag}_c.raw`);
  try {
    writeFileSync(aIn, agent); writeFileSync(cIn, customer);
    for (const [inp, out] of [[aIn, aRaw], [cIn, cRaw]]) {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", inp as string, "-ac", "1", "-ar", "16000", "-f", "s16le", out as string], { stdio: "ignore" });
    }
    const a = readFileSync(aRaw), c = readFileSync(cRaw);
    const n = Math.min(a.length, c.length) & ~3;
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 2) {
      a.copy(data, i * 2, i, i + 2);
      c.copy(data, i * 2 + 2, i, i + 2);
    }
    return encodeWav(data, 16000, 2, 16);
  } finally {
    for (const f of [aIn, cIn, aRaw, cRaw]) try { unlinkSync(f); } catch { /* ignore */ }
  }
}
export function turnsToLines(turns: Turn[], speaker: string): { speaker: string; text: string; start: number; end: number }[] {
  return (turns || [])
    .filter((t) => t.transcript?.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((t) => ({ speaker, text: t.transcript.trim(), start: Math.round((t.startMs / 1000) * 10) / 10, end: Math.round((t.endMs / 1000) * 10) / 10 }));
}
