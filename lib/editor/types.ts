export type AssetKind = "video" | "image";

export type Asset = {
  id: string;
  kind: AssetKind;
  /** Stream URL for preview / export */
  streamUrl: string;
  displayName: string;
  sourceDurationSec?: number;
  width?: number;
  height?: number;
  thumbnailStripUrl?: string;
  ext: string;
};

export type Track = {
  id: string;
  order: number;
};

export type ClipTransform = {
  x: number;
  y: number;
  scale: number;
};

export type ClipPart = {
  assetId: string;
  sourceInSec: number;
  sourceOutSec: number;
};

export type Clip = {
  id: string;
  trackId: string;
  timelineStartSec: number;
  durationSec: number;
  parts: ClipPart[];
  transform: ClipTransform;
};

export type EditorProject = {
  assets: Asset[];
  tracks: Track[];
  clips: Clip[];
  compositionDurationSec: number;
  playheadSec: number;
  selectedClipIds: string[];
  exportBaseName: string;
};

export type AppliedJobStep = {
  clientId: string;
  kind: "restore" | "merge_kept";
  jobId: string;
  clipId: string;
  status: "running" | "done" | "error";
};

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0.5, y: 0.5, scale: 1 };

export const MIN_CLIP_DURATION_SEC = 0.05;
export const SPLIT_EDGE_EPS_SEC = 0.05;
