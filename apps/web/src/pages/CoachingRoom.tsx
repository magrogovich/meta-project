import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { Video, Copy, Check, Hand, PhoneOff, ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Card, CardHeader, Pill } from "../components/ui";

// Private admin monitor for an AI coaching session. The employee only ever
// receives the Google Meet link — this page is platform-internal.
export function CoachingRoom() {
  const [, params] = useRoute("/coach-room/:id");
  const id = params?.id || "";
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    try {
      const r = await api(`/api/coach/${id}/room`);
      setData(r);
      setErr("");
    } catch (e: any) {
      setErr(e.message || "failed to load");
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    const e = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(e); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const employeeId: string | undefined = data?.session?.employeeId;
  const { data: profile } = useQuery({
    queryKey: ["profile", employeeId],
    queryFn: () => api(`/api/employees/${employeeId}/profile`),
    enabled: !!employeeId,
  });
  const employeeName: string = profile?.employee?.name || "Employee";
  const employeeFirst = employeeName.split(" ")[0] || "Employee";

  if (err) return <p className="p-4 text-xs text-red-600">Couldn't load session: {err}</p>;
  if (!data) return <p className="p-4 text-xs text-gray-500">Loading coaching session…</p>;
  const s = data.session || {};
  const turns: any[] = data.turns?.length ? data.turns : (s.transcript || []).map((t: any, i: number) => ({ idx: i, ...t }));
  const statusTone = s.status === "live" ? "green" : s.status === "waiting_for_employee" ? "amber" : s.status === "ended" ? "gray" : "red";
  const statusLabel = s.status === "waiting_for_employee" ? "Waiting for employee" : s.status;
  const isOver = ["ended", "expired", "failed"].includes(s.status);
  // Session clock: derived from server timestamps so it survives refresh and
  // freezes when the session ends (instead of counting page-open time).
  const startMs = s.startedAt ? +new Date(s.startedAt) : s.createdAt ? +new Date(s.createdAt) : null;
  const endMs = s.endedAt ? +new Date(s.endedAt) : null;
  const elapsedSec = startMs ? Math.max(0, Math.floor(((isOver && endMs ? endMs : now) - startMs) / 1000)) : 0;
  const hh = Math.floor(elapsedSec / 3600);
  const mm = String(Math.floor((elapsedSec % 3600) / 60)).padStart(hh ? 2 : 1, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  const clock = hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  const meetUrl: string = s.meetUrl || s.meet_url || "";

  const authed = async (path: string, body: any) => {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    load();
  };
  const saveLink = async () => {
    setSaveErr("");
    try {
      await api(`/api/coach/${id}/meet-link`, { method: "PATCH", body: JSON.stringify({ meetUrl: manualLink }) });
      setManualLink("");
      load();
    } catch (e: any) { setSaveErr(e.message); }
  };
  return (
    <div className="w-full space-y-4">
      <Link href="/coaching" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Coaching</Link>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="h-fit p-0">
          <CardHeader
            title={`Session — ${employeeName}`}
            sub={`${statusLabel} · ${clock}${isOver && endMs ? " total" : ""}${s.scheduledAt ? ` · scheduled ${new Date(s.scheduledAt).toLocaleString()}` : ""}`}
            right={<Pill tone={statusTone as any}>{statusLabel}</Pill>}
          />
          <div className="space-y-2 p-4">
            {s.topics && <p className="text-xs text-gray-600"><span className="font-semibold text-gray-900">Topics:</span> {s.topics}</p>}
            {s.meetError && <p className="rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Meet auto-create failed: {s.meetError}. Reconnect Google (Settings → Integrations) or paste a link below.</p>}
            {s.botError || s.bot_error ? <p className="rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Bot error: {s.botError || s.bot_error}</p> : null}
            {!isOver && s.transport !== "inapp" && data.botOnline === false && data.joinable !== "bot-joining" && data.joinable !== "live" ? <p className="rounded-md bg-red-50 p-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">Coach bot is not running — nobody will join this Meet until it is started: <code>cd coach-bot &amp;&amp; docker compose up -d bot</code>{data.botSeenAgoSec ? ` (last seen ${data.botSeenAgoSec}s ago)` : " (not seen since the API started)"}. Start it, then wait ~10s here; do not create a new session.</p> : null}
            {!isOver && meetUrl && !turns.length && (
              <p className="rounded-md bg-gray-50 p-2 text-xs text-gray-600 ring-1 ring-gray-200">
                {data.joinable === "bot-joining" && "The bot has claimed this session and is joining the Meet now — give it up to a minute."}
                {data.joinable === "joinable" && "Bot should pick this up within ~10s — if it doesn't, the coach-bot process is probably not running."}
                {data.joinable === "scheduled-waiting" && "Scheduled — the bot joins automatically at the scheduled time. Keep coach-bot running."}
                {data.joinable === "no-link" && "No Meet link yet — the bot has nothing to join."}
                {(!data.joinable || !["joinable", "scheduled-waiting", "no-link", "bot-joining"].includes(data.joinable)) && (s.status === "scheduled" ? "Bot joins automatically at the scheduled time — keep coach-bot running." : "Waiting for the employee and bot to join the Meet.")}
              </p>
            )}
            {s.inviteEmail && <p className="text-xs text-gray-500">Meet invite → {s.inviteEmail} {s.inviteSentAt ? "(sent)" : "(not sent — no Gmail config or bad email)"} <button className="font-semibold text-indigo-700 hover:underline" onClick={async () => { await authed(`/api/coach/${id}/invite`, {}); }}>resend</button></p>}
            {meetUrl ? (
              <div className="space-y-2">
                <a href={meetUrl} target="_blank" rel="noreferrer" className="btn w-full"><Video className="h-4 w-4" /> Observe in Meet</a>
                <button className="btn-outline w-full" onClick={() => { navigator.clipboard.writeText(meetUrl).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                  {copied ? <><Check className="h-3.5 w-3.5" /> Copied — send to employee</> : <><Copy className="h-3.5 w-3.5" /> Copy Meet link for employee</>}
                </button>
              </div>
            ) : (
              <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-200">
                <p className="font-semibold">Google Meet not connected.</p>
                <p className="mt-0.5">Paste a Meet link to let the bot and employee join.</p>
                <div className="mt-2 flex gap-1">
                  <input className="input" placeholder="https://meet.google.com/…" value={manualLink} onChange={(e) => setManualLink(e.target.value)} />
                  <button className="btn shrink-0" onClick={saveLink}>Save</button>
                </div>
                {saveErr && <p className="mt-1 font-semibold text-red-600">{saveErr}</p>}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <button className="btn-outline" disabled={isOver} onClick={() => authed(`/api/coach/${id}/flag`, {})}><Hand className="h-3.5 w-3.5" /> Flag for human follow-up</button>
              <button className="btn-outline !text-red-600" disabled={isOver} onClick={() => authed(`/api/coach/${id}/end`, {})}><PhoneOff className="h-3.5 w-3.5" /> {isOver ? `Session ${s.status}` : "End session"}</button>
            </div>
            {s.humanFlag && <p className="text-xs text-amber-700">Flagged for a human evaluator.</p>}
            {employeeId && <Link href={`/employees/${employeeId}`} className="inline-block text-xs font-semibold text-indigo-700 hover:underline">Open {employeeName}'s profile →</Link>}
          </div>
        </Card>
        <Card className="p-0 md:col-span-2">
          <CardHeader title="Live transcript" sub={`AI Coach ↔ ${employeeName} · updates every few seconds`} />
          <div className="max-h-[480px] space-y-2 overflow-y-auto p-4">
            {turns.map((t: any, i: number) => {
              const isCoach = t.role === "coach";
              return (
                <div key={i} className={`rounded-lg p-2.5 text-xs ${isCoach ? "bg-gray-50 text-gray-800 ring-1 ring-gray-100" : "bg-indigo-50 text-gray-900 ring-1 ring-indigo-100"}`}>
                  <span className="font-semibold">{isCoach ? "AI Coach" : employeeFirst}: </span>{t.text}
                  {t.interrupted && <span className="ml-2 rounded bg-amber-100 px-1 text-[10px] text-amber-800">interrupted</span>}
                </div>
              );
            })}
            {!turns.length && <p className="text-xs text-gray-400">Waiting for the conversation to start… the employee and bot meet in Google Meet; their transcript appears here for review.</p>}
          </div>
          {(s.status === "ended" || s.status === "expired" || s.status === "failed") && (
            <div className="m-4 mt-0 rounded-lg bg-gray-50 p-3 text-xs ring-1 ring-gray-200">
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
