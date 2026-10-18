import {describe,it,expect} from 'vitest';
import {compileAudioFade} from './audioFadeDsp';
const f={inSec:1,outSec:1,anchorDurationSec:4,offsetSec:0};
describe('fade sample compiler',()=>{
 it('leaves the zero path byte-empty without needing a sample rate',()=>{expect(compileAudioFade(undefined,NaN).filter).toBe('');expect(compileAudioFade({...f,inSec:0,outSec:0},0).filter).toBe('');});
 it('compiles complete and partial endpoint levels in the frozen order',()=>{
  expect(compileAudioFade(f,48000).filter).toBe('afade=t=in:ss=0:ns=48000:curve=tri:silence=0:unity=1,afade=t=out:ss=144000:ns=48000:curve=tri:silence=0:unity=1');
  expect(compileAudioFade({...f,offsetSec:.25},48000).events[0]).toMatchObject({ss:0,end:36000,ns:36000,silence:.25,unity:1});
  expect(compileAudioFade({...f,offsetSec:3.25},48000).events).toEqual([{type:'out',startSec:0,endSec:.75,ss:0,end:36000,ns:36000,silence:0,unity:.75}]);
 });
 it('retains the binary64 quantization at off-grid boundaries',()=>{
  const fade={inSec:.10000000000000002,outSec:.1,anchorDurationSec:.7,offsetSec:.03},result=compileAudioFade(fade,44100);
  expect(result.events.map(e=>[e.ss,e.end,e.ns])).toEqual([[0,Math.ceil((fade.inSec-fade.offsetSec)*44100),Math.ceil((fade.inSec-fade.offsetSec)*44100)],[Math.floor(((fade.anchorDurationSec-fade.outSec)-fade.offsetSec)*44100),Math.ceil((fade.anchorDurationSec-fade.offsetSec)*44100),Math.ceil((fade.anchorDurationSec-fade.offsetSec)*44100)-Math.floor(((fade.anchorDurationSec-fade.outSec)-fade.offsetSec)*44100)]]);
 });
 it('does not lose a positive sub-sample ramp or extend an expired tail',()=>{expect(compileAudioFade({...f,inSec:Number.MIN_VALUE,outSec:0},48000).events[0].ns).toBe(1);expect(compileAudioFade({...f,offsetSec:4},48000)).toEqual({constant:0,events:[],filter:'volume=0'});});
 it('rejects unsupported rates and unsafe sample events',()=>{for(const rate of [0,-1,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER])expect(()=>compileAudioFade(f,rate)).toThrow();});
});
