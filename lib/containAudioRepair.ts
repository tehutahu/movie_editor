/** Best-effort repair of a proven short, already-successful contain audio WAV.
 * This never changes source seconds or the initial (legacy) extraction. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, unlink, readdir, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolveFfmpegPath, resolveFfprobePath, type FfProbeJson } from "./ffmpeg";

type Rational = { n: bigint; d: bigint };
const mul = (a: Rational, b: Rational): Rational => ({ n: a.n * b.n, d: a.d * b.d });
const sub = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const add = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const ceilMicros = (a: Rational): Rational => ({ n: (a.n * BigInt(1_000_000) + a.d - BigInt(1)) / a.d, d: BigInt(1_000_000) });
const compare = (a: Rational, b: Rational) => a.n * b.d - b.n * a.d;
const abs = (a: Rational): Rational => ({ n: a.n < BigInt(0) ? -a.n : a.n, d: a.d });
function integer(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  return typeof value === "string" && /^-?\d{1,40}$/.test(value) ? BigInt(value) : null;
}
function decimal(value: unknown): Rational | null {
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(Number(value))) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!m) return null;
  const exponent = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (Math.abs(exponent) > 400) return null;
  const n = BigInt(`${m[1]}${m[2]}${m[3] ?? ""}`);
  return exponent >= 0 ? { n: n * BigInt(10) ** BigInt(exponent), d: BigInt(1) } : { n, d: BigInt(10) ** BigInt(-exponent) };
}
function timeBase(value: unknown): Rational | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,20})\/(\d{1,20})$/.exec(value);
  if (!m || BigInt(m[1]) <= BigInt(0) || BigInt(m[2]) <= BigInt(0)) return null;
  return { n: BigInt(m[1]), d: BigInt(m[2]) };
}
export type ContainAudioSeek = { audioDuration: Rational; inputIdentity?: { file: string; stat: Stats } };
/** Shared strict duration/coverage for optional AV diagnostics. Keep arithmetic
 * rational until both endpoints have been conservatively quantized to µs. */
export function verifiedClockDuration(stream: { duration_ts?: number | string; duration?: string; time_base?: string }): Rational | null {
  const ticks = integer(stream.duration_ts), tb = timeBase(stream.time_base), text = decimal(stream.duration);
  if (ticks === null || ticks <= BigInt(0) || !tb || !text || text.n <= BigInt(0)) return null;
  const duration = mul({ n: ticks, d: BigInt(1) }, tb);
  return compare(abs(sub(duration, text)), tb) <= BigInt(0) ? duration : null;
}
export function verifiedClockRangeCovered(limit: Rational, startArg: string, durationArg: string): boolean {
  const start = decimal(startArg), duration = decimal(durationArg);
  if (!start || start.n < BigInt(0) || !duration || duration.n <= BigInt(0)) return false;
  return compare(limit, add(ceilMicros(start), ceilMicros(duration))) >= BigInt(0);
}
export async function containAudioInputIdentity(file: string) {
  try { const stat = await lstat(file); return stat.isFile() ? { file, stat } : undefined; } catch { return undefined; }
}
export async function sameContainAudioInput(identity: NonNullable<ContainAudioSeek["inputIdentity"]>) {
  try { return sameFile(identity.stat, await lstat(identity.file)); } catch { return false; }
}
/** Narrow metadata is necessary, never sufficient: the old WAV is still tested. */
export function containAudioSeekFromProbe(raw: FfProbeJson): ContainAudioSeek | null {
  const videos = raw.streams?.filter(s => s.codec_type === "video") ?? [];
  const audios = raw.streams?.filter(s => s.codec_type === "audio") ?? [];
  if (videos.length !== 1 || audios.length !== 1) return null;
  const v = videos[0], a = audios[0];
  const vs = decimal(v.start_time), as = decimal(a.start_time), fs = decimal(raw.format?.start_time);
  const vp = integer(v.start_pts), ap = integer(a.start_pts), vt = timeBase(v.time_base), at = timeBase(a.time_base);
  if (!vs || vs.n <= BigInt(0) || !as || as.n !== BigInt(0) || !fs || fs.n !== BigInt(0) || vp === null || ap !== BigInt(0) || !vt || !at) return null;
  if (compare(abs(sub(vs, mul({ n: vp, d: BigInt(1) }, vt))), vt) > BigInt(0)) return null;
  const ticks = integer(a.duration_ts), text = decimal(a.duration);
  const duration = ticks !== null && ticks > BigInt(0) ? mul({ n: ticks, d: BigInt(1) }, at) : text;
  if (!duration || duration.n <= BigInt(0)) return null;
  if (a.duration_ts !== undefined && (ticks === null || ticks <= BigInt(0))) return null;
  if (a.duration !== undefined && (!text || text.n <= BigInt(0) || compare(abs(sub(duration, text)), at) > BigInt(0))) return null;
  return { audioDuration: duration };
}
export function containAudioSampleRange(durationArg: string): { low: bigint; high: bigint; duration: Rational } | null {
  const duration = decimal(durationArg);
  if (!duration || duration.n <= BigInt(0)) return null;
  const scaled = duration.n * BigInt(48000);
  const floor = scaled / duration.d, ceil = (scaled + duration.d - BigInt(1)) / duration.d;
  return { low: floor > BigInt(0) ? floor - BigInt(1) : BigInt(0), high: ceil + BigInt(1), duration };
}

