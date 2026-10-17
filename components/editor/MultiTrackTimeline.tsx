"use client";

import { trimStartReason, trimStartSnapshot } from "@/lib/editor/trimClipStart";
import type { EditorProject } from "@/lib/editor/types";
import type { EditorStore } from "@/hooks/useEditorStore";
import { resolvePlayheadSnappedStart } from "@/lib/editor/playheadSnap";
import { timelineRulerMarks } from "@/lib/editor/timelineRuler";
import { formatTimecode, pixelsPerSec, pxToSec, secToPx, filmstripOffsetPercent } from "@/lib/editor/thumbnailMapping";
import { tracksSortedForTimeline } from "@/lib/editor/project";
import { timelineTracksAreaHeightPx } from "@/lib/editor/timelineLayout";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 4;

function TrackDeletionControl({ order, reason, buttonRef, onDelete }: {
  order: number; reason?: string;
  buttonRef: (element: HTMLButtonElement | null) => void; onDelete: () => void;
}) {
  // Track IDs are runtime UUIDs; useId keeps the accessibility linkage stable
  // across server rendering and client hydration without changing the model.
  const reasonId = useId();
  return <span className="timeline-track-label">
    <span>T{order + 1}</span>
    <button type="button" className="track-delete-button" ref={buttonRef}
      aria-label={`空トラック T${order + 1} を削除`} aria-disabled={Boolean(reason)}
      aria-describedby={reasonId}
      title={reason ?? "空トラックを削除し、残るトラック番号を詰め直します"}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onDelete(); }}
      onKeyDown={e => { if (e.key === " " || e.key === "Enter") e.stopPropagation(); }}>
      削除
    </button>
    <span className="track-delete-reason" id={reasonId}>
      {reason ?? "空トラックを削除し、残るトラック番号を詰め直します"}
    </span>
  </span>;
}


