# AGENTS.md

## Project overview

Local MVP web video editor (`movie-editor`). Next.js 16 (App Router) + React 19. Upload, ffmpeg jobs, and multi-track timeline editing run in a single Next.js process on port 3000.

Features include: asset library (video + image upload), multi-track timeline (drag/drop, split, merge, delete, undo/redo), Canvas compositor preview, speed restore (equivalent to `restore_speed.sh`), segment export, and full composition export.

See [README.md](README.md) for user-facing setup and usage.

## Common commands

| Purpose | Command |
|---------|---------|
| Dependencies | `npm ci` (`package-lock.json` present) |
| Dev server | `npm run dev` → http://127.0.0.1:3000 |
| Lint | `npm run lint` |
| Test | `npm test` |
| Test (watch) | `npm run test:watch` |
| Production build | `npm run build` |
| Production start | `npm run start` |

## Cursor Cloud specific instructions

### Required external dependencies

- **Node.js**: `engines.node` in `package.json` is `22.14.0` (`.nvmrc` matches). Minor Node 22.x versions usually work; run `nvm use` for an exact match.
- **ffmpeg / ffprobe**: Required for real media processing (upload metadata, speed restore, export, merge). Resolution order: `FFMPEG_PATH` / `FFPROBE_PATH` env vars → `ffmpeg-static` / `ffprobe-static` npm packages → system PATH. CI (`.github/workflows/ci.yml`) does not install ffmpeg; Vitest mocks API routes. **Browser E2E and real file processing require ffmpeg.**

### Service layout

| Service | Required | How to run |
|---------|----------|------------|
| Next.js (`npm run dev`) | Yes | `127.0.0.1:3000` |
| ffmpeg/ffprobe | Yes (real media) | CLI, no separate daemon |

No Docker, DB, Redis, or separate worker. Data lives under `storage/uploads/` and `storage/jobs/` (local driver) or Vercel Blob when configured.

### Dev server

- `npm run dev` uses **Turbopack** and binds to **`-H 127.0.0.1`** (port 3000). Access from Cloud VM at `http://127.0.0.1:3000`.
- For long-running sessions, prefer a tmux session (e.g. `movie-editor-dev`).

### Environment variables (optional)

| Variable | Default | Notes |
|----------|---------|-------|
| `MAX_UPLOAD_BYTES` | 8 GiB | Upload size limit |
| `MAX_UPLOAD_COUNT` | 20 | Max retained uploads |
| `MAX_JOB_COUNT` | 50 | Max retained jobs |
| `STORAGE_DRIVER` | `local` | Set to `blob` for Vercel Blob |
| `BLOB_READ_WRITE_TOKEN` | — | Enables Blob storage when set |
| `FFMPEG_PATH` / `FFPROBE_PATH` | — | Override ffmpeg/ffprobe binary paths |
| `PORT` | 3000 | Affects `npm run start` only; dev script is fixed at 3000 |

### Verification

#### Automated (CI-equivalent)

```bash
npm run lint && npm test && npm run build
```

#### API smoke test

```bash
# Upload a sample MP4 (legacy single-file endpoint)
curl -s -F "file=@sample.mp4" http://127.0.0.1:3000/api/videos

# Or use the primary assets endpoint (multi-file)
curl -s -F "files=@sample.mp4" http://127.0.0.1:3000/api/assets
```

Then confirm metadata returns `durationSec` via `GET /api/assets/<assetId>/metadata` or `GET /api/videos/<videoId>/metadata`.

#### Browser verification (required for agents)

When validating UI changes or end-to-end behavior, **always use the browser skill** (`cursor-ide-browser` MCP) — do not rely on unit tests alone.

1. Start the dev server if it is not already running: `npm run dev`
2. Navigate to `http://127.0.0.1:3000` with `browser_navigate`
3. Take a `browser_snapshot` to confirm the page structure (header, asset panel, timeline, preview)
4. Interact with the editor as needed (upload, drag clips, toolbar actions)
5. Capture `browser_take_screenshot` to visually confirm the result before reporting success

Use `browser_lock` / `browser_unlock` around multi-step browser automation. Prefer snapshot and screenshot evidence over assumptions about UI state.

### Notes

- `storage/` is created at runtime and gitignored; a clean clone starts empty.
- pre-commit / husky are not configured (sample hooks only).
- Legacy `/api/videos/*` routes remain for compatibility; prefer `/api/assets` for new work.
