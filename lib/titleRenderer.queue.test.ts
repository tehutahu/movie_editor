import { afterAll, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { titleDescriptor } from "./editor/title";
import type { TitleClip } from "./editor/types";
const control=vi.hoisted(()=>({hold:false,started:0,running:0,max:0,releases:[] as (()=>void)[]}));
function crc(b:Buffer){let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function png(){const raw=Buffer.alloc((320*4+1)*320);raw[(320*4+1)*160+1+160*4+3]=255;const chunk=(name:string,data:Buffer)=>{const p=Buffer.alloc(data.length+12);p.writeUInt32BE(data.length);p.write(name,4);data.copy(p,8);p.writeUInt32BE(crc(p.subarray(4,8+data.length)),8+data.length);return p;};const header=Buffer.alloc(13);header.writeUInt32BE(320);header.writeUInt32BE(320,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);}
vi.mock("./titleChild",()=>({titleChild:async(_binary:string,args:string[],options:{signal?:AbortSignal})=>{
 control.started++;control.running++;control.max=Math.max(control.max,control.running);
 try{if(control.hold)await new Promise<void>((resolve,reject)=>{const abort=()=>reject(new Error("cancelled owned fake worker"));const release=()=>{options.signal?.removeEventListener("abort",abort);resolve();};control.releases.push(release);options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();});if(options.signal?.aborted)throw new Error("cancelled");await writeFile(args.at(-1)!,png());return "Using font provider fontconfig\nfontselect: (Noto Sans CJK JP, 400, 0) -> NotoSansCJKjp-Regular, 0, NotoSansCJKjp-Regular";}finally{control.running--;}
}}));
import { TitleRasterService, type TitleRendererIdentity } from "./titleRenderer";
const roots:string[]=[];afterAll(async()=>{for(const r of roots)await rm(r,{recursive:true,force:true});});
async function service(){const root=await mkdtemp(path.join(tmpdir(),"title-queue-test-"));roots.push(root);const binary=path.join(root,"fake-static");await writeFile(binary,"fake bytes");const info:TitleRendererIdentity={binary,binaryHash:createHash("sha256").update("fake bytes").digest("hex"),font:path.resolve("vendor/fonts/noto-sans-cjk/fonts/NotoSansCJK-Regular.ttc"),fontDir:path.resolve("vendor/fonts/noto-sans-cjk/fonts"),env:{...process.env},root,id:"queue-only-fake-identity",fit:()=>({fontSize:20,margin:6})};return new TitleRasterService(async()=>info);}
function clip(n:number):TitleClip{return{kind:"title",id:String(n),trackId:"t",timelineStartSec:0,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor(`タイトル${n}`)};}
it("runs one, bounds unique waiting to16, dedup preserves a remaining consumer, cancel frees all slots",async()=>{
 const s=await service();control.hold=true;control.max=0;
 const controllers=Array.from({length:17},()=>new AbortController());
 const pending=controllers.map((c,i)=>s.acquire(clip(i),320,320,c.signal));const all=Promise.allSettled(pending);
 await vi.waitFor(()=>expect(control.releases.length).toBeGreaterThan(0));
 await expect(s.acquire(clip(99),320,320)).rejects.toThrow(/混雑/);
 const shared=s.acquire(clip(0),320,320);await Promise.resolve();for(const c of controllers)c.abort();
 expect(control.running).toBe(1);control.hold=false;control.releases.shift()!();
 const held=await shared;expect((await all).every(x=>x.status==="rejected")).toBe(true);expect(control.max).toBe(1);held.release();
 const next=await s.acquire(clip(100),320,320);next.release();
 control.hold=true;const cancel=new AbortController(),last=s.acquire(clip(101),320,320,cancel.signal);const lastDone=Promise.allSettled([last]);
 await vi.waitFor(()=>expect(control.releases.length).toBe(1));cancel.abort();expect((await lastDone)[0].status).toBe("rejected");control.hold=false;control.releases=[];
 await vi.waitFor(()=>expect(control.running).toBe(0));
 // A replacement arriving in the cancellation microtask must not join the
 // aborted former task or spin before its owned staging finally completes.
 control.hold=true;const raceCancel=new AbortController(),old=s.acquire(clip(102),320,320,raceCancel.signal),oldDone=Promise.allSettled([old]);
 await vi.waitFor(()=>expect(control.releases.length).toBe(1));const replacement=s.acquire(clip(102),320,320);raceCancel.abort();control.hold=false;control.releases=[];
 const restored=await replacement;restored.release();expect((await oldDone)[0].status).toBe("rejected");
},15000);
it("refuses a full pinned cache and preserves an already-owned export copy after eviction",async()=>{
 const s=await service(),a=await s.acquire(clip(200),320,320);
 const fields=s as unknown as {entries:Map<string,{bytes:number;refs:number;file:string}>};const entry=fields.entries.get(a.key)!;entry.bytes=128*1024*1024;
 await expect(s.acquire(clip(201),320,320)).rejects.toThrow(/cache/);
 const copied=path.join(path.dirname(a.file),"export-owned-copy.png");await copyFile(a.file,copied);const bytes=await readFile(copied);a.release();
 const b=await s.acquire(clip(201),320,320);b.release();await expect(readFile(a.file)).rejects.toThrow();expect(await readFile(copied)).toEqual(bytes);
});
