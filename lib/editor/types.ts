export type AssetKind = "video" | "image";

export type Asset = {
  id: string;
  kind: AssetKind;
  /** Physical upload reference, distinct from the logical editor ID. */
  storageAssetId?: string;
  /** Stream URL for preview / export */
  streamUrl: string;
  /** 速度復元などで参照するジョブ成果（未設定時はアップロード原本） */
  sourceJobId?: string;
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

export type ClipLayoutMode = "stretch" | "contain";

export type ClipBase = {
  id: string;
  trackId: string;
  timelineStartSec: number;
  durationSec: number;
  transform: ClipTransform;
};

export type AudioFade = { inSec: number; outSec: number; anchorDurationSec: number; offsetSec: number };

export type MediaClip = ClipBase & {
  kind?: "media";
  parts: ClipPart[];
  layoutMode?: ClipLayoutMode;
  /** Linear audio gain; omitted means 1, zero silences without changing selection. */
  audioGain?: number;
  audioFade?: AudioFade;
};

export type TitleClip = ClipBase & {
  kind: "title";
  text: string;
  fontId: string;
  fontRevision: string;
  styleRevision: string;
  /** These media fields are forbidden in title descriptors. */
  parts?: never;
  audioGain?: never;
  audioFade?: never;
  layoutMode?: never;
};
export type Clip = MediaClip | TitleClip;
export function isMediaClip(clip: Clip): clip is MediaClip { return clip.kind !== "title"; }
export function isTitleClip(clip: Clip): clip is TitleClip { return clip.kind === "title"; }

export type EditorProject = {
  assets: Asset[];
  tracks: Track[];
  clips: Clip[];
  compositionDurationSec: number;
  compositionWidth: number;
  compositionHeight: number;
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
