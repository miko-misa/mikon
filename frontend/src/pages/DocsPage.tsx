import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DocTree, DocNode, DocDocument } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { BookOpen, FileText, Folder, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface DocsPageProps {
  docPath?: string | null;
  navigate: (path: string) => void;
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
}: {
  node: DocNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);

  if (node.type === "file") {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          selectedPath === node.path
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
        {node.format && (
          <Badge variant="outline" className="ml-auto text-xs shrink-0">
            {node.format}
          </Badge>
        )}
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.length > 0 && (
        <div className="ml-4 border-l border-border pl-2 mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocsPage({ docPath, navigate }: DocsPageProps) {
  const [tree, setTree] = useState<DocTree | null>(null);
  const [doc, setDoc] = useState<DocDocument | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);

  useEffect(() => {
    api
      .get<DocTree>("/api/docs/tree")
      .then(setTree)
      .catch((e: unknown) => toast.error(String(e)));
  }, []);

  useEffect(() => {
    if (!docPath) {
      setDoc(null);
      return;
    }
    setLoadingDoc(true);
    api
      .get<DocDocument>(`/api/docs/render?path=${encodeURIComponent(docPath)}`)
      .then((d) => {
        setDoc(d);
        setLoadingDoc(false);
      })
      .catch((e: unknown) => {
        toast.error(String(e));
        setLoadingDoc(false);
      });
  }, [docPath]);

  function handleSelect(path: string) {
    navigate(`/docs/${path}`);
  }

  return (
    <div className="flex h-full">
      {/* Sidebar tree */}
      <aside className="w-64 shrink-0 border-r border-border">
        <div className="p-3 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            Documentation
          </h2>
        </div>
        <ScrollArea className="h-[calc(100vh-8rem)]">
          <div className="p-2 space-y-0.5">
            {tree == null ? (
              <div className="space-y-1.5 p-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : !tree.exists ? (
              <p className="text-xs text-muted-foreground p-2">
                No docs directory found
              </p>
            ) : tree.nodes.length === 0 ? (
              <p className="text-xs text-muted-foreground p-2">No documents</p>
            ) : (
              tree.nodes.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  selectedPath={docPath ?? null}
                  onSelect={handleSelect}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Document viewer */}
      <main className="flex-1 overflow-auto p-6">
        {!docPath ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="text-base font-medium">Select a document</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Choose a file from the sidebar to view it
            </p>
          </div>
        ) : loadingDoc ? (
          <div className="space-y-3 max-w-3xl">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : doc ? (
          <div className="max-w-3xl">
            {doc.diagnostics.length > 0 && (
              <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-400">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span className="font-medium">Build warnings</span>
                </div>
                {doc.diagnostics.map((d, i) => (
                  <p key={i} className="text-xs mt-1">{d}</p>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 mb-4">
              <h1 className="text-2xl font-bold">{doc.title}</h1>
              <Badge variant="outline" className="text-xs">
                {doc.format}
              </Badge>
            </div>

            {doc.rendered_kind === "html" && (
              <div
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: doc.content }}
              />
            )}
            {doc.rendered_kind === "svg" && (
              <iframe
                className="w-full rounded-lg border border-border bg-white"
                style={{ height: "75vh" }}
                srcDoc={doc.content}
                title={doc.title}
                sandbox=""
              />
            )}
            {doc.rendered_kind === "source" && (
              <pre className="overflow-auto rounded-lg bg-muted/30 p-4 text-sm font-mono">
                {doc.content}
              </pre>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
