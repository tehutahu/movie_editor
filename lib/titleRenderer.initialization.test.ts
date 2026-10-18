import { it, expect, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { titleDescriptor } from "./editor/title";
import type { TitleClip } from "./editor/types";
const fault=vi.hoisted(()=>({remaining:1,probes:0}));
vi.mock("./titleChild",async(importOriginal)=>{
 const actual=await importOriginal<typeof import("./titleChild")>();
 return{...actual,titleChild:async(...args:Parameters<typeof actual.titleChild>)=>{if(args[1].some(s=>s.includes("probe.ass"))){fault.probes++;if(fault.remaining-->0)throw new Error("synthetic one-time probe failure");}return actual.titleChild(...args);}};
});
it.skipIf(process.env.RUN_FFMPEG_TESTS!=="1")("failed shared initialization releases only its own lease and an explicit concurrent retry recovers",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"title-init-test-")),before=process.env.MOVIE_EDITOR_STORAGE_ROOT;process.env.MOVIE_EDITOR_STORAGE_ROOT=root;
 try{
  vi.resetModules();const {TitleRasterService,isTitleBusyError}=await import("./titleRenderer");const service=new TitleRasterService();
  const title:TitleClip={kind:"title",id:"t",trackId:"track",timelineStartSec:0,durationSec:1,transform:{x:.5,y:.5,scale:1},...titleDescriptor("日本語")};
  const first=await Promise.allSettled([service.acquire(title,320,320),service.acquire(title,320,320)]);expect(first.every(x=>x.status==="rejected")).toBe(true);expect(fault.probes).toBe(1);
  expect((await readdir(path.join(root,"title-cache"))).filter(n=>n.startsWith("lease-")||n.startsWith("owner-"))).toEqual([]);
  const [a,b]=await Promise.all([service.acquire(title,320,320),service.acquire(title,320,320)]);expect(a.file).toBe(b.file);expect(fault.probes).toBe(2);a.release();b.release();
  expect(isTitleBusyError(Object.assign(new Error("other module constructor"),{code:"TITLE_RASTER_BUSY",status:429}))).toBe(true);
  expect(isTitleBusyError({status:429})).toBe(false);
 }finally{if(before===undefined)delete process.env.MOVIE_EDITOR_STORAGE_ROOT;else process.env.MOVIE_EDITOR_STORAGE_ROOT=before;await rm(root,{recursive:true,force:true});}
},30000);
