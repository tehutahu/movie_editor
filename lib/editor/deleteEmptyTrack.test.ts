import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { addTrackToProject, clipFromAsset, createEmptyProject, deleteEmptyTrackFromProject } from "./project";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, redo } from "./commandHistory";
import { clipsForExportComposition, resolveActiveClipsAtPlayhead, resolveAudioClipAtPlayhead, resolveAudioTrackForExport } from "./compositor";
import { projectDocumentDraft, parseProjectDocument, documentToProject, projectContentKey } from "./projectDocument";
import { parseTrack } from "./validateExportProject";
import { storageReferences } from "./storageReferences";
import type { ClipLayoutMode } from "./types";
function fixture(orders = [0, 2, 7, 20]) {
  const p = createEmptyProject();
  p.tracks = orders.map(order => ({id:randomUUID(), order}));
  const asset = {id:randomUUID(),kind:"video" as const,ext:"mp4",displayName:"movie",streamUrl:"/source",sourceDurationSec:2,width:320,height:240};
  p.assets=[asset];p.clips=[clipFromAsset({asset,trackId:p.tracks[0]!.id,timelineStartSec:0})];
  p.selectedClipIds=[p.clips[0]!.id];p.playheadSec=.5;p.compositionDurationSec=30;
  return p;
}
it.each([1, 2, 3])("deletes empty track index %s, preserving IDs, array order and all non-track state",index=>{
 const p=fixture(),before=structuredClone(p),target=p.tracks[index]!.id;
 const next=deleteEmptyTrackFromProject(p,target)!;
 expect(next.tracks.map(t=>t.id)).toEqual(p.tracks.filter(t=>t.id!==target).map(t=>t.id));
 expect(next.tracks.map(t=>t.order)).toEqual([0,1,2]);
 expect({...next,tracks:p.tracks}).toEqual(p);expect(next.clips).toBe(p.clips);expect(p).toEqual(before);
 const h=dispatchCommand(createCommandHistory(p),{type:"deleteEmptyTrack",trackId:target})!.history;
 expect(h.undoStack).toHaveLength(2);expect(getCurrentProject(undo(h)!)).toEqual(p);expect(getCurrentProject(redo(undo(h)!)!)).toEqual(next);
 expect(storageReferences(h)).toEqual(storageReferences(createCommandHistory(p)));
});
it("can delete an empty lowest-order track without changing populated track identity",()=>{
 const p=fixture();p.clips[0]!.trackId=p.tracks[2]!.id;
 const next=deleteEmptyTrackFromProject(p,p.tracks[0]!.id)!;
 expect(next.tracks.map(t=>t.order)).toEqual([0,1,2]);expect(next.clips).toBe(p.clips);
});
it("guards nonexistent, newly populated and final tracks without changing pending Redo or the DTO",()=>{
 const p=fixture(),edited=dispatchCommand(createCommandHistory(p),{type:"addTrack"})!.history;
 const history=undo(edited)!,before=structuredClone(history),key=projectContentKey(getCurrentProject(history));
 for(const trackId of [randomUUID(),p.clips[0]!.trackId]) expect(dispatchCommand(history,{type:"deleteEmptyTrack",trackId})).toBeNull();
 const stale=p.tracks[1]!.id;const populated={...p,clips:[...p.clips,{...p.clips[0]!,id:randomUUID(),trackId:stale}]};
 expect(deleteEmptyTrackFromProject(populated,stale)).toBeNull();
 const single={...p,tracks:[p.tracks[1]!],clips:[]};expect(deleteEmptyTrackFromProject(single,single.tracks[0]!.id)).toBeNull();
 expect(history).toEqual(before);expect(projectContentKey(getCurrentProject(history))).toBe(key);expect(redo(history)).not.toBeNull();
});
it("compresses distinct orders without splitting same-order groups or changing compositor/audio ties",()=>{
 const p=fixture([7,2,2,20]);
 p.clips=[{...p.clips[0]!,trackId:p.tracks[1]!.id,timelineStartSec:.1},{...p.clips[0]!,id:randomUUID(),trackId:p.tracks[2]!.id,timelineStartSec:.3}];
 const next=deleteEmptyTrackFromProject(p,p.tracks[3]!.id)!;
 expect(next.tracks.map(t=>t.id)).toEqual(p.tracks.slice(0,3).map(t=>t.id));expect(next.tracks.map(t=>t.order)).toEqual([1,0,0]);
 expect(clipsForExportComposition(next).map(l=>l.clip.id)).toEqual(clipsForExportComposition(p).map(l=>l.clip.id));
 expect(resolveActiveClipsAtPlayhead(next,.5).map(l=>l.clip.id)).toEqual(resolveActiveClipsAtPlayhead(p,.5).map(l=>l.clip.id));
 expect(resolveAudioTrackForExport(next)?.id).toBe(resolveAudioTrackForExport(p)?.id);
 expect(resolveAudioClipAtPlayhead(next,.5)?.clip.id).toBe(resolveAudioClipAtPlayhead(p,.5)?.clip.id);
});
it("keeps repeated add/delete within the existing order/count validators",()=>{
 let p=fixture([0,20]);
 for(let i=0;i<50;i++) {
  p=deleteEmptyTrackFromProject(p,p.tracks[1]!.id)!;p=addTrackToProject(p);
  expect(p.tracks).toHaveLength(2);expect(p.tracks.map(t=>t.order)).toEqual([0,1]);
  p.tracks.forEach((t,i)=>expect(parseTrack(t,i)).toEqual(t));expect(()=>parseProjectDocument(projectDocumentDraft(p))).not.toThrow();
 }
 const boundary=fixture(Array.from({length:20},(_,i)=>i===0?0:i+1));
 const full=addTrackToProject(deleteEmptyTrackFromProject(boundary,boundary.tracks[10]!.id)!);
 expect(full.tracks).toHaveLength(20);expect(Math.max(...full.tracks.map(t=>t.order))).toBe(19);
 expect(()=>parseProjectDocument(projectDocumentDraft(full))).not.toThrow();
});
it.each([undefined,"contain"] as (ClipLayoutMode|undefined)[])("retains v1/v2 media, clip geometry and composition through save/load for %s",mode=>{
 const p=fixture();if(mode)p.clips[0]!.layoutMode=mode;
 const original=projectDocumentDraft(p),next=deleteEmptyTrackFromProject(p,p.tracks[2]!.id)!;
 const doc=parseProjectDocument(projectDocumentDraft(next));expect(doc.version).toBe(mode?2:1);
 expect({...doc.project,tracks:original.project.tracks}).toEqual(original.project);
 expect(documentToProject(doc).clips).toEqual(p.clips);
});
