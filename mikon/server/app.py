from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from mikon.server.api import create_api_router
from mikon.server.problems import ProblemException
from mikon.server.registry import Registry
from mikon.server.resources import ResourceMonitor
from mikon.server.runner import Runner
from mikon.server.scheduler import ChainScheduler
from mikon.server.settings import Settings, load_settings
from mikon.server.store import Store


def create_app(
    *,
    settings: Settings | None = None,
    project_root: Path | None = None,
    token: str | None = None,
) -> FastAPI:
    resolved_settings = settings or load_settings(project_root)
    store = Store(resolved_settings.store)
    registry = Registry(resolved_settings)
    resources = ResourceMonitor(resolved_settings, store)
    runner = Runner(store=store, registry=registry, resources=resources)
    scheduler = ChainScheduler(store=store, runner=runner)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        registry.refresh()
        registry.start_watching()
        scheduler.start()
        yield
        await scheduler.stop()
        registry.stop_watching()

    app = FastAPI(
        title="mikon",
        lifespan=lifespan,
        docs_url="/api/docs-ui",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )
    app.state.settings = resolved_settings
    app.state.store = store
    app.state.registry = registry
    app.state.resources = resources
    app.state.runner = runner
    app.state.scheduler = scheduler
    app.state.token = token

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def token_auth(request: Request, call_next):
        configured_token = request.app.state.token
        if configured_token and request.url.path.startswith("/api"):
            expected = f"Bearer {configured_token}"
            if request.headers.get("authorization") != expected:
                return JSONResponse(
                    {
                        "type": "/problems/unauthorized",
                        "title": "Unauthorized",
                        "status": 401,
                        "detail": "Missing or invalid bearer token.",
                        "instance": str(request.url.path),
                    },
                    status_code=401,
                    media_type="application/problem+json",
                )
        return await call_next(request)

    @app.exception_handler(ProblemException)
    async def problem_handler(request: Request, exc: ProblemException):
        return JSONResponse(
            exc.to_dict(instance=str(request.url.path)),
            status_code=exc.status,
            media_type="application/problem+json",
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            {
                "type": "/problems/request-validation-failed",
                "title": "Request validation failed",
                "status": 422,
                "detail": "Request does not match the API schema.",
                "instance": str(request.url.path),
                "errors": exc.errors(),
            },
            status_code=422,
            media_type="application/problem+json",
        )

    app.include_router(create_api_router())
    _mount_spa(app)
    return app


def _mount_spa(app: FastAPI) -> None:
    web_dir = Path(__file__).resolve().parents[1] / "web"
    assets_dir = web_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        return _spa_response(web_dir)

    @app.head("/{path:path}", include_in_schema=False)
    async def spa_head(path: str):
        return _spa_response(web_dir)


def _spa_response(web_dir: Path) -> HTMLResponse:
    index = web_dir / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return HTMLResponse(
        "<!doctype html><title>mikon</title><h1>mikon API is running</h1>"
        "<p>Build the frontend with <code>npm --prefix frontend run build</code>.</p>"
    )
