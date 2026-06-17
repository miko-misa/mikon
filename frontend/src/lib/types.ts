export type Annotations = {
  title?: string | null;
  memo?: string | null;
  tags: string[];
  star: boolean;
  group_ids: string[];
};

export type JobInfo = {
  name: string;
  doc?: string | null;
  source_file: string;
  lineno: number;
  schema_hash: string;
  output_artifacts: string[];
};

export type JobDetail = JobInfo & {
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, unknown>;
};

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
  | "pending"
  | "cancelled";

export type RunSummary = {
  run_id: string;
  job: string;
  status: RunStatus;
  gpus: string[];
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  annotations: Annotations;
};

export type RunDetail = RunSummary & {
  pid?: number | null;
  exit_code?: number | null;
  config_hash: string;
  schema_hash: string;
  config: Record<string, unknown>;
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, unknown>;
  error?: string | null;
  metric_names: string[];
  artifact_count: number;
  depends_on: string[];
  pending_reason?: string | null;
};

export type ChainStep = {
  job: string;
  config: Record<string, unknown>;
  gpus: string[];
  force?: boolean;
  annotations?: Annotations | null;
};

export type CreateChainRequest = {
  steps: ChainStep[];
  on_upstream_failure: "cancel" | "continue";
};

export type CreateChainResponse = {
  run_ids: string[];
};

export type MetricRecord = {
  seq: number;
  t: string;
  step?: number | null;
  name: string;
  value: number;
};

export type MetricsResponse = {
  run_id: string;
  records: MetricRecord[];
  next_since: number;
};

export type GpuInfo = {
  id: string;
  vendor: "nvidia" | "amd";
  index: number;
  name: string;
  util_pct: number;
  mem_used_mib: number;
  mem_total_mib: number;
  temp_c?: number | null;
  power_w?: number | null;
  occupied: boolean;
  processes: GpuProcess[];
};

export type GpuProcess = {
  pid: number;
  user?: string | null;
  name?: string | null;
  used_mib: number;
  owned_by_mikon: boolean;
  run_id?: string | null;
};

export type ResourceSnapshot = {
  t: string;
  gpu_available: boolean;
  gpus: GpuInfo[];
  machine: {
    cpu_pct: number;
    cpu_count: number;
    mem_used_mib: number;
    mem_total_mib: number;
    disk_used_gb: number;
    disk_total_gb: number;
  };
};

export type Artifact = {
  path: string;
  size: number;
  mtime: string | null;
  kind: "file" | "dir";
};

export type Group = {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
};

export type ConfigInstance = {
  name: string;
  job: string;
  values: Record<string, unknown>;
  schema_hash: string;
  created_at: string;
  updated_at: string;
};

export type DatasetInfo = {
  name: string;
  description?: string | null;
  path: string;
  source: "register" | "builder";
  builder_run_id?: string | null;
  created_at: string;
};

export type DatasetBuilderDetail = {
  name: string;
  doc?: string | null;
  source_file: string;
  lineno: number;
  schema_hash: string;
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, unknown>;
};

export type DocNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  format?: "markdown" | "typst" | "typmark" | null;
  mtime?: string | null;
  size?: number | null;
  children: DocNode[];
};

export type DocTree = { root: string; exists: boolean; nodes: DocNode[] };

export type DocDocument = {
  path: string;
  title: string;
  format: "markdown" | "typst" | "typmark";
  rendered_kind: "html" | "svg" | "source";
  content: string;
  source: string;
  mtime?: string | null;
  size: number;
  diagnostics: string[];
};

export type LineageGraph = {
  center: string;
  nodes: {
    id: string;
    type: "run" | "dataset" | "module" | "artifact";
    label: string;
    collapsed_into?: string | null;
  }[];
  edges: {
    src: string;
    dst: string;
    type: string;
    artifact?: string | null;
    note?: string | null;
    link_id?: string | null;
  }[];
};

export type CompareRunsResponse = {
  runs: {
    run_id: string;
    job: string;
    status: string;
    config: Record<string, unknown>;
    metrics: Record<
      string,
      {
        count: number;
        latest?: number | null;
        min?: number | null;
        max?: number | null;
      }
    >;
  }[];
  config_fields: string[];
  metric_names: string[];
  config_diffs: {
    field: string;
    values: Record<string, unknown>;
    missing_run_ids: string[];
  }[];
};

export type Route =
  | { kind: "dashboard" }
  | { kind: "job"; name: string; configName?: string | null }
  | { kind: "run"; id: string }
  | { kind: "groups" }
  | { kind: "group"; id: string }
  | { kind: "configs" }
  | { kind: "datasets" }
  | { kind: "datasetBuilder"; name: string }
  | { kind: "docs"; path?: string | null }
  | { kind: "compare"; ids: string[] }
  | { kind: "pipeline"; job?: string | null };
