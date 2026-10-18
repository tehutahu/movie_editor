import { getCurrentProject, updateEditorView, type CommandHistory } from "./commandHistory";
import type { EditorProject } from "./types";

/** Keep the current primary/prefix; include every track and kind in stored order. */
export function allClipSelection(project: EditorProject): string[] {
  if (project.clips.length === 0) return project.selectedClipIds;
  const valid = new Set(project.clips.map(clip => clip.id)), seen = new Set<string>(), selected: string[] = [];
  for (const id of [...project.selectedClipIds, ...project.clips.map(clip => clip.id)]) {
    if (valid.has(id) && !seen.has(id)) { selected.push(id); seen.add(id); }
  }
  return selected.length === project.selectedClipIds.length && selected.every((id, i) => id === project.selectedClipIds[i])
    ? project.selectedClipIds : selected;
}

/** Recompute against adopted state, never inject a keydown's stale ID array. */
export function applySelectAllClips(history: CommandHistory, expectedEpoch: number, actualEpoch: number, blocked: boolean): CommandHistory {
  if (blocked || expectedEpoch !== actualEpoch) return history;
  const current = getCurrentProject(history), selectedClipIds = allClipSelection(current);
  return selectedClipIds === current.selectedClipIds ? history : updateEditorView(history, { selectedClipIds });
}
