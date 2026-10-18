"use client";
import { useId, useMemo, useRef, useState } from 'react';
import type { EditorStore } from '@/hooks/useEditorStore';
import { audioFadeSnapshot, type AudioFadeSnapshot } from '@/lib/editor/clipAudioFade';
import { clipHasVideo } from '@/lib/editor/clipAudio';
export function ClipAudioFadeControl({editor}:{editor:EditorStore}){
  const p=editor.project;
  const snapshot=useMemo(()=>audioFadeSnapshot(p,editor.projectEpoch),[p.assets,p.clips,p.selectedClipIds,p.compositionWidth,p.compositionHeight,p.compositionDurationSec,editor.projectEpoch]);
  const blocked=editor.areEditorShortcutsBlocked();
  return <FadeDraft key={`${snapshot?.epoch}:${snapshot?.identity}:${blocked}`} editor={editor} snapshot={snapshot} blocked={blocked}/>;
}
function FadeDraft({editor,snapshot,blocked}:{editor:EditorStore;snapshot:AudioFadeSnapshot|null;blocked:boolean}){
  const clip=editor.project.clips.find(c=>c.id===snapshot?.id),fade=clip?.audioFade;
  const [draft,setDraft]=useState<[string,string]|null>(null),composing=useRef(false),hint=useId();
  const display=draft??[String(fade?.inSec??0),String(fade?.outSec??0)];
  const eligible=!!clip&&clipHasVideo(editor.project,clip);
  const original=[String(fade?.inSec??0),String(fade?.outSec??0)];
  const valid=!!clip&&!!draft&&draft.every((s,i)=>(s===original[i]||/^\d+(?:\.\d{1,3})?$/.test(s))&&Number.isFinite(Number(s)))&&Number(draft[0])+Number(draft[1])<=clip.durationSec;
  const apply=()=>{if(snapshot&&!blocked&&eligible&&valid&&!composing.current&&!editor.areEditorShortcutsBlocked()){editor.setSelectedAudioFade(snapshot,{inSec:Number(display[0]),outSec:Number(display[1])});setDraft(null);}};
  return <fieldset className="clip-fade-control" data-clip-fade onKeyDown={e=>e.stopPropagation()}>
    <legend>音声フェード</legend>
    {(['イン 秒','アウト 秒'] as const).map((label,i)=><label key={label}>{label}<input aria-label={`フェード${label}`} type="text" inputMode="decimal" maxLength={30} value={display[i]} disabled={blocked||!eligible} aria-describedby={hint} aria-invalid={draft!==null&&!valid}
      onChange={e=>{if(!editor.areEditorShortcutsBlocked())setDraft(old=>{const next:[string,string]=old?[...old]:[...display];next[i]=e.target.value;return next;});}}
      onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onKeyDown={e=>{if(e.nativeEvent.isComposing||e.keyCode===229||composing.current)return;if(e.key==='Enter'){e.preventDefault();apply();}if(e.key==='Escape'){e.preventDefault();setDraft(null);}}}/></label>)}
    <button type="button" onClick={apply} disabled={blocked||!eligible||!valid}>フェードを適用</button>
    <button type="button" disabled={blocked||!snapshot||!fade} onClick={()=>{if(snapshot&&!composing.current&&!editor.areEditorShortcutsBlocked()){editor.setSelectedAudioFade(snapshot,null);setDraft(null);}}}>フェードを解除</button>
    <p id={hint} className="muted">{draft&&!valid?'非負の秒数（小数3桁まで）を入力し、合計をクリップの長さ以内にしてください。':!snapshot?'動画を含むクリップを1つ選択してください。':!eligible?'画像のみのクリップは新規適用できません。引き継いだフェードは解除できます。':`適用すると現在の長さ ${clip!.durationSec} 秒を基準に設定します。`}</p>
    <p className="muted">音量に重ねて適用。分割・トリム後も元のフェード位置を保持し、再適用で設定し直します。素材DLは元音声です。</p>
  </fieldset>;
}
