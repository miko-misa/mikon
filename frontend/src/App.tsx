import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import uPlot from "uplot";
import { Activity, AlertTriangle, BookOpen, Box, Cpu, FileDown, FileText, Folder, Gauge, Play, RefreshCcw, Save, Square, Star, Terminal } from "lucide-react";

type Annotations = {
  title?: string | null;
  memo?: string | null;
  tags: string[];
  star: boolean;
  group_ids: string[];
};

type JobInfo = {
  name: string;
  doc?: string | null;
  source_file: string;
  lineno: number;
  schema_hash: string;
};

type JobDetail = JobInfo & {
  json_schema: Record<string, unknown>;
  ui_schema: Record<string, unknown>;
};

type RunSummary = {
  run_id: string;
  job: string;
  status: string;
  gpus: string[];
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  annotations: Annotations;
};

type RunDetail = RunSummary & {
  pid?: number | null;
  exit_code?: number | null;
  config_hash: string;
  schema_hash: string;
  config: Record<string, unknown>;
  error?: string | null;
  metric_names: string[];
  artifact_count: number;
};

type MetricRecord = {
  seq: number;
  t: string;
  step?: number | null;
  name: string;
  value: number;
};

type GpuInfo = {
  id: string;
  vendor: "nvidia" | "amd";
  index: number;
  name: string;
  util_pct: number;
  mem_used_mib: number;
  mem_total_mib: number;
  occupied: boolean;
};

type ResourceSnapshot = {
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

type Artifact = { path: string; size: number; mtime: string | null; kind: "file" | "dir" };
type Group = { id: string; name: string; description?: string | null; created_at: string };
type ConfigInstance = { name: string; job: string; values: Record<string, unknown>; schema_hash: string; created_at: string; updated_at: string };
type ConfigDiff = { name: string; job: string; compatible: boolean; changes: { field: string; kind: string; detail: string }[]; migrated_values: Record<string, unknown> };
type DatasetInfo = { name: string; description?: string | null; path: string; source: "register" | "builder"; builder_run_id?: string | null; created_at: string };
type DatasetBuilderInfo = { name: string; doc?: string | null; source_file: string; lineno: number; schema_hash: string };
type DatasetBuilderDetail = DatasetBuilderInfo & { json_schema: Record<string, unknown>; ui_schema: Record<string, unknown> };
type DocNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  format?: "markdown" | "typst" | null;
  mtime?: string | null;
  size?: number | null;
  children: DocNode[];
};
type DocTree = { root: string; exists: boolean; nodes: DocNode[] };
type DocDocument = {
  path: string;
  title: string;
  format: "markdown" | "typst";
  rendered_kind: "html" | "svg" | "source";
  content: string;
  source: string;
  mtime?: string | null;
  size: number;
  diagnostics: string[];
};
type LineageGraph = {
  center: string;
  nodes: { id: string; type: "run" | "dataset" | "module" | "artifact"; label: string; collapsed_into?: string | null }[];
  edges: { src: string; dst: string; type: string; artifact?: string | null; note?: string | null; link_id?: string | null }[];
};
type CompareRunsResponse = {
  runs: { run_id: string; job: string; status: string; config: Record<string, unknown>; metrics: Record<string, { count: number; latest?: number | null; min?: number | null; max?: number | null }> }[];
  config_fields: string[];
  metric_names: string[];
  config_diffs: { field: string; values: Record<string, unknown>; missing_run_ids: string[] }[];
};

type Route =
  | { kind: "dashboard" }
  | { kind: "job"; name: string; configName?: string | null }
  | { kind: "run"; id: string }
  | { kind: "groups" }
  | { kind: "group"; id: string }
  | { kind: "configs" }
  | { kind: "datasets" }
  | { kind: "datasetBuilder"; name: string }
  | { kind: "docs"; path?: string | null }
  | { kind: "compare"; ids: string[] };

const api = {
  async get<T>(path: string): Promise<T> {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await problemText(response));
    return response.json() as Promise<T>;
  },
  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await problemText(response));
    return response.json() as Promise<T>;
  },
  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await problemText(response));
    return response.json() as Promise<T>;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await problemText(response));
    return response.json() as Promise<T>;
  },
  async delete(path: string): Promise<void> {
    const response = await fetch(path, { method: "DELETE" });
    if (!response.ok) throw new Error(await problemText(response));
  }
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.search));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname, location.search));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const navigate = (path: string) => {
    history.pushState(null, "", path);
    setRoute(parseRoute(location.pathname, location.search));
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("/")}>mikon</button>
        <nav>
          <button onClick={() => navigate("/")}>Dashboard</button>
          <button onClick={() => navigate("/groups")}>Groups</button>
          <button onClick={() => navigate("/configs")}>Configs</button>
          <button onClick={() => navigate("/datasets")}>Datasets</button>
          <button onClick={() => navigate("/docs")}>Docs</button>
        </nav>
      </header>
      <main>
        {route.kind === "dashboard" && <Dashboard navigate={navigate} />}
        {route.kind === "job" && <JobPage name={route.name} configName={route.configName} navigate={navigate} />}
        {route.kind === "run" && <RunPage id={route.id} navigate={navigate} />}
        {route.kind === "groups" && <GroupsPage navigate={navigate} />}
        {route.kind === "group" && <GroupPage id={route.id} navigate={navigate} />}
        {route.kind === "configs" && <ConfigsPage navigate={navigate} />}
        {route.kind === "datasets" && <DatasetsPage navigate={navigate} />}
        {route.kind === "datasetBuilder" && <DatasetBuilderPage name={route.name} navigate={navigate} />}
        {route.kind === "docs" && <DocsPage path={route.path} navigate={navigate} />}
        {route.kind === "compare" && <ComparePage ids={route.ids} navigate={navigate} />}
      </main>
    </div>
  );
}

