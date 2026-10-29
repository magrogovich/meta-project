import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, API } from "../lib/api";
import { useState } from "react";
import { Link } from "wouter";
import { Plus, Upload, LayoutGrid, Table2, Eye, EyeOff, Copy, Check, Download, Mail, X } from "lucide-react";
import { Card, CardHeader, Pill, scoreTone, EmptyState } from "../components/ui";

const LANGS = ["en", "fr", "de", "es"];
const LANG_NAME: Record<string, string> = { en: "English", fr: "French", de: "German", es: "Spanish" };

const agentTone = (s: string): "green" | "amber" | "red" | "gray" =>
  s === "online" ? "green" : s === "offline" ? "amber" : "gray";
const coachTone = (s: string): "green" | "amber" | "red" | "gray" =>
  s === "on track" ? "green" : s === "watch" ? "amber" : s === "needs coaching" ? "red" : "gray";

function KeyField({ value, employeeId, onLogged }: { value: string; employeeId: string; onLogged?: () => void }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    api(`/api/employees/${employeeId}/key/copied`, { method: "POST" }).catch(() => {});
    onLogged?.();
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div>
      <div className="flex gap-2">
        <input className="input font-mono" readOnly type={show ? "text" : "password"} value={value} />
        <button className="btn-outline shrink-0" title={show ? "Hide" : "Reveal"} onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <button className="btn-outline shrink-0" onClick={copy}>
          {copied ? <><Check className="h-4 w-4 text-emerald-600" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-400">Masked by default. Every reveal and copy is logged in the audit trail.</p>
    </div>
  );
}

