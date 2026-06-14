import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { DatasetBuilderDetail, GpuInfo } from "@/lib/types";
import { ConfigForm } from "@/components/ConfigForm";
import { GpuSelector } from "@/components/GpuSelector";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { FileCode, Hammer } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DatasetBuilderPageProps {
  builderName: string;
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
    <div className="p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Hammer className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold">{builder.name}</h1>
          </div>
          {builder.doc && (
            <p className="max-w-3xl text-sm text-muted-foreground">{builder.doc}</p>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="h-3 w-3" />
            {builder.source_file}:{builder.lineno}
          </div>
        </div>

        <Separator />

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <main className="min-w-0">
            <ConfigForm
              schema={builder.json_schema}
              uiSchema={builder.ui_schema}
              values={values}
              onChange={setValues}
              disabled={launching}
              mode="edit"
              title="Configuration"
              description="Set the builder inputs that will be used to produce the dataset metadata."
            />
          </main>

          <aside className="space-y-6 border-t border-border pt-6 lg:sticky lg:top-6 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <WorkbenchSection
              title="Compute"
              description="Dataset builders can run CPU-only or use selected GPUs when requested."
              className="border-t-0 pt-0"
            >
              <GpuSelector
                gpus={gpus}
                selected={selectedGpus}
                onChange={setSelectedGpus}
                disabled={launching}
              />
            </WorkbenchSection>

            <div className="border-t border-border pt-5">
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
          </aside>
        </div>
      </div>
    </div>
  );
}
