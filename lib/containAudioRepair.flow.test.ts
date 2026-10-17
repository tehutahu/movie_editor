import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const commands=vi.hoisted(()=>({ff:"",probe:""}));
const faults=vi.hoisted(()=>({afterClose:undefined as undefined|((file:string)=>void),afterStat:undefined as undefined|((file:string)=>Promise<void>)}));
vi.mock("node:fs/promises",async importOriginal=>{
 const fs=await importOriginal<typeof import("node:fs/promises")>();
 return {...fs,open:async (...args:Parameters<typeof fs.open>)=>{const h=await fs.open(...args),close=h.close.bind(h);h.close=async()=>{await close();faults.afterClose?.(String(args[0]));};return h;},lstat:async(file:string)=>{const s=await fs.lstat(file);await faults.afterStat?.(file);return s;}};
});
vi.mock("./ffmpeg",()=>({resolveFfmpegPath:()=>commands.ff,resolveFfprobePath:()=>commands.probe}));
import { repairContainAudio, AudioAuxAbort, containAudioInputIdentity } from "./containAudioRepair";
let dir:string;
beforeEach(async()=>{
 faults.afterClose=undefined;faults.afterStat=undefined;dir=await mkdtemp(path.join(tmpdir(),"audio-repair-flow-"));commands.ff=path.join(dir,"ff");commands.probe=path.join(dir,"probe");
 const code=`#!${process.execPath}\nconst fs=require('fs'),p=require('path'),d=__dirname;const config=JSON.parse(fs.readFileSync(p.join(d,'config.json')));fs.appendFileSync(p.join(d,'calls.jsonl'),JSON.stringify({kind:p.basename(process.argv[1]),args:process.argv.slice(2)})+'\\n');const file=process.argv.at(-1);if(p.basename(process.argv[1])==='ff'){fs.writeFileSync(file,Buffer.alloc(config.newN*4+78));if(config.retryFail)process.exit(1);if(config.hold)setInterval(()=>{},1000);}else{const n=p.basename(file)==='old.wav'?config.oldN:config.newN;if(config.probeFail||config.newUnknown&&p.basename(file)!=='old.wav'){process.stdout.write('bad');}else{process.stdout.write(JSON.stringify({streams:[{codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'48000',channels:2,bits_per_sample:16,time_base:'1/48000',duration_ts:n}]}));}}`;
 await writeFile(commands.ff,code,{mode:0o700});await writeFile(commands.probe,code,{mode:0o700});
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const descriptor={audioDuration:{n:BigInt(14),d:BigInt(10)}};
async function setup(config:Record<string,unknown>={}){
 const c={oldN:1098,newN:67200,...config};await writeFile(path.join(dir,"config.json"),JSON.stringify(c));const oldFile=path.join(dir,"old.wav"),retryFile=path.join(dir,"retry.wav");await writeFile(oldFile,Buffer.alloc(Number(c.oldN)*4+78,7));const input=path.join(dir,"source.mp4");await writeFile(input,"immutable media");return {input,sourceIn:0,durationArg:"1.4",descriptor:{...descriptor,inputIdentity:await containAudioInputIdentity(input)},oldFile,retryFile};
}
async function calls(){return (await readFile(path.join(dir,"calls.jsonl"),"utf8")).trim().split("\n").map(s=>JSON.parse(s));}
it("healthy WAV including threshold L keeps exact old path/bytes and never retries",async()=>{
 const p=await setup({oldN:67199});const before=await readFile(p.oldFile);expect(await repairContainAudio(p)).toMatchObject({file:p.oldFile,status:"healthy",oldSamples:BigInt(67199)});expect(await readFile(p.oldFile)).toEqual(before);expect((await calls()).map(c=>c.kind)).toEqual(["probe"]);await expect(access(p.retryFile)).rejects.toThrow();
});
it("clear short uses a separate path once, retains original bytes and only removes -ss 0",async()=>{
 const p=await setup();const before=await readFile(p.oldFile);expect(await repairContainAudio(p)).toMatchObject({file:p.retryFile,status:"repaired",oldSamples:BigInt(1098),newSamples:BigInt(67200)});expect(await readFile(p.oldFile)).toEqual(before);const list=await calls();expect(list.map(c=>c.kind)).toEqual(["probe","ff","probe"]);expect(list[1].args).toEqual(["-y","-i",p.input,"-vn","-af","aresample=48000,apad","-ac","2","-ar","48000","-t","1.4","-c:a","pcm_s16le",p.retryFile]);
});
it.each([{retryFail:true},{newUnknown:true},{newN:67198},{newN:67202},{newN:1098},{newN:0}])("retry failure/unacceptable sample count falls back and removes partial candidate: %j",async config=>{
 const p=await setup(config);const before=await readFile(p.oldFile);expect(await repairContainAudio(p)).toMatchObject({status:"fallback",file:p.oldFile});expect(await readFile(p.oldFile)).toEqual(before);await expect(access(p.retryFile)).rejects.toThrow();expect((await calls()).filter(c=>c.kind==="ff")).toHaveLength(1);
});
it("unknown old probe keeps old output without retry",async()=>{const p=await setup({probeFail:true});expect(await repairContainAudio(p)).toMatchObject({status:"unknown",file:p.oldFile});expect((await calls()).map(c=>c.kind)).toEqual(["probe"]);});
it("caller abort during retry is not resurrected as a successful legacy result and candidate is cleaned",async()=>{
 const p=await setup({hold:true});const signal=new AbortController();const result=repairContainAudio({...p,signal:signal.signal});const rejection=expect(result).rejects.toBeInstanceOf(AudioAuxAbort);
 const deadline=Date.now()+2000;while(true){try{await access(p.retryFile);break;}catch{if(Date.now()>deadline)throw new Error("retry never began");await new Promise(r=>setTimeout(r,10));}}
 signal.abort();await rejection;await expect(access(p.retryFile)).rejects.toThrow();expect(await readFile(p.oldFile)).toEqual(Buffer.alloc(1098*4+78,7));
});

it("changed input identity never applies old metadata to new bytes",async()=>{const p=await setup();await writeFile(p.input,"replacement source with changed size");expect(await repairContainAudio(p)).toMatchObject({status:"ineligible",file:p.oldFile});await expect(access(p.retryFile)).rejects.toThrow();});

it.each(["old.wav","retry.wav"])("abort during %s fd close is propagated and never returns healthy/repaired",async target=>{
 const p=await setup({oldN:target==="old.wav"?67200:1098}),controller=new AbortController();
 faults.afterClose=file=>{if(path.basename(file)===target)controller.abort();};
 await expect(repairContainAudio({...p,signal:controller.signal})).rejects.toBeInstanceOf(AudioAuxAbort);
 await expect(access(p.retryFile)).rejects.toThrow();expect(await readFile(p.oldFile)).toEqual(Buffer.alloc((target==="old.wav"?67200:1098)*4+78,7));
});
it("source replacement during old diagnostic keeps legacy and never retries using stale descriptor",async()=>{
 const p=await setup();faults.afterStat=async file=>{if(file===p.oldFile)await writeFile(p.input,"replacement bytes changed during diagnosis");};
 expect(await repairContainAudio(p)).toMatchObject({status:"fallback",file:p.oldFile});expect((await calls()).map(c=>c.kind)).toEqual(["probe"]);
});

it("L-1 is clear short while L+1 is healthy and L=0 avoids all auxiliary work",async()=>{
 let p=await setup({oldN:67198});expect((await repairContainAudio(p)).status).toBe("repaired");
 p=await setup({oldN:67200});expect((await repairContainAudio(p)).status).toBe("healthy");
 p=await setup({oldN:0});expect((await repairContainAudio({...p,durationArg:"1e-12"})).status).toBe("ineligible");
});
