import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSegmentTimes, probeMedia, resolveFfmpegPath } from "./ffmpeg";
import { extractEditorSegment, incompleteSourceAvSegment, repairSourceAvSegment, sourceAudioSample } from "./sourceAvClock";
import { exportCompositionToFile } from "./exportComposition";
import { createEmptyProject } from "./editor/project";
import type { Asset, MediaClip } from "./editor/types";
const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => sources.get(a.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string, input: string, zero: string, variable: string, variableZero: string, earlyVariable: string;
function ff(args: string[]) { return execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 }); }
beforeAll(async () => {
  if (!real) return;
  dir = await mkdtemp(path.join(tmpdir(), "source-av-clock-")); input = path.join(dir, "delayed.mp4"); zero = path.join(dir, "zero.mp4");
  const v = path.join(dir, "video.mp4");
  ff(["-f", "lavfi", "-i", "color=red:s=64x64:r=30:d=0.5", "-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=1.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-bf", "0", v]);
  for (const [file, offset] of [[input, "2"], [zero, "0"]]) ff(["-itsoffset", offset, "-i", v, "-f", "lavfi", "-i", "aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=44100:d=1.4", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", file]);
  const vfr = path.join(dir,"variable-video.mp4"); variable=path.join(dir,"variable.mp4");variableZero=path.join(dir,"variable-zero.mp4");
  ff(["-i",v,"-vf","select=if(lt(t\\,0.5)\\,not(mod(n\\,2))\\,1)","-fps_mode","vfr","-c:v","libx264","-bf","0",vfr]);
  for(const [file,offset] of [[variable,"2"],[variableZero,"0"]]) ff(["-itsoffset",offset,"-i",vfr,"-i",input,"-map","0:v:0","-map","1:a:0","-c","copy",file]);
  const early=path.join(dir,"early-vfr-video.mp4");earlyVariable=path.join(dir,"early-variable.mp4");
  // Retain the last pair at 30Hz too: bundled encoders otherwise infer a
  // non-grid duration for the final packet, which is correctly ineligible.
  ff(["-i",v,"-vf","drawbox=color=blue:t=fill:enable=gte(n\\,1),select=if(lt(t\\,0.5)\\,1\\,not(mod(n\\,2))+eq(n\\,59))","-fps_mode","vfr","-c:v","libx264","-bf","0",early]);
  ff(["-itsoffset","2","-i",early,"-i",input,"-map","0:v:0","-map","1:a:0","-c","copy",earlyVariable]);
}, 30000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
function rms(pcm: Buffer, a: number, b: number) {
  let sum = 0; for (let n = Math.round(a * 48000); n < Math.round(b * 48000); n++) sum += pcm.readInt16LE(n * 2) ** 2;
  return Math.sqrt(sum / Math.round((b - a) * 48000));
}
function oracle(file: string, shift: number, duration=.7) {
  ff(["-xerror", "-i", file, "-f", "null", "-"]);
  // Decode every frame without seeking: distinguish a product cadence error
  // (including ffmpeg 6.1 settb quantization) from decoder seek behavior.
  // Composition output also includes the project's later empty background.
  const frames = ff(["-i", file, "-t", String(duration), "-vf", "crop=iw/2:ih/2,scale=1:1", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  expect(frames.length).toBe(Math.ceil(duration * 30) * 3);
  for (let i=0; i<frames.length/3; i++) {
    const channel = shift+i/30 < .5-1e-9 ? 0 : 2;
    expect(frames[i*3+channel], `frame ${i}, source ${shift+i/30}`).toBeGreaterThan(220);
    expect(frames[i*3+(channel===0?2:0)]).toBeLessThan(25);
  }
  const pcm = ff(["-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  expect(rms(pcm, .502 - shift, .518 - shift)).toBeGreaterThan(4000);
  expect(rms(pcm, .3 - shift, .32 - shift)).toBeLessThan(1500);
  for (const [t, channel] of [[.3 - shift, 0], [.5 - shift, 2]]) {
    const rgb = ff(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=iw/2:ih/2,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    expect(rgb.length).toBe(3); expect(rgb[channel]).toBeGreaterThan(220); expect(rgb[channel === 0 ? 2 : 0]).toBeLessThan(25);
  }
}
async function selectedOracle(source: string, name: string, start: number, expectedSample: number, boundary=.5) {
  const before = await readFile(source), old = path.join(dir, `${name}-old-${start}.mp4`), out = path.join(dir, `${name}-selected-${start}.mp4`);
  await extractSegmentTimes({ inputPath: source, outputPath: old, startSec: start, endSec: start + .7 });
  // System ffmpeg emits no streams; bundled emits video but loses audio.
  expect(incompleteSourceAvSegment(await probeMedia(old), .7)).toBe(true);
  await extractEditorSegment({ inputPath: source, outputPath: out, startSec: start, endSec: start + .7 });
  if (start < .3 && boundary===.5) oracle(out, start);
  if(boundary!==.5 || start>=.499999 && start<=.500001){
    const rgb=ff(["-i",out,"-frames:v","1","-vf","scale=1:1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]);
    expect(rgb[start<boundary?0:2]).toBeGreaterThan(220);
  }
  expect((await readFile(source)).equals(before)).toBe(true);
  // Independent PCM oracle: full source decode, integer byte slice, then the
  // same lossy output codec. Compare decoded output bytes, not just RMS/count.
  const full = ff(["-i", source, "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  const raw = path.join(dir, `oracle-${start}.pcm`), reference = path.join(dir, `oracle-${start}.m4a`);
  expect(sourceAudioSample(start)).toBe(expectedSample);
  await writeFile(raw, full.subarray(expectedSample * 8, (expectedSample + 33600) * 8));
  ff(["-f", "f32le", "-ac", "2", "-ar", "48000", "-i", raw, "-af", "apad", "-t", "0.7", "-c:a", "aac", reference]);
  const decode = (file: string) => ff(["-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  const actual = decode(out), expected = decode(reference);
  expect(actual.length).toBe(expected.length);
  expect(actual.equals(expected)).toBe(true);
}
it.skipIf(!real).each([[0,0],[.1,4800],[1/30,1600],[.500010416,24000],[.500010417,24000],[.500020833,24001],[.500020834,24001]])("CFR selected source %s fixed frame/PCM oracle at sample %s", async (start, sample) => {
  await selectedOracle(input,"cfr",start,sample);
},30000);
it.skipIf(!real).each([[0,0],[.1,4800],[1/30,1600],[.499999,24000],[.5,24000],[.500001,24000]])("1/2-tick VFR selected source %s fixed frame/PCM oracle at sample %s", async (start,sample)=>{
  await selectedOracle(variable,"vfr",start,sample);
},30000);
it.skipIf(!real).each([1/30-.000001,1/30,1/30+.000001])("fractional-microsecond frame boundary source %s keeps its correct side and exact PCM",async start=>{
  await selectedOracle(earlyVariable,"early-vfr",start,1600,1/30);
},30000);
it.skipIf(!real)("zero-origin and eligible healthy output retain identical encoded bytes", async () => {
  for (const source of [zero, input, variable, variableZero]) {
    const out = path.join(dir, "healthy.mp4");
    // A complete old output is authoritative regardless of source eligibility.
    await extractSegmentTimes({ inputPath: zero, outputPath: out, startSec: .1, endSec: .7 });
    const before = await readFile(out);
    expect(await repairSourceAvSegment({ input: source, output: out, start: .1, end: .7 })).toBe(false);
    expect(await readFile(out)).toEqual(before);
  }
});
it.skipIf(!real)("packet EOF keeps old output when actual video is shorter than the requested range, including old probe overreporting", async () => {
  const short = path.join(dir,"short-video.mp4"), out = path.join(dir,"short-old.mp4");
  ff(["-itsoffset","2","-t","0.5","-i",path.join(dir,"video.mp4"),"-i",input,"-map","0:v:0","-map","1:a:0","-c","copy",short]);
  await extractSegmentTimes({inputPath:short,outputPath:out,startSec:.1,endSec:.7});
  const before=await readFile(out);
  expect(await repairSourceAvSegment({input:short,output:out,start:.1,end:.7})).toBe(false);
  expect((await readFile(out)).equals(before)).toBe(true);
});
it.skipIf(!real).each([[false,false],[true,false],[false,true],[true,true]])("stretch multipart=%s VFR=%s aligns video/audio without changing saved source values", async (multi,vfr) => {
  const p = createEmptyProject(); p.compositionWidth = 320; p.compositionHeight = 320;
  const a: Asset = { id: "av", kind: "video", ext: "mp4", displayName: "av", streamUrl: "/x", sourceDurationSec: 4, width: 64, height: 64 };
  sources.set(a.id, vfr?variable:input); p.assets = [a];
  const clip: MediaClip = { id: "clip", trackId: p.tracks[0].id, timelineStartSec: 0, durationSec: .6, transform: { x: .5, y: .5, scale: 1 },
    parts: multi ? [{ assetId: a.id, sourceInSec: .1, sourceOutSec: .4 }, { assetId: a.id, sourceInSec: .4, sourceOutSec: .7 }] : [{ assetId: a.id, sourceInSec: .1, sourceOutSec: .7 }] };
  p.clips = [clip]; const before = JSON.stringify(p);
  const jobDir = path.join(dir, `stretch-${multi}-${vfr}`); await mkdir(jobDir);
  const out = path.join(jobDir, "out.mp4"); await exportCompositionToFile({ project: p, jobDir, outputPath: out });
  oracle(out, .1, .6); expect(JSON.stringify(p)).toBe(before);
  expect((await readdir(jobDir)).filter(s => s.endsWith(".mp4"))).toEqual(["out.mp4"]);
}, 30000);
