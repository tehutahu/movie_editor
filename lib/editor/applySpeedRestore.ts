import { computeCompositionDuration } from "@/lib/editor/project";
import type { EditorProject } from "@/lib/editor/types";

/** 速度復元ジョブ完了後、素材ストリーム・クリップ長・ソース区間を更新します。 */
export function applySpeedRestoreToProject(
  project: EditorProject,
  params: {
    assetId: string;
    jobId: string;
    speedFactor: number;
    restoredDurationSec: number;
  },
): EditorProject {
  const { assetId, jobId, speedFactor, restoredDurationSec } = params;
  if (!(speedFactor > 0) || !Number.isFinite(speedFactor)) {
    throw new Error("速度係数が不正です。");
  }

  const next = structuredClone(project);
  const asset = next.assets.find((a) => a.id === assetId);
  if (!asset || asset.kind !== "video") {
    throw new Error("速度復元対象の動画素材が見つかりません。");
  }

  asset.streamUrl = `/api/jobs/${jobId}/stream`;
  asset.sourceJobId = jobId;
  asset.sourceDurationSec = restoredDurationSec;

  for (const clip of next.clips) {
    let usesAsset = false;
    for (const part of clip.parts) {
      if (part.assetId !== assetId) continue;
      usesAsset = true;
      part.sourceInSec *= speedFactor;
      part.sourceOutSec *= speedFactor;
    }
    if (usesAsset) {
      clip.durationSec *= speedFactor;
    }
  }

  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}
