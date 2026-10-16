import type { Asset, EditorProject } from "./types";
import {
  parseAsset,
  parseClip,
  parseTrack,
  MAX_COMPOSITION_DURATION_SEC,
} from "./validateExportProject";
import {
  assertStorageId,
  assertStrictFiniteNumber,
  MAX_UPLOAD_BYTES,
} from "@/lib/validation";
import {
  MAX_COMPOSITION_DIMENSION,
  MIN_COMPOSITION_DIMENSION,
} from "./compositor";

export const MAX_PROJECT_JSON_BYTES = 2 * 1024 * 1024;
export type MediaReference = {
  kind: "upload" | "job";
  id: string;
  sha256: string;
  size: number;
};
export type ProjectDocument = {
  format: "movie-editor-project";
  version: 1 | 2;
  project: Pick<
    EditorProject,
    | "tracks"
    | "clips"
    | "compositionDurationSec"
    | "compositionWidth"
    | "compositionHeight"
    | "exportBaseName"
  > & {
    assets: (Omit<
      Asset,
      "streamUrl" | "thumbnailStripUrl" | "sourceJobId" | "storageAssetId"
    > & { media: MediaReference })[];
  };
};
export function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("プロジェクト形式が不正です。");
  return raw as Record<string, unknown>;
}
function array(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max)
    throw new Error(`件数が不正です（上限 ${max}）。`);
  return raw;
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new Error("ID が重複しています。");
}
function text(raw: unknown, max = 255): string {
  if (typeof raw !== "string" || raw.length > max)
    throw new Error("名前が不正です。");
  return raw;
}
/** Strict bounded DTO. Only whitelisted fields survive; URLs and paths are never used. */
export function parseProjectDocument(raw: unknown): ProjectDocument {
  if (
    new TextEncoder().encode(JSON.stringify(raw)).length >
    MAX_PROJECT_JSON_BYTES
  )
    throw new Error("JSON サイズが上限を超えています。");
  const doc = record(raw);
  if (doc.format !== "movie-editor-project" || (doc.version !== 1 && doc.version !== 2))
    throw new Error("未対応のプロジェクト形式・version です。");
  const p = record(doc.project);
  const duration = assertStrictFiniteNumber(
    "compositionDurationSec",
    p.compositionDurationSec,
    { min: 0, max: MAX_COMPOSITION_DURATION_SEC },
  );
  function dimension(raw: unknown) {
    const n = assertStrictFiniteNumber("画面サイズ", raw, {
      min: MIN_COMPOSITION_DIMENSION,
      max: MAX_COMPOSITION_DIMENSION,
    });
    if (n % 2) throw new Error("画面サイズは偶数で指定してください。");
    return n;
  }
  const assets = array(p.assets, 50).map((raw, i) => {
    const a = record(raw),
      m = record(a.media);
    const base = parseAsset(
      {
        ...a,
        sourceJobId: undefined,
        storageAssetId: undefined,
        displayName: text(a.displayName),
      },
      i,
    );
    if (m.kind !== "upload" && m.kind !== "job")
      throw new Error("素材参照形式が不正です。");
    if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256))
      throw new Error("SHA-256 が不正です。");
    const size = assertStrictFiniteNumber("素材サイズ", m.size, {
      min: 0,
      max: MAX_UPLOAD_BYTES,
    });
    if (!Number.isSafeInteger(size)) throw new Error("素材サイズが不正です。");
    if (
      base.sourceDurationSec !== undefined &&
      base.sourceDurationSec > MAX_COMPOSITION_DURATION_SEC
    )
      throw new Error("素材時間が上限を超えています。");
    if (
      base.kind === "video" &&
      (base.sourceDurationSec === undefined || base.sourceDurationSec <= 0)
    )
      throw new Error("動画の素材長が必要です。");
    for (const n of [base.width, base.height])
      if (n !== undefined && (!Number.isInteger(n) || n > 65536))
        throw new Error("素材解像度が不正です。");
    // Explicit construction avoids serializing runtime-only fields.
    return {
      id: base.id,
      kind: base.kind,
      ext: base.ext,
      displayName: base.displayName,
      ...(base.sourceDurationSec === undefined
        ? {}
        : { sourceDurationSec: base.sourceDurationSec }),
      ...(base.width === undefined ? {} : { width: base.width }),
      ...(base.height === undefined ? {} : { height: base.height }),
      media: {
        kind: m.kind as MediaReference["kind"],
        id: assertStorageId("media.id", String(m.id)),
        sha256: m.sha256,
        size,
      },
    };
  });
  const tracks = array(p.tracks, 20).map(parseTrack);
  if (
    tracks.some((t) => !Number.isInteger(t.order)) ||
    new Set(tracks.map((t) => t.order)).size !== tracks.length
  )
    throw new Error("トラック順が不正です。");
  const clips = array(p.clips, 100).map((c, i) => {
    if (doc.version === 1 && Object.hasOwn(record(c), "layoutMode"))
      throw new Error("v1 に配置モードは指定できません。");
    return parseClip(
      c,
      i,
      new Set(tracks.map((t) => t.id)),
      new Set(assets.map((a) => a.id)),
      duration,
    );
  });
  unique(assets.map((a) => a.id));
  unique(tracks.map((t) => t.id));
  unique(clips.map((c) => c.id));
  for (const c of clips)
    for (const part of c.parts) {
      const asset = assets.find((a) => a.id === part.assetId)!;
      if (
        part.sourceOutSec > MAX_COMPOSITION_DURATION_SEC ||
        (asset.kind === "video" &&
          (asset.sourceDurationSec === undefined ||
            part.sourceOutSec > asset.sourceDurationSec + 1e-6))
      )
        throw new Error("切り出し区間が素材長を超えています。");
    }
  return {
    format: "movie-editor-project",
    version: doc.version as 1 | 2,
    project: {
      assets,
      tracks,
      clips,
      compositionDurationSec: duration,
      compositionWidth: dimension(p.compositionWidth),
      compositionHeight: dimension(p.compositionHeight),
      exportBaseName: text(p.exportBaseName),
    },
  };
}
/** Save request draft: server replaces placeholders using the actual file bytes. */
export function projectDocumentDraft(project: EditorProject): ProjectDocument {
  return {
    format: "movie-editor-project",
    version: project.clips.some(c => c.layoutMode === "contain") ? 2 : 1,
    project: {
      tracks: structuredClone(project.tracks),
      clips: project.clips.map(c => {
        const { layoutMode, ...clip } = structuredClone(c);
        return layoutMode === "contain" ? { ...clip, layoutMode } : clip;
      }),
      compositionWidth: project.compositionWidth,
      compositionHeight: project.compositionHeight,
      compositionDurationSec: project.compositionDurationSec,
      exportBaseName: project.exportBaseName,
      assets: project.assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        ext: a.ext,
        displayName: a.displayName,
        ...(a.sourceDurationSec === undefined
          ? {}
          : { sourceDurationSec: a.sourceDurationSec }),
        ...(a.width === undefined ? {} : { width: a.width }),
        ...(a.height === undefined ? {} : { height: a.height }),
        media: {
          kind: a.sourceJobId ? "job" : "upload",
          id: a.sourceJobId ?? a.storageAssetId ?? a.id,
          sha256: "0".repeat(64),
          size: 0,
        },
      })),
    },
  };
}
export function projectContentKey(project: EditorProject): string {
  // Fingerprints and runtime state do not change the editable document.
  return JSON.stringify(projectDocumentDraft(project));
}
export function documentToProject(doc: ProjectDocument): EditorProject {
  return {
    ...doc.project,
    playheadSec: 0,
    selectedClipIds: [],
    assets: doc.project.assets.map(({ media, ...a }) => ({
      ...a,
      ...(media.kind === "job"
        ? { sourceJobId: media.id, streamUrl: `/api/jobs/${media.id}/stream` }
        : {
            storageAssetId: media.id,
            streamUrl: `/api/assets/${media.id}/stream`,
            ...(a.kind === "video"
              ? { thumbnailStripUrl: `/api/assets/${media.id}/filmstrip` }
              : {}),
          }),
    })),
  };
}
