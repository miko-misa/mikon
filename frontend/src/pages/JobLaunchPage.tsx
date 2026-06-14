import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { JobDetail, GpuInfo, ConfigInstance } from "@/lib/types";
import { ConfigForm } from "@/components/ConfigForm";
import { GpuSelector } from "@/components/GpuSelector";
import { LaunchLineagePreview } from "@/components/LineageCanvas";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Zap, Save, FileCode, Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface JobLaunchPageProps {
  jobName: string;
  configName?: string | null;
  navigate: (path: string) => void;
}

function WorkbenchSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-border pt-5", className)}>
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

type JsonSchema = Record<string, unknown>;

function resolveRef(ref: string, rootSchema: JsonSchema): JsonSchema | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = rootSchema;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return (cur as JsonSchema) ?? null;
}

function resolveSchema(schema: JsonSchema, rootSchema: JsonSchema): JsonSchema {
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, rootSchema);
    if (resolved) return resolveSchema(resolved, rootSchema);
  }
  return schema;
}

function unwrapOptional(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const nonNull = (schema.anyOf as JsonSchema[]).filter(
      (option) =>
        !(option.type === "null" || (Array.isArray(option.type) && option.type.includes("null")))
    );
    if (nonNull.length === 1 && nonNull.length !== schema.anyOf.length) {
      return nonNull[0];
    }
  }
  return schema;
}

function buildDefaults(schema: JsonSchema, rootSchema: JsonSchema = schema): Record<string, unknown> {
  const resolved = resolveSchema(unwrapOptional(resolveSchema(schema, rootSchema)), rootSchema);
  const props = resolved.properties as Record<string, JsonSchema> | undefined;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const defaultValue = defaultValueForSchema(v, rootSchema);
    if (defaultValue !== undefined) {
      out[k] = defaultValue;
    }
  }
  return out;
}

function defaultValueForSchema(schema: JsonSchema, rootSchema: JsonSchema): unknown {
  const resolved = resolveSchema(unwrapOptional(resolveSchema(schema, rootSchema)), rootSchema);
  if (resolved.default !== undefined) return resolved.default;
  if (resolved["x-mikon-module-ref"] != null && Array.isArray(resolved.oneOf)) {
    return buildModuleDefault(resolved.oneOf as JsonSchema[]);
  }
  if (resolved.type === "object" && resolved.properties) {
    return buildDefaults(resolved, rootSchema);
  }
  return undefined;
}

function buildModuleDefault(options: JsonSchema[]): Record<string, unknown> | undefined {
  const selected = options[0];
  if (!selected) return undefined;
  const props = selected.properties as Record<string, JsonSchema> | undefined;
  const moduleField = props?.__module__;
  const moduleName =
    (typeof selected.title === "string" && selected.title) ||
    (typeof moduleField?.const === "string" && moduleField.const) ||
    (typeof moduleField?.default === "string" && moduleField.default);
  if (!moduleName) return undefined;

  const out: Record<string, unknown> = { __module__: moduleName };
  for (const [key, propSchema] of Object.entries(props ?? {})) {
    if (key === "__module__") continue;
    const defaultValue = defaultValueForSchema(propSchema, selected);
    if (defaultValue !== undefined) {
      out[key] = defaultValue;
    }
  }
  return out;
}

