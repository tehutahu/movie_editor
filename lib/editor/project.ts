import type { Asset, Clip, EditorProject, Track } from "@/lib/editor/types";
import { newId } from "@/lib/newId";

export function createDefaultTracks(): Track[] {
  return [
    { id: newId(), order: 1 },
    { id: newId(), order: 0 },
  ];
}

export function createEmptyProject(): EditorProject {
  return {
    assets: [],
    tracks: createDefaultTracks(),
    clips: [],
    compositionDurationSec: 30,
    compositionWidth: 1920,
    compositionHeight: 1080,
    playheadSec: 0,
    selectedClipIds: [],
    exportBaseName: "project",
  };
}

export function computeCompositionDuration(
  clips: readonly Clip[],
  minSec = 10,
): number {
  if (clips.length === 0) return minSec;
  const end = Math.max(...clips.map((c) => c.timelineStartSec + c.durationSec));
  return Math.max(minSec, end);
}

export function clipFromAsset(params: {
  asset: Asset;
  trackId: string;
  timelineStartSec: number;
  durationSec?: number;
  tracks?: readonly Track[];
}): Clip {
  const { asset, trackId, timelineStartSec } = params;
  const durationSec =
    params.durationSec ??
    (asset.kind === "image" ? 5 : (asset.sourceDurationSec ?? 5));

  const track = params.tracks ? findTrack(params.tracks, trackId) : undefined;
  const maxOrder = params.tracks?.reduce((m, t) => Math.max(m, t.order), 0) ?? 0;
  const transform = track
    ? defaultTransformForTrack(track.order, maxOrder)
    : { x: 0.5, y: 0.5, scale: 1 };

  return {
    id: newId(),
    trackId,
    timelineStartSec,
    durationSec,
    parts: [
      {
        assetId: asset.id,
        sourceInSec: 0,
        sourceOutSec:
          asset.kind === "image"
            ? durationSec
            : Math.min(durationSec, asset.sourceDurationSec ?? durationSec),
      },
    ],
    transform,
  };
}

export function findAsset(assets: readonly Asset[], assetId: string): Asset | undefined {
  return assets.find((a) => a.id === assetId);
}

export function findTrack(tracks: readonly Track[], trackId: string): Track | undefined {
  return tracks.find((t) => t.id === trackId);
}

export function tracksSortedByOrder(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((a, b) => a.order - b.order);
}

export function tracksSortedForPreview(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((a, b) => a.order - b.order);
}

/** タイムライン表示用（上＝前面トラック＝order 小） */
export function tracksSortedForTimeline(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((a, b) => a.order - b.order);
}

export function addTrackToProject(project: EditorProject): EditorProject {
  const maxOrder = project.tracks.reduce((m, t) => Math.max(m, t.order), -1);
  return {
    ...structuredClone(project),
    tracks: [...project.tracks, { id: newId(), order: maxOrder + 1 }],
  };
}

/** トラック order が小さいほど前面。clip 配置時の初期 scale。 */
export function defaultTransformForTrack(trackOrder: number, maxOrder: number): Clip["transform"] {
  const depth = maxOrder - trackOrder;
  const scale = Math.max(0.55, 1 - depth * 0.12);
  return { x: 0.5, y: 0.5, scale };
}
