import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSegmentTimes, probeMedia, resolveFfmpegPath } from "./ffmpeg";
import { extractEditorSegment, repairSourceAvSegment } from "./sourceAvClock";
import { exportCompositionToFile } from "./exportComposition";
import { createEmptyProject } from "./editor/project";
import type { Asset, MediaClip } from "./editor/types";
const sources=vi.hoisted(()=>new Map<string,string>());
vi.mock("@/lib/assetResolve",()=>({resolveAssetInputPath:async(a:Asset)=>sources.get(a.id)??null}));
const real=process.env.RUN_FFMPEG_TESTS==="1";
let dir:string,input:string,zero:string,stereo:string;
const ff=(args:string[])=>execFileSync(resolveFfmpegPath(),["-v","error","-y",...args],{maxBuffer:16*1024*1024});
beforeAll(async()=>{
  if(!real)return;
  dir=await mkdtemp(path.join(tmpdir(),"positive-audio-clock-"));input=path.join(dir,"positive.mp4");zero=path.join(dir,"zero.mp4");stereo=path.join(dir,"stereo.mp4");
  const video=path.join(dir,"video.mp4");
  ff(["-f","lavfi","-i","color=red:s=64x64:r=30:d=0.5","-f","lavfi","-i","color=blue:s=64x64:r=30:d=1.5","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264","-bf","0",video]);
  for(const [out,offset] of [[input,"2"],[zero,"0"]])ff(["-i",video,"-itsoffset",offset,"-f","lavfi","-i","aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=48000:d=1.4","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac",out]);
  ff(["-i",video,"-itsoffset","2","-f","lavfi","-i","aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52)|0.02*sin(2*PI*660*t)+0.25*sin(2*PI*3000*t)*gte(t\\,0.8)*lt(t\\,0.82):s=48000:d=1.4","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac",stereo]);
},30000);
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});

