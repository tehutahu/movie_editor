import { assetHasAudioFade } from "./clipAudioFade";
import { isMediaClip } from "./types";
import { computeCompositionDuration } from "@/lib/editor/project";
import { MIN_CLIP_DURATION_SEC, type ClipPart, type EditorProject } from "@/lib/editor/types";
import { assertRestoreResult, type RestoreResult } from "./restoreResult";

// Arithmetic neighbors, never a media-time snap or a new parser tolerance.
function adjacent(value: number, up: boolean): number {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += up === (value > 0) ? BigInt(1) : -BigInt(1);
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function ulp(value: number): number {
  return Number.isFinite(value)
    ? Math.max(Math.abs(adjacent(value, true) - value), Math.abs(value - adjacent(value, false))) : 0;
}
function budget(trace: number[]): number {
  return Math.min(1e-9, 2 * trace.reduce((sum, value) => sum + ulp(value), 0));
}
function partSum(parts: ClipPart[], trace: number[]): number {
  return parts.reduce((sum, part) => {
    // Match parseClip's existing evaluation order, including cancellation.
    const added = sum + part.sourceOutSec, result = added - part.sourceInSec;
    trace.push(sum, part.sourceOutSec, part.sourceInSec, added, result);
    return result;
  }, 0);
}
function restoredClipDuration(oldDuration: number, oldSum: number, newSum: number,
  factor: number, allTarget: boolean, trace: number[]): number {
  const drift = oldDuration - oldSum;
  if (!Number.isFinite(oldSum) || Math.abs(drift) > 1e-6) {
    throw new Error("復元前のクリップ長とソース区間が一致しません。");
  }
  const delta = newSum - oldSum, primary = oldDuration + delta, alternate = newSum + drift;
  trace.push(oldDuration, oldSum, newSum, drift, delta, primary, alternate);
  const valid = (duration: number) => Number.isFinite(duration) && duration >= MIN_CLIP_DURATION_SEC &&
    Math.abs(newSum - duration) <= 1e-6;
  // Preserve the old all-target result whenever it already satisfies the contract.
  const legacy = oldDuration * factor;
  if (factor === 1 && valid(oldDuration)) return oldDuration;
  if (allTarget && valid(legacy)) return legacy;
  if (Math.max(primary, alternate) < MIN_CLIP_DURATION_SEC) {
    throw new Error("復元後のクリップ長が短すぎます。");
  }
  const candidates = [primary, alternate].flatMap(value => [value, adjacent(value, false), adjacent(value, true)]);
  const allowance = budget(trace);
  const chosen = candidates.filter(value => valid(value) && Math.abs(value - primary) <= allowance)
    .sort((a, b) => Math.abs(a - primary) - Math.abs(b - primary))[0];
  if (chosen === undefined) {
    throw new Error("復元後のクリップ長が短すぎるか、時刻を必要な精度で表現できません。");
  }
  return chosen;
}

/** 速度復元ジョブ完了後、素材ストリーム・クリップ長・ソース区間を更新します。 */
export function applySpeedRestoreToProject(
  project: EditorProject,
  params: {
    assetId: string;
    jobId: string;
    speedFactor: number;
  } & RestoreResult,
): EditorProject {
  const { assetId, jobId, speedFactor, restoredDurationSec, restoredWidth, restoredHeight } = params;
  assertRestoreResult(params);
  if (assetHasAudioFade(project, assetId)) throw new Error("該当clipのフェードを解除してから復元してください。");
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
  asset.width = restoredWidth;
  asset.height = restoredHeight;

  for (const clip of next.clips) {
    if (!isMediaClip(clip)) continue;
    if (!clip.parts.some(part => part.assetId === assetId)) continue;
    const trace: number[] = [];
    const oldSum = partSum(clip.parts, trace);
    const allTarget = clip.parts.every(part => part.assetId === assetId);
    for (const part of clip.parts) {
      if (part.assetId !== assetId) continue;
      const oldIn = part.sourceInSec, oldOut = part.sourceOutSec;
      part.sourceInSec *= speedFactor;
      part.sourceOutSec *= speedFactor;
      if (!Number.isFinite(part.sourceInSec) || !Number.isFinite(part.sourceOutSec) ||
          part.sourceInSec < 0 || part.sourceInSec >= part.sourceOutSec ||
          part.sourceOutSec > restoredDurationSec + 1e-6 ||
          Math.abs((part.sourceOutSec - part.sourceInSec) - (oldOut - oldIn) * speedFactor) >
            budget([oldIn, oldOut, oldOut - oldIn, speedFactor, part.sourceInSec, part.sourceOutSec,
              part.sourceOutSec - part.sourceInSec, (oldOut - oldIn) * speedFactor])) {
        throw new Error("復元後のソース区間が範囲外か、時刻を必要な精度で表現できません。");
      }
    }
    const newSum = partSum(clip.parts, trace);
    clip.durationSec = restoredClipDuration(clip.durationSec, oldSum, newSum, speedFactor, allTarget, trace);
  }

  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}
