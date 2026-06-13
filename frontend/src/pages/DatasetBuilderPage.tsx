import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DatasetBuilderDetail, GpuInfo } from "@/lib/types";
import { ConfigForm } from "@/components/ConfigForm";
import { GpuSelector } from "@/components/GpuSelector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { FileCode, Hammer } from "lucide-react";
import { toast } from "sonner";

interface DatasetBuilderPageProps {
  builderName: string;
  navigate: (path: string) => void;
}

function buildDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.default !== undefined) {
      out[k] = v.default;
    }
  }
  return out;
}

export function DatasetBuilderPage({
  builderName,
  navigate,
}: DatasetBuilderPageProps) {
  const [builder, setBuilder] = useState<DatasetBuilderDetail | null>(null);
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [selectedGpus, setSelectedGpus] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [b, snap] = await Promise.all([
          api.get<DatasetBuilderDetail>(`/api/dataset-builders/${builderName}`),
          api.get<{ gpus: GpuInfo[] }>("/api/resources"),
        ]);
        if (cancelled) return;
        setBuilder(b);
        setGpus(snap.gpus);
        setValues(buildDefaults(b.json_schema));
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [builderName]);

  async function handleLaunch() {
    if (!builder) return;
    setLaunching(true);
    try {
      const result = await api.post<{ run_id: string }>(
        `/api/dataset-builders/${builderName}/run`,
        { config: values, gpus: selectedGpus }
      );
      toast.success(`Dataset build started: ${result.run_id}`);
      navigate(`/runs/${result.run_id}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLaunching(false);
    }
  }

  if (!builder) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Hammer className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">{builder.name}</h1>
        </div>
        {builder.doc && (
          <p className="text-sm text-muted-foreground">{builder.doc}</p>
        )}
        <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <FileCode className="h-3 w-3" />
          {builder.source_file}:{builder.lineno}
        </div>
      </div>

      <Separator />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <ConfigForm
            schema={builder.json_schema}
            uiSchema={builder.ui_schema}
            values={values}
            onChange={setValues}
            disabled={launching}
          />
        </CardContent>
      </Card>

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

      <Button
        className="w-full"
        size="lg"
        onClick={handleLaunch}
        disabled={launching}
      >
        <Hammer className="h-4 w-4" />
        {launching ? "Building..." : "Build Dataset"}
      </Button>
    </div>
  );
}
