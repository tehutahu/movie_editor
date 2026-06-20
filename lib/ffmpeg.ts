import { spawn } from "node:child_process";
import path from "node:path";

export type ProbeInfo = {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
};

type CmdResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ProgressInfo = {
  progressPct?: number;
  etaSec?: number;
};

let resolvedFfmpeg: string | null = null;
let resolvedFfprobe: string | null = null;

export function resolveFfmpegPath(): string {
  if (resolvedFfmpeg) return resolvedFfmpeg;
  if (process.env.FFMPEG_PATH) {
    resolvedFfmpeg = process.env.FFMPEG_PATH;
    return resolvedFfmpeg;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require("ffmpeg-static") as string | null;
    if (ffmpegStatic) {
      resolvedFfmpeg = path.resolve(ffmpegStatic);
      return resolvedFfmpeg;
    }
  } catch {
    // fall through to PATH
  }
  resolvedFfmpeg = "ffmpeg";
  return resolvedFfmpeg;
}

export function resolveFfprobePath(): string {
  if (resolvedFfprobe) return resolvedFfprobe;
  if (process.env.FFPROBE_PATH) {
    resolvedFfprobe = process.env.FFPROBE_PATH;
    return resolvedFfprobe;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeStatic = require("ffprobe-static") as { path: string };
    if (ffprobeStatic?.path) {
      resolvedFfprobe = path.resolve(ffprobeStatic.path);
      return resolvedFfprobe;
    }
  } catch {
    // fall through
  }
  resolvedFfprobe = "ffprobe";
  return resolvedFfprobe;
}

function run(cmd: string, args: readonly string[]): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer | string) => {
      stdout += typeof d === "string" ? d : d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8");
    });
    proc.once("error", reject);
    proc.once("close", (code) =>
      resolve({ exitCode: code, stdout, stderr }),
    );
  });
}

/** ffmpeg -progress の out_time_ms は名前に反してマイクロ秒単位 */
function parseProgressOutTimeSec(line: string): number | undefined {
  const m = /^out_time_ms=(\d+)$/.exec(line.trim());
  if (!m) return undefined;
  const micros = Number(m[1]);
  return Number.isFinite(micros) ? micros / 1_000_000 : undefined;
}

async function ffmpegFailFast(args: readonly string[], opts?: {
  totalDurationSec?: number;
  onProgress?: ((p: ProgressInfo) => void) | undefined;
}): Promise<void> {
  const ffmpegPath = resolveFfmpegPath();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-progress", "pipe:1", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let progressBuf = "";
    const startedAtMs = Date.now();

    proc.stdout.on("data", (d: Buffer | string) => {
      const chunk = typeof d === "string" ? d : d.toString("utf8");
      progressBuf += chunk;

      const lines = progressBuf.split(/\r?\n/);
      progressBuf = lines.pop() ?? "";

      for (const line of lines) {
        const outSec = parseProgressOutTimeSec(line);
        if (typeof outSec !== "number") continue;
        const totalSec = opts?.totalDurationSec;
        if (!totalSec || totalSec <= 0) {
          opts?.onProgress?.({});
          continue;
        }

        const pct = Math.max(0, Math.min(100, (outSec / totalSec) * 100));
        const elapsedSec = Math.max(0.001, (Date.now() - startedAtMs) / 1000);
        const speed = outSec / elapsedSec;
        const remainingInputSec = Math.max(0, totalSec - outSec);
        const etaSec = speed > 0 ? Math.ceil(remainingInputSec / speed) : undefined;

        opts?.onProgress?.({ progressPct: pct, etaSec });
      }
    });

    proc.stderr.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8");
    });

    proc.once("error", reject);
    proc.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg が失敗しました（exit=${code}）:
${stderr.trim().slice(-4000)}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export async function assertFfmpegAvailable(): Promise<{
  ffmpeg: string;
  ffprobe: string;
}> {
  const ffmpegPath = resolveFfmpegPath();
  const ffprobePath = resolveFfprobePath();
  const ffmpegProbe = await run(ffmpegPath, ["-version"]);
  const ffprobeProbe = await run(ffprobePath, ["-version"]);

  if (ffmpegProbe.exitCode !== 0) {
    throw new Error("ffmpeg が見つからないか、実行に失敗しました。");
  }
  if (ffprobeProbe.exitCode !== 0) {
    throw new Error("ffprobe が見つからないか、実行に失敗しました。");
  }

  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
}

type FfProbeJson = {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
  }[];
};

export async function probeVideo(inputPath: string): Promise<ProbeInfo> {
  const ffprobePath = resolveFfprobePath();
  const probe = await run(ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);

  if (probe.exitCode !== 0) {
    throw new Error(
      `ffprobe が失敗しました: ${probe.stderr.slice(0, 2000)}`.trim(),
    );
  }

  let json: FfProbeJson;
  try {
    json = JSON.parse(probe.stdout) as FfProbeJson;
  } catch {
    throw new Error("ffprobe のJSON解析に失敗しました。");
  }

  const durationRaw = Number(json.format?.duration ?? NaN);
  if (!Number.isFinite(durationRaw) || durationRaw <= 0) {
    throw new Error("動画の長さ(duration)が取得できませんでした。");
  }

  const streams = json.streams ?? [];
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const videoStream = streams.find((s) => s.codec_type === "video");

  return {
    durationSec: durationRaw,
    width: typeof videoStream?.width === "number" ? videoStream.width : undefined,
    height:
      typeof videoStream?.height === "number" ? videoStream.height : undefined,
    hasAudio,
    hasVideo: Boolean(videoStream),
  };
}

