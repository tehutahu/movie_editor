# movie_editor（ローカルMVP）

`restore_speed.sh` と同等の ffmpeg フィルタで「倍速っぽい動画」を元の速度・音程へ戻し、区間の書き出しや「削除区間を飛ばして結合」までをブラウザから操作できるローカル用の最小Webアプリです。

## 前提

- Node.js（推奨: Next.jsの要求に合う版）
- `ffmpeg` / `ffprobe` が PATH 上で実行できること

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

## データ保存場所

- アップロード: `storage/uploads/<videoId>/input.<ext>`
- ジョブ成果物: `storage/jobs/<jobId>/...`

## 注意

- 長い動画でも処理できるよう Route Handler で `maxDuration` を広めに取っていますが、処理自体はローカルのCPU/ffmpegに依存します。
- アップロード上限は環境（Next/Vercel等）側のボディサイズ制限の影響を受ける場合があります。このMVPはローカル `next dev` 利用を前提にしています。

## 既存スクリプト

- [`restore_speed.sh`](restore_speed.sh)
