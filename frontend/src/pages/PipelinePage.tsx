import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  JobInfo,
  JobDetail,
  GpuInfo,
  ConfigInstance,
  CreateChainResponse,
} from "@/lib/types";
import { ConfigForm } from "@/components/ConfigForm";
import { GpuSelector } from "@/components/GpuSelector";
import { TagInput } from "@/components/TagInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { GitBranch, Plus, Trash2, ArrowDown, Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface PipelinePageProps {
  navigate: (path: string) => void;
  initialJob?: string | null;
}

type JsonSchema = Record<string, unknown>;

interface ArtifactInput {
  fromStep: number | null;
  artifact: string;
  custom: boolean;
}

interface StepState {
  job: string;
  detail: JobDetail | null;
  values: Record<string, unknown>;
  gpus: string[];
  force: boolean;
  artifactInputs: Record<string, ArtifactInput>;
  savedConfigs: ConfigInstance[];
  annTitle: string;
  annTags: string[];
  annStar: boolean;
}

// --- schema helpers (ArtifactRef fields are handled separately, not via ConfigForm) ---

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return (cur as JsonSchema) ?? null;
}

function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) return resolveSchema(resolved, root);
  }
  return schema;
}

function unwrapOptional(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const nonNull = (schema.anyOf as JsonSchema[]).filter(
      (o) => !(o.type === "null" || (Array.isArray(o.type) && o.type.includes("null")))
    );
    if (nonNull.length === 1 && nonNull.length !== schema.anyOf.length) return nonNull[0];
  }
  return schema;
}

function defaultValueForSchema(schema: JsonSchema, root: JsonSchema): unknown {
  const resolved = resolveSchema(unwrapOptional(resolveSchema(schema, root)), root);
  if (resolved.default !== undefined) return resolved.default;
  if (resolved.type === "object" && resolved.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved.properties as Record<string, JsonSchema>)) {
      const d = defaultValueForSchema(v, root);
      if (d !== undefined) out[k] = d;
    }
    return out;
  }
  return undefined;
}

function artifactRefFields(detail: JobDetail): string[] {
  const ui = detail.ui_schema as Record<string, { "ui:widget"?: string }> | undefined;
  if (!ui) return [];
  return Object.entries(ui)
    .filter(([, v]) => v && v["ui:widget"] === "artifact-ref")
    .map(([k]) => k);
}

function buildStepDefaults(detail: JobDetail, artifactFields: string[]): Record<string, unknown> {
  const schema = detail.json_schema as JsonSchema;
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (artifactFields.includes(k)) continue;
    const d = defaultValueForSchema(v, schema);
    if (d !== undefined) out[k] = d;
  }
  return out;
}

/** Schema with ArtifactRef properties stripped, so ConfigForm only edits plain fields. */
function schemaWithoutArtifactFields(detail: JobDetail, artifactFields: string[]): JsonSchema {
  if (artifactFields.length === 0) return detail.json_schema as JsonSchema;
  const schema = JSON.parse(JSON.stringify(detail.json_schema)) as JsonSchema;
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (props) {
    for (const field of artifactFields) delete props[field];
  }
  if (Array.isArray(schema.required)) {
    schema.required = (schema.required as string[]).filter((r) => !artifactFields.includes(r));
  }
  return schema;
}

function emptyStep(): StepState {
  return {
    job: "",
    detail: null,
    values: {},
    gpus: [],
    force: false,
    artifactInputs: {},
    savedConfigs: [],
    annTitle: "",
    annTags: [],
    annStar: false,
  };
}

const CUSTOM_ARTIFACT = "__custom__";

