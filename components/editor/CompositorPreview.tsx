"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import {
  BASE_DRAW_HEIGHT_RATIO,
  BASE_DRAW_WIDTH_RATIO,
  clampClipScale,
  clipContainsNormPoint,
  COMPOSITION_BG_CSS,
  fitClipTransformToCanvas,
  hitTestTransformHandle,
  resolveActiveClipsAtPlayhead,
  resolveAudioClipAtPlayhead,
  transformFromMove,
  transformFromResize,
} from "@/lib/editor/compositor";
import type { ActiveClipLayer, TransformHandle } from "@/lib/editor/compositor";
import type { ClipTransform } from "@/lib/editor/types";
import { useCallback, useEffect, useRef, useState } from "react";

const EDITOR_HELP_ITEMS = [
  { keys: "Delete", desc: "削除" },
  { keys: "Ctrl+D", desc: "複製" },
  { keys: "Ctrl+X", desc: "分割" },
  { keys: "Ctrl+M", desc: "結合" },
  { keys: "Ctrl+T", desc: "トラック追加" },
  { keys: "Ctrl+E", desc: "全体書き出し" },
  { keys: "Shift+Ctrl+E", desc: "選択書き出し" },
  { keys: "Ctrl+Z / Shift+Ctrl+Z", desc: "Undo / Redo" },
  { keys: "プレビュー上ドラッグ", desc: "素材を移動" },
  { keys: "角をドラッグ", desc: "サイズ変更" },
  { keys: "ダブルクリック / ⛶", desc: "画面にフィット" },
  { keys: "Ctrl+ホイール", desc: "拡大縮小" },
  { keys: "Space", desc: "再生 / 一時停止" },
  { keys: "← / →", desc: "1フレーム戻る / 進む" },
  { keys: "Ctrl+← / Ctrl+→", desc: "先頭 / 末尾へ移動" },
] as const;

const FRAME_STEP_SEC = 1 / 30;
const FULLSCREEN_CONTROLS_HOTZONE_PX = 80;
const FULLSCREEN_CONTROLS_HIDE_MS = 500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

type PreviewControlsBarProps = {
  isPlaying: boolean;
  onSeekStart: () => void;
  onStepBack: () => void;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onSeekEnd: () => void;
  onPointerEnter?: () => void;
};

function PreviewControlsBar({
  isPlaying,
  onSeekStart,
  onStepBack,
  onTogglePlay,
  onStepForward,
  onSeekEnd,
  onPointerEnter,
}: PreviewControlsBarProps) {
  return (
    <div className="preview-controls" onPointerEnter={onPointerEnter}>
      <button type="button" onClick={onSeekStart} title="先頭 (Ctrl+←)">
        ⏮
      </button>
      <button type="button" onClick={onStepBack} title="1フレーム戻る (←)">
        ◀
      </button>
      <button type="button" onClick={onTogglePlay} title="再生 / 一時停止 (Space)">
        {isPlaying ? "⏸" : "▶"}
      </button>
      <button type="button" onClick={onStepForward} title="1フレーム進む (→)">
        ▶
      </button>
      <button type="button" onClick={onSeekEnd} title="末尾 (Ctrl+→)">
        ⏭
      </button>
    </div>
  );
}

function mediaPoolKey(layer: ActiveClipLayer): string {
  return `${layer.clip.id}:${layer.asset.id}:${layer.asset.streamUrl}`;
}

const DRAG_THRESHOLD_PX = 3;
const HANDLE_DRAW_PX = 7;
const HANDLE_HIT_PX = 10;

type TransformDragMode = "move" | `resize-${TransformHandle}`;

type TransformDrag = {
  clipId: string;
  mode: TransformDragMode;
  startClientX: number;
  startClientY: number;
  origTransform: ClipTransform;
  moved: boolean;
};

function layerTransform(
  layer: ActiveClipLayer,
  preview: { clipId: string; transform: ClipTransform } | null,
): ClipTransform {
  if (preview?.clipId === layer.clip.id) return preview.transform;
  return layer.clip.transform;
}

