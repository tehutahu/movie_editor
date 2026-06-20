import type { Asset, Clip, ClipTransform, EditorProject, Track } from "@/lib/editor/types";
import { findAsset, tracksSortedForPreview } from "@/lib/editor/project";
import { getClipAtPlayhead, partAndSourceAtClipOffset } from "@/lib/editor/clipOps";

export const MIN_CLIP_SCALE = 0.2;
export const MAX_CLIP_SCALE = 3;
export const BASE_DRAW_WIDTH_RATIO = 0.5;
export const BASE_DRAW_HEIGHT_RATIO = 0.5;
export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
export const COMPOSITION_BG_RGB = { r: 10, g: 12, b: 16 } as const;
export const COMPOSITION_BG_CSS = "#0a0c10";
export const COMPOSITION_BG_FFMPEG = "0x0a0c10";
/** scale=2 fills the full composition frame (base draw box is half the canvas). */
export const FIT_TO_CANVAS_SCALE = 2;

export type TransformHandle = "nw" | "ne" | "sw" | "se";

export type PixelRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

function evenPx(n: number): number {
  return Math.round(n / 2) * 2;
}

function evenPxMin(n: number, min = 2): number {
  return Math.max(min, evenPx(n));
}

export function transformToPixelRect(
  transform: ClipTransform,
  compW: number,
  compH: number,
): PixelRect {
  const drawW = compW * BASE_DRAW_WIDTH_RATIO * transform.scale;
  const drawH = compH * BASE_DRAW_HEIGHT_RATIO * transform.scale;
  const cx = transform.x * compW;
  const cy = transform.y * compH;
  return {
    x: evenPx(cx - drawW / 2),
    y: evenPx(cy - drawH / 2),
    w: evenPxMin(drawW),
    h: evenPxMin(drawH),
  };
}

export function fitClipTransformToCanvas(): ClipTransform {
  return { x: 0.5, y: 0.5, scale: clampClipScale(FIT_TO_CANVAS_SCALE) };
}

export type ExportCompositionLayer = {
  clip: Clip;
  asset: Asset;
  trackOrder: number;
};

export function clipsForExportComposition(project: EditorProject): ExportCompositionLayer[] {
  const trackOrderMap = new Map(project.tracks.map((t) => [t.id, t.order]));
  const layers: ExportCompositionLayer[] = [];

  for (const clip of project.clips) {
    const assetId = clip.parts[0]?.assetId;
    if (!assetId) continue;
    const asset = findAsset(project.assets, assetId);
    if (!asset) continue;
    layers.push({
      clip,
      asset,
      trackOrder: trackOrderMap.get(clip.trackId) ?? 0,
    });
  }

  return layers.sort((a, b) => {
    if (a.trackOrder !== b.trackOrder) return b.trackOrder - a.trackOrder;
    return b.clip.timelineStartSec - a.clip.timelineStartSec;
  });
}

export function resolveAudioTrackForExport(project: EditorProject): Track | undefined {
  const tracks = tracksSortedForPreview(project.tracks);
  for (const track of tracks) {
    const hasVideo = project.clips.some((clip) => {
      if (clip.trackId !== track.id) return false;
      const asset = findAsset(project.assets, clip.parts[0]?.assetId ?? "");
      return asset?.kind === "video";
    });
    if (hasVideo) return track;
  }
  return undefined;
}

export function clipTransformHalfExtents(scale: number): { halfW: number; halfH: number } {
  return {
    halfW: BASE_DRAW_WIDTH_RATIO * scale * 0.5,
    halfH: BASE_DRAW_HEIGHT_RATIO * scale * 0.5,
  };
}

export function clipContainsNormPoint(transform: ClipTransform, nx: number, ny: number): boolean {
  const { halfW, halfH } = clipTransformHalfExtents(transform.scale);
  return (
    nx >= transform.x - halfW &&
    nx <= transform.x + halfW &&
    ny >= transform.y - halfH &&
    ny <= transform.y + halfH
  );
}

export function hitTestTransformHandle(
  transform: ClipTransform,
  nx: number,
  ny: number,
  canvasW: number,
  canvasH: number,
  handleRadiusPx = 8,
): TransformHandle | null {
  const { halfW, halfH } = clipTransformHalfExtents(transform.scale);
  const corners: { h: TransformHandle; x: number; y: number }[] = [
    { h: "nw", x: transform.x - halfW, y: transform.y - halfH },
    { h: "ne", x: transform.x + halfW, y: transform.y - halfH },
    { h: "sw", x: transform.x - halfW, y: transform.y + halfH },
    { h: "se", x: transform.x + halfW, y: transform.y + halfH },
  ];
  const rx = handleRadiusPx / canvasW;
  const ry = handleRadiusPx / canvasH;
  for (const c of corners) {
    if (Math.abs(nx - c.x) <= rx && Math.abs(ny - c.y) <= ry) return c.h;
  }
  return null;
}

export function clampClipScale(scale: number): number {
  return Math.max(MIN_CLIP_SCALE, Math.min(MAX_CLIP_SCALE, scale));
}

export function transformFromMove(
  orig: ClipTransform,
  dxNorm: number,
  dyNorm: number,
): ClipTransform {
  return { ...orig, x: orig.x + dxNorm, y: orig.y + dyNorm };
}

