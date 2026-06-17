import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { DashboardPage } from "@/pages/DashboardPage";
import { JobsPage } from "@/pages/JobsPage";
import { PipelinePage } from "@/pages/PipelinePage";
import { RunsPage } from "@/pages/RunsPage";
import { RunDetailPage } from "@/pages/RunDetailPage";
import { GroupsPage } from "@/pages/GroupsPage";
import { GroupDetailPage } from "@/pages/GroupDetailPage";
import { ConfigsPage } from "@/pages/ConfigsPage";
import { DatasetsPage } from "@/pages/DatasetsPage";
import { DatasetBuilderPage } from "@/pages/DatasetBuilderPage";
import { DocsPage } from "@/pages/DocsPage";
import { ComparePage } from "@/pages/ComparePage";
import type { Route } from "@/lib/types";

function parseRoute(path: string, search: string): Route {
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(search);

  if (parts.length === 0) return { kind: "dashboard" };

  switch (parts[0]) {
    case "jobs":
      // Launching a single job is just a one-step pipeline seeded with that job.
      if (parts[1]) {
        return { kind: "pipeline", job: decodeURIComponent(parts[1]) };
      }
      // /jobs → show jobs catalog
      return { kind: "job", name: "", configName: null };
    case "pipeline":
      return { kind: "pipeline", job: params.get("job") };
    case "runs":
      if (parts[1])
        return { kind: "run", id: decodeURIComponent(parts[1]) };
      return { kind: "run", id: "" };
    case "groups":
      if (parts[1])
        return { kind: "group", id: decodeURIComponent(parts[1]) };
      return { kind: "groups" };
    case "configs":
      return { kind: "configs" };
    case "datasets":
      if (parts[1])
        return { kind: "datasetBuilder", name: decodeURIComponent(parts[1]) };
      return { kind: "datasets" };
    case "docs": {
      const docPath =
        parts.length > 1
          ? parts
              .slice(1)
              .map((p) => {
                try {
                  return decodeURIComponent(p);
                } catch {
                  return p;
                }
              })
              .join("/")
          : null;
      return { kind: "docs", path: docPath };
    }
    case "compare": {
      const ids = params.get("ids")?.split(",").filter(Boolean) ?? [];
      return { kind: "compare", ids };
    }
    default:
      return { kind: "dashboard" };
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(location.pathname, location.search)
  );

  useEffect(() => {
    function onPop() {
      setRoute(parseRoute(location.pathname, location.search));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(path: string) {
    history.pushState(null, "", path);
    setRoute(parseRoute(location.pathname, location.search));
  }

  function renderPage() {
    switch (route.kind) {
      case "dashboard":
        return <DashboardPage navigate={navigate} />;
      case "job":
        return <JobsPage navigate={navigate} />;
      case "pipeline":
        return <PipelinePage navigate={navigate} initialJob={route.job} />;
      case "run":
        if (!route.id) return <RunsPage navigate={navigate} />;
        return <RunDetailPage runId={route.id} navigate={navigate} />;
      case "groups":
        return <GroupsPage navigate={navigate} />;
      case "group":
        return <GroupDetailPage groupId={route.id} navigate={navigate} />;
      case "configs":
        return <ConfigsPage navigate={navigate} />;
      case "datasets":
        return <DatasetsPage navigate={navigate} />;
      case "datasetBuilder":
        return (
          <DatasetBuilderPage
            builderName={route.name}
            navigate={navigate}
          />
        );
      case "docs":
        return (
          <DocsPage docPath={route.path} navigate={navigate} />
        );
      case "compare":
        return <ComparePage ids={route.ids} navigate={navigate} />;
    }
  }

  // Determine a stable route for sidebar active state
  // We need a "normalised" version for nav items that don't have sub-routes
  const sidebarRoute: Route = (() => {
    if (route.kind === "job" && !route.name) return { kind: "job", name: "" };
    if (route.kind === "run" && !route.id) return { kind: "run", id: "" };
    return route;
  })();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar navigate={navigate} currentRoute={sidebarRoute} />
      <main className="flex-1 overflow-auto">
        {renderPage()}
      </main>
    </div>
  );
}
