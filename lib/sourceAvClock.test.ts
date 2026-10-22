import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const fake = vi.hoisted(() => ({ calls: [] as string[][], input: "", output: "", source: {} as unknown,
  old: {} as unknown, candidate: {} as unknown, packets: {} as unknown, fault: "", signal: undefined as AbortController | undefined }));
vi.mock("./containAudioRepair", async original => {
  const actual = await original<typeof import("./containAudioRepair")>();
  return { ...actual, runBoundedAudioAux: async (_command: string, args: string[], options: {signal?: AbortSignal}) => {
    fake.calls.push(args); if (options.signal?.aborted) throw new actual.AudioAuxAbort();
    const file = args.at(-1)!;
    if (args.includes("-show_packets")) return JSON.stringify(fake.packets);
    if (args.includes("-show_streams")) {
      if (fake.fault === "probe" && file === fake.output) throw new Error("probe timed out");
      const value = file === fake.input ? fake.source : file === fake.output ? fake.old : fake.candidate;
      if (file !== fake.input && file !== fake.output && fake.fault === "abort") fake.signal!.abort();
      return JSON.stringify(value);
    }
    await writeFile(file, "candidate");
    if (fake.fault === "retry") throw new Error("ffmpeg timeout");
    if (fake.fault === "changed") await writeFile(fake.input, "changed input identity");
    return "";
  } };
});
vi.mock("./ffmpeg", async original => ({ ...await original<typeof import("./ffmpeg")>(),
  extractSegmentTimes: async () => { await writeFile(fake.output,"old output"); } }));
