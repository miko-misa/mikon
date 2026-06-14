import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  type Edge as RFEdge,
  type Node as RFNode,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "@dagrejs/dagre";
import {
  Box,
  Code2,
  Database,
  GitBranch,
  Link2,
  Paperclip,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Artifact, DatasetInfo, LineageGraph, RunDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type LineageNodeType = LineageGraph["nodes"][number]["type"];
type LineageNodeModel = LineageGraph["nodes"][number];
type LineageEdgeModel = LineageGraph["edges"][number];
type Direction = "ancestors" | "descendants" | "both";

const NODE_WIDTH = 230;
const NODE_HEIGHT = 82;

const NODE_META: Record<
  LineageNodeType,
  {
    icon: ComponentType<{ className?: string }>;
    accent: string;
    text: string;
    minimap: string;
  }
> = {
  run: {
    icon: Play,
    accent: "border-sky-400/70 bg-sky-500/10 shadow-sky-950/50",
    text: "text-sky-200",
    minimap: "#38bdf8",
  },
  dataset: {
    icon: Database,
    accent: "border-emerald-400/70 bg-emerald-500/10 shadow-emerald-950/50",
    text: "text-emerald-200",
    minimap: "#34d399",
  },
  module: {
    icon: Code2,
    accent: "border-violet-400/70 bg-violet-500/10 shadow-violet-950/50",
    text: "text-violet-200",
    minimap: "#a78bfa",
  },
  artifact: {
    icon: Paperclip,
    accent: "border-zinc-400/60 bg-zinc-500/10 shadow-zinc-950/50",
    text: "text-zinc-200",
    minimap: "#a1a1aa",
  },
};

const EDGE_META: Record<
  string,
  { color: string; label: string; dashed?: boolean; animated?: boolean }
> = {
  "uses-dataset": { color: "#34d399", label: "uses dataset" },
  "produces-dataset": { color: "#22d3ee", label: "produces dataset", animated: true },
  "consumes-artifact": { color: "#f59e0b", label: "consumes artifact" },
  "composed-of-module": { color: "#a78bfa", label: "composed of" },
  manual: { color: "#e5e7eb", label: "manual", dashed: true },
};

type LineageCanvasNodeData = {
  node: LineageNodeModel;
  isCurrent: boolean;
  isSelected: boolean;
};

type NodeConfigState = {
  title: string;
  payload: unknown;
  loading: boolean;
  error: string | null;
};

function layoutGraph(nodes: RFNode[], edges: RFEdge[]) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 52,
    ranksep: 120,
    marginx: 32,
    marginy: 32,
  });
  nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);
  return nodes.map((node) => {
    const position = graph.node(node.id);
    return {
      ...node,
      position: {
        x: position.x - NODE_WIDTH / 2,
        y: position.y - NODE_HEIGHT / 2,
      },
    };
  });
}

