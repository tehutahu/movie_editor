import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, chmod, rename, rm, mkdtemp, stat } from "node:fs/promises";
import { STORAGE_ROOT } from "./paths";
import { createReadStream } from "node:fs";
import { claimTitleCacheOwner } from "./titleCacheOwner";
import { titleChild } from "./titleChild";
import { inspectTitlePng } from "./titlePng";
import { fontCoverageRanges } from "./titleFontCmap";
import { titleFontMetrics } from "./titleFontMetrics";
import coverage from "./editor/titleFontCoverage.json";
import { TITLE_FONT_REVISION, validateTitleDescriptor } from "./editor/title";
import type { TitleClip } from "./editor/types";

const MAX_CACHE = 128 * 1024 * 1024, MAX_ENTRY = 32 * 1024 * 1024;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function fileDigest(file:string){const h=createHash("sha256");for await(const chunk of createReadStream(file))h.update(chunk);return h.digest("hex");}
const xml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;" })[c]!);
export class TitleBusyError extends Error { readonly status = 429; }
type Entry = { key: string; file: string; bytes: number; hash: string; refs: number; pending: number; accessed: number; invalid?: boolean };
export type TitleLease = { file: string; hash: string; key: string; release: () => void };
type Task = { key: string; title: TitleClip; width: number; height: number; owners: Set<symbol>; controller: AbortController; promise: Promise<Entry>; resolve: (entry: Entry) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; entry?: Entry; closed:Promise<void>; close:()=>void };
export type TitleRendererIdentity = { binary: string; binaryHash: string; font: string; fontDir: string; env: NodeJS.ProcessEnv; root: string; id: string; fit:ReturnType<typeof titleFontMetrics> };

