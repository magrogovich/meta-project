import type { ReactNode } from "react";

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

export const scoreTone = (s: number): "green" | "amber" | "red" => (s >= 80 ? "green" : s >= 60 ? "amber" : "red");

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-4 py-10 text-center">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      <div className="mt-1 max-w-sm text-xs text-gray-500">{hint}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
