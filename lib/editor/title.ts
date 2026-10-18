import coverage from "./titleFontCoverage.json";
import type { Clip, EditorProject, TitleClip } from "./types";
import { clipFitsOnTrackAt } from "./clipOps";

export const TITLE_FONT_ID = "noto-sans-cjk-jp-regular";
export const TITLE_FONT_REVISION = coverage.fontHash;
export const TITLE_STYLE_REVISION = "white-outline-centered-v1";
export const TITLE_TEXT_HELP = "半角のバックスラッシュ・波括弧、絵文字の修飾・異体字指定など未対応の文字列は使用できません。";
let segmenter: Intl.Segmenter | undefined;
function label(c: string) { return `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`; }
export function titleFontHasScalar(cp: number): boolean {
  let l = 0, h = coverage.ranges.length - 1;
  while (l <= h) { const m = (l + h) >> 1, [a, b] = coverage.ranges[m]; if (cp < a) h = m - 1; else if (cp > b) l = m + 1; else return true; }
  return false;
}
/** Shared browser/API/import/save/export validation. Never substitutes glyphs. */
export function validateTitleText(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("タイトル本文が必要です。");
  const text = raw.replace(/\r\n?/g, "\n");
  const reserved = text.match(/[\\{}]/u)?.[0];
  if (reserved) throw new Error(`タイトルでは半角のバックスラッシュと波括弧は使用できません（${label(reserved)}）。`);
  if (!text.trim()) throw new Error("タイトル本文を入力してください。");
  if (new TextEncoder().encode(text).length > 4096 || [...text].length > 1024 || text.split("\n").length > 8) throw new Error("タイトルは4096 bytes・1024文字・8行以内で入力してください。");
  if(typeof Intl.Segmenter!=="function")throw new Error("この環境ではタイトル文字列の検証を利用できません。");
  segmenter??=new Intl.Segmenter("ja", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) if (/^\p{M}/u.test(segment)) throw new Error(`結合文字には直前の基底文字が必要です（${label(segment)}）。`);
  for (const c of text) {
    if (c === "\n") continue;
    const cp = c.codePointAt(0)!;
    if (/[\p{Cs}\p{Co}\p{Cn}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Regional_Indicator}\p{Emoji_Modifier}]/u.test(c) || cp === 0x20e3 || cp === 0x2028 || cp === 0x2029) throw new Error(`タイトルで未対応の文字・文字列です（${label(c)}）。`);
    if (!titleFontHasScalar(cp)) throw new Error(`固定fontに収録されていない文字です（${label(c)}）。`);
  }
  return text;
}
export function validateTitleDescriptor(value: Record<string, unknown>): Pick<TitleClip, "text" | "fontId" | "fontRevision" | "styleRevision"> {
  if (value.fontId !== TITLE_FONT_ID || value.fontRevision !== TITLE_FONT_REVISION || value.styleRevision !== TITLE_STYLE_REVISION) throw new Error("未対応のタイトルfont・revisionです。");
  return { text: validateTitleText(value.text), fontId: TITLE_FONT_ID, fontRevision: TITLE_FONT_REVISION, styleRevision: TITLE_STYLE_REVISION };
}
export function titleDescriptor(text: string) { return validateTitleDescriptor({ text, fontId: TITLE_FONT_ID, fontRevision: TITLE_FONT_REVISION, styleRevision: TITLE_STYLE_REVISION }); }
export function addTitle(project: EditorProject, id: string, text: string): EditorProject | null {
  if (project.clips.length >= 100 || !project.tracks.length) return null;
  const descriptor = titleDescriptor(text), durationSec = 5, start = project.playheadSec;
  if (!Number.isFinite(start) || start < 0) return null;
  if (start + durationSec > 86400) return null;
  const front = [...project.tracks].sort((a,b)=>a.order-b.order)[0];
  let tracks = project.tracks, trackId = front.id;
  if (!clipFitsOnTrackAt(project.clips, front.id, start, durationSec)) {
    if (tracks.length >= 20) return null;
    trackId = `${id}-track`;
    tracks = [{ id: trackId, order: 0 }, ...tracks.map(t=>({ ...t, order:t.order+1 }))];
  }
  const clip: TitleClip = { kind: "title", id, trackId, timelineStartSec: start, durationSec, transform: { x: 0.5, y: 0.5, scale: 1 }, ...descriptor };
  return { ...project, tracks, clips: [...project.clips, clip], selectedClipIds: [id], compositionDurationSec: Math.max(project.compositionDurationSec, start + durationSec) };
}
export function updateTitle(project: EditorProject, id: string, text: string): EditorProject | null {
  const descriptor = titleDescriptor(text), clip = project.clips.find(c => c.id === id);
  if (clip?.kind !== "title" || clip.text === descriptor.text) return null;
  return { ...project, clips: project.clips.map((c): Clip => c.id === id ? { ...clip, ...descriptor } : c) };
}
export type TitleEditSnapshot = { epoch:number; id:string; identity:string };
export function titleEditSnapshot(project:EditorProject,epoch:number):TitleEditSnapshot|null{
 if(project.selectedClipIds.length!==1)return null;const clip=project.clips.find(c=>c.id===project.selectedClipIds[0]);if(clip?.kind!=="title")return null;
 return{epoch,id:clip.id,identity:JSON.stringify({clip,width:project.compositionWidth,height:project.compositionHeight})};
}
export function matchesTitleEditSnapshot(project:EditorProject,epoch:number,snapshot:TitleEditSnapshot){const now=titleEditSnapshot(project,epoch);return now?.epoch===snapshot.epoch&&now.id===snapshot.id&&now.identity===snapshot.identity;}
