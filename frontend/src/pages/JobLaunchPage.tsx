import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { JobDetail, GpuInfo, ConfigInstance } from "@/lib/types";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function buildDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.default !== undefined) {
      out[k] = v.default;
    } else if (v.type === "object" && v.properties) {
      out[k] = buildDefaults(v as Record<string, unknown>);
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
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Zap className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">{job.name}</h1>
        </div>
        {job.doc && (
          <p className="text-sm text-muted-foreground">{job.doc}</p>
        )}
        <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <FileCode className="h-3 w-3" />
          {job.source_file}:{job.lineno}
        </div>
      </div>

      <Separator />

      {/* Saved configs */}
      {savedConfigs.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Load saved config</Label>
          <Select onValueChange={loadSavedConfig}>
            <SelectTrigger className="max-w-xs">
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
        </div>
      )}

      {/* Config form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <ConfigForm
            schema={job.json_schema}
            uiSchema={job.ui_schema}
            values={values}
            onChange={setValues}
            disabled={launching}
          />
        </CardContent>
      </Card>

      {/* Annotations */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            Annotations{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (optional)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
            <Label className="text-sm w-12 shrink-0">Title</Label>
            <Input
              value={annTitle}
              onChange={(e) => setAnnTitle(e.target.value)}
              placeholder="Run title..."
              disabled={launching}
            />
          </div>
          <div className="grid grid-cols-[auto_1fr] items-start gap-x-4">
            <Label className="text-sm w-12 shrink-0 pt-1.5">Tags</Label>
            <TagInput
              value={annTags}
              onChange={setAnnTags}
              disabled={launching}
            />
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-4">
            <Label className="text-sm w-12 shrink-0">Star</Label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAnnStar((s) => !s)}
                disabled={launching}
                className="transition-colors"
              >
                <Star
                  className={cn(
                    "h-5 w-5",
                    annStar
                      ? "fill-yellow-400 text-yellow-400"
                      : "text-muted-foreground hover:text-yellow-400"
                  )}
                />
              </button>
              <span className="text-xs text-muted-foreground">
                {annStar ? "Starred" : "Mark as starred"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GPU selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">GPU Selection</CardTitle>
        </CardHeader>
        <CardContent>
          <GpuSelector
            gpus={gpus}
            selected={selectedGpus}
            onChange={setSelectedGpus}
            disabled={launching}
          />
        </CardContent>
      </Card>

      {/* Options */}
      <div className="flex items-center justify-between rounded-lg border border-border p-4">
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

      {/* Launch button */}
      <Button
        className="w-full"
        onClick={handleLaunch}
        disabled={launching}
        size="lg"
      >
        <Zap className="h-4 w-4" />
        {launching ? "Launching..." : "Launch Run"}
      </Button>

      {/* Save config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Save Configuration</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </div>
  );
}
