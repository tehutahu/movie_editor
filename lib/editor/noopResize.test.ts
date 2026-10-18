import { expect, it } from "vitest";
import { createEmptyProject, clipFromAsset } from "./project";
import { resizeClip } from "./clipOps";
import { createCommandHistory, dispatchCommand, getCurrentProject, redo, undo } from "./commandHistory";
import { projectContentKey } from "./projectDocument";
import type { Asset } from "./types";
function fixture() {
  const asset: Asset = { id: "video", kind: "video", ext: "mp4", displayName: "source", streamUrl: "/source", sourceDurationSec: 2 };
  const p = createEmptyProject();
  p.assets = [asset]; p.clips = [clipFromAsset({asset, trackId:p.tracks[0]!.id, timelineStartSec:0})];
  p.selectedClipIds = [p.clips[0]!.id];
  return p;
}
it.each([2, 3, 200])("resolved no-op resize (%s sec) preserves the entire pending history and document", requested => {
  const p = fixture(), snapshot = structuredClone(p);
  const edited = dispatchCommand(createCommandHistory(p), {type:"duplicate", clipIds:p.selectedClipIds})!.history;
  const history = undo(edited)!, before = structuredClone(history), current = getCurrentProject(history);
  expect(dispatchCommand(history,{type:"resize",clipId:current.clips[0]!.id,newDurationSec:requested})).toBeNull();
  expect(history).toEqual(before); expect(p).toEqual(snapshot);
  expect(projectContentKey(getCurrentProject(history))).toBe(projectContentKey(p));
  expect(getCurrentProject(redo(history)!).clips).toEqual(getCurrentProject(edited).clips);
});
it("preserves a custom composition length and joined parts when the tail is already exhausted",()=>{
 const p=fixture();p.compositionDurationSec=30;p.clips[0]!.durationSec=3;
 p.clips[0]!.parts =[{assetId:"video",sourceInSec:0,sourceOutSec:1},{assetId:"video",sourceInSec:0,sourceOutSec:2}];
 const before=structuredClone(p);
 expect(resizeClip(p,p.clips[0]!.id,10,p.assets)).toBeNull();expect(p).toEqual(before);
});
it("actual trim and extension remain one edit, invalidate stale Redo and roundtrip source parts",()=>{
 const p=fixture();
 const history=undo(dispatchCommand(createCommandHistory(p),{type:"duplicate",clipIds:p.selectedClipIds})!.history)!;
 const trimmed=dispatchCommand(history,{type:"resize",clipId:p.clips[0]!.id,newDurationSec:1})!.history;
 expect(trimmed.undoStack).toHaveLength(history.undoStack.length+1);expect(trimmed.redoStack).toEqual([]);
 expect(getCurrentProject(trimmed).clips[0]!.parts![0]!.sourceOutSec).toBe(1);
 expect(getCurrentProject(undo(trimmed)!).clips).toEqual(p.clips);
 expect(getCurrentProject(redo(undo(trimmed)!)!).clips).toEqual(getCurrentProject(trimmed).clips);
 const extended=dispatchCommand(trimmed,{type:"resize",clipId:p.clips[0]!.id,newDurationSec:3})!.history;
 expect(extended.undoStack).toHaveLength(trimmed.undoStack.length+1);
 expect(getCurrentProject(extended).clips).toEqual(p.clips);
 expect(getCurrentProject(undo(extended)!).clips).toEqual(getCurrentProject(trimmed).clips);
});
it("does not suppress a genuine tiny resize or an image tail extension",()=>{
 const p=fixture();
 expect(resizeClip(p,p.clips[0]!.id,2-1e-8,p.assets)?.clips[0]!.durationSec).toBe(2-1e-8);
 p.assets[0]={...p.assets[0]!,kind:"image",ext:"png",sourceDurationSec:undefined};
 expect(resizeClip(p,p.clips[0]!.id,3,p.assets)?.clips[0]!.durationSec).toBe(3);
});
