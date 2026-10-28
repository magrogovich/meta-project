export function LineChart({ points, height = 168, color = "#4F39F6" }: { points: { t: string; score: number }[]; height?: number; color?: string }) {
  const w = 560, h = height, pad = 8;
  if (!points.length) return <div className="grid h-[168px] place-items-center text-xs text-gray-400">No data yet</div>;
  const xs = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2);
  const ys = (s: number) => h - pad - (Math.max(0, Math.min(100, s)) / 100) * (h - pad * 2);
  const line = points.map((p, i) => `${xs(i)},${ys(p.score)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[168px] w-full" preserveAspectRatio="none">
      {[25, 50, 75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={ys(g)} y2={ys(g)} stroke="#e5e7eb" strokeWidth="1" />
      ))}
      <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (
        <circle key={i} cx={xs(i)} cy={ys(p.score)} r="4" fill={color} stroke="#fff" strokeWidth="2">
          <title>{`${new Date(p.t).toLocaleDateString()} — ${p.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function BarChart({ bars, height = 168, color = "#4F39F6" }: { bars: { label: string; value: number }[]; height?: number; color?: string }) {
  if (!bars.length) return <div className="grid h-[168px] place-items-center text-xs text-gray-400">No data yet</div>;
  const max = Math.max(100, ...bars.map((b) => b.value));
  return (
    <div className="flex h-[168px] items-end gap-2">
      {bars.map((b) => (
        <div key={b.label} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${b.label} — ${b.value}`}>
          <div className="text-[11px] font-semibold text-gray-700">{b.value}</div>
          <div className="w-full max-w-10 rounded-t-md" style={{ height: `${Math.max(4, (b.value / max) * (height - 44))}px`, background: color, opacity: 0.85 }} />
          <div className="w-full truncate text-center text-[10px] text-gray-500">{b.label}</div>
        </div>
      ))}
    </div>
  );
}
