# AGENTS.md

## プロジェクト概要

ローカル向け MVP の Web 動画エディタ（`movie-editor`）。Next.js 16（App Router）+ React 19。アップロード・ffmpeg ジョブ・区間編集は単一の Next.js プロセス（ポート 3000）で処理します。

## よく使うコマンド

| 目的 | コマンド |
|------|----------|
| 依存関係 | `npm ci`（`package-lock.json` あり） |
| 開発サーバー | `npm run dev` → http://127.0.0.1:3000 |
| Lint | `npm run lint` |
| テスト | `npm test` |
| 本番ビルド | `npm run build` |
| 本番起動 | `npm run start` |

詳細は [README.md](README.md) を参照。

## Cursor Cloud specific instructions

### 必須の外部依存

- **Node.js**: `package.json` の `engines.node` は `22.14.0`（`.nvmrc` も同値）。マイナー差分の Node 22.x でも通常は動作しますが、厳密に合わせる場合は `nvm use`。
- **ffmpeg / ffprobe**: PATH 上に必須（動画アップロード後のメタデータ・復元・書き出し・結合）。CI（`.github/workflows/ci.yml`）では ffmpeg を入れず、Vitest はモックで API を検証します。**ブラウザでの E2E や実ファイル処理には ffmpeg が必要**です。

### サービス構成

| サービス | 必須 | 起動 |
|----------|------|------|
| Next.js (`npm run dev`) | はい | `127.0.0.1:3000` |
| ffmpeg/ffprobe | はい（実動画処理時） | 別プロセス不要（CLI） |

Docker・DB・Redis・別ワーカーはありません。データは `storage/uploads/` と `storage/jobs/` に保存されます。

### 開発サーバー

- `npm run dev` は **Turbopack** と **`-H 127.0.0.1`** 固定です。Cloud VM からは `http://127.0.0.1:3000` でアクセスしてください。
- 長時間実行する場合は tmux セッション（例: `movie-editor-dev`）での起動を推奨。

### 環境変数（任意）

`MAX_UPLOAD_BYTES` / `MAX_UPLOAD_COUNT` / `MAX_JOB_COUNT` — 未設定時はコード内デフォルト。`PORT` は `next start` 時のみ影響（dev スクリプトは 3000 固定）。

### 検証の目安

- **CI 相当**: `npm run lint` → `npm test` → `npm run build`
- **コア機能のスモーク**: `POST /api/videos`（`file` フィールド）で MP4 をアップロード → `GET /api/videos/<videoId>/metadata` で `durationSec` 等が返ること

### 注意

- `storage/` は実行時に作成されます。gitignore 対象のため、クリーン clone 後は空から始まります。
- pre-commit / husky は未設定（サンプルフックのみ）。
