import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveFfmpegPath, probeMedia } from "./ffmpeg";
import { containAudioSeekFromProbe, containAudioInputIdentity, inspectContainWav, repairContainAudio } from "./containAudioRepair";
const real=process.env.RUN_FFMPEG_TESTS==="1";
let dir:string;
const ff=(args:string[])=>execFileSync(resolveFfmpegPath(),["-v","error",...args],{timeout:30000,maxBuffer:8*1024*1024});
const tone="aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=44100:d=";
const audioArgs=(input:string,d:string,output:string,seek=true)=>["-y",...(seek?["-ss","0"]:[]),"-i",input,"-vn","-af","aresample=48000,apad","-ac","2","-ar","48000","-t",d,"-c:a","pcm_s16le",output];
const pcm=(f:string)=>ff(["-i",f,"-map","0:a:0","-f","s16le","pipe:1"]);
beforeAll(async()=>{
 if(!real)return;dir=await mkdtemp(path.join(tmpdir(),"contain-audio-real-"));
 const video=path.join(dir,"video.mp4");
 ff(["-y","-f","lavfi","-i","testsrc2=s=64x64:r=30:d=1.4","-c:v","libx264","-bf","0",video]);
 for(const [name,offset,duration] of [["short","2","1.4"],["healthy","0.01","1.4"],["origin0","0","1.4"],["long","2","60"]]){
  ff(["-y",...(name==="long"?["-stream_loop","-1"]:[]),"-itsoffset",offset,"-i",video,"-f","lavfi","-i",tone+duration,"-map","0:v:0","-map","1:a:0","-c:v",name==="healthy"?"libx264":"copy",...(name==="healthy"?["-bf","0","-fps_mode:v","passthrough","-enc_time_base:v","1:15360"]:[]),"-c:a","aac","-ar","44100","-t",String(Number(offset)+Number(duration)),"-movflags","+faststart",path.join(dir,name+".mp4")]);
 }
},120000);
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
async function trial(name:string,durationArg="1.4"){
 const input=path.join(dir,name+".mp4"),oldFile=path.join(dir,`${name}-${durationArg}-old.wav`),retryFile=path.join(dir,`${name}-${durationArg}-retry.wav`);
 ff(audioArgs(input,durationArg,oldFile));const oldBytes=await readFile(oldFile);
 const metadata=containAudioSeekFromProbe(await probeMedia(input));
 const descriptor=metadata?{...metadata,inputIdentity:await containAudioInputIdentity(input)}:null;
 const result=await repairContainAudio({input,sourceIn:0,durationArg,descriptor,oldFile,retryFile});
 expect(await readFile(oldFile)).toEqual(oldBytes);
 return {input,oldFile,retryFile,result,descriptor};
}
it.skipIf(!real)("clear-short and verified-empty WAV retry exactly recovers the fixed source audio without touching old bytes",async()=>{
 for(const name of ["short","long"]){
  const {input,oldFile,result}=await trial(name);
  expect(await inspectContainWav(oldFile)).toBeLessThan(BigInt(67199));
  expect(result).toMatchObject({status:"repaired",newSamples:BigInt(67200)});
  const reference=path.join(dir,name+"-reference.wav");ff(audioArgs(input,"1.4",reference,false));expect(pcm(result.file)).toEqual(pcm(reference));
  const data=pcm(result.file);let energy=0;for(let n=24000;n<24960;n++)energy+=data.readInt16LE(n*4)**2;
  expect(Math.sqrt(energy/960)).toBeGreaterThan(4000); // fixed 0.50..0.52 pulse, not just apad length
 }
},120000);
it.skipIf(!real)("healthy positive keeps the complete old WAV/PCM, and origin0 or true short EOF stay on legacy path",async()=>{
 for(const [name,duration] of [["healthy","1.4"],["origin0","1.4"],["short","2"]]){
  const {oldFile,retryFile,result}=await trial(name,duration);
  expect(result.file).toBe(oldFile);expect(result.status).toBe(name==="healthy"?"healthy":"ineligible");await expect(access(retryFile)).rejects.toThrow();
  expect(pcm(result.file)).toEqual(pcm(oldFile));
 }
},120000);
it.skipIf(!real)("noninteger -t sample boundaries fit the fixed floor-minus-one/ceil-plus-one gate",async()=>{
 for(const duration of ["0.05001","0.050020833","0.050020834"]){
  const {result}=await trial("short",duration);expect(result.status).toBe("repaired");
  const n=Number(result.newSamples);expect(n).toBeGreaterThanOrEqual(Math.floor(Number(duration)*48000)-1);expect(n).toBeLessThanOrEqual(Math.ceil(Number(duration)*48000)+1);
 }
},120000);
