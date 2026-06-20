# movie_editor（ローカル MVP）

ブラウザ上で動くマルチトラック動画エディタです。素材のアップロード、タイムライン編集（分割・結合・Undo/Redo）、Canvas プレビュー、ffmpeg による書き出しまでを単一の Next.js プロセスで行います。

[`restore_speed.sh`](restore_speed.sh) と同等の ffmpeg フィルタで「倍速っぽい動画」を元の速度・音程へ戻す機能も含みます。

## 主な機能

- **素材ライブラリ** — 動画（mp4/mkv/avi/mov/flv/wmv）と画像（png/jpg/jpeg/webp/gif）をアップロード
- **マルチトラックタイムライン** — ドラッグ＆ドロップでクリップ配置、トラック追加、分割・結合・削除
- **Canvas プレビュー** — 複数クリップの合成プレビュー（位置・スケール調整）
- **Undo / Redo** — Ctrl+Z / Shift+Ctrl+Z
- **速度復元** — 選択クリップに対し `restore_speed.sh` 相当の ffmpeg 処理
- **書き出し** — 選択クリップの区間書き出し、またはタイムライン全体の合成書き出し
- **フィルムストリップ** — アップロード後にサムネイル帯を自動生成

## 前提

- **Node.js** `22.14.0`（`.nvmrc` 参照。22.x マイナー差分でも通常は動作）
- **ffmpeg / ffprobe** — システム PATH 上のバイナリ、または `ffmpeg-static` / `ffprobe-static`（npm 依存）にフォールバック

## セットアップ

```bash
npm ci          # package-lock.json あり
npm run dev     # http://127.0.0.1:3000
```

```bash
npm run lint    # ESLint
npm test        # Vitest（1 回実行）
npm run test:watch
npm run build
npm run start   # 本番起動（127.0.0.1）
```

## 使い方（概要）

1. ブラウザで `http://127.0.0.1:3000` を開く
2. 素材パネルから動画・画像をアップロード
3. 素材をタイムラインへドラッグしてクリップを配置
4. ツールバーで分割・結合・削除、速度復元、書き出しを実行

キーボード・マウス操作:

| 操作 | ショートカット |
|------|----------------|
| 複数選択 | Ctrl+クリック |
| Undo / Redo | Ctrl+Z / Shift+Ctrl+Z |
| プレビュー拡大縮小 | Ctrl+ホイール |

## 技術スタック

| 項目 | 内容 |
|------|------|
| フレームワーク | Next.js 16（App Router）+ React 19 |
| バンドラ（dev） | Turbopack |
| テスト | Vitest |
| 動画処理 | ffmpeg / ffprobe |
| ストレージ | ローカル（デフォルト）または Vercel Blob |

## データ保存

### ローカルストレージ（デフォルト）

| 種別 | パス |
|------|------|
| アップロード素材 | `storage/uploads/<assetId>/input.<ext>` |
| フィルムストリップ | `storage/uploads/<assetId>/filmstrip.jpg` |
| ジョブ成果物 | `storage/jobs/<jobId>/...` |

`storage/` は実行時に自動作成され、`.gitignore` 対象です。

### Vercel Blob（任意）

`STORAGE_DRIVER=blob` または `BLOB_READ_WRITE_TOKEN` を設定すると Vercel Blob を使用します。

## 環境変数（任意）

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `MAX_UPLOAD_BYTES` | 8 GiB | アップロード上限 |
| `MAX_UPLOAD_COUNT` | 20 | 保持するアップロード数上限 |
| `MAX_JOB_COUNT` | 50 | 保持するジョブ数上限 |
| `STORAGE_DRIVER` | `local` | `local` または `blob` |
| `BLOB_READ_WRITE_TOKEN` | — | 設定時は Blob ストレージを使用 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | — | ffmpeg / ffprobe のパス上書き |
| `PORT` | 3000 | `npm run start` 時のみ（dev は 3000 固定） |

## API（主要エンドポイント）

| メソッド | パス | 用途 |
|----------|------|------|
| POST | `/api/assets` | 素材アップロード（`files` フィールド、複数可） |
| GET | `/api/assets/[assetId]/metadata` | 素材メタデータ |
| GET | `/api/assets/[assetId]/stream` | 素材ストリーム |
| POST | `/api/jobs/restore` | 速度復元ジョブ |
| POST | `/api/jobs/export-segment` | 区間書き出しジョブ |
| POST | `/api/jobs/export-composition` | 合成書き出しジョブ |
| POST | `/api/jobs/merge-kept` | 削除区間を飛ばして結合 |
| GET | `/api/jobs/[jobId]` | ジョブ状態ポーリング |
| GET | `/api/download/[jobId]` | 成果物ダウンロード |

レガシー API（`/api/videos/*`）も互換のため残っています。

## CI

GitHub Actions（`.github/workflows/ci.yml`）: `npm ci` → lint → test → build → audit。

CI では ffmpeg をインストールせず、Vitest は API をモックで検証します。実ファイル処理やブラウザ E2E には ffmpeg が必要です。

## 注意

- 処理はローカル CPU / ffmpeg に依存します。長い動画ほど時間がかかります。
- この MVP はローカル `npm run dev` 利用を前提にしています。
- エージェントによる検証手順は [AGENTS.md](AGENTS.md) を参照してください。

## 既存スクリプト

- [`restore_speed.sh`](restore_speed.sh) — 速度復元の元になったシェルスクリプト
