import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useEffect, useRef } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useAuth } from "../lib/auth";
import { ArrowLeft, Upload, PenLine, Eye, History, RotateCcw, Trash2, Archive, CheckCircle, Wand2, Save, ListPlus } from "lucide-react";
import { Card, CardHeader, Pill, EmptyState, DateField } from "../components/ui";
import { renderMarkdown, diffLines, addSectionIds } from "../lib/markdown";

const STARTER = `# Call Handling Guidelines

## Greeting
- Greet the customer within the first 30 seconds.
- State your name and the company, and offer help.

## Identification and compliance
- Verify the caller's identity before sharing account details.
- Never promise refunds, timelines, or outcomes you cannot guarantee.
- Follow consent and recording-notice policy on every call.

## Tone and empathy
- Acknowledge feelings explicitly ("I understand how frustrating this is").
- Do not interrupt. Let the customer finish before responding.

## Do's
- Summarize what was agreed before closing.
- State a clear next step with a timeline.

## Don'ts
- Don't blame the customer or other teams.
- Don't invent policy details — say you will check and follow up.

## Escalation
- Offer a supervisor or callback when the issue cannot be resolved in one call.
- Flag harassment, health, or safety concerns to a human evaluator.

## Closing
- Ask "Is there anything else I can help with today?"
- Thank the customer and close politely.
`;

function statusTone(s: string): "green" | "amber" | "gray" {
  return s === "active" ? "green" : s === "draft" ? "amber" : "gray";
}

// ---------- editor ----------
function toolbar(md: string, setMd: (v: string) => void, taRef: React.RefObject<HTMLTextAreaElement | null>, kind: string) {
  const ta = taRef.current;
  const sel = ta ? { s: ta.selectionStart, e: ta.selectionEnd } : { s: md.length, e: md.length };
  const before = md.slice(0, sel.s), mid = md.slice(sel.s, sel.e) || "text", after = md.slice(sel.e);
  const lineStart = before.lastIndexOf("\n") + 1;
  let out = md;
  if (kind === "h") out = `${before.slice(0, lineStart)}## ${before.slice(lineStart)}${mid}${after}`;
  else if (kind === "b") out = `${before}**${mid}**${after}`;
  else if (kind === "i") out = `${before}*${mid}*${after}`;
  else if (kind === "ul") out = `${before.slice(0, lineStart)}- ${before.slice(lineStart)}${mid}${after}`;
  else if (kind === "ol") out = `${before.slice(0, lineStart)}1. ${before.slice(lineStart)}${mid}${after}`;
  else if (kind === "link") out = `${before}[${mid}](https://)${after}`;
  else if (kind === "table") out = `${before}\n\n| Col A | Col B |\n| --- | --- |\n| a | b |\n${after}`;
  else out = `${before}\`${mid}\`${after}`;
  setMd(out);
}

