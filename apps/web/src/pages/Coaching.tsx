import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { FileText, Mic, Check, Trash2, Copy } from "lucide-react";
import { Card, CardHeader, Pill, scoreTone, EmptyState } from "../components/ui";
import { CoachDialog } from "./Employee";

const TABS = ["Queue", "Memos", "AI sessions", "Action items"] as const;

export function Coaching() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Queue");
  const [coachFor, setCoachFor] = useState<{ id: string; name: string; email?: string } | null>(null);
  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Coaching</h1>
        <p className="text-xs text-gray-500">Who needs help, and what happened after.</p>
      </div>
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}>{t}</button>))}
      </div>
      {tab === "Queue" && <QueueTab onCoach={setCoachFor} />}
      {tab === "Memos" && <MemosTab />}
      {tab === "AI sessions" && <SessionsTab />}
      {tab === "Action items" && <ActionsTab />}
      {coachFor && <CoachDialog employeeId={coachFor.id} employeeName={coachFor.name} employeeEmail={coachFor.email} onClose={() => setCoachFor(null)} />}
    </div>
  );
}

function QueueTab({ onCoach }: { onCoach: (e: { id: string; name: string; email?: string }) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["queue"], queryFn: () => api("/api/coaching/queue") });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const emailOf = (id: string) => ((emps as any[]) || []).find((e) => e.id === id)?.email || "";
  const genMemo = useMutation({
    mutationFn: (employeeId: string) => api("/api/memos/generate", { method: "POST", body: JSON.stringify({ employeeId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memos"] }),
  });
  const [memoMade, setMemoMade] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (isLoading) return <p className="text-xs text-gray-500">Loading…</p>;
  return (
    <Card>
      <CardHeader
        title="Needs coaching"
        sub={`Rules: score below ${data.rules.scoreBelow}, drop ≥ ${data.rules.dropPoints} pts, or ≥ ${data.rules.criticalCount} critical fails. "Generate memo" saves a point-in-time performance snapshot (see Memos tab). "Start session" opens a live AI coaching session.`}
      />
      {!data.queue.length ? <div className="p-4"><EmptyState title="Queue is clear" hint="No employee currently matches the coaching rules (tune them in Settings)." /></div> : (
        <ul className="divide-y divide-gray-100">
          {data.queue.map((q: any) => (
            <li key={q.employeeId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link href={`/employees/${q.employeeId}`} className="min-w-40 flex-1 text-xs font-semibold text-gray-900 hover:underline">{q.name} <span className="font-normal text-gray-400">· {q.department}</span></Link>
              <Pill tone={scoreTone(q.score)}>{q.score}</Pill>
              <span className="w-full text-xs text-gray-500 sm:w-auto">{q.reasons.join(" · ")}</span>
              <span className="ml-auto flex gap-2">
                <button
                  className="btn-outline"
                  title="Save a performance snapshot for this employee (view it under Memos). One click = one memo."
                  disabled={genMemo.isPending && busyId === q.employeeId}
                  onClick={async () => { setBusyId(q.employeeId); try { await genMemo.mutateAsync(q.employeeId); setMemoMade(q.name); setTimeout(() => setMemoMade(null), 3000); } finally { setBusyId(null); } }}>
                  <FileText className="h-3.5 w-3.5" /> {genMemo.isPending && busyId === q.employeeId ? "Generating…" : "Generate memo"}
                </button>
                <button className="btn" onClick={() => onCoach({ id: q.employeeId, name: q.name, email: emailOf(q.employeeId) })}><Mic className="h-3.5 w-3.5" /> Start session</button>
              </span>
            </li>))}
        </ul>)}
      {memoMade && <p className="border-t border-gray-100 px-4 py-2 text-xs text-emerald-700">Memo generated for {memoMade} — see the Memos tab.</p>}
    </Card>
  );
}

function MemosTab() {
  const { data } = useQuery({ queryKey: ["memos"], queryFn: () => api("/api/memos") });
  const list: any[] = data || [];
  return (
    <Card>
      <CardHeader
        title="Memos"
        sub="Point-in-time performance snapshots — one memo = one report (period, call count, average score, top issues, practice plan). Generating twice creates two separate reports; open one to read the full detail."
      />
      {!list.length ? <div className="p-4"><EmptyState title="No memos yet" hint="Generate one from the queue or an employee's Coaching tab — one click creates one snapshot." /></div> : (
        <ul className="divide-y divide-gray-100">
          {list.map((m: any) => {
            const c = m.content || {};
            return (
              <li key={m.id} className="space-y-1.5 px-4 py-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/employees/${m.employeeId}`} className="font-semibold text-gray-900 hover:underline">{c.employee}</Link>
                  <Pill tone="gray">{c.period}</Pill>
                  <Pill tone="gray">{c.callCount ?? 0} calls</Pill>
                  {c.avgScore != null && <Pill tone={scoreTone(c.avgScore)}>{c.avgScore}</Pill>}
                  <span className="ml-auto text-gray-400">{new Date(m.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="text-gray-700"><span className="font-semibold text-gray-900">Summary: </span>{c.summary}</p>
                {!!(c.topIssues || []).length && (
                  <p className="text-gray-600"><span className="font-semibold text-gray-900">Top issues: </span>{(c.topIssues as any[]).map((t: any) => t.text || t).join(" · ")}</p>
                )}
                {!!(c.actionPlan || []).length && (
                  <p className="text-gray-600"><span className="font-semibold text-gray-900">Plan: </span>{(c.actionPlan as string[]).join(" · ")}</p>
                )}
                {!!(c.phrases || []).length && (
                  <p className="text-gray-500"><span className="font-semibold">Try saying: </span>{(c.phrases as string[]).map((p) => `“${p}”`).join(" · ")}</p>
                )}
              </li>
            );
          })}
        </ul>)}
    </Card>
  );
}

function SessionsTab() {
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: () => api("/api/coaching/sessions") });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const name = (id: string) => ((emps as any[]) || []).find((e) => e.id === id)?.name || "—";
  const list: any[] = data || [];
  const toneFor = (s: string) => s === "live" ? "green" : s === "waiting_for_employee" ? "amber" : s === "scheduled" ? "indigo" : s === "ended" ? "gray" : "red";
  return (
    <Card>
      <CardHeader title="AI sessions" sub={`${list.length} total — newest first. Each row is one coaching session: who, when, status, and outcome.`} />
      {!list.length ? <div className="p-4"><EmptyState title="No sessions yet" hint="Start one from the queue or an employee profile." /></div> : (
        <ul className="divide-y divide-gray-100">
          {list.map((x: any) => (
            <li key={x.id} className="space-y-1.5 px-4 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/employees/${x.employeeId}`} className="font-semibold text-gray-900 hover:underline">{name(x.employeeId)}</Link>
                <Pill tone={toneFor(x.status) as any}>{x.status === "waiting_for_employee" ? "waiting for employee" : x.status}</Pill>
                {x.humanFlag && <Pill tone="amber">human requested</Pill>}
                <span className="ml-auto text-gray-400">{new Date(x.createdAt).toLocaleString()}</span>
              </div>
              <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                <p className="text-gray-600"><span className="font-semibold text-gray-900">Topics: </span>{x.topics || "—"}</p>
                <p className="text-gray-600"><span className="font-semibold text-gray-900">Invite: </span>{x.inviteEmail ? `${x.inviteEmail} ${x.inviteSentAt ? "(sent)" : "(not sent)"}` : "—"}</p>
              </div>
              {x.summary ? <p className="text-gray-600"><span className="font-semibold text-gray-900">Summary: </span>{x.summary}</p> : null}
              {!!(x.actionItems || []).length && <p className="text-gray-600"><span className="font-semibold text-gray-900">Agreed: </span>{(x.actionItems as string[]).join(" · ")}</p>}
              {x.meetError ? <p className="font-semibold text-red-600">Meet error: {x.meetError}</p> : null}
              <div>
                <Link href={`/coach-room/${x.id}`} className="font-semibold text-indigo-700 hover:underline">Open session monitor →</Link>
              </div>
            </li>))}
        </ul>)}
    </Card>
  );
}

function ActionsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["actions"], queryFn: () => api("/api/coaching/actions") });
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const name = (id: string) => ((emps as any[]) || []).find((e) => e.id === id)?.name || "—";
  const inv = () => qc.invalidateQueries({ queryKey: ["actions"] });
  const toggle = useMutation({ mutationFn: (a: any) => api(`/api/coaching/actions/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: a.status === "done" ? "open" : "done" }) }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/coaching/actions/${id}`, { method: "DELETE" }), onSuccess: inv });
  const list: any[] = data || [];
  const open = list.filter((a) => a.status !== "done").length;
  const byEmp: Record<string, any[]> = {};
  for (const a of list) (byEmp[a.employeeId] = byEmp[a.employeeId] || []).push(a);
  const sourceHint = (s: string) => s === "coach" ? "agreed in an AI session" : s === "manual" ? "added by hand" : `from ${s}`;
  return (
    <Card>
      <CardHeader
        title="Action items"
        sub="Concrete follow-ups per employee. “Coach” = agreed at the end of an AI session; “manual” = typed in by you. Tick the box when done, trash to delete."
      />
      {!list.length ? <div className="p-4"><EmptyState title="No action items" hint="They appear here after an AI session ends, or add one by hand on the employee's Coaching tab." /></div> : (
        <div className="divide-y divide-gray-100">
          {Object.entries(byEmp).map(([empId, items]) => (
            <div key={empId} className="px-4 py-2">
              <Link href={`/employees/${empId}`} className="text-xs font-bold text-gray-900 hover:underline">{name(empId)} <span className="font-normal text-gray-400">· {items.filter((a) => a.status !== "done").length} open</span></Link>
              <ul className="mt-1 divide-y divide-gray-50">
                {items.map((a: any) => (
                  <li key={a.id} className="flex items-center gap-2 py-2 text-xs">
                    <button
                      title={a.status === "done" ? "Mark as not done" : "Mark as done"}
                      onClick={() => toggle.mutate(a)}
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${a.status === "done" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 hover:border-gray-500"}`}>
                      {a.status === "done" && <Check className="h-3 w-3" />}
                    </button>
                    <span className={`flex-1 ${a.status === "done" ? "text-gray-400 line-through" : "text-gray-700"}`}>{a.text}</span>
                    <span title={sourceHint(a.source)}><Pill tone="gray">{a.source}</Pill></span>
                    <button title="Delete this item" className="shrink-0 text-gray-400 hover:text-red-600" onClick={() => del.mutate(a.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="px-4 py-2 text-[11px] text-gray-400">{open} open · {list.length - open} done</p>
        </div>)}
    </Card>
  );
}

export function CopyMeet({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <button
      className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:underline"
      onClick={() => { navigator.clipboard.writeText(url).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
      {copied ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy Meet link</>}
    </button>
  );
}