function LineageCanvasNode({ data }: { data: LineageCanvasNodeData }) {
  const meta = NODE_META[data.node.type];
  const Icon = meta.icon;
  const details = nodeDetails(data.node);

  return (
    <div
      className={cn(
        "group relative w-[230px] rounded-md border bg-zinc-950/95 shadow-xl backdrop-blur",
        "select-none transition-colors",
        meta.accent,
        data.isSelected
          ? "ring-2 ring-amber-300/90 ring-offset-2 ring-offset-zinc-950"
          : data.isCurrent && "ring-2 ring-white/70 ring-offset-2 ring-offset-zinc-950"
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border !border-zinc-950 !bg-zinc-200"
      />
      <div className="flex h-8 items-center gap-2 border-b border-white/10 px-3">
        <Icon className={cn("h-4 w-4", meta.text)} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", meta.text)}>
          {data.node.type}
        </span>
        {data.isCurrent && (
          <span className="ml-auto rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white">
            current
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="truncate text-sm font-medium text-zinc-50">{details.title}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-zinc-400">{details.subtitle}</div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border !border-zinc-950 !bg-zinc-200"
      />
    </div>
  );
}

const nodeTypes = { lineageCanvasNode: LineageCanvasNode };

function LineageGraphSurface({
  lineage,
  loading,
  error,
  selectedNodeId,
  selectedEdgeId,
  heightClassName = "h-[620px]",
  skeletonClassName = "h-[580px]",
  emptyTitle,
  emptyText,
  onNodeClick,
  onNodeDoubleClick,
  onEdgeClick,
  onPaneClick,
}: {
  lineage: LineageGraph | null;
  loading?: boolean;
  error?: string | null;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  heightClassName?: string;
  skeletonClassName?: string;
  emptyTitle: string;
  emptyText: string;
  onNodeClick?: (node: LineageNodeModel) => void;
  onNodeDoubleClick?: (node: LineageNodeModel) => void;
  onEdgeClick?: (edge: LineageEdgeModel, edgeId: string) => void;
  onPaneClick?: () => void;
}) {
  const graph = useMemo(() => {
    if (!lineage) return { nodes: [] as RFNode[], edges: [] as RFEdge[] };
    const visibleIds = new Set(lineage.nodes.map((node) => node.id));
    const nodes: RFNode[] = lineage.nodes.map((node) => ({
      id: node.id,
      type: "lineageCanvasNode",
      position: { x: 0, y: 0 },
      data: {
        node,
        isCurrent: node.id === lineage.center,
        isSelected: node.id === selectedNodeId,
      } satisfies LineageCanvasNodeData,
    }));
    const edges: RFEdge[] = lineage.edges
      .filter((edge) => visibleIds.has(edge.src) && visibleIds.has(edge.dst))
      .map((edge, index) => {
        const meta = EDGE_META[edge.type] ?? EDGE_META.manual;
        const id = edgeKey(edge, index);
        return {
          id,
          source: edge.src,
          target: edge.dst,
          type: "smoothstep",
          label: "",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: meta.color },
          style: {
            stroke: meta.color,
            strokeWidth: selectedEdgeId === id ? 3 : 2,
            strokeDasharray: meta.dashed ? "6 4" : undefined,
          },
          animated: meta.animated,
          data: edge,
        };
      });
    return { nodes: layoutGraph(nodes, edges), edges };
  }, [lineage, selectedEdgeId, selectedNodeId]);

  return (
    <div
      className={cn(
        "relative bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.18)_1px,transparent_0)] bg-[length:22px_22px]",
        heightClassName
      )}
    >
      {loading && !lineage ? (
        <div className="p-4">
          <Skeleton className={cn("w-full bg-zinc-800", skeletonClassName)} />
        </div>
      ) : error ? (
        <GraphState icon={<GitBranch className="h-8 w-8" />} title="Lineage failed to load" text={error} />
      ) : graph.nodes.length === 0 ? (
        <GraphState
          icon={<Box className="h-8 w-8" />}
          title={emptyTitle}
          text={emptyText}
        />
      ) : (
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.25}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            onNodeClick?.((node.data as LineageCanvasNodeData).node);
          }}
          onNodeDoubleClick={(_, node) => {
            onNodeDoubleClick?.((node.data as LineageCanvasNodeData).node);
          }}
          onEdgeClick={(_, edge) => {
            if (edge.data) {
              onEdgeClick?.(edge.data as LineageEdgeModel, edge.id);
            }
          }}
          onPaneClick={onPaneClick}
          defaultEdgeOptions={{ focusable: true }}
        >
          <Background color="rgba(148, 163, 184, 0.24)" gap={22} size={1} />
          <Controls className="!border-zinc-800 !bg-zinc-900 !text-zinc-100" />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) =>
              NODE_META[(node.data as LineageCanvasNodeData).node.type].minimap
            }
            maskColor="rgba(9, 9, 11, 0.72)"
            className="!border !border-zinc-800 !bg-zinc-950"
          />
        </ReactFlow>
      )}
    </div>
  );
}

