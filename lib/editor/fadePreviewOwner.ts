import type { AudioFade } from './types';
import { fadeEnvelope, validateAudioFade } from './clipAudioFade';
export type FadePreviewRequest={key:string;url:string;sourceTime:number;u:number;gain:number;fade:AudioFade};
/** Native media is never routed: clear/non-fade survives a failed WebAudio owner. */
export class FadePreviewOwner {
  private context:AudioContext|null=null;
  private media:HTMLVideoElement|null=null;
  private source:MediaElementAudioSourceNode|null=null;
  private gain:GainNode|null=null;
  private generation=0;
  private active:string|null=null;
  private pending=false;
  private lastU:number|null=null;
  get isActive(){return this.active!==null||this.pending;}
  private fault:string|null=null;
  private destroyed=false;
  private closing:Promise<void>|null=null;
  private stateListener:(()=>void)|null=null;
  private mediaError:(()=>void)|null=null;
  private mediaListeners:(()=>void)[]=[];
  private request:FadePreviewRequest|null=null;
  constructor(private native:HTMLVideoElement,private onError:(message:string)=>void){}
  /** Called directly in the play gesture; never silently resumes on a frame. */
  prepare():Promise<void>{
    if(this.destroyed||this.closing)return Promise.reject(Error('音声フェードを終了処理中です。'));
    if(this.fault)return Promise.reject(Error(this.fault));
    try{
      if(!this.context){
        const context=new AudioContext(),media=document.createElement('video');
        this.context=context;this.media=media;media.playsInline=true;media.preload='auto';
        this.source=context.createMediaElementSource(media);this.gain=context.createGain();this.gain.gain.value=0;
        this.source.connect(this.gain);this.gain.connect(context.destination);
        this.stateListener=()=>{if(this.active&&context.state!=='running')this.fail('音声フェードのAudioContextが停止しました。解除または再試行してください。');};
        context.addEventListener('statechange',this.stateListener);
        this.mediaError=()=>{if(this.active||this.pending)this.fail('音声フェードの素材を再生できません。');};media.addEventListener('error',this.mediaError);
        for(const event of ['loadeddata','seeked','waiting','playing']){
          const listener=()=>{
            const request=this.request;if(!this.active||!request)return;
            if(event==='waiting'){this.silence();return;}
            if(!media.paused&&context.state==='running')this.schedule({...request,u:Math.max(0,request.u+media.currentTime-request.sourceTime)});
          };
          media.addEventListener(event,listener);this.mediaListeners.push(()=>media.removeEventListener(event,listener));
        }
      }
      return this.context.resume().then(()=>{if(this.context?.state!=='running')throw Error('音声フェードを開始できません。再生ボタンから再試行してください。');});
    }catch(error){return Promise.reject(error);}
  }
  private silence(){const context=this.context;if(context&&this.gain&&context.state!=='closed'){this.gain.gain.cancelScheduledValues(context.currentTime);this.gain.gain.setValueAtTime(0,context.currentTime);}}
  pause(){++this.generation;this.active=null;this.pending=false;this.lastU=null;this.request=null;this.media?.pause();this.native.pause();this.silence();}
  private fail(message:string){this.fault=message;this.pause();this.onError(message);}
  /** Stop only the dedicated owner before returning to the untouched legacy path. */
  nativeMode(){if(this.active||this.pending){++this.generation;this.active=null;this.pending=false;this.media?.pause();this.silence();}}
  guardNativePlay(play:Promise<void>,isCurrent:()=>boolean){
    void play.then(()=>{if(this.destroyed||!isCurrent())this.native.pause();}).catch(()=>undefined);
  }
  private schedule(request:FadePreviewRequest){
    const context=this.context!,gain=this.gain!.gain,now=context.currentTime,f=request.fade,u=request.u;
    gain.cancelScheduledValues(now);gain.setValueAtTime(fadeEnvelope(f,u),now);
    const boundaries=[f.inSec-f.offsetSec,(f.anchorDurationSec-f.outSec)-f.offsetSec,f.anchorDurationSec-f.offsetSec];
    for(const at of [...new Set(boundaries)].filter(t=>t>u).sort((a,b)=>a-b))gain.linearRampToValueAtTime(fadeEnvelope(f,at),now+at-u);
  }
  sync(request:FadePreviewRequest,playing:boolean){
    validateAudioFade(request.fade);this.native.pause();
    if(!playing){this.pause();return;}
    if(this.fault)throw Error(this.fault);
    const context=this.context,media=this.media;
    if(!context||!media||context.state!=='running')throw Error('音声フェードは再生ボタンから開始してください。');
    const url=new URL(request.url,location.href);
    if(url.origin!==location.origin)throw Error('別オリジンの音声フェードは利用できません。');
    this.request=request;
    const changed=this.active!==request.key||media.src!==url.href;
    const drift=Math.abs(media.currentTime-request.sourceTime);
    const jumped=this.lastU!==null&&Math.abs(request.u-this.lastU)>0.35;
    this.lastU=request.u;
    if(!changed&&this.pending&&!jumped)return;
    if(!changed&&!media.paused&&drift<=0.35)return;
    this.pause();const token=this.generation;this.active=request.key;this.pending=true;this.lastU=request.u;this.request=request;
    if(media.src!==url.href)media.src=url.href;
    media.volume=request.gain;
    if(Math.abs(media.currentTime-request.sourceTime)>0.05)media.currentTime=request.sourceTime;
    this.schedule(request);
    void media.play().then(()=>{
      if(token!==this.generation){if(this.active!==request.key)media.pause();return;}
      this.pending=false;
      // Schedule against the same source clock after delayed play fulfillment.
      this.schedule({...request,u:Math.max(0,request.u+media.currentTime-request.sourceTime)});
    }).catch(error=>{if(token===this.generation)this.fail(`音声フェードを再生できません: ${String(error)}`);});
  }
  async reset(){
    if(this.closing)return this.closing;
    this.pause();const context=this.context,media=this.media,source=this.source,gain=this.gain;
    if(context&&this.stateListener)context.removeEventListener('statechange',this.stateListener);
    if(media&&this.mediaError)media.removeEventListener('error',this.mediaError);
    for(const remove of this.mediaListeners.splice(0))remove();
    this.context=null;this.media=null;this.source=null;this.gain=null;this.stateListener=null;this.mediaError=null;
    const closing=(async()=>{source?.disconnect();gain?.disconnect();if(media){media.removeAttribute('src');media.load();}if(context&&context.state!=='closed')await context.close();})();
    this.closing=closing;try{await closing;this.fault=null;}finally{if(this.closing===closing)this.closing=null;}
  }
  async destroy(){this.destroyed=true;await this.reset();}
}