export function TimelineToolbar({ editor }: { editor: EditorStore }) {
  const {
    project,
    splitAtPlayhead,
    mergeSelected,
    deleteSelected,
    undoEdit,
    redoEdit,
    canUndoEdit,
    canRedoEdit,
    timelineZoom,
    setTimelineZoom,
    downloadSelectedClip,
    restoreSpeedForSelected,
    exportComposition,
    addTrack,
    busy,
    clipExportBusyId,
    speedFactor,
    setSpeedFactor,
    sampleRateHz,
    setSampleRateHz,
  } = editor;

  const trimReasonId = useId();
  const trimSnapshot = trimStartSnapshot(project, editor.projectEpoch);
  const trimReason = busy || editor.persistence.locked ? "処理が終わってから操作してください。" : trimStartReason(project);

  return (
    <div className="timeline-toolbar">
      <div className="timeline-toolbar-left">
        <button type="button" data-add-track onClick={addTrack} disabled={Boolean(busy)} title="トラック追加 (Ctrl+T)">
          +
        </button>
        <button type="button" onClick={splitAtPlayhead} disabled={Boolean(busy)} title="分割 (Ctrl+X)">
          ✂
        </button>
        <span className="trim-start-action">
          <button type="button" data-trim-start aria-disabled={Boolean(trimReason)} aria-describedby={trimReasonId}
            title={trimReason ?? "先頭を再生位置まで短縮します。末尾と素材参照は維持します。"}
            onPointerDown={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === " " || e.key === "Enter") e.stopPropagation(); }}
            onClick={() => editor.trimSelectedStartAtPlayhead(trimSnapshot)}>
            先頭を再生位置まで短縮
          </button>
          <span className="trim-start-reason" id={trimReasonId}>{trimReason ?? "末尾を維持し、先頭だけ短縮します。"}</span>
        </span>
        <button type="button" onClick={undoEdit} disabled={!canUndoEdit} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button type="button" onClick={redoEdit} disabled={!canRedoEdit} title="Redo (Shift+Ctrl+Z)">
          ↷
        </button>
        <button type="button" onClick={mergeSelected} disabled={Boolean(busy)} title="結合 (Ctrl+M)">
          ⧉
        </button>
        <button type="button" onClick={deleteSelected} disabled={Boolean(busy)} title="削除 (Delete)">
          🗑
        </button>
        <button
          type="button"
          onClick={() => editor.duplicateSelected()}
          disabled={Boolean(busy) || project.selectedClipIds.length === 0}
          title="複製 (Ctrl+D)"
        >
          ⎘
        </button>
        <button
          type="button"
          onClick={() => void downloadSelectedClip()}
          disabled={Boolean(busy) || Boolean(clipExportBusyId)}
          title="選択クリップの素材切り出し。位置・拡大率は適用しません。単一動画は原寸、画像・結合クリップは先頭素材の画面内で配置モードを適用します (Shift+Ctrl+E)"
        >
          ⬇
        </button>
        <button
          type="button"
          onClick={() => editor.fitSelectedClipsToCanvas()}
          disabled={Boolean(busy) || project.selectedClipIds.length === 0}
          title="画面にフィット（プレビュー上でダブルクリックでも可）"
        >
          ⛶
        </button>
        <label title="素材の全体を枠内に収めます。余白は透明です。全体書き出しに配置枠を反映します。">
          配置
          <select aria-label="クリップの配置" disabled={Boolean(busy) || editor.layoutChecking || project.selectedClipIds.length === 0}
            value={(() => { const modes = new Set(project.clips.filter(c => project.selectedClipIds.includes(c.id)).map(c => c.layoutMode ?? "stretch")); return modes.size === 1 ? [...modes][0] : "mixed"; })()}
            onChange={e => { if (e.target.value !== "mixed") void editor.setSelectedLayoutMode(e.target.value as "stretch" | "contain"); }}>
            <option value="mixed" disabled>混在 / 未選択</option>
            <option value="stretch">引き伸ばし（従来）</option>
            <option value="contain">縦横比を保持（全体を表示）</option>
          </select>
          {editor.layoutChecking && <span role="status">素材を確認中…</span>}
        </label>
      </div>
      <div className="timeline-toolbar-center muted">
        {formatTimecode(project.playheadSec)} / {formatTimecode(project.compositionDurationSec)}
      </div>
      <div className="timeline-toolbar-right">
        <div className="timeline-speed-restore-group">
          <button type="button" onClick={() => void restoreSpeedForSelected()} disabled={Boolean(busy)}>
            速度復元
          </button>
          <label className="speed-restore-field" title="速度係数">
            <span>速度</span>
            <input
              id="speed-factor"
              type="number"
              min={0.1}
              step={0.1}
              value={speedFactor}
              disabled={Boolean(busy)}
              onChange={(e) => setSpeedFactor(e.target.value)}
            />
          </label>
          <label className="speed-restore-field" title="サンプルレート (Hz)">
            <span>Hz</span>
            <input
              id="sample-rate"
              type="number"
              step={1000}
              value={sampleRateHz}
              disabled={Boolean(busy)}
              onChange={(e) => setSampleRateHz(e.target.value)}
            />
          </label>
        </div>
        <button type="button" className="primary" onClick={() => void exportComposition()} disabled={Boolean(busy)} title="全体書き出し (Ctrl+E)">
          書き出し
        </button>
        <button type="button" onClick={() => setTimelineZoom(Math.max(0.25, timelineZoom - 0.25))}>
          −
        </button>
        <input
          type="range"
          min={0.25}
          max={4}
          step={0.25}
          value={timelineZoom}
          onChange={(e) => setTimelineZoom(Number(e.target.value))}
        />
        <button type="button" onClick={() => setTimelineZoom(Math.min(4, timelineZoom + 0.25))}>
          +
        </button>
      </div>
    </div>
  );
}

type DragState =
  | {
      kind: "move";
      clipId: string;
      startX: number;
      startY: number;
      origStart: number;
      origTrackId: string;
      additive: boolean;
      moved: boolean;
      pointerId: number;
    }
  | {
      kind: "resize";
      clipId: string;
      startX: number;
      origDuration: number;
      moved: boolean;
      pointerId: number;
    };

