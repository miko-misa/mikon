import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type {
  RunDetail,
  MetricRecord,
  MetricsResponse,
  Artifact,
  LineageGraph,
  Group,
} from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { MetricChart } from "@/components/MetricChart";
import { LogViewer } from "@/components/LogViewer";
import { TagInput } from "@/components/TagInput";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Star,
  Square,
  Download,
  Folder,
  FileText,
  ChevronDown,
  ChevronRight,
  X,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface RunDetailPageProps {
  runId: string;
  navigate: (path: string) => void;
}

function calcDuration(start?: string | null, end?: string | null): string {
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

function useLiveDuration(
  start?: string | null,
  end?: string | null,
  running = false
) {
  const [duration, setDuration] = useState(() => calcDuration(start, end));
  useEffect(() => {
    setDuration(calcDuration(start, end));
    if (!running || !start || end) return;
    const id = setInterval(() => setDuration(calcDuration(start, null)), 1000);
    return () => clearInterval(id);
  }, [start, end, running]);
  return duration;
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

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}

// ─── Annotations section ────────────────────────────────────────────────────

function AnnotationsSection({
  run,
  onRunChange,
  navigate,
}: {
  run: RunDetail;
  onRunChange: (r: RunDetail) => void;
  navigate: (path: string) => void;
}) {
  const hasContent =
    !!run.annotations.title ||
    run.annotations.tags.length > 0 ||
    !!run.annotations.memo;
  const [open, setOpen] = useState(hasContent);
  const [title, setTitle] = useState(run.annotations.title ?? "");
  const [memo, setMemo] = useState(run.annotations.memo ?? "");
  const [tags, setTags] = useState<string[]>(run.annotations.tags);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync state when run_id changes (navigating between runs)
  useEffect(() => {
    setTitle(run.annotations.title ?? "");
    setMemo(run.annotations.memo ?? "");
    setTags(run.annotations.tags);
  }, [run.run_id]);

  useEffect(() => {
    api.get<Group[]>("/api/groups").then(setGroups).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.patch<RunDetail>(`/api/runs/${run.run_id}`, {
        title: title.trim() || null,
        memo: memo.trim() || null,
        tags,
        star: run.annotations.star,
        group_ids: run.annotations.group_ids,
      });
      onRunChange(updated);
      toast.success("Annotations saved");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function addToGroup() {
    if (!selectedGroup) return;
    try {
      const ids = [...new Set([...run.annotations.group_ids, selectedGroup])];
      const updated = await api.patch<RunDetail>(`/api/runs/${run.run_id}`, {
        ...run.annotations,
        group_ids: ids,
      });
      onRunChange(updated);
      setSelectedGroup("");
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function removeFromGroup(gid: string) {
    try {
      const ids = run.annotations.group_ids.filter((g) => g !== gid);
      const updated = await api.patch<RunDetail>(`/api/runs/${run.run_id}`, {
        ...run.annotations,
        group_ids: ids,
      });
      onRunChange(updated);
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Header row — always visible */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-accent/20 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="font-medium text-xs text-muted-foreground uppercase tracking-wider shrink-0">
            Annotations
          </span>
          {run.annotations.tags.map((t) => (
            <Badge key={t} variant="secondary" className="text-xs">
              {t}
            </Badge>
          ))}
          {run.annotations.title && (
            <span className="text-xs text-muted-foreground italic truncate">
              "{run.annotations.title}"
            </span>
          )}
          {!hasContent && !open && (
            <span className="text-xs text-muted-foreground">
              Click to add title, tags, memo...
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
        )}
      </button>

      {/* Expanded form */}
      {open && (
        <div className="border-t border-border px-4 py-4 space-y-3 bg-muted/10">
          <div className="grid gap-y-3">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-4">
              <Label className="text-sm w-16 shrink-0">Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Run title..."
              />
            </div>
            <div className="grid grid-cols-[auto_1fr] items-start gap-x-4">
              <Label className="text-sm w-16 shrink-0 pt-1.5">Tags</Label>
              <TagInput value={tags} onChange={setTags} />
            </div>
            <div className="grid grid-cols-[auto_1fr] items-start gap-x-4">
              <Label className="text-sm w-16 shrink-0 pt-1.5">Memo</Label>
              <Textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Notes about this run..."
                rows={2}
              />
            </div>
            <div className="grid grid-cols-[auto_1fr] items-start gap-x-4">
              <Label className="text-sm w-16 shrink-0 pt-1.5">Groups</Label>
              <div className="space-y-2">
                {run.annotations.group_ids.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {run.annotations.group_ids.map((gid) => {
                      const g = groups.find((gr) => gr.id === gid);
                      return (
                        <Badge
                          key={gid}
                          variant="secondary"
                          className="gap-1 cursor-pointer pl-2 pr-1"
                          onClick={() => navigate(`/groups/${gid}`)}
                        >
                          {g?.name ?? gid}
                          <button
                            type="button"
                            className="rounded-full hover:text-destructive transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFromGroup(gid);
                            }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  <Select
                    value={selectedGroup}
                    onValueChange={setSelectedGroup}
                  >
                    <SelectTrigger className="flex-1 max-w-xs">
                      <SelectValue placeholder="Add to group..." />
                    </SelectTrigger>
                    <SelectContent>
                      {groups
                        .filter(
                          (g) => !run.annotations.group_ids.includes(g.id)
                        )
                        .map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addToGroup}
                    disabled={!selectedGroup}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({
  run,
  onRunChange,
  navigate,
}: {
  run: RunDetail;
  onRunChange: (r: RunDetail) => void;
  navigate: (path: string) => void;
}) {
  return (
    <div className="space-y-4">
      <AnnotationsSection run={run} onRunChange={onRunChange} navigate={navigate} />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md bg-muted/30 p-4 text-xs font-mono max-h-96">
            {JSON.stringify(run.config, null, 2)}
          </pre>
        </CardContent>
      </Card>
      {run.error && (
        <Card className="border-destructive/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-md bg-destructive/10 p-4 text-xs font-mono text-destructive max-h-48">
              {run.error}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Metrics Tab ─────────────────────────────────────────────────────────────

function MetricsTab({
  runId,
  metricNames,
  status,
}: {
  runId: string;
  metricNames: string[];
  status: string;
}) {
  const [records, setRecords] = useState<MetricRecord[]>([]);
  const [visibleNames, setVisibleNames] = useState<string[]>(metricNames);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadMetrics() {
    if (metricNames.length === 0) return;
    try {
      const data = await api.get<MetricsResponse>(`/api/runs/${runId}/metrics`);
      setRecords(data.records);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    setVisibleNames((prev) => {
      const added = metricNames.filter((n) => !prev.includes(n));
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, [metricNames]);

  useEffect(() => {
    loadMetrics();
    if (status === "running") {
      intervalRef.current = setInterval(loadMetrics, 2000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [runId, status]);

  if (metricNames.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        No metrics recorded yet
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {metricNames.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() =>
              setVisibleNames((prev) =>
                prev.includes(name)
                  ? prev.filter((n) => n !== name)
                  : [...prev, name]
              )
            }
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              visibleNames.includes(name)
                ? "border-primary/70 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground"
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <MetricChart
        records={records.filter((r) => visibleNames.includes(r.name))}
        names={visibleNames}
      />
    </div>
  );
}

// ─── Artifacts Tab ───────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"]);
const TEXT_EXTS = new Set([
  ".txt", ".log", ".py", ".json", ".yaml", ".yml", ".toml", ".md",
  ".csv", ".sh", ".ts", ".tsx", ".js", ".jsx", ".html", ".css",
  ".xml", ".ini", ".cfg", ".conf", ".rs", ".go", ".java", ".c",
  ".cpp", ".h", ".rb", ".php", ".swift", ".kt",
]);
const PDF_EXTS = new Set([".pdf"]);

type PreviewKind = "image" | "video" | "audio" | "text" | "pdf" | "none";

function getPreviewKind(path: string): PreviewKind {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "none";
  const ext = path.slice(dot).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (TEXT_EXTS.has(ext)) return "text";
  if (PDF_EXTS.has(ext)) return "pdf";
  return "none";
}

function artifactUrl(runId: string, path: string) {
  return `/api/runs/${runId}/artifacts/${path}`;
}

interface PreviewState {
  artifact: Artifact;
  kind: PreviewKind;
  text?: string;
}

function ArtifactsTab({ runId }: { runId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    api
      .get<Artifact[]>(`/api/runs/${runId}/artifacts`)
      .then(setArtifacts)
      .catch(() => setArtifacts([]));
  }, [runId]);

  async function openPreview(artifact: Artifact) {
    if (artifact.kind === "dir") return;
    const kind = getPreviewKind(artifact.path);
    if (kind === "none") {
      window.open(artifactUrl(runId, artifact.path), "_blank");
      return;
    }
    if (kind === "text") {
      setLoadingPreview(true);
      try {
        const text = await fetch(artifactUrl(runId, artifact.path)).then((r) =>
          r.text()
        );
        setPreview({ artifact, kind, text });
      } catch {
        setPreview({ artifact, kind, text: "(Failed to load file)" });
      } finally {
        setLoadingPreview(false);
      }
    } else {
      setPreview({ artifact, kind });
    }
  }

  if (artifacts == null) {
    return (
      <div className="space-y-2">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        No artifacts yet
      </div>
    );
  }

  const previewable = (a: Artifact) =>
    a.kind === "file" && getPreviewKind(a.path) !== "none";

  return (
    <>
      <div className="space-y-1">
        {artifacts.map((a) => (
          <div
            key={a.path}
            className={cn(
              "flex items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors",
              a.kind === "file"
                ? "hover:bg-accent/30 cursor-pointer"
                : "cursor-default opacity-70"
            )}
            onClick={() => a.kind === "file" && openPreview(a)}
          >
            <div className="flex items-center gap-2 min-w-0">
              {a.kind === "dir" ? (
                <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <span className="text-sm font-mono truncate">{a.path}</span>
              {previewable(a) && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {getPreviewKind(a.path)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0 ml-3">
              <span className="text-xs text-muted-foreground">
                {formatSize(a.size)}
              </span>
              {a.kind === "file" && (
                <a
                  href={artifactUrl(runId, a.path)}
                  download
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={preview != null || loadingPreview}
        onOpenChange={(o) => !o && setPreview(null)}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm truncate">
              {preview?.artifact.path ?? "Loading..."}
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-auto max-h-[70vh]">
            {loadingPreview && (
              <Skeleton className="h-40 w-full" />
            )}
            {preview?.kind === "image" && (
              <img
                src={artifactUrl(runId, preview.artifact.path)}
                className="max-w-full mx-auto rounded-md"
                alt={preview.artifact.path}
              />
            )}
            {preview?.kind === "video" && (
              <video
                src={artifactUrl(runId, preview.artifact.path)}
                controls
                className="max-w-full w-full rounded-md"
              />
            )}
            {preview?.kind === "audio" && (
              <div className="py-4">
                <audio
                  src={artifactUrl(runId, preview.artifact.path)}
                  controls
                  className="w-full"
                />
              </div>
            )}
            {preview?.kind === "text" && (
              <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 rounded-md p-4">
                {preview.text}
              </pre>
            )}
            {preview?.kind === "pdf" && (
              <iframe
                src={artifactUrl(runId, preview.artifact.path)}
                className="w-full h-[65vh] rounded-md"
                title={preview.artifact.path}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Lineage Tab (ReactFlow graph) ──────────────────────────────────────────

import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node as RFNode,
  type Edge as RFEdge,
  MarkerType,
  Handle,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "@dagrejs/dagre";
import {
  Play,
  Database,
  Code2,
  Paperclip,
} from "lucide-react";

const NODE_W = 190;
const NODE_H = 64;

function layoutGraph(nodes: RFNode[], edges: RFEdge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 } };
  });
}

const NODE_STYLES: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  run:      { icon: Play,      color: "border-blue-500/60 bg-blue-500/10" },
  dataset:  { icon: Database,  color: "border-green-500/60 bg-green-500/10" },
  module:   { icon: Code2,     color: "border-purple-500/60 bg-purple-500/10" },
  artifact: { icon: Paperclip, color: "border-zinc-500/60 bg-zinc-500/10" },
};

interface LineageNodeData {
  label: string;
  nodeType: string;
  isCurrent: boolean;
  navigate: (path: string) => void;
  nodeId: string;
}

function LineageNode({ data }: { data: LineageNodeData }) {
  const style = NODE_STYLES[data.nodeType] ?? NODE_STYLES.artifact;
  const Icon = style.icon;
  const isRun = data.nodeType === "run";

  return (
    <div
      className={cn(
        "rounded-lg border-2 px-3 py-2 text-xs shadow-sm select-none transition-all",
        style.color,
        data.isCurrent && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        isRun && "cursor-pointer hover:brightness-110"
      )}
      style={{ width: NODE_W, minHeight: NODE_H }}
      onClick={() => {
        if (isRun) {
          const runId = data.nodeId.startsWith("run:") ? data.nodeId.slice(4) : data.nodeId;
          data.navigate(`/runs/${runId}`);
        }
      }}
    >
      <Handle type="target" position={Position.Top} className="bg-muted-foreground!" />
      <div className="flex items-start gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 opacity-70" />
        <div className="min-w-0">
          <p className="font-medium truncate leading-tight">{data.label}</p>
          <p className="text-muted-foreground opacity-80 capitalize mt-0.5">
            {data.nodeType}
            {data.isCurrent && (
              <span className="ml-1 text-primary font-semibold">← current</span>
            )}
          </p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="bg-muted-foreground!" />
    </div>
  );
}

const nodeTypes = { lineageNode: LineageNode };

function LineageTab({
  runId,
  navigate,
}: {
  runId: string;
  navigate: (path: string) => void;
}) {
  const [lineage, setLineage] = useState<LineageGraph | null>(null);

  useEffect(() => {
    api
      .get<LineageGraph>(`/api/runs/${runId}/lineage`)
      .then(setLineage)
      .catch(() => {});
  }, [runId]);

  if (!lineage) {
    return <Skeleton className="h-96 w-full" />;
  }

  // Nodes that are collapsed into another are hidden
  const visibleNodeIds = new Set(
    lineage.nodes.filter((n) => !n.collapsed_into).map((n) => n.id)
  );

  const rfNodes: RFNode[] = lineage.nodes
    .filter((n) => visibleNodeIds.has(n.id))
    .map((n) => ({
      id: n.id,
      type: "lineageNode",
      position: { x: 0, y: 0 },
      data: {
        label: n.label,
        nodeType: n.type,
        isCurrent: n.id === lineage.center,
        navigate,
        nodeId: n.id,
      } satisfies LineageNodeData,
    }));

  const rfEdges: RFEdge[] = lineage.edges
    .filter((e) => visibleNodeIds.has(e.src) && visibleNodeIds.has(e.dst))
    .map((e, i) => ({
      id: `e-${i}`,
      source: e.src,
      target: e.dst,
      label: e.type.replace(/-/g, " "),
      labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
      labelBgStyle: { fill: "hsl(var(--background))", fillOpacity: 0.8 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1.5 },
      animated: e.type === "produces-dataset",
    }));

  if (rfNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        No lineage data
      </div>
    );
  }

  const layoutedNodes = layoutGraph(rfNodes, rfEdges);

  return (
    <div className="h-130 rounded-lg border border-border overflow-hidden">
      <ReactFlow
        nodes={layoutedNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="hsl(var(--muted-foreground))" gap={20} size={0.5} />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const t = (n.data as LineageNodeData).nodeType;
            if (t === "run") return "#3b82f6";
            if (t === "dataset") return "#22c55e";
            if (t === "module") return "#a855f7";
            return "#71717a";
          }}
          maskColor="rgba(0,0,0,0.3)"
        />
      </ReactFlow>
    </div>
  );
}

// ─── Main RunDetailPage ───────────────────────────────────────────────────────

export function RunDetailPage({ runId, navigate }: RunDetailPageProps) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [stopping, setStopping] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await api.get<RunDetail>(`/api/runs/${runId}`);
      setRun(r);
      return r;
    } catch (e: unknown) {
      toast.error(String(e));
      return null;
    }
  }, [runId]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const r = await fetchRun();
      if (cancelled || !r) return;
      if (r.status === "running") {
        intervalRef.current = setInterval(async () => {
          const updated = await api
            .get<RunDetail>(`/api/runs/${runId}`)
            .catch(() => null);
          if (!cancelled && updated) setRun(updated);
        }, 3000);
      }
    }

    init();
    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [runId, fetchRun]);

  const duration = useLiveDuration(
    run?.started_at,
    run?.ended_at,
    run?.status === "running"
  );

  async function toggleStar() {
    if (!run) return;
    try {
      const updated = await api.patch<RunDetail>(`/api/runs/${runId}`, {
        ...run.annotations,
        star: !run.annotations.star,
      });
      setRun(updated);
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.delete(`/api/runs/${runId}`);
      toast.success("Run deleted");
      navigate("/runs");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await api.post(`/api/runs/${runId}/stop`);
      const updated = await api.get<RunDetail>(`/api/runs/${runId}`);
      setRun(updated);
      toast.success("Run stopped");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStopping(false);
    }
  }

  if (!run) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const displayTitle = run.annotations.title ?? run.run_id;
  const isTitleId = !run.annotations.title;

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1
            className={cn(
              "text-xl font-bold leading-tight",
              isTitleId && "font-mono"
            )}
          >
            {displayTitle}
          </h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-sm text-muted-foreground">{run.job}</span>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>Created {run.created_at ? formatDate(run.created_at) : "—"}</span>
            <span>Duration: {duration}</span>
            {run.gpus.length > 0 && (
              <div className="flex gap-1">
                {run.gpus.map((g) => (
                  <Badge key={g} variant="outline" className="text-xs">
                    {g}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleStar}
            title={run.annotations.star ? "Unstar" : "Star"}
          >
            <Star
              className={cn(
                "h-5 w-5",
                run.annotations.star
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground"
              )}
            />
          </Button>
          {run.status === "running" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleStop}
              disabled={stopping}
            >
              <Square className="h-4 w-4" />
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDeleteOpen(true)}
            title="Delete run"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete run?"
          description={
            <span>
              Run <code className="font-mono text-xs bg-muted px-1 rounded">{runId}</code> とそのファイルを完全に削除します。この操作は元に戻せません。
            </span>
          }
          confirmLabel="Delete"
          onConfirm={handleDelete}
          loading={deleting}
        />
      </div>

      {/* ── Tabs ── */}
      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="metrics">
            Metrics
            {run.metric_names.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {run.metric_names.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="artifacts">
            Artifacts
            {run.artifact_count > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {run.artifact_count}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="lineage">Lineage</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab run={run} onRunChange={setRun} navigate={navigate} />
        </TabsContent>

        <TabsContent value="metrics" className="mt-4">
          <MetricsTab
            runId={run.run_id}
            metricNames={run.metric_names}
            status={run.status}
          />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <LogViewer runId={runId} running={run.status === "running"} />
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4">
          <ArtifactsTab runId={runId} />
        </TabsContent>

        <TabsContent value="lineage" className="mt-4">
          <LineageTab runId={runId} navigate={navigate} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
