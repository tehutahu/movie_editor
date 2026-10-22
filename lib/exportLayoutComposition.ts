import { audioFadeExportFilter } from "@/lib/audioFadeExport";
import { isMediaClip, type MediaClip } from "./editor/types";
import { audioGainFilter } from "@/lib/editor/clipAudio";
import { copyTitleRaster } from "./titleRenderer";
/** Opt-in layout renderer. All-stretch compositions use the unchanged legacy renderer. */
import path from "node:path";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { probeVideo, runFfmpegCommand } from "@/lib/ffmpeg";
import { inspectRenderMediaLayout, MediaLayoutError } from "@/lib/mediaLayout";
import { repairContainAudio } from "@/lib/containAudioRepair";
import { renderClipToFile } from "@/lib/renderClip";
import type { Asset, Clip, EditorProject } from "@/lib/editor/types";
import { clipsForExportComposition, compositionFrameAt, COMPOSITION_BG_FFMPEG, MAX_CLIP_SCALE,
  resolveAudioTrackForExport, resolveContainContentRect, transformToPixelRect, visualClipsForExport } from "@/lib/editor/compositor";

function num(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 100_000_000) throw new Error("配置の数値が不正です。");
  return String(Number(n.toFixed(9)));
}
function rectFor(clip: Clip, project: EditorProject) {
  return transformToPixelRect({ ...clip.transform,
    x: Math.max(-MAX_CLIP_SCALE, Math.min(1 + MAX_CLIP_SCALE, clip.transform.x)),
    y: Math.max(-MAX_CLIP_SCALE, Math.min(1 + MAX_CLIP_SCALE, clip.transform.y)),
  }, project.compositionWidth, project.compositionHeight);
}
async function media(asset: Asset) {
  const input = await resolveAssetInputPath(asset);
  if (!input) throw new MediaLayoutError("LAYOUT_MEDIA_MISSING", "素材が見つかりません。再リンクしてください。");
  return { input, ...await inspectRenderMediaLayout(input, asset.kind, asset.ext) };
}
/** Revalidate actual media before registering a layout job; never trust client dimensions. */
export async function validateContainMedia(project: EditorProject): Promise<void> {
  const ids = new Set(project.clips.filter(isMediaClip).filter(c => c.layoutMode === "contain").flatMap(c => c.parts.map(p => p.assetId)));
  for (const a of project.assets) if (ids.has(a.id)) await media(a);
}
async function concat(files: string[], output: string, video: boolean, durations?: number[]) {
  // Only generated names in our private directory enter this manifest.
  const manifest = `${output}.txt`;
  await writeFile(manifest, files.map((file, i) => `file '${path.basename(file)}'\n${durations ? `duration ${num(durations[i]!)}\n` : ""}`).join(""));
  await runFfmpegCommand(["-y", "-f", "concat", "-safe", "0", "-i", manifest, "-map", video ? "0:v" : "0:a:0", "-c", "copy", output]);
  await Promise.all([...files, manifest].map(p => unlink(p)));
}

