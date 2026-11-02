// Virtual audio via pactl (PulseAudio/PipeWire). Per session, removed after.
//   meet_in (null sink): Chromium output routed here (PULSE_SINK=meet_in).
//     Bot records meet_in.monitor to hear the employee.
//   coach_out (null sink) + coach_mic (virtual source from coach_out.monitor):
//     Chromium mic = coach_mic (PULSE_SOURCE=coach_mic). TTS played into
//     coach_out via paplay so Meet hears it as the bot's microphone.
import { execFile } from "child_process";
import { promisify } from "util";
const run = promisify(execFile);

export async function setupSinks(tag: string) {
  const meetIn = `meet_in_${tag}`;
  const coachOut = `coach_out_${tag}`;
  const coachMic = `coach_mic_${tag}`;
  await run("pactl", ["load-module", "module-null-sink", `sink_name=${meetIn}`, `sink_properties=device.description=${meetIn}`]).catch(() => {});
  await run("pactl", ["load-module", "module-null-sink", `sink_name=${coachOut}`, `sink_properties=device.description=${coachOut}`]).catch(() => {});
  await run("pactl", ["load-module", "module-virtual-source", `source_name=${coachMic}`, `master=${coachOut}.monitor`]).catch(() => {});
  return { meetIn, coachOut, coachMic };
}

export async function teardownSinks(s: { meetIn: string; coachOut: string; coachMic: string }) {
  for (const mod of [s.meetIn, s.coachOut, s.coachMic]) {
    await run("pactl", ["unload-module", mod]).catch(() => {});
  }
}

// Play raw PCM (24kHz 16-bit mono from OpenAI TTS) into coach_out.
export function playPcm(pcm: Buffer, sink: string) {
  return run("paplay", ["--raw", "--rate=24000", "--format=s16le", "--channels=1", `-d=${sink}`, "/dev/stdin"], { input: pcm } as any);
}

export async function verifySinks(): Promise<string> {
  const { stdout } = await run("pactl", ["list", "short", "sinks"]);
  return stdout;
}
