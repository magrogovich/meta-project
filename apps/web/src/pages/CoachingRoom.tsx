import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Video, Copy, Check, Hand, PhoneOff, Monitor } from "lucide-react";
import { Card, Pill } from "../components/ui";

// Coaching room: Meet link + live transcript (polls every 1.5s, the codebase's
// existing realtime mechanism). Works for employee (token) and admin (bearer).
export function CoachingRoom() {
  const [, params] = useRoute("/coach-room/:id");
  const id = params?.id || "";
  const token = new URLSearchParams(location.search).get("token") || "";
  const [data, setData] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const bearer = () => localStorage.getItem("token") || "";

  const load = async () => {
    const r = await fetch(`/api/coach/${id}/room?token=${encodeURIComponent(token)}`, {
      headers: bearer() ? { Authorization: `Bearer ${bearer()}` } : {},
    }).then((x) => x.json());
    setData(r);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    const e = setInterval(() => setElapsed((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(e); };
  }, [id]);

  if (!data) return <p className="p-4 text-xs text-gray-500">Loading coaching room…</p>;
  const s = data.session || {};
  const turns: any[] = data.turns?.length ? data.turns : (s.transcript || []).map((t: any, i: number) => ({ idx: i, ...t }));
  const statusTone = s.status === "live" ? "green" : s.status === "waiting_for_employee" ? "amber" : s.status === "ended" ? "gray" : "red";
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  const meetUrl: string = s.meetUrl || s.meet_url || "";

  const authed = async (path: string, body: any) => {
    const h: any = { "Content-Type": "application/json" };
    if (bearer()) h.Authorization = `Bearer ${bearer()}`;
    await fetch(path, { method: "POST", headers: h, body: JSON.stringify({ token, ...body }) });
    load();
  };
  const saveLink = async () => {
    setSaveErr("");
    const h: any = { "Content-Type": "application/json" };
    if (bearer()) h.Authorization = `Bearer ${bearer()}`;
    const r = await fetch(`/api/coach/${id}/meet-link`, { method: "PATCH", headers: h, body: JSON.stringify({ meetUrl: manualLink }) }).then((x) => x.json());
    if (r.error) { setSaveErr(r.error); return; }
    setManualLink("");
    load();
  };
  const isOver = ["ended", "expired", "failed"].includes(s.status);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <div className="rounded-lg bg-indigo-50 p-2.5 text-xs text-indigo-900 ring-1 ring-indigo-200">
        You are talking to an AI coach. This session is recorded and summarized. AI assists, humans decide.
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <Pill tone={statusTone as any}>{s.status === "waiting_for_employee" ? "Waiting for you" : s.status}</Pill>
            <span className="ml-auto text-xs tabular-nums text-gray-500">{mm}:{ss}</span>
          </div>
          <h1 className="mt-2 text-sm font-bold text-gray-900">Coaching room</h1>
          <p className="mt-1 text-xs text-gray-500">{s.status === "scheduled" && s.scheduledAt ? `Scheduled for ${new Date(s.scheduledAt).toLocaleString()} — the bot joins automatically, then you join the Meet.` : "Join the Meet below — the bot joins as “Arocall AI Coach”. Talk, and the transcript appears here live."}</p>
          {s.meetError && <p className="mt-2 rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Meet auto-create failed: {s.meetError}. Reconnect Google (Settings → Integrations) or paste a link below.</p>}
          {s.botError || s.bot_error ? <p className="mt-2 rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Bot error: {s.botError || s.bot_error}</p> : null}
          {!isOver && s.transport !== "inapp" && data.botOnline === false && data.joinable !== "bot-joining" && data.joinable !== "live" ? <p className="mt-2 rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Coach bot is not running — nobody will join this Meet until it is started: <code>cd coach-bot &amp;&amp; docker compose up -d bot</code>{data.botSeenAgoSec ? ` (last seen ${data.botSeenAgoSec}s ago)` : " (not seen since the API started)"}. Start it, then wait ~10s here; do not create a new session.</p> : null}
          {!isOver && meetUrl && !(turns.length) && (
            <p className="mt-2 rounded-md bg-gray-50 p-2 text-xs text-gray-600 ring-1 ring-gray-200">
              {data.joinable === "bot-joining" && "The bot has claimed this session and is joining the Meet now — give it up to a minute. If it doesn't appear, check the bot terminal."}
              {data.joinable === "joinable" && "Bot should pick this up within ~10s — if it doesn't, the coach-bot process is probably not running (cd coach-bot && npm start), or check its terminal for poll errors."}
              {data.joinable === "scheduled-waiting" && "Scheduled — the bot joins automatically at the scheduled time. Keep coach-bot running."}
              {data.joinable === "no-link" && "No Meet link yet — the bot has nothing to join."}
              {data.joinable === "inapp-transport" && "In-app transport — no bot needed, use browser mode."}
              {(!data.joinable || !["joinable", "scheduled-waiting", "no-link", "inapp-transport"].includes(data.joinable)) && (s.status === "scheduled" ? "Bot joins automatically at the scheduled time — keep coach-bot running." : "Waiting for the bot to join — keep coach-bot running (`npm start`). If it stays here, check the bot terminal for JOIN FAILED / poll errors.")}
            </p>
          )}
          {s.inviteEmail && <p className="mt-1 text-xs text-gray-500">Invite → {s.inviteEmail} {s.inviteSentAt ? "(sent)" : "(not sent — no Gmail config or bad email)"} <button className="font-semibold text-indigo-700 hover:underline" onClick={async () => { await authed(`/api/coach/${id}/invite`, {}); }}>resend</button></p>}
          {meetUrl ? (
            <div className="mt-3 space-y-2">
              <a href={meetUrl} target="_blank" rel="noreferrer" className="btn w-full"><Video className="h-4 w-4" /> Join the Meet</a>
              <button className="btn-outline w-full" onClick={() => { navigator.clipboard.writeText(meetUrl).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy Meet link</>}
              </button>
              <a className="btn-outline w-full" href={`mailto:?subject=AI coaching session&body=Join here: ${encodeURIComponent(meetUrl)}`}><span className="text-xs">Email the link</span></a>
            </div>
          ) : (
            <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200">
              <p className="font-semibold">Google Meet not connected.</p>
              <p className="mt-0.5">Paste a Meet link (admin) or use browser mode instead.</p>
              <div className="mt-2 flex gap-1">
                <input className="input" placeholder="https://meet.google.com/…" value={manualLink} onChange={(e) => setManualLink(e.target.value)} />
                <button className="btn shrink-0" onClick={saveLink}>Save</button>
              </div>
              {saveErr && <p className="mt-1 font-semibold text-red-600">{saveErr}</p>}
              <a className="mt-2 inline-flex items-center gap-1 font-semibold text-indigo-700 hover:underline" href={`/coach/${id}?token=${token}`}><Monitor className="h-3.5 w-3.5" /> Use browser mode instead</a>
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
            <button className="btn-outline" disabled={isOver} onClick={() => authed(`/api/coach/${id}/flag`, {})}><Hand className="h-3.5 w-3.5" /> Request human evaluator</button>
            <button className="btn-outline !text-red-600" disabled={isOver} onClick={() => authed(`/api/coach/${id}/end`, {})}><PhoneOff className="h-3.5 w-3.5" /> {isOver ? `Session ${s.status}` : "End session"}</button>
          </div>
          {s.humanFlag && <p className="mt-2 text-xs text-amber-700">Flagged for a human evaluator. They will follow up.</p>}
        </Card>
        <Card className="p-4 md:col-span-2">
          <h2 className="text-sm font-bold text-gray-900">Live transcript</h2>
          <div className="mt-2 max-h-[480px] space-y-2 overflow-y-auto">
            {turns.map((t: any, i: number) => (
              <div key={i} className={`rounded-lg p-2.5 text-xs ${t.role === "coach" ? "bg-gray-50 text-gray-800" : "bg-gray-900 text-white"}`}>
                <span className="font-semibold">{t.role === "coach" ? "AI Coach" : "You"}: </span>{t.text}
                {t.interrupted && <span className="ml-2 rounded bg-amber-100 px-1 text-[10px] text-amber-800">interrupted</span>}
              </div>
            ))}
            {!turns.length && <p className="text-xs text-gray-400">Waiting for the conversation to start…</p>}
          </div>
          {(s.status === "ended" || s.status === "expired" || s.status === "failed") && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs ring-1 ring-gray-200">
              <p className="font-bold text-gray-900">Summary</p>
              <p className="mt-0.5 text-gray-700">{s.summary || "—"}</p>
              {!!(s.actionItems || []).length && <p className="mt-1 text-gray-700">Agreed: {(s.actionItems as string[]).join(" · ")}</p>}
              <p className="mt-1 text-gray-500">Saved on the employee profile.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
