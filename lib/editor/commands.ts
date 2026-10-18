import { fitContentDuration } from "./contentDuration";
import { clearClipAudioFade, setClipAudioFade } from "./clipAudioFade";
import { addTitle, updateTitle } from "./title";
import { isMediaClip } from "./types";
import { setClipAudioGain } from "@/lib/editor/clipAudio";
import { moveClips } from "@/lib/editor/moveClips";
import { trimClipEnd, trimEndReason } from "@/lib/editor/trimClipEnd";
import { trimClipStart, trimStartReason } from "@/lib/editor/trimClipStart";
import { addAssetAtPlayhead } from "@/lib/editor/addAssetAtPlayhead";
import { applySpeedRestoreToProject } from "@/lib/editor/applySpeedRestore";
import type { Clip, ClipLayoutMode, ClipTransform, EditorProject } from "@/lib/editor/types";
import {
  addClipToProject,
  deleteClips,
  duplicateClips,
  mergeClips,
  moveClip,
  resizeClip,
  setClipTransform,
  splitClipAtPlayhead,
} from "@/lib/editor/clipOps";
import { addTrackToProject, deleteEmptyTrackFromProject } from "@/lib/editor/project";

export type EditorCommand =
  | { type: "audioFade"; clipId: string; inSec: number; outSec: number }
  | { type: "clearAudioFade"; clipId: string }
  | { type: "addTitle"; id: string; text: string }
  | { type: "titleText"; clipId: string; text: string }
  | { type: "trimEnd"; clipId: string; atSec: number }
  | { type: "trimStart"; clipId: string; atSec: number }
  | { type: "split"; clipId: string; atSec: number }
  | { type: "merge"; clipIds: string[] }
  | { type: "audioGain"; clipIds: string[]; gain: number }
  | { type: "fitContentDuration" }
  | { type: "moveMany"; clipIds: string[]; deltaSec: number }
  | { type: "move"; clipId: string; newStartSec: number; newTrackId?: string }
  | { type: "resize"; clipId: string; newDurationSec: number }
  | { type: "transform"; clipId: string; transform: ClipTransform }
  | { type: "layoutMode"; clipIds: string[]; layoutMode: ClipLayoutMode }
  | { type: "delete"; clipIds: string[] }
  | { type: "addClip"; clip: Clip }
  | { type: "addAssetAtPlayhead"; assetId: string; clipId: string }
  | { type: "addTrack" }
  | { type: "deleteEmptyTrack"; trackId: string }
  | { type: "duplicate"; clipIds: string[] }
  | {
      type: "restoreSpeed";
      assetId: string;
      jobId: string;
      speedFactor: number;
      restoredDurationSec: number;
      restoredWidth: number;
      restoredHeight: number;
    };

export function applyCommand(
  project: EditorProject,
  command: EditorCommand,
): EditorProject | null {
  switch (command.type) {
    case "fitContentDuration": return fitContentDuration(project);
    case "audioFade": return setClipAudioFade(project, command.clipId, command.inSec, command.outSec);
    case "clearAudioFade": return clearClipAudioFade(project, command.clipId);
    case "addTitle": return addTitle(project, command.id, command.text);
    case "titleText": return updateTitle(project, command.clipId, command.text);
    case "trimEnd": {
      if (project.selectedClipIds.length !== 1 || project.selectedClipIds[0] !== command.clipId ||
          trimEndReason({ ...project, playheadSec: command.atSec }, false)) return null;
      return trimClipEnd(project, command.clipId, command.atSec);
    }
    case "trimStart": {
      if (project.selectedClipIds.length !== 1 || project.selectedClipIds[0] !== command.clipId ||
          trimStartReason({ ...project, playheadSec: command.atSec }, false)) return null;
      return trimClipStart(project, command.clipId, command.atSec);
    }
    case "split":
      return splitClipAtPlayhead(project, command.clipId, command.atSec);
    case "merge":
      return mergeClips(project, command.clipIds);
    case "audioGain":
      return setClipAudioGain(project, command.clipIds, command.gain);
    case "moveMany":
      return moveClips(project, command.clipIds, command.deltaSec);
    case "move":
      return moveClip(project, command.clipId, command.newStartSec, command.newTrackId);
    case "resize": {
      return resizeClip(project, command.clipId, command.newDurationSec, project.assets);
    }
    case "transform":
      return setClipTransform(project, command.clipId, command.transform);
    case "layoutMode": {
      if (command.layoutMode !== "stretch" && command.layoutMode !== "contain") return null;
      const ids = new Set(command.clipIds);
      if (project.clips.some(c => ids.has(c.id) && !isMediaClip(c))) return null;
      if (!project.clips.some(c => ids.has(c.id) && (c.layoutMode ?? "stretch") !== command.layoutMode)) return null;
      return { ...project, clips: project.clips.map(c => ids.has(c.id) && isMediaClip(c) ? { ...c, layoutMode: command.layoutMode } : c) };
    }
    case "delete":
      return deleteClips(project, command.clipIds);
    case "addAssetAtPlayhead":
      return addAssetAtPlayhead(project, command.assetId, command.clipId);
    case "addClip":
      return addClipToProject(project, command.clip);
    case "deleteEmptyTrack":
      return deleteEmptyTrackFromProject(project, command.trackId);
    case "addTrack":
      return addTrackToProject(project);
    case "duplicate":
      return duplicateClips(project, command.clipIds);
    case "restoreSpeed":
      return applySpeedRestoreToProject(project, {
        assetId: command.assetId,
        jobId: command.jobId,
        speedFactor: command.speedFactor,
        restoredDurationSec: command.restoredDurationSec,
        restoredWidth: command.restoredWidth,
        restoredHeight: command.restoredHeight,
      });
    default:
      return null;
  }
}
