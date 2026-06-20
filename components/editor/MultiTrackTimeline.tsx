"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import { formatTimecode, pixelsPerSec, pxToSec, secToPx, filmstripOffsetPercent } from "@/lib/editor/thumbnailMapping";
import { tracksSortedForTimeline } from "@/lib/editor/project";
import { useCallback, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 4;

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
  } = editor;

  return (
    <div className="timeline-toolbar">
      <div className="timeline-toolbar-left">
        <button type="button" onClick={addTrack} disabled={Boolean(busy)} title="トラック追加">
          +
        </button>
        <button type="button" onClick={splitAtPlayhead} disabled={Boolean(busy)} title="分割">
          ✂
        </button>
        <button type="button" onClick={undoEdit} disabled={!canUndoEdit} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button type="button" onClick={redoEdit} disabled={!canRedoEdit} title="Redo (Shift+Ctrl+Z)">
          ↷
        </button>
        <button type="button" onClick={mergeSelected} disabled={Boolean(busy)} title="結合">
          ⧉
        </button>
        <button type="button" onClick={deleteSelected} disabled={Boolean(busy)} title="削除">
          🗑
        </button>
        <button
          type="button"
          onClick={() => void downloadSelectedClip()}
          disabled={Boolean(busy) || Boolean(clipExportBusyId)}
          title="クリップ DL"
        >
          ⬇
        </button>
      </div>
      <div className="timeline-toolbar-center muted">
        {formatTimecode(project.playheadSec)} / {formatTimecode(project.compositionDurationSec)}
      </div>
      <div className="timeline-toolbar-right">
        <button type="button" onClick={() => void restoreSpeedForSelected()} disabled={Boolean(busy)}>
          速度復元
        </button>
        <button type="button" className="primary" onClick={() => void exportComposition()} disabled={Boolean(busy)}>
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
    }
  | {
      kind: "resize";
      clipId: string;
      startX: number;
      origDuration: number;
      moved: boolean;
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
  const rulerWidth = secToPx(project.compositionDurationSec + 2, pps);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

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
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const additive = e.ctrlKey || e.metaKey;
    if (mode === "move") {
      selectClip(clipId, additive);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        kind: "move",
        clipId,
        startX: e.clientX,
        startY: e.clientY,
        origStart: clip.timelineStartSec,
        origTrackId: clip.trackId,
        additive,
        moved: false,
      });
    } else {
      if (!project.selectedClipIds.includes(clipId)) {
        selectClip(clipId, false);
      }
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        kind: "resize",
        clipId,
        startX: e.clientX,
        origDuration: clip.durationSec,
        moved: false,
      });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;

    if (drag.kind === "move") {
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const dSec = pxToSec(dx, pps);
      const trackId = trackIdFromClientY(e.clientY) ?? drag.origTrackId;
      setDrag({ ...drag, moved: true });
      setDragPreview({
        clipId: drag.clipId,
        startSec: Math.max(0, drag.origStart + dSec),
        trackId,
      });
    } else {
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      const dSec = pxToSec(dx, pps);
      setDrag({ ...drag, moved: true });
      setDragPreview({
        clipId: drag.clipId,
        startSec: project.clips.find((c) => c.id === drag.clipId)?.timelineStartSec ?? 0,
        trackId: project.clips.find((c) => c.id === drag.clipId)?.trackId ?? "",
        durationSec: Math.max(0.05, drag.origDuration + dSec),
      });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (drag.kind === "move" && dragPreview && drag.moved) {
      moveSelectedClip(dragPreview.clipId, dragPreview.startSec, dragPreview.trackId);
    } else if (drag.kind === "resize" && dragPreview?.durationSec !== undefined && drag.moved) {
      resizeClipDuration(drag.clipId, dragPreview.durationSec);
    } else if (drag.kind === "move" && !drag.moved) {
      selectClip(drag.clipId, drag.additive);
    }

    setDrag(null);
    setDragPreview(null);
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
    <section className="multi-track-timeline panel">
      <TimelineToolbar editor={editor} />
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onPointerDown={onScrubPointerDown}
        onPointerMove={onScrubPointerMove}
        onPointerUp={onScrubPointerUp}
        onPointerCancel={onScrubPointerUp}
      >
        <div
          className="timeline-ruler"
          style={{ width: rulerWidth + 48 }}
        >
          {Array.from({ length: Math.ceil(project.compositionDurationSec) + 1 }, (_, i) => (
            <span key={i} className="timeline-ruler-mark" style={{ left: secToPx(i, pps) + 48 }}>
              {i}s
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
            <span className="timeline-track-label">T{track.order + 1}</span>
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
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
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
