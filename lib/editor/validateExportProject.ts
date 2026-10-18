import { normalizeAudioFade, validateAudioFade } from "./clipAudioFade";
import { validateTitleDescriptor } from "./title";
import { validAudioGain } from "./clipAudio";
import {
  DEFAULT_COMPOSITION_HEIGHT,
  DEFAULT_COMPOSITION_WIDTH,
  MAX_COMPOSITION_DIMENSION,
  MIN_COMPOSITION_DIMENSION,
  MAX_CLIP_SCALE,
  MIN_CLIP_SCALE,
} from "@/lib/editor/compositor";
import type { Asset, Clip, ClipPart, ClipTransform, EditorProject, Track } from "@/lib/editor/types";
import { MIN_CLIP_DURATION_SEC } from "@/lib/editor/types";
import {
  assertStorageId,
  assertStrictFiniteNumber,
  parseAllowedAssetExtension,
  parseExportBaseName,
} from "@/lib/validation";

export const MAX_COMPOSITION_EXPORT_CLIPS = 100;
export const MAX_COMPOSITION_EXPORT_ASSETS = 50;
export const MAX_COMPOSITION_EXPORT_TRACKS = 20;
export const MAX_CLIP_PARTS = 50;
export const MAX_COMPOSITION_DURATION_SEC = 24 * 60 * 60;

function parseCompositionDimension(
  label: string,
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const n = assertStrictFiniteNumber(label, value, {
    min: MIN_COMPOSITION_DIMENSION,
    max: MAX_COMPOSITION_DIMENSION,
  });
  if (n % 2 !== 0) {
    throw new Error(`${label} は偶数である必要があります。`);
  }
  return n;
}

