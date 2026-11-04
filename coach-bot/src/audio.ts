// Virtual audio via pactl (PulseAudio/PipeWire). Per session, removed after.
//   meet_in (null sink): Chromium output routed here (PULSE_SINK=meet_in).
//     Bot records meet_in.monitor to hear the employee.
//   coach_out (null sink) + coach_mic (virtual source from coach_out.monitor):
//     Chromium mic = coach_mic (PULSE_SOURCE=coach_mic). TTS played into
//     coach_out via paplay so Meet hears it as the bot's microphone.
import { execFile } from "child_process";
import { promisify } from "util";
const run = promisify(execFile);

export interface Sinks {
  meetIn: string;
  coachOut: string;
  coachMic: string;
  modules: string[]; // pactl module indexes, for reliable teardown
  prevDefaultSink: string;
  prevDefaultSource: string;
}

async function loadModule(args: string[]): Promise<string> {
  const { stdout } = await run("pactl", ["load-module", ...args]);
  return stdout.trim(); // module index
}

export async function setupSinks(tag: string): Promise<Sinks> {
  const meetIn = `meet_in_${tag}`;
  const coachOut = `coach_out_${tag}`;
  const coachMic = `coach_mic_${tag}`;
  const modules: string[] = [];
  try {
    modules.push(await loadModule(["module-null-sink", `sink_name=${meetIn}`, `sink_properties=device.description=${meetIn}`]));
    modules.push(await loadModule(["module-null-sink", `sink_name=${coachOut}`, `sink_properties=device.description=${coachOut}`]));
    modules.push(await loadModule(["module-virtual-source", `source_name=${coachMic}`, `master=${coachOut}.monitor`]));
  } catch (e) {
    for (const m of modules.reverse()) await run("pactl", ["unload-module", m]).catch(() => {});
    throw new Error(`pactl sink setup failed (is PulseAudio/PipeWire running?): ${(e as Error).message}`);
  }
  // Verify the devices actually exist — Chromium silently falls back to a
  // dead default device when PULSE_SINK/PULSE_SOURCE name a missing sink.
  const { stdout } = await run("pactl", ["list", "short", "sinks"]);
  if (!stdout.includes(meetIn) || !stdout.includes(coachOut)) {
    for (const m of modules.reverse()) await run("pactl", ["unload-module", m]).catch(() => {});
    throw new Error(`virtual sinks not visible after setup: ${stdout.slice(0, 200)}`);
  }
  // PipeWire renames the virtual source to "output.<name>" — discover the
  // real name, or Chrome/PULSE_SOURCE references a device that never
  // existed and silently falls back to the real microphone.
  const srcList = (await run("pactl", ["list", "short", "sources"])).stdout;
  const realMic = srcList.split("\n").map((l) => l.split("\t")[1]).find((n) => n && n.includes(coachMic)) || coachMic;
  // Chrome does not reliably honor PULSE_SINK/PULSE_SOURCE (it picks the
  // system-default devices — the user's real microphone, which made the
  // coach transmit the room's real mic). Point the system defaults at the
  // virtual devices for the session; restored in teardownSinks. Best
  // effort: a failed default switch must not kill the join.
  const prevDefaultSink = (await run("pactl", ["get-default-sink"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const prevDefaultSource = (await run("pactl", ["get-default-source"]).catch(() => ({ stdout: "" }))).stdout.trim();
  await run("pactl", ["set-default-sink", meetIn]).catch((e) => console.warn("set-default-sink failed", String(e).slice(0, 120)));
  await run("pactl", ["set-default-source", realMic]).catch((e) => console.warn("set-default-source failed", String(e).slice(0, 120)));
  await run("pactl", ["set-source-mute", realMic, "0"]).catch(() => {});
  await run("pactl", ["set-sink-mute", meetIn, "0"]).catch(() => {});
  console.log(`audio devices: sink=${meetIn} mic=${realMic} (defaults switched from ${prevDefaultSink}/${prevDefaultSource})`);
  return { meetIn, coachOut, coachMic: realMic, modules, prevDefaultSink, prevDefaultSource };
}

// Move any already-running Chrome audio streams onto the virtual devices
// (streams opened before the defaults changed keep their old routing).
export async function moveChromeStreams(s: Sinks) {
  const move = async (listCmd: string[], moveCmd: string, target: string) => {
    const { stdout } = await run("pactl", listCmd).catch(() => ({ stdout: "" }));
    for (const block of stdout.split(/\n(?=\w+ #)/)) {
      if (!/application\.name = "(Google Chrome|Chromium|Chrome)"/.test(block)) continue;
      const id = block.match(/#(\d+)/)?.[1];
      if (id) await run("pactl", [moveCmd, id, target]).catch(() => {});
    }
  };
  await move(["list", "sink-inputs"], "move-sink-input", s.meetIn);
  await move(["list", "source-outputs"], "move-source-output", s.coachMic);
}

export async function teardownSinks(s: Sinks) {
  // Restore the user's default devices first. Then unload modules: on
  // PipeWire the id returned by load-module is not accepted by
  // unload-module (sinks leaked every session), so look modules up by
  // their sink/source names in the module list instead.
  if (s.prevDefaultSink) await run("pactl", ["set-default-sink", s.prevDefaultSink]).catch(() => {});
  if (s.prevDefaultSource) await run("pactl", ["set-default-source", s.prevDefaultSource]).catch(() => {});
  const names = [s.meetIn, s.coachOut, s.coachMic.replace(/^output\./, "")];
  const { stdout } = await run("pactl", ["list", "short", "modules"]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    if (names.some((n) => line.includes(n))) {
      const id = line.split("\t")[0];
      if (id) await run("pactl", ["unload-module", id]).catch(() => {});
    }
  }
  // Fallback to load-time ids for plain PulseAudio.
  for (const m of [...s.modules].reverse()) {
    await run("pactl", ["unload-module", m]).catch(() => {});
  }
}

// Play raw PCM (24kHz 16-bit mono from OpenAI TTS) into coach_out.
// --device=, not -d: real PulseAudio rejects `-d <sink>` ("Invalid argument").
export function playPcm(pcm: Buffer, sink: string) {
  return run("paplay", ["--raw", "--rate=24000", "--format=s16le", "--channels=1", `--device=${sink}`, "/dev/stdin"], { input: pcm } as any);
}

export async function verifySinks(): Promise<string> {
  const { stdout } = await run("pactl", ["list", "short", "sinks"]);
  return stdout;
}
