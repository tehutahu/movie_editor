import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applySpeedRestoreToProject } from "./applySpeedRestore";
import { createEmptyProject, clipFromAsset } from "./project";
import { clipAudioGain, audioGainFilter, formatAudioGain, setClipAudioGain, clipAudioSnapshot, matchesClipAudioSnapshot } from "./clipAudio";
import { projectDocumentDraft, parseProjectDocument, documentToProject } from "./projectDocument";
import { parseClip } from "./validateExportProject";
import { splitClipAtPlayhead, mergeClips, duplicateClips } from "./clipOps";
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from "./commandHistory";
import { selectedClipExportRequest } from "./selectedClipExport";
import type { Asset, EditorProject, MediaClip } from "./types";
function fixture(){const p=createEmptyProject() as EditorProject & {clips:MediaClip[]};const assets:Asset[]=[{id:randomUUID(),kind:"video",ext:"mp4",displayName:"v",streamUrl:"/v",sourceDurationSec:4,width:320,height:320},{id:randomUUID(),kind:"image",ext:"png",displayName:"i",streamUrl:"/i",width:320,height:320}];p.assets=assets;p.clips=assets.map((asset,i)=>clipFromAsset({asset,trackId:p.tracks[0].id,timelineStartSec:i,durationSec:1}));p.selectedClipIds=p.clips.map(c=>c.id);return p;}
it("applies only explicitly eligible targets atomically, preserving pure images and all media/geometry/timing",()=>{
 const p=fixture(),before=structuredClone(p),id=p.clips[0].id;const n=setClipAudioGain(p,[id],.5)!;
 expect(n.clips[0].audioGain).toBe(.5);expect(n.clips[1]).toBe(p.clips[1]);expect(n.assets).toBe(p.assets);expect(n.tracks).toBe(p.tracks);expect({...n.clips[0],audioGain:undefined}).toEqual({...p.clips[0],audioGain:undefined});expect(p).toEqual(before);
 expect(setClipAudioGain(p,p.selectedClipIds,.5)).toBeNull();expect(setClipAudioGain(p,[id,id],.5)).toBeNull();expect(setClipAudioGain(p,[id,"missing"],.5)).toBeNull();
});
it.each([-1,1.1,NaN,Infinity])("invalid gain %s is a no-op",gain=>{const p=fixture();expect(setClipAudioGain(p,[p.clips[0].id],gain)).toBeNull();});
it("one apply is one Undo/Redo, equal gain and explicit/default1 preserve Redo, restoring1 removes field",()=>{
 const p=fixture(),command={type:"audioGain" as const,clipIds:[p.clips[0].id],gain:.5};const edit=dispatchCommand(createCommandHistory(p),command)!;
 expect(edit.history.undoStack).toHaveLength(2);expect(getCurrentProject(undo(edit.history)!)).toBe(p);expect(getCurrentProject(redo(undo(edit.history)!)!)).toBe(edit.project);
 expect(dispatchCommand(edit.history,command)).toBeNull();const pending=undo(edit.history)!;expect(dispatchCommand(pending,{...command,gain:1})).toBeNull();expect(pending.redoStack).toHaveLength(1);
 expect(Object.hasOwn(setClipAudioGain(edit.project,command.clipIds,1)!.clips[0],"audioGain")).toBe(false);
});
it("default graph string is empty, arbitrary gain literals roundtrip without either time formatter",()=>{
 const p=fixture();expect(audioGainFilter(p.clips[0])).toBe("");
 for(const gain of [0,.25,.5,1,1e-7,1e-12,Number.MIN_VALUE]){const text=formatAudioGain(gain);expect(text).not.toContain("e");expect(Number(text)).toBe(gain);expect(audioGainFilter({...p.clips[0],audioGain:gain})).toBe(gain===1?"":`volume=${text},`);}
});
it("v3 roundtrip preserves nondefault/tiny/inactive gain, default writer remains exact v1/v2",()=>{
 const p=fixture(),legacy=projectDocumentDraft(p);expect(legacy.version).toBe(1);
 p.clips[0].audioGain=1;expect(projectDocumentDraft(p)).toEqual(legacy);
 for(const gain of [0,.25,1e-12,Number.MIN_VALUE]){p.clips[0].audioGain=gain;p.clips[1].audioGain=.7;const doc=projectDocumentDraft(p);expect(doc.version).toBe(3);expect(documentToProject(parseProjectDocument(doc)).clips.map(c=>c.audioGain)).toEqual([gain,.7]);}
 delete p.clips[0].audioGain;delete p.clips[1].audioGain;p.clips[0].layoutMode="contain";expect(projectDocumentDraft(p).version).toBe(2);
});
it("old versions reject any new property and v3 strictly validates values/unknownversion",()=>{
 const p=fixture();for(const version of [1,2] as const)for(const gain of [undefined,1,0]){const doc=projectDocumentDraft(p);doc.version=version;doc.project.clips[0].audioGain=gain;expect(()=>parseProjectDocument(doc)).toThrow();}
 for(const gain of [null,".5",NaN,-1,1.01]){const doc=projectDocumentDraft(p);doc.version=3;Object.assign(doc.project.clips[0],{audioGain:gain});expect(()=>parseProjectDocument(doc)).toThrow();}
 const doc=projectDocumentDraft(p);expect(()=>parseProjectDocument({...doc,version:6})).toThrow();
 const c={...p.clips[0],audioGain:null};expect(()=>parseClip(c,0,new Set(p.tracks.map(t=>t.id)),new Set(p.assets.map(a=>a.id)),30)).toThrow();
});
it("split/duplicate preserve gain, video merge ignores inactive images and rejects different video gains",()=>{
 const p=fixture();p.clips[0].audioGain=.5;p.clips[1].audioGain=.2;const merged=mergeClips(p,p.selectedClipIds)!;expect(merged.clips[0].audioGain).toBe(.5);
 const split=splitClipAtPlayhead(merged,merged.clips[0].id,1)!;expect(split.clips.map(clipAudioGain)).toEqual([.5,.5]);expect(duplicateClips(p,[p.clips[0].id])!.clips.at(-1)!.audioGain).toBe(.5);
 const q=fixture();q.clips[1]={...q.clips[1],parts:q.clips[0].parts!,audioGain:.5};expect(mergeClips(q,q.selectedClipIds)).toBeNull();q.clips[0].audioGain=.5;expect(mergeClips(q,q.selectedClipIds)!.clips[0].audioGain).toBe(.5);
});
it("selected single and multipart requests omit gain and preserve the input project",()=>{
 const p=fixture();p.clips[0].audioGain=0;const before=structuredClone(p),single=selectedClipExportRequest(p,p.clips[0]);expect(single.url).toBe("/api/jobs/export-segment");expect(Object.hasOwn(single.body,"audioGain")).toBe(false);
 const clip={...p.clips[0],parts:[...p.clips[0].parts!,...p.clips[1].parts!],durationSec:2};const req=selectedClipExportRequest(p,clip);expect(req.url).toBe("/api/jobs/export-composition");expect(JSON.stringify(req.body)).not.toContain('audioGain');expect(p).toEqual(before);
});
it("snapshot targets video-containing selection and rejects stale selection/source/epoch without rejecting playhead",()=>{
 const p=fixture(),s=clipAudioSnapshot(p,1);expect(s.clipIds).toEqual([p.clips[0].id]);expect(matchesClipAudioSnapshot({...p,playheadSec:4},1,s)).toBe(true);
 expect(matchesClipAudioSnapshot({...p,selectedClipIds:[...p.selectedClipIds].reverse()},1,s)).toBe(true);
 expect(matchesClipAudioSnapshot(p,2,s)).toBe(false);expect(matchesClipAudioSnapshot({...p,selectedClipIds:[]},1,s)).toBe(false);expect(matchesClipAudioSnapshot({...p,assets:p.assets.map(a=>({...a,sourceJobId:randomUUID()}))},1,s)).toBe(false);
});

it("speed restore preserves constant gain and never applies it to the source media",()=>{
 const p=fixture();p.clips[0].audioGain=.33;const n=applySpeedRestoreToProject(p,{assetId:p.assets[0].id,jobId:randomUUID(),speedFactor:2,restoredDurationSec:8,restoredWidth:320,restoredHeight:320});expect(n.clips[0].audioGain).toBe(.33);expect(n.clips[1]).toEqual(p.clips[1]);expect(Object.hasOwn(n.assets[0],"audioGain")).toBe(false);
});
