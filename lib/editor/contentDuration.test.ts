import { describe, expect, it } from "vitest";
import { applyContentDuration, contentDurationOwnerStopped, contentDurationPlan, contentDurationSnapshot, fitContentDuration } from "./contentDuration";
import { createCommandHistory, dispatchCommand, getCurrentProject, redo, undo, updateEditorView } from "./commandHistory";
import { createEmptyProject } from "./project";
import { documentToProject, parseProjectDocument, projectDocumentDraft } from "./projectDocument";
import { titleDescriptor } from "./title";
import type { EditorProject } from "./types";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture(): EditorProject {
  const p=createEmptyProject();p.tracks=[0,1,2].map(order=>({id:id(order+1),order}));
  p.assets=[{id:id(4),kind:"video",ext:"mp4",displayName:"告知",streamUrl:"/video",sourceDurationSec:4,width:320,height:180},
    {id:id(5),kind:"image",ext:"png",displayName:"画像",streamUrl:"/image",width:320,height:180}];
  p.clips=[{id:id(6),trackId:id(1),timelineStartSec:1,durationSec:3,parts:[{assetId:id(4),sourceInSec:.5,sourceOutSec:2},{assetId:id(4),sourceInSec:2,sourceOutSec:3.5}],transform:{x:.5,y:.5,scale:1},audioGain:.7,audioFade:{inSec:.5,outSec:.5,anchorDurationSec:3,offsetSec:0}},
    {id:id(7),trackId:id(2),timelineStartSec:5,durationSec:1,parts:[{assetId:id(5),sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:1}},
    {id:id(8),kind:"title",trackId:id(3),timelineStartSec:6,durationSec:2,transform:{x:.5,y:.5,scale:1},...titleDescriptor("告知") }];
  p.compositionDurationSec=30;p.playheadSec=20;p.selectedClipIds=[id(6)];return p;
}
function apply(p: EditorProject) {const h=createCommandHistory(p);return applyContentDuration(h,contentDurationSnapshot(h,1),1,false);}
it("reduces only D and latest P in one command; all source/title/selection references survive",()=>{
  const p=fixture(),h=apply(p),n=getCurrentProject(h);expect(n).toEqual({...p,compositionDurationSec:8,playheadSec:8});
  expect(n.clips).toBe(p.clips);expect(n.assets).toBe(p.assets);expect(n.tracks).toBe(p.tracks);expect(n.selectedClipIds).toBe(p.selectedClipIds);
  expect(h.undoStack).toHaveLength(2);expect(getCurrentProject(undo(h)!)).toBe(p);expect(getCurrentProject(redo(undo(h)!)!)).toBe(n);
});
it.each([0,3,8,29])("keeps or clamps position %s exactly",position=>{const p=fixture();p.playheadSec=position;expect(fitContentDuration(p)?.playheadSec).toBe(Math.min(position,8));});
it("includes image, silent and missing media even outside selection and preserves internal gaps",()=>{
  const p=fixture();p.clips=p.clips.filter(c=>c.kind!=="title");p.assets=[];expect(fitContentDuration(p)?.compositionDurationSec).toBe(6);expect(fitContentDuration(p)?.clips).toBe(p.clips);
});
it.each([.05,.1+.2,8+Number.EPSILON*8,86400])("uses exact binary64 end %s without minimum10 or epsilon",end=>{
  const p=fixture();p.clips=[{...p.clips[0],timelineStartSec:0,durationSec:end}];p.compositionDurationSec=end===86400?86400:Math.min(86400,end+1);p.playheadSec=0;
  if(end===86400){expect(contentDurationPlan(p).reason).not.toBeNull();expect(fitContentDuration(p)).toBeNull();}
  else expect(fitContentDuration(p)?.compositionDurationSec).toBe(end);
});
it("allows the tiniest representable reduction rather than an epsilon no-op",()=>{const p=fixture();p.compositionDurationSec=8+Number.EPSILON*8;p.playheadSec=0;expect(fitContentDuration(p)?.compositionDurationSec).toBe(8);});
it.each([NaN,Infinity,-1,0,.049,86401])("rejects invalid D %s",d=>{const p=fixture();p.compositionDurationSec=d;expect(fitContentDuration(p)).toBeNull();});
it.each([NaN,Infinity,-1,31])("rejects invalid P %s",n=>{const p=fixture();p.playheadSec=n;expect(fitContentDuration(p)).toBeNull();});
it.each([NaN,Infinity,-1])("rejects invalid clip start %s",n=>{const p=fixture();p.clips[0]={...p.clips[0],timelineStartSec:n};expect(fitContentDuration(p)).toBeNull();});
it.each([NaN,Infinity,0,-1])("rejects invalid clip duration %s",n=>{const p=fixture();p.clips[0]={...p.clips[0],durationSec:n};expect(fitContentDuration(p)).toBeNull();});
it("rejects empty, subminimum, overD and over24h content without identity/history changes",()=>{
 for(const clips of [[],[{...fixture().clips[0],timelineStartSec:0,durationSec:.04}],[{...fixture().clips[0],timelineStartSec:30,durationSec:1}],[{...fixture().clips[0],timelineStartSec:86400,durationSec:1}]]){
  const p=fixture();p.clips=clips;const h=createCommandHistory(p);expect(applyContentDuration(h,contentDurationSnapshot(h,1),1,false)).toBe(h);
 }
});
describe("queued adoption and Redo",()=>{
 it("uses latest view position/selection while retaining the same content snapshot",()=>{
  const p=fixture(),h=createCommandHistory(p),s=contentDurationSnapshot(h,1),v=updateEditorView(h,{playheadSec:4,selectedClipIds:[]});
  const n=getCurrentProject(applyContentDuration(v,s,1,false));expect(n.playheadSec).toBe(4);expect(n.selectedClipIds).toEqual([]);expect(n.compositionDurationSec).toBe(8);
 });
 it("keeps Redo identity on no-op/blocked/stale and rejects intervening edit/undo-redo",()=>{
  const p=fixture(),base=createCommandHistory(p),edited=dispatchCommand(base,{type:"addTrack"})!.history,h=undo(edited)!,s=contentDurationSnapshot(h,1);
  expect(applyContentDuration(h,s,1,true)).toBe(h);expect(applyContentDuration(h,s,2,false)).toBe(h);
  expect(applyContentDuration(edited,s,1,false)).toBe(edited);const navigated=undo(redo(h)!)!;expect(applyContentDuration(navigated,s,1,false)).toBe(navigated);
  const n=applyContentDuration(h,s,1,false);expect(n.redoStack).toEqual([]);const same=updateEditorView(n,{playheadSec:3});expect(applyContentDuration(same,contentDurationSnapshot(same,1),1,false)).toBe(same);
 });
 it("keeps sub10 D for views but leaves the existing later content-edit minimum10 policy intact",()=>{
  const h=apply(fixture());expect(getCurrentProject(updateEditorView(h,{playheadSec:1})).compositionDurationSec).toBe(8);
  const deleted=dispatchCommand(h,{type:"delete",clipIds:[id(7)]})!;expect(deleted.project.compositionDurationSec).toBe(10);
 });
});
it.each([1,2,3,4,5])("retains v%s writer/source fields on save-load with only DTO D changed",version=>{
 const p=fixture();p.playheadSec=1;
 if(version<4)p.clips=p.clips.filter(c=>c.kind!=="title");
 p.clips=p.clips.map(c=>{if(c.kind==="title")return c;const{audioFade:_f,audioGain:_g,layoutMode:_l,...plain}=c;return{...plain,...(version===2?{layoutMode:"contain" as const}:{}),...(version===3?{audioGain:.7}:{}),...(version===5?{audioFade:{inSec:.5,outSec:.5,anchorDurationSec:c.durationSec,offsetSec:0}}:{})};});
 const before=projectDocumentDraft(p);expect(before.version).toBe(version);const restored=documentToProject(parseProjectDocument(before));restored.playheadSec=1;
 const after=projectDocumentDraft(getCurrentProject(apply(restored)));expect(after.version).toBe(version);expect({...after.project,compositionDurationSec:before.project.compositionDurationSec}).toEqual(before.project);
});
it("observes owner state and intent without mutating playback; start/pending/unmount cannot adopt",()=>{
 expect(contentDurationOwnerStopped(true,false,false,false,2,2)).toBe(true);
 for(const args of [[false,false,false,false,2,2],[true,true,false,false,2,2],[true,false,true,false,2,2],[true,false,false,true,2,2],[true,false,false,false,3,2]] as const)
  expect(contentDurationOwnerStopped(args[0],args[1],args[2],args[3],args[4],args[5])).toBe(false);
});
