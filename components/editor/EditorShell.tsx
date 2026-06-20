"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import { AssetLibraryPanel } from "@/components/editor/AssetLibraryPanel";
import { CompositorPreview } from "@/components/editor/CompositorPreview";
import { MultiTrackTimeline } from "@/components/editor/MultiTrackTimeline";

export function EditorShell({ editor }: { editor: EditorStore }) {
  const { project, setExportBaseName, busy, error, liveJob, jobPhase, speedFactor, setSpeedFactor, sampleRateHz, setSampleRateHz } = editor;

  return (
    <>
      <header className="editor-header">
        <h1>
          <span className="badge">NLE</span>
          マルチトラック動画エディタ
        </h1>
        <p className="muted">
          素材をタイムラインにドラッグ、分割・結合・Undo/Redo、Canvas プレビューで編集します。
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}
      {busy ? <p className="busy-banner">{busy}</p> : null}
      {liveJob ? (
        <p className="muted job-status">
          {jobPhase} — {liveJob.status}
          {typeof liveJob.progressPct === "number" ? ` (${Math.round(liveJob.progressPct)}%)` : ""}
        </p>
      ) : null}

      <div className="editor-shell-v2">
        <div className="editor-top-row">
          <AssetLibraryPanel editor={editor} />
          <div className="editor-center-col">
            <div className="editor-project-name">
              <label htmlFor="export-base-name">プロジェクト名</label>
              <input
                id="export-base-name"
                type="text"
                value={project.exportBaseName}
                disabled={Boolean(busy)}
                onChange={(e) => setExportBaseName(e.target.value)}
              />
            </div>
            <CompositorPreview editor={editor} />
          </div>
          <aside className="tool-rail panel">
            <h2>ツール</h2>
            <label htmlFor="speed-factor">速度係数</label>
            <input
              id="speed-factor"
              type="number"
              min={0.1}
              step={0.1}
              value={speedFactor}
              onChange={(e) => setSpeedFactor(e.target.value)}
            />
            <label htmlFor="sample-rate">サンプルレート (Hz)</label>
            <input
              id="sample-rate"
              type="number"
              step={1000}
              value={sampleRateHz}
              onChange={(e) => setSampleRateHz(e.target.value)}
            />
            <p className="muted tool-hint">
              Ctrl+クリックで複数選択。Ctrl+Z / Shift+Ctrl+Z で Undo/Redo。プレビュー上 Ctrl+ホイールで拡大縮小。
            </p>
          </aside>
        </div>
        <MultiTrackTimeline editor={editor} />
      </div>
    </>
  );
}