async function oracle(file:string,start:number,duration:number,exactPCM=true,source=input){
  const pixels=ff(["-xerror","-i",file,"-t",String(duration),"-vf","crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]);
  expect(pixels.length).toBe(Math.ceil(duration*30)*3);
  for(let i=0;i<pixels.length/3;i++){
    const channel=start+i/30<.5-1e-9?0:2;
    expect(pixels[i*3+channel],`frame ${i}, source ${start+i/30}`).toBeGreaterThan(220);
    expect(pixels[i*3+(channel===0?2:0)]).toBeLessThan(25);
  }
  // Full decode is the reference, including AAC priming. Do not reinterpret
  // its first audible pulse as the origin or fit an offset to the output.
  const full=ff(["-i",source,"-vn","-ac","2","-ar","48000","-f","f32le","pipe:1"]);
  // Fixed oracle indices are independent of the production seek formatter.
  const first=new Map([[0,0],[.1,4800],[1/30,1600],[.499999,24000],[.5,24000],[.500001,24000]]).get(start);
  if(first===undefined)throw Error("Missing fixed sample oracle");
  const count=duration===.7?33600:duration===.6?28800:0;
  expect(count).toBeGreaterThan(0);
  const raw=path.join(dir,`ref-${start}-${duration}.pcm`),reference=path.join(dir,`ref-${start}-${duration}.m4a`);
  await writeFile(raw,full.subarray(first*8,(first+count)*8));
  ff(["-f","f32le","-ac","2","-ar","48000","-i",raw,"-af","apad","-t",String(duration),"-c:a","aac",reference]);
  const decode=(f:string)=>ff(["-i",f,"-vn","-ac","2","-ar","48000","-f","s16le","pipe:1"]);
  const actual=decode(file),expected=decode(reference);expect(actual.length).toBe(expected.length);
  if(exactPCM)expect(actual.equals(expected)).toBe(true);
  else{
    // Composition has additional lossy AAC generations. Its fixed pulse/quiet
    // windows must agree with the source-slice reference, not byte identity.
    const rms=(pcm:Buffer,a:number,b:number)=>{
      let sum=0,count=0;for(let n=Math.round(a*48000);n<Math.round(b*48000);n++){sum+=pcm.readInt16LE(n*4)**2;count++;}
      return Math.sqrt(sum/count);
    };
    const pulse=rms(actual,.526-start,.536-start),referencePulse=rms(expected,.526-start,.536-start);
    expect(pulse).toBeGreaterThan(4000);expect(Math.abs(pulse/referencePulse-1)).toBeLessThan(.05);
    expect(rms(actual,.2,.22)).toBeLessThan(1500);
  }
}

it.skipIf(!real).each([0,.1,1/30,.499999,.5,.500001])("positive audio source %s recovers missing samples and exact frame/PCM interval",async start=>{
  const old=path.join(dir,`old-${start}.mp4`),out=path.join(dir,`selected-${start}.mp4`),before=await readFile(input);
  await extractSegmentTimes({inputPath:input,outputPath:old,startSec:start,endSec:start+.7});
  expect((await probeMedia(old)).streams?.some(s=>s.codec_type==="audio")).toBe(false);
  await extractEditorSegment({inputPath:input,outputPath:out,startSec:start,endSec:start+.7});
  expect((await probeMedia(out)).streams?.map(s=>s.codec_type)).toEqual(["video","audio"]);
  await oracle(out,start,.7);expect((await readFile(input)).equals(before)).toBe(true);
},30000);

it.skipIf(!real)("stereo positive audio retains distinct channel PCM and per-channel prefix coverage",async()=>{
  const out=path.join(dir,"stereo-selected.mp4");
  await extractEditorSegment({inputPath:stereo,outputPath:out,startSec:.1,endSec:.8});
  expect((await probeMedia(out)).streams?.find(s=>s.codec_type==="audio")?.channels).toBe(2);
  await oracle(out,.1,.7,true,stereo);
},30000);

it.skipIf(!real)("actual short audio keeps old bytes even when bundled metadata includes its positive origin",async()=>{
  const short=path.join(dir,"short.mp4"),out=path.join(dir,"short-old.mp4");
  ff(["-i",input,"-i",input,"-map","0:v:0","-map","1:a:0","-c:v","copy","-af","atrim=end_sample=9600,asetpts=PTS-STARTPTS+2/TB","-c:a","aac",short]);
  await extractSegmentTimes({inputPath:short,outputPath:out,startSec:.1,endSec:.7});const before=await readFile(out);
  expect(await repairSourceAvSegment({input:short,output:out,start:.1,end:.7})).toBe(false);
  expect((await readFile(out)).equals(before)).toBe(true);
},30000);

it.skipIf(!real)("healthy legacy audio/video bytes are authoritative for positive and zero origins",async()=>{
  const out=path.join(dir,"healthy.mp4");await extractSegmentTimes({inputPath:zero,outputPath:out,startSec:.1,endSec:.7});
  const before=await readFile(out);
  for(const source of [zero,input]){
    expect(await repairSourceAvSegment({input:source,output:out,start:.1,end:.7})).toBe(false);
    expect((await readFile(out)).equals(before)).toBe(true);
  }
});

it.skipIf(!real).each([false,true])("stretch multipart=%s recovers positive audio and preserves the source DTO",async multi=>{
  const p=createEmptyProject();p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=.6;
  const a:Asset={id:"positive",kind:"video",ext:"mp4",displayName:"positive",streamUrl:"/x",sourceDurationSec:3.4,width:64,height:64};
  p.assets=[a];sources.set(a.id,input);
  const clip:MediaClip={id:"clip",trackId:p.tracks[0].id,timelineStartSec:0,durationSec:.6,transform:{x:.5,y:.5,scale:1},
    parts:multi?[{assetId:a.id,sourceInSec:.1,sourceOutSec:.4},{assetId:a.id,sourceInSec:.4,sourceOutSec:.7}]:[{assetId:a.id,sourceInSec:.1,sourceOutSec:.7}]};
  p.clips=[clip];const before=JSON.stringify(p),jobDir=path.join(dir,`stretch-${multi}`);await mkdir(jobDir);
  const out=path.join(jobDir,"out.mp4");await exportCompositionToFile({project:p,jobDir,outputPath:out});
  await oracle(out,.1,.6,false);
  expect(JSON.stringify(p)).toBe(before);expect((await readdir(jobDir)).filter(f=>f.endsWith(".mp4"))).toEqual(["out.mp4"]);
},30000);
