import { cn } from "@/lib/utils";
import type { Route, ResourceSnapshot } from "@/lib/types";
import {
  LayoutDashboard,
  Zap,
  Play,
  Layers,
  Settings2,
  Database,
  BookOpen,
  Cpu,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface SidebarProps {
  navigate: (path: string) => void;
  currentRoute: Route;
}

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  path: string;
  routeKind: Route["kind"] | Route["kind"][];
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    path: "/",
    routeKind: "dashboard",
  },
  { label: "Jobs", icon: Zap, path: "/jobs", routeKind: ["job"] },
  { label: "Runs", icon: Play, path: "/runs", routeKind: ["run", "compare"] },
  { label: "Groups", icon: Layers, path: "/groups", routeKind: ["group", "groups"] },
  { label: "Configs", icon: Settings2, path: "/configs", routeKind: "configs" },
  {
    label: "Datasets",
    icon: Database,
    path: "/datasets",
    routeKind: ["datasets", "datasetBuilder"],
  },
  { label: "Docs", icon: BookOpen, path: "/docs", routeKind: "docs" },
];

function isActive(item: NavItem, route: Route): boolean {
  const kinds = Array.isArray(item.routeKind)
    ? item.routeKind
    : [item.routeKind];
  if (kinds.includes(route.kind)) return true;
  // Special: /jobs page shows "Jobs" nav as active but route.kind is "job"
  // This is already handled above. /runs list shows Runs.
  return false;
}

function ResourceBar() {
  const [snap, setSnap] = useState<ResourceSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const s = await api.get<ResourceSnapshot>("/api/resources");
        if (!cancelled) setSnap(s);
      } catch {
        // ignore
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!snap) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        Loading resources...
      </div>
    );
  }

  const gpuCount = snap.gpus.length;
  const freeGpus = snap.gpus.filter((g) => !g.occupied).length;

  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Cpu className="h-3 w-3" />
        <span>CPU {snap.machine.cpu_pct.toFixed(0)}%</span>
      </div>
      {gpuCount > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Zap className="h-3 w-3" />
          <span>
            {freeGpus}/{gpuCount} GPU free
          </span>
        </div>
      )}
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary/60"
          style={{
            width: `${(snap.machine.mem_used_mib / snap.machine.mem_total_mib) * 100}%`,
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {(snap.machine.mem_used_mib / 1024).toFixed(1)} /{" "}
        {(snap.machine.mem_total_mib / 1024).toFixed(1)} GB RAM
      </p>
    </div>
  );
}

export function Sidebar({ navigate, currentRoute }: SidebarProps) {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <span className="text-xs font-bold text-primary-foreground">M</span>
        </div>
        <span className="font-semibold tracking-tight">mikon</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3">
        <ul className="space-y-0.5 px-2">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item, currentRoute);
            const Icon = item.icon;
            return (
              <li key={item.path}>
                <button
                  type="button"
                  onClick={() => navigate(item.path)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Resource indicator */}
      <div className="border-t border-border">
        <ResourceBar />
      </div>
    </aside>
  );
}
