import { it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProject } from "./editor/project";
import { titleDescriptor } from "./editor/title";
import { exportCompositionToFile } from "./exportComposition";
import { titleRasterService } from "./titleRenderer";
import { inspectTitlePng } from "./titlePng";
import type { MediaClip, TitleClip } from "./editor/types";
const sources=vi.hoisted(()=>new Map<string,string>());
vi.mock("./assetResolve",()=>({resolveAssetInputPath:async(a:{id:string})=>sources.get(a.id)??null}));
const ff=(args:string[])=>execFileSync(process.env.FFMPEG_PATH||"/usr/bin/ffmpeg",["-v","error","-y",...args],{maxBuffer:32*1024*1024});
it.skipIf(process.env.RUN_FFMPEG_TESTS!=="1")("real title overlay keeps both media graphs' audio and finite visibility; portrait chapter fits without prior cropping",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"title-composition-"));
 try{
  const source=path.join(root,"source.mp4");ff(["-f","lavfi","-i","color=red:s=320x320:r=30:d=1.2","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1.2","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",source]);
  const p=createEmptyProject();p.compositionWidth=320;p.compositionHeight=320;p.compositionDurationSec=1.2;p.tracks=[{id:randomUUID(),order:1}];
  p.assets=[{id:randomUUID(),kind:"video",ext:"mp4",displayName:"red",streamUrl:"/x",sourceDurationSec:1.2,width:320,height:320}];sources.set(p.assets[0].id,source);
  const clip:MediaClip={id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:0,durationSec:1.2,parts:[{assetId:p.assets[0].id,sourceInSec:0,sourceOutSec:1.2}],transform:{x:.5,y:.5,scale:2}};
  const title:TitleClip={kind:"title",id:randomUUID(),trackId:randomUUID(),timelineStartSec:.2,durationSec:.6,transform:{x:.5,y:.5,scale:1},...titleDescriptor("日本語 見出し")};
  for(const mode of ["stretch","contain"] as const){
   const base={...p,clips:[{...clip,...(mode==="contain"?{layoutMode:mode}:{})}]};
   const edited={...base,tracks:[{id:title.trackId,order:0},...base.tracks],clips:[...base.clips,title]};
   const outputs:string[]=[];
   for(const [name,project]of [["old",base],["title",edited]] as const){const dir=path.join(root,`${mode}-${name}`);await mkdir(dir);const output=path.join(dir,"out.mp4");await exportCompositionToFile({project,jobDir:dir,outputPath:output});outputs.push(output);}
   const pcm=(file:string)=>ff(["-i",file,"-vn","-acodec","pcm_s16le","-f","s16le","-"]);
   expect(pcm(outputs[1])).toEqual(pcm(outputs[0]));
   const rgb=ff(["-i",outputs[1],"-f","rawvideo","-pix_fmt","rgb24","-"]);expect(rgb.length).toBe(36*320*320*3);
   function white(frame:number){let n=0;const offset=frame*320*320*3;for(let i=0;i<320*320;i++)if(rgb[offset+i*3]>170&&rgb[offset+i*3+1]>170&&rgb[offset+i*3+2]>170)n++;return n;}
   expect(white(2)).toBe(0);expect(white(12)).toBeGreaterThan(50);expect(white(28)).toBe(0);
   expect(rgb[12*320*320*3]).toBeGreaterThan(200);expect(rgb[12*320*320*3+1]).toBeLessThan(25);
  }
  const portrait={...title,...titleDescriptor("日本語の動画編集チュートリアル")};
  const lease=await titleRasterService().acquire(portrait,720,1280);
  try{const png=await readFile(lease.file),metrics=inspectTitlePng(png,720,1280);expect(metrics.bbox[0]).toBeGreaterThan(14);expect(metrics.bbox[2]).toBeLessThan(706);expect(metrics.alphaPixels).toBeGreaterThan(1000);
   const artifact=process.env.TITLE_AUTHOR_PORTRAIT;if(artifact)await copyFile(lease.file,artifact);
  }finally{lease.release();}
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
