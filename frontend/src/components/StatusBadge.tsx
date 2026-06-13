import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type Status = "running" | "completed" | "failed" | "stopped" | "unknown";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  if (status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs font-semibold text-blue-400",
          className
        )}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
        </span>
        Running
      </span>
    );
  }

  if (status === "completed") {
    return (
      <Badge
        className={cn(
          "border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/10",
          className
        )}
        variant="outline"
      >
        Completed
      </Badge>
    );
  }

  if (status === "failed") {
    return (
      <Badge
        className={cn(
          "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/10",
          className
        )}
        variant="outline"
      >
        Failed
      </Badge>
    );
  }

  if (status === "stopped") {
    return (
      <Badge
        className={cn(
          "border-zinc-500/30 bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/10",
          className
        )}
        variant="outline"
      >
        Stopped
      </Badge>
    );
  }

  return (
    <Badge
      className={cn(
        "border-yellow-500/30 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/10",
        className
      )}
      variant="outline"
    >
      Unknown
    </Badge>
  );
}
