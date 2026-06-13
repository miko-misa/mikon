import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CompareRunsResponse } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ComparePageProps {
  ids: string[];
  navigate: (path: string) => void;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function formatMetric(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(3) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(3) + "K";
  return v.toFixed(4);
}

export function ComparePage({ ids, navigate }: ComparePageProps) {
  const [data, setData] = useState<CompareRunsResponse | null>(null);

  useEffect(() => {
    if (ids.length === 0) return;
    api
      .post<CompareRunsResponse>("/api/runs/compare", { run_ids: ids })
      .then(setData)
      .catch((e: unknown) => toast.error(String(e)));
  }, [ids.join(",")]);

  if (ids.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full">
        <GitCompare className="h-12 w-12 text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">No runs selected</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const diffFields = new Set(data.config_diffs.map((d) => d.field));

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold">Compare Runs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Comparing {data.runs.length} runs
        </p>
      </div>

      {/* Header */}
      <div className="overflow-auto">
        <table className="w-full text-sm border-collapse">
          <colgroup>
            <col className="w-48" />
            {data.runs.map((r) => (
              <col key={r.run_id} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/30 sticky left-0">
                Field
              </th>
              {data.runs.map((r) => (
                <th
                  key={r.run_id}
                  className="text-left px-3 py-2 min-w-40"
                >
                  <button
                    type="button"
                    className="font-mono text-xs hover:underline text-primary"
                    onClick={() => navigate(`/runs/${r.run_id}`)}
                  >
                    {r.run_id.slice(0, 20)}...
                  </button>
                  <div className="mt-1">
                    <StatusBadge
                      status={r.status as "running" | "completed" | "failed" | "stopped" | "unknown"}
                    />
                  </div>
                  <div className="mt-1">
                    <Badge variant="outline" className="text-xs">{r.job}</Badge>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Config section */}
            {data.config_fields.length > 0 && (
              <>
                <tr className="border-b border-border bg-muted/50">
                  <td
                    colSpan={data.runs.length + 1}
                    className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Configuration
                  </td>
                </tr>
                {data.config_fields.map((field) => {
                  const isDiff = diffFields.has(field);
                  return (
                    <tr
                      key={field}
                      className={cn(
                        "border-b border-border",
                        isDiff && "bg-yellow-500/5"
                      )}
                    >
                      <td className="px-3 py-2 sticky left-0 bg-card">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs">{field}</span>
                          {isDiff && (
                            <Badge
                              variant="outline"
                              className="text-xs border-yellow-500/40 bg-yellow-500/10 text-yellow-400"
                            >
                              diff
                            </Badge>
                          )}
                        </div>
                      </td>
                      {data.runs.map((r) => (
                        <td key={r.run_id} className="px-3 py-2">
                          <code className="text-xs">
                            {formatValue(r.config[field])}
                          </code>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </>
            )}

            {/* Metrics section */}
            {data.metric_names.length > 0 && (
              <>
                <tr className="border-b border-border bg-muted/50">
                  <td
                    colSpan={data.runs.length + 1}
                    className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Metrics
                  </td>
                </tr>
                {data.metric_names.map((metric) => (
                  <tr key={metric} className="border-b border-border">
                    <td className="px-3 py-2 sticky left-0 bg-card">
                      <span className="font-mono text-xs">{metric}</span>
                    </td>
                    {data.runs.map((r) => {
                      const m = r.metrics[metric];
                      return (
                        <td key={r.run_id} className="px-3 py-2">
                          {m ? (
                            <div className="space-y-0.5 text-xs">
                              <div>
                                <span className="text-muted-foreground">latest: </span>
                                {formatMetric(m.latest)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">min: </span>
                                {formatMetric(m.min)}
                                <span className="text-muted-foreground ml-2">max: </span>
                                {formatMetric(m.max)}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
