import type { Asset, Clip, ClipPart, EditorProject } from "@/lib/editor/types";
import { newId } from "@/lib/newId";
import {
  DEFAULT_TRANSFORM,
  MIN_CLIP_DURATION_SEC,
  SPLIT_EDGE_EPS_SEC,
} from "@/lib/editor/types";
import { computeCompositionDuration, findAsset } from "@/lib/editor/project";

function cloneProject(p: EditorProject): EditorProject {
  return structuredClone(p);
}

function partDuration(part: ClipPart): number {
  return part.sourceOutSec - part.sourceInSec;
}

export function partAndSourceAtClipOffset(
  clip: Clip,
  timelineOffsetSec: number,
): { part: ClipPart; sourceSec: number } | null {
  const mapped = mapPartAtTimelineOffset(clip, timelineOffsetSec);
  if (!mapped) return null;
  const part = clip.parts[mapped.partIndex];
  if (!part) return null;
  return { part, sourceSec: mapped.sourceSec };
}

export function clipEndSec(clip: Clip): number {
  return clip.timelineStartSec + clip.durationSec;
}

function clipsOverlap(
  startA: number,
  durA: number,
  startB: number,
  durB: number,
): boolean {
  return startA < startB + durB - 1e-9 && startA + durA > startB + 1e-9;
}

export function resolveNonOverlappingStart(
  clips: readonly Clip[],
  clipId: string,
  trackId: string,
  desiredStartSec: number,
  durationSec: number,
): number {
  let start = Math.max(0, desiredStartSec);
  const others = clips
    .filter((c) => c.trackId === trackId && c.id !== clipId)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec);

  for (let pass = 0; pass <= others.length; pass++) {
    let adjusted = false;
    for (const other of others) {
      const oStart = other.timelineStartSec;
      const oEnd = clipEndSec(other);
      if (!clipsOverlap(start, durationSec, oStart, other.durationSec)) continue;

      const snapBefore = oStart - durationSec;
      const snapAfter = oEnd;
      if (snapBefore >= 0 && Math.abs(desiredStartSec - snapBefore) <= Math.abs(desiredStartSec - snapAfter)) {
        start = snapBefore;
      } else {
        start = snapAfter;
      }
      adjusted = true;
      break;
    }
    if (!adjusted) break;
  }

  return Math.max(0, start);
}

function mapPartAtTimelineOffset(
  clip: Clip,
  timelineOffsetSec: number,
): { partIndex: number; sourceSec: number } | null {
  let cursor = 0;
  for (let i = 0; i < clip.parts.length; i++) {
    const part = clip.parts[i]!;
    const dur = partDuration(part);
    if (timelineOffsetSec >= cursor && timelineOffsetSec < cursor + dur - 1e-9) {
      return { partIndex: i, sourceSec: part.sourceInSec + (timelineOffsetSec - cursor) };
    }
    cursor += dur;
  }
  return null;
}

function splitPartsAt(
  parts: ClipPart[],
  timelineOffsetSec: number,
): [ClipPart[], ClipPart[]] | null {
  let cursor = 0;
  const left: ClipPart[] = [];
  const right: ClipPart[] = [];

  for (const part of parts) {
    const dur = partDuration(part);
    const partEnd = cursor + dur;

    if (timelineOffsetSec <= cursor + 1e-9) {
      right.push({ ...part });
      cursor = partEnd;
      continue;
    }

    if (timelineOffsetSec >= partEnd - 1e-9) {
      left.push({ ...part });
      cursor = partEnd;
      continue;
    }

    const offsetInPart = timelineOffsetSec - cursor;
    const splitSource = part.sourceInSec + offsetInPart;
    left.push({ assetId: part.assetId, sourceInSec: part.sourceInSec, sourceOutSec: splitSource });
    right.push({ assetId: part.assetId, sourceInSec: splitSource, sourceOutSec: part.sourceOutSec });
    cursor = partEnd;
  }

  const leftDur = left.reduce((s, p) => s + partDuration(p), 0);
  const rightDur = right.reduce((s, p) => s + partDuration(p), 0);
  if (leftDur < MIN_CLIP_DURATION_SEC || rightDur < MIN_CLIP_DURATION_SEC) return null;
  return [left, right];
}

export function splitClipAtPlayhead(
  project: EditorProject,
  clipId: string,
  atSec: number,
): EditorProject | null {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return null;

  const rel = atSec - clip.timelineStartSec;
  if (rel <= SPLIT_EDGE_EPS_SEC || rel >= clip.durationSec - SPLIT_EDGE_EPS_SEC) return null;

  const split = splitPartsAt(clip.parts, rel);
  if (!split) return null;
  const [leftParts, rightParts] = split;

  const leftDur = leftParts.reduce((s, p) => s + partDuration(p), 0);
  const rightDur = rightParts.reduce((s, p) => s + partDuration(p), 0);

  const left: Clip = {
    ...clip,
    id: newId(),
    durationSec: leftDur,
    parts: leftParts,
  };
  const right: Clip = {
    ...clip,
    id: newId(),
    timelineStartSec: clip.timelineStartSec + leftDur,
    durationSec: rightDur,
    parts: rightParts,
  };

  const next = cloneProject(project);
  next.clips = next.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]));
  next.selectedClipIds = [left.id, right.id];
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}

