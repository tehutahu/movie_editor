import { spawn } from "node:child_process";

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

export async function assertFfmpegAvailable(): Promise<{
  ffmpeg: string;
  ffprobe: string;
}> {
  const ffmpegProbe = await run("ffmpeg", ["-version"]);
  const ffprobeProbe = await run("ffprobe", ["-version"]);

  if (ffmpegProbe.exitCode !== 0) {
    throw new Error("ffmpeg が見つからないか、実行に失敗しました。");
  }
  if (ffprobeProbe.exitCode !== 0) {
    throw new Error("ffprobe が見つからないか、実行に失敗しました。");
  }

  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
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
  const probe = await run("ffprobe", [
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

async function ffmpegFailFast(args: readonly string[]): Promise<void> {
  const result = await run("ffmpeg", args);
  if (result.exitCode !== 0) {
    throw new Error(
      `ffmpeg が失敗しました（exit=${result.exitCode}）:\n${result.stderr.trim().slice(-4000)}`,
    );
  }
}

/** `restore_speed.sh` と同等: setpts / asetrate+aresample */
export async function restoreSpeedSameAsShell(params: {
  inputPath: string;
  outputPath: string;
  speedFactor: number;
  sampleRateHz: number;
  hasAudioHint?: boolean | undefined;
}): Promise<void> {
  const speed = params.speedFactor;
  const sr = params.sampleRateHz;

  let hasAudio = params.hasAudioHint;

  // ヒント無しでも ffprobe が取れれば自動判定する
  if (typeof hasAudio !== "boolean") {
    let info: ProbeInfo;
    try {
      info = await probeVideo(params.inputPath);
      hasAudio = info.hasAudio;
    } catch {
      hasAudio = true;
    }
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
    ]);
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
  ]);
}

export async function extractSegmentTimes(params: {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
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
  ]);
}

function escapeConcatDemuxerSingleQuotedPath(absPath: string): string {
  // concat demuxer: file 'PATH'
  // PATH 内部のシングルクォートは '\'' でエスケープ
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
  /** すべての入力セグメントに音声が無いことが分かっているなら false */
  outputHasAudio: boolean;
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
  ]);
}
