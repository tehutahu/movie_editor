import type { AudioFade } from './types';
import { normalizeAudioFade } from './clipAudioFade';
export type FadeSampleEvent={type:'in'|'out';startSec:number;endSec:number;ss:number;end:number;ns:number;silence:number;unity:number};
/** DSP arithmetic deliberately uses binary64 in the frozen operation order. */
export function compileAudioFade(value:AudioFade|undefined,sampleRate:number):{constant:0|1|null;events:FadeSampleEvent[];filter:string}{
  const fade=normalizeAudioFade(value),events:FadeSampleEvent[]=[];
  if(!fade)return{constant:1,events,filter:''};
  if(!Number.isSafeInteger(sampleRate)||sampleRate<=0)throw Error('音声フェードのサンプルレートが不正です。');
  const {inSec:I,outSec:O,anchorDurationSec:A,offsetSec:offset}=fade,clamp=(n:number)=>Math.max(0,Math.min(1,n));
  const add=(type:'in'|'out',startSec:number,endSec:number,silence:number,unity:number)=>{
    const ss=Math.floor(startSec*sampleRate),end=Math.ceil(endSec*sampleRate),ns=Math.max(1,end-ss);
    if(startSec<0||endSec<=startSec||![ss,end,ns].every(Number.isSafeInteger)||ss<0||ns<1)throw Error('音声フェードのサンプル範囲に対応していません。');
    events.push({type,startSec,endSec,ss,end,ns,silence,unity});
  };
  if(O>0&&offset>=A)return{constant:0,events,filter:'volume=0'};
  if(I>0&&offset<I)add('in',0,I-offset,clamp(offset/I),1);
  if(O>0){const end=A-offset,start=(A-O)-offset;if(end>0)add('out',Math.max(0,start),end,0,start>=0?1:clamp((A-offset)/O));}
  return{constant:events.length?null:1,events,filter:events.map(e=>`afade=t=${e.type}:ss=${e.ss}:ns=${e.ns}:curve=tri:silence=${e.silence}:unity=${e.unity}`).join(',')};
}