function assertRecord(label: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} はオブジェクトである必要があります。`);
  }
  return value as Record<string, unknown>;
}

export function parseAsset(raw: unknown, index: number): Asset {
  const o = assertRecord(`assets[${index}]`, raw);
  const id = assertStorageId(`assets[${index}].id`, String(o.id ?? ""));
  const kind = o.kind;
  if (kind !== "video" && kind !== "image") {
    throw new Error(`assets[${index}].kind が不正です。`);
  }
  const ext = String(o.ext ?? "").toLowerCase();
  const parsedExt = parseAllowedAssetExtension(`file.${ext}`);
  if (!parsedExt || parsedExt.kind !== kind) {
    throw new Error(`assets[${index}].ext が kind と一致しません。`);
  }
  const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
  if (!displayName) {
    throw new Error(`assets[${index}].displayName が必要です。`);
  }

  let sourceJobId: string | undefined;
  if (o.sourceJobId !== undefined && o.sourceJobId !== null && o.sourceJobId !== "") {
    sourceJobId = assertStorageId(`assets[${index}].sourceJobId`, String(o.sourceJobId));
  }

  const asset: Asset = {
    id,
    kind,
    ext: parsedExt.ext,
    displayName,
    streamUrl: `/api/assets/${id}/stream`,
    sourceJobId,
    ...(o.storageAssetId === undefined ? {} : { storageAssetId: assertStorageId("storageAssetId", String(o.storageAssetId)) }),
  };

  if (o.sourceDurationSec !== undefined) {
    asset.sourceDurationSec = assertStrictFiniteNumber(
      `assets[${index}].sourceDurationSec`,
      o.sourceDurationSec,
      { min: 0 },
    );
  }
  if (o.width !== undefined) {
    asset.width = assertStrictFiniteNumber(`assets[${index}].width`, o.width, { min: 1 });
  }
  if (o.height !== undefined) {
    asset.height = assertStrictFiniteNumber(`assets[${index}].height`, o.height, { min: 1 });
  }

  return asset;
}

export function parseTrack(raw: unknown, index: number): Track {
  const o = assertRecord(`tracks[${index}]`, raw);
  return {
    id: assertStorageId(`tracks[${index}].id`, String(o.id ?? "")),
    order: assertStrictFiniteNumber(`tracks[${index}].order`, o.order, {
      min: 0,
      max: MAX_COMPOSITION_EXPORT_TRACKS,
    }),
  };
}

function parseTransform(raw: unknown, label: string): ClipTransform {
  const o = assertRecord(label, raw);
  return {
    // Preview dragging permits centres outside the canvas; export clips the
    // resulting rectangle rather than rejecting those UI positions.
    x: assertStrictFiniteNumber(`${label}.x`, o.x),
    y: assertStrictFiniteNumber(`${label}.y`, o.y),
    scale: assertStrictFiniteNumber(`${label}.scale`, o.scale, {
      min: MIN_CLIP_SCALE,
      max: MAX_CLIP_SCALE,
    }),
  };
}

function parseClipPart(
  raw: unknown,
  index: number,
  assetIds: ReadonlySet<string>,
): ClipPart {
  const o = assertRecord(`parts[${index}]`, raw);
  const assetId = assertStorageId(`parts[${index}].assetId`, String(o.assetId ?? ""));
  if (!assetIds.has(assetId)) {
    throw new Error(`parts[${index}].assetId が assets に存在しません。`);
  }
  const sourceInSec = assertStrictFiniteNumber(`parts[${index}].sourceInSec`, o.sourceInSec, {
    min: 0,
  });
  const sourceOutSec = assertStrictFiniteNumber(`parts[${index}].sourceOutSec`, o.sourceOutSec, {
    min: 0,
  });
  if (sourceInSec >= sourceOutSec) {
    throw new Error(`parts[${index}] の sourceInSec は sourceOutSec より小さい必要があります。`);
  }
  return { assetId, sourceInSec, sourceOutSec };
}

export function parseClip(
  raw: unknown,
  index: number,
  trackIds: ReadonlySet<string>,
  assetIds: ReadonlySet<string>,
  compositionDurationSec: number,
): Clip {
  const o = assertRecord(`clips[${index}]`, raw);
  if (o.layoutMode !== undefined && o.layoutMode !== "stretch" && o.layoutMode !== "contain") {
    throw new Error("配置モードが不正です。");
  }
  if (o.audioGain !== undefined && !validAudioGain(o.audioGain)) throw new Error("音量は0〜1で指定してください。");
  const trackId = assertStorageId(`clips[${index}].trackId`, String(o.trackId ?? ""));
  if (!trackIds.has(trackId)) {
    throw new Error(`clips[${index}].trackId が tracks に存在しません。`);
  }

  const timelineStartSec = assertStrictFiniteNumber(
    `clips[${index}].timelineStartSec`,
    o.timelineStartSec,
    { min: 0, max: compositionDurationSec },
  );
  const durationSec = assertStrictFiniteNumber(`clips[${index}].durationSec`, o.durationSec, {
    min: MIN_CLIP_DURATION_SEC,
    max: compositionDurationSec,
  });
  if (timelineStartSec + durationSec > compositionDurationSec + 1e-6) {
    throw new Error(`clips[${index}] が compositionDurationSec を超えています。`);
  }

  if (o.kind === "title") {
    const allowed = new Set(["kind", "id", "trackId", "timelineStartSec", "durationSec", "transform", "text", "fontId", "fontRevision", "styleRevision"]);
    if (Object.keys(o).some(k => !allowed.has(k))) throw new Error("タイトルに素材・cache・未知fieldは指定できません。");
    return { kind: "title", id: assertStorageId(`clips[${index}].id`, String(o.id ?? "")), trackId, timelineStartSec, durationSec,
      transform: parseTransform(o.transform, `clips[${index}].transform`), ...validateTitleDescriptor(o) };
  }
  if (o.kind !== undefined && o.kind !== "media") throw new Error("未対応のclip kindです。");
  if (["text", "fontId", "fontRevision", "styleRevision"].some(k => Object.hasOwn(o, k))) throw new Error("素材にタイトルfieldは指定できません。");
  if (!Array.isArray(o.parts) || o.parts.length === 0) {
    throw new Error(`clips[${index}].parts は1件以上必要です。`);
  }
  if (o.parts.length > MAX_CLIP_PARTS) {
    throw new Error(`clips[${index}].parts が多すぎます。`);
  }

  const audioFade = Object.hasOwn(o, "audioFade") ? normalizeAudioFade(validateAudioFade(o.audioFade)) : undefined;
  const parts = o.parts.map((part, pi) => parseClipPart(part, pi, assetIds));
  const partsDuration = parts.reduce((sum, p) => sum + p.sourceOutSec - p.sourceInSec, 0);
  if (Math.abs(partsDuration - durationSec) > 1e-6) {
    throw new Error(`clips[${index}] の parts と durationSec が一致しません。`);
  }


  return {
    id: assertStorageId(`clips[${index}].id`, String(o.id ?? "")),
    trackId,
    timelineStartSec,
    durationSec,
    parts,
    transform: parseTransform(o.transform, `clips[${index}].transform`),
    ...(o.layoutMode === undefined ? {} : { layoutMode: o.layoutMode as Clip["layoutMode"] }),
    ...(o.audioGain === undefined ? {} : { audioGain: o.audioGain as number }),
    ...(audioFade ? { audioFade } : {}),
  };
}

export type ParsedCompositionExport = {
  project: EditorProject;
  exportBaseName: string | undefined;
};

/** Validate client JSON before ffmpeg export (filter graph injection / DoS mitigation). */
export function parseCompositionExportPayload(raw: unknown): ParsedCompositionExport {
  const body = assertRecord("body", raw);

  const compositionDurationSec = assertStrictFiniteNumber(
    "compositionDurationSec",
    body.compositionDurationSec,
    { min: MIN_CLIP_DURATION_SEC, max: MAX_COMPOSITION_DURATION_SEC },
  );

  const compositionWidth = parseCompositionDimension(
    "compositionWidth",
    body.compositionWidth,
    DEFAULT_COMPOSITION_WIDTH,
  );
  const compositionHeight = parseCompositionDimension(
    "compositionHeight",
    body.compositionHeight,
    DEFAULT_COMPOSITION_HEIGHT,
  );

  if (!Array.isArray(body.assets)) {
    throw new Error("assets は配列である必要があります。");
  }

  if (body.assets.length > MAX_COMPOSITION_EXPORT_ASSETS) {
    throw new Error("assets が多すぎます。");
  }

  if (!Array.isArray(body.tracks)) {
    throw new Error("tracks は配列である必要があります。");
  }
  if (body.tracks.length === 0) {
    throw new Error("tracks が空です。");
  }
  if (body.tracks.length > MAX_COMPOSITION_EXPORT_TRACKS) {
    throw new Error("tracks が多すぎます。");
  }

  if (!Array.isArray(body.clips)) {
    throw new Error("clips は配列である必要があります。");
  }
  if (body.clips.length === 0) {
    throw new Error("クリップがありません。");
  }
  if (body.clips.length > MAX_COMPOSITION_EXPORT_CLIPS) {
    throw new Error("clips が多すぎます。");
  }

  const assets = body.assets.map((asset, i) => parseAsset(asset, i));
  const tracks = body.tracks.map((track, i) => parseTrack(track, i));
  const assetIds = new Set(assets.map((a) => a.id));
  const trackIds = new Set(tracks.map((t) => t.id));
  const clips = body.clips.map((clip, i) =>
    parseClip(clip, i, trackIds, assetIds, compositionDurationSec),
  );

  if (!assets.length && clips.some(c => c.kind !== "title")) throw new Error("assets が空です。");
  const exportBaseName = parseExportBaseName(body.exportBaseName);

  return {
    project: {
      assets,
      tracks,
      clips,
      compositionDurationSec,
      compositionWidth,
      compositionHeight,
      playheadSec: 0,
      selectedClipIds: [],
      exportBaseName: exportBaseName ?? "project",
    },
    exportBaseName,
  };
}
