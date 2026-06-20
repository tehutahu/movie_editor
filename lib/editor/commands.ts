import { applySpeedRestoreToProject } from "@/lib/editor/applySpeedRestore";
import type { Clip, ClipTransform, EditorProject } from "@/lib/editor/types";
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
import { addTrackToProject } from "@/lib/editor/project";

export type EditorCommand =
  | { type: "split"; clipId: string; atSec: number }
  | { type: "merge"; clipIds: string[] }
  | { type: "move"; clipId: string; newStartSec: number; newTrackId?: string }
  | { type: "resize"; clipId: string; newDurationSec: number }
  | { type: "transform"; clipId: string; transform: ClipTransform }
  | { type: "delete"; clipIds: string[] }
  | { type: "addClip"; clip: Clip }
  | { type: "addTrack" }
  | { type: "duplicate"; clipIds: string[] }
  | {
      type: "restoreSpeed";
      assetId: string;
      jobId: string;
      speedFactor: number;
      restoredDurationSec: number;
    };

export function applyCommand(
  project: EditorProject,
  command: EditorCommand,
): EditorProject | null {
  switch (command.type) {
    case "split":
      return splitClipAtPlayhead(project, command.clipId, command.atSec);
    case "merge":
      return mergeClips(project, command.clipIds);
    case "move":
      return moveClip(project, command.clipId, command.newStartSec, command.newTrackId);
    case "resize": {
      return resizeClip(project, command.clipId, command.newDurationSec, project.assets);
    }
    case "transform":
      return setClipTransform(project, command.clipId, command.transform);
    case "delete":
      return deleteClips(project, command.clipIds);
    case "addClip":
      return addClipToProject(project, command.clip);
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
      });
    default:
      return null;
  }
}
