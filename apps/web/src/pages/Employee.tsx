import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, API } from "../lib/api";
import { useState, useRef, useEffect } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useAuth } from "../lib/auth";
import { ArrowLeft, Mic, MoreHorizontal, Eye, EyeOff, Copy, Check, KeyRound, Ban, FileText, Plus, Trash2, Pencil, Play, Pause, Loader2 } from "lucide-react";
import { Card, CardHeader, Pill, scoreTone, EmptyState, DateField } from "../components/ui";
import { LineChart, HBars } from "../components/charts";

const TABS = ["Overview", "Calls", "Coaching", "Agent"] as const;

// ---------- custom audio player (light, minimal) ----------
// The stored file is split-track stereo (agent = left, customer = right) so
// the pipeline can label speakers by channel. For listening, the player
// loads a centered mono mix from the API (?mix=mono: both voices, both ears),
// with a Mono/Stereo toggle that swaps the source while keeping position.
function AudioPlayer({ src, audioRef }: { src: string; audioRef: React.RefObject<HTMLAudioElement | null> }) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [mono, setMono] = useState(true);
  const [rate, setRate] = useState(1);
  const SPEEDS = [1, 1.25, 1.5, 2];
  const [audioError, setAudioError] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const pendingSeek = useRef<{ pos: number; play: boolean } | null>(null);
  const url = mono ? `${src}?mix=mono` : src;
  useEffect(() => { setAudioError(false); setT(0); setDur(0); pendingSeek.current = null; }, [src]);
  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };
  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play(); else a.pause();
  };
  const toggleMix = () => {
    const a = audioRef.current;
    if (!a) return;
    pendingSeek.current = { pos: a.currentTime, play: !a.paused };
    setMono((m) => !m);
  };
  const onLoaded = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    const el = e.currentTarget;
    el.playbackRate = rate;
    setDur(el.duration);
    const p = pendingSeek.current;
    pendingSeek.current = null;
    if (p) {
      el.currentTime = Math.min(p.pos, el.duration || 0);
      if (p.play) el.play().catch(() => {});
    }
  };
  const seekRatio = (ratio: number) => {
    const a = audioRef.current;
    if (!a || !dur) return;
    const nt = Math.min(Math.max(ratio, 0), 1) * dur;
    a.currentTime = nt; setT(nt);
  };
  const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl bg-gray-50 px-3 py-2 ring-1 ring-gray-200">
      <audio ref={audioRef} src={url} preload="metadata"
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={onLoaded}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setAudioError(true)} className="hidden" />
      <button
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-900 text-white transition hover:bg-gray-700"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
      </button>
      <span className="shrink-0 text-xs tabular-nums text-gray-500">{fmt(t)}</span>
      <div ref={barRef}
        role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(t)}
        tabIndex={0}
        className="h-1.5 flex-1 cursor-pointer rounded-full bg-gray-200 outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        onClick={(e) => {
          const el = barRef.current;
          if (!el) return;
          const r = el.getBoundingClientRect();
          seekRatio((e.clientX - r.left) / r.width);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") seekRatio((t + 5) / (dur || 1));
          if (e.key === "ArrowLeft") seekRatio((t - 5) / (dur || 1));
        }}>
        <div className="h-full rounded-full bg-teal-600 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-gray-400">{fmt(dur)}</span>
      {audioError && <span className="shrink-0 text-[11px] text-red-600">Couldn't load audio</span>}
      <button
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
          setRate(next);
          if (audioRef.current) audioRef.current.playbackRate = next;
        }}
        title={`Playback speed: ${rate}x (click to change)`}
        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums text-gray-500 ring-1 ring-gray-300 transition hover:text-gray-900">
        {rate}x
      </button>
      <button
        onClick={toggleMix}
        title={mono
          ? "Mono mix: agent + customer in both ears (click for true stereo: agent left, customer right)"
          : "True stereo: agent left, customer right (click for mono mix in both ears)"}
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 transition ${
          mono ? "bg-gray-900 text-white ring-gray-900" : "text-gray-500 ring-gray-300 hover:text-gray-900"}`}>
        {mono ? "Mono" : "Stereo"}
      </button>
    </div>
  );
}

// ---------- session key panel ----------
function AgentKey({ employeeId, isAdmin }: { employeeId: string; isAdmin: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"regen" | "revoke" | null>(null);
  const qc = useQueryClient();
  const reveal = async () => {
    setErr("");
    try { const r = await api(`/api/employees/${employeeId}/key`); setKey(r.sessionKey); }
    catch (e: any) { setErr(e.message); }
  };
  const copy = async () => {
    if (!key) return;
    await navigator.clipboard.writeText(key).catch(() => {});
    api(`/api/employees/${employeeId}/key/copied`, { method: "POST" }).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  const regen = async () => {
    const r = await api(`/api/employees/${employeeId}/key/regenerate`, { method: "POST" });
    setKey(r.sessionKey); setConfirm(null);
    qc.invalidateQueries({ queryKey: ["profile"] });
  };
  const revoke = async () => {
    await api(`/api/employees/${employeeId}/key/revoke`, { method: "POST" });
    setKey(null); setConfirm(null);
    qc.invalidateQueries({ queryKey: ["profile"] });
  };
  if (!isAdmin) return <p className="p-4 text-xs text-gray-500">Session keys are visible to admins only.</p>;
  return (
    <div className="space-y-3 p-4">
      {!key ? (
        <button className="btn-outline" onClick={reveal}><Eye className="h-3.5 w-3.5" /> Reveal session key</button>
      ) : (
        <div className="flex gap-2">
          <input className="input font-mono" readOnly type={show ? "text" : "password"} value={key} />
          <button className="btn-outline shrink-0" onClick={() => setShow((s) => !s)}>{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
          <button className="btn-outline shrink-0" onClick={copy}>{copied ? <><Check className="h-4 w-4 text-emerald-600" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}</button>
        </div>
      )}
      {err && <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-700 ring-1 ring-amber-200">{err}</p>}
      <div className="flex flex-wrap gap-2">
        {!confirm ? (
          <>
            <button className="btn-outline" onClick={() => setConfirm("regen")}><KeyRound className="h-3.5 w-3.5" /> Regenerate key</button>
            <button className="btn-outline !text-red-600" onClick={() => setConfirm("revoke")}><Ban className="h-3.5 w-3.5" /> Revoke key</button>
          </>
        ) : (
          <div className="rounded-lg bg-amber-50 p-3 text-xs ring-1 ring-amber-200">
            <p className="font-semibold text-gray-900">{confirm === "regen" ? "Regenerate this key?" : "Revoke this key?"}</p>
            <p className="mt-0.5 text-gray-600">{confirm === "regen" ? "The old key stops working immediately. The desktop agent will need the new key." : "The agent will stop uploading immediately and show an error until a new key is set up."}</p>
            <div className="mt-2 flex gap-2">
              <button className="btn" onClick={confirm === "regen" ? regen : revoke}>Confirm</button>
              <button className="btn-outline" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- start-coaching dialog ----------
export function CoachDialog({ employeeId, employeeName, employeeEmail, onClose }: { employeeId: string; employeeName: string; employeeEmail?: string; onClose: () => void }) {
  const [, nav] = useLocation();
  const [topics, setTopics] = useState("");
  const [memoId, setMemoId] = useState("");
  const [email, setEmail] = useState(employeeEmail || "");
  const [mode, setMode] = useState<"now" | "scheduled">("now");
  const [when, setWhen] = useState("");
  const [err, setErr] = useState("");
  const { data: memos } = useQuery({ queryKey: ["memos", employeeId], queryFn: () => api(`/api/memos?employeeId=${employeeId}`) });
  const start = useMutation({
    mutationFn: () => api("/api/coach", {
      method: "POST",
      body: JSON.stringify({
        employeeId, memoId: memoId || undefined, topics,
        email: email.trim() || undefined,
        ...(mode === "scheduled" && when ? { scheduledAt: new Date(when).toISOString() } : {}),
      }),
    }),
    onSuccess: (r) => nav(`/coach-room/${r.id}`),
    onError: (e: any) => setErr(e.message),
  });
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h2 className="text-sm font-bold text-gray-900">Start AI coaching — {employeeName}</h2>
        <p className="mt-0.5 text-[11px] text-gray-500">Auto-creates a Google Meet, emails the invite to the employee, and the AI coach joins on its own. No manual links.</p>
        <label className="mt-3 block text-[11px] font-semibold text-gray-500">Employee email (invite goes here)</label>
        <input className="input mt-1" type="email" placeholder="jane@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Focus topics</label>
        <input className="input mt-1" placeholder="e.g. closing, empathy on billing calls" value={topics} onChange={(e) => setTopics(e.target.value)} />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Attach memo (optional)</label>
        <select className="input mt-1" value={memoId} onChange={(e) => setMemoId(e.target.value)}>
          <option value="">none</option>{((memos as any[]) || []).map((m: any) => <option key={m.id} value={m.id}>{m.content?.employee} · {m.content?.period}</option>)}
        </select>
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">When</label>
        <div className="mt-1 flex gap-1">
          <button type="button" onClick={() => setMode("now")} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "now" ? "bg-gray-900 text-white" : "text-gray-500 ring-1 ring-gray-200"}`}>Now (instant)</button>
          <button type="button" onClick={() => setMode("scheduled")} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "scheduled" ? "bg-gray-900 text-white" : "text-gray-500 ring-1 ring-gray-200"}`}>Schedule</button>
        </div>
        {mode === "scheduled" && (
          <input className="input mt-2" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        )}
        {err && <p className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-700 ring-1 ring-red-200">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-outline" disabled={start.isPending} onClick={onClose}>Cancel</button>
          <button className="btn min-w-36" disabled={start.isPending || (mode === "scheduled" && !when)} onClick={() => { setErr(""); start.mutate(); }}>
            {start.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {mode === "scheduled" ? "Scheduling… sending invite…" : "Starting… sending invite…"}</>
            ) : (
              <><Mic className="h-3.5 w-3.5" /> {mode === "scheduled" ? "Schedule session" : "Start now"}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- edit employee dialog ----------
function EditDialog({ employee, onClose }: { employee: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: depts } = useQuery({ queryKey: ["depts"], queryFn: () => api("/api/departments") });
  const [form, setForm] = useState({
    name: employee.name, email: employee.email || "", department: employee.department,
    languages: (employee.languages || []).join(", "), status: employee.status || "active",
  });
  const save = useMutation({
    mutationFn: () => api(`/api/employees/${employee.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...form, languages: form.languages.split(",").map((s: string) => s.trim()).filter(Boolean) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); qc.invalidateQueries({ queryKey: ["emp-table"] }); qc.invalidateQueries({ queryKey: ["emps"] }); onClose(); },
  });
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h2 className="text-sm font-bold text-gray-900">Edit employee</h2>
        <label className="mt-3 block text-[11px] font-semibold text-gray-500">Name</label>
        <input className="input mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Work email (coaching invites)</label>
        <input className="input mt-1" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Department</label>
        <select className="input mt-1" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
          {[...new Set([...((depts as any[]) || []).map((d) => d.name), form.department])].map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Languages (comma separated)</label>
        <input className="input mt-1" value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} />
        <label className="mt-2 block text-[11px] font-semibold text-gray-500">Status</label>
        <select className="input mt-1" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="active">active</option><option value="inactive">inactive</option>
        </select>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!form.name.trim()} onClick={() => save.mutate()}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------- coaching tab ----------
