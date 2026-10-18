import { isMediaClip, type MediaClip } from "./types";
import { MIN_CLIP_DURATION_SEC, type Clip, type EditorProject } from "@/lib/editor/types";

const START_EPS_SEC = 1e-9;
// Operation precision, not an input restriction or a source-time snap.
const MAX_TRIM_ROUNDING_SEC = 1e-9;

// Adjacent IEEE-754 value: this is an arithmetic ULP, never a media-time epsilon.
function adjacent(value: number, up: boolean): number {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let high = view.getUint32(0), low = view.getUint32(4);
  if (up === (value > 0)) {
    if (low === 0xffffffff) { high += 1; low = 0; } else low += 1;
  } else {
    if (low === 0) { high -= 1; low = 0xffffffff; } else low -= 1;
  }
  view.setUint32(0, high); view.setUint32(4, low);
  return view.getFloat64(0);
}
function ulp(value: number): number {
  return Number.isFinite(value) ? Math.max(Math.abs(adjacent(value, true) - value), Math.abs(value - adjacent(value, false))) : 0;
}
function arithmeticBudget(trace: number[]): number {
  return 2 * trace.reduce((sum, value) => sum + ulp(value), 0);
}
function partSum(parts: MediaClip["parts"], trace: number[]): number {
  // Match the existing validator's addition/subtraction order exactly.
  return parts.reduce((sum, part) => {
    const added = sum + part.sourceOutSec, next = added - part.sourceInSec;
    trace.push(sum, added, next, part.sourceInSec, part.sourceOutSec);
    return next;
  }, 0);
}

export function trimStartUpperBound(clip: Clip): number {
  const end = clip.timelineStartSec + clip.durationSec;
  const upper = end - MIN_CLIP_DURATION_SEC;
  return end - upper < MIN_CLIP_DURATION_SEC ? adjacent(upper, false) : upper;
}

/** Numeric operation: finite requests clamp; the user command rejects invalid requests first. */
export function trimClipStart(project: EditorProject, clipId: string, requestedStartSec: number): EditorProject | null {
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip || !Number.isFinite(requestedStartSec)) return null;
  const oldDuration = clip.durationSec;
  const end = clip.timelineStartSec + oldDuration;
  const start = Math.max(clip.timelineStartSec, Math.min(requestedStartSec, trimStartUpperBound(clip)));
  if (start - clip.timelineStartSec <= START_EPS_SEC) return null;
  const nominalStart = Math.max(clip.timelineStartSec, Math.min(requestedStartSec, end - MIN_CLIP_DURATION_SEC));
  if (Math.abs(start - nominalStart) > Math.min(arithmeticBudget([clip.timelineStartSec, oldDuration, end, nominalStart, start]), MAX_TRIM_ROUNDING_SEC)) return null;
  if (!isMediaClip(clip)) return { ...project, clips: project.clips.map(c => c.id === clip.id ? { ...clip, timelineStartSec: start, durationSec: end - start } : c) };
  const prefix = start - clip.timelineStartSec;
  // Keep coordinate domains separate: huge source timestamps must never
  // authorize a visible change to the timeline's endpoint.
  const timelineTrace = [clip.timelineStartSec, oldDuration, end, start, prefix];
  const sourceTrace: number[] = [prefix];
  const oldSum = partSum(clip.parts, sourceTrace), oldDrift = oldDuration - oldSum;
  sourceTrace.push(oldDrift);
  let remaining = prefix;
  let firstOriginal: MediaClip["parts"][number] | undefined;
  let wholeConsumed = 0, localPrefix = 0;
  const parts = [];
  for (const part of clip.parts) {
    const length = part.sourceOutSec - part.sourceInSec;
    sourceTrace.push(part.sourceInSec, part.sourceOutSec, length, remaining);
    if (remaining >= length) {
      remaining -= length; wholeConsumed += length;
      sourceTrace.push(remaining, wholeConsumed); continue;
    }
    if (!firstOriginal) { firstOriginal = part; localPrefix = remaining; }
    if (remaining > 0) {
      const sourceInSec = part.sourceInSec + remaining;
      sourceTrace.push(sourceInSec);
      // A positive tail must remain representable even when sourceIn + offset rounds up.
      parts.push({ ...part, sourceInSec: sourceInSec < part.sourceOutSec ? sourceInSec : adjacent(part.sourceOutSec, false) });
      remaining = 0;
    } else parts.push(part);
  }
  if (parts.length === 0) return null;
  function sourceProgressError(candidateParts: MediaClip["parts"]): number {
    const progress = candidateParts[0].sourceInSec - firstOriginal!.sourceInSec;
    sourceTrace.push(progress, wholeConsumed + progress, localPrefix);
    // Comparing newIn with normalIn alone misses offsets swallowed by the same
    // coarse float. Check the actual represented progress, locally and globally.
    return Math.max(Math.abs(progress - localPrefix), Math.abs(wholeConsumed + progress - prefix));
  }
  function chooseDuration(candidateParts: MediaClip["parts"]): number | undefined {
    const sourceError = sourceProgressError(candidateParts);
    if (!Number.isFinite(sourceError) || sourceError > Math.min(arithmeticBudget(sourceTrace), MAX_TRIM_ROUNDING_SEC)) return undefined;
    const sum = partSum(candidateParts, sourceTrace);
    const bases = [end - start, oldDuration - prefix, sum + oldDrift];
    const candidates = bases.flatMap(value => [value, adjacent(value, false), adjacent(value, true)]);
    for (const duration of candidates) timelineTrace.push(duration, start + duration);
    const budget = Math.min(arithmeticBudget(timelineTrace), MAX_TRIM_ROUNDING_SEC);
    // Deterministic finite candidates; exact computed end wins. Only arithmetic
    // roundoff can relax that equality, while the existing validator stays strict.
    return candidates.filter(duration => Number.isFinite(duration) && duration >= MIN_CLIP_DURATION_SEC &&
      Math.abs(sum - duration) <= 1e-6 && Math.abs(start + duration - end) <= budget)
      .sort((a, b) => Math.abs(start + a - end) - Math.abs(start + b - end))[0];
  }
  let durationSec = chooseDuration(parts);
  if (durationSec === undefined && firstOriginal) {
    // A rounded large source timestamp can cross the strict drift boundary at
    // MIN duration. Recompute the same first-source position once, then consider
    // only its two adjacent values. No search or tolerance-sized source shift.
    const sum = partSum(parts, sourceTrace), target = end - start - oldDrift;
    const normalIn = parts[0].sourceInSec, corrected = normalIn + (sum - target);
    sourceTrace.push(target, sum - target, corrected);
    const candidates = [corrected, adjacent(corrected, false), adjacent(corrected, true)];
    const options: { parts: MediaClip["parts"]; duration: number; sourceError: number }[] = [];
    for (const sourceInSec of candidates) {
      sourceTrace.push(sourceInSec);
      if (sourceInSec < firstOriginal.sourceInSec || sourceInSec >= firstOriginal.sourceOutSec ||
          Math.abs(sourceInSec - normalIn) > Math.min(arithmeticBudget(sourceTrace), MAX_TRIM_ROUNDING_SEC)) continue;
      const changed = [{ ...parts[0], sourceInSec }, ...parts.slice(1)];
      const duration = chooseDuration(changed);
      if (duration !== undefined) options.push({ parts: changed, duration, sourceError: sourceProgressError(changed) });
    }
    options.sort((a, b) => Math.abs(start + a.duration - end) - Math.abs(start + b.duration - end) || a.sourceError - b.sourceError);
    const chosen = options[0];
    if (chosen) { parts.splice(0, parts.length, ...chosen.parts); durationSec = chosen.duration; }
  }
  if (durationSec === undefined) return null;
  const next = { ...clip, timelineStartSec: start, durationSec, parts };
  return { ...project, clips: project.clips.map(c => c === clip ? next : c) };
}

