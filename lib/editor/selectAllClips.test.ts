import { expect, it } from "vitest";
import { allClipSelection, applySelectAllClips } from "./selectAllClips";
import { createEmptyProject } from "./project";
import { createCommandHistory, dispatchCommand, getCurrentProject, redo, undo, updateEditorView } from "./commandHistory";
import { projectContentKey, projectDocumentDraft } from "./projectDocument";
import { titleDescriptor } from "./title";
import type { EditorProject } from "./types";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture():EditorProject {
 const p=createEmptyProject();p.tracks=[0,1,2].map(order=>({id:id(order+1),order}));
 p.assets=[{id:id(4),kind:"video",ext:"mp4",displayName:"告知",streamUrl:"/video",sourceDurationSec:8,width:320,height:320},{id:id(5),kind:"image",ext:"png",displayName:"背景",streamUrl:"/image",width:320,height:320}];
 p.clips=[0,1,2,3,4,5].map((n)=>n<3?{id:id(6+n),trackId:id(n+1),timelineStartSec:n,durationSec:1,parts:[{assetId:id(n===2?5:4),sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:1},...(n===0?{audioGain:.5,audioFade:{inSec:.25,outSec:.25,anchorDurationSec:1,offsetSec:0}}:{})}
 :{id:id(6+n),kind:"title",trackId:id(n-2),timelineStartSec:n+1,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor("案内")});
 p.playheadSec=2;p.selectedClipIds=[id(10),id(6)];return p;
}
it("retains valid primary/prefix and appends every media/image/title track in stored order",()=>{
 const p=fixture();expect(allClipSelection(p)).toEqual([id(10),id(6),id(7),id(8),id(9),id(11)]);
 const h=createCommandHistory(p),n=applySelectAllClips(h,2,2,false),v=getCurrentProject(n);
 expect(v).toEqual({...p,selectedClipIds:[id(10),id(6),id(7),id(8),id(9),id(11)]});expect(v.clips).toBe(p.clips);expect(v.assets).toBe(p.assets);expect(v.tracks).toBe(p.tracks);
 expect(n.undoStack).toHaveLength(1);expect(n.redoStack).toBe(h.redoStack);expect(projectDocumentDraft(v)).toEqual(projectDocumentDraft(p));expect(projectContentKey(v)).toBe(projectContentKey(p));
});
it("does not omit unavailable/missing media or sort clip ends, time, or track order",()=>{const p=fixture();p.assets=[];p.clips.reverse();p.selectedClipIds=[];expect(allClipSelection(p)).toEqual(p.clips.map(c=>c.id));});
it("empty is exact identity noop even with invalid selection",()=>{const p=createEmptyProject();p.selectedClipIds=["stale"];const h=createCommandHistory(p);expect(allClipSelection(p)).toBe(p.selectedClipIds);expect(applySelectAllClips(h,0,0,false)).toBe(h);});
it("whole reversed selection is an exact identity noop",()=>{const p=fixture();p.selectedClipIds=p.clips.map(c=>c.id).reverse();const h=createCommandHistory(p);expect(allClipSelection(p)).toBe(p.selectedClipIds);expect(applySelectAllClips(h,0,0,false)).toBe(h);});
it("repairs invalid and duplicate selection without changing valid prefix",()=>{const p=fixture();p.selectedClipIds=[id(10),"missing",id(10),id(6)];expect(allClipSelection(p)).toEqual([id(10),id(6),id(7),id(8),id(9),id(11)]);});
it("preserves actual pending Redo through selection and redoes the original edit",()=>{const p=fixture(),edit=dispatchCommand(createCommandHistory(p),{type:"addTrack"})!.history,h=undo(edit)!,n=applySelectAllClips(h,0,0,false);expect(n.redoStack).toBe(h.redoStack);expect(n.undoStack.length).toBe(h.undoStack.length);expect(getCurrentProject(redo(n)!)).toBe(getCurrentProject(edit));});
it("adopts the latest clip membership and latest prefix rather than an event ID list",()=>{
 const p=fixture(),h=createCommandHistory(p);const deleted=dispatchCommand(h,{type:"delete",clipIds:[id(7)]})!.history;
 const v=updateEditorView(deleted,{selectedClipIds:[id(11)]}),n=applySelectAllClips(v,4,4,false);
 expect(getCurrentProject(n).selectedClipIds).toEqual([id(11),id(6),id(8),id(9),id(10)]);expect(getCurrentProject(n).selectedClipIds).not.toContain(id(7));
});
it("blocked and epoch-changed adoption leaves all history references untouched",()=>{const h=createCommandHistory(fixture());expect(applySelectAllClips(h,2,3,false)).toBe(h);expect(applySelectAllClips(h,2,2,true)).toBe(h);});
