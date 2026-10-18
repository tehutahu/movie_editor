import { it, expect, afterAll } from "vitest";
import { readFile, mkdtemp, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { claimTitleCacheOwner } from "./titleCacheOwner";
import { inspectTitlePng } from "./titlePng";
import { titleDescriptor } from "./editor/title";
import type { TitleClip } from "./editor/types";
const roots:string[]=[];
afterAll(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
it("reclaims only proven stale derived owner generations and rejects a live owner",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"title-owner-test-"));roots.push(root);
 const first=await claimTitleCacheOwner(root);await writeFile(path.join(first,"owned-only"),"derived");
 await expect(claimTitleCacheOwner(root)).rejects.toThrow(/稼働中/);
 const lease=(await readdir(root)).find(x=>x.startsWith("lease-"))!;
 const data=JSON.parse(await readFile(path.join(root,lease),"utf8"));data.boot="previous-boot";await chmod(path.join(root,lease),0o600);await writeFile(path.join(root,lease),JSON.stringify(data));
 const second=await claimTitleCacheOwner(root);expect(second).not.toBe(first);await expect(readFile(path.join(first,"owned-only"))).rejects.toThrow();
 expect((await readdir(root)).filter(x=>x.startsWith("owner-"))).toHaveLength(1);expect((await readdir(root)).filter(x=>x.startsWith("lease-"))).toHaveLength(1);
});
it("serializes concurrent actual process owners, preserves the live one and reclaims it after exit",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"title-process-owner-"));roots.push(root);
 const module=pathToFileURL(path.resolve("lib/titleCacheOwner.ts")).href;
 const code=`import {claimTitleCacheOwner} from ${JSON.stringify(module)};try{const directory=await claimTitleCacheOwner(${JSON.stringify(root)});console.log(JSON.stringify({ok:true,directory}));process.stdin.resume();}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}`;
 const owned=[0,1].map(()=>{
  const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{stdio:["pipe","pipe","pipe"]});
  const closed=new Promise<void>((resolve,reject)=>{child.once("close",()=>resolve());child.once("error",reject);});
  const result=new Promise<{ok:boolean;directory?:string}>((resolve,reject)=>{let output="";child.stdout.on("data",d=>{output+=d;if(output.includes("\n")){try{resolve(JSON.parse(output.split("\n")[0]));}catch(e){reject(e);}}});child.once("error",reject);child.once("close",()=>{if(!output)reject(new Error("owner child ended without result"));});});
  return{child,closed,result};
 });
 try{const results=await Promise.all(owned.map(x=>x.result));expect(results.filter(r=>r.ok)).toHaveLength(1);await expect(claimTitleCacheOwner(root)).rejects.toThrow(/稼働中/);}
 finally{for(const o of owned){o.child.stdin.end();if(o.child.exitCode===null)o.child.kill("SIGTERM");}await Promise.all(owned.map(o=>o.closed));}
 const next=await claimTitleCacheOwner(root);expect(await readdir(next)).toEqual([]);expect((await readdir(root)).filter(x=>x.startsWith("owner-"))).toHaveLength(1);
},15000);
it.skipIf(process.env.RUN_FFMPEG_TESTS!=="1")("real canonical title renderer validates identity, JP face, alpha, CRC, dedup and cache corruption",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"title-renderer-test-"));roots.push(root);
 // Module root is process-owned in the dedicated test worker, never source media.
 const oldRoot=process.env.MOVIE_EDITOR_STORAGE_ROOT;process.env.MOVIE_EDITOR_STORAGE_ROOT=root;
 try{
  const {vi}=await import("vitest");vi.resetModules();
  const {TitleRasterService}=await import("./titleRenderer");
  const service=new TitleRasterService(),clip:TitleClip={kind:"title",id:randomUUID(),trackId:randomUUID(),timelineStartSec:0,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor("日本語「見出し」\nｶﾞ か\u3099 ￥¥ ©♥")};
  const [a,b]=await Promise.all([service.acquire(clip,320,320),service.acquire(clip,320,320)]);
  expect(a.key).toBe(b.key);expect(a.file).toBe(b.file);const png=await readFile(a.file);expect(inspectTitlePng(png,320,320).alphaPixels).toBeGreaterThan(0);
  expect(createHash("sha256").update(png).digest("hex")).toBe(a.hash);
  const corrupt=Buffer.from(png);corrupt[corrupt.length-5]^=1;expect(()=>inspectTitlePng(corrupt,320,320)).toThrow(/CRC/);
  a.release();b.release();const hit=await service.acquire(clip,320,320);expect(hit.hash).toBe(a.hash);hit.release();
  await chmod(a.file,0o600);await writeFile(a.file,"corrupt");await expect(service.acquire(clip,320,320)).rejects.toThrow(/cache/);
 }finally{if(oldRoot===undefined)delete process.env.MOVIE_EDITOR_STORAGE_ROOT;else process.env.MOVIE_EDITOR_STORAGE_ROOT=oldRoot;}
},30000);
