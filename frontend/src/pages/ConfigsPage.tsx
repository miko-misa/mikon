import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ConfigInstance } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Settings2, Trash2, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface ConfigsPageProps {
  navigate: (path: string) => void;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ConfigsPage({ navigate }: ConfigsPageProps) {
  const [configs, setConfigs] = useState<ConfigInstance[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    try {
      const cs = await api.get<ConfigInstance[]>("/api/configs");
      setConfigs(cs);
    } catch (e) {
      toast.error(String(e));
    }
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(name: string) {
    setDeleting(name);
    try {
      await api.delete(`/api/configs/${name}`);
      toast.success(`Config "${name}" deleted`);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Saved Configs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reusable job configurations
        </p>
      </div>

      {configs == null ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : configs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-16 text-center">
          <Settings2 className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium">No saved configs</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Save configs from the job launch page
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Job</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Created</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {configs.map((cfg) => (
                <tr
                  key={cfg.name}
                  className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">{cfg.name}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs">
                      {cfg.job}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDate(cfg.created_at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDate(cfg.updated_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigate(`/jobs/${cfg.job}?config=${cfg.name}`)
                        }
                      >
                        <ExternalLink className="h-4 w-4" />
                        Load
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(cfg.name)}
                        disabled={deleting === cfg.name}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
