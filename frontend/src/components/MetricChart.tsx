import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import type { MetricRecord } from "@/lib/types";

interface MetricChartProps {
  records: MetricRecord[];
  names: string[];
}

const COLORS = [
  "#60a5fa", // blue-400
  "#34d399", // emerald-400
  "#f87171", // red-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#f472b6", // pink-400
  "#38bdf8", // sky-400
  "#4ade80", // green-400
];

function formatValue(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "K";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4);
}

export function MetricChart({ records, names }: MetricChartProps) {
  if (records.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No metric data yet
      </div>
    );
  }

  // Build a map of step -> { metricName: value }
  const byStep = new Map<number, Record<string, number>>();
  for (const r of records) {
    const key = r.step ?? r.seq;
    const existing = byStep.get(key) ?? {};
    existing[r.name] = r.value;
    byStep.set(key, existing);
  }

  const data = Array.from(byStep.entries())
    .sort(([a], [b]) => a - b)
    .map(([step, vals]) => ({ step, ...vals }));

  const hasStep = records.some((r) => r.step != null);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 3.7% 15.9%)" />
        <XAxis
          dataKey="step"
          tick={{ fill: "hsl(240 5% 64.9%)", fontSize: 11 }}
          label={
            hasStep
              ? { value: "step", position: "insideBottomRight", fill: "hsl(240 5% 64.9%)", fontSize: 11, offset: -4 }
              : undefined
          }
        />
        <YAxis
          tick={{ fill: "hsl(240 5% 64.9%)", fontSize: 11 }}
          tickFormatter={formatValue}
          width={60}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(240 10% 3.9%)",
            border: "1px solid hsl(240 3.7% 15.9%)",
            borderRadius: 8,
            color: "hsl(0 0% 98%)",
            fontSize: 12,
          }}
          formatter={(value: number, name: string) => [formatValue(value), name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "hsl(240 5% 64.9%)" }}
        />
        {names.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
