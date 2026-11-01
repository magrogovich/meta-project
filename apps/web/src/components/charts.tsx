export type ChartPoint = { t: string; score: number; count?: number; id?: string };

const TEAL = "#0d9488";
const SLATE = "#1e293b";

// Fixed-height line chart with Y axis (0/25/50/75/100), X labels and native tooltips.
export function LineChart({ points, height = 200, color = TEAL, hint, onPointClick }: {
  points: ChartPoint[]; height?: number; color?: string;
  hint?: (p: ChartPoint, i: number) => string; onPointClick?: (p: ChartPoint) => void;
}) {
  const H = height;
  if (!points.length) return <div style={{ height: H }} className="grid w-full place-items-center text-xs text-gray-400">No data yet</div>;
  const w = 560, h = 160, padL = 30, padR = 10, padT = 10, padB = 24;
  const xs = (i: number) => padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const ys = (s: number) => padT + (1 - Math.max(0, Math.min(100, s)) / 100) * (h - padT - padB);
  const line = points.map((p, i) => `${xs(i)},${ys(p.score)}`).join(" ");
  const title = (p: ChartPoint, i: number) => (hint ? hint(p, i) : `${new Date(p.t).toLocaleDateString()} — ${p.score}`);
  const xLabel = (i: number) => {
    if (points.length <= 8 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0)
      return new Date(points[i].t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return "";
  };
  return (
    <div style={{ height: H }} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ height: H, width: "100%" }} preserveAspectRatio="none" role="img">
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={padL} x2={w - padR} y1={ys(g)} y2={ys(g)} stroke={g === 0 ? "#cbd5e1" : "#e5e7eb"} strokeWidth="1" />
            <text x={padL - 4} y={ys(g) + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{g}</text>
          </g>
        ))}
        <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={xs(i)} cy={ys(p.score)} r="5" fill={color} stroke="#fff" strokeWidth="2"
              style={onPointClick ? { cursor: "pointer" } : undefined}
              onClick={onPointClick ? () => onPointClick(p) : undefined}>
              <title>{title(p, i)}</title>
            </circle>
            {xLabel(i) && <text x={xs(i)} y={h - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">{xLabel(i)}</text>}
          </g>
        ))}
      </svg>
    </div>
  );
}

// Trend + target + volume: team average line, dashed target, faint volume bars.
export function TrendChart({ points, target, height = 220, weekly }: { points: { t: string; score: number; count: number }[]; target: number; height?: number; weekly?: boolean }) {
  const H = height;
  if (points.length < 3)
    return <div style={{ height: H }} className="grid w-full place-items-center p-4 text-center text-xs text-gray-500">Not enough data yet — need at least 3 {weekly ? "weeks" : "days"} with analyzed calls.</div>;
  const w = 560, h = 170, padL = 30, padR = 10, padT = 10, padB = 24;
  const maxCount = Math.max(1, ...points.map((p) => p.count));
  const xs = (i: number) => padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const ys = (s: number) => padT + (1 - Math.max(0, Math.min(100, s)) / 100) * (h - padT - padB);
  const bw = Math.max(3, (w - padL - padR) / points.length - 4);
  const line = points.map((p, i) => `${xs(i)},${ys(p.score ?? 0)}`).join(" ");
  return (
    <div style={{ height: H }} className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ height: H, width: "100%" }} preserveAspectRatio="none" role="img">
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={padL} x2={w - padR} y1={ys(g)} y2={ys(g)} stroke={g === 0 ? "#cbd5e1" : "#e5e7eb"} strokeWidth="1" />
            <text x={padL - 4} y={ys(g) + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{g}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const bh = ((p.count / maxCount) * (h - padT - padB)) / 3;
          return (
            <rect key={i} x={xs(i) - bw / 2} y={h - padB - bh} width={bw} height={bh} fill="#0d9488" opacity={0.15}>
              <title>{`${new Date(p.t).toLocaleDateString()} — avg ${p.score} across ${p.count} call(s)`}</title>
            </rect>
          );
        })}
        <line x1={padL} x2={w - padR} y1={ys(target)} y2={ys(target)} stroke="#16a34a" strokeWidth="1.5" strokeDasharray="6 4" />
        <text x={w - padR} y={ys(target) - 4} textAnchor="end" fontSize="9" fill="#16a34a" fontWeight="700">target {target}</text>
        <polyline points={line} fill="none" stroke={TEAL} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={xs(i)} cy={ys(p.score ?? 0)} r="4.5" fill={TEAL} stroke="#fff" strokeWidth="2">
              <title>{`${new Date(p.t).toLocaleDateString()} — avg ${p.score} across ${p.count} call(s)`}</title>
            </circle>
            {(i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0) && (
              <text x={xs(i)} y={h - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {new Date(p.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Sparkline({ points, width = 120, height = 28 }: { points: { t: string; v: number | null }[]; width?: number; height?: number }) {
  const vs = points.map((p) => p.v).filter((v): v is number => v != null);
  if (!vs.length) return <span className="text-[10px] text-gray-300">—</span>;
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = Math.max(1, max - min);
  const step = width / Math.max(1, points.length - 1);
  const pts = points.map((p, i) => `${i * step},${height - 3 - (((p.v ?? min) - min) / span) * (height - 6)}`).join(" ");
  return (
    <svg width={width} height={height} className="mt-1 block" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#0d9488" strokeWidth="1.5" />
    </svg>
  );
}

export function BarChart({ bars, height = 200, color = TEAL }: { bars: { label: string; value: number }[]; height?: number; color?: string }) {
  if (!bars.length) return <div style={{ height }} className="grid w-full place-items-center text-xs text-gray-400">No data yet</div>;
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div style={{ height }} className="flex w-full items-end gap-2 overflow-hidden">
      {bars.map((b) => (
        <div key={b.label} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${b.label} — ${b.value}`}>
          <div className="text-[11px] font-semibold text-gray-700">{b.value}</div>
          <div className="w-full max-w-10 rounded-t-md" style={{ height: `${Math.max(6, (b.value / max) * (height - 52))}px`, background: color, opacity: 0.85 }} />
          <div className="w-full truncate text-center text-[10px] text-gray-500">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// Horizontal bars: better use of space for named breakdowns.
export function HBars({ bars, color = TEAL, onClick }: { bars: { label: string; value: number; hint?: string; id?: string }[]; color?: string; onClick?: (b: any) => void }) {
  if (!bars.length) return <p className="text-xs text-gray-400">No data yet</p>;
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="space-y-2.5">
      {bars.map((b) => (
        <div key={b.label} title={b.hint || `${b.label} — ${b.value}`}
          onClick={onClick ? () => onClick(b) : undefined}
          className={onClick ? "cursor-pointer rounded hover:bg-gray-50" : undefined}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium text-gray-700">{b.label}</span>
            <span className="shrink-0 text-xs font-bold text-gray-900">{b.value}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (b.value / max) * 100)}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export { TEAL, SLATE };
