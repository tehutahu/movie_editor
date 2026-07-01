"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import { AssetLibraryPanel } from "@/components/editor/AssetLibraryPanel";
import { CompositorPreview } from "@/components/editor/CompositorPreview";
import { MultiTrackTimeline } from "@/components/editor/MultiTrackTimeline";
import { timelineTracksAreaHeightPx } from "@/lib/editor/timelineLayout";
import { useCallback, useEffect, useRef, useState } from "react";

const SPLIT_STORAGE_KEY = "editor-workspace-height-px";
const SPLIT_HANDLE_HEIGHT_PX = 12;
const MIN_WORKSPACE_PX = 220;
const MIN_TIMELINE_TOOLBAR_PX = 52;
const TIMELINE_PANEL_PADDING_PX = 32;

function timelinePaneHeightPx(trackCount: number): number {
  return MIN_TIMELINE_TOOLBAR_PX + TIMELINE_PANEL_PADDING_PX + timelineTracksAreaHeightPx(trackCount);
}

function readStoredWorkspaceHeight(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const COMPOSITION_PRESETS = [
  { id: "16:9", label: "1920×1080 (16:9)", width: 1920, height: 1080 },
  { id: "9:16", label: "1080×1920 (9:16)", width: 1080, height: 1920 },
  { id: "1:1", label: "1080×1080 (1:1)", width: 1080, height: 1080 },
] as const;

function compositionPresetId(width: number, height: number): string {
  const match = COMPOSITION_PRESETS.find((p) => p.width === width && p.height === height);
  return match?.id ?? "custom";
}

export function EditorShell({ editor }: { editor: EditorStore }) {
  const {
    project,
    setExportBaseName,
    setCompositionSize,
    matchCompositionToSelectedClip,
    busy,
    error,
    liveJob,
    jobPhase,
  } = editor;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [workspaceHeightPx, setWorkspaceHeightPx] = useState<number | null>(null);
  const workspaceHeightRef = useRef<number | null>(null);
  workspaceHeightRef.current = workspaceHeightPx;

  const timelineHeightPx = timelinePaneHeightPx(project.tracks.length);

  const clampWorkspaceHeight = useCallback(
    (raw: number, shellHeight: number) => {
      const maxTop = shellHeight - SPLIT_HANDLE_HEIGHT_PX - timelineHeightPx;
      return Math.min(maxTop, Math.max(MIN_WORKSPACE_PX, raw));
    },
    [timelineHeightPx],
  );

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const syncHeights = () => {
      const shellH = shell.getBoundingClientRect().height;
      const stored = readStoredWorkspaceHeight();
      const fallback = clampWorkspaceHeight(shellH * 0.55, shellH);
      setWorkspaceHeightPx((prev) => {
        const base = prev ?? stored ?? fallback;
        return clampWorkspaceHeight(base, shellH);
      });
    };

    syncHeights();
    const ro = new ResizeObserver(syncHeights);
    ro.observe(shell);
    return () => ro.disconnect();
  }, [clampWorkspaceHeight, timelineHeightPx]);

  const onSplitPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const shell = shellRef.current;
      if (!shell) return;

      const shellRect = shell.getBoundingClientRect();
      const startY = e.clientY;
      const startHeight = workspaceHeightRef.current ?? shellRect.height * 0.55;

      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        const next = clampWorkspaceHeight(startHeight + dy, shellRect.height);
        setWorkspaceHeightPx(next);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (workspaceHeightRef.current !== null) {
          window.localStorage.setItem(SPLIT_STORAGE_KEY, String(workspaceHeightRef.current));
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clampWorkspaceHeight],
  );

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

      <div className="editor-shell-v2" ref={shellRef}>
        <div
          className="editor-workspace-pane"
          style={{
            height: workspaceHeightPx ?? undefined,
            minHeight: MIN_WORKSPACE_PX,
            flexShrink: 0,
          }}
        >
          <div className="editor-top-row">
            <AssetLibraryPanel editor={editor} />
            <div className="editor-center-col">
              <div className="editor-project-bar">
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
                <div className="editor-composition-size">
                  <label htmlFor="composition-preset">合成解像度</label>
                  <span className="composition-size-value">
                    {project.compositionWidth} × {project.compositionHeight}
                  </span>
                  <select
                    id="composition-preset"
                    value={compositionPresetId(project.compositionWidth, project.compositionHeight)}
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      const preset = COMPOSITION_PRESETS.find((p) => p.id === e.target.value);
                      if (preset) setCompositionSize(preset.width, preset.height);
                    }}
                  >
                    {COMPOSITION_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    {compositionPresetId(project.compositionWidth, project.compositionHeight) ===
                    "custom" ? (
                      <option value="custom">
                        {project.compositionWidth}×{project.compositionHeight} (カスタム)
                      </option>
                    ) : null}
                  </select>
                  <button
                    type="button"
                    disabled={Boolean(busy) || project.selectedClipIds.length === 0}
                    onClick={() => matchCompositionToSelectedClip()}
                    title="選択中クリップの素材解像度に合わせる"
                  >
                    素材に合わせる
                  </button>
                </div>
              </div>
              <CompositorPreview editor={editor} />
            </div>
          </div>
        </div>

        <div
          className="workspace-split-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="プレビューとタイムラインの高さを調整"
          onPointerDown={onSplitPointerDown}
        />

        <div className="editor-timeline-pane" style={{ height: timelineHeightPx, flexShrink: 0 }}>
          <MultiTrackTimeline editor={editor} />
        </div>
      </div>
    </>
  );
}
