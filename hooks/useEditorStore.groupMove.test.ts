import { beforeEach, expect, it, vi } from "vitest";
import { createEmptyProject } from "@/lib/editor/project";
import { createCommandHistory, getCurrentProject, type CommandHistory } from "@/lib/editor/commandHistory";
import { groupMoveSnapshot } from "@/lib/editor/moveClips";
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
 render();const p=createEmptyProject();p.tracks=[{id:"t",order:0}];p.clips=[1,3].map((timelineStartSec,i)=>({id:`c${i}`,trackId:"t",timelineStartSec,durationSec:1,parts:[{assetId:"a",sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:1}}));p.selectedClipIds=["c0","c1"];
 harness.cells[0].value=createCommandHistory(p);return render();
}
beforeEach(()=>{harness.cells=[];harness.cursor=0;harness.locked=false;});
it("queued zoom setter followed by stale group callback cannot commit against the old zoom",()=>{
 const editor=setup(),snapshot=groupMoveSnapshot(editor.project,editor.projectEpoch,editor.timelineZoom);
 editor.setTimelineZoom(2);editor.moveSelectedClips(snapshot,1);const current=render();
 expect(current.timelineZoom).toBe(2);expect(current.project).toBe(editor.project);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(1);
});
it("queued selection change is checked in the latest updater, not just the rendered closure",()=>{
 const editor=setup(),snapshot=groupMoveSnapshot(editor.project,editor.projectEpoch,editor.timelineZoom);
 editor.selectClip("c0",false);editor.moveSelectedClips(snapshot,1);const current=render();
 expect(current.project.clips).toBe(editor.project.clips);expect(current.project.selectedClipIds).toEqual(["c0"]);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(1);
});
it("current busy/help and persistence lock prevent stale callback adoption",()=>{
 let editor=setup(),snapshot=groupMoveSnapshot(editor.project,editor.projectEpoch,editor.timelineZoom);
 editor.setRestoreHelpBlocked(true);editor.moveSelectedClips(snapshot,1);expect(render().project).toBe(editor.project);
 editor.setRestoreHelpBlocked(false);harness.locked=true;render();editor.moveSelectedClips(snapshot,1);expect(render().project).toBe(editor.project);
 harness.locked=false;editor=render();snapshot=groupMoveSnapshot(editor.project,editor.projectEpoch,editor.timelineZoom);
 // busy is a private state cell; simulate an already-rendered busy transport.
 const busyCell=harness.cells.find(c=>c.value===null&&c.queue.length===0)!;busyCell.value="upload";render();editor.moveSelectedClips(snapshot,1);expect(render().project).toBe(editor.project);
});
it("queued playhead-only navigation remains valid and adopts the rendered delta atomically",()=>{
 const editor=setup(),snapshot=groupMoveSnapshot(editor.project,editor.projectEpoch,editor.timelineZoom);
 editor.setPlayheadSec(5);editor.moveSelectedClips(snapshot,1);const current=render();
 expect(current.project.clips.map(c=>c.timelineStartSec)).toEqual([2,4]);expect(current.project.playheadSec).toBe(5);expect((harness.cells[0].value as CommandHistory).undoStack).toHaveLength(2);
 expect(getCurrentProject(harness.cells[0].value as CommandHistory)).toBe(current.project);
});