export function PipelinePage({ navigate, initialJob }: PipelinePageProps) {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [steps, setSteps] = useState<StepState[]>([emptyStep()]);
  const [onFailure, setOnFailure] = useState<"cancel" | "continue">("cancel");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [jobList, snap] = await Promise.all([
          api.get<JobInfo[]>("/api/jobs"),
          api.get<{ gpus: GpuInfo[] }>("/api/resources"),
        ]);
        if (cancelled) return;
        setJobs(jobList);
        setGpus(snap.gpus);
        if (initialJob && jobList.some((j) => j.name === initialJob)) {
          selectJob(0, initialJob);
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJob]);

  function updateStep(index: number, patch: Partial<StepState>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function selectJob(index: number, jobName: string) {
    updateStep(index, { job: jobName });
    try {
      const [detail, savedConfigs] = await Promise.all([
        api.get<JobDetail>(`/api/jobs/${jobName}`),
        api.get<ConfigInstance[]>(`/api/configs?job=${jobName}`).catch(() => [] as ConfigInstance[]),
      ]);
      const artifactFields = artifactRefFields(detail);
      const artifactInputs: Record<string, ArtifactInput> = {};
      for (const field of artifactFields) {
        artifactInputs[field] = { fromStep: null, artifact: "", custom: false };
      }
      updateStep(index, {
        detail,
        values: buildStepDefaults(detail, artifactFields),
        artifactInputs,
        savedConfigs,
      });
    } catch (e) {
      toast.error(String(e));
    }
  }

  function loadSavedConfig(index: number, name: string) {
    const step = steps[index];
    const cfg = step.savedConfigs.find((c) => c.name === name);
    if (!cfg || !step.detail) return;
    const artifactFields = artifactRefFields(step.detail);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg.values)) {
      if (!artifactFields.includes(k)) values[k] = v;
    }
    updateStep(index, { values });
  }

  function setArtifactInput(index: number, field: string, patch: Partial<ArtifactInput>) {
    const step = steps[index];
    const current = step.artifactInputs[field] ?? { fromStep: null, artifact: "", custom: false };
    updateStep(index, {
      artifactInputs: { ...step.artifactInputs, [field]: { ...current, ...patch } },
    });
  }

  function addStep() {
    setSteps((prev) => [...prev, emptyStep()]);
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function validate(): string | null {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.job) return `Step ${i + 1}: choose a job.`;
      if (step.gpus.length === 0) return `Step ${i + 1}: select at least one GPU.`;
      for (const [field, ref] of Object.entries(step.artifactInputs)) {
        if (ref.fromStep == null) return `Step ${i + 1}: pick a source step for "${field}".`;
        if (ref.fromStep >= i) return `Step ${i + 1}: "${field}" must reference an earlier step.`;
        if (!ref.artifact.trim()) return `Step ${i + 1}: choose an artifact for "${field}".`;
      }
    }
    return null;
  }

  async function handleSubmit() {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    setSubmitting(true);
    try {
      const payloadSteps = steps.map((step) => {
        const config: Record<string, unknown> = { ...step.values };
        for (const [field, ref] of Object.entries(step.artifactInputs)) {
          config[field] = {
            __artifact_ref__: { step: ref.fromStep, artifact: ref.artifact.trim() },
          };
        }
        const hasAnn = step.annTitle.trim() || step.annTags.length > 0 || step.annStar;
        const annotations = hasAnn
          ? {
              title: step.annTitle.trim() || null,
              memo: null,
              tags: step.annTags,
              star: step.annStar,
              group_ids: [],
            }
          : null;
        return { job: step.job, config, gpus: step.gpus, force: step.force, annotations };
      });
      const result = await api.post<CreateChainResponse>("/api/chains", {
        steps: payloadSteps,
        on_upstream_failure: onFailure,
      });
      const label = result.run_ids.length === 1 ? "run" : `pipeline of ${result.run_ids.length} runs`;
      toast.success(`Launched ${label}`);
      navigate(`/runs/${result.run_ids[0]}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">New Pipeline</h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A pipeline is one or more runs launched together. Steps run in order;
            when a step completes, the next one starts automatically and can
            consume the previous step's artifacts. A single step is just a normal
            run.
          </p>
        </div>

        <Separator />

        {steps.map((step, index) => {
          const artifactFields = step.detail ? artifactRefFields(step.detail) : [];
          return (
            <div key={index} className="space-y-4">
              {index > 0 && (
                <div className="flex justify-center">
                  <ArrowDown className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              <section className="rounded-lg border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Step {index + 1}</h2>
                  {steps.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeStep(index)}
                      disabled={submitting}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Job</Label>
                  <Select value={step.job} onValueChange={(v) => selectJob(index, v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select job..." />
                    </SelectTrigger>
                    <SelectContent>
                      {jobs.map((j) => (
                        <SelectItem key={j.name} value={j.name}>
                          {j.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {step.detail && (
                  <div className="mt-4 space-y-4">
                    {step.savedConfigs.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Load saved config</Label>
                        <Select onValueChange={(v) => loadSavedConfig(index, v)}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select config..." />
                          </SelectTrigger>
                          <SelectContent>
                            {step.savedConfigs.map((c) => (
                              <SelectItem key={c.name} value={c.name}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <ConfigForm
                      schema={schemaWithoutArtifactFields(step.detail, artifactFields)}
                      uiSchema={step.detail.ui_schema}
                      values={step.values}
                      onChange={(v) => updateStep(index, { values: v })}
                      disabled={submitting}
                      mode="edit"
                      title="Configuration"
                    />

                    {artifactFields.length > 0 && (
                      <div className="space-y-3 border-t border-border pt-4">
                        <h3 className="text-sm font-semibold">Inputs from previous steps</h3>
                        {artifactFields.map((field) => {
                          const ref =
                            step.artifactInputs[field] ??
                            ({ fromStep: null, artifact: "", custom: false } as ArtifactInput);
                          const sourceDetail =
                            ref.fromStep != null ? steps[ref.fromStep]?.detail : null;
                          const candidates = sourceDetail?.output_artifacts ?? [];
                          const useList = candidates.length > 0 && !ref.custom;
                          return (
                            <div key={field} className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{field}</Label>
                              <div className="flex gap-2">
                                <Select
                                  value={ref.fromStep != null ? String(ref.fromStep) : ""}
                                  onValueChange={(v) =>
                                    setArtifactInput(index, field, {
                                      fromStep: Number(v),
                                      artifact: "",
                                      custom: false,
                                    })
                                  }
                                >
                                  <SelectTrigger className="w-44">
                                    <SelectValue placeholder="From step..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {steps.slice(0, index).map((s, si) => (
                                      <SelectItem key={si} value={String(si)}>
                                        Step {si + 1}
                                        {s.job ? ` (${s.job})` : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>

                                {useList ? (
                                  <Select
                                    value={ref.artifact || ""}
                                    onValueChange={(v) => {
                                      if (v === CUSTOM_ARTIFACT) {
                                        setArtifactInput(index, field, { custom: true, artifact: "" });
                                      } else {
                                        setArtifactInput(index, field, { artifact: v });
                                      }
                                    }}
                                  >
                                    <SelectTrigger className="flex-1">
                                      <SelectValue placeholder="Select artifact..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {candidates.map((name) => (
                                        <SelectItem key={name} value={name}>
                                          {name}
                                        </SelectItem>
                                      ))}
                                      <SelectItem value={CUSTOM_ARTIFACT}>Other (type manually)…</SelectItem>
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <Input
                                    placeholder="artifact name (e.g. model.npz)"
                                    value={ref.artifact}
                                    onChange={(e) =>
                                      setArtifactInput(index, field, { artifact: e.target.value })
                                    }
                                    disabled={submitting}
                                    className="flex-1"
                                  />
                                )}
                              </div>
                              {ref.fromStep != null && candidates.length === 0 && (
                                <p className="text-xs text-muted-foreground">
                                  No detected output files for that job — type the filename it writes.
                                </p>
                              )}
                              {candidates.length > 0 && ref.custom && (
                                <button
                                  type="button"
                                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                  onClick={() =>
                                    setArtifactInput(index, field, { custom: false, artifact: "" })
                                  }
                                >
                                  Choose from detected files
                                </button>
                              )}
                            </div>
                          );
                        })}
                        {index === 0 && (
                          <p className="text-xs text-amber-400">
                            The first step cannot reference earlier steps. Move this job later in
                            the pipeline.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="space-y-2 border-t border-border pt-4">
                      <Label className="text-xs text-muted-foreground">GPUs</Label>
                      <GpuSelector
                        gpus={gpus}
                        selected={step.gpus}
                        onChange={(ids) => updateStep(index, { gpus: ids })}
                        disabled={submitting}
                      />
                      <div className="flex items-center justify-between pt-1">
                        <Label className="text-xs text-muted-foreground">
                          Force (override GPU occupancy at launch)
                        </Label>
                        <Switch
                          checked={step.force}
                          onCheckedChange={(c) => updateStep(index, { force: c })}
                          disabled={submitting}
                        />
                      </div>
                    </div>

                    <details className="border-t border-border pt-4">
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        Annotations (optional)
                      </summary>
                      <div className="mt-3 space-y-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Title</Label>
                          <Input
                            value={step.annTitle}
                            onChange={(e) => updateStep(index, { annTitle: e.target.value })}
                            placeholder="Run title..."
                            disabled={submitting}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Tags</Label>
                          <TagInput
                            value={step.annTags}
                            onChange={(tags) => updateStep(index, { annTags: tags })}
                            disabled={submitting}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => updateStep(index, { annStar: !step.annStar })}
                          disabled={submitting}
                          className="flex items-center gap-2"
                        >
                          <Star
                            className={cn(
                              "h-4 w-4",
                              step.annStar
                                ? "fill-yellow-400 text-yellow-400"
                                : "text-muted-foreground hover:text-yellow-400"
                            )}
                          />
                          <span className="text-xs text-muted-foreground">
                            {step.annStar ? "Starred" : "Mark as starred"}
                          </span>
                        </button>
                      </div>
                    </details>
                  </div>
                )}
              </section>
            </div>
          );
        })}

        <Button variant="outline" onClick={addStep} disabled={submitting} className="w-full">
          <Plus className="h-4 w-4" />
          Add step
        </Button>

        <Separator />

        {steps.length > 1 && (
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium">On upstream failure</Label>
              <p className="text-xs text-muted-foreground">
                What to do with downstream steps when an upstream step fails.
              </p>
            </div>
            <Select value={onFailure} onValueChange={(v) => setOnFailure(v as "cancel" | "continue")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cancel">Cancel downstream</SelectItem>
                <SelectItem value="continue">Continue anyway</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <Button className="w-full" size="lg" onClick={handleSubmit} disabled={submitting}>
          <GitBranch className="h-4 w-4" />
          {submitting
            ? "Submitting..."
            : steps.length === 1
              ? "Launch Run"
              : "Launch Pipeline"}
        </Button>
      </div>
    </div>
  );
}