/** Local auxiliary budgets only; mandatory ffmpeg/probe runners are unchanged.
 * A timeout is an unrepaired fallback, not a media rejection or speed guarantee. */
export const CONTAIN_AUDIO_AUX_BUDGET = { probeMs: 5000, retryMs: 30000, termMs: 1000, outputBytes: 1024 * 1024 } as const;
export class AudioAuxCleanupError extends Error { constructor() { super("Audio auxiliary process cleanup unconfirmed"); } }
export class AudioAuxAbort extends Error { constructor() { super("Audio repair caller aborted"); this.name = "AbortError"; } }
export async function runBoundedAudioAux(command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; termMs?: number; outputBytes?: number }): Promise<string> {
  if (options.signal?.aborted) throw new AudioAuxAbort();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error; }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), options.termMs ?? CONTAIN_AUDIO_AUX_BUDGET.termMs);
    };
    const abort = () => stop(new AudioAuxAbort());
    const timer = setTimeout(() => stop(new Error("Audio auxiliary timeout")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Drain both pipes even after their bounded retained output overflows.
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= (options.outputBytes ?? CONTAIN_AUDIO_AUX_BUDGET.outputBytes)) output += chunk.toString();
      else stop(new Error("Audio auxiliary output limit"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.outputBytes ?? CONTAIN_AUDIO_AUX_BUDGET.outputBytes)) stop(new Error("Audio auxiliary output limit"));
    });
    child.once("error", error => { failure = error; });
    // close follows process exit AND pipe closure; never race a live child.
    child.once("close", async code => {
      clearTimeout(timer);
      // Leader close does not prove descendants exited (they can close stdio).
      // Only inspect our owned pgid. Zombies cannot run or hold media handles.
      const liveGroup = async () => {
        if (!child.pid || process.platform !== "linux") return false;
        try { process.kill(-child.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
            if (Number(fields[2]) === child.pid && fields[0] !== "Z" && fields[0] !== "X") return true;
          } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
        return false;
      };
      try {
        if (await liveGroup()) {
          failure ??= new Error("Audio auxiliary left a live descendant");
          kill("SIGKILL");
          const deadline = Date.now() + (options.termMs ?? CONTAIN_AUDIO_AUX_BUDGET.termMs);
          while (await liveGroup()) {
            if (Date.now() >= deadline) throw new AudioAuxCleanupError();
            await new Promise(r => setTimeout(r, 10));
          }
        }
      } catch { failure = new AudioAuxCleanupError(); }
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(new AudioAuxAbort());
      else if (failure || code !== 0) reject(failure ?? new Error(`Audio auxiliary exit ${code}`));
      else resolve(output);
    });
    if (options.signal?.aborted) abort();
  });
}

