import type { Asset, Clip, EditorProject, Track } from "@/lib/editor/types";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import {
  clipsForExportComposition,
  COMPOSITION_BG_FFMPEG,
  getCompositionSize,
  resolveAudioTrackForExport,
  transformToPixelRect,
} from "@/lib/editor/compositor";
import {
  buildConcatDemuxerListFile,
  concatViaDemuxer,
  extractSegmentTimes,
  imageToVideoSegment,
  probeVideo,
  runFfmpegCommand,
} from "@/lib/ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_FFMPEG_FILTER_INT = 100_000;

/** Embed validated numbers in ffmpeg filter expressions (defense in depth). */
export function formatFfmpegFilterNumber(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("ffmpeg フィルタ数値が不正です。");
  }
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  const s = String(rounded);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error("ffmpeg フィルタ数値の形式が不正です。");
  }
  return s;
}

function formatFfmpegFilterInt(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("ffmpeg フィルタ整数が不正です。");
  }
  if (value < 0 || value > MAX_FFMPEG_FILTER_INT) {
    throw new Error("ffmpeg フィルタ整数が範囲外です。");
  }
  return String(value);
}

type ExportClipInput = {
  clip: Clip;
  asset: Asset;
  inputPath: string;
};

type PreparedClip = {
  path: string;
  clip: Clip;
  asset: Asset;
  inputIndex: number;
  rect: ReturnType<typeof transformToPixelRect>;
};

async function renderClipPartSegment(
  jobDir: string,
  clipIndex: number,
  partIndex: number,
  asset: Asset,
  part: Clip["parts"][number],
  inputPath: string,
): Promise<string> {
  const outPath = path.join(
    jobDir,
    `part_${String(clipIndex).padStart(3, "0")}_${partIndex}.mp4`,
  );
  const duration = part.sourceOutSec - part.sourceInSec;

  if (asset.kind === "image") {
    await imageToVideoSegment({
      inputPath,
      outputPath: outPath,
      durationSec: duration,
    });
    return outPath;
  }

  await extractSegmentTimes({
    inputPath,
    outputPath: outPath,
    startSec: part.sourceInSec,
    endSec: part.sourceOutSec,
  });
  return outPath;
}

async function renderClipToPart(
  jobDir: string,
  index: number,
  item: ExportClipInput,
  assets: readonly Asset[],
): Promise<string> {
  const outPath = path.join(jobDir, `part_${String(index).padStart(3, "0")}.mp4`);

  if (item.clip.parts.length === 1) {
    const part = item.clip.parts[0]!;
    const duration = item.clip.durationSec;

    if (item.asset.kind === "image") {
      await imageToVideoSegment({
        inputPath: item.inputPath,
        outputPath: outPath,
        durationSec: duration,
      });
      return outPath;
    }

    await extractSegmentTimes({
      inputPath: item.inputPath,
      outputPath: outPath,
      startSec: part.sourceInSec,
      endSec: part.sourceInSec + duration,
    });
    return outPath;
  }

  const segmentPaths: string[] = [];
  for (let pi = 0; pi < item.clip.parts.length; pi++) {
    const part = item.clip.parts[pi]!;
    const asset = assets.find((a) => a.id === part.assetId);
    if (!asset) continue;
    const inputPath = await resolveAssetInputPath(asset);
    if (!inputPath) continue;
    segmentPaths.push(
      await renderClipPartSegment(jobDir, index, pi, asset, part, inputPath),
    );
  }

  if (segmentPaths.length === 0) {
    throw new Error("クリップのパートを書き出せませんでした。");
  }
  if (segmentPaths.length === 1) {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(segmentPaths[0]!, outPath);
    return outPath;
  }

  const listPath = path.join(jobDir, `part_${String(index).padStart(3, "0")}_concat.txt`);
  await writeFile(listPath, buildConcatDemuxerListFile(segmentPaths), "utf8");
  const probe = await probeVideo(segmentPaths[0]!);
  await concatViaDemuxer({
    listTxtAbsolutePath: listPath,
    outputPath: outPath,
    outputHasAudio: probe.hasAudio,
  });
  return outPath;
}

async function prepareCompositionClips(
  project: EditorProject,
  jobDir: string,
  compW: number,
  compH: number,
): Promise<PreparedClip[]> {
  const sorted = clipsForExportComposition(project);
  const prepared: PreparedClip[] = [];
  let partIndex = 0;

  for (const { clip, asset } of sorted) {
    const inputPath = await resolveAssetInputPath(asset);
    if (!inputPath) continue;

    const rendered = await renderClipToPart(
      jobDir,
      partIndex++,
      { clip, asset, inputPath },
      project.assets,
    );

    prepared.push({
      path: rendered,
      clip,
      asset,
      inputIndex: prepared.length + 1,
      rect: transformToPixelRect(clip.transform, compW, compH),
    });
  }

  return prepared;
}

