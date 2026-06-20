"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import { resolveActiveClipsAtPlayhead, resolveAudioClipAtPlayhead } from "@/lib/editor/compositor";
import type { ActiveClipLayer } from "@/lib/editor/compositor";
import { useCallback, useEffect, useRef, useState } from "react";

function mediaPoolKey(layer: ActiveClipLayer): string {
  return `${layer.clip.id}:${layer.asset.id}`;
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
        void media.play().catch(() => {});
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

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const w = container.clientWidth;
    const h = Math.round((w * 9) / 16);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const proj = projectRef.current;

    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, w, h);

    const layers = resolveActiveClipsAtPlayhead(proj, proj.playheadSec);
    const activeKeys = new Set<string>();
    const playing = isPlayingRef.current;

    for (const layer of layers) {
      const media = ensureMedia(layer);
      const key = mediaPoolKey(layer);
      activeKeys.add(key);
      const { x, y, scale } = layer.clip.transform;
      const drawW = w * 0.5 * scale;
      const drawH = h * 0.5 * scale;
      const cx = x * w;
      const cy = y * h;

      if (media instanceof HTMLVideoElement) {
        syncVideoTime(media, layer.sourceTimeSec, playing);
      }

      ctx.save();
      const canDraw =
        media instanceof HTMLVideoElement
          ? media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && media.videoWidth > 0
          : media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0;

      if (canDraw) {
        ctx.drawImage(media, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
      }
      ctx.restore();

      if (proj.selectedClipIds.includes(layer.clip.id)) {
        ctx.strokeStyle = "#e53e3e";
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);
      }
    }

    for (const [key, media] of mediaPoolRef.current) {
      if (activeKeys.has(key) || !(media instanceof HTMLVideoElement)) continue;
      if (!media.paused) media.pause();
    }
  }, [ensureMedia, syncVideoTime]);

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

  function onCanvasClick(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    const layers = resolveActiveClipsAtPlayhead(project, project.playheadSec);
    for (let i = 0; i < layers.length; i++) {
      const { clip } = layers[layers.length - 1 - i]!;
      const { x, y, scale } = clip.transform;
      const half = 0.25 * scale;
      if (nx >= x - half && nx <= x + half && ny >= y - half && ny <= y + half) {
        selectClip(clip.id, e.ctrlKey || e.metaKey);
        return;
      }
    }
    if (!e.ctrlKey && !e.metaKey) editor.clearSelection();
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
      scale: Math.max(0.2, Math.min(3, clip.transform.scale + delta)),
    });
  }

  return (
    <section className="compositor-preview panel">
      <div ref={containerRef} className="compositor-canvas-wrap">
        <canvas ref={canvasRef} className="compositor-canvas" onClick={onCanvasClick} onWheel={onWheel} />
        <video ref={audioVideoRef} className="compositor-audio-hidden" playsInline />
      </div>
      <div className="preview-controls">
        <button type="button" onClick={() => setPlayheadSec(0)} title="先頭">
          ⏮
        </button>
        <button type="button" onClick={() => setPlayheadSec(Math.max(0, project.playheadSec - 1 / 30))}>
          ◀
        </button>
        <button type="button" onClick={() => setIsPlaying((p) => !p)}>
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          onClick={() =>
            setPlayheadSec(Math.min(project.compositionDurationSec, project.playheadSec + 1 / 30))
          }
        >
          ▶
        </button>
        <button type="button" onClick={() => setPlayheadSec(project.compositionDurationSec)}>
          ⏭
        </button>
      </div>
    </section>
  );
}
