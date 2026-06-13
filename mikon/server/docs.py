from __future__ import annotations

import mimetypes
import posixpath
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Callable, Literal
from urllib.parse import quote, unquote, urlsplit

import bleach
import markdown as markdown_lib
from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor

from mikon.server.models import DocDocument, DocNode, DocTree
from mikon.server.problems import ProblemException
from mikon.server.settings import Settings


MAX_DOC_BYTES = 2 * 1024 * 1024
MAX_DOC_ASSET_BYTES = 10 * 1024 * 1024
MAX_TYPST_SVG_BYTES = 5 * 1024 * 1024
DOC_EXTENSIONS = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".typ": "typst",
}
ASSET_EXTENSIONS = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
MARKDOWN_TAGS = {
    "a",
    "abbr",
    "blockquote",
    "br",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
}
MARKDOWN_ATTRIBUTES = {
    "*": ["id", "title"],
    "a": ["href", "title"],
    "img": ["src", "alt", "title"],
    "code": ["class"],
    "th": ["align"],
    "td": ["align"],
}


class DocsService:
    def __init__(self, settings: Settings) -> None:
        if settings.docs_root is None:
            self.root = (settings.project_root / "docs").resolve()
        else:
            self.root = settings.docs_root.resolve()

    def tree(self) -> DocTree:
        if not self.root.exists():
            return DocTree(root=str(self.root), exists=False)
        if not self.root.is_dir():
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Docs root is not a directory",
                status=422,
                detail=f"Docs root is not a directory: {self.root}",
            )
        return DocTree(root=str(self.root), exists=True, nodes=self._children(self.root, set()))

    def document(self, path: str) -> DocDocument:
        doc_path = self._resolve_doc(path)
        stat = doc_path.stat()
        if stat.st_size > MAX_DOC_BYTES:
            raise ProblemException(
                type="/problems/doc-too-large",
                title="Document too large",
                status=413,
                detail=f"Document exceeds {MAX_DOC_BYTES} bytes: {path}",
                path=self._relative(doc_path),
                size=stat.st_size,
            )

        source = doc_path.read_text(encoding="utf-8")
        fmt = self._format_for(doc_path)
        if fmt == "markdown":
            content = self._render_markdown(doc_path, source)
            rendered_kind = "html"
            diagnostics: list[str] = []
        else:
            content, rendered_kind, diagnostics = self._render_typst(doc_path, source)

        return DocDocument(
            path=self._relative(doc_path),
            title=_title_for(doc_path, source),
            format=fmt,
            rendered_kind=rendered_kind,
            content=content,
            source=source,
            mtime=datetime.fromtimestamp(stat.st_mtime, UTC),
            size=stat.st_size,
            diagnostics=diagnostics,
        )

    def asset(self, path: str) -> tuple[Path, str]:
        asset_path = self._resolve_asset(path)
        media_type = ASSET_EXTENSIONS.get(asset_path.suffix.lower())
        if media_type is None:
            media_type = mimetypes.guess_type(asset_path.name)[0] or "application/octet-stream"
        return asset_path, media_type

    def _children(self, directory: Path, seen: set[Path]) -> list[DocNode]:
        resolved_directory = directory.resolve()
        if resolved_directory in seen:
            return []
        seen.add(resolved_directory)
        nodes: list[DocNode] = []
        for child in directory.iterdir():
            if _is_hidden(child):
                continue
            try:
                resolved = child.resolve()
            except OSError:
                continue
            if not _is_relative_to(resolved, self.root):
                continue
            if child.is_dir():
                children = self._children(resolved, seen)
                if children:
                    nodes.append(
                        DocNode(
                            name=child.name,
                            path=self._relative(resolved),
                            type="dir",
                            children=children,
                        )
                    )
                continue
            if not child.is_file() or child.suffix.lower() not in DOC_EXTENSIONS:
                continue
            stat = child.stat()
            nodes.append(
                DocNode(
                    name=child.name,
                    path=self._relative(resolved),
                    type="file",
                    format=self._format_for(child),
                    mtime=datetime.fromtimestamp(stat.st_mtime, UTC),
                    size=stat.st_size,
                )
            )
        nodes.sort(key=lambda node: (node.type != "dir", node.name.lower(), node.name))
        return nodes

    def _resolve_doc(self, path: str) -> Path:
        candidate = self._resolve_safe_file(path)
        if candidate.suffix.lower() not in DOC_EXTENSIONS:
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Unsupported document",
                status=415,
                detail=f"Unsupported document type: {path}",
                path=path,
            )
        return candidate

    def _resolve_asset(self, path: str) -> Path:
        candidate = self._resolve_safe_file(path)
        if candidate.suffix.lower() not in ASSET_EXTENSIONS:
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Unsupported docs asset",
                status=415,
                detail=f"Unsupported docs asset type: {path}",
                path=path,
            )
        stat = candidate.stat()
        if stat.st_size > MAX_DOC_ASSET_BYTES:
            raise ProblemException(
                type="/problems/doc-too-large",
                title="Docs asset too large",
                status=413,
                detail=f"Docs asset exceeds {MAX_DOC_ASSET_BYTES} bytes: {path}",
                path=self._relative(candidate),
                size=stat.st_size,
            )
        return candidate

    def _resolve_safe_file(self, path: str) -> Path:
        if not self.root.exists():
            raise ProblemException(
                type="/problems/doc-not-found",
                title="Document not found",
                status=404,
                detail="Docs root does not exist.",
                path=path,
            )
        if not self.root.is_dir():
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Docs root is not a directory",
                status=422,
                detail=f"Docs root is not a directory: {self.root}",
                path=path,
            )
        if not path or path.endswith("/"):
            raise ProblemException(
                type="/problems/doc-not-found",
                title="Document not found",
                status=404,
                detail=f"Unknown document: {path}",
                path=path,
            )
        pure = PurePosixPath(path)
        if (
            pure.is_absolute()
            or ".." in pure.parts
            or any(not part or part.startswith(".") for part in pure.parts)
        ):
            raise ProblemException(
                type="/problems/doc-not-found",
                title="Document not found",
                status=404,
                detail=f"Unknown document: {path}",
                path=path,
            )
        candidate = (self.root / Path(*pure.parts)).resolve()
        if not _is_relative_to(candidate, self.root) or not candidate.is_file():
            raise ProblemException(
                type="/problems/doc-not-found",
                title="Document not found",
                status=404,
                detail=f"Unknown document: {path}",
                path=path,
            )
        return candidate

    def _format_for(self, path: Path) -> Literal["markdown", "typst"]:
        fmt = DOC_EXTENSIONS.get(path.suffix.lower())
        if fmt not in {"markdown", "typst"}:
            raise ProblemException(
                type="/problems/doc-unsupported",
                title="Unsupported document",
                status=415,
                detail=f"Unsupported document type: {self._relative(path)}",
                path=self._relative(path),
            )
        return fmt

    def _relative(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def _render_markdown(self, path: Path, source: str) -> str:
        return _render_markdown(source, self._relative(path), self._is_valid_asset_reference)

    def _is_valid_asset_reference(self, path: str) -> bool:
        try:
            self._resolve_asset(path)
            return True
        except ProblemException:
            return False

    def _render_typst(self, path: Path, source: str) -> tuple[str, Literal["svg", "source"], list[str]]:
        executable = shutil.which("typst")
        if not executable:
            return source, "source", ["typst CLI was not found on PATH; showing source."]
        with tempfile.TemporaryDirectory(prefix="mikon-typst-") as temp_dir:
            output = Path(temp_dir) / "document.svg"
            try:
                completed = subprocess.run(
                    [executable, "compile", "--root", str(self.root), str(path), str(output)],
                    cwd=self.root,
                    text=True,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return source, "source", ["typst compile timed out after 10 seconds; showing source."]
            except OSError as exc:
                return source, "source", [f"typst compile failed to start: {exc}; showing source."]
            if completed.returncode != 0:
                message = (completed.stderr or completed.stdout or "typst compile failed").strip()
                return source, "source", [message[:4000]]
            if not output.exists():
                return source, "source", ["typst compile did not produce an SVG output; showing source."]
            output_size = output.stat().st_size
            if output_size > MAX_TYPST_SVG_BYTES:
                return source, "source", [
                    f"typst SVG output exceeded {MAX_TYPST_SVG_BYTES} bytes; showing source."
                ]
            return output.read_text(encoding="utf-8"), "svg", []


def _render_markdown(source: str, doc_path: str, asset_allowed: Callable[[str], bool]) -> str:
    raw_html = markdown_lib.markdown(
        source,
        extensions=["fenced_code", "tables", "toc", _DocsImageExtension(doc_path, asset_allowed)],
        output_format="html5",
    )
    return bleach.clean(
        raw_html,
        tags=MARKDOWN_TAGS,
        attributes=_allow_markdown_attribute,
        protocols={"http", "https", "mailto"},
        strip=True,
    )


def _title_for(path: Path, source: str) -> str:
    suffix = path.suffix.lower()
    for line in source.splitlines():
        stripped = line.strip()
        if suffix in {".md", ".markdown"} and stripped.startswith("# "):
            return stripped[2:].strip() or path.stem
        if suffix == ".typ" and stripped.startswith("= "):
            return stripped[2:].strip() or path.stem
        if stripped and not stripped.startswith(("#", "//", "=")):
            break
    return path.stem.replace("-", " ").replace("_", " ").strip() or path.name


class _DocsImageExtension(Extension):
    def __init__(self, doc_path: str, asset_allowed: Callable[[str], bool]) -> None:
        super().__init__()
        self.doc_path = doc_path
        self.asset_allowed = asset_allowed

    def extendMarkdown(self, md: markdown_lib.Markdown) -> None:
        md.treeprocessors.register(
            _DocsImageTreeprocessor(md, self.doc_path, self.asset_allowed),
            "mikon_docs_images",
            15,
        )


class _DocsImageTreeprocessor(Treeprocessor):
    def __init__(self, md: markdown_lib.Markdown, doc_path: str, asset_allowed: Callable[[str], bool]) -> None:
        super().__init__(md)
        self.doc_path = doc_path
        self.asset_allowed = asset_allowed

    def run(self, root):
        for element in root.iter():
            if element.tag != "img":
                continue
            src = element.get("src")
            asset_url = _asset_url_for_doc_image(self.doc_path, src or "", self.asset_allowed)
            if asset_url is None:
                element.attrib.pop("src", None)
            else:
                element.set("src", asset_url)
        return root


def _asset_url_for_doc_image(
    doc_path: str,
    src: str,
    asset_allowed: Callable[[str], bool],
) -> str | None:
    if not src or src.startswith("#"):
        return None
    parsed = urlsplit(src)
    if parsed.scheme or parsed.netloc or parsed.path.startswith("/"):
        return None
    decoded_path = unquote(parsed.path)
    base_dir = PurePosixPath(doc_path).parent
    raw_path = (base_dir / PurePosixPath(decoded_path)).as_posix()
    normalized = posixpath.normpath(raw_path)
    if normalized in {".", ""} or normalized == ".." or normalized.startswith("../"):
        return None
    pure = PurePosixPath(normalized)
    if any(part.startswith(".") for part in pure.parts):
        return None
    if pure.suffix.lower() not in ASSET_EXTENSIONS:
        return None
    asset_path = pure.as_posix()
    if not asset_allowed(asset_path):
        return None
    return "/api/docs/assets/" + "/".join(quote(part, safe="") for part in pure.parts)


def _allow_markdown_attribute(tag: str, name: str, value: str) -> bool:
    if name in MARKDOWN_ATTRIBUTES.get("*", []):
        return True
    if tag == "img":
        if name in {"alt", "title"}:
            return True
        return name == "src" and _is_safe_asset_api_url(value)
    return name in MARKDOWN_ATTRIBUTES.get(tag, [])


def _is_safe_asset_api_url(value: str) -> bool:
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return False
    prefix = "/api/docs/assets/"
    if not parsed.path.startswith(prefix):
        return False
    decoded = unquote(parsed.path.removeprefix(prefix))
    pure = PurePosixPath(decoded)
    if not decoded or pure.suffix.lower() not in ASSET_EXTENSIONS:
        return False
    return not (
        pure.is_absolute()
        or ".." in pure.parts
        or any(not part or part.startswith(".") for part in pure.parts)
    )


def _is_hidden(path: Path) -> bool:
    return path.name.startswith(".")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False