type DragPreview = {
  clipId: string;
  startSec: number;
  trackId: string;
  durationSec?: number;
};

export function MultiTrackTimeline({ editor }: { editor: EditorStore }) {
  const {
    project,
    timelineZoom,
    setPlayheadSec,
    selectClip,
    addClipFromAsset,
    moveSelectedClip,
    resizeClipDuration,
  } = editor;

  const pps = pixelsPerSec(timelineZoom);
  const tracks = tracksSortedForTimeline(project.tracks);
  const timelineBodyHeightPx = timelineTracksAreaHeightPx(tracks.length);
  const rulerWidth = secToPx(project.compositionDurationSec + 2, pps);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const timelineRef = useRef<HTMLElement | null>(null);
  const deleteButtonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingDeletionRef = useRef<{ before: EditorProject; expected: EditorProject; neighborId?: string; message: string } | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<{ project: EditorProject; message: string } | null>(null);
  function trackDeletionReason(trackId: string): string | undefined {
    if (editor.busy || editor.persistence.locked) return "処理中です";
    if (project.clips.some(c => c.trackId === trackId)) return "クリップがあるトラックは削除できません";
    if (project.tracks.length <= 1) return "最後のトラックは削除できません";
  }
  function requestTrackDeletion(trackId: string) {
    if (trackDeletionReason(trackId) || pendingDeletionRef.current) return;
    const index = tracks.findIndex(t => t.id === trackId);
    if (index < 0) return;
    const expected = editor.deleteEmptyTrack(trackId);
    if (!expected) return;
    pendingDeletionRef.current = { before: project, expected,
      neighborId: tracks[index + 1]?.id ?? tracks[index - 1]?.id,
      message: `空トラックT${tracks[index]!.order + 1}を削除しました` };
  }
  useLayoutEffect(() => {
    const pending = pendingDeletionRef.current;
    if (!pending) return;
    if (project === pending.expected) {
      pendingDeletionRef.current = null;
      setDeletionNotice({ project, message: pending.message });
      const neighbor = pending.neighborId ? deleteButtonsRef.current.get(pending.neighborId) : undefined;
      (neighbor ?? timelineRef.current?.querySelector<HTMLButtonElement>("[data-add-track]"))?.focus();
    } else if (project !== pending.before || editor.busy || editor.persistence.locked) {
      pendingDeletionRef.current = null;
    }
  }, [project, editor.busy, editor.persistence.locked]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [rawDragPreview, setRawDragPreview] = useState<DragPreview | null>(null);
  const [altPressed, setAltPressed] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const committedPreviewRef = useRef<DragPreview | null>(null);

  // Retain the unsnapped pointer position. Playback, zoom and stationary Alt
  // changes rederive the visible position without another pointer move.
  const movingClip = drag?.kind === "move" ? project.clips.find((c) => c.id === drag.clipId) : undefined;
  const dragPreview = rawDragPreview && movingClip ? {
    ...rawDragPreview,
    startSec: resolvePlayheadSnappedStart({
      clips: project.clips, clipId: movingClip.id, trackId: rawDragPreview.trackId,
      rawStartSec: rawDragPreview.startSec, durationSec: movingClip.durationSec,
      playheadSec: project.playheadSec, pixelsPerSecond: pps, disabled: altPressed,
    }),
  } : rawDragPreview;

  useLayoutEffect(() => {
    committedPreviewRef.current = dragPreview;
  }, [dragPreview]);

  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => setAltPressed(event.altKey);
    const cancel = () => { committedPreviewRef.current = null; setDrag(null); setRawDragPreview(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", cancel);
    };
  }, [drag]);

  const seekFromClientX = useCallback(
    (clientX: number, areaEl: HTMLElement) => {
      const labelWidth = 48;
      const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const rect = areaEl.getBoundingClientRect();
      const x = clientX - rect.left - labelWidth + scrollLeft;
      setPlayheadSec(Math.max(0, pxToSec(Math.max(0, x), pps)));
    },
    [pps, setPlayheadSec],
  );

  const onScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".timeline-clip")) return;
      e.preventDefault();
      setScrubbing(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX, e.currentTarget);
    },
    [seekFromClientX],
  );

  const onScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!scrubbing) return;
      seekFromClientX(e.clientX, e.currentTarget);
    },
    [scrubbing, seekFromClientX],
  );

  const onScrubPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!scrubbing) return;
      setScrubbing(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [scrubbing],
  );

  const trackIdFromClientY = useCallback(
    (clientY: number): string | undefined => {
      for (const track of tracks) {
        const el = trackRowRefs.current.get(track.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) return track.id;
      }
      return undefined;
    },
    [tracks],
  );

  function onTrackDrop(e: React.DragEvent, trackId: string) {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-asset-id");
    if (!assetId) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const labelWidth = 48;
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left - labelWidth + scrollLeft;
    addClipFromAsset(asset, trackId, Math.max(0, pxToSec(x, pps)));
  }

  function onPointerDownClip(
    e: React.PointerEvent,
    clipId: string,
    mode: "move" | "resize",
  ) {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    committedPreviewRef.current = null;

    const additive = e.ctrlKey || e.metaKey;
    if (mode === "move") {
      selectClip(clipId, additive);
      scrollRef.current?.setPointerCapture(e.pointerId);
      setAltPressed(e.altKey);
      setDrag({
        kind: "move",
        clipId,
        startX: e.clientX,
        startY: e.clientY,
        origStart: clip.timelineStartSec,
        origTrackId: clip.trackId,
        additive,
        moved: false,
        pointerId: e.pointerId,
      });
    } else {
      if (!project.selectedClipIds.includes(clipId)) {
        selectClip(clipId, false);
      }
      scrollRef.current?.setPointerCapture(e.pointerId);
      setDrag({
        kind: "resize",
        clipId,
        startX: e.clientX,
        origDuration: clip.durationSec,
        moved: false,
        pointerId: e.pointerId,
      });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;

    if (drag.kind === "move") {
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const dSec = pxToSec(dx, pps);
      const trackId = trackIdFromClientY(e.clientY) ?? drag.origTrackId;
      const rawStart = Math.max(0, drag.origStart + dSec);
      setAltPressed(e.altKey);
      setDrag({ ...drag, moved: true });
      setRawDragPreview({
        clipId: drag.clipId,
        startSec: rawStart,
        trackId,
      });
    } else {
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      const dSec = pxToSec(dx, pps);
      setDrag({ ...drag, moved: true });
      setRawDragPreview({
        clipId: drag.clipId,
        startSec: project.clips.find((c) => c.id === drag.clipId)?.timelineStartSec ?? 0,
        trackId: project.clips.find((c) => c.id === drag.clipId)?.trackId ?? "",
        durationSec: Math.max(0.05, drag.origDuration + dSec),
      });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const preview = committedPreviewRef.current;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (drag.kind === "move" && preview && drag.moved) {
      const clip = project.clips.find((c) => c.id === preview.clipId);
      // Commit the rendered preview, including during playback. A drag that
      // returns to its original position must preserve both Undo and Redo.
      if (clip && (clip.timelineStartSec !== preview.startSec || clip.trackId !== preview.trackId)) {
        moveSelectedClip(preview.clipId, preview.startSec, preview.trackId);
      }
    } else if (drag.kind === "resize" && preview?.durationSec !== undefined && drag.moved) {
      resizeClipDuration(drag.clipId, preview.durationSec);
    }

    setDrag(null);
    setRawDragPreview(null);
    committedPreviewRef.current = null;
  }

  function clipDisplayState(clipId: string, clip: { timelineStartSec: number; trackId: string; durationSec: number }) {
    if (dragPreview?.clipId === clipId) {
      return {
        startSec: dragPreview.startSec,
        trackId: dragPreview.trackId,
        durationSec: dragPreview.durationSec ?? clip.durationSec,
        dragging: true,
      };
    }
    return {
      startSec: clip.timelineStartSec,
      trackId: clip.trackId,
      durationSec: clip.durationSec,
      dragging: false,
    };
  }

  return (
    <section className="multi-track-timeline panel" ref={timelineRef}>
      <div className="track-delete-status" role="status" aria-live="polite">{deletionNotice?.project === project ? deletionNotice.message : ""}</div>
      <TimelineToolbar editor={editor} />
      <div
        className="timeline-scroll"
        ref={scrollRef}
        style={{ height: timelineBodyHeightPx }}
        onPointerDown={onScrubPointerDown}
        onPointerMove={(e) => { onPointerMove(e); onScrubPointerMove(e); }}
        onPointerUp={(e) => { onPointerUp(e); onScrubPointerUp(e); }}
        onPointerCancel={(e) => { committedPreviewRef.current = null; setDrag(null); setRawDragPreview(null); onScrubPointerUp(e); }}
        onLostPointerCapture={() => { committedPreviewRef.current = null; setDrag(null); setRawDragPreview(null); }}
      >
        <div
          className="timeline-ruler"
          style={{ width: rulerWidth + 48 }}
        >
          {timelineRulerMarks(project.compositionDurationSec, pps).map((sec) => (
            <span key={sec} className="timeline-ruler-mark" style={{ left: secToPx(sec, pps) + 48 }}>
              {sec}s
            </span>
          ))}
          <div
            className="timeline-playhead"
            style={{ left: secToPx(project.playheadSec, pps) + 48 }}
          />
        </div>
        <div
          className="timeline-playhead timeline-playhead--tracks"
          style={{ left: secToPx(project.playheadSec, pps) + 48 }}
        />
        {tracks.map((track) => (
          <div
            key={track.id}
            ref={(el) => {
              if (el) trackRowRefs.current.set(track.id, el);
              else trackRowRefs.current.delete(track.id);
            }}
            className="timeline-track-row"
            style={{ width: rulerWidth + 48 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onTrackDrop(e, track.id)}
          >
            <TrackDeletionControl order={track.order} reason={trackDeletionReason(track.id)}
              buttonRef={el => { if (el) deleteButtonsRef.current.set(track.id, el); else deleteButtonsRef.current.delete(track.id); }}
              onDelete={() => requestTrackDeletion(track.id)} />
            {project.clips
              .filter((c) => {
                const st = clipDisplayState(c.id, c);
                return st.trackId === track.id;
              })
              .map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.parts[0]?.assetId);
                const selected = project.selectedClipIds.includes(clip.id);
                const st = clipDisplayState(clip.id, clip);
                const offset = filmstripOffsetPercent({
                  clipStartSec: st.startSec,
                  clipDurationSec: st.durationSec,
                  playheadSec: project.playheadSec,
                });
                return (
                  <div
                    key={clip.id}
                    className={`timeline-clip${selected ? " timeline-clip--selected" : ""}${asset?.kind === "image" ? " timeline-clip--image" : ""}${st.dragging ? " timeline-clip--dragging" : ""}`}
                    style={{
                      left: secToPx(st.startSec, pps) + 48,
                      width: secToPx(st.durationSec, pps),
                      backgroundImage: asset?.thumbnailStripUrl
                        ? `url(${asset.thumbnailStripUrl})`
                        : undefined,
                      backgroundPosition: asset?.thumbnailStripUrl ? `${offset}% 0` : undefined,
                    }}
                    onPointerDown={(e) => onPointerDownClip(e, clip.id, "move")}
                  >
                    <span className="timeline-clip-label">{asset?.displayName ?? "clip"}</span>
                    <div
                      className="timeline-clip-resize"
                      onPointerDown={(e) => onPointerDownClip(e, clip.id, "resize")}
                    />
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </section>
  );
}