function Dashboard({ navigate }: { navigate: (path: string) => void }) {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filters, setFilters] = useState({ tag: "", group: "", job: "", status: "", star: false });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.tag) params.set("tag", filters.tag);
      if (filters.group) params.set("group", filters.group);
      if (filters.job) params.set("job", filters.job);
      if (filters.status) params.set("status", filters.status);
      if (filters.star) params.set("star", "true");
      const [nextJobs, nextRuns, nextResources, nextGroups] = await Promise.all([
        api.get<JobInfo[]>("/api/jobs"),
        api.get<RunSummary[]>(`/api/runs?${params.toString()}`),
        api.get<ResourceSnapshot>("/api/resources"),
        api.get<Group[]>("/api/groups")
      ]);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setResources(nextResources);
      setGroups(nextGroups);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [filters]);

  return (
    <div className="grid">
      <section className="panel span-2">
        <PanelTitle icon={<Activity size={18} />} title="Jobs" action={<IconButton title="Refresh" onClick={load} icon={<RefreshCcw size={16} />} />} />
        {error && <p className="error">{error}</p>}
        <div className="table">
          <div className="row head"><span>Name</span><span>Source</span><span></span></div>
          {jobs.map((job) => (
            <div className="row" key={job.name}>
              <span className="strong">{job.name}</span>
              <span className="muted">{shortPath(job.source_file)}:{job.lineno}</span>
              <span><button onClick={() => navigate(`/jobs/${encodeURIComponent(job.name)}`)}><Play size={15} /> Run</button></span>
            </div>
          ))}
          {jobs.length === 0 && <p className="empty">No jobs discovered.</p>}
        </div>
      </section>

      <ResourcePanel resources={resources} />

      <section className="panel span-3">
        <PanelTitle icon={<Terminal size={18} />} title="Runs" />
        <div className="filters">
          <input placeholder="tag" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })} />
          <select value={filters.group} onChange={(event) => setFilters({ ...filters, group: event.target.value })}>
            <option value="">all groups</option>
            {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
          </select>
          <input placeholder="job" value={filters.job} onChange={(event) => setFilters({ ...filters, job: event.target.value })} />
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">all statuses</option>
            {["running", "completed", "failed", "stopped", "unknown"].map((status) => <option value={status} key={status}>{status}</option>)}
          </select>
          <label><input type="checkbox" checked={filters.star} onChange={(event) => setFilters({ ...filters, star: event.target.checked })} /> Starred</label>
        </div>
        <RunTable runs={runs} navigate={navigate} />
      </section>
    </div>
  );
}

