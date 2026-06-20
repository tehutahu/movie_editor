import type { Asset, Clip, EditorProject, Track } from "@/lib/editor/types";
import { findAsset, tracksSortedForPreview } from "@/lib/editor/project";
import { getClipAtPlayhead, sourceTimeAtPlayhead } from "@/lib/editor/clipOps";

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
    const sourceTime = sourceTimeAtPlayhead(clip, playheadSec);
    if (sourceTime === null) continue;
    const asset = findAsset(project.assets, clip.parts[0]?.assetId ?? "");
    if (!asset) continue;
    layers.push({
      clip,
      asset,
      sourceTimeSec: sourceTime,
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
    const asset = findAsset(project.assets, clip.parts[0]?.assetId ?? "");
    if (!asset || asset.kind !== "video") continue;
    const sourceTime = sourceTimeAtPlayhead(clip, playheadSec);
    if (sourceTime === null) continue;
    return { clip, asset, sourceTimeSec: sourceTime };
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
    const { x, y, scale } = clip.transform;
    const half = 0.25 * scale;
    if (
      normX >= x - half &&
      normX <= x + half &&
      normY >= y - half &&
      normY <= y + half
    ) {
      return clip;
    }
  }
  return null;
}

export function trackAtIndex(tracks: readonly Track[], index: number): Track | undefined {
  const sorted = tracksSortedForPreview(tracks);
  return sorted[index];
}
