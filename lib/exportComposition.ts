import type { Asset, Clip, EditorProject, Track } from "@/lib/editor/types";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import {
  buildConcatDemuxerListFile,
  concatViaDemuxer,
  extractSegmentTimes,
  imageToVideoSegment,
  probeVideo,
} from "@/lib/ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tracksSortedForPreview } from "@/lib/editor/project";

type ExportClipInput = {
  clip: Clip;
  asset: Asset;
  inputPath: string;
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

/** Export full composition as single MP4 (stacked by track order, bottom track base). */
export async function exportCompositionToFile(params: {
  project: EditorProject;
  jobDir: string;
  outputPath: string;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const { project, jobDir, outputPath } = params;
  const tracks = tracksSortedForPreview(project.tracks);
  const duration = project.compositionDurationSec;

  const trackParts: string[] = [];
  let partIndex = 0;

  for (const track of tracks) {
    const trackClips = project.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.timelineStartSec - b.timelineStartSec);

    if (trackClips.length === 0) continue;

    const clipPaths: string[] = [];
    for (const clip of trackClips) {
      const assetId = clip.parts[0]?.assetId;
      if (!assetId) continue;
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) continue;
      const inputPath = await resolveAssetInputPath(asset);
      if (!inputPath) continue;

      const gap = clip.timelineStartSec - (clipPaths.length > 0 ? clip.timelineStartSec : 0);
      void gap;

      const rendered = await renderClipToPart(jobDir, partIndex++, {
        clip,
        asset,
        inputPath,
      }, project.assets);
      clipPaths.push(rendered);
    }

    if (clipPaths.length === 1) {
      trackParts.push(clipPaths[0]!);
    } else if (clipPaths.length > 1) {
      const listPath = path.join(jobDir, `track_${track.id}_concat.txt`);
      await writeFile(listPath, buildConcatDemuxerListFile(clipPaths), "utf8");
      const merged = path.join(jobDir, `track_${track.id}.mp4`);
      const probe = await probeVideo(clipPaths[0]!);
      await concatViaDemuxer({
        listTxtAbsolutePath: listPath,
        outputPath: merged,
        outputHasAudio: probe.hasAudio,
      });
      trackParts.push(merged);
    }
  }

  if (trackParts.length === 0) {
    throw new Error("書き出すクリップがありません。");
  }

  if (trackParts.length === 1) {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(trackParts[0]!, outputPath);
    return;
  }

  const listPath = path.join(jobDir, "composition_concat.txt");
  await writeFile(listPath, buildConcatDemuxerListFile(trackParts), "utf8");
  const probe = await probeVideo(trackParts[0]!);
  await concatViaDemuxer({
    listTxtAbsolutePath: listPath,
    outputPath,
    outputHasAudio: probe.hasAudio,
    totalDurationSec: duration,
    onProgress: params.onProgress
      ? (p) => {
          if (typeof p.progressPct === "number") params.onProgress?.(p.progressPct);
        }
      : undefined,
  });

  for (const p of trackParts) {
    await unlink(p).catch(() => undefined);
  }
}

export type CompositionExportPayload = {
  assets: Asset[];
  tracks: Track[];
  clips: Clip[];
  compositionDurationSec: number;
  exportBaseName?: string;
};
