# mikon — contributor & maintainer guide

mikon is a self-hosted GPU job management tool for ML experiments.
PyPI: `pip install mikon` / `uv tool install mikon`
Repo: https://github.com/miko-misa/mikon

---

## Architecture

```
mikon/
  cli.py              # typer CLI (serve / run / stop / doctor / dataset / init)
  _utils.py           # shared utilities (is_relative_to)
  _runner.py          # in-process job runner bootstrap
  sdk/                # public Python SDK (imported by user job scripts)
    config.py         # Config base class (Pydantic)
    context.py        # RunContext — log_metric, log_artifact, use_dataset, use_artifact
    job.py            # @mikon.job decorator + registry
    module.py         # @mikon.module, ModuleRef, ModuleFactory
    datasets.py       # @mikon.dataset decorator
  server/             # FastAPI backend
    app.py            # create_app() — mounts router + static frontend
    api.py            # all REST endpoints (/api/*)
    models.py         # Pydantic request/response models
    settings.py       # load_settings() — reads mikon.toml via tomllib
    store.py          # RunStore — filesystem R/W for runs, metrics, artifacts, configs
    discovery.py      # subprocess-based job/module/dataset discovery
    runner.py         # subprocess job launcher + heartbeat monitor
    resources.py      # GPU (nvidia-ml-py / amdsmi) + CPU metrics
    docs.py           # document tree + markdown/typmark rendering
    registry.py       # in-memory job/module registry cache
    schema.py         # JSON schema extraction from Pydantic Config classes
    problems.py       # RFC 9457 ProblemException + handlers
  templates/
    docs/
      USAGE.md        # end-user documentation template (English) — mikon init が配置
      USAGE-ja.md     # end-user documentation template (Japanese)
      CLAUDE.md       # AI context template for user projects (Claude Code)
      AGENTS.md       # AI context template for user projects (Codex CLI)
  web/                # Vite build output — gitignored, wheel の artifacts に含まれる
frontend/             # React + Tailwind + shadcn/ui ソース
  src/
    pages/            # ページコンポーネント (RunsPage, JobLaunchPage, DocsPage, …)
    components/       # 共有コンポーネント (ConfigForm, LineageCanvas, …)
    components/ui/    # shadcn/ui primitives
    lib/              # API クライアントなど
  vite.config.ts      # outDir: ../mikon/web
tests/
  test_discovery_runner_api.py
  test_sdk.py
```

### データフロー

```
user script  ──@mikon.job──>  sdk/job.py (registry)
                                    |
mikon run  ──POST /api/runs──>  api.py
                                    |
                             discovery.py  (subprocess で @mikon.job を発見)
                                    |
                             runner.py    (subprocess でジョブ実行)
                                    |
                             store.py     (.mikon/ へ書き込み)
```

---

## 開発セットアップ

```bash
# Python 依存
uv sync

# フロントエンド依存
cd frontend && npm install

# バックエンド起動（フロントエンドは別途 dev server を使う）
uv run mikon serve

# フロントエンド dev server（プロキシで /api を 8000 番へ転送）
cd frontend && npm run dev
```

---

## テスト

```bash
uv run pytest          # 63 テスト（バックエンドのみ）
```

フロントエンドのテストは現時点で存在しない。

---

## リリース手順（v0.0.5 以降）

### 1. フロントエンドをビルド

**必須。忘れると PyPI に古い UI が含まれる。**

```bash
cd frontend
npm install          # 依存が変わった場合
npm run build        # → ../mikon/web/ に出力
cd ..
```

### 2. テストを通す

```bash
uv run pytest
```

### 3. バージョンを上げる

[pyproject.toml](pyproject.toml) の `version` を更新する。

```toml
[project]
version = "0.0.5"
```

### 4. コミット & タグ

```bash
git add pyproject.toml
git commit -m "chore: bump version to 0.0.5"
git tag v0.0.5
git push origin main
git push origin v0.0.5
```

### 5. ビルド

```bash
uv build
# → dist/mikon-0.0.5.tar.gz
# → dist/mikon-0.0.5-py3-none-any.whl
```

### 6. PyPI へアップロード

`~/.pypirc` のトークンを使う（uv publish は自動読み込みしないため twine を使う）:

```bash
uv tool run twine upload dist/mikon-0.0.5*
```

### 7. 確認

https://pypi.org/project/mikon/ でバージョンが上がっていることを確認。

---

## 重要な実装メモ

### フロントエンドのバンドル方法

`mikon/web/` は `.gitignore` に入っているが、`pyproject.toml` の `[tool.hatch.build] artifacts` に指定されているため wheel には含まれる。`app.py` が `StaticFiles` でマウントする。

### `[mikon] python` 設定

`mikon.toml` の `python` フィールドで venv の Python を指定できる。`settings.py` は相対パスを `.resolve()` せずに解決する（シンボリックリンクを保持して `pyvenv.cfg` を正しく認識させるため）。

### SSE エンドポイント

`sse_starlette.EventSourceResponse` を使用。`/api/runs/{id}/stream`（metrics+status）、`/api/runs/{id}/logs/stream`（ログ）、`/api/resources/stream`（GPU/CPU）、`/api/docs/stream`（ドキュメントホットリロード）の4本。

### Job 名

`@mikon.job def train(...)` は `"train"` というキーでレジストリに登録される（`target.__name__`）。`mikon run train --gpu nvidia:0` のように関数名で指定する。

### ドキュメント形式

`.md`（Markdown + pymdownx）、`.typ`（Typst、typst CLI が必要）、`.tmd`（TypMark、typmark-cli が必要）に対応。TypMark は `typmark-cli --render` の stdout を sandboxed `<iframe srcDoc>` で表示。

---

## ファイル変更時の注意

| 変更対象 | 連動して変更が必要なもの |
|---|---|
| `USAGE.md` / `USAGE-ja.md`（ルート） | `mikon/templates/docs/` の同名ファイルも同期 |
| `mikon/templates/docs/CLAUDE.md` | `mikon/templates/docs/AGENTS.md` も同内容に同期 |
| `mikon/server/models.py` の型 | `frontend/src/` の対応する TypeScript 型も更新 |
| フロントエンドの UI 変更 | リリース前に必ず `npm run build` でビルド |
