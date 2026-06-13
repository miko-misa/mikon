import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DatasetInfo, DatasetBuilderDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Database, Plus, Trash2, FileCode, Hammer } from "lucide-react";
import { toast } from "sonner";

interface DatasetsPageProps {
  navigate: (path: string) => void;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DatasetsPage({ navigate }: DatasetsPageProps) {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [builders, setBuilders] = useState<DatasetBuilderDetail[] | null>(null);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  async function load() {
    try {
      const [ds, bs] = await Promise.all([
        api.get<DatasetInfo[]>("/api/datasets"),
        api.get<DatasetBuilderDetail[]>("/api/dataset-builders"),
      ]);
      setDatasets(ds);
      setBuilders(bs);
    } catch (e) {
      toast.error(String(e));
    }
  }

  useEffect(() => { load(); }, []);

  async function handleRegister() {
    if (!newName.trim() || !newPath.trim()) return;
    setCreating(true);
    try {
      await api.post("/api/datasets", {
        name: newName.trim(),
        path: newPath.trim(),
        description: newDesc.trim() || null,
      });
      toast.success(`Dataset "${newName}" registered`);
      setOpen(false);
      setNewName("");
      setNewPath("");
      setNewDesc("");
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(name: string) {
    setDeletingName(name);
    try {
      await api.delete(`/api/datasets/${name}`);
      toast.success(`Dataset "${name}" deleted`);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Datasets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Registered datasets and dataset builders
        </p>
      </div>

      {/* Registered datasets */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Registered Datasets</h2>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" />
                Register Dataset
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Register Dataset</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="my_dataset"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Path</Label>
                  <Input
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="/data/my_dataset"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Description (optional)</Label>
                  <Textarea
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Describe the dataset..."
                    rows={2}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleRegister}
                  disabled={creating || !newName.trim() || !newPath.trim()}
                >
                  {creating ? "Registering..." : "Register"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {datasets == null ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : datasets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <Database className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No datasets registered</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Path</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Source</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Created</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {datasets.map((ds) => (
                  <tr
                    key={ds.name}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <div>
                        <span className="font-medium">{ds.name}</span>
                        {ds.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {ds.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <code className="text-xs font-mono text-muted-foreground">
                        {ds.path}
                      </code>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className="text-xs">
                        {ds.source}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {formatDate(ds.created_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(ds.name)}
                        disabled={deletingName === ds.name}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Dataset builders */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Dataset Builders</h2>
        {builders == null ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : builders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <Hammer className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No dataset builders found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {builders.map((b) => (
              <Card
                key={b.name}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/datasets/${b.name}`)}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Hammer className="h-4 w-4 text-primary shrink-0" />
                    {b.name}
                  </CardTitle>
                  {b.doc && (
                    <CardDescription className="text-xs line-clamp-2">
                      {b.doc}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <FileCode className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {b.source_file}:{b.lineno}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