function JobPage({ name, configName, navigate }: { name: string; configName?: string | null; navigate: (path: string) => void }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [saveConfigAs, setSaveConfigAs] = useState("");
  const [annotations, setAnnotations] = useState<Annotations>(emptyAnnotations());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setFormData({});
    void (async () => {
      try {
        const [nextJob, nextResources, nextGroups] = await Promise.all([
          api.get<JobDetail>(`/api/jobs/${encodeURIComponent(name)}`),
          api.get<ResourceSnapshot>("/api/resources"),
          api.get<Group[]>("/api/groups")
        ]);
        setJob(nextJob);
        setResources(nextResources);
        setGroups(nextGroups);
        if (configName) {
          const saved = await api.get<ConfigInstance>(`/api/configs/${encodeURIComponent(configName)}`);
          if (saved.job !== name) {
            setError(`Config ${saved.name} belongs to ${saved.job}.`);
            return;
          }
          setFormData(saved.values);
          setSaveConfigAs(saved.name);
        }
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [name, configName]);

  const selectedVendor = useMemo(() => {
    const gpu = resources?.gpus.find((item) => selected.includes(item.id));
    return gpu?.vendor;
  }, [resources, selected]);

  const submit = async () => {
    try {
      const response = await api.post<{ run_id: string }>("/api/runs", {
        job: name,
        config: formData,
        gpus: selected,
        force,
        annotations,
        save_config_as: saveConfigAs || null
      });
      navigate(`/runs/${encodeURIComponent(response.run_id)}`);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Activity size={18} />} title={`Run ${name}`} />
        {error && <p className="error">{error}</p>}
        {job && (
          <Form
            schema={job.json_schema}
            uiSchema={job.ui_schema}
            validator={validator}
            formData={formData}
            onChange={(event) => setFormData(event.formData ?? {})}
            onSubmit={() => void submit()}
          >
            <GpuPicker resources={resources} selected={selected} setSelected={setSelected} selectedVendor={selectedVendor} />
            <AnnotationFields annotations={annotations} setAnnotations={setAnnotations} groups={groups} />
            <label className="checkline">
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              Force occupied GPU
            </label>
            <input placeholder="save config as" value={saveConfigAs} onChange={(event) => setSaveConfigAs(event.target.value)} />
            <button type="submit" disabled={!job || selected.length === 0}><Play size={15} /> Start run</button>
          </Form>
        )}
      </section>
    </div>
  );
}

function RunPage({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [metrics, setMetrics] = useState<MetricRecord[]>([]);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [lineage, setLineage] = useState<LineageGraph | null>(null);
  const [includeModules, setIncludeModules] = useState(false);
  const [configName, setConfigName] = useState("");
  const [compareIds, setCompareIds] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [nextDetail, nextMetrics, nextArtifacts, nextGroups, nextLineage] = await Promise.all([
        api.get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
        api.get<{ records: MetricRecord[] }>(`/api/runs/${encodeURIComponent(id)}/metrics?since=-1`),
        api.get<Artifact[]>(`/api/runs/${encodeURIComponent(id)}/artifacts`),
        api.get<Group[]>("/api/groups"),
        api.get<LineageGraph>(`/api/runs/${encodeURIComponent(id)}/lineage?direction=both&depth=3&include_modules=${includeModules ? "true" : "false"}`)
      ]);
      setDetail(nextDetail);
      setMetrics(nextMetrics.records);
      setArtifacts(nextArtifacts);
      setGroups(nextGroups);
      setLineage(nextLineage);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    let stdoutEvents: EventSource | null = null;
    let stderrEvents: EventSource | null = null;
    void (async () => {
      await load();
      const [out, err] = await Promise.all([fetchLog(id, "stdout"), fetchLog(id, "stderr")]);
      setStdout(out.text);
      setStderr(err.text);
      stdoutEvents = openLogStream(id, "stdout", out.nextSince, setStdout);
      stderrEvents = openLogStream(id, "stderr", err.nextSince, setStderr);
    })();
    const events = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
    events.addEventListener("metric", (event) => {
      const record = JSON.parse((event as MessageEvent).data) as MetricRecord;
      setMetrics((items) => items.some((item) => item.seq === record.seq) ? items : [...items, record]);
    });
    events.addEventListener("status", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as { status: string };
      setDetail((current) => current ? { ...current, status: next.status } : current);
    });
    const timer = setInterval(() => void load(), 5000);
    return () => {
      events.close();
      stdoutEvents?.close();
      stderrEvents?.close();
      clearInterval(timer);
    };
  }, [id, includeModules]);

  const stop = async () => {
    try {
      const next = await api.post<RunDetail>(`/api/runs/${encodeURIComponent(id)}/stop`);
      setDetail(next);
    } catch (err) {
      setError(String(err));
    }
  };

  const patchAnnotations = async (annotations: Annotations) => {
    const next = await api.patch<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, annotations);
    setDetail(next);
  };

  const saveConfig = async () => {
    if (!detail || !configName) return;
    await api.put<ConfigInstance>(`/api/configs/${encodeURIComponent(configName)}`, {
      job: detail.job,
      values: detail.config
    });
    setConfigName("");
  };

  const compare = () => {
    const ids = [id, ...splitCsv(compareIds)].filter(unique);
    if (ids.length >= 2) navigate(`/compare?${ids.map((item) => `run_id=${encodeURIComponent(item)}`).join("&")}`);
  };

  const createManualLink = async (src: string, dst: string, note: string) => {
    await api.post("/api/links", { src, dst, note: note || null });
    await load();
  };

  const deleteManualLink = async (linkId: string) => {
    await api.delete(`/api/links/${encodeURIComponent(linkId)}`);
    await load();
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle
          icon={<Terminal size={18} />}
          title={id}
          action={detail?.status === "running" ? <button onClick={stop}><Square size={15} /> Stop</button> : undefined}
        />
        {error && <p className="error">{error}</p>}
        {detail && (
          <>
            <div className="facts">
              <span><b>Job</b>{detail.job}</span>
              <span><b>Status</b><Status status={detail.status} /></span>
              <span><b>PID</b>{detail.pid ?? "-"}</span>
              <span><b>GPUs</b>{detail.gpus.join(", ") || "-"}</span>
            </div>
            <AnnotationEditor detail={detail} groups={groups} onSave={patchAnnotations} />
            <div className="inline-tools">
              <input placeholder="config name" value={configName} onChange={(event) => setConfigName(event.target.value)} />
              <button onClick={() => void saveConfig()} disabled={!configName}><Save size={15} /> Save config</button>
              <input placeholder="other run ids for compare" value={compareIds} onChange={(event) => setCompareIds(event.target.value)} />
              <button onClick={compare} disabled={splitCsv(compareIds).length === 0}>Compare</button>
            </div>
          </>
        )}
      </section>
      <section className="panel">
        <PanelTitle icon={<Gauge size={18} />} title="Metrics" />
        <MetricSummary records={metrics} />
        <MetricChart records={metrics} />
      </section>
      <section className="panel two-col">
        <LogPanel title="stdout" text={stdout} />
        <LogPanel title="stderr" text={stderr} />
      </section>
      <section className="panel">
        <PanelTitle icon={<Box size={18} />} title="Artifacts" />
        <ArtifactList runId={id} artifacts={artifacts} />
      </section>
      <section className="panel">
        <PanelTitle
          icon={<Activity size={18} />}
          title="Lineage"
          action={
            <label className="checkline">
              <input type="checkbox" checked={includeModules} onChange={(event) => setIncludeModules(event.target.checked)} />
              Include modules
            </label>
          }
        />
        <LineagePanel graph={lineage} centerRunId={id} navigate={navigate} onCreateManualLink={createManualLink} onDeleteManualLink={deleteManualLink} />
      </section>
    </div>
  );
}

