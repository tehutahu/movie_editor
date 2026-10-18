import { isMediaClip, MIN_CLIP_DURATION_SEC, type Clip, type EditorProject, type MediaClip } from "./types";

const END_EPS_SEC = 1e-9;
const MAX_ROUNDING_SEC = 1e-9;

// Adjacent arithmetic values, not a source-time snapping interval.
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
function budget(trace: number[]): number {
  if (!trace.every(Number.isFinite)) return NaN;
  const sum = trace.reduce((total, value) => total + Math.max(Math.abs(adjacent(value, true) - value), Math.abs(value - adjacent(value, false))), 0);
  return Number.isFinite(2 * sum) ? Math.min(2 * sum, MAX_ROUNDING_SEC) : NaN;
}
function partSum(parts: MediaClip["parts"], trace: number[]): number {
  // Preserve the document validator's addition/subtraction order.
  return parts.reduce((sum, part) => {
    const added = sum + part.sourceOutSec, next = added - part.sourceInSec;
    trace.push(sum, added, next, part.sourceInSec, part.sourceOutSec);
    return next;
  }, 0);
}

/** Finite numeric helper. User commands reject out-of-range requests first. */
export function trimClipEnd(project: EditorProject, clipId: string, requestedEndSec: number): EditorProject | null {
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip || !Number.isFinite(requestedEndSec)) return null;
  const start = clip.timelineStartSec, oldDuration = clip.durationSec, oldEnd = start + oldDuration;
  const end = Math.min(oldEnd, Math.max(start + MIN_CLIP_DURATION_SEC, requestedEndSec));
  const retained = end - start;
  if (![start, oldDuration, oldEnd, end, retained].every(Number.isFinite) || oldEnd - end <= END_EPS_SEC) return null;
  const timelineTrace = [start, oldDuration, oldEnd, end, retained, oldEnd - end];
  function durationFor(sum?: number): number | undefined {
    const bases = [retained, oldDuration - (oldEnd - end), MIN_CLIP_DURATION_SEC, ...(sum === undefined ? [] : [sum])];
    const candidates = [...new Set(bases.flatMap(value => [value, adjacent(value, false), adjacent(value, true)]))];
    const trace = [...timelineTrace, ...candidates.flatMap(duration => [duration, start + duration])];
    const allowed = budget(trace);
    return candidates.filter(duration => Number.isFinite(duration) && duration >= MIN_CLIP_DURATION_SEC && duration < oldDuration &&
      Math.abs(start + duration - end) <= allowed && (sum === undefined || Math.abs(sum - duration) <= 1e-6))
      .sort((a, b) => Math.abs(start + a - end) - Math.abs(start + b - end))[0];
  }
  if (!isMediaClip(clip)) {
    const durationSec = durationFor();
    return durationSec === undefined ? null : { ...project, clips: project.clips.map(c => c === clip ? { ...clip, durationSec } : c) };
  }
  if (!clip.parts.length) return null;
  const sourceTrace = [retained], oldSum = partSum(clip.parts, sourceTrace);
  const sourceTarget = Math.min(retained, oldSum);
  sourceTrace.push(oldSum, sourceTarget);
  if (!sourceTrace.every(Number.isFinite) || oldSum <= 0) return null;
  const prefix: MediaClip["parts"] = [];
  let remaining = sourceTarget;
  let cut: MediaClip["parts"][number] | undefined;
  for (const part of clip.parts) {
    if (remaining <= 0) break;
    const length = part.sourceOutSec - part.sourceInSec;
    sourceTrace.push(length, remaining);
    if (!(length > 0) || !Number.isFinite(length)) return null;
    if (remaining >= length) {
      prefix.push(part); remaining -= length; sourceTrace.push(remaining);
    } else { cut = part; break; }
  }
  // Positive declared hold/drift is retained as time, never invented source.
  if (sourceTarget === oldSum) { prefix.splice(0, prefix.length, ...clip.parts); cut = undefined; }
  const options: { parts: MediaClip["parts"]; duration: number; sourceError: number }[] = [];
  function consider(parts: MediaClip["parts"]) {
    const trace = [...sourceTrace], sum = partSum(parts, trace), error = Math.abs(sum - sourceTarget);
    trace.push(sum, error);
    const duration = durationFor(sum);
    if (duration !== undefined && Number.isFinite(error) && error <= budget(trace)) options.push({ parts, duration, sourceError: error });
  }
  if (!cut) consider(prefix);
  else {
    const normal = cut.sourceInSec + remaining;
    const normalParts = [...prefix, { ...cut, sourceOutSec: normal }];
    const normalSum = partSum(normalParts, sourceTrace), corrected = normal + (sourceTarget - normalSum);
    sourceTrace.push(normal, normalSum, corrected);
    const candidates = [...new Set([normal, corrected].flatMap(value => [value, adjacent(value, false), adjacent(value, true)]))];
    for (const sourceOutSec of candidates) {
      const trace = [...sourceTrace, sourceOutSec];
      if (!Number.isFinite(sourceOutSec) || sourceOutSec <= cut.sourceInSec || sourceOutSec > cut.sourceOutSec || Math.abs(sourceOutSec - normal) > budget(trace)) continue;
      consider([...prefix, { ...cut, sourceOutSec }]);
    }
  }
  options.sort((a, b) => Math.abs(start + a.duration - end) - Math.abs(start + b.duration - end) || a.sourceError - b.sourceError);
  const chosen = options[0];
  if (!chosen) return null;
  const next = { ...clip, durationSec: chosen.duration, parts: chosen.parts };
  return { ...project, clips: project.clips.map(c => c === clip ? next : c) };
}

export function trimEndReason(project: EditorProject, checkPrecision = true): string | null {
  if (project.selectedClipIds.length !== 1) return "クリップを1つ選択してください。";
  const clip = project.clips.find(c => c.id === project.selectedClipIds[0]);
  if (!clip) return "クリップを1つ選択してください。";
  if (!Number.isFinite(project.playheadSec) || project.playheadSec < clip.timelineStartSec + MIN_CLIP_DURATION_SEC)
    return "再生位置の前に0.05秒以上残してください。";
  if (clip.timelineStartSec + clip.durationSec - project.playheadSec <= END_EPS_SEC)
    return "再生位置をクリップの末尾より前へ移動してください。";
  if (checkPrecision && !trimClipEnd(project, clip.id, project.playheadSec))
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
export type TrimEndSnapshot = { epoch: number; clipId: string; identity: string };
export function trimEndSnapshot(project: EditorProject, epoch: number): TrimEndSnapshot | null {
  if (project.selectedClipIds.length !== 1) return null;
  const clip = project.clips.find(c => c.id === project.selectedClipIds[0]);
  return clip ? { epoch, clipId: clip.id, identity: targetIdentity(project, clip) } : null;
}
export function matchesTrimEndSnapshot(project: EditorProject, epoch: number, snapshot: TrimEndSnapshot): boolean {
  if (snapshot.epoch !== epoch || project.selectedClipIds.length !== 1 || project.selectedClipIds[0] !== snapshot.clipId) return false;
  const clip = project.clips.find(c => c.id === snapshot.clipId);
  return Boolean(clip && targetIdentity(project, clip) === snapshot.identity);
}