/** `restore_speed.sh` と同等: setpts / asetrate+aresample */
export async function restoreSpeedSameAsShell(params: {
  inputPath: string;
  outputPath: string;
  speedFactor: number;
  sampleRateHz: number;
  hasAudioHint?: boolean | undefined;
  onProgress?: ((p: ProgressInfo) => void) | undefined;
}): Promise<void> {
  const speed = params.speedFactor;
  const sr = params.sampleRateHz;

  let hasAudio = params.hasAudioHint;

  const info = await probeVideo(params.inputPath);

  // ヒント無しでも ffprobe が取れれば自動判定する
  if (typeof hasAudio !== "boolean") {
    hasAudio = info.hasAudio;
  }

  const pts = `[0:v]setpts=${speed}*PTS`;
  const maps: string[] = [];

  const baseArgs: string[] = [
    "-y",
    "-i",
    params.inputPath,
    "-movflags",
    "+faststart",
  ];

  if (hasAudio) {
    const filterComplex = `${pts}[v];[0:a]asetrate=${sr}/${speed},aresample=${sr}[a]`;
    maps.push("-map", "[v]", "-map", "[a]");
    await ffmpegFailFast([
      ...baseArgs,
      "-filter_complex",
      filterComplex,
      ...maps,
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-strict",
      "experimental",
      params.outputPath,
    ], {
      // setpts で出力タイムラインが speed 倍に伸びる
      totalDurationSec: info.durationSec * speed,
      onProgress: params.onProgress,
    });
    return;
  }

  const filterComplexMono = `${pts}[v]`;
  maps.push("-map", "[v]");
  await ffmpegFailFast([
    ...baseArgs,
    "-filter_complex",
    filterComplexMono,
    ...maps,
    "-c:v",
    "libx264",
    "-an",
    params.outputPath,
  ], {
    totalDurationSec: info.durationSec * speed,
    onProgress: params.onProgress,
  });
}

export async function extractSegmentTimes(params: {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  onProgress?: ((p: ProgressInfo) => void) | undefined;
}): Promise<void> {
  const durationSec = Math.max(0, params.endSec - params.startSec);
  const info = await probeVideo(params.inputPath);

  await ffmpegFailFast([
    "-y",
    "-ss",
    String(params.startSec),
    "-i",
    params.inputPath,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    ...(info.hasAudio ? ["-c:a", "aac"] : ["-an"]),
    "-movflags",
    "+faststart",
    params.outputPath,
  ], { totalDurationSec: durationSec, onProgress: params.onProgress });
}

function escapeConcatDemuxerSingleQuotedPath(absPath: string): string {
  return absPath.replaceAll("'", "'\\''");
}

export function buildConcatDemuxerListFile(entries: readonly string[]): string {
  let out = "";
  for (const fp of entries) {
    out += `file '${escapeConcatDemuxerSingleQuotedPath(fp)}'\n`;
  }
  return out;
}

export async function concatViaDemuxer(params: {
  listTxtAbsolutePath: string;
  outputPath: string;
  outputHasAudio: boolean;
  totalDurationSec?: number | undefined;
  onProgress?: ((p: ProgressInfo) => void) | undefined;
}): Promise<void> {
  await ffmpegFailFast([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    params.listTxtAbsolutePath,
    "-c:v",
    "libx264",
    ...(params.outputHasAudio ? (["-c:a", "aac"] as const) : (["-an"] as const)),
    "-movflags",
    "+faststart",
    params.outputPath,
  ], {
    totalDurationSec: params.totalDurationSec,
    onProgress: params.onProgress,
  });
}

/** Generate horizontal filmstrip JPEG for timeline thumbnails. */
export async function generateFilmstrip(params: {
  inputPath: string;
  outputPath: string;
  durationSec: number;
  frameCount?: number;
  thumbWidth?: number;
}): Promise<void> {
  const frameCount = params.frameCount ?? Math.min(20, Math.max(1, Math.ceil(params.durationSec)));
  const thumbWidth = params.thumbWidth ?? 160;
  const interval = params.durationSec / frameCount;

  await ffmpegFailFast([
    "-y",
    "-i",
    params.inputPath,
    "-vf",
    `fps=1/${Math.max(interval, 0.5)},scale=${thumbWidth}:-1,tile=${frameCount}x1`,
    "-frames:v",
    "1",
    "-q:v",
    "5",
    params.outputPath,
  ]);
}

/** Still image to timed video segment for export. */
export async function imageToVideoSegment(params: {
  inputPath: string;
  outputPath: string;
  durationSec: number;
}): Promise<void> {
  await ffmpegFailFast([
    "-y",
    "-loop",
    "1",
    "-i",
    params.inputPath,
    "-t",
    String(params.durationSec),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    params.outputPath,
  ], { totalDurationSec: params.durationSec });
}
