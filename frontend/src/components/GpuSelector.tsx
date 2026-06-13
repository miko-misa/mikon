import { cn } from "@/lib/utils";
import type { GpuInfo } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Thermometer, Zap } from "lucide-react";

interface GpuSelectorProps {
  gpus: GpuInfo[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

function MemBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{used} MiB</span>
        <span>{total} MiB</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct > 90
              ? "bg-red-500"
              : pct > 70
              ? "bg-yellow-500"
              : "bg-blue-500"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function hasMixedVendors(gpus: GpuInfo[], ids: string[]): boolean {
  const selected = gpus.filter((g) => ids.includes(g.id));
  const vendors = new Set(selected.map((g) => g.vendor));
  return vendors.size > 1;
}

export function GpuSelector({
  gpus,
  selected,
  onChange,
  disabled = false,
}: GpuSelectorProps) {
  const mixedVendors = hasMixedVendors(gpus, selected);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  if (gpus.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        <Zap className="h-4 w-4" />
        No GPU detected — will run on CPU
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {gpus.map((gpu) => {
          const isSelected = selected.includes(gpu.id);
          return (
            <button
              key={gpu.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(gpu.id)}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-all hover:border-primary/50",
                isSelected
                  ? "border-primary/70 bg-primary/5"
                  : "border-border bg-card",
                gpu.occupied && !isSelected && "border-red-500/30 opacity-75",
                disabled && "cursor-not-allowed opacity-50"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">
                      {gpu.name}
                    </span>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {gpu.id}
                    </Badge>
                    {gpu.occupied && (
                      <Badge
                        variant="outline"
                        className="text-xs border-red-500/40 bg-red-500/10 text-red-400 shrink-0"
                      >
                        Occupied
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2">
                    <MemBar used={gpu.mem_used_mib} total={gpu.mem_total_mib} />
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0 text-xs text-muted-foreground">
                  <span>{gpu.util_pct}% util</span>
                  {gpu.temp_c != null && (
                    <span className="flex items-center gap-1">
                      <Thermometer className="h-3 w-3" />
                      {gpu.temp_c}°C
                    </span>
                  )}
                  {gpu.power_w != null && <span>{gpu.power_w}W</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {mixedVendors && (
        <p className="text-xs text-red-400">
          Cannot mix different GPU vendors (NVIDIA and AMD) in a single run.
        </p>
      )}
    </div>
  );
}