export function transformFromResize(
  orig: ClipTransform,
  handle: TransformHandle,
  pointerPx: { x: number; y: number },
  canvasW: number,
  canvasH: number,
): ClipTransform {
  const bw = canvasW * BASE_DRAW_WIDTH_RATIO;
  const bh = canvasH * BASE_DRAW_HEIGHT_RATIO;
  const { x, y, scale } = orig;
  const drawW = bw * scale;
  const drawH = bh * scale;
  const cx = x * canvasW;
  const cy = y * canvasH;
  const left = cx - drawW / 2;
  const right = cx + drawW / 2;
  const top = cy - drawH / 2;
  const bottom = cy + drawH / 2;
  const px = pointerPx.x;
  const py = pointerPx.y;

  let scaleW: number;
  let scaleH: number;
  let newCx: number;
  let newCy: number;

  switch (handle) {
    case "se": {
      scaleW = (px - left) / bw;
      scaleH = (py - top) / bh;
      const newScale = clampClipScale(Math.max(scaleW, scaleH));
      const newDrawW = bw * newScale;
      const newDrawH = bh * newScale;
      newCx = left + newDrawW / 2;
      newCy = top + newDrawH / 2;
      return { x: newCx / canvasW, y: newCy / canvasH, scale: newScale };
    }
    case "nw": {
      scaleW = (right - px) / bw;
      scaleH = (bottom - py) / bh;
      const newScale = clampClipScale(Math.max(scaleW, scaleH));
      const newDrawW = bw * newScale;
      const newDrawH = bh * newScale;
      newCx = right - newDrawW / 2;
      newCy = bottom - newDrawH / 2;
      return { x: newCx / canvasW, y: newCy / canvasH, scale: newScale };
    }
    case "ne": {
      scaleW = (px - left) / bw;
      scaleH = (bottom - py) / bh;
      const newScale = clampClipScale(Math.max(scaleW, scaleH));
      const newDrawW = bw * newScale;
      const newDrawH = bh * newScale;
      newCx = left + newDrawW / 2;
      newCy = bottom - newDrawH / 2;
      return { x: newCx / canvasW, y: newCy / canvasH, scale: newScale };
    }
    case "sw": {
      scaleW = (right - px) / bw;
      scaleH = (py - top) / bh;
      const newScale = clampClipScale(Math.max(scaleW, scaleH));
      const newDrawW = bw * newScale;
      const newDrawH = bh * newScale;
      newCx = right - newDrawW / 2;
      newCy = top + newDrawH / 2;
      return { x: newCx / canvasW, y: newCy / canvasH, scale: newScale };
    }
  }
}

export type ActiveClipLayer = {
  clip: Clip;
  asset: Asset;
  sourceTimeSec: number;
  trackOrder: number;
};

export function resolveActiveClipsAtPlayhead(
  project: EditorProject,
  playheadSec: number,
): ActiveClipLayer[] {
  const trackOrderMap = new Map(project.tracks.map((t) => [t.id, t.order]));
  const layers: ActiveClipLayer[] = [];

  for (const clip of project.clips) {
    if (!getClipAtPlayhead(clip, playheadSec)) continue;
    const rel = playheadSec - clip.timelineStartSec;
    const resolved = partAndSourceAtClipOffset(clip, rel);
    if (!resolved) continue;
    const asset = findAsset(project.assets, resolved.part.assetId);
    if (!asset) continue;
    layers.push({
      clip,
      asset,
      sourceTimeSec: resolved.sourceSec,
      trackOrder: trackOrderMap.get(clip.trackId) ?? 0,
    });
  }

  return layers.sort((a, b) => {
    // order 大＝背景（先に描画）、order 小＝前面
    if (a.trackOrder !== b.trackOrder) return b.trackOrder - a.trackOrder;
    // 同一トラックで重なる場合は先に置いたクリップを手前に
    return b.clip.timelineStartSec - a.clip.timelineStartSec;
  });
}

export function resolveAudioClipAtPlayhead(
  project: EditorProject,
  playheadSec: number,
): { clip: Clip; asset: Asset; sourceTimeSec: number } | null {
  const tracks = tracksSortedForPreview(project.tracks);
  for (const track of tracks) {
    const clip = project.clips.find(
      (c) => c.trackId === track.id && getClipAtPlayhead(c, playheadSec),
    );
    if (!clip) continue;
    const rel = playheadSec - clip.timelineStartSec;
    const resolved = partAndSourceAtClipOffset(clip, rel);
    if (!resolved) continue;
    const asset = findAsset(project.assets, resolved.part.assetId);
    if (!asset || asset.kind !== "video") continue;
    return { clip, asset, sourceTimeSec: resolved.sourceSec };
  }
  return null;
}

export function hitTestClipAtPoint(
  project: EditorProject,
  playheadSec: number,
  normX: number,
  normY: number,
): Clip | null {
  const layers = resolveActiveClipsAtPlayhead(project, playheadSec);
  for (let i = layers.length - 1; i >= 0; i--) {
    const { clip } = layers[i]!;
    if (clipContainsNormPoint(clip.transform, normX, normY)) {
      return clip;
    }
  }
  return null;
}

export function trackAtIndex(tracks: readonly Track[], index: number): Track | undefined {
  const sorted = tracksSortedForPreview(tracks);
  return sorted[index];
}
