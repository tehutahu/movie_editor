import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { containAudioSeekFromProbe, containAudioSampleRange, containWavSamplesFromProbe, verifiedEmptyContainWav, runBoundedAudioAux, AudioAuxAbort, inspectContainWav, repairContainAudio, containAudioInputIdentity } from "./containAudioRepair";
import type { FfProbeJson } from "./ffmpeg";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function dir() { const d = await mkdtemp(path.join(tmpdir(), "audio-repair-unit-")); dirs.push(d); return d; }
function raw(): FfProbeJson { return { format: { start_time: "0" }, streams: [
  { codec_type: "video", start_time: "2", start_pts: 30720, time_base: "1/15360" },
  { codec_type: "audio", start_time: "0", start_pts: 0, time_base: "1/44100", duration_ts: 61740, duration: "1.4" },
] }; }
function wavProbe(n: unknown): FfProbeJson { return { streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 2, bits_per_sample: 16, time_base: "1/48000", duration_ts: n as number }] }; }
function chunk(id: string, data: Buffer) { const b = Buffer.alloc(8 + data.length + data.length % 2); b.write(id); b.writeUInt32LE(data.length, 4); data.copy(b, 8); return b; }
function empty(info = true) {
 const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1); fmt.writeUInt16LE(2, 2); fmt.writeUInt32LE(48000, 4); fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(16, 14);
 const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), ...(info ? [chunk("LIST", Buffer.concat([Buffer.from("INFO"), chunk("ISFT", Buffer.from("Lavf61.1.100\0"))]))] : []), chunk("data", Buffer.alloc(0))]);
 const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