function EditorPane({ title, setTitle, markdown, setMarkdown, onSave, onCancel, saving, draftKey }: {
  title: string; setTitle: (v: string) => void; markdown: string; setMarkdown: (v: string) => void;
  onSave: () => void; onCancel: () => void; saving: boolean; draftKey: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [mobileTab, setMobileTab] = useState<"write" | "preview">("write");
  const [dirty, setDirty] = useState(false);
  // local autosave
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) { const d = JSON.parse(raw); if (d.markdown && !markdown) { setMarkdown(d.markdown); if (d.title && !title) setTitle(d.title); } }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    if (dirty) { try { localStorage.setItem(draftKey, JSON.stringify({ title, markdown, at: Date.now() })); } catch {} }
  }, [title, markdown, dirty, draftKey]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty ]);
  const edit = (v: string) => { setMarkdown(v); setDirty(true); };
  const tools: { k: string; label: string; title: string }[] = [
    { k: "h", label: "H", title: "Heading" }, { k: "b", label: "B", title: "Bold" },
    { k: "i", label: "I", title: "Italic" }, { k: "ul", label: "• List", title: "Bullet list" },
    { k: "ol", label: "1. List", title: "Numbered list" }, { k: "link", label: "Link", title: "Link" },
    { k: "table", label: "Table", title: "Table" },
  ];
  return (
    <div className="space-y-3">
      <div><label className="text-[11px] font-semibold text-gray-500">Title</label>
        <input className="input mt-1" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} placeholder="Document title" /></div>
      <div className="flex flex-wrap gap-1">
        {tools.map((t) => <button key={t.k} type="button" title={t.title} className="btn-outline !px-2 !py-1 !text-[11px] font-bold" onClick={() => { toolbar(markdown, edit, taRef, t.k); setDirty(true); }}>{t.label}</button>)}
        <span className="ml-auto flex gap-1 md:hidden">
          <button type="button" className={`btn-outline !px-2 !py-1 ${mobileTab === "write" ? "!bg-gray-900 !text-white" : ""}`} onClick={() => setMobileTab("write")}>Write</button>
          <button type="button" className={`btn-outline !px-2 !py-1 ${mobileTab === "preview" ? "!bg-gray-900 !text-white" : ""}`} onClick={() => setMobileTab("preview")}>Preview</button>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <textarea ref={taRef} value={markdown} onChange={(e) => edit(e.target.value)}
          className={`input h-[420px] font-mono !text-xs leading-relaxed ${mobileTab === "preview" ? "hidden md:block" : ""}`} spellCheck={false} />
        <div className={`prose-sm max-w-none overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 text-xs text-gray-800 ${mobileTab === "write" ? "hidden md:block" : ""}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} />
      </div>
      {dirty && <p className="text-[11px] text-amber-600">Unsaved changes (draft autosaved locally).</p>}
      <div className="flex justify-end gap-2">
        <button className="btn-outline" onClick={() => { if (!dirty || confirm("Discard unsaved changes?")) { try { localStorage.removeItem(draftKey); } catch {} onCancel(); } }}>Cancel</button>
        <button className="btn" disabled={saving || !title.trim() || !markdown.trim()} onClick={() => { try { localStorage.removeItem(draftKey); } catch {} setDirty(false); onSave(); }}>
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save (new version)"}
        </button>
      </div>
    </div>
  );
}

// ---------- list ----------
export function Guidelines() {
  const qc = useQueryClient();
  const [, nav] = useLocation();
  const [draft, setDraft] = useState<{ title: string; markdown: string } | null>(null);
  const [uploadErr, setUploadErr] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["guidelines"], queryFn: () => api("/api/guidelines") });
  const { data: mode } = useQuery({ queryKey: ["guide-mode"], queryFn: () => api("/api/guidelines/status/mode") });
  const inv = () => { qc.invalidateQueries({ queryKey: ["guidelines"] }); qc.invalidateQueries({ queryKey: ["guide-mode"] }); qc.invalidateQueries({ queryKey: ["criteria-sets"] }); };
  const create = useMutation({
    mutationFn: () => api("/api/guidelines", { method: "POST", body: JSON.stringify(draft) }),
    onSuccess: (d) => { setDraft(null); inv(); nav(`/guidelines/${d.id}`); },
  });
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploadErr("");
    const fd = new FormData();
    fd.append("file", f);
    const token = localStorage.getItem("token");
    const r = await fetch("/api/guidelines/upload", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
    const j = await r.json();
    if (!r.ok) { setUploadErr(j.error || "upload rejected"); return; }
    setDraft({ title: j.title, markdown: j.markdown });
  };
  const docs: any[] = data?.docs || [];
  if (draft) {
    return (
      <div className="w-full space-y-4">
        <button className="text-xs font-medium text-gray-500 hover:text-gray-900" onClick={() => setDraft(null)}>← Back to guidelines</button>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Review before saving</h1>
        <EditorPane title={draft.title} setTitle={(t) => setDraft({ ...draft, title: t })} markdown={draft.markdown}
          setMarkdown={(m) => setDraft({ ...draft, markdown: m })} onSave={() => create.mutate()} onCancel={() => setDraft(null)}
          saving={create.isPending} draftKey="arocall-guide-new" />
      </div>
    );
  }
  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-gray-900">Guidelines</h1>
          <p className="text-xs text-gray-500">Markdown source of truth for AI scoring. {mode ? `Scoring mode: ${mode.mode} (${mode.totalTokens.toLocaleString()} / ${mode.budget.toLocaleString()} tokens, ${mode.activeCount} active).` : ""}</p>
        </div>
        <div className="flex gap-2">
          <label className="btn-outline cursor-pointer"><Upload className="h-3.5 w-3.5" /> Upload Markdown
            <input type="file" accept=".md,.markdown,text/markdown,text/plain" className="hidden" onChange={(e) => upload(e.target.files?.[0])} /></label>
          <button className="btn" onClick={() => setDraft({ title: "", markdown: "" })}><PenLine className="h-3.5 w-3.5" /> Write guidelines</button>
        </div>
      </div>
      {uploadErr && <p className="rounded-md bg-red-50 p-2 text-xs text-red-600 ring-1 ring-red-200">{uploadErr}</p>}
      {data?.approvedCriteria?.stale && (
        <div className="rounded-lg bg-amber-50 p-3 text-xs ring-1 ring-amber-200">
          <b>Criteria may be out of date.</b> Guidelines changed since criteria v{data.approvedCriteria.version} were approved. <Link href="/guidelines#criteria" className="font-semibold text-indigo-700 hover:underline">Review criteria</Link>
        </div>
      )}
      {isLoading ? <p className="text-xs text-gray-500">Loading…</p> : !docs.length ? (
        <Card className="p-8 text-center">
          <h3 className="text-sm font-bold text-gray-900">No guidelines yet</h3>
          <p className="mx-auto mt-1 max-w-md text-xs text-gray-500">Upload a Markdown file (.md) or write guidelines from scratch. New documents start as Draft — activate one so the AI scores against it.</p>
          <div className="mt-3 flex justify-center gap-2">
            <button className="btn" onClick={() => setDraft({ title: "Call Handling Guidelines", markdown: STARTER })}><ListPlus className="h-3.5 w-3.5" /> Use a starter template</button>
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-gray-100">
            {docs.map((d: any) => (
              <li key={d.id}>
                <Link href={`/guidelines/${d.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  <span className="min-w-48 flex-1 text-xs font-semibold text-gray-900">{d.title} <span className="font-normal text-gray-400">v{d.currentVersion}</span></span>
                  <Pill tone={statusTone(d.status)}>{d.status}</Pill>
                  <span className="text-[11px] text-gray-400">{d.latestBy} · {d.latestAt ? new Date(d.latestAt).toLocaleDateString() : ""}</span>
                </Link>
              </li>))}
          </ul>
        </Card>
      )}
      <CriteriaPanel onChanged={inv} />
    </div>
  );
}

