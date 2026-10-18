"use client";
import { useRef, useState, useId } from "react";
import type { EditorStore } from "@/hooks/useEditorStore";
import { titleEditSnapshot, validateTitleText, TITLE_TEXT_HELP, type TitleEditSnapshot } from "@/lib/editor/title";

export function TitleControl({editor}:{editor:EditorStore}){
 const snapshot=titleEditSnapshot(editor.project,editor.projectEpoch),blocked=editor.areEditorShortcutsBlocked();
 const [adding,setAdding]=useState(false);
 return <section className="title-control" aria-label="タイトル編集">
  <button type="button" disabled={blocked||adding} onClick={()=>{setAdding(true);void editor.addTitleClip().finally(()=>setAdding(false));}}>タイトル追加</button>
  {adding&&<p role="status">タイトルを準備中…</p>}
  <p className="muted">再生位置へ5秒のタイトルを追加します。文字は保存後も再編集できます。長い本文は改行すると大きく表示できます。</p>
  <TitleDraft key={`${snapshot?.epoch}:${snapshot?.identity}:${blocked}`} editor={editor} snapshot={snapshot} blocked={blocked}/>
 </section>;
}
function TitleDraft({editor,snapshot,blocked}:{editor:EditorStore;snapshot:TitleEditSnapshot|null;blocked:boolean}){
 const clip=editor.project.clips.find(c=>c.id===snapshot?.id),original=clip?.kind==="title"?clip.text:"";
 const [draft,setDraft]=useState(original),[composing,setComposing]=useState(false),[applying,setApplying]=useState(false),composition=useRef(false),hint=useId();
 let error="";try{validateTitleText(draft);}catch(e){error=e instanceof Error?e.message:String(e);}
 const disabled=blocked||!snapshot;
 return <div onKeyDown={e=>e.stopPropagation()}>
  <label>タイトル本文<textarea aria-label="タイトル本文" rows={3} value={draft} disabled={disabled||applying} aria-invalid={Boolean(snapshot&&!composing&&error)} aria-describedby={hint}
   onCompositionStart={()=>{composition.current=true;setComposing(true);}} onCompositionEnd={()=>{composition.current=false;setComposing(false);}}
   onChange={e=>{if(!editor.areEditorShortcutsBlocked())setDraft(e.target.value);}}
   onKeyDown={e=>{if(e.nativeEvent.isComposing||e.keyCode===229||composition.current)return;if(e.key==="Escape"){e.preventDefault();setDraft(original);}}}/></label>
  <button type="button" disabled={disabled||applying||composing||Boolean(error)||draft===original} onClick={()=>{if(snapshot&&!composition.current&&!editor.areEditorShortcutsBlocked()){setApplying(true);void editor.applyTitleText(snapshot,draft).finally(()=>setApplying(false));}}}>本文を適用</button>
  {applying&&<p role="status">本文を確認中…</p>}
  <p id={hint} className="muted">{!snapshot?"本文を編集するタイトルを1つ選択してください。":composing?"変換を確定してから適用してください。":error||"Enterで改行、適用で1回の編集。Escapeで入力を取り消します。"}</p>
  <p className="muted">{TITLE_TEXT_HELP}</p>
 </div>;
}