function drawTransformHandles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  drawW: number,
  drawH: number,
) {
  const corners = [
    [cx - drawW / 2, cy - drawH / 2],
    [cx + drawW / 2, cy - drawH / 2],
    [cx - drawW / 2, cy + drawH / 2],
    [cx + drawW / 2, cy + drawH / 2],
  ];
  const half = HANDLE_DRAW_PX / 2;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#e53e3e";
  ctx.lineWidth = 1.5;
  for (const [hx, hy] of corners) {
    ctx.fillRect(hx - half, hy - half, HANDLE_DRAW_PX, HANDLE_DRAW_PX);
    ctx.strokeRect(hx - half, hy - half, HANDLE_DRAW_PX, HANDLE_DRAW_PX);
  }
}

function cursorForMode(mode: TransformDragMode | "default" | "hover-move" | TransformHandle): string {
  switch (mode) {
    case "move":
    case "hover-move":
      return "move";
    case "resize-nw":
    case "resize-se":
      return "nwse-resize";
    case "resize-ne":
    case "resize-sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "default";
  }
}

export function CompositorPreview({ editor }: { editor: EditorStore }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaPoolRef = useRef<Map<string, HTMLVideoElement | HTMLImageElement>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const drawRafRef = useRef<number | null>(null);
  const playRafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  const { project, setPlayheadSec, selectClip, updateClipTransform, audioVideoRef } = editor;

  const projectRef = useRef(project);
  projectRef.current = project;
  const playheadSecRef = useRef(project.playheadSec);
  playheadSecRef.current = project.playheadSec;
  const setPlayheadSecRef = useRef(setPlayheadSec);
  setPlayheadSecRef.current = setPlayheadSec;

  const [transformDrag, setTransformDrag] = useState<TransformDrag | null>(null);
  const [transformPreview, setTransformPreview] = useState<{
    clipId: string;
    transform: ClipTransform;
  } | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string>("default");
  const [helpOpen, setHelpOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(false);
  const hideControlsTimerRef = useRef<number | null>(null);

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
  }, []);

  const showFullscreenControls = useCallback(() => {
    clearHideControlsTimer();
    setFullscreenControlsVisible(true);
  }, [clearHideControlsTimer]);

  const scheduleHideFullscreenControls = useCallback(() => {
    clearHideControlsTimer();
    hideControlsTimerRef.current = window.setTimeout(() => {
      setFullscreenControlsVisible(false);
      hideControlsTimerRef.current = null;
    }, FULLSCREEN_CONTROLS_HIDE_MS);
  }, [clearHideControlsTimer]);

  const seekStart = useCallback(() => setPlayheadSec(0), [setPlayheadSec]);
  const stepBack = useCallback(
    () => setPlayheadSec(Math.max(0, playheadSecRef.current - FRAME_STEP_SEC)),
    [setPlayheadSec],
  );
  const togglePlay = useCallback(() => setIsPlaying((p) => !p), []);
  const stepForward = useCallback(() => {
    setPlayheadSec(
      Math.min(projectRef.current.compositionDurationSec, playheadSecRef.current + FRAME_STEP_SEC),
    );
  }, [setPlayheadSec]);
  const seekEnd = useCallback(
    () => setPlayheadSec(projectRef.current.compositionDurationSec),
    [setPlayheadSec],
  );

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === containerRef.current;
      setIsFullscreen(active);
      if (!active) {
        clearHideControlsTimer();
        setFullscreenControlsVisible(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [clearHideControlsTimer]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || helpOpen) return;

      const mod = e.ctrlKey || e.metaKey;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (mod) seekStart();
        else stepBack();
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (mod) seekEnd();
        else stepForward();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [helpOpen, seekStart, stepBack, stepForward, seekEnd, togglePlay]);

  useEffect(() => () => clearHideControlsTimer(), [clearHideControlsTimer]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
      return;
    }
    void el.requestFullscreen();
  }, []);

  const transformDragRef = useRef(transformDrag);
  transformDragRef.current = transformDrag;
  const transformPreviewRef = useRef(transformPreview);
  transformPreviewRef.current = transformPreview;

  const ensureMedia = useCallback(
    (layer: ActiveClipLayer): HTMLVideoElement | HTMLImageElement => {
      const key = mediaPoolKey(layer);
      const pool = mediaPoolRef.current;
      let el = pool.get(key);
      if (!el) {
        el =
          layer.asset.kind === "image"
            ? document.createElement("img")
            : document.createElement("video");
        el.crossOrigin = "anonymous";
        if (el instanceof HTMLVideoElement) {
          el.muted = true;
          el.playsInline = true;
          el.preload = "auto";
          el.addEventListener("seeked", () => {
            void drawRef.current?.();
          });
        }
        el.src = layer.asset.streamUrl;
        el.addEventListener("loadeddata", () => {
          void drawRef.current?.();
        });
        pool.set(key, el);
      }
      return el;
    },
    [],
  );

  const drawRef = useRef<(() => void) | null>(null);

  const syncVideoTime = useCallback((media: HTMLVideoElement, targetSec: number, playing: boolean) => {
    if (playing) {
      if (media.paused) {
        if (Math.abs(media.currentTime - targetSec) > 0.05) {
          media.currentTime = targetSec;
        }
        void media.play().catch(() => undefined);
        return;
      }
      if (Math.abs(media.currentTime - targetSec) > 0.35) {
        media.currentTime = targetSec;
      }
      return;
    }

    if (!media.paused) media.pause();
    if (Math.abs(media.currentTime - targetSec) > 0.02) {
      media.currentTime = targetSec;
    }
  }, []);

  const canDrawMedia = useCallback((media: HTMLVideoElement | HTMLImageElement): boolean => {
    if (media instanceof HTMLVideoElement) {
      return (
        !media.seeking &&
        media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        media.videoWidth > 0
      );
    }
    return media.complete && media.naturalWidth > 0;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const availW = container.clientWidth;
    const availH = container.clientHeight;
    if (availW < 1 || availH < 1) return;

    const proj = projectRef.current;
    const aspect =
      proj.compositionWidth > 0 && proj.compositionHeight > 0
        ? proj.compositionWidth / proj.compositionHeight
        : 16 / 9;
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));

    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const preview = transformPreviewRef.current;

    const layers = resolveActiveClipsAtPlayhead(proj, proj.playheadSec);
    const activeKeys = new Set<string>();
    const playing = isPlayingRef.current;

    for (const layer of layers) {
      const media = ensureMedia(layer);
      if (media instanceof HTMLVideoElement) {
        syncVideoTime(media, layer.sourceTimeSec, playing);
      }
    }

    const drawableLayers = layers.filter((layer) => canDrawMedia(ensureMedia(layer)));
    if (layers.length > 0 && drawableLayers.length === 0) {
      return;
    }

    ctx.fillStyle = COMPOSITION_BG_CSS;
    ctx.fillRect(0, 0, w, h);

    for (const layer of layers) {
      const media = ensureMedia(layer);
      const key = mediaPoolKey(layer);
      activeKeys.add(key);
      const transform = layerTransform(layer, preview);
      const { x, y, scale } = transform;
      const drawW = w * BASE_DRAW_WIDTH_RATIO * scale;
      const drawH = h * BASE_DRAW_HEIGHT_RATIO * scale;
      const cx = x * w;
      const cy = y * h;

      ctx.save();
      if (canDrawMedia(media)) {
        ctx.drawImage(media, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
      }
      ctx.restore();

      if (proj.selectedClipIds.includes(layer.clip.id)) {
        ctx.strokeStyle = "#e53e3e";
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);
        drawTransformHandles(ctx, cx, cy, drawW, drawH);
      }
    }

    for (const [key, media] of mediaPoolRef.current) {
      if (activeKeys.has(key) || !(media instanceof HTMLVideoElement)) continue;
      if (!media.paused) media.pause();
    }
  }, [canDrawMedia, ensureMedia, syncVideoTime]);

  drawRef.current = draw;

  useEffect(() => {
    const loop = () => {
      draw();
      drawRafRef.current = requestAnimationFrame(loop);
    };
    drawRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
    };
  }, [draw]);

  useEffect(() => {
    if (!isPlaying) {
      lastTickRef.current = null;
      if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
      playRafRef.current = null;
      return;
    }

    const loop = (ts: number) => {
      if (lastTickRef.current !== null) {
        const dt = (ts - lastTickRef.current) / 1000;
        const duration = projectRef.current.compositionDurationSec;
        const next = Math.min(duration, playheadSecRef.current + dt);
        playheadSecRef.current = next;
        setPlayheadSecRef.current(next);
        if (next >= duration - 0.01) {
          setIsPlaying(false);
          return;
        }
      }
      lastTickRef.current = ts;
      playRafRef.current = requestAnimationFrame(loop);
    };

    lastTickRef.current = null;
    playRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
      playRafRef.current = null;
    };
  }, [isPlaying]);

  useEffect(() => {
    const audio = resolveAudioClipAtPlayhead(project, project.playheadSec);
    const vid = audioVideoRef.current;
    if (!vid || !audio) return;
    const absUrl = new URL(audio.asset.streamUrl, window.location.origin).href;
    if (vid.src !== absUrl) vid.src = audio.asset.streamUrl;
    syncVideoTime(vid, audio.sourceTimeSec, isPlaying);
  }, [project, project.playheadSec, audioVideoRef, isPlaying, syncVideoTime]);

  useEffect(() => {
    for (const asset of project.assets) {
      const key = `preload:${asset.id}`;
      const pool = mediaPoolRef.current;
      if (pool.has(key)) continue;
      const el =
        asset.kind === "image"
          ? document.createElement("img")
          : document.createElement("video");
      el.crossOrigin = "anonymous";
      if (el instanceof HTMLVideoElement) {
        el.muted = true;
        el.preload = "auto";
      }
      el.src = asset.streamUrl;
      pool.set(key, el);
    }
  }, [project.assets]);

  const canvasNormFromEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      nx: (e.clientX - rect.left) / rect.width,
      ny: (e.clientY - rect.top) / rect.height,
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
  }, []);

  const resolveTransformAtPointer = useCallback(
    (nx: number, ny: number, w: number, h: number) => {
      const proj = projectRef.current;
      const layers = resolveActiveClipsAtPlayhead(proj, proj.playheadSec);
      const preview = transformPreviewRef.current;

      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i]!;
        if (!proj.selectedClipIds.includes(layer.clip.id)) continue;
        const transform = layerTransform(layer, preview);
        const handle = hitTestTransformHandle(transform, nx, ny, w, h, HANDLE_HIT_PX);
        if (handle) {
          return { clip: layer.clip, mode: `resize-${handle}` as TransformDragMode, transform };
        }
      }

      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i]!;
        const transform = layerTransform(layer, preview);
        if (clipContainsNormPoint(transform, nx, ny)) {
          return { clip: layer.clip, mode: "move" as TransformDragMode, transform };
        }
      }

      return null;
    },
    [],
  );

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    const pos = canvasNormFromEvent(e);
    if (!pos) return;

    const hit = resolveTransformAtPointer(pos.nx, pos.ny, pos.w, pos.h);
    const additive = e.ctrlKey || e.metaKey;

    if (!hit) {
      if (!additive) editor.clearSelection();
      return;
    }

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    if (hit.mode === "move") {
      selectClip(hit.clip.id, additive);
    } else if (!project.selectedClipIds.includes(hit.clip.id)) {
      selectClip(hit.clip.id, false);
    }

    setTransformDrag({
      clipId: hit.clip.id,
      mode: hit.mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origTransform: { ...hit.transform },
      moved: false,
    });
    setTransformPreview(null);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const pos = canvasNormFromEvent(e);
    if (!pos) return;

    const drag = transformDragRef.current;
    if (drag) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

      let next: ClipTransform;
      if (drag.mode === "move") {
        next = transformFromMove(drag.origTransform, dx / pos.w, dy / pos.h);
      } else {
        const handle = drag.mode.replace("resize-", "") as TransformHandle;
        next = transformFromResize(drag.origTransform, handle, { x: pos.px, y: pos.py }, pos.w, pos.h);
      }

      setTransformDrag({ ...drag, moved: true });
      setTransformPreview({ clipId: drag.clipId, transform: next });
      return;
    }

    const hit = resolveTransformAtPointer(pos.nx, pos.ny, pos.w, pos.h);
    if (!hit) {
      setHoverCursor("default");
      return;
    }
    if (hit.mode === "move") {
      setHoverCursor(cursorForMode("hover-move"));
      return;
    }
    const handle = hit.mode.replace("resize-", "") as TransformHandle;
    setHoverCursor(cursorForMode(handle));
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = transformDragRef.current;
    if (!drag) return;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (drag.moved && transformPreviewRef.current?.clipId === drag.clipId) {
      updateClipTransform(drag.clipId, transformPreviewRef.current.transform);
    }

    setTransformDrag(null);
    setTransformPreview(null);
  }

  function onPointerLeave() {
    if (!transformDragRef.current) setHoverCursor("default");
  }

  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = canvasNormFromEvent(e);
    if (!pos) return;
    const hit = resolveTransformAtPointer(pos.nx, pos.ny, pos.w, pos.h);
    if (!hit || hit.mode !== "move") return;
    selectClip(hit.clip.id, false);
    updateClipTransform(hit.clip.id, fitClipTransformToCanvas());
  }

  function onWheel(e: React.WheelEvent) {
    const selected = project.selectedClipIds[0];
    if (!selected || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const clip = project.clips.find((c) => c.id === selected);
    if (!clip) return;
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    updateClipTransform(selected, {
      ...clip.transform,
      scale: clampClipScale(clip.transform.scale + delta),
    });
  }

  const canvasCursor = transformDrag ? cursorForMode(transformDrag.mode) : hoverCursor;

  function onWrapPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isFullscreen) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientY >= rect.bottom - FULLSCREEN_CONTROLS_HOTZONE_PX) {
      showFullscreenControls();
      return;
    }
    scheduleHideFullscreenControls();
  }

  function onWrapPointerLeave() {
    if (!isFullscreen) return;
    scheduleHideFullscreenControls();
  }

  return (
    <section className="compositor-preview panel">
      <div
        ref={containerRef}
        className="compositor-canvas-wrap"
        onPointerMove={onWrapPointerMove}
        onPointerLeave={onWrapPointerLeave}
      >
        <canvas
          ref={canvasRef}
          className="compositor-canvas"
          style={{ cursor: canvasCursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
        />
        <video ref={audioVideoRef} className="compositor-audio-hidden" playsInline />
        <button
          type="button"
          className="preview-help-btn"
          onClick={() => setHelpOpen(true)}
          title="ショートカットと操作のヘルプ"
          aria-label="ヘルプ"
        >
          ?
        </button>
        <button
          type="button"
          className="preview-maximize-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? "全画面を終了" : "プレビューを最大画面"}
          aria-label={isFullscreen ? "全画面を終了" : "プレビューを最大画面"}
        >
          {isFullscreen ? "⊟" : "⛶"}
        </button>
        {isFullscreen ? (
          <div
            className={`preview-controls-overlay${fullscreenControlsVisible ? " is-visible" : ""}`}
            onPointerEnter={showFullscreenControls}
            onPointerLeave={scheduleHideFullscreenControls}
          >
            <PreviewControlsBar
              isPlaying={isPlaying}
              onSeekStart={seekStart}
              onStepBack={stepBack}
              onTogglePlay={togglePlay}
              onStepForward={stepForward}
              onSeekEnd={seekEnd}
              onPointerEnter={showFullscreenControls}
            />
          </div>
        ) : null}
      </div>
      {helpOpen ? (
        <div className="help-modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="help-modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="help-modal-title">操作ヘルプ</h2>
            <ul className="help-modal-list">
              {EDITOR_HELP_ITEMS.map((item) => (
                <li key={item.keys}>
                  <kbd>{item.keys}</kbd>
                  <span>{item.desc}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="secondary" onClick={() => setHelpOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      ) : null}
      {!isFullscreen ? (
        <PreviewControlsBar
          isPlaying={isPlaying}
          onSeekStart={seekStart}
          onStepBack={stepBack}
          onTogglePlay={togglePlay}
          onStepForward={stepForward}
          onSeekEnd={seekEnd}
        />
      ) : null}
    </section>
  );
}