function sameFile(a: Stats, b: Stats) { return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
/** Only our exact, bounded empty RIFF shape. This is not a general WAV reader. */
export function verifiedEmptyContainWav(b: Buffer): boolean {
  if (b.length < 44 || b.length > 65536 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE" || b.readUInt32LE(4) + 8 !== b.length) return false;
  let p = 12;
  const chunk = () => {
    if (p + 8 > b.length) return null;
    const kind = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4), start = p + 8;
    const end = start + size, padded = end + size % 2;
    if (padded > b.length || size === 0xffffffff) return null;
    p = padded; return { kind, size, start, end };
  };
  const fmt = chunk();
  if (!fmt || fmt.kind !== "fmt " || fmt.size !== 16) return false;
  const f = fmt.start;
  if (b.readUInt16LE(f) !== 1 || b.readUInt16LE(f + 2) !== 2 || b.readUInt32LE(f + 4) !== 48000 || b.readUInt32LE(f + 8) !== 192000 || b.readUInt16LE(f + 12) !== 4 || b.readUInt16LE(f + 14) !== 16) return false;
  let data = chunk();
  if (data?.kind === "LIST") {
    if (data.size < 12 || b.toString("ascii", data.start, data.start + 4) !== "INFO" || b.toString("ascii", data.start + 4, data.start + 8) !== "ISFT") return false;
    const size = b.readUInt32LE(data.start + 8);
    if (size === 0xffffffff || data.start + 12 + size + size % 2 !== data.end) return false;
    data = chunk();
  }
  return !!data && data.kind === "data" && data.size === 0 && p === b.length;
}
export function containWavSamplesFromProbe(probe: FfProbeJson, size: number): bigint | null {
  if (probe.streams?.length !== 1) return null;
  const a = probe.streams[0];
  if (a.codec_type !== "audio" || a.codec_name !== "pcm_s16le" || a.sample_rate !== "48000" || a.channels !== 2 || a.bits_per_sample !== 16) return null;
  const ticks = integer(a.duration_ts), tb = timeBase(a.time_base);
  if (ticks === null || ticks <= BigInt(0) || !tb) return null; // zero needs RIFF proof
  const numerator = ticks * tb.n * BigInt(48000);
  if (numerator % tb.d !== BigInt(0)) return null;
  const n = numerator / tb.d;
  return n <= BigInt(Number.MAX_SAFE_INTEGER) && n * BigInt(4) <= BigInt(size) ? n : null;
}
async function inspectContainWavInternal(file: string, signal?: AbortSignal): Promise<bigint | null> {
  if (signal?.aborted) throw new AudioAuxAbort();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!constants.O_NOFOLLOW) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size)) return null;
    let samples: bigint | null = null;
    if (before.size <= 65536) {
      const buffer = Buffer.alloc(before.size);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead === before.size && verifiedEmptyContainWav(buffer)) samples = BigInt(0);
    }
    if (samples === null) {
      const output = await runBoundedAudioAux(resolveFfprobePath(), ["-v", "error", "-show_streams", "-of", "json", file], { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal });
      samples = containWavSamplesFromProbe(JSON.parse(output) as FfProbeJson, before.size);
    }
    const stable = sameFile(before, await handle.stat()) && sameFile(before, await lstat(file));
    if (signal?.aborted) throw new AudioAuxAbort();
    return stable ? samples : null;
  } catch (error) {
    if (error instanceof AudioAuxCleanupError) throw error;
    if (signal?.aborted || error instanceof AudioAuxAbort) throw new AudioAuxAbort();
    return null;
  } finally { await handle?.close(); }
}

export async function inspectContainWav(file: string, signal?: AbortSignal): Promise<bigint | null> {
  const result = await inspectContainWavInternal(file, signal);
  if (signal?.aborted) throw new AudioAuxAbort();
  return result;
}

