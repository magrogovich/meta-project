import { createHash, randomBytes } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newSessionKey = () => "ak_" + randomBytes(32).toString("hex");

// Write a tiny playable WAV (sine sweep) so the audio player works without real recordings.
export function synthWav(seconds: number, seed = 1): Buffer {
  const rate = 16000, n = Math.max(1, Math.floor(seconds * rate));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const f = 220 + ((i * seed) % 440);
    const v = Math.floor(9000 * Math.sin((2 * Math.PI * f * i) / rate) * Math.exp(-i / (n * 2)));
    data.writeInt16LE(v, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export function storageDir() {
  const d = process.env.STORAGE_DIR || join(process.cwd(), "storage", "audio");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export function saveAudio(buf: Buffer, name: string) {
  const p = join(storageDir(), name);
  writeFileSync(p, buf);
  return name;
}
