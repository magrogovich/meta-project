import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, scoreColor, authHeader, API } from "../lib/api";
import { useState, useRef } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { Trend } from "./Dashboard";

export function EmployeeProfile() {
  const [, params] = useRoute("/employees/:id");
  const id = params?.id || "";
  const [, nav] = useLocation();
  const [f, setF] = useState({ from: "", to: "", lang: "", min: "", max: "" });
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading } = useQuery({ queryKey: ["profile", id, q], queryFn: () => api(`/api/employees/${id}/profile?${q}`) });
  const qc = useQueryClient();
  const [regen, setRegen] = useState("");
  const [memo, setMemo] = useState<any>(null);
  const regenKey = useMutation({ mutationFn: () => api(`/api/employees/${id}/key`, { method: "POST" }), onSuccess: (r) => setRegen(r.sessionKey) });
  const genMemo = useMutation({ mutationFn: () => api("/api/memos/generate", { method: "POST", body: JSON.stringify({ employeeId: id, from: f.from, to: f.to }) }), onSuccess: setMemo });
  const [coachTopics, setCoachTopics] = useState("");
  const startCoach = useMutation({ mutationFn: () => api("/api/coach", { method: "POST", body: JSON.stringify({ employeeId: id, topics: coachTopics }) }), onSuccess: (r) => nav(`/coach/${r.id}?token=${r.token}`) });
  if (isLoading) return <p className="p-6">Loading…</p>;
  if (!data) return <p className="p-6">Not found</p>;
  const e = data.employee;
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href="/" className="text-sm underline">← Employees</Link>
      <div className="card p-6 mt-2 flex flex-wrap gap-6 items-center">
        <div className="w-20 h-20 rounded-full bg-cyan-100 grid place-items-center text-3xl font-bold text-cyan-800">{e.name[0]}</div>
        <div className="flex-1 min-w-60">
          <h1 className="text-2xl font-bold">{e.name}</h1>
          <p className="text-sm text-slate-500">{e.department} · {(e.languages || []).join(", ")}</p>
          <p className="text-sm mt-1">Strengths: {data.strengths?.join("; ") || "—"}<br />Weaknesses: {data.weaknesses?.join("; ") || "—"}</p>
        </div>
        <div><span className={`badge text-lg ${scoreColor(e.overallScore)}`}>{e.overallScore}</span><div className="mt-2"><Trend points={data.trend} /></div></div>
      </div>
      <div className="card p-4 mt-4 flex flex-wrap gap-2 items-end text-sm">
        <input className="input max-w-40" type="date" value={f.from} onChange={(ev) => setF({ ...f, from: ev.target.value })} />
        <input className="input max-w-40" type="date" value={f.to} onChange={(ev) => setF({ ...f, to: ev.target.value })} />
        <select className="input max-w-32" value={f.lang} onChange={(ev) => setF({ ...f, lang: ev.target.value })}><option value="">all lang</option><option>en</option><option>fr</option><option>de</option><option>es</option></select>
        <button className="btn-ghost" onClick={() => regenKey.mutate()}>Regenerate session key</button>
        <button className="btn-ghost" onClick={() => genMemo.mutate()}>Generate coaching memo</button>
        <input className="input max-w-52" placeholder="coach focus topics" value={coachTopics} onChange={(ev) => setCoachTopics(ev.target.value)} />
        <button className="btn" onClick={() => startCoach.mutate()}>Start AI coaching session</button>
      </div>
      {regen && <div className="card p-3 mt-2 text-sm">New key (shown once): <code className="break-all">{regen}</code></div>}
      {memo && <MemoCard memo={memo} />}
      <div className="card mt-4 overflow-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500 border-b"><th className="p-2">Date</th><th>Dur</th><th>Lang</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>{data.calls.map((c: any) => (
            <tr key={c.id} className="border-b hover:bg-slate-50"><td className="p-2"><Link className="underline" href={`/calls/${c.id}`}>{new Date(c.startedAt).toLocaleString()}</Link></td>
            <td>{c.durationSec}s</td><td>{c.language}</td><td><span className={`badge ${scoreColor(c.score)}`}>{c.score}</span></td><td>{c.status}</td></tr>))}
          </tbody>
        </table>
        {!data.calls.length && <p className="p-4 text-slate-500 text-sm">No calls in this filter — upload via the desktop agent or seed script.</p>}
      </div>
    </div>
  );
}