it("metadata requires explicit single-stream origins and consistent actual audio duration", () => {
 expect(containAudioSeekFromProbe(raw())).not.toBeNull();
 for (const modify of [
  (r:FfProbeJson)=>{r.format!.start_time=undefined;}, (r:FfProbeJson)=>{r.streams![0].start_time="";},
  (r:FfProbeJson)=>{r.streams![0].start_time="0";}, (r:FfProbeJson)=>{r.streams![0].start_pts=0;},
  (r:FfProbeJson)=>{r.streams![1].start_pts=1;}, (r:FfProbeJson)=>{r.streams![1].duration="0.5";},
  (r:FfProbeJson)=>{r.streams![1].duration_ts=NaN;}, (r:FfProbeJson)=>{r.streams!.push({...r.streams![1]});},
  (r:FfProbeJson)=>{r.streams!.pop();},
 ]) { const r=raw();modify(r);expect(containAudioSeekFromProbe(r)).toBeNull(); }
});
it("Darg thresholds use exact decimal floor/ceil, including exponent and extreme short ranges", () => {
 expect(containAudioSampleRange("1.4")).toMatchObject({low:BigInt(67199),high:BigInt(67201)});
 expect(containAudioSampleRange("0.05001")).toMatchObject({low:BigInt(2399),high:BigInt(2402)});
 expect(containAudioSampleRange("2e-5")).toMatchObject({low:BigInt(0),high:BigInt(2)});
 expect(containAudioSampleRange("0.000020833333333333334")).toMatchObject({low:BigInt(0),high:BigInt(3)});
 for(const s of ["", "NaN", "Infinity", "-1", "0", "1e99999999"]) expect(containAudioSampleRange(s)).toBeNull();
});
it("WAV probe counts stereo sample-frames exactly and refuses ambiguous zero, invalid types, fractional ticks, impossible size",()=>{
 expect(containWavSamplesFromProbe(wavProbe(1098),4470)).toBe(BigInt(1098));
 expect(containWavSamplesFromProbe(wavProbe("67200"),268878)).toBe(BigInt(67200));
 for(const n of [undefined,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,"N/A","0"]) expect(containWavSamplesFromProbe(wavProbe(n),10000)).toBeNull();
 const p=wavProbe(1);p.streams![0].time_base="1/44100";expect(containWavSamplesFromProbe(p,10000)).toBeNull();
 expect(containWavSamplesFromProbe(wavProbe(100),399)).toBeNull();
 const wrong=wavProbe(10);wrong.streams![0].channels=1;expect(containWavSamplesFromProbe(wrong,1000)).toBeNull();
});
it("strict empty parser accepts generated PCM fmt/optional INFO ISFT/data0 only",()=>{
 expect(verifiedEmptyContainWav(empty())).toBe(true);expect(verifiedEmptyContainWav(empty(false))).toBe(true);
 for(const mutate of [
  (b:Buffer)=>b.write("RF64"), (b:Buffer)=>b.writeUInt32LE(0xffffffff,4),
  (b:Buffer)=>b.writeUInt16LE(65534,20), (b:Buffer)=>b.write("wavl",44),
  (b:Buffer)=>b.write("IART",48), (b:Buffer)=>b.writeUInt32LE(0xffffffff,52),
  (b:Buffer)=>b.write("slnt",b.length-8), (b:Buffer)=>b.writeUInt32LE(1,b.length-4),
 ]) {const b=empty();mutate(b);expect(verifiedEmptyContainWav(b)).toBe(false);}
 expect(verifiedEmptyContainWav(empty().subarray(0,-1))).toBe(false);
 expect(verifiedEmptyContainWav(Buffer.concat([empty(),Buffer.alloc(2)]))).toBe(false);
 expect(verifiedEmptyContainWav(Buffer.alloc(65537))).toBe(false);
});
it("empty diagnostic is same-file bounded and rejects symlink/unknown tiny WAV",async()=>{
 const d=await dir(),f=path.join(d,"empty.wav");await writeFile(f,empty());expect(await inspectContainWav(f)).toBe(BigInt(0));
 const link=path.join(d,"link.wav");await symlink(f,link);expect(await inspectContainWav(link)).toBeNull();
 await writeFile(f,Buffer.alloc(78));expect(await inspectContainWav(f)).toBeNull();
});
it("aux runner bounds output, kills timeout including TERM-resistant children, and propagates caller abort",async()=>{
 expect(await runBoundedAudioAux(process.execPath,["-e","process.stdout.write('ok')"],{timeoutMs:1000})).toBe("ok");
 await expect(runBoundedAudioAux(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{timeoutMs:100,termMs:20})).rejects.toThrow("timeout");
 await expect(runBoundedAudioAux(process.execPath,["-e","process.stdout.write('x'.repeat(1000))"],{timeoutMs:1000,outputBytes:100})).rejects.toThrow("output limit");
 const a=new AbortController();const pending=runBoundedAudioAux(process.execPath,["-e","setInterval(()=>{},1000)"],{timeoutMs:1000,signal:a.signal});a.abort();await expect(pending).rejects.toBeInstanceOf(AudioAuxAbort);
},5000);
it("ineligible source/coverage and unavailable auxiliary probe retain old bytes and do not create a candidate",async()=>{
 const d=await dir(),oldFile=path.join(d,"old.wav"),retryFile=path.join(d,"retry.wav"),input=path.join(d,"source.mp4");await writeFile(oldFile,empty());await writeFile(input,"not real media");const descriptor={...containAudioSeekFromProbe(raw())!,inputIdentity:await containAudioInputIdentity(input)};
 for(const sourceIn of [1e-12,1]) expect((await repairContainAudio({input,sourceIn,durationArg:"1.4",descriptor,oldFile,retryFile})).status).toBe("ineligible");
 expect((await repairContainAudio({input,sourceIn:0,durationArg:"2",descriptor,oldFile,retryFile})).status).toBe("ineligible");
 expect((await repairContainAudio({input,sourceIn:0,durationArg:"1.4",descriptor,oldFile,retryFile})).status).toBe("fallback");
 expect(await readFile(oldFile)).toEqual(empty());await expect(access(retryFile)).rejects.toThrow();
 const a=new AbortController();a.abort();await expect(repairContainAudio({input,sourceIn:0,durationArg:"1.4",descriptor:null,oldFile,retryFile,signal:a.signal})).rejects.toBeInstanceOf(AudioAuxAbort);
});