function Wizard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ name: "", department: "Support", languages: ["en"] as string[], photo: "" });
  const [newDept, setNewDept] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string; sessionKey: string } | null>(null);
  const { data: depts } = useQuery({ queryKey: ["depts"], queryFn: () => api("/api/departments") });
  const deptNames = [...new Set([...((depts as any[]) || []).map((d) => d.name), form.department])];

  const toggleLang = (l: string) =>
    setForm({ ...form, languages: form.languages.includes(l) ? form.languages.filter((x) => x !== l) : [...form.languages, l] });

  const create = useMutation({
    mutationFn: () => api("/api/employees", {
      method: "POST",
      body: JSON.stringify({ ...form, department: newDept.trim() || form.department, languages: form.languages.length ? form.languages : ["en"] }),
    }),
    onSuccess: (r) => { setCreated({ id: r.employee.id, name: r.employee.name, sessionKey: r.sessionKey }); qc.invalidateQueries({ queryKey: ["emp-table"] }); qc.invalidateQueries({ queryKey: ["emps"] }); setStep(2); },
  });

  const onPhoto = (f: File | undefined) => {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setForm({ ...form, photo: String(rd.result || "") });
    rd.readAsDataURL(f);
  };

  const downloadConfig = () => {
    if (!created) return;
    const blob = new Blob([JSON.stringify({ apiUrl: API || location.origin, sessionKey: created.sessionKey, employee: created.name }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "arocall-agent-config.json"; a.click();
    URL.revokeObjectURL(a.href);
  };
  const mailto = created
    ? `mailto:?subject=${encodeURIComponent(`Arocall desktop agent setup for ${created.name}`)}&body=${encodeURIComponent(`Hi ${created.name},\n\nInstall the Arocall desktop agent, then paste this session key when asked:\n\n${created.sessionKey}\n\nSteps:\n1. Run the installer (see agent/README.md)\n2. Paste the key at first run\n3. Make a test call — it will appear on your profile\n\nThe app shows a recording indicator while a call is active.`)}`
    : "#";

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/40">
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Add employee {step === 1 ? "(1/2 details)" : "(2/2 connect agent)"}</h2>
            <p className="text-xs text-gray-500">{step === 1 ? "Who is joining?" : "Connect the desktop agent"}</p>
          </div>
          <button className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100" onClick={onDone}><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {step === 1 && (
            <>
              <div><label className="text-[11px] font-semibold text-gray-500">Name *</label>
                <input className="input mt-1" placeholder="Jane Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><label className="text-[11px] font-semibold text-gray-500">Photo</label>
                <div className="mt-1 flex items-center gap-3">
                  {form.photo ? <img src={form.photo} className="h-10 w-10 rounded-full object-cover" alt="" /> : <div className="grid h-10 w-10 place-items-center rounded-full bg-gray-100 text-sm font-bold text-gray-500">{form.name[0]?.toUpperCase() || "?"}</div>}
                  <input type="file" accept="image/*" className="text-xs text-gray-500" onChange={(e) => onPhoto(e.target.files?.[0])} />
                </div></div>
              <div><label className="text-[11px] font-semibold text-gray-500">Department</label>
                <select className="input mt-1" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                  {deptNames.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input className="input mt-2" placeholder="…or create new department" value={newDept} onChange={(e) => setNewDept(e.target.value)} /></div>
              <div><label className="text-[11px] font-semibold text-gray-500">Languages worked</label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {allowedLangs.map((l: string) => (
                    <button key={l} type="button" onClick={() => toggleLang(l)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${form.languages.includes(l) ? "bg-gray-900 text-white ring-gray-900" : "bg-white text-gray-600 ring-gray-200 hover:ring-gray-400"}`}>
                      {LANG_NAME[l]}
                    </button>))}
                </div></div>
            </>
          )}
          {step === 2 && created && (
            <>
              <p className="text-xs text-gray-600">Paste this key into the desktop agent at first run. Unlike the old flow, this key is <b>persistent</b> — you can reveal it again later from the employee's Agent tab.</p>
              <KeyField value={created.sessionKey} employeeId={created.id} />
              <div className="flex flex-wrap gap-2">
                <button className="btn-outline" onClick={downloadConfig}><Download className="h-3.5 w-3.5" /> Download connection file</button>
                <a className="btn-outline" href={mailto}><Mail className="h-3.5 w-3.5" /> Email setup instructions</a>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                <b>Install:</b> 1) Install the agent (see <code>agent/README.md</code>) — or drop the downloaded <code>arocall-agent-config.json</code> next to it.
                2) Run setup and paste the key. 3) Make a test call; it appears on the profile once analyzed.
              </div>
            </>
          )}
          {step === 3 && (
            <EmptyState title={`${created?.name} added`} hint="They appear below with status “Waiting for first call” until the agent uploads." action={<button className="btn" onClick={onDone}>Done</button>} />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4">
          {step === 1 && <button className="btn" disabled={!form.name.trim()} onClick={() => create.mutate()}>Create & continue →</button>}
          {step === 2 && <button className="btn" onClick={() => setStep(3)}>Done</button>}
        </div>
      </div>
    </div>
  );
}

function CsvImport({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<{ created: { name: string; sessionKey: string }[]; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const token = localStorage.getItem("token");
      const r = await fetch(`${API}/api/employees/import`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
      setResult(await r.json());
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold text-gray-900">CSV import <span className="font-normal text-gray-500">header: <code>name,department,languages</code> (languages separated by ; — max 50 rows)</span></p>
      <input type="file" accept=".csv,text/csv" disabled={busy} className="mt-2 text-xs text-gray-500" onChange={(e) => run(e.target.files?.[0])} />
      {result && (
        <div className="mt-2 text-xs">
          <p className="font-semibold text-emerald-700">{result.created.length} created (keys shown once — copy now):</p>
          <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {result.created.map((c) => <li key={c.name} className="break-all rounded bg-gray-50 p-1.5 font-mono">{c.name}: {c.sessionKey}</li>)}
          </ul>
          {!!result.errors.length && <p className="mt-1 text-red-600">{result.errors.join("; ")}</p>}
        </div>
      )}
    </Card>
  );
}

export function Employees() {
  const qc = useQueryClient();
  const [view, setView] = useState<"table" | "cards">("table");
  const [f, setF] = useState({ q: "", dept: "", lang: "", status: "", agent: "" });
  const [wizard, setWizard] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, isLoading } = useQuery({ queryKey: ["emp-table", q], queryFn: () => api(`/api/employees/table?${q}`) });
  const { data: depts } = useQuery({ queryKey: ["depts"], queryFn: () => api("/api/departments") });
  const list: any[] = data || [];
  const refresh = () => { qc.invalidateQueries({ queryKey: ["emp-table"] }); qc.invalidateQueries({ queryKey: ["emps"] }); };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-gray-900">Employees</h1>
          <p className="text-xs text-gray-500">{list.length} total · keys are persistent and revealable</p>
        </div>
        <div className="flex gap-2">
          <button className={`btn-outline ${view === "table" ? "!bg-gray-900 !text-white" : ""}`} onClick={() => setView("table")}><Table2 className="h-4 w-4" /></button>
          <button className={`btn-outline ${view === "cards" ? "!bg-gray-900 !text-white" : ""}`} onClick={() => setView("cards")}><LayoutGrid className="h-4 w-4" /></button>
          <button className="btn-outline" onClick={() => setShowCsv((s) => !s)}><Upload className="h-3.5 w-3.5" /> CSV import</button>
          <button className="btn" onClick={() => setWizard(true)}><Plus className="h-4 w-4" /> Add employee</button>
        </div>
      </div>

      {showCsv && <CsvImport onDone={refresh} />}

      <Card className="flex flex-wrap items-end gap-2 p-3">
        <div className="min-w-40 flex-1"><label className="text-[11px] font-semibold text-gray-500">Search</label>
          <input className="input mt-1" placeholder="name…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Department</label>
          <select className="input mt-1 w-36" value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
            <option value="">all</option>{((depts as any[]) || []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Language</label>
          <select className="input mt-1 w-28" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}><option value="">all</option>{LANGS.map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Status</label>
          <select className="input mt-1 w-28" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">all</option><option value="active">active</option><option value="inactive">inactive</option></select></div>
        <div><label className="text-[11px] font-semibold text-gray-500">Agent</label>
          <select className="input mt-1 w-32" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}><option value="">all</option><option value="online">online</option><option value="offline">offline</option><option value="never">never</option></select></div>
      </Card>

      {isLoading ? <p className="text-xs text-gray-500">Loading…</p> : !list.length ? (
        <EmptyState title="No employees match" hint="Adjust filters, import a CSV, or add your first employee." action={<button className="btn" onClick={() => setWizard(true)}>Add employee</button>} />
      ) : view === "cards" ? (
        <div className="grid gap-3 md:grid-cols-3">
          {list.map((e: any) => (
            <Link key={e.id} href={`/employees/${e.id}`} className="card p-4 hover:shadow">
              <div className="flex items-center gap-3">
                {e.photo ? <img src={e.photo} className="h-12 w-12 rounded-full object-cover" alt="" /> : <div className="grid h-12 w-12 place-items-center rounded-full bg-gray-900 font-bold text-white">{e.name[0]}</div>}
                <div className="min-w-0"><div className="truncate font-semibold text-gray-900">{e.name}</div>
                  <div className="truncate text-xs text-gray-500">{e.department} · {(e.languages || []).join(", ")}</div></div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Pill tone={scoreTone(e.overallScore || 0)}>{e.overallScore ?? "—"}</Pill>
                <Pill tone={agentTone(e.agentStatus)}>{e.callsThisPeriod === 0 ? "Waiting for first call" : `agent ${e.agentStatus}`}</Pill>
              </div>
            </Link>))}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100">
                <th className="table-head px-4 py-2">Employee</th><th className="table-head px-2 py-2">Dept</th>
                <th className="table-head px-2 py-2">Langs</th><th className="table-head px-2 py-2 text-right">Score</th>
                <th className="table-head px-2 py-2 text-right">Trend</th><th className="table-head px-2 py-2 text-right">Calls</th>
                <th className="table-head px-2 py-2">Last call</th><th className="table-head px-2 py-2">Agent</th>
                <th className="table-head px-2 py-2">Coaching</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((e: any) => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <Link href={`/employees/${e.id}`} className="flex items-center gap-2 font-medium text-gray-900 hover:underline">
                        {e.photo ? <img src={e.photo} className="h-7 w-7 rounded-full object-cover" alt="" /> : <span className="grid h-7 w-7 place-items-center rounded-full bg-gray-900 text-[11px] font-bold text-white">{e.name[0]}</span>}
                        {e.name}
                      </Link></td>
                    <td className="px-2 py-2.5 text-gray-500">{e.department}</td>
                    <td className="px-2 py-2.5 text-gray-500">{(e.languages || []).join(", ")}</td>
                    <td className="px-2 py-2.5 text-right"><Pill tone={scoreTone(e.overallScore || 0)}>{e.overallScore ?? "No data yet"}</Pill></td>
                    <td className="px-2 py-2.5 text-right text-gray-600">{e.trend > 0 ? `↗ +${e.trend}` : e.trend < 0 ? `↘ ${e.trend}` : "→"}</td>
                    <td className="px-2 py-2.5 text-right text-gray-600">{e.callsThisPeriod}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-gray-500">{e.lastCall ? new Date(e.lastCall).toLocaleDateString() : "—"}</td>
                    <td className="px-2 py-2.5"><Pill tone={agentTone(e.agentStatus)}>{e.callsThisPeriod === 0 && e.agentStatus === "never" ? "Waiting for first call" : e.agentStatus}</Pill></td>
                    <td className="px-2 py-2.5"><Pill tone={coachTone(e.coachingStatus)}>{e.coachingStatus}</Pill></td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {wizard && <Wizard onDone={() => { setWizard(false); refresh(); }} />}
    </div>
  );
}