function assertStaticElf(bytes: Buffer) {
  if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1) throw new Error("タイトルはLinux static ffmpegでのみ利用できます。");
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size < 56 || !count || offset + size * count > bytes.length) throw new Error("タイトルrenderer ELFが不正です。");
  for (let i = 0; i < count; i++) if ([2,3].includes(bytes.readUInt32LE(offset + i * size))) throw new Error("動的ffmpegはcanonicalタイトルrendererに使用できません。");
}
async function identity(): Promise<TitleRendererIdentity> {
  // Export FFMPEG_PATH never changes the canonical title renderer.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const original = require("ffmpeg-static") as string | null; if (!original) throw new Error("固定タイトルrendererがありません。");
  const binaryBytes = await readFile(original); assertStaticElf(binaryBytes); const binaryHash = digest(binaryBytes);
  const vendorFontDir = path.resolve(process.cwd(), "vendor/fonts/noto-sans-cjk/fonts"), fontBytes = await readFile(path.join(vendorFontDir, "NotoSansCJK-Regular.ttc"));
  if (digest(fontBytes) !== TITLE_FONT_REVISION || JSON.stringify(fontCoverageRanges(fontBytes)) !== JSON.stringify(coverage.ranges)) throw new Error("固定タイトルfontの実体が一致しません。");
  const cacheRoot = path.join(STORAGE_ROOT, "title-cache"); await mkdir(cacheRoot, { recursive: true });
  const owner = await claimTitleCacheOwner(cacheRoot), binary = path.join(owner, "ffmpeg"), fontDir=path.join(owner,"fonts"),font=path.join(fontDir,"NotoSansCJK-Regular.ttc");
  try {
    await mkdir(fontDir);await writeFile(font,fontBytes,{mode:0o400});
    await writeFile(binary, binaryBytes, { mode: 0o500 }); if (digest(await readFile(binary)) !== binaryHash) throw new Error("renderer snapshotが一致しません。");
    const config = path.join(owner, "fonts.conf"), fontCache = path.join(owner, "font-cache"); await mkdir(fontCache);
    await writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${xml(fontDir)}</dir><cachedir>${xml(fontCache)}</cachedir></fontconfig>`);
    const env = { ...process.env, FONTCONFIG_FILE: config, FONTCONFIG_PATH: owner };
    const version = await titleChild(binary, ["-version"], { env });
    const filters = await titleChild(binary, ["-hide_banner", "-filters"], { env }); if (!/\bass\s+V->V/.test(filters)) throw new Error("固定rendererにlibassがありません。");
    // Capture shaper/provider identity using an actual render before keys are published.
    const probeAss = path.join(owner, "probe.ass"), probePng = path.join(owner, "probe.png"); await writeFile(probeAss, titleAss("日本語", 320, 320));
    const log = await titleChild(binary, rasterArgs(probeAss, probePng, fontDir, 320, 320), { env }); assertFontLog(log); inspectTitlePng(await readFile(probePng), 320, 320);
    const manifest = { binaryHash, version, shaper: log.split("\n").filter(l=>/libass |Shaper:|Using font provider/.test(l)).map(l=>l.replace(/^\[[^\]]+\]\s*/, "")), fontHash: TITLE_FONT_REVISION, face: "NotoSansCJKjp-Regular/index0", pipeline: "title-rgba-ass-fit-v2", fontconfig: "self-contained-no-reset-v1" };
    const id = digest(JSON.stringify(manifest)); await writeFile(path.join(owner, "manifest.json"), JSON.stringify(manifest, null, 2)); await rm(probeAss); await rm(probePng);
    return { binary, binaryHash, font, fontDir, env, root: owner, id,fit:titleFontMetrics(fontBytes) };
  } catch (e) { await rm(owner, { recursive: true, force: true }); throw e; }
}
function assertFontLog(log: string) {
  const selects = log.split("\n").filter(l=>l.includes("fontselect:"));
  if (!log.includes("Using font provider fontconfig") || !selects.length || selects.some(l=>!l.includes("-> NotoSansCJKjp-Regular, 0, NotoSansCJKjp-Regular")) || /Error opening memory font|unknown element|failed|fallback|missing glyph|glyph.*not found|no glyph/i.test(log)) throw new Error("固定fontでタイトルを描画できません。未収録文字やfont設定を確認してください。");
}
export function titleAss(text: string, width: number, height: number, size = height*.08): string {
  const outline = size / 24;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK JP,${size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,${text.replace(/\n/g,"\\N")}\n`;
}
function rasterArgs(ass: string, png: string, fontDir: string, width: number, height: number) {
  // Only server generated safe paths enter filter expressions. Fail explicitly on an unsupported storage path.
  if ([ass, fontDir].some(p=>/[':\\,;[\]]/.test(p))) throw new Error("タイトルcacheの保存先pathに未対応の記号があります。");
  return ["-hide_banner","-y","-f","lavfi","-i",`color=c=black@0:s=${width}x${height}:r=1,format=rgba`,"-vf",`ass=filename=${ass}:fontsdir=${fontDir}:alpha=1`,"-frames:v","1","-threads","1",png];
}
export class TitleRasterService {
  private ready:Promise<TitleRendererIdentity>; private entries = new Map<string, Entry>(); private tasks = new Map<string, Task>(); private queue: Task[] = []; private running = false;
  constructor(initialize:()=>Promise<TitleRendererIdentity> = identity) { this.ready=initialize();void this.ready.catch(()=>undefined); }
  private lease(entry: Entry): TitleLease { entry.refs++; entry.accessed=Date.now(); let active=true; return { file:entry.file,hash:entry.hash,key:entry.key,release:()=>{if(active){active=false;entry.refs--;if(entry.invalid&&!entry.refs&&!entry.pending)void rm(entry.file,{force:true}).then(()=>{if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);}).catch(()=>undefined);}} }; }
  async acquire(title: TitleClip, width: number, height: number, signal?: AbortSignal): Promise<TitleLease> {
    const descriptor=validateTitleDescriptor(title as unknown as Record<string,unknown>);
    if (![width,height].every(n=>Number.isInteger(n)&&n>=320&&n<=4096&&n%2===0)) throw new Error("タイトルの構図寸法が不正です。");
    if (signal?.aborted) throw new Error("タイトル生成を取り消しました。");
    const info=await this.ready; if(signal?.aborted)throw new Error("タイトル生成を取り消しました。");
    const key=digest(JSON.stringify({descriptor,width,height,identity:info.id})), hit=this.entries.get(key);
    if(hit){if(hit.invalid)throw new Error("タイトルcacheを復旧中です。再試行してください。");const lease=this.lease(hit);try{if(await fileDigest(hit.file)!==hit.hash)throw new Error("タイトルcache実体が一致しません。");return lease;}catch(e){hit.invalid=true;lease.release();throw e;}}
    let task=this.tasks.get(key);
    if(task?.controller.signal.aborted){await task.closed;return this.acquire(title,width,height,signal);}
    if (!task) {
      if(this.queue.length>=16)throw new TitleBusyError("タイトル生成が混雑しています。少し待って再試行してください。");
      let resolve!:Task["resolve"],reject!:Task["reject"];const promise=new Promise<Entry>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>undefined);
      let close!:()=>void;const closed=new Promise<void>(resolve=>{close=resolve;});
      task={key,title:{...title,...descriptor},width,height,owners:new Set(),controller:new AbortController(),promise,resolve,reject,timer:setTimeout(()=>this.cancelWaiting(key),30000),closed,close};this.tasks.set(key,task);this.queue.push(task);
    }
    const target=task,owner=Symbol();target.owners.add(owner);
    const result=new Promise<TitleLease>((resolve,reject)=>{
      let active=true;
      const abort=()=>{if(!active)return;active=false;if(target.entry)target.entry.pending--;target.owners.delete(owner);if(!target.owners.size) {target.controller.abort();this.cancelWaiting(key);}reject(new Error("タイトル生成を取り消しました。"));};
      signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
      void target.promise.then(entry=>{signal?.removeEventListener("abort",abort);if(active){entry.pending--;active=false;target.owners.delete(owner);resolve(this.lease(entry));}},error=>{signal?.removeEventListener("abort",abort);if(active){active=false;target.owners.delete(owner);reject(error);}});
    });
    void this.pump(); return result;
  }
  private cancelWaiting(key:string) { const index=this.queue.findIndex(t=>t.key===key);if(index<0)return;const [t]=this.queue.splice(index,1);clearTimeout(t.timer);this.tasks.delete(key);t.reject(new Error("タイトル生成の待機を取り消しました・時間切れです。"));t.close(); }
  private async pump() {
    if(this.running)return;const task=this.queue.shift();if(!task)return;this.running=true;clearTimeout(task.timer);
    const deadline=setTimeout(()=>task.controller.abort(),30000);
    try {
      const info=await this.ready;
      let bytes=[...this.entries.values()].reduce((s,e)=>s+e.bytes,0);
      for(const e of [...this.entries.values()].sort((a,b)=>a.accessed-b.accessed)) {if(bytes+MAX_ENTRY<=MAX_CACHE&&this.entries.size<128)break;if(e.refs||e.pending||e.invalid)continue;this.entries.delete(e.key);bytes-=e.bytes;await rm(e.file,{force:true});}
      if(bytes+MAX_ENTRY>MAX_CACHE||this.entries.size>=128)throw new TitleBusyError("タイトルcache使用中です。少し待って再試行してください。");
      if(digest(await readFile(info.binary))!==info.binaryHash||digest(await readFile(info.font))!==TITLE_FONT_REVISION)throw new Error("固定タイトルrenderer・fontが変更されています。");
      const stage=await mkdtemp(path.join(info.root,"render-"));
      try {
        const ass=path.join(stage,"text.ass"),png=path.join(stage,"image.png"),fit=info.fit(task.title.text,task.width,task.height);
        let data:Buffer|undefined,fontSize=fit.fontSize;
        for(let attempt=0;attempt<3;attempt++){
          await writeFile(ass,titleAss(task.title.text,task.width,task.height,fontSize));
          const log=await titleChild(info.binary,rasterArgs(ass,png,info.fontDir,task.width,task.height),{env:info.env,signal:task.controller.signal});assertFontLog(log);
          const size=(await stat(png)).size;if(size>MAX_ENTRY)throw new Error("タイトルPNGが容量上限を超えました。");
          const candidate=await readFile(png),metrics=inspectTitlePng(candidate,task.width,task.height),[l,t,r,b]=metrics.bbox;
          if(l>=fit.margin&&t>=fit.margin&&r<=task.width-fit.margin&&b<=task.height-fit.margin){data=candidate;break;}
          fontSize=Math.floor(fontSize*.85*4)/4;if(fontSize<12)break;
        }
        if(!data)throw new Error("タイトルの文字が構図に収まりません。本文を短くするか手動改行を調整してください。");
        if(task.controller.signal.aborted)throw new Error("タイトル生成を取り消しました。");
        const file=path.join(info.root,`${task.key}.png`);await rename(png,file);await chmod(file,0o400);
        const entry:Entry={key:task.key,file,bytes:data.length,hash:digest(data),refs:0,pending:task.owners.size,accessed:Date.now()};task.entry=entry;this.entries.set(task.key,entry);task.resolve(entry);
      }finally{await rm(stage,{recursive:true,force:true});}
    }catch(e){task.reject(e);}finally{clearTimeout(deadline);this.tasks.delete(task.key);this.running=false;task.close();void this.pump();}
  }
}
const state=globalThis as typeof globalThis & {__movieTitleRasterV1?:Map<string,TitleRasterService>};
export function titleRasterService(){const services=state.__movieTitleRasterV1??=new Map();let service=services.get(STORAGE_ROOT);if(!service){service=new TitleRasterService();services.set(STORAGE_ROOT,service);}return service;}
/** Copy leased PNG into an export-owned directory before any consuming ffmpeg starts. */
export async function copyTitleRaster(title:TitleClip,width:number,height:number,directory:string):Promise<string>{
  const lease=await titleRasterService().acquire(title,width,height);
  try{const file=path.join(directory,`title-${randomUUID()}.png`);await copyFile(lease.file,file);if(digest(await readFile(file))!==lease.hash)throw new Error("タイトルexport copyが一致しません。");await chmod(file,0o400);return file;}finally{lease.release();}
}
