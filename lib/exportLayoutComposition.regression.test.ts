import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProject } from "./editor/project";
import { exportCompositionToFile } from "./exportComposition";
import { inspectMediaLayout } from "./mediaLayout";
import type { Asset, Clip } from "./editor/types";
const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => sources.get(a.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string;
function ff(args: string[]) { return execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v","error","-y",...args], {maxBuffer:64*1024*1024}); }
beforeAll(async()=>{if(real) dir=await mkdtemp(path.join(tmpdir(),"contain-regression-"));});
afterAll(async()=>{if(dir) await rm(dir,{recursive:true,force:true});});
it.skipIf(!real)("real contain product pipeline retains transparent margins and last frame33, audio tail, PTS and clean temp",async()=>{
  const red=path.join(dir,"red.mp4"), blue=path.join(dir,"blue.mp4");
  ff(["-f","lavfi","-i","color=red:s=160x320:r=24:d=2","-f","lavfi","-i","sine=frequency=440:duration=2","-c:v","libx264","-c:a","aac",red]);
  ff(["-f","lavfi","-i","color=blue:s=320x320:r=30:d=2","-c:v","libx264",blue]);
  const p=createEmptyProject(); p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=1.11;
  const assets=[red,blue].map(file=>({id:randomUUID(),kind:"video" as const,ext:"mp4",displayName:file,streamUrl:"/x",sourceDurationSec:2}));
  p.assets=assets; assets.forEach((a,i)=>sources.set(a.id,[red,blue][i]));
  const c:Clip={id:randomUUID(),trackId:p.tracks.find(t=>t.order===0)!.id,timelineStartSec:0,durationSec:1.11,layoutMode:"contain",transform:{x:.5,y:.5,scale:2},parts:Array.from({length:3},()=>({assetId:assets[0].id,sourceInSec:.13,sourceOutSec:.5}))};
  p.clips=[{...c,id:randomUUID(),trackId:p.tracks.find(t=>t.order===1)!.id,layoutMode:undefined,parts:[{assetId:assets[1].id,sourceInSec:0,sourceOutSec:1.11}]},c];
  const job=path.join(dir,"job");await mkdir(job);const out=path.join(job,"out.mp4");
  await exportCompositionToFile({project:p,jobDir:job,outputPath:out});
  const raw=ff(["-i",out,"-an","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  const stride=320*320*3;expect(raw.length/stride).toBe(34);
  for(const frame of [0,10,11,12,21,22,23,32,33]){
    const center=frame*stride+(160*320+160)*3, side=frame*stride+(160*320+20)*3;
    expect(raw[center]).toBeGreaterThan(220);expect(raw[center+2]).toBeLessThan(20);
    expect(raw[side+2]).toBeGreaterThan(220);expect(raw[side]).toBeLessThan(20);
  }
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH??"/usr/bin/ffprobe",["-v","error","-show_streams","-show_frames","-of","json",out],{maxBuffer:4*1024*1024}).toString());
  expect(probe.streams[0].pix_fmt).toBe("yuv420p");expect(probe.streams[0].color_range).toBe("tv");
  const frames=probe.frames.filter((f:{media_type:string})=>f.media_type==="video");
  frames.forEach((f:{pts_time:string},i:number)=>expect(Number(f.pts_time)).toBeCloseTo(i/30,5));
  const pcm=ff(["-ss","1.04","-i",out,"-t","0.06","-vn","-ac","1","-ar","48000","-f","s16le","pipe:1"]);let energy=0;
  for(let i=0;i+1<pcm.length;i+=2) energy+=pcm.readInt16LE(i)**2;
  expect(pcm.length).toBeGreaterThan(4000);expect(Math.sqrt(energy/(pcm.length/2))).toBeGreaterThan(500);
  expect(await readdir(job)).toEqual(["out.mp4"]);
  sources.delete(assets[0].id);
  const failed=path.join(dir,"failed");await mkdir(failed);
  await expect(exportCompositionToFile({project:p,jobDir:failed,outputPath:path.join(failed,"out.mp4")})).rejects.toThrow(/素材/);
  expect(await readdir(failed)).toEqual([]);
},120000);
it.skipIf(!real)("rejects non-square media in actual-file eligibility without changing the stretch contract",async()=>{
 const file=path.join(dir,"sar.mp4");ff(["-f","lavfi","-i","color=red:s=320x240:d=0.1","-vf","setsar=2/1","-c:v","libx264",file]);
 await expect(inspectMediaLayout(file,"video","mp4")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_SAR"});
});
it.skipIf(!real)("moving CFR24/30/60 contain samples the same hold-last source frame as Canvas at every active output frame",async()=>{
 for(const fps of [24,30,60]){
  const source=path.join(dir,`barcode${fps}.mp4`),width=224,height=64,N=fps*2, pixels=Buffer.alloc(width*height*3*N);
  for(let n=0;n<N;n++) for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const value=n&(1<<Math.floor(x/32))?224:32,offset=((n*height+y)*width+x)*3;pixels.fill(value,offset,offset+3);
  }
  execFileSync(process.env.FFMPEG_PATH??"/usr/bin/ffmpeg",["-v","error","-y","-f","rawvideo","-pix_fmt","rgb24","-s",`${width}x${height}`,"-r",String(fps),"-i","pipe:0","-c:v","libx264","-pix_fmt","yuv420p",source],{input:pixels});
  const p=createEmptyProject(),id=randomUUID();sources.set(id,source);
  p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=1.4;
  p.assets=[{id,kind:"video",ext:"mp4",displayName:"moving",streamUrl:"/x",sourceDurationSec:2}];
  p.clips=[{id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:.17,durationSec:1.11,layoutMode:"contain",transform:{x:.5,y:.5,scale:2},parts:[{assetId:id,sourceInSec:.13,sourceOutSec:1.24}]}];
  const job=path.join(dir,`moving${fps}`);await mkdir(job);const out=path.join(job,"out.mp4");
  await exportCompositionToFile({project:p,jobDir:job,outputPath:out});
  const raw=ff(["-i",out,"-an","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]),stride=320*320*3;
  expect(raw.length/stride).toBe(42);
  for(let f=6;f<=38;f++){
    let value=0;for(let bit=0;bit<7;bit++) if(raw[f*stride+(160*320+Math.floor((16+32*bit)*320/224))*3]>128)value|=1<<bit;
    expect(value,`${fps}fps output frame${f}`).toBe(Math.floor((.13+f/30-.17)*fps+1e-7));
  }
 }
},120000);
it.skipIf(!real)("sourceOut is exclusive before fps/clone, never borrowing forbidden future frames",async()=>{
 const source=path.join(dir,"sentinel.mp4");
 ff(["-f","lavfi","-i","color=red:s=160x320:r=30:d=0.5","-f","lavfi","-i","color=magenta:s=160x320:r=30:d=0.5","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264",source]);
 const p=createEmptyProject(),id=randomUUID();sources.set(id,source);
 p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=.54;
 p.assets=[{id,kind:"video",ext:"mp4",displayName:"sentinel",streamUrl:"/x",sourceDurationSec:1}];
 p.clips=[{id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:.17,durationSec:.37,layoutMode:"contain",transform:{x:.5,y:.5,scale:2},parts:[{assetId:id,sourceInSec:.13,sourceOutSec:.5}]}];
 const job=path.join(dir,"sentinel");await mkdir(job);const out=path.join(job,"out.mp4");
 await exportCompositionToFile({project:p,jobDir:job,outputPath:out});
 const raw=ff(["-i",out,"-an","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]),stride=320*320*3;
 expect(raw.length/stride).toBe(17);
 for(let f=6;f<=16;f++) {const center=f*stride+(160*320+160)*3;expect(raw[center]).toBeGreaterThan(220);expect(raw[center+2]).toBeLessThan(20);}
},120000);
it.skipIf(!real)("a trimmed contain export restores the source-timed audio pulse while keeping its video boundary and source bytes",async()=>{
 const video=path.join(dir,"delayed-video.mp4"),source=path.join(dir,"delayed-av.mp4");
 ff(["-f","lavfi","-i","color=red:s=64x64:r=30:d=0.5","-f","lavfi","-i","color=blue:s=64x64:r=30:d=1.5","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264","-bf","0",video]);
 ff(["-itsoffset","2","-i",video,"-f","lavfi","-i","aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=44100:d=1.4","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac",source]);
 const original=await readFile(source),p=createEmptyProject(),id=randomUUID();sources.set(id,source);
 p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=.6;
 p.assets=[{id,kind:"video",ext:"mp4",displayName:"delayed",streamUrl:"/x",sourceDurationSec:4}];
 p.clips=[{id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:0,durationSec:.6,layoutMode:"contain",transform:{x:.5,y:.5,scale:2},parts:[{assetId:id,sourceInSec:.1,sourceOutSec:.7}]}];
 const before=JSON.stringify(p),job=path.join(dir,"trimmed-audio");await mkdir(job);const out=path.join(job,"out.mp4");
 await exportCompositionToFile({project:p,jobDir:job,outputPath:out});
 const raw=ff(["-i",out,"-an","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]),stride=320*320*3;
 expect(raw.length/stride).toBe(18);
 for(const frame of [0,11,12,17]){const at=frame*stride+(160*320+160)*3;expect(raw[at+(frame<12?0:2)]).toBeGreaterThan(220);expect(raw[at+(frame<12?2:0)]).toBeLessThan(25);}
 const pcm=ff(["-i",out,"-vn","-ac","1","-ar","48000","-f","s16le","pipe:1"]);
 const rms=(start:number,end:number)=>{let energy=0;for(let n=Math.round(start*48000);n<Math.round(end*48000);n++)energy+=pcm.readInt16LE(n*2)**2;return Math.sqrt(energy/Math.round((end-start)*48000));};
 expect(rms(.402,.418)).toBeGreaterThan(4000);expect(rms(.3,.32)).toBeLessThan(1500);expect(rms(.5,.52)).toBeLessThan(1500);
 expect(await readFile(source)).toEqual(original);expect(JSON.stringify(p)).toBe(before);expect(await readdir(job)).toEqual(["out.mp4"]);
},120000);