function CoachingTab({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const inv = () => { qc.invalidateQueries({ queryKey: ["memos"] }); qc.invalidateQueries({ queryKey: ["sessions"] }); qc.invalidateQueries({ queryKey: ["actions"] }); };
  const { data: memos } = useQuery({ queryKey: ["memos", employeeId], queryFn: () => api(`/api/memos?employeeId=${employeeId}`) });
  const { data: sessions } = useQuery({ queryKey: ["sessions", employeeId], queryFn: () => api(`/api/coaching/sessions?employeeId=${employeeId}`) });
  const { data: actions } = useQuery({ queryKey: ["actions", employeeId], queryFn: () => api(`/api/coaching/actions?employeeId=${employeeId}`) });
  const [editing, setEditing] = useState<any>(null);
  const [editForm, setEditForm] = useState({ summary: "", actionPlan: "", phrases: "" });
  const [newAction, setNewAction] = useState("");
  const genMemo = useMutation({ mutationFn: () => api("/api/memos/generate", { method: "POST", body: JSON.stringify({ employeeId }) }), onSuccess: inv });
  const saveMemo = useMutation({
    mutationFn: () => api(`/api/memos/${editing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: { summary: editForm.summary, actionPlan: editForm.actionPlan.split("\n").filter(Boolean), phrases: editForm.phrases.split("\n").filter(Boolean) } }),
    }),
    onSuccess: () => { setEditing(null); inv(); },
  });
  const toggleAction = useMutation({
    mutationFn: (a: any) => api(`/api/coaching/actions/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: a.status === "done" ? "open" : "done" }) }),
    onSuccess: inv,
  });
  const addAction = useMutation({
    mutationFn: () => api("/api/coaching/actions", { method: "POST", body: JSON.stringify({ employeeId, text: newAction }) }),
    onSuccess: () => { setNewAction(""); inv(); },
  });
  const delAction = useMutation({
    mutationFn: (id: string) => api(`/api/coaching/actions/${id}`, { method: "DELETE" }),
    onSuccess: inv,
  });
  const openEdit = (m: any) => {
    setEditing(m);
    setEditForm({ summary: m.content?.summary || "", actionPlan: (m.content?.actionPlan || []).join("\n"), phrases: (m.content?.phrases || []).join("\n") });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Coaching memos" sub="generate, edit, export" right={<button className="btn" onClick={() => genMemo.mutate()}><FileText className="h-3.5 w-3.5" /> Generate memo</button>} />
        {!((memos as any[]) || []).length ? <p className="p-4 text-xs text-gray-400">No memos yet.</p> : (
          <ul className="divide-y divide-gray-100">
            {((memos as any[]) || []).map((m: any) => (
              <li key={m.id} className="px-4 py-3 text-xs">
                {editing?.id === m.id ? (
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-gray-500">Summary</label>
                    <textarea className="input h-20" value={editForm.summary} onChange={(e) => setEditForm({ ...editForm, summary: e.target.value })} />
                    <label className="text-[11px] font-semibold text-gray-500">Action plan (one per line)</label>
                    <textarea className="input h-20" value={editForm.actionPlan} onChange={(e) => setEditForm({ ...editForm, actionPlan: e.target.value })} />
                    <label className="text-[11px] font-semibold text-gray-500">Practice phrases (one per line)</label>
                    <textarea className="input h-20" value={editForm.phrases} onChange={(e) => setEditForm({ ...editForm, phrases: e.target.value })} />
                    <div className="flex gap-2"><button className="btn" onClick={() => saveMemo.mutate()}>Save</button><button className="btn-outline" onClick={() => setEditing(null)}>Cancel</button></div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{m.content?.period || "Memo"}</span>
                      <Pill tone="gray">{m.content?.callCount ?? 0} calls · {m.content?.avgScore ?? "—"}</Pill>
                      <span className="ml-auto flex gap-1">
                        <button className="btn-outline !px-2 !py-1" onClick={() => openEdit(m)}><Pencil className="h-3 w-3" /></button>
                        <button className="btn-outline !px-2 !py-1" onClick={() => window.print()}>PDF</button>
                      </span>
                    </div>
                    <p className="mt-1 text-gray-600">{m.content?.summary}</p>
                    {!!(m.content?.actionPlan || []).length && <p className="mt-1 text-gray-500">Plan: {m.content.actionPlan.join(" · ")}</p>}
                  </>
                )}
              </li>))}
          </ul>)}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Past AI sessions" sub={`${((sessions as any[]) || []).length} total`} />
          {!((sessions as any[]) || []).length ? <p className="p-4 text-xs text-gray-400">No sessions yet.</p> : (
            <ul className="divide-y divide-gray-100">
              {((sessions as any[]) || []).map((x: any) => (
                <li key={x.id} className="px-4 py-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800">{new Date(x.createdAt).toLocaleString()}</span>
                    {x.humanFlag && <Pill tone="amber">human requested</Pill>}
                  </div>
                  <p className="mt-0.5 text-gray-500">{x.summary || "—"}</p>
                  {!!(x.actionItems || []).length && <p className="text-gray-500">Agreed: {(x.actionItems as string[]).join(" · ")}</p>}
                </li>))}
            </ul>)}
        </Card>
        <Card>
          <CardHeader title="Action items" sub="track follow-through" />
          <div className="flex gap-2 p-3">
            <input className="input" placeholder="New action item…" value={newAction} onChange={(e) => setNewAction(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newAction.trim() && addAction.mutate()} />
            <button className="btn shrink-0" disabled={!newAction.trim()} onClick={() => addAction.mutate()}><Plus className="h-3.5 w-3.5" /></button>
          </div>
          <ul className="divide-y divide-gray-100">
            {((actions as any[]) || []).map((a: any) => (
              <li key={a.id} className="flex items-center gap-2 px-4 py-2 text-xs">
                <input type="checkbox" checked={a.status === "done"} onChange={() => toggleAction.mutate(a)} className="h-4 w-4 accent-gray-900" />
                <span className={`flex-1 ${a.status === "done" ? "text-gray-400 line-through" : "text-gray-800"}`}>{a.text}</span>
                <Pill tone="gray">{a.source}</Pill>
                <button className="text-gray-400 hover:text-red-600" onClick={() => delAction.mutate(a.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </li>))}
          </ul>
          {!((actions as any[]) || []).length && <p className="p-4 text-xs text-gray-400">No action items yet.</p>}
        </Card>
      </div>
    </div>
  );
}

// ---------- profile ----------
export function EmployeeProfile() {
  const [, params] = useRoute("/employees/:id");
  const id = params?.id || "";
  const [, nav] = useLocation();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [f, setF] = useState({ from: "", to: "", lang: "", min: "", max: "" });
  const [more, setMore] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { role } = useAuth();
  const isAdmin = role !== "evaluator";
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading } = useQuery({ queryKey: ["profile", id, q], queryFn: () => api(`/api/employees/${id}/profile?${q}`) });
  const qc = useQueryClient();
  const delEmp = useMutation({
    mutationFn: () => api(`/api/employees/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["emps"] }); nav("/employees"); },
  });
  if (isLoading) return <p className="p-4 text-xs text-gray-500">Loading…</p>;
  if (!data) return <p className="p-4 text-xs">Not found</p>;
  const e = data.employee;
  const callCount = data.calls.length;
  const rangeHint = callCount ? `from ${data.calls.length} analyzed call(s)` : "no analyzed calls";
  return (
    <div className="w-full space-y-4">
      <Link href="/employees" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Employees</Link>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          {e.photo ? <img src={e.photo} className="h-14 w-14 rounded-full object-cover" alt="" /> : <div className="grid h-14 w-14 place-items-center rounded-full bg-gray-900 text-xl font-bold text-white">{e.name[0]}</div>}
          <div className="min-w-48 flex-1">
            <h1 className="text-lg font-bold tracking-tight text-gray-900">{e.name}</h1>
            <p className="text-xs text-gray-500">{e.department} · {(e.languages || []).join(", ")}{e.email ? ` · ${e.email}` : ""}</p>
          </div>
          <Pill tone={scoreTone(e.overallScore || 0)}><span className="text-base">{e.overallScore ?? "—"}</span></Pill>
          <span className="text-xs text-gray-500">{data.trend?.length > 1 ? `trend ${data.trend[data.trend.length - 1].score >= data.trend[0].score ? "↗" : "↘"}` : ""}</span>
          <button className="btn" onClick={() => setCoachOpen(true)}><Mic className="h-3.5 w-3.5" /> Start AI coaching</button>
          <div className="relative">
            <button className="btn-outline" onClick={() => setMore((m) => !m)}><MoreHorizontal className="h-4 w-4" /> More</button>
            {more && (
              <div className="absolute end-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                <button className="block w-full px-3 py-2 text-left text-xs hover:bg-gray-50" onClick={() => { setMore(false); setEditOpen(true); }}><span className="inline-flex items-center gap-1.5"><Pencil className="h-3 w-3" /> Edit details</span></button>
                <button className="block w-full px-3 py-2 text-left text-xs hover:bg-gray-50" onClick={() => { setMore(false); setTab("Coaching"); }}>Generate memo</button>
                <button className="block w-full px-3 py-2 text-left text-xs hover:bg-gray-50" onClick={() => { setMore(false); setTab("Agent"); }}>Manage session key</button>
                <button className="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50" onClick={() => { if (confirm(`Delete ${e.name} and all their data?`)) delEmp.mutate(); }}>Delete employee</button>
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 flex gap-1 border-t border-gray-100 pt-3">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}>{t}</button>))}
        </div>
      </Card>

      {tab === "Overview" && (
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader title="Score trend" sub={`${rangeHint} — hover a point, click to open the call`} />
            <div className="p-4"><LineChart
              color="#4f39f6"
              points={data.trend}
              hint={(p) => `${new Date(p.t).toLocaleString()} — score ${p.score} (click to open call)`}
              onPointClick={(p) => p.id && nav(`/calls/${p.id}`)} /></div>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Criteria breakdown" sub={`average per criterion, ${rangeHint}`} />
            <div className="p-4"><HBars color="#4f39f6" bars={(data.breakdown || []).map((b: any) => ({
              label: b.name, value: b.avg,
              hint: `${b.name}: avg ${b.avg} across ${b.count} call(s)`,
            }))} /></div>
          </Card>
        </div>
      )}

      {tab === "Calls" && (
        <Card>
          <CardHeader title="Calls" sub={`${data.calls.length} in filter — click a row to open`} />
          <div className="flex flex-wrap items-end gap-2 border-b border-gray-100 p-3">
            <div><label className="text-[11px] font-semibold text-gray-500">From</label><DateField value={f.from} onChange={(v) => setF({ ...f, from: v })} /></div>
            <div><label className="text-[11px] font-semibold text-gray-500">To</label><DateField value={f.to} onChange={(v) => setF({ ...f, to: v })} /></div>
            <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
              <select className="input mt-1 w-28" value={f.lang} onChange={(ev) => setF({ ...f, lang: ev.target.value })}><option value="">all</option><option>en</option><option>fr</option><option>de</option><option>es</option></select></div>
            <div><label className="text-[11px] font-semibold text-gray-500">Min score</label><input className="input mt-1 w-24" type="number" placeholder="—" value={f.min} onChange={(ev) => setF({ ...f, min: ev.target.value })} /></div>
            <div><label className="text-[11px] font-semibold text-gray-500">Max score</label><input className="input mt-1 w-24" type="number" placeholder="—" value={f.max} onChange={(ev) => setF({ ...f, max: ev.target.value })} /></div>
          </div>
          {!data.calls.length ? <p className="p-4 text-xs text-gray-400">No calls in this filter.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-100">
                  <th className="table-head px-4 py-2">Date</th><th className="table-head px-2 py-2">Dur</th>
                  <th className="table-head px-2 py-2">Lang</th><th className="table-head px-2 py-2">Status</th>
                  <th className="table-head px-2 py-2 text-right">Score</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {data.calls.map((c: any) => (
                    <tr key={c.id} className="cursor-pointer hover:bg-gray-50" onClick={() => nav(`/calls/${c.id}`)}>
                      <td className="px-4 py-2.5 font-medium text-gray-900">{new Date(c.startedAt).toLocaleString()}</td>
                      <td className="px-2 py-2.5 text-gray-500">{c.durationSec}s</td>
                      <td className="px-2 py-2.5 text-gray-500">{c.language}</td>
                      <td className="px-2 py-2.5"><Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{c.status}</Pill></td>
                      <td className="px-2 py-2.5 text-right"><Pill tone={scoreTone(c.score)}>{c.score}</Pill></td>
                    </tr>))}
                </tbody>
              </table>
            </div>)}
        </Card>
      )}

      {tab === "Coaching" && <CoachingTab employeeId={id} />}

      {tab === "Agent" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Session key" sub="persistent · masked · audited" />
            <AgentKey employeeId={id} isAdmin={isAdmin} />
          </Card>
          <Card>
            <CardHeader title="Device" sub="desktop agent status" />
            <div className="space-y-2 p-4 text-xs">
              <p><span className="font-semibold text-gray-700">Status: </span><Pill tone={e.agentStatus === "online" ? "green" : e.agentStatus === "offline" ? "amber" : "gray"}>{e.agentStatus || "never"}</Pill></p>
              <p><span className="font-semibold text-gray-700">Last seen: </span><span className="text-gray-600">{e.lastSeen ? new Date(e.lastSeen).toLocaleString() : "never connected"}</span></p>
              <p><span className="font-semibold text-gray-700">Agent version: </span><span className="text-gray-600">{e.agentVersion || "—"}</span></p>
              {e.keyRevoked && <p className="rounded-md bg-red-50 p-2 text-red-700 ring-1 ring-red-200">Key revoked — the agent is paused until a new key is set up.</p>}
            </div>
          </Card>
        </div>
      )}

      {coachOpen && <CoachDialog employeeId={id} employeeName={e.name} employeeEmail={e.email} onClose={() => setCoachOpen(false)} />}
      {editOpen && <EditDialog employee={e} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

export function MemoCard({ memo }: { memo: any }) {
  const c = memo.content;
  return (
    <Card className="p-5 text-xs">
      <h3 className="text-sm font-bold text-gray-900">Coaching memo — {c.employee} ({c.period})</h3>
      <p className="mt-1 text-gray-600">{c.summary}</p>
      <p className="mt-3 font-semibold text-gray-900">Top issues</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.topIssues || []).map((t: any, i: number) => <li key={i}>{t.text || t}</li>)}</ul>
      <p className="mt-2 font-semibold text-gray-900">Action plan</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.actionPlan || []).map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
      <p className="mt-2 font-semibold text-gray-900">Practice phrases</p>
      <ul className="ml-4 list-disc text-gray-600">{(c.phrases || []).map((t: string, i: number) => <li key={i}><i>“{t}”</i></li>)}</ul>
      <button className="btn mt-3" onClick={() => window.print()}>Export PDF (print)</button>
    </Card>
  );
}

export function CallDetail() {
  const [, params] = useRoute("/calls/:id");
  const id = params?.id || "";
  const seekRef = useRef<HTMLAudioElement>(null);
  const [rerunning, setRerunning] = useState(false);
  const { data: c, isLoading, refetch } = useQuery({ queryKey: ["call", id], queryFn: () => api(`/api/calls/${id}`), refetchInterval: (q: any) => (["uploaded", "transcribing", "analyzing"].includes(q?.state?.data?.status) ? 2000 : false) });
  useEffect(() => {
    if (c && !["uploaded", "transcribing", "analyzing"].includes(c.status)) setRerunning(false);
  }, [c?.status]);
  if (isLoading) return <p className="p-4 text-xs text-gray-500">Loading…</p>;
  const seek = (s: number) => { const a = seekRef.current; if (a) { a.currentTime = s; a.play(); } };
  const rerun = async () => {
    if (rerunning) return;
    setRerunning(true);
    await api(`/api/calls/${id}/rerun`, { method: "POST" });
    refetch();
  };
  return (
    <div className="w-full space-y-4">
      <Link href={c ? `/employees/${c.employeeId}` : "/employees"} className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Back to employee</Link>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-gray-900">Call {id.slice(0, 8)}</span>
          <Pill tone={c.status === "done" ? "green" : c.status === "failed" ? "red" : "amber"}>{rerunning ? "analyzing" : c.status}</Pill>
          <Pill tone={scoreTone(c.score)}>{c.score}</Pill>
          <span className="text-xs text-gray-500">{c.language} · criteria v{c.criteriaVersion ?? 1}{c.guidelineRefs && Object.keys(c.guidelineRefs).length ? ` · guidelines ${Object.values(c.guidelineRefs).join(",")}` : ""}</span>
          <button className="btn-outline ml-auto disabled:opacity-60" disabled={rerunning} onClick={rerun}>{rerunning ? "Analyzing…" : "Re-run analysis"}</button>
        </div>
        <AudioPlayer audioRef={seekRef} src={`${API}/api/calls/audio/${c.audioFile}`} />
        <p className="mt-2 text-xs text-gray-700">{c.summary}</p>
        <p className="mt-1 text-[11px] text-gray-500">Went well: {(c.wentWell || []).join(" · ") || "—"}</p>
        <p className="text-[11px] text-gray-500">Went wrong: {(c.wentWrong || []).join(" · ") || "—"} · Tags: {(c.tags || []).join(", ")}</p>
        <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2">
          <div className="rounded-md bg-gray-50 p-2 ring-1 ring-gray-100">
            <p className="font-semibold text-gray-700">Conversation outcomes <span className="font-normal text-gray-400">(AI estimate)</span></p>
            <p className="mt-1 text-gray-600">Sentiment start: <b>{c.sentimentStart || "—"}</b>
              {c.sentimentStartQuote && <button className="ml-1 text-indigo-700 hover:underline" onClick={() => seek(c.sentimentStartAt)}>“{c.sentimentStartQuote.slice(0, 60)}”</button>}</p>
            <p className="text-gray-600">Sentiment end: <b>{c.sentimentEnd || "—"}</b>
              {c.sentimentEndQuote && <button className="ml-1 text-indigo-700 hover:underline" onClick={() => seek(c.sentimentEndAt)}>“{c.sentimentEndQuote.slice(0, 60)}”</button>}</p>
            <p className="text-gray-600">Resolved: <b>{c.issueResolved || "—"}</b>
              {c.issueResolvedQuote && <button className="ml-1 text-indigo-700 hover:underline" onClick={() => seek(c.issueResolvedAt)}>“{c.issueResolvedQuote.slice(0, 60)}”</button>}</p>
            <p className="text-gray-600">Supervisor requested: <b>{c.supervisorRequested ? "yes" : "no"}</b>
              {!!c.supervisorQuote && <button className="ml-1 text-indigo-700 hover:underline" onClick={() => seek(c.supervisorAt)}>“{c.supervisorQuote.slice(0, 60)}”</button>}</p>
          </div>
          <div className="rounded-md bg-gray-50 p-2 ring-1 ring-gray-100">
            <p className="font-semibold text-gray-700">Conversation metrics <span className="font-normal text-gray-400">(computed)</span></p>
            <p className="mt-1 text-gray-600">Talk:listening {c.talkRatio ?? "—"}{c.talkRatio != null ? ":1" : ""} · Dead air {c.deadAirPct ?? "—"}{c.deadAirPct != null ? "%" : ""} · Interruptions {c.interruptions ?? "—"}</p>
            <p className="text-gray-600">Handle {c.durationSec}s · Pace {c.agentWpm ?? "—"}{c.agentWpm != null ? " wpm" : ""}</p>
            {(c.talkRatio == null) && <p className="text-gray-400">— until re-run analysis.</p>}
          </div>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Transcript" sub="click a line to seek" />
          <div className="max-h-[480px] overflow-y-auto p-2">
            {(c.transcript || []).map((l: any, i: number) => (
              <button key={i} onClick={() => seek(l.start)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50">
                <span className={`badge mt-0.5 shrink-0 ${l.speaker === "Agent" ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "bg-gray-100 text-gray-600"}`}>{l.speaker} {l.start.toFixed(1)}s</span>
                <span className="text-gray-700">{l.text}</span>
              </button>))}
          </div>
        </Card>
        <Card>
          <CardHeader title="AI report" sub="every score has evidence" />
          <div className="max-h-[480px] overflow-y-auto p-4">
            {(c.results || []).map((r: any) => (
              <div key={r.id} className="border-b border-gray-100 py-2.5 text-xs last:border-0">
                <div className="flex items-center gap-2"><span className="font-semibold text-gray-900">{r.criterionName}</span>
                  <Pill tone={r.result === "pass" ? "green" : r.result === "partial" ? "amber" : "red"}>{r.result} {r.score}</Pill></div>
                <button className="mt-1 block text-left text-indigo-700 hover:underline" onClick={() => seek(r.evidenceStart)}>“{r.evidenceQuote}” @{r.evidenceStart?.toFixed?.(1)}s</button>
                {r.guidelineRef && <Link className="mt-0.5 inline-block text-[11px] text-gray-500 hover:text-indigo-700 hover:underline" href={`/guidelines/${r.guidelineRef.split(":")[0]}?section=${encodeURIComponent(r.guidelineRef)}`}>judged against § {r.guidelineRef.split(":").pop()}</Link>}
              </div>))}
            {!c.results?.length && <p className="text-xs text-gray-500">Analysis pending… status: {rerunning ? "analyzing" : c.status}</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
