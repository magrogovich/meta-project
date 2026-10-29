import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Card, CardHeader, EmptyState } from "../components/ui";
import { BarChart } from "../components/charts";

export function ComingSoon({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-lg font-bold tracking-tight text-gray-900">{title}</h1>
      <div className="mt-3"><EmptyState title="Coming soon" hint={hint} /></div>
    </div>
  );
}

// Thin stand-in removed in Phase 2 (see pages/Employees.tsx).

export function Analytics() {
  const { data: emps } = useQuery({ queryKey: ["emps"], queryFn: () => api("/api/employees") });
  const bars = ((emps as any[]) || []).slice(0, 12).map((e) => ({ label: e.name.split(" ")[0], value: Math.round(e.overallScore || 0) }));
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-gray-900">Analytics <Pill tone="gray">coming soon</Pill></h1>
        <p className="text-xs text-gray-500">Deeper cuts live here. Score by employee already moved over from the dashboard.</p>
      </div>
      <Card>
        <CardHeader title="Score by employee" sub="overall average" />
        <div className="p-4"><BarChart bars={bars} /></div>
      </Card>
      <EmptyState title="More analytics on the way" hint="Department splits, criterion heatmaps and exportable reports." />
    </div>
  );
}