export function LineageCanvas({
  runId,
  navigate,
}: {
  runId: string;
  navigate: (path: string) => void;
}) {
  const [direction, setDirection] = useState<Direction>("both");
  const [depth, setDepth] = useState("3");
  const [includeModules, setIncludeModules] = useState(true);
  const [lineage, setLineage] = useState<LineageGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeConfig, setNodeConfig] = useState<NodeConfigState | null>(null);

  const fetchLineage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        direction,
        depth,
        include_modules: String(includeModules),
      });
      const next = await api.get<LineageGraph>(
        `/api/runs/${encodeURIComponent(runId)}/lineage?${query.toString()}`
      );
      setLineage(next);
      setSelectedNodeId((current) =>
        current && next.nodes.some((node) => node.id === current) ? current : null
      );
      setSelectedEdgeId((current) =>
        current && next.edges.some((edge, index) => edgeKey(edge, index) === current)
          ? current
          : null
      );
    } catch (exc) {
      setError(String(exc));
      setLineage(null);
    } finally {
      setLoading(false);
    }
  }, [depth, direction, includeModules, runId]);

  useEffect(() => {
    void fetchLineage();
  }, [fetchLineage]);

  const selectedEdge = useMemo(() => {
    if (!lineage || !selectedEdgeId) return null;
    return lineage.edges.find((edge, index) => edgeKey(edge, index) === selectedEdgeId) ?? null;
  }, [lineage, selectedEdgeId]);

  const selectedNode = useMemo(() => {
    if (!lineage || !selectedNodeId) return null;
    return lineage.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [lineage, selectedNodeId]);

  useEffect(() => {
    if (!selectedNode) {
      setNodeConfig(null);
      return;
    }
    let cancelled = false;
    setNodeConfig({
      title: nodeConfigTitle(selectedNode),
      payload: null,
      loading: true,
      error: null,
    });
    void loadNodeConfig(selectedNode)
      .then((next) => {
        if (!cancelled) {
          setNodeConfig({ ...next, loading: false, error: null });
        }
      })
      .catch((exc) => {
        if (!cancelled) {
          setNodeConfig({
            title: nodeConfigTitle(selectedNode),
            payload: null,
            loading: false,
            error: String(exc),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  async function deleteSelectedManualLink() {
    if (!selectedEdge?.link_id) return;
    try {
      await api.delete(`/api/links/${encodeURIComponent(selectedEdge.link_id)}`);
      toast.success("Manual link deleted");
      setSelectedEdgeId(null);
      await fetchLineage();
    } catch (exc) {
      toast.error(String(exc));
    }
  }

  const nodeCount = lineage?.nodes.length ?? 0;
  const edgeCount = lineage?.edges.length ?? 0;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <GitBranch className="h-4 w-4 text-zinc-400" />
          Lineage Graph
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={direction} onValueChange={(value) => setDirection(value as Direction)}>
            <SelectTrigger className="h-8 w-36 border-zinc-700 bg-zinc-900 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Both</SelectItem>
              <SelectItem value="ancestors">Ancestors</SelectItem>
              <SelectItem value="descendants">Descendants</SelectItem>
            </SelectContent>
          </Select>
          <Select value={depth} onValueChange={setDepth}>
            <SelectTrigger className="h-8 w-24 border-zinc-700 bg-zinc-900 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["1", "2", "3", "5", "8", "12"].map((value) => (
                <SelectItem key={value} value={value}>
                  depth {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
            <Switch checked={includeModules} onCheckedChange={setIncludeModules} />
            Modules
          </label>
          <Button variant="outline" size="sm" onClick={() => void fetchLineage()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid min-h-[620px] grid-cols-[minmax(0,1fr)_280px]">
        <LineageGraphSurface
          lineage={lineage}
          loading={loading}
          error={error}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          emptyTitle="No lineage data"
          emptyText="This run has no recorded dataset, artifact, module, or manual links in the selected range."
          onNodeClick={(node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onNodeDoubleClick={(node) => {
            const nodeRunId = runIdFromNode(node);
            if (node.type === "run" && nodeRunId) {
              navigate(`/runs/${encodeURIComponent(nodeRunId)}`);
            }
          }}
          onEdgeClick={(_edge, edgeId) => {
            setSelectedEdgeId(edgeId);
            setSelectedNodeId(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
        />

        <aside className="border-l border-zinc-800 bg-zinc-950/95 p-3">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <GraphFact label="Nodes" value={nodeCount} />
            <GraphFact label="Edges" value={edgeCount} />
          </div>
          {selectedNode ? (
            <NodeInspector node={selectedNode} configState={nodeConfig} />
          ) : selectedEdge ? (
            <EdgeInspector edge={selectedEdge} onDelete={deleteSelectedManualLink} />
          ) : (
            <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-400">
              Click a node to inspect its config. Double-click a run node to open its detail page.
            </div>
          )}
          <Legend />
        </aside>
      </div>
    </div>
  );
}

export function LaunchLineagePreview({
  jobName,
  values,
}: {
  jobName: string;
  values: Record<string, unknown>;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const lineage = useMemo(() => buildLaunchModuleLineage(jobName, values), [jobName, values]);
  const moduleCount = lineage.nodes.filter((node) => node.type === "module").length;

  useEffect(() => {
    if (selectedNodeId && !lineage.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [lineage, selectedNodeId]);

  if (moduleCount === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <GitBranch className="h-4 w-4 text-zinc-400" />
          Module Lineage Preview
        </div>
        <Badge variant="outline" className="border-violet-400/60 text-violet-200">
          {moduleCount} modules
        </Badge>
      </div>
      <LineageGraphSurface
        lineage={lineage}
        selectedNodeId={selectedNodeId}
        heightClassName="h-[380px]"
        skeletonClassName="h-[340px]"
        emptyTitle="No module lineage"
        emptyText="This configuration does not contain module references."
        onNodeClick={(node) => setSelectedNodeId(node.id)}
        onPaneClick={() => setSelectedNodeId(null)}
      />
    </div>
  );
}

function GraphState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
      <div className="max-w-sm rounded-lg border border-zinc-800 bg-zinc-950/90 p-5 shadow-xl">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-md bg-zinc-900 text-zinc-400">
          {icon}
        </div>
        <div className="font-medium text-zinc-100">{title}</div>
        <p className="mt-1 text-sm text-zinc-400">{text}</p>
      </div>
    </div>
  );
}

function GraphFact({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function NodeInspector({
  node,
  configState,
}: {
  node: LineageNodeModel;
  configState: NodeConfigState | null;
}) {
  const details = nodeDetails(node);
  const meta = NODE_META[node.type];
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-3 flex items-center gap-2">
        <Badge variant="outline" className={cn("border-current", meta.text)}>
          {node.type}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{details.title}</span>
      </div>
      <InfoRow label="id" value={node.id} mono />
      <InfoRow label="label" value={node.label} />
      {details.subtitle && <InfoRow label="path" value={details.subtitle} mono />}
      {node.collapsed_into && <InfoRow label="belongs to" value={node.collapsed_into} mono />}
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">
          {configState?.title ?? "Config"}
        </div>
        {!configState || configState.loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full bg-zinc-800" />
            <Skeleton className="h-4 w-5/6 bg-zinc-800" />
            <Skeleton className="h-4 w-2/3 bg-zinc-800" />
          </div>
        ) : configState?.error ? (
          <div className="rounded border border-red-950 bg-red-950/30 p-2 text-xs text-red-200">
            {configState.error}
          </div>
        ) : (
          <pre className="max-h-80 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-200">
            {formatJson(configState?.payload)}
          </pre>
        )}
      </div>
    </div>
  );
}

function EdgeInspector({
  edge,
  onDelete,
}: {
  edge: LineageEdgeModel;
  onDelete: () => void;
}) {
  const meta = EDGE_META[edge.type] ?? EDGE_META.manual;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="h-4 w-4" style={{ color: meta.color }} />
        <span className="text-sm font-medium text-zinc-100">{meta.label}</span>
      </div>
      <InfoRow label="from" value={edge.src} mono />
      <InfoRow label="to" value={edge.dst} mono />
      {edge.artifact && <InfoRow label="artifact" value={edge.artifact} mono />}
      {edge.note && <InfoRow label="note" value={edge.note} />}
      {edge.link_id && (
        <Button variant="destructive" size="sm" className="mt-3 w-full" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete manual link
        </Button>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Legend</div>
      {Object.entries(EDGE_META).map(([key, meta]) => (
        <div key={key} className="flex items-center gap-2 py-1 text-xs text-zinc-300">
          <span
            className="h-0.5 w-8 rounded"
            style={{
              backgroundColor: meta.color,
              borderTop: meta.dashed ? `1px dashed ${meta.color}` : undefined,
            }}
          />
          {meta.label}
        </div>
      ))}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border-t border-zinc-800 py-2 first:border-t-0">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cn("mt-0.5 break-all text-xs text-zinc-200", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function edgeKey(edge: LineageEdgeModel, index: number) {
  return edge.link_id ?? `${edge.src}->${edge.dst}:${edge.type}:${edge.artifact ?? ""}:${index}`;
}

function buildLaunchModuleLineage(
  jobName: string,
  values: Record<string, unknown>
): LineageGraph {
  const runId = "launch-preview";
  const center = `run:${runId}`;
  const nodes: LineageGraph["nodes"] = [
    { id: center, type: "run", label: jobName },
  ];
  const edges: LineageGraph["edges"] = [];
  const nodeIds = new Set([center]);

  function addModule(fieldPath: string, moduleName: string, parentNodeId: string | null) {
    const path = fieldPath || "module";
    const nodeId = `module:${runId}:${path}:${moduleName}`;
    if (!nodeIds.has(nodeId)) {
      nodes.push({
        id: nodeId,
        type: "module",
        label: moduleName,
        collapsed_into: center,
      });
      nodeIds.add(nodeId);
    }
    edges.push({
      src: nodeId,
      dst: parentNodeId ?? center,
      type: "composed-of-module",
    });
    return nodeId;
  }

  function walk(value: unknown, fieldPath: string, parentModuleId: string | null) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const nextPath = fieldPath ? `${fieldPath}[${index}]` : `[${index}]`;
        walk(item, nextPath, parentModuleId);
      });
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    let currentParent = parentModuleId;
    if (typeof record.__module__ === "string" && record.__module__) {
      currentParent = addModule(fieldPath, record.__module__, parentModuleId);
    }
    for (const [key, item] of Object.entries(record)) {
      if (key === "__module__") continue;
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      walk(item, nextPath, currentParent);
    }
  }

  walk(values, "", null);
  return { center, nodes, edges };
}

function nodeDetails(node: LineageNodeModel) {
  if (node.type === "module") {
    const parts = moduleNodeParts(node.id);
    const fieldPath = parts?.fieldPath || "module";
    const moduleName = parts?.moduleName || node.label;
    return { title: moduleName, subtitle: fieldPath };
  }
  if (node.type === "artifact") {
    const rest = node.id.slice("artifact:".length);
    const separator = rest.indexOf(":");
    if (separator >= 0) {
      return {
        title: rest.slice(separator + 1),
        subtitle: `run:${rest.slice(0, separator)}`,
      };
    }
  }
  if (node.type === "run") {
    return { title: node.label, subtitle: node.id.replace(/^run:/, "") };
  }
  return { title: node.label, subtitle: node.id };
}

function nodeConfigTitle(node: LineageNodeModel) {
  if (node.type === "run") return "Run config";
  if (node.type === "module") return "Module config";
  if (node.type === "dataset") return "Dataset metadata";
  if (node.type === "artifact") return "Artifact metadata";
  return "Config";
}

async function loadNodeConfig(
  node: LineageNodeModel
): Promise<{ title: string; payload: unknown }> {
  if (node.type === "run") {
    const runId = runIdFromNode(node);
    if (!runId) return { title: "Run config", payload: node };
    const detail = await api.get<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    return { title: "Run config", payload: detail.config };
  }

  if (node.type === "module") {
    const parts = moduleNodeParts(node.id);
    if (!parts) return { title: "Module config", payload: node };
    const detail = await api.get<RunDetail>(`/api/runs/${encodeURIComponent(parts.runId)}`);
    const config = valueAtPath(detail.config, parts.fieldPath);
    return {
      title: "Module config",
      payload:
        config === undefined
          ? {
              __module__: parts.moduleName,
              field_path: parts.fieldPath,
              missing: true,
            }
          : config,
    };
  }

  if (node.type === "dataset") {
    const name = datasetNameFromNode(node.id);
    if (!name) return { title: "Dataset metadata", payload: node };
    const dataset = await api.get<DatasetInfo>(`/api/datasets/${encodeURIComponent(name)}`);
    return { title: "Dataset metadata", payload: dataset };
  }

  if (node.type === "artifact") {
    const parts = artifactNodeParts(node.id);
    if (!parts) return { title: "Artifact metadata", payload: node };
    const artifacts = await api.get<Artifact[]>(
      `/api/runs/${encodeURIComponent(parts.runId)}/artifacts`
    );
    const artifact = artifacts.find((item) => item.path === parts.path);
    return {
      title: "Artifact metadata",
      payload: artifact ?? { run_id: parts.runId, path: parts.path, missing: true },
    };
  }

  return { title: "Config", payload: node };
}

function runIdFromNode(node: LineageNodeModel) {
  return node.id.startsWith("run:") ? node.id.slice("run:".length) : null;
}

function datasetNameFromNode(nodeId: string) {
  return nodeId.startsWith("dataset:") ? nodeId.slice("dataset:".length) : null;
}

function moduleNodeParts(nodeId: string) {
  if (!nodeId.startsWith("module:")) return null;
  const rest = nodeId.slice("module:".length);
  const first = rest.indexOf(":");
  if (first < 0) return null;
  const second = rest.indexOf(":", first + 1);
  if (second < 0) return null;
  return {
    runId: rest.slice(0, first),
    fieldPath: rest.slice(first + 1, second),
    moduleName: rest.slice(second + 1),
  };
}

function artifactNodeParts(nodeId: string) {
  if (!nodeId.startsWith("artifact:")) return null;
  const rest = nodeId.slice("artifact:".length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  return {
    runId: rest.slice(0, separator),
    path: rest.slice(separator + 1),
  };
}

function valueAtPath(root: unknown, path: string) {
  if (!path) return root;
  let current = root;
  for (const token of parseFieldPath(path)) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) return undefined;
      current = current[token];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function parseFieldPath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  for (const segment of path.split(".").filter(Boolean)) {
    const name = segment.match(/^[^\[]+/)?.[0];
    if (name) tokens.push(name);
    for (const match of segment.matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(match[1]));
    }
  }
  return tokens;
}

function formatJson(value: unknown) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}
