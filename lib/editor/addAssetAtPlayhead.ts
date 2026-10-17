import type { EditorProject, Track } from "./types";
import { clipFromAsset } from "./project";
import { addClipToProject, resolveNonOverlappingStart } from "./clipOps";
import { compositionSizeForFirstClip } from "./compositor";

/** Follow selection order, then the first visible track. No separate target state. */
export function assetAdditionTrack(project: EditorProject): Track | undefined {
  for (const id of project.selectedClipIds) {
    const clip = project.clips.find((candidate) => candidate.id === id);
    const track = project.tracks.find((candidate) => candidate.id === clip?.trackId);
    if (track) return track;
  }
  return [...project.tracks].sort((a, b) => a.order - b.order)[0];
}

/** A single edit includes placement, first-clip resolution and selection. */
export function addAssetAtPlayhead(
  project: EditorProject,
  assetId: string,
  clipId: string,
): EditorProject | null {
  const asset = project.assets.find((candidate) => candidate.id === assetId);
  const track = assetAdditionTrack(project);
  if (!asset || !track || project.clips.some((clip) => clip.id === clipId) ||
      !Number.isFinite(project.playheadSec) || project.playheadSec < 0) return null;
  const clip = { ...clipFromAsset({ asset, trackId: track.id,
    timelineStartSec: project.playheadSec, tracks: project.tracks }), id: clipId };
  clip.timelineStartSec = resolveNonOverlappingStart(project.clips, clip.id,
    track.id, project.playheadSec, clip.durationSec);
  const size = compositionSizeForFirstClip(project, asset);
  return addClipToProject(size ? { ...project, ...size } : project, clip);
}