type Prepared = { file: string; clip: Clip; matte: boolean; audio: boolean; title?: boolean; rect: ReturnType<typeof rectFor> };
async function prepareContain(clip: MediaClip, project: EditorProject, dir: string, ci: number, audio: boolean): Promise<Prepared> {
  const rect = rectFor(clip, project), videos: string[] = [], durations: number[] = [], audios: string[] = [];
  let offset = clip.timelineStartSec;
  for (const [pi, part] of clip.parts.entries()) {
    const asset = project.assets.find(a => a.id === part.assetId);
    if (!asset) throw new Error("素材が見つかりません。");
    const info = await media(asset);
    if (asset.kind === "video" && (!Number.isFinite(info.durationSec) || part.sourceOutSec > info.durationSec + 1 / 30)) throw new Error("切り出し区間が素材長を超えています。");
    const duration = part.sourceOutSec - part.sourceInSec, end = offset + duration;
    const S = compositionFrameAt(offset), n = compositionFrameAt(end) - S;
    const first = part.sourceInSec + S / 30 - offset;
    if (n > 0) {
      const content = resolveContainContentRect({ x: 0, y: 0, w: rect.w, h: rect.h }, info.width, info.height);
      const output = path.join(dir, `c${ci}-p${pi}.mkv`);
      const inputArgs = asset.kind === "image" ? ["-loop", "1", "-framerate", "30"] : ["-copyts", "-noaccurate_seek", "-ss", num(first)];
      // Keep keyframe preroll: Canvas displays the last sample at/before the
      // requested media time, including a sample whose PTS precedes sourceIn.
      // Remove sourceOut and later samples BEFORE fps/EOF cloning. Round up
      // schedules future samples on the next output grid rather than early.
      const trim = asset.kind === "video" ? `trim=end=${num(info.origin + part.sourceOutSec)},setpts=PTS-${num(info.origin + first)}/TB` : `trim=duration=${num(duration)},setpts=PTS-STARTPTS`;
      const normalized = `${trim},fps=30:start_time=0:round=up,settb=1/30,tpad=stop_mode=clone:stop_duration=${num((n + 1) / 30)},trim=end_frame=${n},setpts=N,format=rgba,scale=${content.w}:${content.h},setsar=1,pad=${rect.w}:${rect.h}:${content.x}:${content.y}:color=black@0,format=bgra`;
      const filter = `[0:v:0]${normalized},split=2[cs][as];[cs]scale=in_range=auto:out_range=tv,format=yuv444p,setrange=limited[color];[as]alphaextract[alpha]`;
      await runFfmpegCommand(["-y", ...inputArgs, "-i", info.input, "-filter_complex", filter,
        "-map", "[color]", "-map", "[alpha]", "-an", "-frames:v", String(n), "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv444p", "-color_range:v:0", "tv", "-bsf:v:0", "h264_metadata=video_full_range_flag=0",
        "-c:v:1", "ffv1", "-level:v:1", "3", "-g:v:1", "1", "-pix_fmt:v:1", "gray", "-color_range:v:1", "pc", output]);
      videos.push(output); durations.push(n / 30);
    }
    if (audio) {
      const output = path.join(dir, `a${ci}-${pi}.wav`);
      const sourceInArg = num(part.sourceInSec);
      const inputArgs = asset.kind === "video" && info.hasAudio ? ["-ss", sourceInArg, "-i", info.input] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
      await runFfmpegCommand(["-y", ...inputArgs, "-vn", "-af", "aresample=48000,apad", "-ac", "2", "-ar", "48000", "-t", num(duration), "-c:a", "pcm_s16le", output]);
      const repaired = await repairContainAudio({ input: info.input, sourceIn: part.sourceInSec, sourceInArg,
        durationArg: num(duration), descriptor: asset.kind === "video" && info.hasAudio ? info.audioSeek : null,
        oldFile: output, retryFile: path.join(dir, `a${ci}-${pi}-retry.wav`) });
      if (repaired.status !== "ineligible")
        console.info("Contain audio repair", { status: repaired.status, oldSamples: String(repaired.oldSamples), newSamples: repaired.newSamples === undefined ? undefined : String(repaired.newSamples) });
      audios.push(repaired.file);
    }
    offset = end;
  }
  if (!videos.length) throw new Error("クリップの映像フレームを取得できませんでした。");
  let file = path.join(dir, `clip${ci}.mkv`);
  await concat(videos, file, true, durations);
  if (audios.length) {
    const audioFile = path.join(dir, `audio${ci}.wav`), mux = path.join(dir, `mux${ci}.mkv`);
    await concat(audios, audioFile, false);
    await runFfmpegCommand(["-y", "-i", file, "-i", audioFile, "-map", "0:v", "-map", "1:a", "-c", "copy", mux]);
    await unlink(file); await unlink(audioFile); file = mux;
  }
  return { file, clip, matte: true, audio, rect };
}

