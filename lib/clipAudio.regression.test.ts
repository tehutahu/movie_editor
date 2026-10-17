import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProject, clipFromAsset } from "./editor/project";
import { exportCompositionToFile } from "./exportComposition";
import { formatAudioGain } from "./editor/clipAudio";
import type { Asset } from "./editor/types";
import { resolveFfmpegPath } from "./ffmpeg";
const state=vi.hoisted(()=>({sources:new Map<string,string>(),argv:[] as string[][]}));
vi.mock("./assetResolve",()=>({resolveAssetInputPath:async(a:Asset)=>state.sources.get(a.id)??null}));
vi.mock("./ffmpeg",async original=>{const actual=await original<typeof import("./ffmpeg")>();return {...actual,runFfmpegCommand:async(args:string[],opts:Parameters<typeof actual.runFfmpegCommand>[1])=>{state.argv.push([...args]);return actual.runFfmpegCommand(args,opts);}};});
const real=process.env.RUN_FFMPEG_TESTS==="1";let dir:string;
const ff=(args:string[])=>execFileSync(resolveFfmpegPath(),["-v","error",...args],{timeout:30000,maxBuffer:8*1024*1024});
const pcm=(file:string)=>ff(["-i",file,"-ss","0.2","-t","0.6","-vn","-ac","1","-ar","48000","-f","f32le","pipe:1"]);
function rms(b:Buffer){let energy=0;for(let i=0;i<b.length;i+=4)energy+=b.readFloatLE(i)**2;return Math.sqrt(energy/(b.length/4));}
beforeAll(async()=>{if(real){dir=await mkdtemp(path.join(tmpdir(),"clip-audio-real-"));ff(["-y","-f","lavfi","-i","color=red:s=64x64:r=30:d=2","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2","-c:v","libx264","-c:a","aac",path.join(dir,"source.mp4")]);}});
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
it.skipIf(!real)("shared tiny/subnormal decimal literals are accepted by the actual ffmpeg without formatter quantization",()=>{
 const source=["-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=0.04"];const base=rms(ff([...source,"-f","f32le","pipe:1"]));
 for(const gain of [0,.01,.25,.33,.5,1,1e-7,1e-12,Number.MIN_VALUE]){
  const text=formatAudioGain(gain);expect(Number(text)).toBe(gain);
  const data=ff(["-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=0.04","-af",`volume=${text}`,"-f","f32le","pipe:1"]);
  expect(data.length).toBe(1920*4);if(gain>=1e-12){expect(rms(data)).toBeGreaterThan(0);expect(Math.abs(rms(data)/base/gain-1)).toBeLessThan(1e-5);}else expect(rms(data)).toBe(0);
 }
},60000);
it.skipIf(!real).each(["stretch","contain"] as const)("%s preserves exact default argv/allPCM/RGB and applies .5/.25/0 after the same winner",async mode=>{
 const job=path.join(dir,mode);await mkdir(job);const output=path.join(job,"out.mp4"),p=createEmptyProject();p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=1;
 const asset:Asset={id:randomUUID(),kind:"video",ext:"mp4",streamUrl:"/source",displayName:"source",sourceDurationSec:2,width:64,height:64};p.assets=[asset];state.sources.set(asset.id,path.join(dir,"source.mp4"));const c=clipFromAsset({asset,trackId:p.tracks[0].id,timelineStartSec:0,durationSec:1});c.transform={x:.5,y:.5,scale:2};if(mode==="contain")c.layoutMode="contain";p.clips=[c];
 state.argv=[];await exportCompositionToFile({project:p,jobDir:job,outputPath:output});const legacyArgs=state.argv,basePCM=ff(["-i",output,"-vn","-f","f32le","pipe:1"]),baseRMS=rms(pcm(output)),rgb=ff(["-i",output,"-an","-pix_fmt","rgb24","-f","framemd5","pipe:1"]);
 state.argv=[];c.audioGain=1;await exportCompositionToFile({project:p,jobDir:job,outputPath:output});const normalize=(argv:string[][])=>argv.map(args=>args.map(a=>a.replace(/\/layout-[A-Za-z0-9]{6}\//g,"/layout-PRIVATE/")));expect(normalize(state.argv)).toEqual(normalize(legacyArgs));expect(ff(["-i",output,"-vn","-f","f32le","pipe:1"])).toEqual(basePCM);expect(ff(["-i",output,"-an","-pix_fmt","rgb24","-f","framemd5","pipe:1"])).toEqual(rgb);
 for(const gain of [.5,.25,.33,.01,0]){c.audioGain=gain;state.argv=[];await exportCompositionToFile({project:p,jobDir:job,outputPath:output});const ratio=rms(pcm(output))/baseRMS;if(gain===0)expect(ratio).toBe(0);else expect(Math.abs(ratio/gain-1)).toBeLessThan(.08);const graph=state.argv.find(args=>args.includes("-filter_complex")&&args.some(a=>a.includes(`volume=${gain},adelay=`)));expect(graph).toBeDefined();expect(ff(["-i",output,"-an","-pix_fmt","rgb24","-f","framemd5","pipe:1"])).toEqual(rgb);}
},120000);
