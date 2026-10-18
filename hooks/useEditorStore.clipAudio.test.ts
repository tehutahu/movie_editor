import { beforeEach, expect, it, vi } from "vitest";
import { createEmptyProject } from "@/lib/editor/project";
import { createCommandHistory, getCurrentProject, type CommandHistory } from "@/lib/editor/commandHistory";
import { clipAudioSnapshot } from "@/lib/editor/clipAudio";
const harness=vi.hoisted(()=>({cursor:0,cells:[] as {value:unknown;queue:unknown[]}[],locked:false}));
vi.mock("react",()=>({
 useState:(initial:unknown)=>{
  const i=harness.cursor++;
  if(!harness.cells[i])harness.cells[i]={value:typeof initial==="function"?initial():initial,queue:[]};
  const cell=harness.cells[i];while(cell.queue.length){const next=cell.queue.shift();cell.value=typeof next==="function"?next(cell.value):next;}
  return [cell.value,(next:unknown)=>cell.queue.push(next)];
 },
 useRef:(initial:unknown)=>{const i=harness.cursor++;if(!harness.cells[i])harness.cells[i]={value:{current:initial},queue:[]};return harness.cells[i].value;},
 useMemo:(fn:()=>unknown)=>fn(),useCallback:(fn:unknown)=>fn,useEffect:()=>{ /* Effects are outside this queued command-boundary harness. */ },
}));
vi.mock("@/hooks/useRestoreInputAudio",()=>({useRestoreInputAudio:()=>({manualEdit:vi.fn()})}));
vi.mock("@/hooks/useProjectPersistence",()=>({useProjectPersistence:()=>({locked:harness.locked})}));
import { useEditorStore } from "./useEditorStore";
function render(){harness.cursor=0;return useEditorStore();}
function setup(){
 render();const p=createEmptyProject();p.tracks=[{id:"t",order:0}];p.clips=[1,3].map((timelineStartSec,i)=>({id:`c${i}`,trackId:"t",timelineStartSec,durationSec:1,parts:[{assetId:"a",sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:1}}));p.assets=[{id:"a",kind:"video",ext:"mp4",streamUrl:"/a",displayName:"a",sourceDurationSec:4}];p.selectedClipIds=["c0","c1"];
 harness.cells[0].value=createCommandHistory(p);return render();
}
beforeEach(()=>{harness.cells=[];harness.cursor=0;harness.locked=false;});
it("queued selection change rejects a stale gain callback atomically",()=>{
 const editor=setup(),snapshot=clipAudioSnapshot(editor.project,editor.projectEpoch);editor.selectClip("c0",false);editor.setSelectedAudioGain(snapshot,.5);const current=render();expect(current.project.clips).toBe(editor.project.clips);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(1);
});
it("queued audio edit invalidates an older source/value snapshot instead of applying twice",()=>{
 const editor=setup(),snapshot=clipAudioSnapshot(editor.project,editor.projectEpoch);editor.setSelectedAudioGain(snapshot,.5);editor.setSelectedAudioGain(snapshot,.25);const current=render();expect(current.project.clips.map(c=>c.audioGain)).toEqual([.5,.5]);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(2);
});
it("same-turn help and current persistence lock block a stale audio callback",()=>{
 const editor=setup(),snapshot=clipAudioSnapshot(editor.project,editor.projectEpoch);editor.setRestoreHelpBlocked(true);editor.setSelectedAudioGain(snapshot,0);expect(render().project).toBe(editor.project);editor.setRestoreHelpBlocked(false);harness.locked=true;render();editor.setSelectedAudioGain(snapshot,0);expect(render().project).toBe(editor.project);
});
it("queued playhead-only navigation preserves target and gain apply is one command",()=>{
 const editor=setup(),snapshot=clipAudioSnapshot(editor.project,editor.projectEpoch);editor.setPlayheadSec(2);editor.setSelectedAudioGain(snapshot,.33);const current=render();expect(current.project.playheadSec).toBe(2);expect(current.project.clips.map(c=>c.audioGain)).toEqual([.33,.33]);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(2);expect(getCurrentProject(harness.cells[0].value as CommandHistory)).toBe(current.project);
});