export type AudioRepairResult = { file: string; status: "ineligible" | "unknown" | "healthy" | "fallback" | "repaired"; oldSamples?: bigint; newSamples?: bigint };
async function repairContainAudioInternal(params: { input: string; sourceIn: number; sourceInArg?: string; durationArg: string; descriptor: ContainAudioSeek | null; oldFile: string; retryFile: string; signal?: AbortSignal }): Promise<AudioRepairResult> {
  const { input, sourceIn, durationArg, descriptor, oldFile, retryFile, signal } = params;
  const original = (status: AudioRepairResult["status"], oldSamples?: bigint): AudioRepairResult => ({ file: oldFile, status, oldSamples });
  if (signal?.aborted) throw new AudioAuxAbort();
  const range = containAudioSampleRange(durationArg);
  // Nonzero cuts reuse the original renderer's nine-decimal argument. Allow
  // for ffmpeg's microsecond parse quantization conservatively at both endpoints.
  const startArg = params.sourceInArg ?? (sourceIn === 0 ? "0" : undefined);
  const start = startArg !== undefined && /^\d+(?:\.\d{1,9})?$/.test(startArg) ? decimal(startArg) : null;
  if (!Number.isFinite(sourceIn) || sourceIn < 0 || !start ||
      Number(startArg) !== Number(sourceIn.toFixed(9)) ||
      !descriptor || !range || range.low === BigInt(0) ||
      compare(descriptor.audioDuration, start.n === BigInt(0) ? range.duration : add(ceilMicros(start), ceilMicros(range.duration))) < BigInt(0)) return original("ineligible");
  if (!descriptor.inputIdentity || descriptor.inputIdentity.file !== input || !await sameContainAudioInput(descriptor.inputIdentity)) return original("ineligible");
  if (signal?.aborted) throw new AudioAuxAbort();
  const oldSamples = await inspectContainWav(oldFile, signal);
  if (signal?.aborted) throw new AudioAuxAbort();
  if (oldSamples === null) return original("unknown");
  if (oldSamples >= range.low) return original("healthy", oldSamples);
  if (!await sameContainAudioInput(descriptor.inputIdentity)) return original("fallback", oldSamples);
  if (signal?.aborted) throw new AudioAuxAbort();
  let accepted = false;
  try {
    await runBoundedAudioAux(resolveFfmpegPath(), ["-y", "-i", input,
      ...(start.n > BigInt(0) ? ["-ss", startArg!] : []),
      "-vn", "-af", "aresample=48000,apad", "-ac", "2", "-ar", "48000", "-t", durationArg, "-c:a", "pcm_s16le", retryFile], { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.retryMs, signal });
    const newSamples = await inspectContainWav(retryFile, signal);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (!await sameContainAudioInput(descriptor.inputIdentity)) return original("fallback", oldSamples);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (newSamples !== null && newSamples > oldSamples && newSamples >= range.low && newSamples <= range.high) {
      accepted = true; return { file: retryFile, status: "repaired", oldSamples, newSamples };
    }
    return original("fallback", oldSamples);
  } catch (error) {
    if (error instanceof AudioAuxCleanupError) throw error;
    if (signal?.aborted || error instanceof AudioAuxAbort) throw new AudioAuxAbort();
    return original("fallback", oldSamples);
  } finally {
    if (!accepted) await unlink(retryFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** Final boundary checks also cover aborts during filesystem awaits/early exits. */
export async function repairContainAudio(params: Parameters<typeof repairContainAudioInternal>[0]): Promise<AudioRepairResult> {
  try {
    const result = await repairContainAudioInternal(params);
    if (params.signal?.aborted) throw new AudioAuxAbort();
    return result;
  } catch (error) {
    if (params.signal?.aborted || error instanceof AudioAuxAbort) {
      await unlink(params.retryFile).catch(cleanup => { if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup; });
      throw new AudioAuxAbort();
    }
    throw error;
  }
}
