import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { JobInfo } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, FileCode } from "lucide-react";
import { toast } from "sonner";

interface JobsPageProps {
  navigate: (path: string) => void;
}

export function JobsPage({ navigate }: JobsPageProps) {
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<JobInfo[]>("/api/jobs")
      .then((j) => { if (!cancelled) setJobs(j); })
      .catch((e: unknown) => toast.error(String(e)));
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Jobs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Discovered training jobs and experiments
        </p>
      </div>

      {jobs == null ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-16 text-center">
          <Zap className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium">No jobs found</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Define jobs with the @mikon.job decorator
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.map((job) => (
            <Card
              key={job.name}
              className="hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => navigate(`/pipeline?job=${encodeURIComponent(job.name)}`)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary shrink-0" />
                  {job.name}
                </CardTitle>
                {job.doc && (
                  <CardDescription className="text-xs line-clamp-2">
                    {job.doc}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
                  <FileCode className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {job.source_file}:{job.lineno}
                  </span>
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/pipeline?job=${encodeURIComponent(job.name)}`);
                  }}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Launch
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
