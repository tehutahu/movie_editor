import type { AudioFade } from './types';
import { fadeEnvelope, validateAudioFade } from './clipAudioFade';
import { outputTimelinePosition, outputContextTime, type FadeOutputTimestamp } from './fadeOutputClock';
export type FadePreviewRequest={key:string;url:string;sourceTime:number;u:number;performanceMs:number;gain:number;fade:AudioFade};
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
  private firstPublicAdvance:number|null=null;
  private outputTimer:ReturnType<typeof setTimeout>|null=null;
  private outputAttempts=0;
  private lastOutput:FadeOutputTimestamp|null=null;
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
            if(!media.paused&&context.state==='running')this.scheduleLatest();
          };
          media.addEventListener(event,listener);this.mediaListeners.push(()=>media.removeEventListener(event,listener));
        }
      }
      return this.context.resume().then(()=>{if(this.context?.state!=='running')throw Error('音声フェードを開始できません。再生ボタンから再試行してください。');});
    }catch(error){return Promise.reject(error);}
  }
  private silence(){const context=this.context;if(context&&this.gain&&context.state!=='closed'){this.gain.gain.cancelScheduledValues(context.currentTime);this.gain.gain.setValueAtTime(0,context.currentTime);}}
  private cancelOutputWait(){if(this.outputTimer!==null)clearTimeout(this.outputTimer);this.outputTimer=null;this.outputAttempts=0;}
  pause(){this.cancelOutputWait();this.firstPublicAdvance=null;this.lastOutput=null;++this.generation;this.active=null;this.pending=false;this.lastU=null;this.request=null;this.media?.pause();this.native.pause();this.silence();}
  private fail(message:string){this.fault=message;this.pause();this.onError(message);}
  /** Stop only the dedicated owner before returning to the untouched legacy path. */
  nativeMode(){if(this.active||this.pending){this.cancelOutputWait();this.firstPublicAdvance=null;this.lastOutput=null;++this.generation;this.active=null;this.pending=false;this.media?.pause();this.silence();}}
  guardNativePlay(play:Promise<void>,isCurrent:()=>boolean){
    void play.then(()=>{if(this.destroyed||!isCurrent())this.native.pause();}).catch(()=>undefined);
  }
  /** DOM-commit pair updates do not recreate steady-state automation. */
  observeTimeline(key:string,u:number,performanceMs:number){
    if(this.active!==key||!this.request)return;
    if(![u,performanceMs].every(Number.isFinite)||u<0||performanceMs<0){this.fail("音声フェードの公開時刻が不正です。");return;}
    this.request={...this.request,u,performanceMs};
    if(this.firstPublicAdvance!==null&&u>this.firstPublicAdvance){this.firstPublicAdvance=null;this.scheduleLatest();}
  }
  private scheduleLatest(){
    const request=this.request,context=this.context;
    if(!request||!context||!this.active)return;
    try{
      if(context.state!=='running'||typeof context.getOutputTimestamp!=='function')throw Error('音声フェードの出力時計を利用できません。');
      const output=context.getOutputTimestamp(),stamp={contextTime:output.contextTime??NaN,performanceTime:output.performanceTime??NaN},wall=performance.now();
      if(stamp.contextTime===0&&stamp.performanceTime===0){
        if(this.lastOutput)throw Error("音声フェードの出力時計を見失いました。");
        this.silence();
        if(this.outputTimer!==null)return;
        if(this.outputAttempts>=32)throw Error('音声フェードの出力時計の準備が完了しません。');
        const token=this.generation;this.outputAttempts++;
        this.outputTimer=setTimeout(()=>{this.outputTimer=null;if(token===this.generation)this.scheduleLatest();},16);return;
      }
      if(![stamp.contextTime,stamp.performanceTime,wall].every(Number.isFinite)||Math.abs(wall-stamp.performanceTime)>100||this.lastOutput&&(stamp.contextTime<this.lastOutput.contextTime||stamp.performanceTime<this.lastOutput.performanceTime))throw Error('音声フェードの出力時計が無効または古くなっています。');
      const now=context.currentTime,u=outputTimelinePosition(request,stamp,now),gain=this.gain!.gain,f=request.fade;
      this.lastOutput={...stamp};this.cancelOutputWait();
      gain.cancelScheduledValues(now);gain.setValueAtTime(fadeEnvelope(f,u),now);
      const boundaries=[f.inSec-f.offsetSec,(f.anchorDurationSec-f.outSec)-f.offsetSec,f.anchorDurationSec-f.offsetSec];
      for(const at of [...new Set(boundaries)].sort((a,b)=>a-b)){
        const when=outputContextTime(request,stamp,at);
        if(when>now)gain.linearRampToValueAtTime(fadeEnvelope(f,at),when);
      }
    }catch(error){this.fail(String(error));}
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
    this.pause();const token=this.generation;this.active=request.key;this.pending=true;this.lastU=request.u;this.request=request;this.firstPublicAdvance=request.u;
    if(media.src!==url.href)media.src=url.href;
    media.volume=request.gain;
    if(Math.abs(media.currentTime-request.sourceTime)>0.05)media.currentTime=request.sourceTime;
    this.scheduleLatest();
    if(token!==this.generation)return;
    void media.play().then(()=>{
      if(token!==this.generation){if(this.active===null)media.pause();return;}
      this.pending=false;
      // Delayed fulfillment uses the latest public DOM-commit pair, never media time.
      this.scheduleLatest();
    }).catch(error=>{if(token===this.generation)this.fail(`音声フェードを再生できません: ${String(error)}`);});
  }
  async reset(){
    if(this.closing)return this.closing;
    this.pause();const context=this.context,media=this.media,source=this.source,gain=this.gain;
    if(context&&this.stateListener)context.removeEventListener('statechange',this.stateListener);
    if(media&&this.mediaError)media.removeEventListener('error',this.mediaError);
    for(const remove of this.mediaListeners.splice(0))remove();
    this.lastOutput=null;this.context=null;this.media=null;this.source=null;this.gain=null;this.stateListener=null;this.mediaError=null;
    const closing=(async()=>{source?.disconnect();gain?.disconnect();if(media){media.removeAttribute('src');media.load();}if(context&&context.state!=='closed')await context.close();})();
    this.closing=closing;try{await closing;this.fault=null;}finally{if(this.closing===closing)this.closing=null;}
  }
  async destroy(){this.destroyed=true;await this.reset();}
}
