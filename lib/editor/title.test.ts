import { it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmptyProject, clipFromAsset } from "./project";
import { titleDescriptor, validateTitleText, TITLE_FONT_REVISION, titleFontHasScalar } from "./title";
import { fontCoverageRanges } from "../titleFontCmap";
import coverage from "./titleFontCoverage.json";
import { applyCommand } from "./commands";
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from "./commandHistory";
import { projectDocumentDraft, parseProjectDocument, documentToProject } from "./projectDocument";
import { parseCompositionExportPayload } from "./validateExportProject";
import { selectedClipExportRequest } from "./selectedClipExport";
import { clipHasVideo, setClipAudioGain } from "./clipAudio";
import { resolveAudioClipAtPlayhead, resolveAudioTrackForExport } from "./compositor";
import type { EditorProject, TitleClip } from "./types";

function fixture(): EditorProject {
 const p = createEmptyProject();
 p.assets = [{ id: randomUUID(), kind: "video", ext: "mp4", displayName: "video", streamUrl: "/v", sourceDurationSec: 10 }];
 p.clips = [clipFromAsset({ asset: p.assets[0], trackId: p.tracks[0].id, timelineStartSec: 0 })];
 return p;
}
function title(p = createEmptyProject()) { return applyCommand(p, { type: "addTitle", id: randomUUID(), text: "日本語\n第十二章" })!; }
it("shared plaintext validator preserves ordinary Japanese, marks, symbols and only normalizes line endings", () => {
 for (const text of ["かな漢字123", "ｶﾞ ﾊﾟ／か\u3099 は\u309a", "「」『』（ ）【】！？ー〜～…・", "0-9 # * ©®™ ♪☆★♥ ☀ ※ ○△□ ￥¥", "e\u0301", "日本語\n二行目"]) expect(validateTitleText(text)).toBe(text);
 expect(validateTitleText("一\r\n二\r三")).toBe("一\n二\n三");
});
it.each(["\\", "{", "}", "\\N", "{\\pos(0,0)}", "\uD800", "\u2060", "\u200D", "\uFE0F", "\u{E0100}", "\u200C", "\u2028", "\u2029", "\u3099", "e\n\u0301", "1\u20E3", "\u{1F3FB}", "\u{1F1EF}\u{1F1F5}", "😀", "\u2C80", "\t"])("rejects unsupported input explicitly: %j", text => {
 expect(() => validateTitleText(text)).toThrow();
});
it("bounded cmap output agrees with pinned TTC coverage and rejects malformed lengths/offsets", () => {
 const bytes = readFileSync("vendor/fonts/noto-sans-cjk/fonts/NotoSansCJK-Regular.ttc");
 expect(createHash("sha256").update(bytes).digest("hex")).toBe(TITLE_FONT_REVISION);
 expect(fontCoverageRanges(bytes)).toEqual(coverage.ranges);
 for (const cp of [0, 0x41, 0x304b, 0x3099, 0x1f600]) expect(titleFontHasScalar(cp)).toBe(coverage.ranges.some(([a,b]) => cp >= a && cp <= b));
 for (const length of [0, 4, 15, 100]) expect(() => fontCoverageRanges(bytes.subarray(0, length))).toThrow();
 const bad = Buffer.from(bytes); bad.writeUInt32BE(0xffffffff, 12); expect(() => fontCoverageRanges(bad)).toThrow();
});
it("title-only v4 roundtrips without fake asset/parts/cache; old versions reject title and writer returns minimal version", () => {
 const p = title(), doc = projectDocumentDraft(p);
 expect(doc.version).toBe(4); expect(doc.project.assets).toEqual([]);
 expect(documentToProject(parseProjectDocument(doc)).clips).toEqual(p.clips);
 expect(Object.hasOwn(doc.project.clips[0], "parts")).toBe(false);
 for (const version of [1, 2, 3]) expect(() => parseProjectDocument({ ...doc, version })).toThrow(/v4/);
 for (const extra of [{parts:[]},{audioGain:1},{layoutMode:"stretch"},{cacheUrl:"/x"},{fontPath:"/x"}]) expect(() => parseProjectDocument({...doc,project:{...doc.project,clips:[{...doc.project.clips[0],...extra}]}})).toThrow();
 expect(() => parseProjectDocument({...doc,project:{...doc.project,clips:[{...doc.project.clips[0],text:"bad{"}]}})).toThrow(/U\+007B/);
 expect(parseCompositionExportPayload({...p}).project.clips).toEqual(p.clips);
 const old = fixture(); expect(projectDocumentDraft(old).version).toBe(1);
 old.clips[0].layoutMode = "contain"; expect(projectDocumentDraft(old).version).toBe(2);
 old.clips[0].audioGain = .5; expect(projectDocumentDraft(old).version).toBe(3);
 expect(projectDocumentDraft(title(old)).version).toBe(4);
 expect(() => parseProjectDocument({...doc,version:6})).toThrow();
});
it("one title edit is one Undo/Redo, no-op/invalid keep source and Redo; split/duplicate/move/resize preserve source", () => {
 const p = title(), id = p.clips[0].id, h = createCommandHistory(p);
 const edited = dispatchCommand(h,{type:"titleText",clipId:id,text:"編集後"})!;
 expect(edited.history.undoStack).toHaveLength(2); const back = undo(edited.history)!;
 expect(getCurrentProject(back)).toBe(p); expect(redo(back)).toEqual(edited.history);
 expect(dispatchCommand(back,{type:"titleText",clipId:id,text:(p.clips[0] as TitleClip).text})).toBeNull();
 expect(() => dispatchCommand(back,{type:"titleText",clipId:id,text:"bad{"})).toThrow(); expect(back.redoStack).toHaveLength(1);
 const split = applyCommand(p,{type:"split",clipId:id,atSec:2})!;
 expect(split.clips.map(c => c.kind === "title" && c.text)).toEqual(["日本語\n第十二章","日本語\n第十二章"]);
 const dup = applyCommand(p,{type:"duplicate",clipIds:[id]})!; expect(dup.clips).toHaveLength(2);
 const resized = applyCommand(p,{type:"resize",clipId:id,newDurationSec:8})!; expect(resized.clips[0].durationSec).toBe(8); expect(Object.hasOwn(resized.clips[0],"parts")).toBe(false);
 const moved = applyCommand(split,{type:"moveMany",clipIds:split.selectedClipIds,deltaSec:3})!; expect(moved.clips.map(c => c.timelineStartSec)).toEqual([3,5]);
});
it("titles never become audio/source targets, and mixed selected DL/merge/layout are rejected atomically", () => {
 const old = fixture(), p = title(old), t = p.clips.find(c=>c.kind==="title")!;
 expect(resolveAudioClipAtPlayhead(p,0)).toEqual(resolveAudioClipAtPlayhead(old,0)); expect(resolveAudioTrackForExport(p)).toEqual(resolveAudioTrackForExport(old));
 expect(clipHasVideo(p,t)).toBe(false); expect(setClipAudioGain(p,[t.id],0)).toBeNull();
 p.selectedClipIds=p.clips.map(c=>c.id);
 expect(()=>selectedClipExportRequest(p,p.clips[0])).toThrow(/タイトル/);
 expect(applyCommand(p,{type:"merge",clipIds:p.selectedClipIds})).toBeNull();
 expect(applyCommand(p,{type:"layoutMode",clipIds:p.selectedClipIds,layoutMode:"contain"})).toBeNull();
 expect(titleDescriptor("本文").fontRevision).toBe(TITLE_FONT_REVISION);
});
it("adds at the playhead above existing video, creates an occupied front track atomically, and respects existing limits", () => {
 const old = fixture(); old.clips[0].trackId = [...old.tracks].sort((a,b)=>a.order-b.order)[0].id;
 const next = title(old), t = next.clips.find(c=>c.kind==="title")!;
 expect(t.timelineStartSec).toBe(old.playheadSec); expect(next.tracks).toHaveLength(old.tracks.length+1);
 expect(next.tracks.find(x=>x.id===t.trackId)!.order).toBeLessThan(next.tracks.find(x=>x.id===old.clips[0].trackId)!.order);
 const history = dispatchCommand(createCommandHistory(old),{type:"addTitle",id:randomUUID(),text:"見出し"})!.history;
 expect(history.undoStack).toHaveLength(2); expect(getCurrentProject(undo(history)!)).toBe(old);
 const full = {...old, tracks:Array.from({length:20},(_,i)=>({id:i===0?old.clips[0].trackId:randomUUID(),order:i}))};
 expect(applyCommand(full,{type:"addTitle",id:randomUUID(),text:"見出し"})).toBeNull();
});
