import { useState, useEffect, type ReactNode } from "react";
import { Calendar } from "lucide-react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-gray-900">{title}</h3>
        {sub && <p className="truncate text-xs text-gray-500">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function StatCard({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
        {icon}
      </div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

export function Pill({ tone, children }: { tone: "green" | "amber" | "red" | "gray" | "indigo"; children: ReactNode }) {
  const map: Record<string, string> = {
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    red: "bg-red-50 text-red-600 ring-1 ring-red-200",
    gray: "bg-gray-100 text-gray-600",
    indigo: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  };
  return <span className={`badge ${map[tone]}`}>{children}</span>;
}

export const scoreTone = (s: number | null, target = 80, pass = 70): "green" | "amber" | "red" => (s == null ? "gray" : s >= target ? "green" : s >= pass ? "amber" : "red");

export const scoreColor = (s: number | null, target = 80, pass = 70) =>
  s == null ? "#cbd5e1" : s >= target ? "#22c55e" : s >= pass ? "#f59e0b" : "#ef4444";

export function Skeleton({ className = "h-16" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-gray-100 ${className}`} />;
}

export function MetricTip({ text }: { text: string }) {
  return (
    <span title={text} className="ml-1 inline-grid h-4 w-4 cursor-help place-items-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500">?</span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {  return (
    <div className="card flex flex-col items-center px-4 py-10 text-center">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      <div className="mt-1 max-w-sm text-xs text-gray-500">{hint}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// Plain-text date field (YYYY-MM-DD) — avoids the browser's mm/dd/yyyy placeholder.
// The calendar icon opens the native date picker (invisible overlay input).
export function DateField({ value, onChange, className = "input w-36" }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value); setBad(false); }, [value]);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) ? value : "";
  return (
    <div className="relative">
      <input
        className={`${className} pr-8 ${bad ? "!border-red-400" : ""}`}
        placeholder="---- -- --"
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (!v) { setBad(false); onChange(""); return; }
          if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))) { setBad(false); onChange(v); }
          else setBad(true);
        }}
      />
      <Calendar className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
      <input
        type="date"
        aria-label="Pick a date from the calendar"
        title="Pick a date from the calendar"
        value={valid}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        className="absolute right-1 top-1/2 h-6 w-7 -translate-y-1/2 cursor-pointer opacity-0"
      />
    </div>
  );
}
