import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createEmptyProject, clipFromAsset } from "./project";
import { applyCommand } from "./commands";
import { createCommandHistory, dispatchCommand, undo, getCurrentProject } from "./commandHistory";
import { projectDocumentDraft, parseProjectDocument, documentToProject } from "./projectDocument";
import { parseCompositionExportPayload } from "./validateExportProject";
import { resolveContainContentRect, compositionFrameAt } from "./compositor";
function project() {
  const p = createEmptyProject();
  p.assets = [{ id: randomUUID(), kind: "video", ext: "mp4", displayName: "movie", streamUrl: "/x", sourceDurationSec: 2 }];
  p.clips = [clipFromAsset({asset:p.assets[0], trackId:p.tracks[0].id,timelineStartSec:0})];
  return p;
}
describe("opt-in contain geometry, persistence and commands", () => {
  it("uses the same even geometry for every source ratio, negative position and tiny dimension", () => {
    expect(resolveContainContentRect({x:-20,y:10,w:320,h:180},100,100)).toEqual({x:50,y:10,w:180,h:180});
    expect(resolveContainContentRect({x:0,y:0,w:320,h:180},10000,1)).toEqual({x:0,y:90,w:320,h:2});
    expect(() => resolveContainContentRect({x:0,y:0,w:320,h:180},0,100)).toThrow();
    expect([.37,.74,1.11,.1+.2].map(compositionFrameAt)).toEqual([12,23,34,9]);
  });
  it("changes a selection in one command, preserving transforms and no-op Redo", () => {
    const p = project(); p.clips.push({...structuredClone(p.clips[0]), id:randomUUID()});
    const h = createCommandHistory(p), ids = p.clips.map(c => c.id);
    const next = dispatchCommand(h,{type:"layoutMode",clipIds:ids,layoutMode:"contain"})!.history;
    expect(next.undoStack).toHaveLength(2);
    expect(getCurrentProject(next).clips.every(c => c.layoutMode === "contain")).toBe(true);
    expect(getCurrentProject(next).clips[0].transform).toEqual(p.clips[0].transform);
    const back = undo(next)!;
    expect(dispatchCommand(back,{type:"layoutMode",clipIds:ids,layoutMode:"stretch"})).toBeNull();
    expect(back.redoStack).toHaveLength(1);
  });
  it("inherits mode through split/duplicate/merge, rejecting mixed merge", () => {
    const p = project(); p.clips[0].layoutMode="contain";
    const split = applyCommand(p,{type:"split",clipId:p.clips[0].id,atSec:1})!;
    expect(split.clips.map(c=>c.layoutMode)).toEqual(["contain","contain"]);
    const joined = applyCommand(split,{type:"merge",clipIds:split.clips.map(c=>c.id)})!;
    expect(joined.clips[0].layoutMode).toBe("contain");
    expect(applyCommand(p,{type:"duplicate",clipIds:[p.clips[0].id]})!.clips.every(c=>c.layoutMode==="contain")).toBe(true);
    split.clips[1].layoutMode="stretch";
    expect(applyCommand(split,{type:"merge",clipIds:split.clips.map(c=>c.id)})).toBeNull();
  });
  it("writes contain only in v2 and writes all stretch documents identically to legacy v1", () => {
    const p = project(), original=projectDocumentDraft(p);
    p.clips[0].layoutMode="stretch";
    expect(projectDocumentDraft(p)).toEqual(original);
    p.clips[0].layoutMode="contain";
    const doc = projectDocumentDraft(p);
    expect(doc.version).toBe(2);
    expect(documentToProject(parseProjectDocument(doc)).clips[0].layoutMode).toBe("contain");
    expect(parseProjectDocument({...doc,version:2,project:{...doc.project,clips:[{...doc.project.clips[0],layoutMode:"stretch"}]}}).version).toBe(2);
  });
  it.each(["stretch","contain",null,"cover",3])("rejects every v1 mode property: %j", mode => {
    const doc=projectDocumentDraft(project());
    expect(()=>parseProjectDocument({...doc,project:{...doc.project,clips:[{...doc.project.clips[0],layoutMode:mode}]}})).toThrow();
  });
  it.each([null,"cover",3])("rejects invalid v2/API mode: %j", mode => {
    const p=project(); p.clips[0]={...p.clips[0],layoutMode:mode} as typeof p.clips[0];
    expect(()=>parseProjectDocument({...projectDocumentDraft(project()),version:2,project:{...projectDocumentDraft(project()).project,clips:p.clips}})).toThrow();
    expect(()=>parseCompositionExportPayload(p)).toThrow();
  });
  it.each([0,6,"1",null])("rejects unknown document version %j", version => expect(()=>parseProjectDocument({...projectDocumentDraft(project()),version})).toThrow());
});
