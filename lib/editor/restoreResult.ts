import type { Asset, EditorProject } from "./types";

export type RestoreResult = {
  restoredDurationSec: number;
  restoredWidth: number;
  restoredHeight: number;
};

/** Validate before changing history, and again at the pure command boundary. */
export function assertRestoreResult(result: RestoreResult): void {
  if (!(result.restoredDurationSec > 0) || !Number.isFinite(result.restoredDurationSec)) {
    throw new Error("復元後の動画の長さが不正です。");
  }
  for (const dimension of [result.restoredWidth, result.restoredHeight]) {
    // Match the existing saved-media dimension bounds. Odd source sizes are valid.
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 65536) {
      throw new Error("復元後の動画の解像度が不正です。");
    }
  }
}

export function parseRestoreResultMetadata(raw: unknown, jobId: string): RestoreResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("復元後のメタデータが不正です。");
  }
  const meta = raw as Record<string, unknown>;
  if (meta.jobId !== jobId || meta.hasVideo !== true ||
      typeof meta.durationSec !== "number" || typeof meta.width !== "number" || typeof meta.height !== "number") {
    throw new Error("復元後のメタデータが不正です。");
  }
  const result = { restoredDurationSec: meta.durationSec, restoredWidth: meta.width, restoredHeight: meta.height };
  assertRestoreResult(result);
  return result;
}

export type RestoreSource = {
  assetId: string;
  storageAssetId: string;
  sourceJobId?: string;
  streamUrl: string;
};
export function restoreSource(asset: Asset): RestoreSource {
  return { assetId: asset.id, storageAssetId: asset.storageAssetId ?? asset.id,
    sourceJobId: asset.sourceJobId, streamUrl: asset.streamUrl };
}
export function matchesRestoreSource(project: EditorProject, source: RestoreSource): boolean {
  const asset = project.assets.find((a) => a.id === source.assetId);
  return asset?.kind === "video" &&
    (asset.storageAssetId ?? asset.id) === source.storageAssetId &&
    asset.sourceJobId === source.sourceJobId && asset.streamUrl === source.streamUrl;
}