function GroupsPage({ navigate }: { navigate: (path: string) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => setGroups(await api.get<Group[]>("/api/groups"));
  useEffect(() => { void load().catch((err) => setError(String(err))); }, []);

  const create = async () => {
    try {
      await api.post<Group>("/api/groups", { name, description });
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Star size={18} />} title="Groups" />
        {error && <p className="error">{error}</p>}
        <div className="inline-tools">
          <input placeholder="name" value={name} onChange={(event) => setName(event.target.value)} />
          <input placeholder="description" value={description} onChange={(event) => setDescription(event.target.value)} />
          <button onClick={() => void create()} disabled={!name}>Create</button>
        </div>
        <div className="table">
          <div className="row head"><span>Name</span><span>Description</span><span>Created</span></div>
          {groups.map((group) => (
            <button className="row clickable" key={group.id} onClick={() => navigate(`/groups/${encodeURIComponent(group.id)}`)}>
              <span className="strong">{group.name}</span>
              <span>{group.description ?? ""}</span>
              <span className="muted">{formatTime(group.created_at)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function GroupPage({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [nextGroup, nextRuns] = await Promise.all([
      api.get<Group>(`/api/groups/${encodeURIComponent(id)}`),
      api.get<RunSummary[]>(`/api/groups/${encodeURIComponent(id)}/runs`)
    ]);
    setGroup(nextGroup);
    setRuns(nextRuns);
  };

  useEffect(() => { void load().catch((err) => setError(String(err))); }, [id]);

  const deleteGroup = async () => {
    await api.delete(`/api/groups/${encodeURIComponent(id)}`);
    navigate("/groups");
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Star size={18} />} title={group?.name ?? id} action={<button onClick={() => void deleteGroup()}>Delete</button>} />
        {error && <p className="error">{error}</p>}
        <p className="muted">{group?.description}</p>
        {runs.length >= 2 && (
          <button onClick={() => navigate(`/compare?${runs.map((run) => `run_id=${encodeURIComponent(run.run_id)}`).join("&")}`)}>Compare group runs</button>
        )}
      </section>
      <section className="panel">
        <RunTable runs={runs} navigate={navigate} />
      </section>
    </div>
  );
}

function ConfigsPage({ navigate }: { navigate: (path: string) => void }) {
  const [configs, setConfigs] = useState<ConfigInstance[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [selected, setSelected] = useState<ConfigInstance | null>(null);
  const [valuesText, setValuesText] = useState("{}");
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [nextConfigs, nextJobs] = await Promise.all([api.get<ConfigInstance[]>("/api/configs"), api.get<JobInfo[]>("/api/jobs")]);
    setConfigs(nextConfigs);
    setJobs(nextJobs);
  };
  useEffect(() => { void load().catch((err) => setError(String(err))); }, []);

  const selectConfig = (config: ConfigInstance) => {
    setSelected(config);
    setValuesText(JSON.stringify(config.values, null, 2));
    setDiff(null);
  };

  const save = async () => {
    if (!selected) return;
    await api.put<ConfigInstance>(`/api/configs/${encodeURIComponent(selected.name)}`, {
      job: selected.job,
      values: JSON.parse(valuesText)
    });
    await load();
  };

  const run = () => {
    if (!selected) return;
    navigate(`/jobs/${encodeURIComponent(selected.job)}?config=${encodeURIComponent(selected.name)}`);
  };

  const showDiff = async () => {
    if (!selected) return;
    const next = await api.post<ConfigDiff>(`/api/configs/${encodeURIComponent(selected.name)}/diff`, { job: selected.job });
    setDiff(next);
  };

  return (
    <div className="grid">
      <section className="panel">
        <PanelTitle icon={<Save size={18} />} title="Configs" />
        {error && <p className="error">{error}</p>}
        <div className="table compact-table">
          {configs.map((config) => (
            <button className="row clickable" key={config.name} onClick={() => selectConfig(config)}>
              <span className="strong">{config.name}</span>
              <span>{config.job}</span>
              <span className="muted">{formatTime(config.updated_at)}</span>
            </button>
          ))}
          {configs.length === 0 && <p className="empty">No saved configs.</p>}
        </div>
      </section>
      <section className="panel span-2">
        <PanelTitle icon={<Save size={18} />} title={selected ? `Edit ${selected.name}` : "Config Detail"} />
        <p className="muted">Known jobs: {jobs.map((job) => job.name).join(", ") || "-"}</p>
        {selected && (
          <>
            <textarea value={valuesText} onChange={(event) => setValuesText(event.target.value)} rows={14} />
            <div className="inline-tools">
              <button onClick={() => void save()}>Save</button>
              <button onClick={() => void showDiff()}>Diff</button>
              <button onClick={run}>Open job</button>
            </div>
            {diff && (
              <pre>{JSON.stringify(diff, null, 2)}</pre>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function DatasetsPage({ navigate }: { navigate: (path: string) => void }) {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [builders, setBuilders] = useState<DatasetBuilderInfo[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [nextDatasets, nextBuilders] = await Promise.all([
      api.get<DatasetInfo[]>("/api/datasets"),
      api.get<DatasetBuilderInfo[]>("/api/dataset-builders")
    ]);
    setDatasets(nextDatasets);
    setBuilders(nextBuilders);
  };
  useEffect(() => { void load().catch((err) => setError(String(err))); }, []);

  const create = async () => {
    try {
      await api.post<DatasetInfo>("/api/datasets", { name, path, description: description || null });
      setName("");
      setPath("");
      setDescription("");
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (dataset: DatasetInfo) => {
    try {
      await api.delete(`/api/datasets/${encodeURIComponent(dataset.name)}`);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Box size={18} />} title="Datasets" />
        {error && <p className="error">{error}</p>}
        <div className="inline-tools">
          <input placeholder="name" value={name} onChange={(event) => setName(event.target.value)} />
          <input placeholder="path" value={path} onChange={(event) => setPath(event.target.value)} />
          <input placeholder="description" value={description} onChange={(event) => setDescription(event.target.value)} />
          <button onClick={() => void create()} disabled={!name || !path}>Register</button>
        </div>
        <div className="table">
          <div className="row head"><span>Name</span><span>Path</span><span>Source</span><span></span></div>
          {datasets.map((dataset) => (
            <div className="row" key={dataset.name}>
              <span className="strong">{dataset.name}</span>
              <span className="mono">{dataset.path}</span>
              <span>{dataset.source}</span>
              <span><button onClick={() => void remove(dataset)}>Delete</button></span>
            </div>
          ))}
          {datasets.length === 0 && <p className="empty">No datasets.</p>}
        </div>
      </section>
      <section className="panel">
        <PanelTitle icon={<Play size={18} />} title="Dataset Builders" />
        <div className="table">
          <div className="row head"><span>Name</span><span>Source</span><span></span></div>
          {builders.map((builder) => (
            <div className="row" key={builder.name}>
              <span className="strong">{builder.name}</span>
              <span className="muted">{shortPath(builder.source_file)}:{builder.lineno}</span>
              <span><button onClick={() => navigate(`/datasets/build/${encodeURIComponent(builder.name)}`)}><Play size={15} /> Build</button></span>
            </div>
          ))}
          {builders.length === 0 && <p className="empty">No dataset builders discovered.</p>}
        </div>
      </section>
    </div>
  );
}

function DatasetBuilderPage({ name, navigate }: { name: string; navigate: (path: string) => void }) {
  const [builder, setBuilder] = useState<DatasetBuilderDetail | null>(null);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [nextBuilder, nextResources] = await Promise.all([
          api.get<DatasetBuilderDetail>(`/api/dataset-builders/${encodeURIComponent(name)}`),
          api.get<ResourceSnapshot>("/api/resources")
        ]);
        setBuilder(nextBuilder);
        setResources(nextResources);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [name]);

  const selectedVendor = useMemo(() => {
    const gpu = resources?.gpus.find((item) => selected.includes(item.id));
    return gpu?.vendor;
  }, [resources, selected]);

  const submit = async () => {
    try {
      const response = await api.post<{ run_id: string }>(`/api/datasets/${encodeURIComponent(name)}/build`, {
        config: formData,
        gpus: selected,
        force
      });
      navigate(`/runs/${encodeURIComponent(response.run_id)}`);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Box size={18} />} title={`Build ${name}`} />
        {error && <p className="error">{error}</p>}
        {builder && (
          <Form
            schema={builder.json_schema}
            uiSchema={builder.ui_schema}
            validator={validator}
            formData={formData}
            onChange={(event) => setFormData(event.formData ?? {})}
            onSubmit={() => void submit()}
          >
            <GpuPicker resources={resources} selected={selected} setSelected={setSelected} selectedVendor={selectedVendor} />
            <label className="checkline">
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              Force occupied GPU
            </label>
            <button type="submit"><Play size={15} /> Start build</button>
          </Form>
        )}
      </section>
    </div>
  );
}

function DocsPage({ path, navigate }: { path?: string | null; navigate: (path: string) => void }) {
  const [tree, setTree] = useState<DocTree | null>(null);
  const [document, setDocument] = useState<DocDocument | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<DocTree>("/api/docs").then((nextTree) => {
      setTree(nextTree);
      setError(null);
      if (!path && nextTree.nodes.length > 0) {
        const first = firstDocPath(nextTree.nodes);
        if (first) navigate(`/docs/${encodeDocPath(first)}`);
      }
    }).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (!path) {
      setDocument(null);
      return;
    }
    void api.get<DocDocument>(`/api/docs/${encodeDocPath(path)}`).then((nextDocument) => {
      setDocument(nextDocument);
      setError(null);
      setExpanded((items) => expandParents(items, nextDocument.path));
    }).catch((err) => {
      setDocument(null);
      setError(String(err));
    });
  }, [path]);

  const toggle = (nodePath: string) => {
    setExpanded((items) => {
      const next = new Set(items);
      if (next.has(nodePath)) next.delete(nodePath);
      else next.add(nodePath);
      return next;
    });
  };

  const openDoc = (docPath: string) => navigate(`/docs/${encodeDocPath(docPath)}`);

  return (
    <div className="docs-layout">
      <section className="panel docs-tree">
        <PanelTitle icon={<BookOpen size={18} />} title="Docs" />
        {error && <p className="error">{error}</p>}
        {!tree && <p className="empty">Loading docs.</p>}
        {tree && !tree.exists && <p className="empty">Docs root not found: <span className="mono">{tree.root}</span></p>}
        {tree && tree.exists && tree.nodes.length === 0 && <p className="empty">No Markdown or Typst documents found.</p>}
        {tree && tree.exists && tree.nodes.map((node) => (
          <DocTreeItem
            key={node.path}
            node={node}
            selectedPath={path ?? null}
            expanded={expanded}
            onToggle={toggle}
            onOpen={openDoc}
          />
        ))}
      </section>
      <section className="panel docs-viewer">
        {!path && <p className="empty">Select a document.</p>}
        {path && !document && !error && <p className="empty">Loading document.</p>}
        {document && (
          <>
            <PanelTitle
              icon={<FileText size={18} />}
              title={document.title}
              action={<span className="muted mono">{document.path}</span>}
            />
            {document.diagnostics.length > 0 && (
              <div className="doc-diagnostics">
                <AlertTriangle size={16} />
                <span>{document.diagnostics.join(" ")}</span>
              </div>
            )}
            <div className="facts">
              <span><b>Format</b>{document.format}</span>
              <span><b>Rendered</b>{document.rendered_kind}</span>
              <span><b>Size</b>{document.size} bytes</span>
              <span><b>Updated</b>{document.mtime ? formatTime(document.mtime) : "-"}</span>
            </div>
            <DocViewer document={document} navigate={navigate} />
          </>
        )}
      </section>
    </div>
  );
}

function DocTreeItem({
  node,
  selectedPath,
  expanded,
  onToggle,
  onOpen
}: {
  node: DocNode;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (node.type === "dir") {
    const isExpanded = expanded.has(node.path);
    return (
      <div className="doc-node">
        <button className="doc-tree-button" onClick={() => onToggle(node.path)}>
          <Folder size={15} />
          <span>{node.name}</span>
        </button>
        {isExpanded && (
          <div className="doc-children">
            {node.children.map((child) => (
              <DocTreeItem
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      className={`doc-tree-button ${selectedPath === node.path ? "selected" : ""}`}
      onClick={() => onOpen(node.path)}
    >
      <FileText size={15} />
      <span>{node.name}</span>
      <span className="muted">{node.format}</span>
    </button>
  );
}

function DocViewer({ document, navigate }: { document: DocDocument; navigate: (path: string) => void }) {
  if (document.rendered_kind === "html") {
    const onClick = (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const nextPath = resolveDocLink(document.path, link.getAttribute("href") ?? "");
      if (!nextPath) return;
      event.preventDefault();
      navigate(`/docs/${encodeDocPath(nextPath)}`);
    };
    return <article className="doc-markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: document.content }} />;
  }
  if (document.rendered_kind === "svg") {
    return <iframe className="doc-frame" sandbox="" srcDoc={document.content} title={document.title} />;
  }
  return <pre className="doc-source">{document.content}</pre>;
}

function ComparePage({ ids, navigate }: { ids: string[]; navigate: (path: string) => void }) {
  const [data, setData] = useState<CompareRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = ids.map((id) => `run_id=${encodeURIComponent(id)}`).join("&");
    void api.get<CompareRunsResponse>(`/api/compare/runs?${params}`).then(setData).catch((err) => setError(String(err)));
  }, [ids.join(",")]);

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle icon={<Gauge size={18} />} title="Run Compare" />
        {error && <p className="error">{error}</p>}
        {data && (
          <>
            <div className="compare-grid">
              <div className="row head"><span>Run</span><span>Status</span><span>Metrics</span></div>
              {data.runs.map((run) => (
                <button className="row clickable" key={run.run_id} onClick={() => navigate(`/runs/${encodeURIComponent(run.run_id)}`)}>
                  <span className="mono">{run.run_id}</span>
                  <Status status={run.status} />
                  <span>{Object.entries(run.metrics).map(([name, stats]) => `${name}: latest ${stats.latest ?? "-"} min ${stats.min ?? "-"} max ${stats.max ?? "-"}`).join(", ")}</span>
                </button>
              ))}
            </div>
            <div className="compare-grid">
              <div className="row head"><span>Config field</span><span>Values</span><span>Missing</span></div>
              {data.config_diffs.map((diff) => (
                <div className="row" key={diff.field}>
                  <span className="strong">{diff.field}</span>
                  <span>{Object.entries(diff.values).map(([runId, value]) => `${runId}: ${formatValue(value)}`).join(", ")}</span>
                  <span>{diff.missing_run_ids.join(", ") || "-"}</span>
                </div>
              ))}
              {data.config_diffs.length === 0 && <p className="empty">No config differences.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function RunTable({ runs, navigate }: { runs: RunSummary[]; navigate: (path: string) => void }) {
  return (
    <div className="table">
      <div className="row head"><span>Run</span><span>Job</span><span>Status</span><span>Tags</span><span>Created</span></div>
      {runs.map((run) => (
        <button className="row clickable" key={run.run_id} onClick={() => navigate(`/runs/${encodeURIComponent(run.run_id)}`)}>
          <span className="mono">{run.annotations.title || run.run_id}</span>
          <span>{run.job}</span>
          <Status status={run.status} />
          <span>{run.annotations.star ? "★ " : ""}{run.annotations.tags.join(", ")}</span>
          <span className="muted">{formatTime(run.created_at)}</span>
        </button>
      ))}
      {runs.length === 0 && <p className="empty">No runs.</p>}
    </div>
  );
}

function GpuPicker({ resources, selected, setSelected, selectedVendor }: { resources: ResourceSnapshot | null; selected: string[]; setSelected: (value: string[]) => void; selectedVendor?: string }) {
  return (
    <div className="gpu-list">
      {resources?.gpus.map((gpu) => {
        const disabled = selectedVendor !== undefined && selectedVendor !== gpu.vendor && !selected.includes(gpu.id);
        return (
          <label className={`gpu-option ${gpu.occupied ? "occupied" : ""}`} key={gpu.id}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(gpu.id)}
              onChange={(event) => {
                if (event.target.checked) setSelected([...selected, gpu.id]);
                else setSelected(selected.filter((item) => item !== gpu.id));
              }}
            />
            <span>{gpu.id}</span>
            <span className="muted">{gpu.name}</span>
            <span>{gpu.mem_used_mib}/{gpu.mem_total_mib} MiB</span>
            <span>{Math.round(gpu.util_pct)}%</span>
          </label>
        );
      })}
      {resources && resources.gpus.length === 0 && <p className="empty">No GPU backend detected.</p>}
    </div>
  );
}

function AnnotationFields({ annotations, setAnnotations, groups }: { annotations: Annotations; setAnnotations: (value: Annotations) => void; groups: Group[] }) {
  return (
    <div className="annotation-fields">
      <input placeholder="title" value={annotations.title ?? ""} onChange={(event) => setAnnotations({ ...annotations, title: event.target.value })} />
      <textarea placeholder="memo" value={annotations.memo ?? ""} onChange={(event) => setAnnotations({ ...annotations, memo: event.target.value })} />
      <input placeholder="tags comma separated" value={annotations.tags.join(", ")} onChange={(event) => setAnnotations({ ...annotations, tags: splitCsv(event.target.value) })} />
      <label><input type="checkbox" checked={annotations.star} onChange={(event) => setAnnotations({ ...annotations, star: event.target.checked })} /> Star</label>
      <select multiple value={annotations.group_ids} onChange={(event) => setAnnotations({ ...annotations, group_ids: Array.from(event.target.selectedOptions).map((option) => option.value) })}>
        {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
      </select>
    </div>
  );
}

function AnnotationEditor({ detail, groups, onSave }: { detail: RunDetail; groups: Group[]; onSave: (annotations: Annotations) => Promise<void> }) {
  const [annotations, setAnnotations] = useState<Annotations>(detail.annotations);
  useEffect(() => setAnnotations(detail.annotations), [detail.run_id, JSON.stringify(detail.annotations)]);
  return (
    <div className="annotation-editor">
      <AnnotationFields annotations={annotations} setAnnotations={setAnnotations} groups={groups} />
      <button onClick={() => void onSave(annotations)}><Save size={15} /> Save annotations</button>
    </div>
  );
}

function ResourcePanel({ resources }: { resources: ResourceSnapshot | null }) {
  return (
    <section className="panel">
      <PanelTitle icon={<Cpu size={18} />} title="Resources" />
      {!resources && <p className="empty">Loading resources.</p>}
      {resources && (
        <>
          <div className="machine">
            <span>CPU {Math.round(resources.machine.cpu_pct)}%</span>
            <span>RAM {resources.machine.mem_used_mib}/{resources.machine.mem_total_mib} MiB</span>
            <span>Disk {resources.machine.disk_used_gb}/{resources.machine.disk_total_gb} GiB</span>
          </div>
          <div className="gpu-list compact">
            {resources.gpus.map((gpu) => (
              <div className={`gpu-option ${gpu.occupied ? "occupied" : ""}`} key={gpu.id}>
                <span className="strong">{gpu.id}</span>
                <span className="muted">{gpu.name}</span>
                <span>{gpu.mem_used_mib}/{gpu.mem_total_mib} MiB</span>
                <span>{Math.round(gpu.util_pct)}%</span>
              </div>
            ))}
            {resources.gpus.length === 0 && <p className="empty">GPU information unavailable.</p>}
          </div>
        </>
      )}
    </section>
  );
}

function MetricSummary({ records }: { records: MetricRecord[] }) {
  const stats = useMemo(() => summarizeMetrics(records), [records]);
  return (
    <div className="metric-summary">
      {Object.entries(stats).map(([name, item]) => (
        <span key={name}><b>{name}</b> latest {item.latest ?? "-"} min {item.min ?? "-"} max {item.max ?? "-"}</span>
      ))}
    </div>
  );
}

function MetricChart({ records }: { records: MetricRecord[] }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string>("");
  const names = Array.from(new Set(records.map((record) => record.name))).slice(0, 12);
  const visible = selected ? records.filter((record) => record.name === selected) : records;

  useEffect(() => {
    if (!root.current) return;
    root.current.innerHTML = "";
    if (visible.length === 0) return;
    const seriesNames = Array.from(new Set(visible.map((record) => record.name))).slice(0, 6);
    const xs = Array.from(new Set(visible.map((record) => record.step ?? record.seq))).sort((a, b) => a - b);
    const series = seriesNames.map((name) => {
      const byX = new Map(visible.filter((record) => record.name === name).map((record) => [record.step ?? record.seq, record.value]));
      return xs.map((x) => byX.get(x) ?? null);
    });
    const plot = new uPlot(
      {
        width: root.current.clientWidth || 640,
        height: 260,
        scales: { x: { time: false } },
        series: [{ label: "step" }, ...seriesNames.map((name) => ({ label: name }))],
        axes: [{ label: "step" }, { label: "value" }]
      },
      [xs, ...series] as uPlot.AlignedData,
      root.current
    );
    return () => plot.destroy();
  }, [visible]);

  return (
    <>
      <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">all series</option>
        {names.map((name) => <option value={name} key={name}>{name}</option>)}
      </select>
      <div className="chart" ref={root}>{records.length === 0 && <p className="empty">No metrics.</p>}</div>
    </>
  );
}

function ArtifactList({ runId, artifacts }: { runId: string; artifacts: Artifact[] }) {
  const directories = artifacts.filter((artifact) => artifact.kind === "dir");
  const files = artifacts.filter((artifact) => artifact.kind === "file");
  return (
    <>
      {directories.map((artifact) => (
        <div className="artifact" key={artifact.path}><Box size={15} /> {artifact.path}/ <span className="muted">{artifact.size} bytes</span></div>
      ))}
      {files.map((artifact) => (
        <a className="artifact" href={`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeArtifactPath(artifact.path)}`} key={artifact.path}>
          <FileDown size={15} /> {artifact.path} <span className="muted">{artifact.size} bytes</span>
        </a>
      ))}
      {artifacts.length === 0 && <p className="empty">No artifacts.</p>}
    </>
  );
}

function LineagePanel({
  graph,
  centerRunId,
  navigate,
  onCreateManualLink,
  onDeleteManualLink
}: {
  graph: LineageGraph | null;
  centerRunId: string;
  navigate: (path: string) => void;
  onCreateManualLink: (src: string, dst: string, note: string) => Promise<void>;
  onDeleteManualLink: (linkId: string) => Promise<void>;
}) {
  const [src, setSrc] = useState("");
  const [dst, setDst] = useState(`run:${centerRunId}`);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    try {
      await onCreateManualLink(src, dst, note);
      setSrc("");
      setDst(`run:${centerRunId}`);
      setNote("");
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  if (!graph) return <p className="empty">Loading lineage.</p>;
  return (
    <div className="lineage">
      <div className="inline-tools">
        <input placeholder="from node id" value={src} onChange={(event) => setSrc(event.target.value)} />
        <input placeholder="to node id" value={dst} onChange={(event) => setDst(event.target.value)} />
        <input placeholder="note" value={note} onChange={(event) => setNote(event.target.value)} />
        <button onClick={() => void create()} disabled={!src || !dst}>Add link</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="table compact-table">
        <div className="row head"><span>Node</span><span>Type</span><span>Collapsed</span></div>
        {graph.nodes.map((node) => {
          const content = (
            <>
              <span className="mono">{node.label}</span>
              <span>{node.type}</span>
              <span>{node.collapsed_into ?? "-"}</span>
            </>
          );
          if (node.type === "run") {
            return (
              <button className="row clickable" key={node.id} onClick={() => navigate(`/runs/${encodeURIComponent(node.id.replace(/^run:/, ""))}`)}>
                {content}
              </button>
            );
          }
          return <div className="row" key={node.id}>{content}</div>;
        })}
      </div>
      <div className="table compact-table">
        <div className="row head"><span>From</span><span>Type</span><span>To</span></div>
        {graph.edges.map((edge, index) => (
          <div className="row" key={`${edge.src}-${edge.dst}-${edge.type}-${index}`}>
            <span className="mono">{edge.src}</span>
            <span>{edge.type}{edge.artifact ? ` ${edge.artifact}` : ""}{edge.note ? ` ${edge.note}` : ""}</span>
            <span className="mono">{edge.dst}{edge.link_id ? <button onClick={() => void onDeleteManualLink(edge.link_id!)}>Delete</button> : null}</span>
          </div>
        ))}
        {graph.edges.length === 0 && <p className="empty">No lineage edges.</p>}
      </div>
    </div>
  );
}

function LogPanel({ title, text }: { title: string; text: string }) {
  return (
    <div className="log-panel">
      <h3>{title}</h3>
      <pre>{text || "No log output."}</pre>
    </div>
  );
}

function PanelTitle({ icon, title, action }: { icon: JSX.Element; title: string; action?: JSX.Element }) {
  return (
    <div className="panel-title">
      <h2>{icon}{title}</h2>
      {action}
    </div>
  );
}

function IconButton({ icon, title, onClick }: { icon: JSX.Element; title: string; onClick: () => void }) {
  return <button className="icon" title={title} onClick={onClick}>{icon}</button>;
}

function Status({ status }: { status: string }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function parseRoute(path: string, search: string): Route {
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  if (parts[0] === "jobs" && parts[1]) return { kind: "job", name: decodeURIComponent(parts[1]), configName: params.get("config") };
  if (parts[0] === "runs" && parts[1]) return { kind: "run", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "groups" && parts[1]) return { kind: "group", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "groups") return { kind: "groups" };
  if (parts[0] === "configs") return { kind: "configs" };
  if (parts[0] === "datasets" && parts[1] === "build" && parts[2]) return { kind: "datasetBuilder", name: decodeURIComponent(parts[2]) };
  if (parts[0] === "datasets") return { kind: "datasets" };
  if (parts[0] === "docs") return { kind: "docs", path: parts.length > 1 ? decodeDocPath(parts.slice(1)) : null };
  if (parts[0] === "compare") return { kind: "compare", ids: params.getAll("run_id") };
  return { kind: "dashboard" };
}

async function problemText(response: Response): Promise<string> {
  try {
    const problem = await response.json();
    return problem.detail ?? problem.title ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

async function fetchLog(id: string, stream: "stdout" | "stderr"): Promise<{ text: string; nextSince: number }> {
  const response = await fetch(`/api/runs/${encodeURIComponent(id)}/logs?stream=${stream}`);
  if (!response.ok) throw new Error(await problemText(response));
  const text = await response.text();
  const nextSince = Number.parseInt(response.headers.get("X-Log-Next-Since") ?? "-1", 10);
  return { text, nextSince: Number.isFinite(nextSince) ? nextSince : -1 };
}

function openLogStream(
  id: string,
  stream: "stdout" | "stderr",
  since: number,
  setText: (updater: (text: string) => string) => void
): EventSource {
  const events = new EventSource(`/api/runs/${encodeURIComponent(id)}/logs/stream?stream=${stream}&since=${since}`);
  events.addEventListener("log", (event) => {
    const record = JSON.parse((event as MessageEvent).data) as { line: string };
    setText((text) => `${text}${record.line}\n`);
  });
  return events;
}

function summarizeMetrics(records: MetricRecord[]) {
  const values: Record<string, number[]> = {};
  for (const record of records) values[record.name] = [...(values[record.name] ?? []), record.value];
  return Object.fromEntries(Object.entries(values).map(([name, items]) => [name, {
    latest: items.length ? items[items.length - 1] : undefined,
    min: Math.min(...items),
    max: Math.max(...items)
  }]));
}

function emptyAnnotations(): Annotations {
  return { title: "", memo: "", tags: [], star: false, group_ids: [] };
}

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function unique(value: string, index: number, array: string[]) {
  return array.indexOf(value) === index;
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "-";
  return JSON.stringify(value);
}

function encodeArtifactPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeDocPath(path: string) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function firstDocPath(nodes: DocNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "file") return node.path;
    const child = firstDocPath(node.children);
    if (child) return child;
  }
  return null;
}

function expandParents(current: Set<string>, path: string) {
  const next = new Set(current);
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    next.add(parts.slice(0, index).join("/"));
  }
  return next;
}

function resolveDocLink(currentPath: string, href: string): string | null {
  if (!href || href.startsWith("#")) return null;
  let parsed: URL;
  try {
    const baseDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
    parsed = new URL(href, `https://mikon.local/${baseDir}`);
  } catch {
    return null;
  }
  if (parsed.origin !== "https://mikon.local") return null;
  const path = safeDecodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (path === null) return null;
  if (!isSupportedDocPath(path)) return null;
  return path;
}

function decodeDocPath(parts: string[]): string | null {
  const decoded: string[] = [];
  for (const part of parts) {
    const value = safeDecodeURIComponent(part);
    if (value === null) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSupportedDocPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".typ");
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}
