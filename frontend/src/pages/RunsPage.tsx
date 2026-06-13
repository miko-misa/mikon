import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { RunSummary, JobInfo, Group } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Star, GitCompare, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface RunsPageProps {
  navigate: (path: string) => void;
}

function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.floor((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RunsPage({ navigate }: RunsPageProps) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterJob, setFilterJob] = useState<string>("all");
  const [filterTag, setFilterTag] = useState("");
  const [filterStar, setFilterStar] = useState(false);
  const [filterGroup, setFilterGroup] = useState<string>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null); // single run id
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadRuns() {
    try {
      const r = await api.get<RunSummary[]>("/api/runs?limit=200");
      setRuns(r);
    } catch (e) {
      toast.error(String(e));
    }
  }

  useEffect(() => {
    loadRuns();
    Promise.all([
      api.get<JobInfo[]>("/api/jobs"),
      api.get<Group[]>("/api/groups"),
    ])
      .then(([j, g]) => {
        setJobs(j);
        setGroups(g);
      })
      .catch(() => {});
  }, []);

  // Auto-refresh every 3s when there are running runs
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const hasRunning = runs?.some((r) => r.status === "running") ?? false;
    if (hasRunning) {
      intervalRef.current = setInterval(loadRuns, 3000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [runs]);

  const filtered = (runs ?? []).filter((r) => {
    if (filterStatus !== "all" && r.status !== filterStatus) return false;
    if (filterJob !== "all" && r.job !== filterJob) return false;
    if (filterTag && !r.annotations.tags.some((t) => t.includes(filterTag)))
      return false;
    if (filterStar && !r.annotations.star) return false;
    if (
      filterGroup !== "all" &&
      !r.annotations.group_ids.includes(filterGroup)
    )
      return false;
    return true;
  });

  function toggleSelect(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  function handleCompare() {
    if (selected.length < 2) return;
    navigate(`/compare?ids=${selected.join(",")}`);
  }

  async function handleDeleteSingle(runId: string) {
    setDeleting(true);
    try {
      await api.delete(`/api/runs/${runId}`);
      toast.success("Run deleted");
      setRuns((prev) => (prev ?? []).filter((r) => r.run_id !== runId));
      setSelected((prev) => prev.filter((id) => id !== runId));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function handleBulkDelete() {
    setDeleting(true);
    const targets = [...selected];
    let failed = 0;
    for (const id of targets) {
      try {
        await api.delete(`/api/runs/${id}`);
        setRuns((prev) => (prev ?? []).filter((r) => r.run_id !== id));
      } catch {
        failed++;
      }
    }
    setSelected([]);
    setBulkDeleteOpen(false);
    setDeleting(false);
    if (failed > 0) {
      toast.error(`${failed} run(s) could not be deleted (still running?)`);
    } else {
      toast.success(`${targets.length} run(s) deleted`);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {runs == null ? "Loading..." : `${runs.length} total runs`}
          </p>
        </div>
        {selected.length >= 1 && (
          <div className="flex gap-2">
            {selected.length >= 2 && (
              <Button onClick={handleCompare} variant="outline" size="sm">
                <GitCompare className="h-4 w-4" />
                Compare {selected.length}
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              Delete {selected.length}
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterJob} onValueChange={setFilterJob}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {jobs.map((j) => (
              <SelectItem key={j.name} value={j.name}>
                {j.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterGroup} onValueChange={setFilterGroup}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All groups</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-36"
          placeholder="Filter tag..."
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
        />

        <Button
          variant={filterStar ? "secondary" : "ghost"}
          size="icon"
          onClick={() => setFilterStar((v) => !v)}
          title="Starred only"
        >
          <Star
            className={cn(
              "h-4 w-4",
              filterStar ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
            )}
          />
        </Button>
      </div>

      {/* Table */}
      {runs == null ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-16 text-center">
          <Play className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No runs match filters</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="w-8 px-2 py-2" />
                <th className="w-8 px-2 py-2" />
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Status
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Title
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Job
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  GPUs
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Created
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Duration
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Tags
                </th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => (
                <tr
                  key={run.run_id}
                  className="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/runs/${run.run_id}`)}
                >
                  <td
                    className="px-2 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(run.run_id)}
                      onChange={() => toggleSelect(run.run_id)}
                      className="rounded border-border"
                    />
                  </td>
                  <td
                    className="px-2 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        run.annotations.star
                          ? "fill-yellow-400 text-yellow-400"
                          : "text-muted-foreground"
                      )}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-3 py-2.5 max-w-44">
                    <span className={cn(
                      "truncate block",
                      run.annotations.title
                        ? "text-sm font-medium"
                        : "font-mono text-xs text-muted-foreground"
                    )}>
                      {run.annotations.title ?? run.run_id}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-medium">{run.job}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {run.gpus.length === 0 ? (
                        <span className="text-xs text-muted-foreground">CPU</span>
                      ) : (
                        run.gpus.map((g) => (
                          <Badge key={g} variant="outline" className="text-xs">
                            {g}
                          </Badge>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(run.created_at)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {formatDuration(run.started_at, run.ended_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {run.annotations.tags.map((t) => (
                        <Badge key={t} variant="secondary" className="text-xs">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td
                    className="px-2 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                      title="Delete run"
                      onClick={() => setDeleteTarget(run.run_id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Single delete dialog */}
      {deleteTarget && (
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(o) => !o && setDeleteTarget(null)}
          title="Delete run?"
          description={
            <span>
              Run <code className="font-mono text-xs bg-muted px-1 rounded">{deleteTarget}</code> とそのファイルを完全に削除します。この操作は元に戻せません。
            </span>
          }
          onConfirm={() => handleDeleteSingle(deleteTarget)}
          loading={deleting}
        />
      )}

      {/* Bulk delete dialog */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`${selected.length} 件の Run を削除?`}
        description={`選択した ${selected.length} 件のRunとそのファイルを完全に削除します。実行中のRunはスキップされます。この操作は元に戻せません。`}
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
