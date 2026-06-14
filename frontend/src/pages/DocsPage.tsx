import { useEffect, useRef, useState } from "react";
import type { MouseEvent, SyntheticEvent } from "react";
import { api } from "@/lib/api";
import type { DocTree, DocNode, DocDocument } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { BookOpen, FileText, Folder, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import katex from "katex";
import "katex/dist/katex.min.css";

interface DocsPageProps {
  docPath?: string | null;
  navigate: (path: string) => void;
}

type ViewMode = "rendered" | "source";

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
          <Badge
            variant="outline"
            className={cn(
              "ml-auto text-xs shrink-0",
              node.format === "markdown" && "border-blue-500/50 text-blue-400",
              node.format === "typst"    && "border-orange-500/50 text-orange-400",
              node.format === "typmark"  && "border-violet-500/50 text-violet-400",
            )}
          >
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
  const [treeError, setTreeError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  const markdownRef = useRef<HTMLDivElement | null>(null);
  const docPathRef = useRef<string | null | undefined>(docPath);

  useEffect(() => { docPathRef.current = docPath; }, [docPath]);

  function reloadTree() {
    api.get<DocTree>("/api/docs")
      .then((result) => { setTree(result); setTreeError(null); })
      .catch(() => {});
  }

  function reloadDoc(path: string) {
    api.get<DocDocument>(`/api/docs/${encodeDocPath(path)}`)
      .then(setDoc)
      .catch(() => {});
  }

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);

  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartW.current = sidebarWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current) return;
      const next = dragStartW.current + ev.clientX - dragStartX.current;
      setSidebarWidth(Math.max(160, Math.min(520, next)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    api
      .get<DocTree>("/api/docs")
      .then((result) => { setTree(result); setTreeError(null); })
      .catch((e: unknown) => {
        const message = String(e);
        setTreeError(message);
        toast.error(message);
      });

    const es = new EventSource("/api/docs/stream");
    es.addEventListener("change", () => {
      reloadTree();
      const path = docPathRef.current;
      if (path) reloadDoc(path);
    });
    es.onerror = () => {};
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!docPath) {
      setDoc(null);
      setDocError(null);
      setViewMode("rendered");
      return;
    }
    setLoadingDoc(true);
    setDoc(null);
    setDocError(null);
    setViewMode("rendered");
    api
      .get<DocDocument>(`/api/docs/${encodeDocPath(docPath)}`)
      .then((d) => {
        setDoc(d);
        setLoadingDoc(false);
      })
      .catch((e: unknown) => {
        const message = String(e);
        setDocError(message);
        toast.error(message);
        setLoadingDoc(false);
      });
  }, [docPath]);

  useEffect(() => {
    if (
      viewMode !== "rendered" ||
      doc?.rendered_kind !== "html" ||
      doc?.format === "typmark" ||
      markdownRef.current == null
    ) return;
    renderMath(markdownRef.current);
  }, [doc, viewMode]);

  function handleSelect(path: string) {
    navigate(`/docs/${path}`);
  }

  function handleTypmarkLoad(e: SyntheticEvent<HTMLIFrameElement>) {
    const frame = e.currentTarget;
    const idoc = frame.contentDocument;
    if (!idoc) return;
    // Disable scroll inside the iframe so the outer page is the only scroll container
    idoc.documentElement.style.overflow = "hidden";
    idoc.body.style.overflow = "hidden";
    const resize = () => {
      const h = idoc.body.scrollHeight;
      if (h) frame.style.height = h + "px";
    };
    resize();
    setTimeout(resize, 150);
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Resizable sidebar */}
      <aside
        className="shrink-0 flex flex-col border-r border-border relative"
        style={{ width: sidebarWidth }}
      >
        <div className="p-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            Documentation
          </h2>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {treeError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {treeError}
              </div>
            ) : tree == null ? (
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

        {/* Drag handle */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-primary/40 active:bg-primary/60 transition-colors"
          onMouseDown={onDragStart}
        />
      </aside>

      {/* Document viewer: fixed header + scrollable body */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Fixed header — only when doc is loaded */}
        {doc && (
          <div className="shrink-0 border-b border-border px-6 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-bold">{doc.title}</h1>
              <Badge variant="outline" className="text-xs shrink-0">
                {doc.format}
              </Badge>
            </div>
            <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
              {(["rendered", "source"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    "rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                    viewMode === mode
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto p-6">
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
          ) : docError ? (
            <div className="flex min-h-72 max-w-2xl flex-col items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 p-8 text-center">
              <AlertTriangle className="mb-3 h-10 w-10 text-destructive" />
              <h3 className="text-base font-medium">Document failed to load</h3>
              <p className="mt-2 text-sm text-muted-foreground">{docError}</p>
            </div>
          ) : doc ? (
            <div className="max-w-3xl mx-auto">
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

              {viewMode === "source" ? (
                <SourceBlock source={doc.source} />
              ) : (
                <>
                  {doc.rendered_kind === "html" && doc.format !== "typmark" && (
                    <div
                      ref={markdownRef}
                      className="docs-markdown max-w-none"
                      onClick={(event) => handleMarkdownClick(event, doc.path, navigate)}
                      dangerouslySetInnerHTML={{ __html: doc.content }}
                    />
                  )}
                  {doc.rendered_kind === "svg" && (
                    <div
                      className="w-full overflow-x-auto"
                      dangerouslySetInnerHTML={{ __html: doc.content }}
                    />
                  )}
                  {doc.rendered_kind === "html" && doc.format === "typmark" && (
                    <iframe
                      className="block w-full rounded-lg border border-border bg-white"
                      style={{ height: "0px" }}
                      srcDoc={doc.content}
                      title={doc.title}
                      sandbox="allow-scripts allow-same-origin"
                      onLoad={handleTypmarkLoad}
                    />
                  )}
                  {doc.rendered_kind === "source" && <SourceBlock source={doc.content} />}
                </>
              )}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function SourceBlock({ source }: { source: string }) {
  return (
    <pre className="overflow-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground">
      <code>{source}</code>
    </pre>
  );
}

function encodeDocPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function renderMath(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>(".arithmatex")) {
    const raw = element.textContent?.trim() ?? "";
    const displayMode =
      element.tagName.toLowerCase() === "div" ||
      raw.startsWith("\\[") ||
      raw.startsWith("$$");
    const tex = unwrapMath(raw);
    if (!tex) continue;
    try {
      katex.render(tex, element, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
      });
    } catch {
      element.textContent = raw;
    }
  }
}

function unwrapMath(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("\\(") && value.endsWith("\\)")) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("\\[") && value.endsWith("\\]")) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("$$") && value.endsWith("$$")) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith("$") && value.endsWith("$") && value.length > 1) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function handleMarkdownClick(
  event: MouseEvent<HTMLDivElement>,
  currentPath: string,
  navigate: (path: string) => void
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (anchor == null) return;
  const href = anchor.getAttribute("href");
  if (href == null || href === "" || href.startsWith("#")) return;
  const resolved = resolveDocHref(currentPath, href);
  if (resolved == null) return;
  event.preventDefault();
  navigate(resolved);
}

function resolveDocHref(currentPath: string, href: string): string | null {
  try {
    const baseDir = currentPath.split("/").slice(0, -1).join("/");
    const base = `http://mikon.local/${baseDir ? `${baseDir}/` : ""}`;
    const url = new URL(href, base);
    if (url.origin !== "http://mikon.local") return null;
    const path = url.pathname.replace(/^\/+/, "");
    if (!/\.(md|markdown|typ|tmd)$/i.test(path)) return null;
    return `/docs/${path}${url.hash}`;
  } catch {
    return null;
  }
}