export function mergeClips(
  project: EditorProject,
  clipIds: readonly string[],
): EditorProject | null {
  if (clipIds.length < 2) return null;
  const clips = clipIds.map((id) => project.clips.find((c) => c.id === id)).filter(Boolean) as Clip[];
  if (clips.length !== clipIds.length) return null;

  const trackId = clips[0]!.trackId;
  if (!clips.every((c) => c.trackId === trackId)) return null;

  const sorted = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  const mergedParts: ClipPart[] = [];

  for (const clip of sorted) {
    mergedParts.push(...clip.parts.map((p) => ({ ...p })));
  }

  const totalDur = mergedParts.reduce((s, p) => s + partDuration(p), 0);
  const merged: Clip = {
    id: newId(),
    trackId,
    timelineStartSec: sorted[0]!.timelineStartSec,
    durationSec: totalDur,
    parts: mergedParts,
    transform: { ...sorted[0]!.transform },
  };

  const removeIds = new Set(clipIds);
  const next = cloneProject(project);
  next.clips = [...next.clips.filter((c) => !removeIds.has(c.id)), merged];
  next.selectedClipIds = [merged.id];
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}

export function moveClip(
  project: EditorProject,
  clipId: string,
  newStartSec: number,
  newTrackId?: string,
): EditorProject {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;

  const trackId = newTrackId ?? clip.trackId;
  const resolvedStart = resolveNonOverlappingStart(
    project.clips,
    clipId,
    trackId,
    newStartSec,
    clip.durationSec,
  );

  const next = cloneProject(project);
  next.clips = next.clips.map((c) => {
    if (c.id !== clipId) return c;
    return {
      ...c,
      timelineStartSec: resolvedStart,
      trackId,
    };
  });
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}

export function resizeClip(
  project: EditorProject,
  clipId: string,
  newDurationSec: number,
  assets: readonly Asset[],
): EditorProject | null {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const dur = Math.max(MIN_CLIP_DURATION_SEC, newDurationSec);

  const next = cloneProject(project);
  next.clips = next.clips.map((c) => {
    if (c.id !== clipId) return c;
    const asset = findAsset(assets, c.parts[0]?.assetId ?? "");
    if (asset?.kind === "image") {
      return {
        ...c,
        durationSec: dur,
        parts: [{ assetId: asset.id, sourceInSec: 0, sourceOutSec: dur }],
      };
    }
    const part = c.parts[0];
    if (!part) return { ...c, durationSec: dur };
    const maxSource = asset?.sourceDurationSec ?? part.sourceOutSec;
    const newOut = Math.min(part.sourceInSec + dur, maxSource);
    return {
      ...c,
      durationSec: newOut - part.sourceInSec,
      parts: [{ ...part, sourceOutSec: newOut }],
    };
  });
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}

export function deleteClips(project: EditorProject, clipIds: readonly string[]): EditorProject {
  const remove = new Set(clipIds);
  const next = cloneProject(project);
  next.clips = next.clips.filter((c) => !remove.has(c.id));
  next.selectedClipIds = next.selectedClipIds.filter((id) => !remove.has(id));
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  return next;
}

export function addClipToProject(project: EditorProject, clip: Clip): EditorProject {
  const next = cloneProject(project);
  next.clips = [...next.clips, clip];
  next.compositionDurationSec = computeCompositionDuration(next.clips);
  next.selectedClipIds = [clip.id];
  return next;
}

export function setClipTransform(
  project: EditorProject,
  clipId: string,
  transform: Clip["transform"],
): EditorProject {
  const next = cloneProject(project);
  next.clips = next.clips.map((c) =>
    c.id === clipId ? { ...c, transform: { ...transform } } : c,
  );
  return next;
}

export function getClipAtPlayhead(clip: Clip, playheadSec: number): boolean {
  return (
    playheadSec >= clip.timelineStartSec &&
    playheadSec < clip.timelineStartSec + clip.durationSec - 1e-9
  );
}

export function sourceTimeAtPlayhead(clip: Clip, playheadSec: number): number | null {
  const rel = playheadSec - clip.timelineStartSec;
  if (rel < 0 || rel >= clip.durationSec) return null;
  const mapped = mapPartAtTimelineOffset(clip, rel);
  return mapped?.sourceSec ?? null;
}

export function createClipWithDefaultTransform(
  partial: Omit<Clip, "transform">,
): Clip {
  return { ...partial, transform: { ...DEFAULT_TRANSFORM } };
}
