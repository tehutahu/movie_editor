import { expect, it } from "vitest";
import { storageReferences } from "./storageReferences";
import { createEmptyProject } from "./project";
import type { Asset } from "./types";
it("protects library-only, Undo-only, Redo-only and restored-job references", () => {
 const asset: Asset = { id:"library",kind:"video",ext:"mp4",displayName:"v",streamUrl:"/v" };
 const undo = { ...createEmptyProject(), assets: [{ ...asset,id:"undo",sourceJobId:"restored" }] };
 const redo = { ...createEmptyProject(), assets: [{ ...asset,id:"redo" }] };
 const current = { ...createEmptyProject(), assets:[asset] };
 expect(storageReferences({ undoStack:[undo,current],redoStack:[redo] }).sort()).toEqual(["library","redo","restored","undo"]);
});