function buildCompositionVideoFilterGraph(prepared: readonly PreparedClip[]): string {
  const filters: string[] = [];
  let currentV = "0:v";

  if (prepared.length === 0) {
    filters.push("[0:v]format=yuv420p[vout]");
    return filters.join(";");
  }

  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    const scaled = `vs${i}`;
    const out = i === prepared.length - 1 ? "vout" : `vo${i}`;
    const start = formatFfmpegFilterNumber(p.clip.timelineStartSec);
    const end = formatFfmpegFilterNumber(p.clip.timelineStartSec + p.clip.durationSec);
    filters.push(
      `[${p.inputIndex}:v]scale=${formatFfmpegFilterInt(p.rect.w)}:${formatFfmpegFilterInt(p.rect.h)}[${scaled}]`,
    );
    filters.push(
      `[${currentV}][${scaled}]overlay=${formatFfmpegFilterInt(p.rect.x)}:${formatFfmpegFilterInt(p.rect.y)}:enable='between(t\\,${start}\\,${end})'[${out}]`,
    );
    currentV = out;
  }

  return filters.join(";");
}

async function buildCompositionAudioFilterGraph(
  prepared: readonly PreparedClip[],
  audioTrack: Track | undefined,
  project: EditorProject,
): Promise<{ filterPart: string | null; audioMapLabel: string | null }> {
  const audioClipIds = new Set(
    audioTrack
      ? project.clips.filter((c) => c.trackId === audioTrack.id).map((c) => c.id)
      : [],
  );

  const filters: string[] = [];
  const audioLabels: string[] = [];

  for (const p of prepared) {
    if (!audioClipIds.has(p.clip.id)) continue;
    if (p.asset.kind !== "video") continue;
    const probe = await probeVideo(p.path);
    if (!probe.hasAudio) continue;
    const label = `ad${p.inputIndex}`;
    const delayMs = formatFfmpegFilterInt(Math.round(p.clip.timelineStartSec * 1000));
    filters.push(`[${p.inputIndex}:a]adelay=${delayMs}|${delayMs}[${label}]`);
    audioLabels.push(`[${label}]`);
  }

  if (audioLabels.length === 0) {
    return { filterPart: null, audioMapLabel: null };
  }
  if (audioLabels.length === 1) {
    return { filterPart: filters.join(";"), audioMapLabel: audioLabels[0]! };
  }

  filters.push(
    `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`,
  );
  return { filterPart: filters.join(";"), audioMapLabel: "[aout]" };
}

/** Export full composition as single MP4 with preview-matched layout on the project canvas. */
export async function exportCompositionToFile(params: {
  project: EditorProject;
  jobDir: string;
  outputPath: string;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const { project, jobDir, outputPath } = params;
  const { width: compW, height: compH } = getCompositionSize(project);
  const duration = project.compositionDurationSec;
  const fps = 30;

  const prepared = await prepareCompositionClips(project, jobDir, compW, compH);
  if (prepared.length === 0) {
    throw new Error("書き出すクリップがありません。");
  }

  const audioTrack = resolveAudioTrackForExport(project);
  const videoFilter = buildCompositionVideoFilterGraph(prepared);
  const audioFilter = await buildCompositionAudioFilterGraph(prepared, audioTrack, project);
  const filterComplex = audioFilter.filterPart
    ? `${videoFilter};${audioFilter.filterPart}`
    : videoFilter;

  const args: string[] = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${COMPOSITION_BG_FFMPEG}:s=${compW}x${compH}:d=${formatFfmpegFilterNumber(duration)}:r=${fps}`,
  ];
  for (const p of prepared) {
    args.push("-i", p.path);
  }

  args.push("-filter_complex", filterComplex, "-map", "[vout]");
  if (audioFilter.audioMapLabel) {
    args.push("-map", audioFilter.audioMapLabel, "-c:a", "aac");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(formatFfmpegFilterNumber(duration)),
    outputPath,
  );

  await runFfmpegCommand(args, {
    totalDurationSec: duration,
    onProgress: params.onProgress
      ? (p) => {
          if (typeof p.progressPct === "number") params.onProgress?.(p.progressPct);
        }
      : undefined,
  });

  for (const p of prepared) {
    await unlink(p.path).catch(() => undefined);
  }
}

export type CompositionExportPayload = {
  assets: Asset[];
  tracks: Track[];
  clips: Clip[];
  compositionDurationSec: number;
  compositionWidth?: number;
  compositionHeight?: number;
  exportBaseName?: string;
};
