import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Group, RunSummary } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AlertTriangle, Layers, Plus } from "lucide-react";
import { toast } from "sonner";

interface GroupsPageProps {
  navigate: (path: string) => void;
}

export function GroupsPage({ navigate }: GroupsPageProps) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadGroups() {
    try {
      setError(null);
      const [gs, runs] = await Promise.all([
        api.get<Group[]>("/api/groups"),
        api.get<RunSummary[]>("/api/runs?limit=500"),
      ]);
      setGroups(gs);
      const counts: Record<string, number> = {};
      for (const r of runs) {
        for (const gid of r.annotations.group_ids) {
          counts[gid] = (counts[gid] ?? 0) + 1;
        }
      }
      setRunCounts(counts);
    } catch (e) {
      const message = String(e);
      setError(message);
      toast.error(message);
    }
  }

  useEffect(() => { loadGroups(); }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.post("/api/groups", {
        name: newName.trim(),
        description: newDesc.trim() || null,
      });
      toast.success(`Group "${newName}" created`);
      setOpen(false);
      setNewName("");
      setNewDesc("");
      await loadGroups();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Groups</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Organize runs into groups
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4" />
              New Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Group</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Group name..."
                />
              </div>
              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="What is this group for?"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 p-12 text-center">
          <AlertTriangle className="mb-3 h-10 w-10 text-destructive" />
          <h3 className="text-sm font-medium">Groups failed to load</h3>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={loadGroups}>
            Retry
          </Button>
        </div>
      ) : groups == null ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-16 text-center">
          <Layers className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium">No groups yet</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Create a group to organize your runs
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((g) => (
            <Card
              key={g.id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => navigate(`/groups/${g.id}`)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary shrink-0" />
                  {g.name}
                </CardTitle>
                {g.description && (
                  <CardDescription className="text-xs line-clamp-2">
                    {g.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground">
                  {runCounts[g.id] ?? 0} run
                  {(runCounts[g.id] ?? 0) !== 1 ? "s" : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