export function trimStartReason(project: EditorProject, checkPrecision = true): string | null {
  if (project.selectedClipIds.length !== 1) return "クリップを1つ選択してください。";
  const clip = project.clips.find(c => c.id === project.selectedClipIds[0]);
  if (!clip) return "クリップを1つ選択してください。";
  if (!Number.isFinite(project.playheadSec) || project.playheadSec <= clip.timelineStartSec + START_EPS_SEC)
    return "再生位置をクリップの先頭より後へ移動してください。";
  // Accept the nominal boundary; the helper canonicalizes its one-ULP subtraction error.
  if (project.playheadSec > clip.timelineStartSec + clip.durationSec - MIN_CLIP_DURATION_SEC)
    return "再生位置の後に0.05秒以上残してください。";
  if (checkPrecision && !trimClipStart(project, clip.id, project.playheadSec))
    return "素材の時刻精度ではこの位置まで短縮できません。別の再生位置を選んでください。";
  return null;
}

function targetIdentity(project: EditorProject, clip: Clip): string {
  return JSON.stringify({ clip, assets: (isMediaClip(clip) ? clip.parts : []).map(part => {
    const asset = project.assets.find(a => a.id === part.assetId);
    return asset ? { id: asset.id, storageAssetId: asset.storageAssetId, sourceJobId: asset.sourceJobId,
      streamUrl: asset.streamUrl, kind: asset.kind, ext: asset.ext, sourceDurationSec: asset.sourceDurationSec,
      width: asset.width, height: asset.height } : null;
  }) });
}

export type TrimStartSnapshot = { epoch: number; clipId: string; identity: string };
export function trimStartSnapshot(project: EditorProject, epoch: number): TrimStartSnapshot | null {
  if (project.selectedClipIds.length !== 1) return null;
  const clip = project.clips.find(c => c.id === project.selectedClipIds[0]);
  return clip ? { epoch, clipId: clip.id, identity: targetIdentity(project, clip) } : null;
}
export function matchesTrimStartSnapshot(project: EditorProject, epoch: number, snapshot: TrimStartSnapshot): boolean {
  if (snapshot.epoch !== epoch || project.selectedClipIds.length !== 1 || project.selectedClipIds[0] !== snapshot.clipId) return false;
  const clip = project.clips.find(c => c.id === snapshot.clipId);
  return Boolean(clip && targetIdentity(project, clip) === snapshot.identity);
}
