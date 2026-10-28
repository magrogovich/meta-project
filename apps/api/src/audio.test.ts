import test from "node:test";
import assert from "node:assert";
import { parseWav, encodeWav, splitChannels, turnsToLines } from "./lib/audio.js";

function stereoWav(): Buffer {
  const n = 1600;
  const left = Buffer.alloc(n * 2), right = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { left.writeInt16LE(1000, i * 2); right.writeInt16LE(-1000, i * 2); }
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { left.copy(data, i * 4, i * 2, i * 2 + 2); right.copy(data, i * 4 + 2, i * 2, i * 2 + 2); }
  return encodeWavStereo(data);
}
function encodeWavStereo(data: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(64000, 28);
  head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test("stereo splits into agent/customer mono channels", () => {
  const [a, b] = splitChannels(stereoWav());
  assert.equal(parseWav(a).channels, 1);
  assert.equal(parseWav(b).channels, 1);
  assert.equal(parseWav(a).data.readInt16LE(0), 1000);   // left = Agent
  assert.equal(parseWav(b).data.readInt16LE(0), -1000);  // right = Customer
});

test("mono passes through untouched", () => {
  const mono = encodeWav(Buffer.alloc(320), 16000);
  const out = splitChannels(mono);
  assert.equal(out.length, 1);
  assert.equal(parseWav(out[0]).channels, 1);
});

test("turns map to timestamped lines in ms->s", () => {
  const lines = turnsToLines([
    { turnId: 2, startMs: 5900, endMs: 8240, transcript: "It is raining.", speaker: "B" },
    { turnId: 1, startMs: 1520, endMs: 4640, transcript: "How is the weather?", speaker: "A" },
  ], "Agent");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "How is the weather?");
  assert.equal(lines[0].start, 1.5);
  assert.equal(lines[1].end, 8.2);
  assert.ok(lines.every((l) => l.speaker === "Agent"));
});
