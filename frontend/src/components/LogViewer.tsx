import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LogViewerProps {
  runId: string;
  running: boolean;
}

type StreamType = "all" | "stdout" | "stderr";

export function LogViewer({ runId, running }: LogViewerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [stream, setStream] = useState<StreamType>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLPreElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const autoScrollRef = useRef(true);

  // Initial log fetch
  useEffect(() => {
    setLoading(true);
    setLines([]);
    setError(null);
    const streamParam = stream === "all" ? "stdout" : stream;
    fetch(`/api/runs/${runId}/logs?stream=${streamParam}&tail=200`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setLines(text ? text.split("\n") : []);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
  }, [runId, stream]);

  // SSE streaming when running
  useEffect(() => {
    if (!running) return;
    if (esRef.current) {
      esRef.current.close();
    }
    const es = new EventSource(
      `/api/runs/${runId}/logs/stream?stream=${stream}`
    );
    esRef.current = es;

    es.onmessage = (e) => {
      const text = e.data as string;
      if (!text) return;
      setLines((prev) => [...prev, ...text.split("\n")]);
    };

    es.onerror = () => {
      // SSE will retry automatically; don't show error for normal close
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [runId, running, stream]);

  // Auto-scroll
  useEffect(() => {
    if (autoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {(["all", "stdout", "stderr"] as StreamType[]).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={stream === s ? "secondary" : "ghost"}
            onClick={() => setStream(s)}
          >
            {s}
          </Button>
        ))}
        {running && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
            </span>
            Live
          </span>
        )}
      </div>
      <pre
        ref={containerRef}
        onScroll={handleScroll}
        className={cn(
          "h-96 overflow-auto rounded-lg bg-black/50 p-4 text-xs font-mono text-green-300 border border-border",
          "whitespace-pre-wrap break-words"
        )}
      >
        {loading && (
          <span className="text-muted-foreground">Loading logs...</span>
        )}
        {error && <span className="text-red-400">Error: {error}</span>}
        {!loading && !error && lines.length === 0 && (
          <span className="text-muted-foreground">No log output yet.</span>
        )}
        {lines.join("\n")}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}
