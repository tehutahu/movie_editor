# movie_editor（ローカル MVP）

ブラウザ上で動くマルチトラック動画エディタです。素材のアップロード、タイムライン編集（分割・結合・Undo/Redo）、Canvas 合成プレビュー、ffmpeg による書き出しまでを単一の Next.js プロセスで行います。

[`scripts/restore_speed.sh`](scripts/restore_speed.sh) と同等の ffmpeg フィルタで「倍速っぽい動画」を元の速度・音程へ戻す機能も含みます。

## 主な機能

### 素材・タイムライン

- **素材ライブラリ** — 動画（mp4/mkv/avi/mov/flv/wmv）と画像（png/jpg/jpeg/webp/gif）を複数同時アップロード
- **マルチトラックタイムライン** — 素材をドラッグして配置、トラック追加（+）、移動・端ドラッグで長さ変更
- **クリップ編集** — 分割・結合（同一トラック・複数選択）・削除・複製
- **重なり回避** — クリップ移動時、同一トラック上の重なりを自動で前後にスナップ
- **フィルムストリップ** — 動画クリップにサムネイル帯を表示（アップロード後に非同期生成）
- **タイムラインズーム** — 0.25×〜4×

### プレビュー・合成

- **Canvas プレビュー** — 複数トラックの映像を重ね合わせ（下位トラックが背面）
- **変形** — 選択クリップの移動・四隅ハンドルでスケール、ダブルクリックまたは ⛶ で画面フィット
- **再生** — 再生/一時停止、1フレーム送り、先頭/末尾ジャンプ、全画面プレビュー
- **音声** — 最上位の動画トラックの音声をプレビュー再生（書き出しも同トラック基準）
- **レイアウト** — プレビューとタイムラインの境界をドラッグで高さ調整（`localStorage` に保存）

### ジョブ・書き出し

- **速度復元** — 選択した動画クリップに `scripts/restore_speed.sh` 相当の ffmpeg 処理を適用
- **選択クリップ書き出し** — タイムライン上の区間を mp4 でダウンロード
- **全体書き出し** — タイムライン合成を 1920×1080 mp4 でエクスポート
- **Undo / Redo** — 編集操作の取り消し（Ctrl+Z / Shift+Ctrl+Z）

## 未実装・今後の候補

現状の MVP では次の機能は**ありません**（API や旧 UI に残っているものを除く）。

| カテゴリ | 内容 |
|----------|------|
| プロジェクト保存 | タイムライン状態のファイル保存/読み込み（リロードで編集内容は失われる） |
| トラック操作 | トラック削除・並べ替え・ミュート/ソロ |
| 素材管理 | ライブラリからの素材削除・表示名変更 |
| 高度な編集 | トランジション、エフェクト、テロップ、不透明度、音量調整、リップル編集 |
| スナップ | プレイヘッド/グリッドへのスナップ（クリップ同士の重なり回避のみ） |
| merge-kept | 「削除区間を飛ばして結合」— API は存在するが NLE UI からは未接続（旧単一動画 UI のみ） |
| 書き出し設定 | 解像度・フレームレート・コーデックの UI 選択（mp4 固定） |
| 認証・共同編集 | ユーザー管理、クラウドプロジェクト |

旧来の**単一動画・マーカー区間エディタ**（`EditorLayout`）のコードはリポジトリに残っていますが、現在のトップページ（`/`）では使われていません。

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
2. 左の素材パネルから動画・画像をアップロード
3. 素材カードをタイムラインのトラックへドラッグしてクリップを配置
4. 中央の Canvas プレビューで位置・サイズを調整、下部ツールバーで分割・結合・書き出しなどを実行

### キーボード・マウス操作

| 操作 | ショートカット |
|------|----------------|
| 複数選択 | Ctrl+クリック |
| 分割 | Ctrl+X |
| 結合 | Ctrl+M |
| 複製 | Ctrl+D |
| 削除 | Delete |
| トラック追加 | Ctrl+T |
| 全体書き出し | Ctrl+E |
| 選択クリップ書き出し | Shift+Ctrl+E |
| Undo / Redo | Ctrl+Z / Shift+Ctrl+Z |
| 再生 / 一時停止 | Space |
| 1フレーム戻る / 進む | ← / → |
| 先頭 / 末尾へ | Ctrl+← / Ctrl+→ |
| プレビュー上で移動 | ドラッグ |
| サイズ変更 | 四隅ハンドルをドラッグ |
| 画面にフィット | ダブルクリック または ⛶ |
| 拡大縮小 | Ctrl+ホイール |
| タイムラインシーク | ルーラー/トラックをクリックまたはドラッグ |

プレビュー右上の **?** から操作ヘルプを開けます。

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
| 表示名 | `storage/uploads/<assetId>/displayName.txt` |
| フィルムストリップ | `storage/uploads/<assetId>/filmstrip.jpg`（動画のみ） |
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
| POST | `/api/assets` | 素材アップロード（`file` / `files`） |
| GET | `/api/assets/[assetId]/metadata` | 素材メタデータ |
| GET | `/api/assets/[assetId]/stream` | 素材ストリーム |
| GET | `/api/assets/[assetId]/filmstrip` | フィルムストリップ JPEG |
| POST | `/api/jobs/restore` | 速度復元ジョブ |
| POST | `/api/jobs/export-segment` | 区間書き出しジョブ |
| POST | `/api/jobs/export-composition` | 合成書き出しジョブ |
| POST | `/api/jobs/merge-kept` | 削除区間を飛ばして結合（レガシー UI 向け） |
| POST | `/api/jobs/thumbnails` | フィルムストリップ再生成 |
| GET | `/api/jobs/[jobId]` | ジョブ状態ポーリング |
| GET | `/api/jobs/[jobId]/metadata` | ジョブ成果物メタデータ |
| GET | `/api/jobs/[jobId]/stream` | ジョブ成果物ストリーム |
| GET | `/api/download/[jobId]` | 成果物ダウンロード |
| POST | `/api/storage/prune` | ストレージ整理 |

レガシー API（`/api/videos/*`）も互換のため残っています。新規連携は `/api/assets` を推奨します。

## CI

GitHub Actions（`.github/workflows/ci.yml`）: `npm ci` → lint → test → build → audit。

CI では ffmpeg をインストールせず、Vitest は API をモックで検証します。実ファイル処理やブラウザ E2E には ffmpeg が必要です。

## 注意

- 処理はローカル CPU / ffmpeg に依存します。長い動画ほど時間がかかります。
- この MVP はローカル `npm run dev` 利用を前提にしています。
- エージェントによる検証手順は [AGENTS.md](AGENTS.md) を参照してください。

## 既存スクリプト

- [`scripts/restore_speed.sh`](scripts/restore_speed.sh) — 速度復元の元になったシェルスクリプト
