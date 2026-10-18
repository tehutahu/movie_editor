import type { AudioFade, Clip, EditorProject, MediaClip } from './types';
import { exactFadeEquivalent } from './audioFadeExact';
export function validateAudioFade(value: unknown): AudioFade {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'anchorDurationSec,inSec,offsetSec,outSec') throw Error('フェードの項目が不正です。');
  const {inSec, outSec, anchorDurationSec, offsetSec} = value as AudioFade;
  if (![inSec,outSec,anchorDurationSec,offsetSec].every(n=>typeof n==='number'&&Number.isFinite(n)) || inSec<0 || outSec<0 || anchorDurationSec<=0 || anchorDurationSec>86400 || inSec+outSec>anchorDurationSec || offsetSec<0 || offsetSec>anchorDurationSec) throw Error('フェードは非負の秒数、合計は基準長以内で指定してください。');
  return {inSec:inSec===0?0:inSec,outSec:outSec===0?0:outSec,anchorDurationSec,offsetSec:offsetSec===0?0:offsetSec};
}
export function normalizeAudioFade(value: AudioFade | undefined): AudioFade | undefined {
  if (value===undefined) return undefined;
  const f=validateAudioFade(value);
  return (f.inSec===0&&f.outSec===0)||(f.outSec===0&&f.offsetSec>=f.inSec)?undefined:f;
}
export function shiftedAudioFade(value: AudioFade | undefined, delta: number): AudioFade | undefined {
  if (!value) return undefined;
  const f=validateAudioFade(value); return normalizeAudioFade({...f,offsetSec:Math.min(f.anchorDurationSec,f.offsetSec+delta)});
}
export function withAudioFade<T extends MediaClip>(clip: T, value: AudioFade | undefined): T {
  const {audioFade:_old,...rest}=clip,fade=normalizeAudioFade(value);
  return {...rest,...(fade?{audioFade:fade}:{})} as T;
}
export function fadeEnvelope(fade: AudioFade | undefined,u:number):number {
  if(!fade)return 1;const q=fade.offsetSec+u,clamp=(n:number)=>Math.max(0,Math.min(1,n));
  return (fade.inSec===0?1:clamp(q/fade.inSec))*(fade.outSec===0?1:clamp((fade.anchorDurationSec-q)/fade.outSec));
}
export function audioFadeEquivalent(a:AudioFade|undefined,b:AudioFade|undefined):boolean {return exactFadeEquivalent(normalizeAudioFade(a),normalizeAudioFade(b));}
function ulp(value:number):number{
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,Math.abs(value));
  const exponent=(view.getUint32(0)>>>20)&2047;
  return exponent===0?Number.MIN_VALUE:2**(exponent-1023-52);
}
/** Merge-only bounded arithmetic adjustment; semantic no-op remains exact. */
export function fadeMergeRoundoff(required:number,actual:number,trace:readonly number[],fade:AudioFade){
  const delta=Math.abs(actual-required),values=[...trace,actual],k=values.length+4,u=2**-53,ku=k*u;
  const positive=[fade.inSec,fade.outSec].filter(n=>n>0),minRamp=Math.min(...positive);
  const budget=Math.min(1e-9,2*values.reduce((sum,n)=>sum+ulp(n),0)),gamma=ku/(1-ku),relative=gamma*minRamp;
  const finite=values.every(Number.isFinite)&&[delta,budget,gamma,relative,minRamp].every(Number.isFinite)&&ku<1;
  return{allowed:finite&&(delta===0||(delta<=budget&&delta<=relative)),delta,budget,gamma,minRamp};
}
export function mergedAudioFade(clips:readonly MediaClip[]):{allowed:boolean;fade?:AudioFade}{
  if(!clips.length)return{allowed:false};const first=normalizeAudioFade(clips[0].audioFade);
  if(!first)return{allowed:clips.every(c=>!normalizeAudioFade(c.audioFade))};
  let total=0;const trace=[first.offsetSec];
  for(const clip of clips){
    const raw=first.offsetSec+total,offset=Math.min(first.anchorDurationSec,raw),next=normalizeAudioFade(clip.audioFade),boundary=[...trace,raw,offset];
    if(next){
      if(next.inSec!==first.inSec||next.outSec!==first.outSec||next.anchorDurationSec!==first.anchorDurationSec||!fadeMergeRoundoff(offset,next.offsetSec,boundary,first).allowed)return{allowed:false};
    }else if(first.outSec!==0||(offset<first.inSec&&!fadeMergeRoundoff(offset,first.inSec,boundary,first).allowed))return{allowed:false};
    const before=total;total+=clip.durationSec;trace.push(before,clip.durationSec,total);
  }
  return{allowed:true,fade:first};
}
export function setClipAudioFade(project:EditorProject,id:string,inSec:number,outSec:number):EditorProject|null{
  const clip=project.clips.find(c=>c.id===id);
  if(!clip||clip.kind==='title'||!clip.parts.some(p=>project.assets.some(a=>a.id===p.assetId&&a.kind==='video')))return null;
  let fade:AudioFade|undefined;
  try{fade=normalizeAudioFade({inSec,outSec,anchorDurationSec:clip.durationSec,offsetSec:0});}catch{return null;}
  if(audioFadeEquivalent(clip.audioFade,fade))return null;
  return{...project,clips:project.clips.map(c=>c.id===id?withAudioFade(clip,fade):c)};
}
export function clearClipAudioFade(project:EditorProject,id:string):EditorProject|null{
  const clip=project.clips.find(c=>c.id===id);if(!clip||clip.kind==='title'||!clip.audioFade)return null;
  return{...project,clips:project.clips.map(c=>c.id===id?withAudioFade(clip,undefined):c)};
}
export function assetHasAudioFade(project:EditorProject,assetId:string):boolean {return project.clips.some(c=>c.kind!=='title'&&!!normalizeAudioFade(c.audioFade)&&c.parts.some(p=>p.assetId===assetId));}
export function clipHasAudioFade(clip:Clip):boolean{return clip.kind!=='title'&&!!normalizeAudioFade(clip.audioFade);}
export type AudioFadeSnapshot={epoch:number;id:string;identity:string};
export function audioFadeSnapshot(project:EditorProject,epoch:number):AudioFadeSnapshot|null{
  if(project.selectedClipIds.length!==1)return null;const clip=project.clips.find(c=>c.id===project.selectedClipIds[0]);if(!clip||clip.kind==='title')return null;
  const ids=new Set(clip.parts.map(p=>p.assetId));
  return{epoch,id:clip.id,identity:JSON.stringify({clip,assets:project.assets.filter(a=>ids.has(a.id)),width:project.compositionWidth,height:project.compositionHeight,duration:project.compositionDurationSec})};
}
export function matchesAudioFadeSnapshot(project:EditorProject,epoch:number,snapshot:AudioFadeSnapshot):boolean{const current=audioFadeSnapshot(project,epoch);return !!current&&current.epoch===snapshot.epoch&&current.id===snapshot.id&&current.identity===snapshot.identity;}
