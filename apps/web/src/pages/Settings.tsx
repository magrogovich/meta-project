import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useState } from "react";
import { Card, CardHeader, Pill, EmptyState } from "../components/ui";

const ALL_LANGS = ["en", "fr", "de", "es"];
const LANG_NAME: Record<string, string> = { en: "English", fr: "French", de: "German", es: "Spanish" };

export function Settings() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isAdmin = role !== "evaluator";
  const [tab, setTab] = useState("Organization");
  const tabs = ["Organization", "Team", "Departments", "Coaching rules", "Retention", "Audit log"];
  return (
    <div className="w-full space-y-4">
      <h1 className="text-lg font-bold tracking-tight text-gray-900">Settings</h1>
      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === t ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}>{t}</button>))}
      </div>
      {tab === "Organization" && <OrgTab isAdmin={isAdmin} refresh={() => qc.invalidateQueries({ queryKey: ["settings"] })} />}
      {tab === "Team" && <TeamTab isAdmin={isAdmin} />}
      {tab === "Departments" && <DeptTab isAdmin={isAdmin} />}
      {tab === "Coaching rules" && <RulesTab isAdmin={isAdmin} />}
      {tab === "Retention" && <RetentionTab isAdmin={isAdmin} />}
      {tab === "Audit log" && <AuditTab />}
    </div>
  );
}

function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api("/api/settings") });
}

function OrgTab({ isAdmin, refresh }: { isAdmin: boolean; refresh: () => void }) {
  const { data } = useSettings();
  const [name, setName] = useState("");
  const [init, setInit] = useState(false);
  if (data && !init) { setName(data.org.name); setInit(true); }
  const save = useMutation({
    mutationFn: () => api("/api/settings/org", { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: refresh,
  });
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold text-gray-900">Organization</p>
      <div className="mt-2 flex gap-2">
        <input className="input" value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
        {isAdmin && <button className="btn shrink-0" onClick={() => save.mutate()}>Save</button>}
      </div>
      {data && <p className="mt-2 text-xs text-gray-500">{data.counts.users} users · {data.counts.employees} employees · {data.counts.calls} calls</p>}
      {!isAdmin && <p className="mt-1 text-[11px] text-gray-400">Evaluators can view settings but not change them.</p>}
    </Card>
  );
}

function TeamTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: team } = useQuery({ queryKey: ["team"], queryFn: () => api("/api/settings/team") });
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<{ token: string } | null>(null);
  const send = useMutation({
    mutationFn: () => api("/api/auth/invite", { method: "POST", body: JSON.stringify({ email }) }),
    onSuccess: (r) => { setInvite(r); setEmail(""); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/settings/team/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
  return (
    <Card>
      <CardHeader title="Team" sub="admins manage everything · evaluators read + coach" />
      <ul className="divide-y divide-gray-100">
        {((team as any[]) || []).map((u: any) => (
          <li key={u.id} className="flex items-center gap-2 px-4 py-2.5 text-xs">
            <span className="flex-1 font-medium text-gray-900">{u.name} <span className="font-normal text-gray-400">· {u.email}</span></span>
            <Pill tone={u.role === "admin" ? "indigo" : "gray"}>{u.role}</Pill>
            {isAdmin && <button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm(`Remove ${u.email}?`)) remove.mutate(u.id); }}>Remove</button>}
          </li>))}
      </ul>
      {isAdmin && (
        <div className="border-t border-gray-100 p-4">
          <p className="text-xs font-semibold text-gray-900">Invite evaluator</p>
          <div className="mt-2 flex gap-2">
            <input className="input" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn shrink-0" disabled={!email.includes("@")} onClick={() => send.mutate()}>Invite</button>
          </div>
          {invite && <p className="mt-2 break-all rounded bg-gray-50 p-2 text-xs">Share this link: <code>{location.origin}/accept-invite?token={invite.token}</code></p>}
        </div>
      )}
    </Card>
  );
}

function DeptTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: depts } = useQuery({ queryKey: ["depts"], queryFn: () => api("/api/departments") });
  const { data: settings } = useSettings();
  const [name, setName] = useState("");
  const [langs, setLangs] = useState<string[] | null>(null);
  const cur = langs ?? settings?.org?.settings?.languages ?? ALL_LANGS;
  const add = useMutation({
    mutationFn: () => api("/api/departments", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["depts"] }); },
  });
  const rename = useMutation({
    mutationFn: (d: any) => {
      const next = prompt("Rename department", d.name);
      return next && next !== d.name ? api(`/api/departments/${d.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) }) : Promise.resolve(null);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["depts"] }),
  });
  const saveLangs = useMutation({
    mutationFn: () => api("/api/settings/preferences", { method: "PATCH", body: JSON.stringify({ languages: cur }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const toggle = (l: string) => setLangs(cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Departments" sub="renaming updates all employees" />
        <ul className="divide-y divide-gray-100">
          {((depts as any[]) || []).map((d: any) => (
            <li key={d.id} className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-gray-800">
              <span className="flex-1">{d.name}</span>
              {isAdmin && <button className="text-indigo-700 hover:underline" onClick={() => rename.mutate(d)}>Rename</button>}
            </li>))}
        </ul>
        {isAdmin && (
          <div className="flex gap-2 border-t border-gray-100 p-4">
            <input className="input" placeholder="New department…" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn shrink-0" disabled={!name.trim()} onClick={() => add.mutate()}>Add</button>
          </div>
        )}
      </Card>
      <Card className="p-4">
        <p className="text-xs font-semibold text-gray-900">Languages offered</p>
        <p className="text-[11px] text-gray-500">Used in employee forms and filters.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ALL_LANGS.map((l) => (
            <button key={l} disabled={!isAdmin} onClick={() => toggle(l)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${cur.includes(l) ? "bg-gray-900 text-white ring-gray-900" : "bg-white text-gray-500 ring-gray-200"}`}>{LANG_NAME[l]}</button>))}
        </div>
        {isAdmin && <button className="btn mt-3" onClick={() => saveLangs.mutate()}>Save languages</button>}
      </Card>
    </div>
  );
}

function RulesTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: () => api("/api/coaching/rules") });
  const [f, setF] = useState({ scoreBelow: 70, dropPoints: 10, criticalCount: 3 });
  const [init, setInit] = useState(false);
  if (rules && !init) { setF(rules); setInit(true); }
  const save = useMutation({
    mutationFn: () => api("/api/coaching/rules", { method: "PATCH", body: JSON.stringify(f) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rules"] }); qc.invalidateQueries({ queryKey: ["queue"] }); },
  });
  return (
    <Card className="space-y-3 p-4">
      <p className="text-xs font-semibold text-gray-900">Coaching rules</p>
      <p className="text-[11px] text-gray-500">Shared by the Coaching queue and the dashboard "Needing coaching" card.</p>
      {[
        ["scoreBelow", "Flag score below"],
        ["dropPoints", "Flag drop of (points)"],
        ["criticalCount", "Flag repeated critical failures (count)"],
      ].map(([k, label]) => (
        <div key={k} className="flex items-center gap-2">
          <label className="w-56 text-xs text-gray-600">{label}</label>
          <input className="input w-28" type="number" disabled={!isAdmin} value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
        </div>))}
      {isAdmin && <button className="btn" onClick={() => save.mutate()}>Save rules</button>}
    </Card>
  );
}

function RetentionTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [days, setDays] = useState<number>(0);
  const [init, setInit] = useState(false);
  const cur = settings?.org?.settings?.retentionDays ?? 0;
  if (!init && settings) { setDays(cur); setInit(true); }
  const [msg, setMsg] = useState("");
  const save = useMutation({
    mutationFn: () => api("/api/settings/preferences", { method: "PATCH", body: JSON.stringify({ retentionDays: days }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const run = useMutation({
    mutationFn: () => api("/api/settings/retention/run", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r) => setMsg(`Deleted ${r.deleted} calls (and their reports) older than the window.`),
  });
  return (
    <Card className="space-y-3 p-4">
      <p className="text-xs font-semibold text-gray-900">Data retention</p>
      <p className="text-[11px] text-gray-500">Calls older than this are permanently deletable. 0 = keep forever.</p>
      <div className="flex items-center gap-2">
        <input className="input w-28" type="number" min={0} disabled={!isAdmin} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        <span className="text-xs text-gray-500">days</span>
        {isAdmin && <button className="btn" onClick={() => save.mutate()}>Save</button>}
      </div>
      {isAdmin && (
        <div>
          <button className="btn-outline !text-red-600" disabled={!cur} onClick={() => { if (confirm(`Delete all calls older than ${cur} days? This cannot be undone.`)) run.mutate(); }}>Run retention cleanup now</button>
          {msg && <p className="mt-1 text-xs text-gray-600">{msg}</p>}
        </div>
      )}
      <p className="text-[11px] text-gray-400">To wipe one person entirely, delete them from the Employees page (removes calls, reports, memos, sessions, keys).</p>
    </Card>
  );
}

function AuditTab() {
  const { data } = useQuery({ queryKey: ["audit"], queryFn: () => api("/api/settings/audit") });
  const list: any[] = data || [];
  return (
    <Card>
      <CardHeader title="Audit log" sub="key reveals/copies, views, cleanup runs" />
      {!list.length ? <div className="p-4"><EmptyState title="Nothing logged yet" hint="Reveal a session key or play a call to create entries." /></div> : (
        <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto">
          {list.map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
              <Pill tone="gray">{r.action}</Pill>
              <span className="text-gray-700">{r.userLabel}</span>
              {r.targetLabel && <span className="text-gray-400">→ {r.targetLabel}</span>}
              <span className="ml-auto text-gray-400">{new Date(r.createdAt).toLocaleString()}</span>
            </li>))}
        </ul>)}
    </Card>
  );
}

export function AcceptInvite() {
  const token = new URLSearchParams(location.search).get("token") || "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    setErr("");
    try {
      const r = await api("/api/auth/accept-invite", { method: "POST", body: JSON.stringify({ token, email, password, name }) });
      localStorage.setItem("token", r.token);
      location.href = "/";
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-gray-50 p-6 text-[13px]">
      <div className="card w-full max-w-md p-8">
        <h1 className="text-lg font-bold text-gray-900">Accept evaluator invite</h1>
        <input className="input mt-4" placeholder="email (must match invite)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input mt-2" placeholder="display name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input mt-2" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
        {done && <p className="mt-2 text-xs text-emerald-700">{done}</p>}
        <button className="btn mt-4 w-full" onClick={go}>Join workspace</button>
      </div>
    </div>
  );
}
