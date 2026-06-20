// --------------------------------------------------------------------------
// A tiny dependency-free SVG bar chart for agent usage over time. Renders one
// bar per bucket, scaled to the largest value, with an axis baseline and hover
// tooltips. Kept intentionally small — no chart lib, on-theme colors.
// --------------------------------------------------------------------------

export interface ChartBar {
  /** Short axis label, e.g. "06-19". */
  label: string;
  value: number;
  /** Tooltip / accessible title for this bar. */
  title?: string;
}

export function UsageChart({
  bars,
  accent = 'var(--signal)',
  format = (v) => String(v),
  height = 120,
}: {
  bars: ChartBar[];
  accent?: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const allZero = bars.every((b) => b.value === 0);

  return (
    <div className="chart">
      <div className="chart-bars" style={{ height }}>
        {bars.map((b, i) => {
          const pct = allZero ? 0 : (b.value / max) * 100;
          return (
            <div
              className="chart-col"
              key={`${b.label}-${i}`}
              title={b.title ?? `${b.label}: ${format(b.value)}`}
            >
              <div className="chart-bar-track">
                <div
                  className="chart-bar"
                  style={{ height: `${pct}%`, background: accent }}
                />
              </div>
              <span className="chart-xlabel">{b.label}</span>
            </div>
          );
        })}
      </div>
      <div className="chart-axis">
        <span className="muted small">0</span>
        <span className="muted small">{format(max)}</span>
      </div>
    </div>
  );
}
