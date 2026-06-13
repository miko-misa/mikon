import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Group, RunSummary } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { GitCompare, Edit2, Check } from "lucide-react";
import { toast } from "sonner";

interface GroupDetailPageProps {
  groupId: string;
  navigate: (path: string) => void;
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

export function GroupDetailPage({ groupId, navigate }: GroupDetailPageProps) {
  const [group, setGroup] = useState<Group | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [g, allRuns] = await Promise.all([
          api.get<Group>(`/api/groups/${groupId}`),
          api.get<RunSummary[]>("/api/runs?limit=1000"),
        ]);
        if (cancelled) return;
        setGroup(g);
        setName(g.name);
        setDesc(g.description ?? "");
        setRuns(allRuns.filter((r) => r.annotations.group_ids.includes(groupId)));
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [groupId]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.patch<Group>(`/api/groups/${groupId}`, {
        name,
        description: desc || null,
      });
      setGroup(updated);
      setEditing(false);
      toast.success("Group updated");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleCompareAll() {
    if (!runs || runs.length < 2) return;
    navigate(`/compare?ids=${runs.map((r) => r.run_id).join(",")}`);
  }

  if (!group) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-xl font-bold"
              />
              <Textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="Description..."
                rows={2}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setName(group.name);
                    setDesc(group.description ?? "");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">{group.name}</h1>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setEditing(true)}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {group.description && (
                <p className="text-sm text-muted-foreground mt-1">
                  {group.description}
                </p>
              )}
            </div>
          )}
        </div>
        {(runs?.length ?? 0) >= 2 && (
          <Button variant="outline" size="sm" onClick={handleCompareAll}>
            <GitCompare className="h-4 w-4" />
            Compare all
          </Button>
        )}
      </div>

      {/* Runs */}
      <div>
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">
          Runs ({runs?.length ?? "..."})
        </Label>
        {runs == null ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">No runs in this group</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Run ID</th>
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
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs text-muted-foreground">
                        {run.run_id}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium">{run.job}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {formatDate(run.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
