import { expect, it } from "vitest";
import { groupMoveSnapshot, matchesGroupMoveSnapshot, moveClips, planGroupMove, resolveGroupMove } from "./moveClips";
import { createEmptyProject } from "./project";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, redo, updateEditorView } from "./commandHistory";
import type { Clip, EditorProject } from "./types";
function project(): EditorProject {
 const p=createEmptyProject();p.tracks=[{id:"t0",order:0},{id:"t1",order:1}];p.assets=[{id:"a",kind:"video",ext:"mp4",displayName:"a",streamUrl:"/x",sourceDurationSec:5,sourceJobId:"restore"}];
 const c=(id:string,trackId:string,timelineStartSec:number,extra:Partial<Clip>={}):Clip=>({id,trackId,timelineStartSec,durationSec:1,parts:[{assetId:"a",sourceInSec:.5,sourceOutSec:1.5}],transform:{x:.5,y:.5,scale:2},...extra});
 p.clips=[c("a","t0",1,{layoutMode:"contain"}),c("b","t1",3),c("other","t0",10)];p.selectedClipIds=["a","b"];return p;
}
it("common translation preserves track/IDs/gaps/parts/source/geometry/mode and all unselected objects",()=>{
 const p=project(),before=structuredClone(p),n=moveClips(p,p.selectedClipIds,2)!;
 expect(n.clips.map(c=>c.timelineStartSec)).toEqual([3,5,10]);expect(n.clips[1].timelineStartSec-n.clips[0].timelineStartSec).toBe(2);
 n.clips.forEach((c,i)=>{expect({...c,timelineStartSec:p.clips[i].timelineStartSec}).toEqual(p.clips[i]);expect(c.parts).toBe(p.clips[i].parts);});
 expect(n.clips[2]).toBe(p.clips[2]);expect(n.assets).toBe(p.assets);expect(n.tracks).toBe(p.tracks);expect(n.selectedClipIds).toBe(p.selectedClipIds);expect(p).toEqual(before);
});
it("one edit is one Undo/Redo and preserves custom duration; right extent alone grows it",()=>{
 const p=project(),h=createCommandHistory(p),edit=dispatchCommand(h,{type:"moveMany",clipIds:p.selectedClipIds,deltaSec:4})!;
 expect(edit.history.undoStack).toHaveLength(2);expect(edit.project.compositionDurationSec).toBe(30);expect(getCurrentProject(undo(edit.history)!)).toBe(p);expect(getCurrentProject(redo(undo(edit.history)!)!)).toBe(edit.project);
 expect(moveClips(p,p.selectedClipIds,40)!.compositionDurationSec).toBe(44);expect(moveClips(p,p.selectedClipIds,-100)!.compositionDurationSec).toBe(30);
});
it("whole group clamps at zero without flattening gaps and preserves internal preexisting overlap",()=>{
 const p=project();expect(moveClips(p,p.selectedClipIds,-100)!.clips.map(c=>c.timelineStartSec)).toEqual([0,2,10]);
 p.clips[1]={...p.clips[1],trackId:"t0",timelineStartSec:1.5};expect(moveClips(p,p.selectedClipIds,2)!.clips.map(c=>c.timelineStartSec)).toEqual([3,3.5,10]);
});
it("external same-track collision rejects all; touching and another track do not collide",()=>{
 const p=project();expect(moveClips(p,p.selectedClipIds,9)).toBeNull();expect(planGroupMove(p,p.selectedClipIds,9).reason).toMatch(/重なる/);
 expect(moveClips(p,p.selectedClipIds,8)!.clips[0].timelineStartSec).toBe(9); // end exactly blocker start
 p.clips[2]={...p.clips[2],trackId:"t1",timelineStartSec:6};expect(moveClips(p,p.selectedClipIds,5)).not.toBeNull();
});
it.each([0,NaN,Infinity,-Infinity,86400])("invalid/noop delta %s preserves pending Redo",deltaSec=>{
 const p=project(),h=createCommandHistory(p);const pending=undo(dispatchCommand(h,{type:"delete",clipIds:["other"]})!.history)!;
 expect(dispatchCommand(pending,{type:"moveMany",clipIds:p.selectedClipIds,deltaSec})).toBeNull();expect(pending.redoStack).toHaveLength(1);expect(pending.undoStack).toHaveLength(1);
});
it.each([["a"],["a","a"],["a","missing"],[]].map(ids=>({ids})))("invalid IDs are atomic no-op $ids",({ids})=>{expect(moveClips(project(),ids,2)).toBeNull();});
it("anchor start/end nearest snap only, start tie, Alt bypass; other selected edges never nominate snaps",()=>{
 const p=project();p.playheadSec=5;
 expect(resolveGroupMove(p,p.selectedClipIds,"a",3.95,80,false).deltaSec).toBe(4);
 expect(resolveGroupMove(p,p.selectedClipIds,"a",3.05,80,false).deltaSec).toBe(3);
 expect(resolveGroupMove(p,p.selectedClipIds,"a",3.05,80,true).deltaSec).toBe(3.05);
 expect(resolveGroupMove(p,p.selectedClipIds,"a",1.05,80,false).deltaSec).toBe(1.05);
 expect(resolveGroupMove(p,p.selectedClipIds,"a",3.5,8,false).deltaSec).toBe(4);
});
it("illegal nearest snap falls back to raw without trying the other anchor edge",()=>{
 const p=project();p.playheadSec=5;p.clips[2]={...p.clips[2],timelineStartSec:5.95};
 const r=resolveGroupMove(p,p.selectedClipIds,"a",3.91,80,false);expect(r).toEqual({deltaSec:3.91,reason:null});
 // Both anchor edges are in range, nearest start collides; further end isn't searched.
 expect(resolveGroupMove(p,p.selectedClipIds,"a",3.6,8,false).deltaSec).toBe(3.6);
});
it("snapshot accepts playback/frame navigation but rejects epoch, edit/source/selection/zoom changes",()=>{
 const p=project(),snapshot=groupMoveSnapshot(p,4,1),view=getCurrentProject(updateEditorView(createCommandHistory(p),{playheadSec:5}));
 expect(matchesGroupMoveSnapshot(view,4,1,snapshot)).toBe(true);
 expect(matchesGroupMoveSnapshot({...view,selectedClipIds:["b","a"]},4,1,snapshot)).toBe(true);
 for(const changed of [{...p,assets:p.assets.map(a=>({...a,sourceJobId:"new"}))},{...p,clips:[...p.clips]},{...p,tracks:[...p.tracks]},{...p,selectedClipIds:["a"]},{...p,compositionDurationSec:40}])expect(matchesGroupMoveSnapshot(changed,4,1,snapshot)).toBe(false);
 expect(matchesGroupMoveSnapshot(p,5,1,snapshot)).toBe(false);expect(matchesGroupMoveSnapshot(p,4,2,snapshot)).toBe(false);
});
it("near-24h times use the same finite delta without touching source timing or exceeding save range",()=>{
 const p=project();p.clips=[{...p.clips[0],timelineStartSec:86390.1},{...p.clips[1],timelineStartSec:86391.3}];p.compositionDurationSec=86400;
 const n=moveClips(p,p.selectedClipIds,.2)!;expect(n).not.toBeNull();expect(n.clips[0].timelineStartSec).toBe(86390.1+.2);expect(Math.abs((n.clips[1].timelineStartSec-n.clips[0].timelineStartSec)-(p.clips[1].timelineStartSec-p.clips[0].timelineStartSec))).toBeLessThan(1e-9);
 expect(moveClips(p,p.selectedClipIds,9)).toBeNull();
});

it("return to origin or zero-clamped drag never snaps into a new edit near the playhead",()=>{
 const p=project();p.playheadSec=1.05;expect(resolveGroupMove(p,p.selectedClipIds,"a",0,80,false)).toEqual({deltaSec:0,reason:null});
 p.clips[0]={...p.clips[0],timelineStartSec:0};p.playheadSec=.05;expect(resolveGroupMove(p,p.selectedClipIds,"a",-1,80,false)).toEqual({deltaSec:0,reason:null});
});

it("decimal equal-distance snap follows the existing start-edge tie and 8px rounding rule",()=>{
 const p=project();p.clips[0]={...p.clips[0],timelineStartSec:.1,durationSec:.1};p.playheadSec=1;
 expect(resolveGroupMove(p,p.selectedClipIds,"a",.85,80,false).deltaSec).toBe(.9);
});
