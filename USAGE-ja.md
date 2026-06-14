# mikon 使い方ガイド

> English: [USAGE.md](USAGE.md)

> Phase 1〜4 の全実装済み機能を対象にした開発者向け完全リファレンスです。

---

## 目次

1. [インストール](#1-インストール)
2. [プロジェクトの初期化](#2-プロジェクトの初期化)
3. [ジョブの書き方](#3-ジョブの書き方)
4. [Config の設計](#4-config-の設計)
5. [RunContext API](#5-runcontext-api)
6. [サーバーの起動](#6-サーバーの起動)
7. [CLIリファレンス](#7-cli-リファレンス)
8. [モジュールシステム](#8-モジュールシステム)
9. [データセット](#9-データセット)
10. [リネージュ](#10-リネージュ)
11. [整理機能（タグ・グループ・スター）](#11-整理機能タググループスター)
12. [ドキュメント閲覧](#12-ドキュメント閲覧)
13. [mikon.toml リファレンス](#13-mikontoml-リファレンス)
14. [ストアのレイアウト](#14-ストアのレイアウト)
15. [GPU管理](#15-gpu-管理)
16. [認証・アクセス制御](#16-認証アクセス制御)
17. [API エラーモデル](#17-api-エラーモデル)

---

## 1. インストール

要件：**Python 3.11+**、GPUサーバー（NVIDIA / AMD ROCm どちらでも可）。

```bash
# uv の場合（推奨）
uv add mikon

# pip の場合
pip install mikon
```

依存ライブラリ（`pynvml`・`psutil`・`watchfiles` など）は自動で入ります。`nvidia-smi` はドライバに含まれるため追加導入は不要です。AMD の場合は `amdsmi` または `rocm-smi` / `amd-smi` CLI のいずれかが利用できれば動作します。

---

## 2. プロジェクトの初期化

```bash
cd /your/project
mikon init
```

生成物：

```
mikon.toml          # サーバー設定
src/
  example.py        # サンプルジョブ（削除して構いません）
```

既存ファイルを上書きしたい場合は `--force` を渡します。

---

## 3. ジョブの書き方

「ジョブ」とは、起動してGPU上で実行し、成果物を残して終わる処理単位の定義です。**関数に `@mikon.job` デコレータを付けるだけ**でサーバーに自動認識されます（登録作業は不要）。

```python
import mikon
from mikon import Config, RunContext
from pydantic import Field
from typing import Literal

class TrainConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    batch: int = Field(32, ge=1, le=512)
    epochs: int = Field(10, ge=1, le=1000)
    optimizer: Literal["adam", "sgd"] = "adam"

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = 1.0 / (epoch + 1)
        ctx.log_metric("loss", loss, step=epoch)
        ctx.log_metric("lr", config.lr, step=epoch)

    ckpt = ctx.artifacts_dir / "model.pt"
    ckpt.write_text("dummy weights")
    ctx.log_artifact("model.pt", ckpt)
```

**シグネチャの制約**：

```python
def fn(config: <Configサブクラス>, ctx: RunContext) -> None
```

- 第1引数は `Config` のサブクラス（名前は任意）
- 第2引数は `RunContext`（名前は任意）
- 戻り値は `None`（無視されます）

`@mikon.job` にはオプション引数 `name=` があります：

```python
@mikon.job(name="my-train")    # UIに表示される名前を上書き
def train(...): ...
```

名前は `[A-Za-z0-9_.-]+` のみ使用可能です。省略するとデコレートした関数の `__name__` が使われます。

`mikon.toml` の `watch` で指定したディレクトリ配下の Python ファイルが自動スキャンされます。ファイルを保存すると `watchfiles` が検知してサーバーが再読み込みします（サーバー再起動不要）。

---

## 4. Config の設計

`mikon.Config` は **Pydantic v2 の `BaseModel`** を継承したクラスです。フィールドの制約がそのままUIのフォームに反映されます。

```python
from mikon import Config
from pydantic import Field
from typing import Literal

class MyConfig(Config):
    # 数値 + minimum/maximum 両方あり → スライダになる
    lr: float = Field(1e-3, gt=0, le=1)
    batch: int = Field(32, ge=1, le=512)

    # Literal / Enum → セレクトになる
    optimizer: Literal["adam", "sgd", "adamw"] = "adam"

    # Optional フィールド
    weight_decay: float | None = None

    # ネストしたコンフィグ（折り畳みセクションになる）
    class SchedulerConfig(Config):
        type: Literal["cosine", "linear"] = "cosine"
        warmup: int = Field(100, ge=0)

    scheduler: SchedulerConfig = SchedulerConfig()
```

**UI 自動変換ルール**：

| 型・制約 | UIウィジェット |
| --- | --- |
| `int` / `float` + `minimum` と `maximum` 両方あり | スライダ |
| `Literal[...]` / `Enum` | セレクト |
| `str` | テキスト入力 |
| `bool` | チェックボックス |
| ネストした `Config` サブクラス | 折り畳みセクション |
| `ModuleRef[T]` / `ModuleFactory[T]` | モジュール選択 + サブフォーム |

**`description` をヘルプとして表示**：

```python
lr: float = Field(1e-3, gt=0, le=1, description="学習率（Adam向け推奨: 1e-3〜3e-4）")
```

**`--set` でCLIから値を上書きする場合の型変換**：

- JSON として解釈できる値（数値・真偽値・配列・オブジェクト）はその型になります
- 解釈できなければ文字列として扱います
- ドット区切りでネストした値を指定できます：`model.depth=50`

---

## 5. RunContext API

ジョブの第2引数に注入されるランタイムハンドルです。

### 5.1 プロパティ

| プロパティ | 型 | 説明 |
| --- | --- | --- |
| `ctx.artifacts_dir` | `pathlib.Path` | 成果物の出力先ディレクトリ。起動時に自動作成済み。 |

### 5.2 メトリクス

```python
ctx.log_metric(name: str, value: int | float, step: int | None = None) -> None
```

- `name`：系列名（例：`"loss"`, `"accuracy/val"`）
- `value`：数値（`int` または `float`）
- `step`：省略すると記録は単純な時系列になります。`step=epoch` のように渡すと X 軸が step になります

ダッシュボードのチャートに数秒遅れでライブ反映されます。ストアへの書き込みはスレッドセーフです。

### 5.3 成果物

```python
ctx.log_artifact(name: str, path: str | pathlib.Path) -> pathlib.Path
```

- `name`：成果物のエイリアス名。パス区切り（`/`）を含めてサブディレクトリ構成にできます
- `path`：ファイルまたはディレクトリのパス（ソースを `artifacts/` 以下にコピーします）
- 戻り値：コピー後の `artifacts/` 内でのパス

```python
# ファイル1つ
ctx.log_artifact("weights/final.pt", Path("checkpoints/epoch_10.pt"))

# ディレクトリごと
ctx.log_artifact("outputs/", Path("results/"))
```

UIの「Artifacts」タブから一覧・ダウンロードできます。

### 5.4 データセット参照

```python
ctx.use_dataset(name: str) -> pathlib.Path
```

登録済みデータセット `name` のパスを返します。同時にリネージュ（`uses-dataset` エッジ）を `inputs.jsonl` に記録します。

```python
data_dir = ctx.use_dataset("imagenet")
# data_dir は Path オブジェクト（登録時のパス）
```

### 5.5 他runの成果物参照

```python
ctx.use_artifact(run_id: str, name: str) -> pathlib.Path
```

別runの成果物パスを返します。リネージュ（`consumes-artifact` エッジ）を記録します。

```python
weights = ctx.use_artifact("train__20260612-153000__a1b2", "weights/final.pt")
```

- `run_id` は `[A-Za-z0-9_.-]+` 形式（パス区切りや `..` は拒否）
- `name` は `artifacts/` 内への相対パス（`..` によるディレクトリ脱出は拒否）

---

## 6. サーバーの起動

GPUサーバー上で：

```bash
mikon serve
# 既定で http://127.0.0.1:8000 にバインド
```

手元のPCからはSSHポートフォワードで開きます：

```bash
ssh -L 8000:localhost:8000 you@gpu-server
# → ブラウザで http://localhost:8000 を開く
```

ダッシュボードにはジョブ一覧・実行中/完了のラン・GPU状況が表示されます。`watch` で指定したディレクトリ内のファイルを変更すると自動再読み込みします。

---

## 7. CLI リファレンス

### `mikon init`

プロジェクトを初期化します。

```
mikon init [--force]
```

| オプション | 説明 |
| --- | --- |
| `--force` | 既存ファイルを上書きします |

### `mikon serve`

ダッシュボードサーバーを起動します。

```
mikon serve [--host HOST] [--port PORT] [--token TOKEN]
```

| オプション | デフォルト | 説明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | バインドアドレス |
| `--port` | `8000` | バインドポート |
| `--token` | なし | Bearer トークン。`localhost` 以外にバインドする場合は必須 |

### `mikon run`

ジョブを起動します（サーバー経由）。

```
mikon run <JOB> --gpu <GPU_IDS> [--config CONFIG] [--set KEY=VALUE ...] [--force] [--server URL]
```

| 引数/オプション | 説明 |
| --- | --- |
| `JOB` | ジョブ名（UIに表示される名前） |
| `--gpu` | カンマ区切りのGPU ID（例：`nvidia:0`、`nvidia:0,nvidia:1`、`amd:0`） |
| `--config` | JSON コンフィグファイルのパス |
| `--set` | `key=value` 形式でコンフィグを上書き（複数指定可）。JSON 値対応・ドット区切りネスト対応 |
| `--force` | GPU占有中でも強制起動 |
| `--server` | サーバーURL（デフォルト: `http://127.0.0.1:8000`） |

**例：**

```bash
# 最小
mikon run train --gpu nvidia:0

# コンフィグファイル指定 + 上書き
mikon run train --gpu nvidia:0 --config base.json --set lr=3e-4 --set batch=64

# マルチGPU
mikon run train --gpu nvidia:0,nvidia:1

# 占有GPUに強制起動
mikon run train --gpu nvidia:0 --force

# リモートサーバー
mikon run train --gpu nvidia:0 --server http://10.0.0.5:8000
```

**`--set` の値変換ルール：**

- `--set epochs=50` → `{"epochs": 50}`（整数）
- `--set lr=3e-4` → `{"lr": 0.0003}`（浮動小数点）
- `--set use_amp=true` → `{"use_amp": true}`（真偽値）
- `--set tags=["a","b"]` → `{"tags": ["a", "b"]}`（配列）
- `--set model.depth=50` → `{"model": {"depth": 50}}`（ドット区切りネスト）
- `--set name=hello` → `{"name": "hello"}`（文字列）

### `mikon stop`

実行中のジョブを停止します（`SIGTERM` を送信）。

```
mikon stop <RUN_ID> [--server URL]
```

### `mikon doctor`

GPU検出・フレームワーク互換性を診断します。

```
mikon doctor
```

以下を点検してコンソールに出力します：

- GPUベンダー検出（NVIDIA / AMD）
- インストール済みフレームワーク（torch / jax / tensorflow）とGPUの互換性
- 「AMD機にCUDA版torchが入っている」などの設定ミスを早期発見

### `mikon dataset register`

既存パスをデータセットとして登録します。

```
mikon dataset register <NAME> <PATH> [--description DESC] [--server URL]
```

| 引数/オプション | 説明 |
| --- | --- |
| `NAME` | データセット名（`[A-Za-z0-9_.-]+`） |
| `PATH` | データセットのパス（サーバー上に存在している必要あり） |
| `--description` | 説明文 |
| `--server` | サーバーURL |

### `mikon dataset build`

データセットビルダーを起動します。

```
mikon dataset build <NAME> [--config CONFIG] [--set KEY=VALUE ...] [--gpu GPU_IDS] [--force] [--server URL]
```

| 引数/オプション | 説明 |
| --- | --- |
| `NAME` | `@mikon.dataset` でデコレートした関数名 |
| `--config` | JSON コンフィグファイルのパス |
| `--set` | コンフィグの上書き |
| `--gpu` | GPU ID（データ前処理のみなど不要な場合は省略可） |
| `--force` | GPU占有中でも強制起動 |

---

## 8. モジュールシステム

モジュールは、ジョブのコンフィグから差し替えられる**部品**です。前処理・モデル構造・損失関数など、実験ごとに切り替えたいコンポーネントをモジュールとして定義すると、UIで選択フォームが自動生成されます。

### 8.1 インターフェースの定義

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class ModelBlock(Protocol):
    def forward(self, x): ...
```

インターフェースは `Protocol` でも通常の基底クラスでも構いません。

### 8.2 モジュールの実装と登録

```python
from mikon import Config
from pydantic import Field

class ResNetConfig(Config):
    depth: int = Field(50, ge=18)

@mikon.module(implements=ModelBlock)    # ← 型が合うジョブに差せる
class ResNet:
    def __init__(self, config: ResNetConfig):
        self.config = config

    def forward(self, x):
        ...
```

- `@mikon.module(implements=T)` は自動認識されます（`watch` 対象ディレクトリ内に置いてください）
- `name=` でモジュール名を上書きできます（省略するとクラス/関数名）
- クラスと関数のどちらでも登録できます

### 8.3 ジョブからの使用：`ModuleRef[T]`

```python
import mikon
from mikon import Config, RunContext

class TrainConfig(Config):
    lr: float = 1e-3
    model: mikon.ModuleRef[ModelBlock]   # UI に選択フォームが出る

@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    # config.model はすでにインスタンス化済みのオブジェクト
    output = config.model.forward(input_data)
```

`ModuleRef[T]` フィールドを持つジョブでは、UIの `model` 欄に「`T` を実装しているモジュールの一覧」が出ます。モジュールを選ぶとそのモジュールの Config フォームが下に展開されます。

### 8.4 遅延構築：`ModuleFactory[T]`

```python
class TrainConfig(Config):
    model: mikon.ModuleFactory[ModelBlock]

@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    # 呼び出すときに kwargs を渡せる
    model_a = config.model(seed=1)
    model_b = config.model(seed=2)
```

`ModuleFactory[T]` は呼び出しのたびにインスタンスを生成する callable です。実行時引数が必要なケースやデータ並列構成に使います。

### 8.5 入れ子モジュール

モジュール自身も `ModuleRef` / `ModuleFactory` フィールドを持てます。

```python
class PipelineConfig(Config):
    encoder: mikon.ModuleRef[Encoder]
    decoder: mikon.ModuleRef[Decoder]

@mikon.module(implements=Pipeline)
class EncDecPipeline:
    def __init__(self, config: PipelineConfig): ...
```

入れ子の最大深さは `mikon.toml` の `[modules] max_nest_depth`（デフォルト: `8`）で制御します。

### 8.6 コンフィグへの直列化形式

モジュールフィールドの値は内部的に以下の形式で `config.json` に保存されます：

```json
{
  "__module__": "ResNet",
  "depth": 50
}
```

`__module__` がモジュール名、残りのキーがそのモジュールの Config フィールドです。

---

## 9. データセット

### 9.1 既存パスの登録

```python
# Python SDK から（サーバー起動前に呼ぶスクリプト等）
import mikon.datasets
mikon.datasets.register("mnist", path="/data/mnist", description="手書き数字")
```

```bash
# CLI から
mikon dataset register mnist /data/mnist --description "手書き数字"
```

名前は `[A-Za-z0-9_.-]+` のみ使用可能です。

### 9.2 ビルダーによる作成

```python
from mikon import Config, DatasetContext
from pydantic import Field

class Cifar10Config(Config):
    root: str = "/data/cache"
    train_only: bool = False

@mikon.dataset
def cifar10(config: Cifar10Config, ctx: DatasetContext) -> None:
    # ダウンロードなどの処理
    download_to(ctx.staging_dir, config.root)

    # 完成したディレクトリを "cifar10" として登録する
    ctx.add_dir(ctx.staging_dir, description="CIFAR-10 dataset")
```

ビルダー関数のシグネチャ：

```python
def fn(config: <Configサブクラス>, ctx: DatasetContext) -> None
```

**`DatasetContext` API：**

| メソッド/プロパティ | 説明 |
| --- | --- |
| `ctx.staging_dir` | 一時作業ディレクトリ（`pathlib.Path`） |
| `ctx.dataset_name` | ビルダー名（登録時のデータセット名） |
| `ctx.add_dir(path, description=None)` | パスをデータセットとしてストアに登録します |

### 9.3 ジョブからの参照

```python
@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    data_dir = ctx.use_dataset("mnist")   # Path が返る
    # data_dir 以下を読む
```

`use_dataset` は自動でリネージュ（`uses-dataset` エッジ）を記録します。

---

## 10. リネージュ

mikon は以下のエッジを自動で記録します：

| エッジ種別 | 記録タイミング |
| --- | --- |
| `uses-dataset` | `ctx.use_dataset(name)` を呼んだとき |
| `consumes-artifact` | `ctx.use_artifact(run_id, name)` を呼んだとき |
| `uses-module` | モジュールを含む Config でジョブを起動したとき |
| `produces-dataset` | `ctx.add_dir(...)` でデータセットビルダーが完了したとき |

UIの「Lineage」ビューでは、あるランを中心に上流（親）・下流（子）方向を指定深さまでグラフとして表示します。モジュールリンクはデフォルト折り畳みで、必要なときだけ展開できます。

**手動リンク**（成果物を介さない「参考にした」関係）はUIから張ることもできます。

**APIでの取得：**

```
GET /api/runs/{run_id}/lineage?direction=both&depth=2&include_modules=false
```

---

## 11. 整理機能（タグ・グループ・スター・削除）

各ランにはアノテーションを付けられます。**起動時**（UI のジョブ起動フォームまたは `CreateRunRequest.annotations`）に設定することも、**起動後**（UI の Overview タブまたは `PATCH /api/runs/{run_id}`）に編集することもできます。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `title` | `str \| null` | 表示名。省略するとラン ID が表示名として扱われる |
| `memo` | `str \| null` | メモ・ノート |
| `tags` | `list[str]` | 自由タグ（複数） |
| `star` | `bool` | スター（お気に入りフラグ） |
| `group_ids` | `list[str]` | 所属グループの ID 一覧 |

`title` はラン一覧・詳細ヘッダでの主表示として使われます。未設定の場合はラン ID が代わりに表示されます。

**グループ** は独立した管理対象で、複数のランをまとめて比較・整理するための入れ物です。グループ単位でランを並べて比較できます。

`GET /api/runs` でのフィルタリング：

```
GET /api/runs?tag=baseline&star=true&group=<group_id>&job=train&status=completed
```

### ランの削除

UIのラン詳細画面の削除ボタン、またはラン一覧の各行・一括削除から実行できます。必ず確認ダイアログが表示されます。実行中（`status=running`）のランは削除できません。

```
DELETE /api/runs/{run_id}    # 204 No Content
```

削除するとストア内のディレクトリ（メタ・ログ・成果物を含む）がすべて消去されます。**この操作は取り消せません。**

---

## 12. ドキュメント閲覧

プロジェクトの `docs/` ディレクトリ（`mikon.toml` の `[docs] root` で変更可能）に配置した Markdown / Typst / TypMark ファイルをダッシュボードの `Docs` タブで閲覧できます。

```
docs/
  index.md
  assets/
    plot.png          # 画像ファイル（.avif/.gif/.jpeg/.jpg/.png/.webp）
  experiments/
    notes.md
  reports/
    summary.typ       # Typst ドキュメント
    report.tmd        # TypMark ドキュメント
```

**制約と動作：**

- Markdown は サーバー側でHTMLへレンダリングされ、危険な HTML は sanitize されます
- Markdown 内の相対画像（`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`）は `docs/assets/` 配下のものだけ表示されます
- 外部URL画像や `docs/` 外への参照は表示されません
- Typst は PATH 上に `typst` CLI がある場合のみ SVG へコンパイルされます。CLI がない・コンパイル失敗・SVG出力上限超過（5 MiB）の場合はソース表示に縮退し、理由が画面に出ます
- TypMark ドキュメント（`.tmd`）は PATH 上に `typmark-cli` がある場合に `typmark-cli --render` で HTML へレンダリングされ、サンドボックス化した iframe 内で表示されます。CLI がない・レンダリング失敗の場合はソース表示に縮退します
- いずれの形式もソースファイルを保存するとブラウザが自動再読み込みします（ホットリロード）。手動リフレッシュは不要です
- ファイルサイズ上限：ドキュメント 2 MiB、アセット 10 MiB
- 隠しファイル（`.` で始まるファイル・ディレクトリ）はツリーに表示されません
- シンボリックリンクは `docs/` 外への参照を拒否します（循環リンクも検出）
- ドキュメント編集・全文検索・PDF出力は対象外です

---

## 13. mikon.toml リファレンス

```toml
[mikon]
# ジョブを自動スキャンするディレクトリのリスト（相対パス or 絶対パス）
watch = ["src"]

# run・メトリクス・成果物の保存先（相対パス）
store = ".mikon"

[gpu]
# このメモリ（MiB）を超えると「占有中」とみなす（NVIDIA: nvml、AMD: amdsmi/CLI）
occupancy_mem_mb = 500

# この使用率（%）を超えると「占有中」とみなす
occupancy_util = 5

[modules]
# ModuleRef / ModuleFactory の入れ子の最大深さ（循環防止）
max_nest_depth = 8

[docs]
# ダッシュボードの Docs タブで表示するドキュメントルート（相対パス）
root = "docs"
```

すべてのキーはオプションです。`mikon.toml` が存在しない場合はデフォルト値が使われます。

---

## 14. ストアのレイアウト

ストアのデフォルト位置は `.mikon/`（`mikon.toml` の `store` で変更可能）。ランタイムは環境変数 `MIKON_STORE` で上書きできます。

```
.mikon/
  runs/
    train__20260612-153000__a1b2/    # run_id = {job}__{YYYYMMDD-HHMMSS}__{4hex}
      meta.json          # job名、開始時刻、GPUs、tags、star、group_id など
      status.json        # 現在のステータス（running/completed/failed/stopped/unknown）
      config.json        # 起動時のコンフィグ（確定値）
      metrics.jsonl      # log_metric の記録（1行1レコード）
      artifacts.jsonl    # log_artifact の記録（1行1レコード）
      inputs.jsonl       # use_dataset / use_artifact / uses-module の記録
      heartbeat          # ランナーが2秒ごとに更新（30秒以上更新なし → unknown）
      logs/
        stdout.log
        stderr.log
      artifacts/
        model.pt         # log_artifact でコピーされたファイル
  datasets/
    mnist/
      meta.json          # name, path, description, source, created_at
  configs/               # 保存済みコンフィグ（PUT /api/configs/{name}）
  groups/                # グループ（POST /api/groups）
  links/                 # 手動リンク（POST /api/links）
```

**ラン ID のフォーマット：** `{job}__{YYYYMMDD-HHMMSS}__{4hex}`（例：`train__20260612-153000__a1b2`）

ファイルはすべてテキストベースで、ダッシュボードなしに直接読めます。ダッシュボードは「ファイルの表示レイヤー」であり、ジョブはダッシュボードと独立したプロセスとして動作します。

---

## 15. GPU 管理

### GPU ID の形式

mikon では GPU を `vendor:index` の統一形式で指定します：

| 形式 | 説明 |
| --- | --- |
| `nvidia:0` | NVIDIA GPU の index 0 |
| `nvidia:1` | NVIDIA GPU の index 1 |
| `amd:0` | AMD GPU の index 0 |

**制約：1つのジョブでは同じベンダーの GPU だけを選択できます。** `nvidia:0,amd:0` のように複数ベンダーを混在させると `422 gpus-mixed-vendor` エラーになります。

### 環境変数の自動設定

ジョブ起動時、選択した GPU のベンダーに応じて以下の環境変数が自動設定されます：

| ベンダー | 環境変数 |
| --- | --- |
| NVIDIA | `CUDA_VISIBLE_DEVICES=0,1,...` |
| AMD | `ROCR_VISIBLE_DEVICES=0,1,...` |

コード内でGPUを選択する必要はありません。

### GPU占有チェック

既定では、`occupancy_mem_mb` または `occupancy_util` を超えるGPUへの起動はブロックされます（`409 gpu-occupied`）。`--force` で上書きできます。

### 診断

```bash
mikon doctor
```

GPU が正しく認識されているか、フレームワークとの互換性（例：AMD機でCUDA版torchが入っていないか）を点検します。

---

## 16. 認証・アクセス制御

| バインド先 | 認証 |
| --- | --- |
| `127.0.0.1`（デフォルト） | なし（SSH ポートフォワード推奨） |
| `0.0.0.0` 等の外部 | `--token <TOKEN>` 必須 |

外部バインド時は全 `/api` エンドポイントで `Authorization: Bearer <token>` ヘッダが必要です。

```bash
mikon serve --host 0.0.0.0 --port 8000 --token mysecrettoken
```

CLIコマンドは現時点でトークンを引数として渡す方法がないため、外部サーバーへCLIで接続する場合は直接 `httpx` / `curl` 等を使うか、ローカルでSSHフォワードを使ってください。

---

## 17. API エラーモデル

mikon は [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) 形式（`application/problem+json`）でエラーを返します。

```json
{
  "type": "/problems/gpu-occupied",
  "title": "Selected GPU is occupied",
  "status": 409,
  "detail": "GPU nvidia:0 is in use.",
  "instance": "/api/runs",
  "gpus": ["nvidia:0"],
  "occupied_by": [{"pid": 12345, "user": "alice", "used_mib": 18442}]
}
```

主要なエラー type：

| type | status | 意味 |
| --- | --- | --- |
| `/problems/job-not-found` | 404 | 未知のジョブ名 |
| `/problems/run-not-found` | 404 | 未知のラン ID |
| `/problems/gpu-occupied` | 409 | 占有GPU への非force起動 |
| `/problems/gpus-mixed-vendor` | 422 | 複数ベンダーのGPUを同一ジョブに指定 |
| `/problems/gpu-not-found` | 422 | 指定GPUが存在しない |
| `/problems/run-not-stoppable` | 409 | 終端済みランへの停止要求 |
| `/problems/config-validation-failed` | 422 | Config がスキーマ違反 |
| `/problems/config-name-conflict` | 409 | config名が別ジョブに帰属済み |
| `/problems/registry-stale` | 503 | ディスカバリの import 失敗中 |
| `/problems/dataset-not-found` | 404 | 未知のデータセット名 |
| `/problems/dataset-builder-not-found` | 404 | 未知のビルダー名 |
| `/problems/dataset-validation-failed` | 422 | データセット登録値が不正 |
| `/problems/invalid-name` | 422 | 名前に不正文字 |
| `/problems/group-not-found` | 404 | 未知のグループ ID |
| `/problems/group-validation-failed` | 422 | グループ名/説明が不正 |
| `/problems/link-not-found` | 404 | 未知のリンク ID |
| `/problems/link-validation-failed` | 422 | manual link の参照先が不正 |
| `/problems/run-start-failed` | 500 | サブプロセス起動失敗 |
| `/problems/doc-not-found` | 404 | 未知の docs パス |
| `/problems/doc-unsupported` | 415/422 | 未対応拡張子または docs root 不正 |
| `/problems/doc-too-large` | 413 | ドキュメント/アセットがサイズ上限超過 |