export function MemoCard({ memo }: { memo: any }) {
  const c = memo.content;
  return (
    <div className="card p-4 mt-2 text-sm" id="memo-print">
      <h3 className="font-bold">Coaching memo — {c.employee} ({c.period})</h3>
      <p className="mt-1">{c.summary}</p>
      <p className="mt-2"><b>Top issues:</b></p>
      <ul className="list-disc ml-5">{(c.topIssues || []).map((t: any, i: number) => <li key={i}>{t.text || t}</li>)}</ul>
      <p className="mt-2"><b>Action plan:</b></p>
      <ul className="list-disc ml-5">{(c.actionPlan || []).map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
      <p className="mt-2"><b>Practice phrases:</b></p>
      <ul className="list-disc ml-5">{(c.phrases || []).map((t: string, i: number) => <li key={i}><i>“{t}”</i></li>)}</ul>
      <button className="btn mt-3" onClick={() => window.print()}>Export PDF (print)</button>
    </div>
  );
}

export function CallDetail() {
  const [, params] = useRoute("/calls/:id");
  const id = params?.id || "";
  const audioRef = useRef<HTMLAudioElement>(null);
  const { data: c, isLoading, refetch } = useQuery({ queryKey: ["call", id], queryFn: () => api(`/api/calls/${id}`), refetchInterval: (q: any) => (["uploaded", "transcribing", "analyzing"].includes(q?.state?.data?.status) ? 2000 : false) });
  const [rerun, setRerun] = useState(false);
  if (isLoading) return <p className="p-6">Loading…</p>;
  const seek = (s: number) => { if (audioRef.current) { audioRef.current.currentTime = s; audioRef.current.play(); } };
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href={c ? `/employees/${c.employeeId}` : "/"} className="text-sm underline">← Back</Link>
      <div className="card p-4 mt-2">
        <div className="flex flex-wrap gap-3 items-center">
          <b>Call {id.slice(0, 8)}</b><span className="badge bg-slate-200">{c.status}</span>
          <span className={`badge ${scoreColor(c.score)}`}>{c.score}</span>
          <span className="text-sm text-slate-500">{c.language} · v{c.scorecardVersion} {rerun ? "" : ""}</span>
          <button className="btn-ghost text-sm" onClick={async () => { setRerun(true); await api(`/api/calls/${id}/rerun`, { method: "POST" }); setTimeout(() => refetch(), 2500); }}>Re-run analysis</button>
        </div>
        <audio ref={audioRef} controls className="w-full mt-3" src={`${API}/api/calls/audio/${c.audioFile}?t=${Date.now()}`} />
        <p className="text-sm mt-2">{c.summary}</p>
        <p className="text-xs text-slate-500">Went well: {(c.wentWell || []).join(" · ") || "—"}</p>
        <p className="text-xs text-slate-500">Went wrong: {(c.wentWrong || []).join(" · ") || "—"} · Tags: {(c.tags || []).join(", ")}</p>
      </div>
      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="card p-4">
          <h3 className="font-bold mb-2">Transcript (click a line to seek)</h3>
          {(c.transcript || []).map((l: any, i: number) => (
            <button key={i} onClick={() => seek(l.start)} className="block w-full text-left text-sm py-1 border-b border-slate-100 hover:bg-slate-50">
              <span className={`badge mr-2 ${l.speaker === "Agent" ? "bg-cyan-100 text-cyan-800" : "bg-slate-200"}`}>{l.speaker} {l.start.toFixed(1)}s</span>{l.text}
            </button>))}
        </div>
        <div className="card p-4">
          <h3 className="font-bold mb-2">AI report (evidence required per criterion)</h3>
          {(c.results || []).map((r: any) => (
            <div key={r.id} className="border-b py-2 text-sm">
              <div className="flex gap-2 items-center"><b>{r.criterionName}</b>
                <span className={`badge ${r.result === "pass" ? "bg-emerald-100 text-emerald-800" : r.result === "partial" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800"}`}>{r.result} {r.score}</span></div>
              <button className="text-cyan-700 underline text-left" onClick={() => seek(r.evidenceStart)}>“{r.evidenceQuote}” @{r.evidenceStart?.toFixed?.(1)}s</button>
            </div>))}
          {!c.results?.length && <p className="text-sm text-slate-500">Analysis pending… status: {c.status}</p>}
        </div>
      </div>
    </div>
  );
}
