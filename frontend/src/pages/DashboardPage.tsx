import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { RunSummary, ResourceSnapshot } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Play, Zap, ListChecks } from "lucide-react";
import { toast } from "sonner";

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

function StatCard({
  title,
  value,
  icon: Icon,
  description,
}: {
  title: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

function GpuCard({ gpu }: { gpu: ResourceSnapshot["gpus"][number] }) {
  const memPct = gpu.mem_total_mib > 0
    ? Math.round((gpu.mem_used_mib / gpu.mem_total_mib) * 100)
    : 0;
  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium truncate">{gpu.name}</span>
        <Badge variant="outline" className="text-xs shrink-0 ml-2">
          {gpu.id}
        </Badge>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>VRAM {gpu.mem_used_mib} / {gpu.mem_total_mib} MiB</span>
          <span>{memPct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full ${memPct > 90 ? "bg-red-500" : "bg-blue-500"}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Util {gpu.util_pct}%</span>
        {gpu.temp_c != null && <span>{gpu.temp_c}°C</span>}
        {gpu.occupied ? (
          <span className="text-red-400">Occupied</span>
        ) : (
          <span className="text-green-400">Free</span>
        )}
      </div>
    </div>
  );
}

export function DashboardPage({ navigate }: { navigate: (path: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [r, s] = await Promise.all([
          api.get<RunSummary[]>("/api/runs?limit=20"),
          api.get<ResourceSnapshot>("/api/resources"),
        ]);
        if (cancelled) return;
        setRuns(r);
        setResources(s);

        const hasRunning = r.some((x) => x.status === "running");
        if (hasRunning && !intervalRef.current) {
          intervalRef.current = setInterval(async () => {
            try {
              const [nr, ns] = await Promise.all([
                api.get<RunSummary[]>("/api/runs?limit=20"),
                api.get<ResourceSnapshot>("/api/resources"),
              ]);
              if (!cancelled) { setRuns(nr); setResources(ns); }
            } catch { /* ignore */ }
          }, 5000);
        } else if (!hasRunning && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    }

    load();
    return () => {
      cancelled = true;
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
  }, []);

  const activeRuns = runs?.filter((r) => r.status === "running") ?? [];
  const totalRuns = runs?.length ?? 0;
  const gpusAvailable = resources
    ? resources.gpus.filter((g) => !g.occupied).length
    : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your ML experiments
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          title="Active Runs"
          value={activeRuns.length}
          icon={Play}
          description="Currently running"
        />
        <StatCard
          title="GPUs Available"
          value={gpusAvailable}
          icon={Zap}
          description={
            resources ? `of ${resources.gpus.length} total` : undefined
          }
        />
        <StatCard
          title="Total Runs"
          value={totalRuns}
          icon={ListChecks}
          description="Last 20 shown"
        />
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Recent runs */}
        <div className="col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Recent Runs
          </h2>
          {runs == null ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Play className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No runs yet</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Title</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Job</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr
                      key={run.run_id}
                      className="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer transition-colors"
                      onClick={() => navigate(`/runs/${run.run_id}`)}
                    >
                      <td className="px-4 py-2.5">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-2.5 max-w-50">
                        <span className={`text-sm truncate block ${!run.annotations.title ? "font-mono text-xs text-muted-foreground" : "font-medium"}`}>
                          {run.annotations.title ?? run.run_id}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-medium">{run.job}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">
                        {formatRelative(run.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* GPU cards */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            GPUs
          </h2>
          {resources == null ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : resources.gpus.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-xs text-muted-foreground">No GPU detected</p>
            </div>
          ) : (
            <div className="space-y-2">
              {resources.gpus.map((gpu) => (
                <GpuCard key={gpu.id} gpu={gpu} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