import { extractEditorSegment, incompleteSourceAvSegment, inspectSourceAvClock, repairSourceAvSegment, sourceAudioSample, sourceAvClockFromProbe, sourceAvRepairRate, verifiedVideoPacketDuration } from "./sourceAvClock";
import type { FfProbeJson } from "./ffmpeg";
let dir: string;
const raw = (): FfProbeJson => ({ format: {start_time:"0"}, streams: [
  {codec_type:"video",start_time:"2",start_pts:30720,time_base:"1/15360",duration:"2",duration_ts:30720,avg_frame_rate:"30/1",r_frame_rate:"30/1"},
  {codec_type:"audio",start_time:"0",start_pts:0,time_base:"1/44100",duration:"1.4",duration_ts:61740}
] });
const complete = () => ({ streams: [ {codec_type:"video",start_time:"0",duration:"0.6"}, {codec_type:"audio",start_time:"0",duration:"0.6"} ] });
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "av-clock-flow-")); fake.input = path.join(dir,"input.mp4"); fake.output=path.join(dir,"out.mp4");
  await writeFile(fake.input,"immutable source"); await writeFile(fake.output,"old output");
  fake.source=raw(); fake.old={streams:[]};fake.candidate=complete();fake.fault="";fake.calls=[];fake.signal=undefined;
  fake.packets={packets:Array.from({length:60},(_,i)=>({pts:30720+i*512,duration:512}))};
});
afterEach(async () => { await rm(dir,{recursive:true,force:true}); });
const params = () => ({input:fake.input,output:fake.output,start:.1,end:.7});
it("distinguishes unknown diagnostics from proven missing or truncated output", () => {
  expect(incompleteSourceAvSegment({},.6)).toBeNull();
  expect(incompleteSourceAvSegment({streams:[{codec_type:"video"},{codec_type:"audio"}]},.6)).toBeNull();
  expect(incompleteSourceAvSegment({streams:[]},.6)).toBe(true);
  expect(incompleteSourceAvSegment(complete(),.6)).toBe(false);
  expect(incompleteSourceAvSegment({streams:[{codec_type:"video",start_time:"2",duration:".6"}]},.6)).toBe(true);
});
it.each([{}, {streams:[{}]}, complete(), {streams:[{codec_type:"video"},{codec_type:"audio"}]}])("healthy/unknown old output is never replaced: %j", async old => {
  fake.old=old; expect(await repairSourceAvSegment(params())).toBe(false);
  expect((await readFile(fake.output)).toString()).toBe("old output"); expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it("replaces only a verified short output and removes the unique candidate", async () => {
  expect(await repairSourceAvSegment(params())).toBe(true);
  expect((await readFile(fake.output)).toString()).toBe("candidate");
  expect((await readFile(fake.input)).toString()).toBe("immutable source"); expect((await readdir(dir)).sort()).toEqual(["input.mp4","out.mp4"]);
});
it.each(["probe","retry","changed"])("%s failure keeps exact old bytes and cleans candidate", async fault => {
  fake.fault=fault;expect(await repairSourceAvSegment(params())).toBe(false);
  expect((await readFile(fake.output)).toString()).toBe("old output");expect((await readdir(dir)).sort()).toEqual(["input.mp4","out.mp4"]);
});
it.each([{}, {streams:[]}, {streams:[{codec_type:"video"},{codec_type:"audio"}]}])("unknown/incomplete candidate never replaces old bytes: %j", async candidate => {
  fake.candidate=candidate;expect(await repairSourceAvSegment(params())).toBe(false);
  expect((await readFile(fake.output)).toString()).toBe("old output");expect((await readdir(dir)).sort()).toEqual(["input.mp4","out.mp4"]);
});
it("abort after candidate probe cannot publish candidate and cleans its file", async () => {
  fake.fault="abort";fake.signal=new AbortController();
  await expect(repairSourceAvSegment({...params(),signal:fake.signal.signal})).rejects.toThrow();
  expect((await readFile(fake.output)).toString()).toBe("old output");expect((await readdir(dir)).sort()).toEqual(["input.mp4","out.mp4"]);
});
it("preaborted diagnostics do not run ffmpeg", async () => {
  const controller=new AbortController();controller.abort();await expect(inspectSourceAvClock(fake.input,controller.signal)).rejects.toThrow();
  expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it("strict duration/metadata and CFR gate exclude unknown families without a retry", async () => {
  for (const mutate of [
    (r:FfProbeJson)=>{r.streams![0].start_time="0";},
    (r:FfProbeJson)=>{delete r.streams![0].duration_ts;},
    (r:FfProbeJson)=>{r.streams![0].duration="99";},
    (r:FfProbeJson)=>{r.streams!.push({...r.streams![1]});},
    (r:FfProbeJson)=>{r.streams![1].start_pts=1;},
  ]) { const r=raw();mutate(r);expect(sourceAvClockFromProbe(r)).toBeNull(); }
  const r=raw();r.streams![0].avg_frame_rate="24/1";fake.source=r;
  expect(await repairSourceAvSegment(params())).toBe(false);
  expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it("rational coverage rejects positive submicrosecond uncovered ends", async () => {
  expect(await repairSourceAvSegment({...params(),start:1.100000001,end:1.400000001})).toBe(false);
  expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it("packet EOF rejects a short actual video even when an old probe overreports its duration", async () => {
  fake.packets={packets:Array.from({length:15},(_,i)=>({pts:30720+i*512,duration:512}))};
  expect(await repairSourceAvSegment(params())).toBe(false);
  expect((await readFile(fake.output)).toString()).toBe("old output");
  expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it.each([{}, {packets:[]}, {packets:[{pts:30720,duration:1024}]}, {packets:[{pts:30720,duration:512},{pts:31744,duration:512}]}])("unknown or non-CFR packet grid is ineligible: %j", packets => {
  expect(verifiedVideoPacketDuration(packets,"30720","1/15360")).toBeNull();
});
it("bounded variable cadence sorts packet pairs and derives EOF from durations rather than count",()=>{
  const packets={packets:[{pts:31744,duration:512},{pts:30720,duration:1024}]};
  expect(verifiedVideoPacketDuration(packets,"30720","1/15360",2,"20/1")).toEqual({n:BigInt(1536),d:BigInt(15360)});
  expect(verifiedVideoPacketDuration(packets,"30720","1/15360",2,"30/1")).toBeNull();
  expect(verifiedVideoPacketDuration(packets,"30720","1/15360")).toBeNull();
});
it.each([
 [{pts:30720,duration:1024},{pts:32256,duration:512}], // hole
 [{pts:30720,duration:1024},{pts:30720,duration:512}], // duplicate
 [{pts:30720,duration:1024},{pts:31232,duration:512}], // overlap
 [{pts:30721,duration:512}], // first off-grid
 [{pts:30720,duration:1536}], // outside 1/2 tick family
 [{pts:30720,duration:513}],
 [{pts:30720}],
].map(packets=>({packets})))("bounded VFR rejects unproven grids: %j",raw=>{
  expect(verifiedVideoPacketDuration(raw,"30720","1/15360",2)).toBeNull();
});
it.each([undefined,"0/0","31/1","14/1","NaN","30","3e1/1","30/0"])("unproven nominal rate %s is not eligible",rate=>{
  expect(sourceAvRepairRate(rate)).toBe(false);
});
it("verified 1/2-tick variable cadence can repair but its actual short EOF cannot",async()=>{
  const r=raw();r.streams![0].avg_frame_rate="20/1";fake.source=r;
  fake.packets={packets:Array.from({length:40},(_,i)=>({pts:30720+Math.floor(i/2)*1536+(i%2)*1024,duration:i%2?512:1024}))};
  expect(await repairSourceAvSegment(params())).toBe(true);
  await writeFile(fake.output,"old output");fake.calls=[];
  fake.packets={packets:[{pts:30720,duration:1024},{pts:31744,duration:512}]};
  expect(await repairSourceAvSegment(params())).toBe(false);
  expect((await readFile(fake.output)).toString()).toBe("old output");
  expect(fake.calls.filter(c=>c.includes("-filter_complex"))).toHaveLength(0);
});
it.each([[1/30,1600],[.500010416,24000],[.500010417,24000],[.500020833,24001],[.500020834,24001]])("integer seek quantization %s -> sample %s", (time,sample) => {
  expect(sourceAudioSample(time)).toBe(sample);
});
it.each([null, {}, {streams:[{}]}, {streams:"unknown"}, complete()])("selected wrapper preserves unknown/healthy legacy success: %j", async old => {
  fake.old=old;fake.source={};await extractEditorSegment({inputPath:fake.input,outputPath:fake.output,startSec:.1,endSec:.7});
  expect((await readFile(fake.output)).toString()).toBe("old output");
});
it("selected wrapper preserves legacy success on optional diagnostic timeout", async () => {
  fake.fault="probe";fake.source={};await extractEditorSegment({inputPath:fake.input,outputPath:fake.output,startSec:.1,endSec:.7});
  expect((await readFile(fake.output)).toString()).toBe("old output");
});
it("proven missing video with unknown source becomes an explicit error and removes the unusable selected output", async () => {
  fake.source={};fake.old={streams:[]};
  await expect(extractEditorSegment({inputPath:fake.input,outputPath:fake.output,startSec:.1,endSec:.7})).rejects.toThrow("映像");
  expect(await readdir(dir)).toEqual(["input.mp4"]);
});
