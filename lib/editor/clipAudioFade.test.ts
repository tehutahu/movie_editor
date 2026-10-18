import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyProject, clipFromAsset } from './project';
import type { AudioFade, MediaClip, EditorProject } from './types';
import { audioFadeSnapshot, matchesAudioFadeSnapshot, audioFadeEquivalent, validateAudioFade, normalizeAudioFade, fadeEnvelope, setClipAudioFade, clearClipAudioFade, assetHasAudioFade, mergedAudioFade, fadeMergeRoundoff } from './clipAudioFade';
import { splitClipAtPlayhead, mergeClips, resizeClip, duplicateClips } from './clipOps';
import { trimClipStart } from './trimClipStart';
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from './commandHistory';
import { parseProjectDocument, projectDocumentDraft, documentToProject } from './projectDocument';
import { parseCompositionExportPayload } from './validateExportProject';
import { titleDescriptor } from './title';
import { applySpeedRestoreToProject } from './applySpeedRestore';
import { selectedClipExportRequest } from './selectedClipExport';
const f=(I=1,O=1,A=4,offset=0):AudioFade=>({inSec:I,outSec:O,anchorDurationSec:A,offsetSec:offset});
function fixture(image=false):EditorProject & {clips:MediaClip[]} {
 const p=createEmptyProject();const a={id:randomUUID(),kind:image?'image' as const:'video' as const,ext:image?'png':'mp4',displayName:'source',sourceDurationSec:8,width:320,height:240,streamUrl:'/source'};
 p.assets=[a];const c=clipFromAsset({asset:a,trackId:p.tracks[0].id,timelineStartSec:0});c.parts=[{assetId:a.id,sourceInSec:0,sourceOutSec:4}];c.durationSec=4;p.clips=[c];p.compositionDurationSec=20;p.selectedClipIds=[c.id];return p as EditorProject & {clips:MediaClip[]};
}
describe('audio fade boundaries and complete-future semantic equality',()=>{
 it.each([null,[],{},f(-1),f(1,-1),f(3,2),f(1,1,0),f(1,1,86401),f(1,1,4,5),{...f(),inSec:'1'},{...f(),inSec:NaN},{...f(),outSec:Infinity},{...f(),extra:0}])('rejects malformed descriptor %j',value=>expect(()=>validateAudioFade(value)).toThrow());
 it('accepts endpoints, positive subnormal, max anchor and strips only a future unit envelope',()=>{
  expect(validateAudioFade(f(2,2))).toEqual(f(2,2));expect(validateAudioFade(f(Number.MIN_VALUE,0))).toEqual(f(Number.MIN_VALUE,0));expect(validateAudioFade(f(1,1,86400,86400))).toEqual(f(1,1,86400,86400));
  expect(normalizeAudioFade(f(0,0))).toBeUndefined();expect(normalizeAudioFade(f(1,0,4,1))).toBeUndefined();expect(normalizeAudioFade(f(1,1,4,1))).toEqual(f(1,1,4,1));
 });
 it('compares exact future ramps without swallowing tiny intervals or changes behind gain zero',()=>{
  expect(audioFadeEquivalent(f(1,0,10),f(1,0,5))).toBe(true);expect(audioFadeEquivalent(f(1,1,10),f(1,1,5))).toBe(false);
  expect(audioFadeEquivalent(f(Number.MIN_VALUE,0),undefined)).toBe(false);expect(audioFadeEquivalent(f(0,Number.MIN_VALUE,1),f(0,2*Number.MIN_VALUE,1))).toBe(false);
  const p=fixture();p.clips[0].audioGain=0;p.clips[0].audioFade=f();expect(setClipAudioFade(p,p.clips[0].id,.5,.5)).not.toBeNull();
 });
 it('uses timeline local time, not source part offsets',()=>{expect([0,.25,1,2,3,3.5,4].map(u=>fadeEnvelope(f(),u))).toEqual([0,.25,1,1,1,.5,0]);expect(fadeEnvelope(f(1,1,4,.5),0)).toBe(.5);});
});
describe('atomic command and media operations',()=>{
 it('applies and clears in one Undo each; same meaning and invalid commands preserve Redo',()=>{
  const p=fixture(),id=p.clips[0].id;const start=createCommandHistory(p),applied=dispatchCommand(start,{type:'audioFade',clipId:id,inSec:1,outSec:1})!;
  expect((getCurrentProject(applied.history).clips[0] as MediaClip).audioFade).toEqual(f());const undone=undo(applied.history)!;expect(undone.redoStack).toHaveLength(1);
  expect(dispatchCommand(undone,{type:'audioFade',clipId:id,inSec:0,outSec:0})).toBeNull();expect(dispatchCommand(undone,{type:'audioFade',clipId:id,inSec:3,outSec:3})).toBeNull();
  const restored=redo(undone)!;const cleared=dispatchCommand(restored,{type:'clearAudioFade',clipId:id})!;expect((getCurrentProject(cleared.history).clips[0] as MediaClip).audioFade).toBeUndefined();expect(getCurrentProject(undo(cleared.history)!).clips).toEqual(getCurrentProject(restored).clips);
 });
 it.each([[1,0,.5],[1,0,1],[1,0,1.5],[0,1,1.5],[1,1,1.5]])('split/rejoin retains the envelope, including stripped unit tails I%f O%f cut%f',(I,O,cut)=>{
  const p=fixture();p.clips[0].audioFade=f(I,O);const split=splitClipAtPlayhead(p,p.clips[0].id,cut)!;const right=split.clips[1] as MediaClip;
  for(const u of [0,.125,.5,1])expect(fadeEnvelope(right.audioFade,u)).toBe(fadeEnvelope(f(I,O),cut+u));
  if(O===0&&cut>=I)expect(right.audioFade).toBeUndefined();const merged=mergeClips(split,split.clips.map(c=>c.id))!;expect((merged.clips[0] as MediaClip).audioFade).toEqual(f(I,O));
 });
 it('rejoins repeated decimal splits in alternate grouping orders with bounded merge-only roundoff',()=>{
  const p=fixture();p.clips[0].audioFade=f(1,1,4,.1);
  const first=splitClipAtPlayhead(p,p.clips[0].id,.2)!,all=splitClipAtPlayhead(first,first.clips[1].id,.5)!;
  expect(all.clips.map(c=>c.audioFade?.offsetSec)).toEqual([.1,.30000000000000004,.6000000000000001]);
  expect(mergeClips(all,all.clips.map(c=>c.id))).not.toBeNull();
  for(const indexes of [[0,1],[1,2]]){const group=mergeClips(all,indexes.map(i=>all.clips[i].id))!;expect(mergeClips(group,group.clips.map(c=>c.id))).not.toBeNull();}
  const trimmed=trimClipStart(p,p.clips[0].id,.1)!;const sliced=splitClipAtPlayhead(trimmed,p.clips[0].id,.3)!;expect(mergeClips(sliced,sliced.clips.map(c=>c.id))).not.toBeNull();
  const altered=structuredClone(all);altered.clips[2].audioFade!.offsetSec+=1e-6;expect(mergeClips(altered,altered.clips.map(c=>c.id))).toBeNull();
  const exactDelta=.6000000000000001-.6;
  const diagnostic=fadeMergeRoundoff(.6,.6000000000000001,[.1,0,.2,.2,.2,.3,.5,.6,.6],f());expect(diagnostic.allowed).toBe(true);expect(diagnostic.delta).toBe(exactDelta);expect(diagnostic.delta*48000).toBe(5.329070518200751e-12);
  // The same offset ULP is a material phase change for a tiny positive ramp.
  expect(fadeMergeRoundoff(.6,.6000000000000001,[.1,.5,.6,.6],f(1e-20,0)).allowed).toBe(false);
  expect(fadeMergeRoundoff(0,Number.MIN_VALUE,[0],f(Number.MIN_VALUE,0)).allowed).toBe(false);
  expect(fadeMergeRoundoff(0,1,[Infinity],f()).allowed).toBe(false);expect(fadeMergeRoundoff(0,0,[Infinity],f()).allowed).toBe(false);
  expect(audioFadeEquivalent(f(1,1,4,.6),f(1,1,4,.6000000000000001))).toBe(false);
 });
 it('permits only bounded unit-tail boundary rounding, not a remaining plateau or active phase',()=>{
  const p=fixture();p.clips[0].audioFade=f(1,0);const c=p.clips[0];
  expect(mergedAudioFade([{...c,durationSec:.9999999999999999},{...c,audioFade:undefined}]).allowed).toBe(true);
  expect(mergedAudioFade([{...c,durationSec:.99},{...c,audioFade:undefined}]).allowed).toBe(false);
  expect(mergedAudioFade([{...c,audioFade:f(1,1),durationSec:2},{...c,audioFade:undefined}]).allowed).toBe(false);
 });
 it('keeps constant zero after the old anchor and supports repeated partial trims',()=>{
  const p=fixture();p.clips[0].audioFade=f();const trimmed=trimClipStart(p,p.clips[0].id,.25)!;expect((trimmed.clips[0] as MediaClip).audioFade).toEqual(f(1,1,4,.25));
  const again=trimClipStart(trimmed,p.clips[0].id,.5)!;expect((again.clips[0] as MediaClip).audioFade).toEqual(f(1,1,4,.5));
  const extended=resizeClip(p,p.clips[0].id,6,p.assets)!;expect((extended.clips[0] as MediaClip).audioFade).toEqual(f());expect(fadeEnvelope((extended.clips[0] as MediaClip).audioFade,5)).toBe(0);
  const split=splitClipAtPlayhead(extended,p.clips[0].id,5)!;expect((split.clips[1] as MediaClip).audioFade?.offsetSec).toBe(4);expect(mergeClips(split,split.clips.map(c=>c.id))).not.toBeNull();
 });
 it('duplicate preserves metadata, and current-end reapply with identical in-only meaning is noop',()=>{
  const p=fixture();p.clips[0].audioFade=f(1,0);const shorter=resizeClip(p,p.clips[0].id,2,p.assets)!;expect(setClipAudioFade(shorter,p.clips[0].id,1,0)).toBeNull();
  expect((duplicateClips(p,[p.clips[0].id])!.clips[1] as MediaClip).audioFade).toEqual(f(1,0));
 });
 it('rejects unrelated anchors atomically and allows pure-image inherited metadata clear',()=>{
  const p=fixture();p.clips[0].audioFade=f();const split=splitClipAtPlayhead(p,p.clips[0].id,2)!;(split.clips[1] as MediaClip).audioFade=f(1,1,4,.5);expect(mergeClips(split,split.clips.map(c=>c.id))).toBeNull();
  const image=fixture(true);image.clips[0].audioFade=f();expect(setClipAudioFade(image,image.clips[0].id,.5,.5)).toBeNull();const clear=clearClipAudioFade(image,image.clips[0].id)!;expect(clear.clips[0]).toEqual({...image.clips[0],audioFade:undefined});expect(Object.hasOwn(clear.clips[0],'audioFade')).toBe(false);expect(clearClipAudioFade(clear,image.clips[0].id)).toBeNull();
  expect(mergedAudioFade([{...p.clips[0],audioFade:undefined},{...p.clips[0],audioFade:f()}]).allowed).toBe(false);
 });
 it('rejects stale epoch/selection/source/gain/parts/geometry while view-only seek keeps the snapshot',()=>{
  const p=fixture(),snapshot=audioFadeSnapshot(p,1)!;expect(matchesAudioFadeSnapshot({...p,playheadSec:2},1,snapshot)).toBe(true);
  expect(matchesAudioFadeSnapshot(p,2,snapshot)).toBe(false);expect(matchesAudioFadeSnapshot({...p,selectedClipIds:[]},1,snapshot)).toBe(false);
  for(const change of [(q:typeof p)=>q.assets[0].streamUrl='/new', (q:typeof p)=>q.clips[0].audioGain=.25,(q:typeof p)=>q.clips[0].parts[0].sourceInSec=.25,(q:typeof p)=>q.clips[0].transform.scale=2]){const q=structuredClone(p);change(q);expect(matchesAudioFadeSnapshot(q,1,snapshot)).toBe(false);}
 });
 it('blocks restore for any affected reference, even when the selected clip has no fade',()=>{
  const p=fixture();p.clips.push({...p.clips[0],id:randomUUID(),timelineStartSec:5,audioFade:f()});expect(assetHasAudioFade(p,p.assets[0].id)).toBe(true);
  expect(()=>applySpeedRestoreToProject(p,{assetId:p.assets[0].id,jobId:randomUUID(),speedFactor:2,restoredDurationSec:16,restoredWidth:320,restoredHeight:240})).toThrow(/フェード/);
 });
});
describe('strict v5 and existing document/source contracts',()=>{
 it('roundtrips v5 source, returns minimal v1-v4 after clear and rejects fade presence in older versions',()=>{
  const p=fixture();p.clips[0].audioFade=f();let doc=projectDocumentDraft(p);expect(doc.version).toBe(5);expect(documentToProject(parseProjectDocument(doc)).clips).toEqual(p.clips);
  for(const version of [1,2,3,4])for(const audioFade of [f(),f(0,0)])expect(()=>parseProjectDocument({...doc,version,project:{...doc.project,clips:[{...doc.project.clips[0],audioFade}]}})).toThrow(/v5/);
  expect(()=>parseProjectDocument({...doc,project:{...doc.project,clips:[{...doc.project.clips[0],unknownFade:1}]}})).toThrow(/未知/);
  const clear=clearClipAudioFade(p,p.clips[0].id)!;expect(projectDocumentDraft(clear).version).toBe(1);(clear.clips[0] as MediaClip).layoutMode='contain';expect(projectDocumentDraft(clear).version).toBe(2);(clear.clips[0] as MediaClip).audioGain=.5;expect(projectDocumentDraft(clear).version).toBe(3);
  clear.clips.push({kind:'title',id:randomUUID(),trackId:clear.tracks[0].id,timelineStartSec:6,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor('題')});expect(projectDocumentDraft(clear).version).toBe(4);
  (clear.clips[0] as MediaClip).audioFade=f();doc=projectDocumentDraft(clear);expect(doc.version).toBe(5);expect(parseProjectDocument(doc).project.clips).toHaveLength(2);expect(()=>parseProjectDocument({...doc,version:6})).toThrow();
 });
 it('rejects malformed fade/API/title fields rather than silently dropping them',()=>{
  const p=fixture();for(const audioFade of [null,[],{...f(),extra:1},{...f(),inSec:'1'}])expect(()=>parseCompositionExportPayload({...p,clips:[{...p.clips[0],audioFade}]})).toThrow();
  const title={kind:'title',id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:0,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor('題'),audioFade:f(0,0)};
  expect(()=>parseCompositionExportPayload({...p,clips:[title]})).toThrow();
 });
 it('keeps active fade in composition DTO but strips both fade/gain from selected multipart source download',()=>{
  const p=fixture();p.clips[0].audioFade=f();p.clips[0].audioGain=.25;p.clips[0].parts=[{assetId:p.assets[0].id,sourceInSec:0,sourceOutSec:1},{assetId:p.assets[0].id,sourceInSec:1,sourceOutSec:4}];
  expect((parseCompositionExportPayload(p).project.clips[0] as MediaClip).audioFade).toEqual(f());const source=selectedClipExportRequest(p,p.clips[0]);expect(JSON.stringify(source)).not.toMatch(/audioFade|audioGain/);expect(p.clips[0].audioFade).toEqual(f());
 });
});
