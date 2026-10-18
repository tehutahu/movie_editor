import {afterEach,describe,it,expect,vi} from 'vitest';
import {FadePreviewOwner} from './fadePreviewOwner';
class Media extends EventTarget {
 src='';currentTime=0;volume=1;paused=true;playsInline=false;preload='';
 play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();removeAttribute(){this.src='';}
}
class Context extends EventTarget {
 static instances:Context[]=[];
 timestamp={contextTime:10,performanceTime:1000};getOutputTimestamp=vi.fn(()=>this.timestamp);
 state='suspended';currentTime=10;destination={};
 param={value:0,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()};
 source={connect:vi.fn(),disconnect:vi.fn()};gain={gain:this.param,connect:vi.fn(),disconnect:vi.fn()};
 createMediaElementSource=vi.fn(()=>this.source);createGain=vi.fn(()=>this.gain);
 resume=vi.fn(async()=>{this.state='running';});close=vi.fn(async()=>{this.state='closed';});
 constructor(){super();Context.instances.push(this);}
}
const request={key:'clip/part1',url:'/a.mp4',sourceTime:0,u:0,performanceMs:1000,gain:.5,fade:{inSec:1,outSec:1,anchorDurationSec:4,offsetSec:0}};
function setup(){
 vi.spyOn(performance,'now').mockReturnValue(1000);
 Context.instances=[];const native=new Media(),dedicated:Media[]=[];
 vi.stubGlobal('AudioContext',Context);vi.stubGlobal('location',{href:'http://localhost/',origin:'http://localhost'});
 vi.stubGlobal('document',{createElement:()=>{const m=new Media();dedicated.push(m);return m;}});
 const error=vi.fn(),owner=new FadePreviewOwner(native as unknown as HTMLVideoElement,error);
 return{native,dedicated,error,owner};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('dedicated preview fade ownership',()=>{
 it('never routes the native element, schedules once for a continuing source',async()=>{
  const {owner,native,dedicated}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();
  const context=Context.instances[0];expect(context.createMediaElementSource).toHaveBeenCalledWith(dedicated[0]);expect(context.createMediaElementSource).not.toHaveBeenCalledWith(native);
  const count=context.param.cancelScheduledValues.mock.calls.length;
  // A real src setter resolves the URL; model that resolved value here.
  dedicated[0].src='http://localhost/a.mp4';dedicated[0].currentTime=.1;
  owner.sync({...request,sourceTime:.1,u:.1},true);
  expect(context.param.cancelScheduledValues).toHaveBeenCalledTimes(count);expect(dedicated[0].volume).toBe(.5);expect(native.paused).toBe(true);
  await owner.destroy();expect(context.close).toHaveBeenCalledTimes(1);
 });
 it('allows fresh reset before first use and closes exactly one owner before retry',async()=>{
  const {owner}=setup();await owner.reset();await owner.prepare();await owner.reset();await owner.prepare();expect(Context.instances).toHaveLength(2);expect(Context.instances[0].close).toHaveBeenCalledTimes(1);await owner.destroy();
 });
 it('cancels a delayed play before native fallback and does not revive it',async()=>{
  const {owner,native,dedicated}=setup();await owner.prepare();let finish!:()=>void;
  dedicated[0].play=vi.fn(()=>new Promise<void>(resolve=>{finish=()=>{dedicated[0].paused=false;resolve();};}));
  owner.sync(request,true);owner.nativeMode();native.paused=false;finish();await Promise.resolve();
  expect(dedicated[0].paused).toBe(true);expect(native.paused).toBe(false);expect(owner.isActive).toBe(false);await owner.destroy();
 });
 it('does not let a stale dedicated play completion pause its current new winner',async()=>{
  const {owner,dedicated}=setup();await owner.prepare();const finishes:(()=>void)[]=[];
  dedicated[0].play=vi.fn(()=>new Promise<void>(resolve=>finishes.push(()=>{dedicated[0].paused=false;resolve();})));
  owner.sync(request,true);owner.sync({...request,key:'new-winner'},true);finishes[1]();await Promise.resolve();finishes[0]();await Promise.resolve();expect(dedicated[0].paused).toBe(false);expect(owner.isActive).toBe(true);await owner.destroy();
 });
 it('fails closed on context loss but keeps native return possible',async()=>{
  const {owner,native,error}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();const context=Context.instances[0];
  context.state='suspended';context.dispatchEvent(new Event('statechange'));expect(error).toHaveBeenCalledTimes(1);expect(owner.isActive).toBe(false);expect(()=>owner.sync(request,true)).toThrow();
  owner.nativeMode();native.paused=false;expect(native.paused).toBe(false);await owner.reset();await owner.prepare();expect(Context.instances).toHaveLength(2);await owner.destroy();
 });
 it('ignores a stale dedicated media error after returning to native playback',async()=>{
  const {owner,native,dedicated,error}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();owner.nativeMode();native.paused=false;
  dedicated[0].dispatchEvent(new Event('error'));expect(native.paused).toBe(false);expect(error).not.toHaveBeenCalled();expect(owner.isActive).toBe(false);await owner.destroy();
 });
 it('stops late native play after ownership changes or unmount without stopping a current native play',async()=>{
  const {owner,native}=setup();let finish!:()=>void;let current=true;
  const pending=new Promise<void>(resolve=>{finish=()=>{native.paused=false;resolve();};});owner.guardNativePlay(pending,()=>current);current=false;finish();await Promise.resolve();expect(native.paused).toBe(true);
  owner.guardNativePlay(Promise.resolve(),()=>true);native.paused=false;await Promise.resolve();expect(native.paused).toBe(false);
  await owner.destroy();native.paused=false;owner.guardNativePlay(Promise.resolve(),()=>true);await Promise.resolve();expect(native.paused).toBe(true);
 });
 it('schedules presentation-clock E and knots independently of native currentTime',async()=>{
  const {owner,dedicated}=setup();await owner.prepare();const context=Context.instances[0];context.timestamp={contextTime:9.96,performanceTime:1000};
  dedicated[0].currentTime=0;owner.sync(request,true);await Promise.resolve();
  expect(context.param.setValueAtTime).toHaveBeenLastCalledWith(expect.closeTo(.04,10),10);
  expect(context.param.linearRampToValueAtTime).toHaveBeenCalledWith(1,expect.closeTo(10.96,10));
  dedicated[0].currentTime=3;dedicated[0].dispatchEvent(new Event('playing'));
  expect(context.param.setValueAtTime).toHaveBeenLastCalledWith(expect.closeTo(.04,10),10);await owner.destroy();
 });
 it('anchors the first public advance once and then only stores DOM pairs',async()=>{
  const {owner,dedicated}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();dedicated[0].src='http://localhost/a.mp4';
  const context=Context.instances[0],before=context.param.cancelScheduledValues.mock.calls.length;context.currentTime=10.02;vi.mocked(performance.now).mockReturnValue(1020);
  owner.observeTimeline(request.key,.01,1020);expect(context.param.cancelScheduledValues).toHaveBeenCalledTimes(before+1);expect(context.param.setValueAtTime).toHaveBeenLastCalledWith(expect.closeTo(.01,10),10.02);
  context.currentTime=10.03;vi.mocked(performance.now).mockReturnValue(1030);owner.observeTimeline(request.key,.02,1030);expect(context.param.cancelScheduledValues).toHaveBeenCalledTimes(before+1);await owner.destroy();
 });
 it('uses the newest pair after delayed play instead of a closed-over media delta',async()=>{
  const {owner,dedicated}=setup();await owner.prepare();let finish!:()=>void;dedicated[0].play=vi.fn(()=>new Promise<void>(resolve=>{finish=()=>{dedicated[0].paused=false;resolve();};}));
  owner.sync(request,true);const context=Context.instances[0];context.currentTime=10.02;vi.mocked(performance.now).mockReturnValue(1020);owner.observeTimeline(request.key,.1,1020);dedicated[0].currentTime=2;finish();await Promise.resolve();expect(context.param.setValueAtTime).toHaveBeenLastCalledWith(expect.closeTo(.1,10),10.02);await owner.destroy();
 });
 it('waits silently for an initial zero timestamp and cancels readiness on pause',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const {owner,error}=setup();await owner.prepare();const context=Context.instances[0];context.timestamp={contextTime:0,performanceTime:0};owner.sync(request,true);await Promise.resolve();expect(context.param.setValueAtTime).toHaveBeenLastCalledWith(0,10);
  owner.pause();await vi.advanceTimersByTimeAsync(600);expect(error).not.toHaveBeenCalled();context.timestamp={contextTime:10,performanceTime:1000};owner.sync(request,true);await Promise.resolve();expect(owner.isActive).toBe(true);await owner.destroy();
 });
 it('bounds startup waiting and rejects missing, nonfinite, stale or regressing output clocks',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});let s=setup();await s.owner.prepare();Context.instances[0].timestamp={contextTime:0,performanceTime:0};s.owner.sync(request,true);await vi.advanceTimersByTimeAsync(600);expect(s.error).toHaveBeenCalledTimes(1);expect(s.owner.isActive).toBe(false);await s.owner.destroy();vi.restoreAllMocks();
  for(const timestamp of [{contextTime:NaN,performanceTime:1000},{contextTime:-1,performanceTime:1000},{contextTime:10,performanceTime:-1},{contextTime:10,performanceTime:800},{contextTime:10,performanceTime:1200}]){s=setup();await s.owner.prepare();Context.instances[0].timestamp=timestamp;s.owner.sync(request,true);expect(s.error).toHaveBeenCalledTimes(1);expect(s.dedicated[0].paused).toBe(true);await s.owner.destroy();vi.restoreAllMocks();}
  s=setup();await s.owner.prepare();Object.defineProperty(Context.instances[0],'getOutputTimestamp',{value:undefined});s.owner.sync(request,true);expect(s.error).toHaveBeenCalledTimes(1);await s.owner.destroy();vi.restoreAllMocks();
  s=setup();await s.owner.prepare();s.owner.sync(request,true);await Promise.resolve();Context.instances[0].timestamp={contextTime:9.9,performanceTime:999};s.dedicated[0].dispatchEvent(new Event('playing'));expect(s.error).toHaveBeenCalledTimes(1);await s.owner.destroy();
 });
 it('does not treat a lost post-valid output clock as initial startup',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const {owner,dedicated,error}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();
  Context.instances[0].timestamp={contextTime:0,performanceTime:0};dedicated[0].dispatchEvent(new Event('playing'));expect(error).toHaveBeenCalledTimes(1);expect(owner.isActive).toBe(false);await vi.advanceTimersByTimeAsync(600);expect(error).toHaveBeenCalledTimes(1);await owner.destroy();
 });
 it('cancels and silences a same-source winner/part switch',async()=>{
  const {owner,dedicated}=setup();await owner.prepare();owner.sync(request,true);await Promise.resolve();dedicated[0].src='http://localhost/a.mp4';
  const context=Context.instances[0],before=context.param.cancelScheduledValues.mock.calls.length;
  owner.sync({...request,key:'clip/part2',sourceTime:1,u:2},true);await Promise.resolve();expect(context.param.cancelScheduledValues.mock.calls.length).toBeGreaterThan(before);expect(dedicated[0].currentTime).toBe(1);owner.sync(request,false);expect(dedicated[0].paused).toBe(true);await owner.destroy();
 });
});