export function JobLaunchPage({ jobName, configName, navigate }: JobLaunchPageProps) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [selectedGpus, setSelectedGpus] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [force, setForce] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [savedConfigs, setSavedConfigs] = useState<ConfigInstance[]>([]);
  const [saveConfigName, setSaveConfigName] = useState("");
  const [saving, setSaving] = useState(false);

  // Annotations
  const [annTitle, setAnnTitle] = useState("");
  const [annTags, setAnnTags] = useState<string[]>([]);
  const [annStar, setAnnStar] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [j, snap, cfgs] = await Promise.all([
          api.get<JobDetail>(`/api/jobs/${jobName}`),
          api.get<{ gpus: GpuInfo[] }>("/api/resources"),
          api.get<ConfigInstance[]>(`/api/configs?job=${jobName}`),
        ]);
        if (cancelled) return;
        setJob(j);
        setGpus(snap.gpus);
        setSavedConfigs(cfgs);
        if (configName) {
          const cfg = cfgs.find((c) => c.name === configName);
          setValues(cfg ? cfg.values : buildDefaults(j.json_schema));
        } else {
          setValues(buildDefaults(j.json_schema));
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [jobName, configName]);

  async function handleLaunch() {
    if (!job) return;
    setLaunching(true);
    try {
      const result = await api.post<{ run_id: string }>("/api/runs", {
        job: jobName,
        config: values,
        gpus: selectedGpus,
        force,
        annotations: {
          title: annTitle.trim() || null,
          tags: annTags,
          star: annStar,
          memo: null,
          group_ids: [],
        },
      });
      toast.success(`Launched run ${result.run_id}`);
      navigate(`/runs/${result.run_id}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLaunching(false);
    }
  }

  async function handleSaveConfig() {
    if (!saveConfigName.trim() || !job) return;
    setSaving(true);
    try {
      await api.put(`/api/configs/${saveConfigName}`, {
        job: jobName,
        values,
        schema_hash: job.schema_hash,
      });
      toast.success(`Config "${saveConfigName}" saved`);
      const cfgs = await api.get<ConfigInstance[]>(`/api/configs?job=${jobName}`);
      setSavedConfigs(cfgs);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  function loadSavedConfig(name: string) {
    const cfg = savedConfigs.find((c) => c.name === name);
    if (cfg) setValues(cfg.values);
  }

  if (!job) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">{job.name}</h1>
          </div>
          {job.doc && (
            <p className="max-w-3xl text-sm text-muted-foreground">{job.doc}</p>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="h-3 w-3" />
            {job.source_file}:{job.lineno}
          </div>
        </div>

        <Separator />

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <main className="min-w-0 space-y-8">
            <ConfigForm
              schema={job.json_schema}
              uiSchema={job.ui_schema}
              values={values}
              onChange={setValues}
              disabled={launching}
              mode="edit"
              title="Configuration"
              description="Set the inputs that will be validated and written into the run config."
            />

            <LaunchLineagePreview jobName={job.name} values={values} />
          </main>

          <aside className="space-y-6 border-t border-border pt-6 lg:sticky lg:top-6 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            {savedConfigs.length > 0 && (
              <WorkbenchSection
                title="Load saved config"
                description="Replace the form values with a saved configuration for this job."
                className="border-t-0 pt-0"
              >
                <Select onValueChange={loadSavedConfig}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select config..." />
                  </SelectTrigger>
                  <SelectContent>
                    {savedConfigs.map((c) => (
                      <SelectItem key={c.name} value={c.name}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </WorkbenchSection>
            )}

            <WorkbenchSection
              title="Annotations"
              description="Optional metadata used for filtering and reviewing runs later."
              className={cn(savedConfigs.length === 0 && "border-t-0 pt-0")}
            >
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Title</Label>
                  <Input
                    value={annTitle}
                    onChange={(e) => setAnnTitle(e.target.value)}
                    placeholder="Run title..."
                    disabled={launching}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Tags</Label>
                  <TagInput
                    value={annTags}
                    onChange={setAnnTags}
                    disabled={launching}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Star</Label>
                  <button
                    type="button"
                    onClick={() => setAnnStar((s) => !s)}
                    disabled={launching}
                    className="flex items-center gap-2 transition-colors"
                  >
                    <Star
                      className={cn(
                        "h-5 w-5",
                        annStar
                          ? "fill-yellow-400 text-yellow-400"
                          : "text-muted-foreground hover:text-yellow-400"
                      )}
                    />
                    <span className="text-xs text-muted-foreground">
                      {annStar ? "Starred" : "Mark as starred"}
                    </span>
                  </button>
                </div>
              </div>
            </WorkbenchSection>

            <WorkbenchSection
              title="Compute"
              description="Select GPUs and decide whether to override occupancy checks."
            >
              <GpuSelector
                gpus={gpus}
                selected={selectedGpus}
                onChange={setSelectedGpus}
                disabled={launching}
              />
              <div className="flex items-center justify-between border-t border-border pt-3">
                <div>
                  <Label className="text-sm font-medium">Force launch</Label>
                  <p className="text-xs text-muted-foreground">
                    Override GPU occupancy checks
                  </p>
                </div>
                <Switch
                  checked={force}
                  onCheckedChange={setForce}
                  disabled={launching}
                />
              </div>
            </WorkbenchSection>

            <WorkbenchSection
              title="Save configuration"
              description="Store the current form values for reuse."
            >
              <div className="flex gap-2">
                <Input
                  placeholder="Config name..."
                  value={saveConfigName}
                  onChange={(e) => setSaveConfigName(e.target.value)}
                  disabled={saving}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  onClick={handleSaveConfig}
                  disabled={saving || !saveConfigName.trim()}
                >
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </WorkbenchSection>

            <div className="border-t border-border pt-5">
              <Button
                className="w-full"
                onClick={handleLaunch}
                disabled={launching}
                size="lg"
              >
                <Zap className="h-4 w-4" />
                {launching ? "Launching..." : "Launch Run"}
              </Button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
