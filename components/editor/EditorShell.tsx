"use client";

import { ProjectPersistencePanel } from "./ProjectPersistencePanel";
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

/** Preserve the fixed controls and the existing minimum canvas while resizing. */
function minimumWorkspaceHeightPx(shell: HTMLElement | null): number {
  if (!shell || !window.matchMedia("(min-width: 981px)").matches) return MIN_WORKSPACE_PX;
  const center = shell.querySelector<HTMLElement>(".editor-center-col");
  const bar = shell.querySelector<HTMLElement>(".editor-project-bar");
  const preview = shell.querySelector<HTMLElement>(".compositor-preview");
  const canvas = shell.querySelector<HTMLElement>(".compositor-canvas-wrap");
  const transport = shell.querySelector<HTMLElement>(".preview-transport");
  if (!center || !bar || !preview || !canvas || !transport) return MIN_WORKSPACE_PX;
  const px = (value: string) => Number.parseFloat(value) || 0;
  const columnStyle = getComputedStyle(center), previewStyle = getComputedStyle(preview), transportStyle = getComputedStyle(transport);
  return Math.max(MIN_WORKSPACE_PX, Math.ceil(bar.getBoundingClientRect().height + px(columnStyle.rowGap) +
    px(previewStyle.paddingTop) + px(previewStyle.paddingBottom) + px(previewStyle.borderTopWidth) + px(previewStyle.borderBottomWidth) +
    px(getComputedStyle(canvas).minHeight) + transport.getBoundingClientRect().height + px(transportStyle.marginTop) + px(transportStyle.marginBottom)));
}

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
    projectEpoch,
    setExportBaseName,
    setCompositionSize,
    matchCompositionToSelectedClip,
    busy,
    error,
    storageWarning,
    finishEditing,
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
      return Math.max(minimumWorkspaceHeightPx(shellRef.current), Math.min(maxTop, raw));
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
    let observedControls = new Set<Element>();
    const observeControls = () => {
      const current = new Set(shell.querySelectorAll(".editor-project-bar, .preview-transport, .compositor-canvas-wrap"));
      for (const element of observedControls) if (!current.has(element)) ro.unobserve(element);
      for (const element of current) if (!observedControls.has(element)) ro.observe(element);
      observedControls = current;
      syncHeights();
    };
    observeControls();
    // Load epochs and fullscreen replace preview/transport nodes. Observe new
    // controls too; pane style changes and playback text updates are not watched.
    const mutations = new MutationObserver(observeControls);
    mutations.observe(shell.querySelector(".editor-center-col") ?? shell, { childList: true, subtree: true });
    return () => { mutations.disconnect(); ro.disconnect(); };
  }, [clampWorkspaceHeight, timelineHeightPx, projectEpoch]);

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

      <ProjectPersistencePanel editor={editor} />
      <button type="button" className="storage-release" onClick={() => void finishEditing()} disabled={Boolean(busy) || editor.persistence.locked} title="このタブの編集・素材一覧・履歴を破棄し、不要になったサーバー素材を整理します">編集終了・素材解放</button>
      {storageWarning ? <p role="status" className="storage-notice">{storageWarning}</p> : null}
      {error ? <p className="error-banner">{error}</p> : null}
      {busy ? <p className="busy-banner">{busy}</p> : null}
      {liveJob ? (
        <p className="muted job-status">
          {jobPhase} — {liveJob.status}
          {typeof liveJob.progressPct === "number" ? ` (${Math.round(liveJob.progressPct)}%)` : ""}
        </p>
      ) : null}

      <div className="editor-shell-v2" ref={shellRef} inert={editor.persistence.locked || Boolean(busy)}>
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
                    disabled={Boolean(busy) || project.selectedClipIds.length === 0||project.clips.some(c=>project.selectedClipIds.includes(c.id)&&c.kind==="title")}
                    onClick={() => matchCompositionToSelectedClip()}
                    title="選択中クリップの素材解像度に合わせる"
                  >
                    素材に合わせる
                  </button>
                </div>
              </div>
              <CompositorPreview key={editor.projectEpoch} editor={editor} />
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
