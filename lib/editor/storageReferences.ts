import type { CommandHistory } from "./commandHistory";
/** Include the library, all history snapshots, and restored-job sources. */
export function storageReferences(history: CommandHistory): string[] {
  const ids = new Set<string>();
  for (const project of [...history.undoStack, ...history.redoStack]) {
    for (const asset of project.assets) { ids.add(asset.id); if (asset.sourceJobId) ids.add(asset.sourceJobId); }
    for (const clip of project.clips) for (const part of clip.parts) ids.add(part.assetId);
  }
  return [...ids];
}