export async function exportLayoutCompositionToFile(params: { project: EditorProject; jobDir: string; outputPath: string; onProgress?: (pct: number) => void }): Promise<void> {
  const { project, outputPath } = params, duration = project.compositionDurationSec;
  const dir = await mkdtemp(path.join(params.jobDir, "layout-"));
  let succeeded = false;
  try {
    const prepared: Prepared[] = [];
    const audioTrack = resolveAudioTrackForExport(project);
    const layers=project.clips.some(c=>c.kind==="title")?visualClipsForExport(project).map(clip=>({clip})):clipsForExportComposition(project);
    for (const [ci, { clip }] of layers.entries()) {
      if(clip.kind==="title"){
        const file=await copyTitleRaster(clip,project.compositionWidth,project.compositionHeight,dir);
        prepared.push({file,clip,title:true,matte:false,audio:false,rect:transformToPixelRect({...clip.transform,x:Math.max(-MAX_CLIP_SCALE,Math.min(1+MAX_CLIP_SCALE,clip.transform.x)),y:Math.max(-MAX_CLIP_SCALE,Math.min(1+MAX_CLIP_SCALE,clip.transform.y))},project.compositionWidth,project.compositionHeight,1)});continue;
      }
      const audio = clip.trackId === audioTrack?.id;
      if (clip.layoutMode === "contain") prepared.push(await prepareContain(clip, project, dir, ci, audio));
      else {
        // Mixed projects keep existing stretch source normalization and geometry.
        const file = path.join(dir, `stretch${ci}.mp4`);
        await renderClipToFile({ clip, assets: project.assets, jobDir: dir, outputPath: file, width: project.compositionWidth, height: project.compositionHeight });
        prepared.push({ file, clip, audio, matte: false, rect: rectFor(clip, project) });
      }
    }
    if (!prepared.length) throw new Error("書き出すクリップがありません。");
    const V = compositionFrameAt(duration), filters: string[] = [`[0:v]trim=end_frame=${V},settb=1/30,setpts=N[base]`];
    const args = ["-y", "-f", "lavfi", "-i", `color=c=${COMPOSITION_BG_FFMPEG}:s=${project.compositionWidth}x${project.compositionHeight}:d=${num(duration)}:r=30`];
    let current = "base";
    const audioLabels: string[] = [];
    for (const [i, p] of prepared.entries()) {
      const j = i + 1, start = num(p.clip.timelineStartSec), end = num(p.clip.timelineStartSec + p.clip.durationSec);
      if(p.title)args.push("-loop","1","-framerate","30");
      args.push("-i", p.file);
      if (p.matte) {
        filters.push(`[${j}:v:0]settb=1/30,setpts=N+${compositionFrameAt(p.clip.timelineStartSec)}[c${i}]`,
          `[${j}:v:1]settb=1/30,setpts=N+${compositionFrameAt(p.clip.timelineStartSec)},format=gray,setrange=full[m${i}]`,
          `[c${i}][m${i}]alphamerge,format=rgba[s${i}]`);
      } else filters.push(`[${j}:v:0]setpts=PTS-STARTPTS+${start}/TB,scale=${p.rect.w}:${p.rect.h}[s${i}]`);
      filters.push(`[${current}][s${i}]overlay=${num(p.rect.x)}:${num(p.rect.y)}:format=auto:alpha=straight:eof_action=repeat:repeatlast=1:shortest=0:enable='gte(t\\,${start})*lt(t\\,${end})'[v${i}]`);
      current = `v${i}`;
      // Existing stretch outputs may have no audio (single silent video).
      const hasAudio = p.matte ? p.audio : p.audio && (await probeVideo(p.file)).hasAudio;
      if (await hasAudio) {
        filters.push(`[${j}:a:0]${audioGainFilter(p.clip)}${await audioFadeExportFilter(p.clip,p.file)}adelay=${Math.round(p.clip.timelineStartSec * 1000)}|${Math.round(p.clip.timelineStartSec * 1000)}[a${i}]`);
        audioLabels.push(`[a${i}]`);
      }
    }
    let audioLabel: string | undefined;
    if (audioLabels.length) {
      const mixed = audioLabels.length > 1 ? "[amixed]" : audioLabels[0]!;
      if (audioLabels.length > 1) filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0${mixed}`);
      filters.push(`${mixed}atrim=duration=${num(duration)},asetpts=PTS-STARTPTS[aexact]`); audioLabel = "[aexact]";
    }
    filters.push(`[${current}]trim=end_frame=${V},settb=1/30,setpts=N,scale=in_range=auto:out_range=tv,format=yuv420p,setrange=limited[vexact]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[vexact]");
    args.push(...(audioLabel ? ["-map", audioLabel, "-c:a", "aac"] : ["-an"]));
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range:v", "tv", "-bsf:v", "h264_metadata=video_full_range_flag=0", "-movflags", "+faststart", "-frames:v", String(V), "-r", "30", "-enc_time_base:v", "1:30", outputPath);
    await runFfmpegCommand(args, { totalDurationSec: duration, onProgress: p => { if (typeof p.progressPct === "number") params.onProgress?.(p.progressPct); } });
    succeeded = true;
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (!succeeded) await unlink(outputPath).catch(() => undefined);
  }
}