// ---------- criteria ----------
function CriteriaPanel({ onChanged }: { onChanged: () => void }) {
  const { data: sets } = useQuery({ queryKey: ["criteria-sets"], queryFn: () => api("/api/guidelines/criteria/sets") });
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<any[]>([]);
  const gen = useMutation({ mutationFn: () => api("/api/guidelines/criteria/generate", { method: "POST" }), onSuccess: onChanged });
  const save = useMutation({
    mutationFn: (patch: any) => api(`/api/guidelines/criteria/${editing.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => { setEditing(null); onChanged(); },
  });
  const list: any[] = sets || [];
  const approved = list.find((x) => x.status === "approved");
  const draft = list.find((x) => x.status === "draft");
  const { role } = useAuth();
  const canEdit = role !== "evaluator";
  const openEdit = (s: any) => { setEditing(s); setForm(JSON.parse(JSON.stringify(s.criteria))); };
  return (
    <div id="criteria">
    <Card>
      <CardHeader title="Evaluation criteria" sub="derived from guidelines · approved set scores calls"
        right={canEdit ? <button className="btn" onClick={() => gen.mutate()} disabled={gen.isPending}><Wand2 className="h-3.5 w-3.5" /> {gen.isPending ? "Generating…" : "Generate evaluation criteria"}</button> : undefined} />
      {approved && <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-600">Approved: <b>v{approved.version}</b> ({approved.criteria.length} criteria){approved.stale && <span className="ml-2 font-semibold text-amber-700">out of date — review</span>}</p>}
      {!draft ? <p className="p-4 text-xs text-gray-400">No draft. Generate criteria from the active guidelines, then review and approve.</p> : !canEdit ? (
        <p className="p-4 text-xs text-gray-500">Draft v{draft.version} awaiting admin review ({draft.criteria.length} criteria).</p>
      ) : editing?.id !== draft.id ? (
        <div className="p-4 text-xs">
          <p><b>Draft v{draft.version}</b> ready for review ({draft.criteria.length} criteria).</p>
          <button className="btn-outline mt-2" onClick={() => openEdit(draft)}>Review & edit</button>
        </div>
      ) : (
        <div className="space-y-2 p-4">
          {form.map((c, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 rounded-lg border border-gray-100 p-2">
              <input className="input col-span-2" value={c.name} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="input col-span-4" value={c.description} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <input className="input col-span-1" type="number" value={c.weight} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} />
              <label className="col-span-2 flex items-center gap-1 text-[11px] text-gray-600"><input type="checkbox" checked={!!c.mustPass} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, mustPass: e.target.checked } : x)))} className="h-4 w-4 accent-gray-900" /> must-pass</label>
              <input className="input col-span-3" value={c.guidance} onChange={(e) => setForm(form.map((x, j) => (j === i ? { ...x, guidance: e.target.value } : x)))} />
              <p className="col-span-12 text-[11px] text-gray-400">Sections: {(c.guidelineRefs || []).join(", ") || "—"}</p>
            </div>))}
          <div className="flex gap-2">
            <button className="btn-outline" onClick={() => save.mutate({ criteria: form })}>Save draft</button>
            <button className="btn" onClick={() => { if (confirm("Approve criteria v" + editing.version + "? Calls will be scored against this set.")) save.mutate({ criteria: form, status: "approved" }); }}>
              <CheckCircle className="h-3.5 w-3.5" /> Approve
            </button>
          </div>
        </div>
      )}
    </Card>
    </div>
  );
}

// ---------- document page ----------
export function GuidelineDoc() {
  const [, params] = useRoute("/guidelines/:id");
  const id = params?.id || "";
  const [, nav] = useLocation();
  const sectionParam = new URLSearchParams(location.search).get("section") || "";
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [showVersions, setShowVersions] = useState(false);
  const [diffV, setDiffV] = useState<number | null>(null);
  const qc = useQueryClient();
  const { data: doc, isLoading } = useQuery({ queryKey: ["guide", id], queryFn: () => api(`/api/guidelines/${id}`) });
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [init, setInit] = useState(false);
  useEffect(() => {
    if (doc && !init) { setTitle(doc.title); setMarkdown(doc.markdown); setInit(true); }
  }, [doc, init]);
  useEffect(() => {
    if (mode === "preview" && sectionParam) {
      const el = document.getElementById(`sec-${sectionParam.split(":").pop()}`);
      if (el) el.scrollIntoView({ block: "center" });
    }
  }, [mode, sectionParam, doc]);
  const inv = () => { qc.invalidateQueries({ queryKey: ["guide", id] }); qc.invalidateQueries({ queryKey: ["guidelines"] }); qc.invalidateQueries({ queryKey: ["guide-mode"] }); };
  const save = useMutation({ mutationFn: () => api(`/api/guidelines/${id}/save`, { method: "POST", body: JSON.stringify({ markdown }) }), onSuccess: () => inv() });
  const patch = useMutation({ mutationFn: (b: any) => api(`/api/guidelines/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv });
  const restore = useMutation({ mutationFn: (v: number) => api(`/api/guidelines/${id}/restore`, { method: "POST", body: JSON.stringify({ version: v }) }), onSuccess: () => { inv(); setInit(false); } });
  const remove = useMutation({ mutationFn: () => api(`/api/guidelines/${id}`, { method: "DELETE" }), onSuccess: () => nav("/guidelines") });
  const toggleMandatory = useMutation({
    mutationFn: (secId: string) => {
      const cur: string[] = doc.mandatorySections || [];
      const next = cur.includes(secId) ? cur.filter((x) => x !== secId) : [...cur, secId];
      return api(`/api/guidelines/${id}/mandatory`, { method: "PATCH", body: JSON.stringify({ sectionIds: next }) });
    },
    onSuccess: inv,
  });
  const [rerun, setRerun] = useState({ from: "", to: "" });
  const [rerunMsg, setRerunMsg] = useState("");
  const { role } = useAuth();
  const canEdit = role !== "evaluator";
  const rerunRange = async () => {
    setRerunMsg("Re-running…");
    const r = await api("/api/calls/rerun-range", { method: "POST", body: JSON.stringify(rerun) });
    setRerunMsg(`Re-analyzed ${r.count} calls against current guidelines.`);
  };
  if (isLoading) return <p className="p-4 text-xs text-gray-500">Loading…</p>;
  if (!doc) return <p className="p-4 text-xs">Not found</p>;
  const versions: any[] = doc.versions || [];
  const diffPair = diffV != null ? versions.filter((v) => v.version === diffV || v.version === diffV - 1) : [];
  return (
    <div className="w-full space-y-4">
      <Link href="/guidelines" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900"><ArrowLeft className="h-3.5 w-3.5" /> Guidelines</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold tracking-tight text-gray-900">{doc.title}</h1>
        <Pill tone={statusTone(doc.status)}>{doc.status} · v{doc.currentVersion}</Pill>
        <span className="ml-auto flex flex-wrap gap-2">
          {canEdit && doc.status === "draft" && <button className="btn" onClick={() => patch.mutate({ status: "active" })}><CheckCircle className="h-3.5 w-3.5" /> Activate</button>}
          {canEdit && doc.status === "active" && <button className="btn-outline" onClick={() => patch.mutate({ status: "archived" })}><Archive className="h-3.5 w-3.5" /> Archive</button>}
          {canEdit && doc.status === "archived" && <button className="btn-outline" onClick={() => patch.mutate({ status: "draft" })}>Back to draft</button>}
          <button className="btn-outline" onClick={() => setShowVersions((s) => !s)}><History className="h-3.5 w-3.5" /> Versions ({versions.length})</button>
          {canEdit && <button className="btn-outline !text-red-600" onClick={() => { if (confirm(`Delete "${doc.title}" and all its versions?`)) remove.mutate(); }}><Trash2 className="h-3.5 w-3.5" /></button>}
        </span>
      </div>

      {showVersions && (
        <Card className="p-4">
          <h3 className="text-xs font-bold text-gray-900">Version history</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {versions.map((v: any) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 rounded bg-gray-50 px-2 py-1.5">
                <b>v{v.version}</b><span className="text-gray-500">{v.by} · {new Date(v.at).toLocaleString()} · {v.hash.slice(0, 8)}</span>
                <span className="ml-auto flex gap-2">
                  {v.version > 1 && <button className="font-semibold text-indigo-700 hover:underline" onClick={() => setDiffV(diffV === v.version ? null : v.version)}>diff vs v{v.version - 1}</button>}
                  <button className="font-semibold text-indigo-700 hover:underline" onClick={() => { if (confirm(`Restore v${v.version}? This creates a new version.`)) restore.mutate(v.version); }}>
                    <span className="inline-flex items-center gap-1"><RotateCcw className="h-3 w-3" /> Restore</span>
                  </button>
                </span>
              </li>))}
          </ul>
          {diffV != null && <VersionDiffBody guidelineId={id} fromV={diffV - 1} toV={diffV} />}
        </Card>
      )}

      <div className="flex gap-1">
        <button onClick={() => setMode("preview")} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "preview" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}><Eye className="h-3.5 w-3.5" /> Preview</button>
        {canEdit && <button onClick={() => setMode("edit")} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === "edit" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}>Edit</button>}
      </div>

      {mode === "preview" ? (
        <div className="grid gap-4 lg:grid-cols-4">
          <Card className="p-5 lg:col-span-3">
            <div className="prose-sm max-w-none text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: addSectionIds(renderMarkdown(doc.markdown), doc.sections || []) }} />
          </Card>
          <Card className="h-fit">
            <CardHeader title="Sections" sub="toggle mandatory for budget mode" />
            <ul className="max-h-96 space-y-1 overflow-y-auto p-3 text-xs">
              {(doc.sections || []).map((s: any) => (
                <li key={s.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-gray-50">
                  <a href={`#sec-${s.id}`} className="min-w-0 flex-1 truncate text-gray-700 hover:text-indigo-700" style={{ paddingLeft: Math.min(24, (s.level - 1) * 12) }}>{s.title}</a>
                  {canEdit && <button title="Mandatory (always included in scoring)" onClick={() => toggleMandatory.mutate(s.id)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${s.mandatory ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-400 hover:text-gray-600"}`}>M</button>}
                </li>))}
            </ul>
          </Card>
        </div>
      ) : (
        <EditorPane title={title} setTitle={setTitle} markdown={markdown} setMarkdown={setMarkdown}
          onSave={() => { patch.mutate({ title }); save.mutate(); }} onCancel={() => { setMode("preview"); setTitle(doc.title); setMarkdown(doc.markdown); }}
          saving={save.isPending} draftKey={`arocall-guide-${id}`} />
      )}

      <Card className="p-4">
        <h3 className="text-xs font-bold text-gray-900">Re-run analysis</h3>
        <p className="text-[11px] text-gray-500">After guideline or criteria changes, re-score calls in a date range against the current setup.</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div><label className="text-[11px] font-semibold text-gray-500">From</label><DateField value={rerun.from} onChange={(v) => setRerun({ ...rerun, from: v })} /></div>
          <div><label className="text-[11px] font-semibold text-gray-500">To</label><DateField value={rerun.to} onChange={(v) => setRerun({ ...rerun, to: v })} /></div>
          <button className="btn" onClick={rerunRange}>Re-run range</button>
          {rerunMsg && <span className="text-xs text-gray-600">{rerunMsg}</span>}
        </div>
      </Card>
    </div>
  );
}

function VersionDiffBody({ guidelineId, fromV, toV }: { guidelineId: string; fromV: number; toV: number }) {
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      // The detail endpoint returns current markdown only; version bodies come from the
      // versions endpoint below (added for diff/restore transparency).
      const r = await api(`/api/guidelines/${guidelineId}/versions`);
      const a = r.find((v: any) => v.version === fromV)?.markdown || "";
      const b = r.find((v: any) => v.version === toV)?.markdown || "";
      if (!dead) setPair({ a, b });
    })();
    return () => { dead = true; };
  }, [guidelineId, fromV, toV]);
  if (!pair) return <p className="mt-2 text-xs text-gray-400">Loading diff…</p>;
  const lines = diffLines(pair.a, pair.b).filter((l) => l.type !== "same" || l.text.trim());
  return (
    <div className="mt-2 max-h-64 overflow-y-auto rounded border border-gray-100 bg-white font-mono text-[11px]">
      {lines.filter((l) => l.type !== "same").slice(0, 200).map((l, i) => (
        <div key={i} className={`px-2 py-0.5 ${l.type === "add" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {l.type === "add" ? "+ " : "− "}{l.text}
        </div>))}
      {!lines.some((l) => l.type !== "same") && <p className="p-2 text-gray-400">No differences.</p>}
    </div>
  );
}
