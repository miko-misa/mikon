# mikon

GPUサーバー上のAI開発（学習・評価ジョブ）をブラウザで管理するセルフホスト型ツール。

**あなたは普段どおりPythonでコードを書き、関数にデコレータを付けるだけ。** ツールが自動でジョブを認識し、コンフィグのフォームを生成し、GPUを割り当てて起動し、メトリクス・ログ・成果物をリアルタイムで表示します。

---

## 特徴

- **デコレータだけで認識** — `@mikon.job` を付けるだけ。登録作業やコード変更は不要
- **コンフィグUIの自動生成** — `class Config(mikon.Config)` の Pydantic フィールドがそのままフォームになる（スライダ・セレクト・チェックボックスなど）
- **NVIDIA / AMD 両対応** — `nvidia:0` / `amd:0` の統一形式でGPUを指定。`CUDA_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES` を自動設定
- **ライブモニタリング** — メトリクスチャート・ログストリームが数秒更新（SSE）
- **成果物管理** — `ctx.log_artifact()` でブラウザからダウンロード可能
- **リネージュ追跡** — `ctx.use_dataset()` / `ctx.use_artifact()` で上流/下流グラフを自動構築
- **モジュールシステム** — 差し替え可能なコンポーネントを `@mikon.module` で登録、UIでモジュール選択フォームが自動生成
- **データセット管理** — 既存パスの登録、ビルダーによる自動作成
- **ドキュメント閲覧** — `docs/` に置いた Markdown / Typst をダッシュボードで表示
- **ファイルベース永続化** — SQLデータベース不要。すべて `.mikon/` 以下のテキストファイルに保存
- **独立プロセス** — ダッシュボードを再起動してもジョブは生き続ける

---

## 要件

- Python 3.11+
- GPUサーバー（NVIDIA ドライバ or AMD ROCm 導入済み）
- Typst ドキュメントを使う場合は `typst` CLI（任意）

---

## クイックスタート

```bash
# インストール
uv add mikon   # または pip install mikon

# プロジェクト初期化
mikon init
```

```python
# src/train.py
import mikon
from mikon import Config, RunContext
from pydantic import Field
from typing import Literal

class TrainConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    epochs: int = Field(10, ge=1, le=1000)
    optimizer: Literal["adam", "sgd"] = "adam"

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = 1.0 / (epoch + 1)
        ctx.log_metric("loss", loss, step=epoch)
```

```bash
# サーバー起動（GPUサーバー上で）
mikon serve

# CLIから起動
mikon run train --gpu nvidia:0

# 手元PCからはSSHポートフォワードで
ssh -L 8000:localhost:8000 you@gpu-server
# → ブラウザで http://localhost:8000
```

---

## インストール

```bash
uv add mikon   # 推奨
pip install mikon
```

依存ライブラリ（`pynvml`・`psutil`・`watchfiles`・`fastapi` など）は自動でインストールされます。

---

## ドキュメント

詳細な使い方・SDK リファレンス・CLI オプション・API エラーモデルは [USAGE.md](USAGE.md) を参照してください。

---

## ライセンス

MIT
