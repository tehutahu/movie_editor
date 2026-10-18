import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyProject } from "@/lib/editor/project";
import { createCommandHistory, type CommandHistory } from "@/lib/editor/commandHistory";
const harness=vi.hoisted(()=>({cursor:0,cells:[] as {value:unknown;queue:unknown[]}[],locked:false,captured:false,effect:undefined as undefined|(()=>unknown),loaded:undefined as undefined|(()=>void),keydown:undefined as undefined|((event:KeyboardEvent)=>void)}));
vi.mock("react",()=>({
 useState:(initial:unknown)=>{const i=harness.cursor++;if(!harness.cells[i])harness.cells[i]={value:typeof initial==="function"?initial():initial,queue:[]};const cell=harness.cells[i];while(cell.queue.length){const next=cell.queue.shift();cell.value=typeof next==="function"?next(cell.value):next;}return[cell.value,(next:unknown)=>cell.queue.push(next)];},
 useRef:(initial:unknown)=>{const i=harness.cursor++;if(!harness.cells[i])harness.cells[i]={value:{current:initial},queue:[]};return harness.cells[i].value;},
 useMemo:(fn:()=>unknown)=>fn(),useCallback:(fn:unknown)=>fn,
 // Only the final (global keyboard) effect is activated below; network/media
 // ownership is outside this queued-store/event harness and covered by browser QA.
 useEffect:(effect:()=>unknown)=>{harness.effect=effect;},
}));
vi.mock("@/hooks/useRestoreInputAudio",()=>({useRestoreInputAudio:()=>({manualEdit:vi.fn()})}));
vi.mock("@/hooks/useProjectPersistence",()=>({useProjectPersistence:({onLoaded}:{onLoaded:()=>void})=>{harness.loaded=onLoaded;return{locked:harness.locked};}}));
vi.mock("@/hooks/useMoveToPlayheadCapture",()=>({useMoveToPlayheadCapture:()=>({active:harness.captured,isActive:()=>harness.captured})}));
import { useEditorStore } from "./useEditorStore";
class Target {
 isContentEditable=false;
 constructor(public tagName="BUTTON",public editableParent=false){}
 closest(selector:string){return this.editableParent && selector.includes('contenteditable') ? this : null;}
}
function render(){harness.cursor=0;return useEditorStore();}
function setup(){render();const p=createEmptyProject();p.tracks=[{id:"t",order:0}];p.assets=[{id:"asset",kind:"image",ext:"png",displayName:"image",streamUrl:"/image",width:320,height:320}];p.clips=[1,3].map((timelineStartSec,i)=>({id:`c${i}`,trackId:"t",timelineStartSec,durationSec:1,parts:[{assetId:"asset",sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:1}}));p.selectedClipIds=["c1"];harness.cells[0].value=createCommandHistory(p);const e=render();expect(e.project.clips).toHaveLength(2);harness.effect!();expect(harness.keydown).toBeTypeOf("function");return e;}
function key(patch:Partial<KeyboardEvent>={}){const event={key:"a",ctrlKey:true,metaKey:false,shiftKey:false,altKey:false,repeat:false,isComposing:false,keyCode:65,defaultPrevented:false,preventCount:0,target:new Target(),preventDefault(){this.preventCount++;this.defaultPrevented=true;},...patch};harness.keydown!(event as unknown as KeyboardEvent);return event;}
beforeEach(()=>{harness.cells=[];harness.cursor=0;harness.locked=false;harness.captured=false;harness.keydown=undefined;vi.stubGlobal("Element",Target);vi.stubGlobal("HTMLElement",Target);vi.stubGlobal("window",{addEventListener:(name:string,fn:(e:KeyboardEvent)=>void)=>{if(name==="keydown")harness.keydown=fn;},removeEventListener:()=>undefined});});
afterEach(()=>vi.unstubAllGlobals());
it.each([{ctrlKey:true,metaKey:false},{ctrlKey:false,metaKey:true},{ctrlKey:true,metaKey:true}])("accepts one Ctrl/Meta chord %j with a stable existing prefix",mods=>{const e=setup(),h=harness.cells[0].value as CommandHistory;expect(key(mods).defaultPrevented).toBe(true);const n=render();expect(n.project.selectedClipIds).toEqual(["c1","c0"]);expect(n.project.clips).toBe(e.project.clips);expect((harness.cells[0].value as CommandHistory).redoStack).toBe(h.redoStack);expect((harness.cells[0].value as CommandHistory).undoStack.length).toBe(h.undoStack.length);});
it("consumes eligible repeat without queueing selection",()=>{const e=setup();expect(key({repeat:true}).defaultPrevented).toBe(true);expect(render().project).toBe(e.project);});
it.each([{isComposing:true},{keyCode:229},{defaultPrevented:true},{shiftKey:true},{altKey:true},{ctrlKey:false,metaKey:false}])("leaves excluded event %j and selection alone",patch=>{const e=setup(),event=key(patch);expect(event.defaultPrevented).toBe(Boolean(patch.defaultPrevented));expect(event.preventCount).toBe(0);expect(render().project).toBe(e.project);});
it.each([new Target("INPUT"),new Target("TEXTAREA"),new Target("SELECT"),Object.assign(new Target("SPAN"),{isContentEditable:true}),new Target("SPAN",true)])("leaves native editable target %j alone",target=>{const e=setup();expect(key({target:target as unknown as EventTarget}).defaultPrevented).toBe(false);expect(render().project).toBe(e.project);});
it("blocks pending capture/help/persistence without preventing native page selection",()=>{let e=setup();harness.captured=true;expect(key().defaultPrevented).toBe(false);expect(render().project).toBe(e.project);harness.captured=false;e.setRestoreHelpBlocked(true);expect(key().defaultPrevented).toBe(false);e.setRestoreHelpBlocked(false);harness.locked=true;e=render();expect(key().defaultPrevented).toBe(false);expect(render().project).toBe(e.project);});
it("rechecks capture and locks on adoption and rejects a crossed epoch",()=>{for(const blocker of ["capture","help","epoch"]){harness.cells=[];const e=setup();e.selectAllClips();if(blocker==="capture")harness.captured=true;if(blocker==="help")e.setRestoreHelpBlocked(true);if(blocker==="epoch")harness.loaded!();expect(render().project).toBe(e.project);harness.captured=false;harness.locked=false;}});
it("queued deletion and selection use latest membership/prefix without stale ID resurrection",()=>{const e=setup();e.deleteSelected();e.selectAllClips();const n=render();expect(n.project.clips.map(c=>c.id)).toEqual(["c0"]);expect(n.project.selectedClipIds).toEqual(["c0"]);});
it("queued addition is included, and queued selection order is adopted",()=>{const e=setup();e.addClipFromAsset(e.project.assets[0],"t",6);e.selectAllClips();const n=render(),last=n.project.clips.at(-1)!;expect(n.project.selectedClipIds).toEqual([last.id,"c0","c1"]);expect(n.project.clips).toHaveLength(3);});
it("latest queued prefix is retained and a second all-selected invocation is identity noop",()=>{const e=setup();e.selectClip("c0",false);e.selectAllClips();e.selectAllClips();const n=render();expect(n.project.selectedClipIds).toEqual(["c0","c1"]);const h=harness.cells[0].value;n.selectAllClips();render();expect(harness.cells[0].value).toBe(h);});
