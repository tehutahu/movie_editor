import { audioFadeExportFilter } from "@/lib/audioFadeExport";
import { audioGainFilter } from "@/lib/editor/clipAudio";
import { copyTitleRaster } from "./titleRenderer";
import { exportLayoutCompositionToFile } from "@/lib/exportLayoutComposition";
import type { Asset, Clip, EditorProject, Track } from "@/lib/editor/types";
import {
  clipsForExportComposition,
  COMPOSITION_BG_FFMPEG,
  MAX_CLIP_SCALE,
  getCompositionSize,
  resolveAudioTrackForExport,
  transformToPixelRect,
  visualClipsForExport,
} from "@/lib/editor/compositor";
import { MAX_COMPOSITION_DURATION_SEC } from "@/lib/editor/validateExportProject";
import { probeVideo, runFfmpegCommand } from "@/lib/ffmpeg";
import { renderClipToFile } from "@/lib/renderClip";
import { unlink, mkdtemp, rm } from "node:fs/promises";
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

function formatFfmpegFilterInt(
  value: number,
  min = 0,
  max = MAX_FFMPEG_FILTER_INT,
): string {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("ffmpeg フィルタ整数が不正です。");
  }
  if (value < min || value > max) {
    throw new Error("ffmpeg フィルタ整数が範囲外です。");
  }
  return String(value);
}

type PreparedClip = {
  path: string;
  clip: Clip;
  inputIndex: number;
  title?: boolean;
  rect: ReturnType<typeof transformToPixelRect>;
};

async function prepareCompositionClips(
  project: EditorProject,
  jobDir: string,
  compW: number,
  compH: number,
  titleDir?: string,
): Promise<PreparedClip[]> {
  const sorted = titleDir ? visualClipsForExport(project).map(clip=>({clip})) : clipsForExportComposition(project);
  const prepared: PreparedClip[] = [];
  let partIndex = 0;

  for (const { clip } of sorted) {
    if (clip.kind === "title") {
      if(!titleDir)throw new Error("タイトルexport stagingがありません。");
      const rendered=await copyTitleRaster(clip,compW,compH,titleDir);
      prepared.push({path:rendered,clip,title:true,inputIndex:prepared.length+1,rect:transformToPixelRect({...clip.transform,x:Math.max(-MAX_CLIP_SCALE,Math.min(1+MAX_CLIP_SCALE,clip.transform.x)),y:Math.max(-MAX_CLIP_SCALE,Math.min(1+MAX_CLIP_SCALE,clip.transform.y))},compW,compH,1)});
      continue;
    }
    const rendered = path.join(jobDir, `part_${partIndex++}.mp4`);
    await renderClipToFile({ clip, assets: project.assets, jobDir,
      outputPath: rendered, width: compW, height: compH });

    prepared.push({
      path: rendered,
      clip,
      inputIndex: prepared.length + 1,
      // UI moves may put the centre outside the canvas. Saturate only far
      // off-screen positions, where the entire layer is already invisible,
      // so finite UI coordinates cannot overflow ffmpeg's integer expressions.
      rect: transformToPixelRect({
        ...clip.transform,
        x: Math.max(-MAX_CLIP_SCALE, Math.min(1 + MAX_CLIP_SCALE, clip.transform.x)),
        y: Math.max(-MAX_CLIP_SCALE, Math.min(1 + MAX_CLIP_SCALE, clip.transform.y)),
      }, compW, compH),
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
      `[${p.inputIndex}:v]setpts=PTS-STARTPTS+${start}/TB,scale=${formatFfmpegFilterInt(p.rect.w)}:${formatFfmpegFilterInt(p.rect.h)}[${scaled}]`,
    );
    filters.push(
      `[${currentV}][${scaled}]overlay=${formatFfmpegFilterInt(p.rect.x, -MAX_FFMPEG_FILTER_INT)}:${formatFfmpegFilterInt(p.rect.y, -MAX_FFMPEG_FILTER_INT)}:enable='gte(t\\,${start})*lt(t\\,${end})'[${out}]`,
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
    if (p.title || !audioClipIds.has(p.clip.id)) continue;

    const probe = await probeVideo(p.path);
    if (!probe.hasAudio) continue;
    const label = `ad${p.inputIndex}`;
    const delayMs = formatFfmpegFilterInt(
      Math.round(p.clip.timelineStartSec * 1000), 0, MAX_COMPOSITION_DURATION_SEC * 1000,
    );
    filters.push(`[${p.inputIndex}:a]${audioGainFilter(p.clip)}${await audioFadeExportFilter(p.clip,p.path)}adelay=${delayMs}|${delayMs}[${label}]`);
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
  if (params.project.clips.some(c => c.layoutMode === "contain")) return exportLayoutCompositionToFile(params);
  const { project, jobDir, outputPath } = params;
  const { width: compW, height: compH } = getCompositionSize(project);
  const duration = project.compositionDurationSec;
  const fps = 30;

  const titleDir=project.clips.some(c=>c.kind==="title")?await mkdtemp(path.join(jobDir,"titles-")):undefined;
  try {
  const prepared = await prepareCompositionClips(project, jobDir, compW, compH,titleDir);
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
    if(p.title)args.push("-loop","1","-framerate","30");
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
  }finally{if(titleDir)await rm(titleDir,{recursive:true,force:true});}
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
