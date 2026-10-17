import { multipartDurationArgument, planMultipartVideo } from "@/lib/multipartTiming";
import type { Asset, Clip } from "@/lib/editor/types";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { extractSegmentTimes, imageToVideoSegment, probeMedia, probeVideo, runFfmpegCommand } from "@/lib/ffmpeg";
import { unlink } from "node:fs/promises";
import path from "node:path";

/** Normalize every part before concatenation: dimensions, frame/time bases,
 * pixel format and stereo audio (silence for images or silent videos).
 */
export async function renderClipToFile(params: {
  clip: Clip; assets: readonly Asset[]; jobDir: string;
  outputPath: string; width: number; height: number;
}): Promise<void> {
  const { clip, assets, jobDir, outputPath, width, height } = params;
  const paths: string[] = [];
  const plan = clip.parts.length > 1 ? planMultipartVideo(clip) : null;
  const streams: { video: boolean; audio: boolean }[] = [];
  try {
    for (let i = 0; i < clip.parts.length; i++) {
      const part = clip.parts[i]!;
      const asset = assets.find((a) => a.id === part.assetId);
      if (!asset) throw new Error("クリップの素材が見つかりません。");
      const input = await resolveAssetInputPath(asset);
      if (!input) throw new Error("クリップの素材ファイルが見つかりません。");
      const duration = part.sourceOutSec - part.sourceInSec;
      const info = asset.kind === "video" ? await probeVideo(input) : null;
      if (info && (!info.hasVideo || part.sourceOutSec > info.durationSec + 1 / 30)) {
        throw new Error("クリップの素材範囲が動画の長さを超えています。");
      }
      if (clip.parts.length === 1) {
        if (asset.kind === "image") {
          await imageToVideoSegment({ inputPath: input, outputPath, durationSec: duration });
        } else {
          await extractSegmentTimes({ inputPath: input, outputPath, startSec: part.sourceInSec, endSec: part.sourceOutSec });
        }
        return;
      }
      const out = path.join(jobDir, `${path.basename(outputPath, ".mp4")}_source_${i}.mp4`);
      paths.push(out);
      const args = ["-y", ...(asset.kind === "image" ? ["-loop", "1"] : ["-ss", multipartDurationArgument(part.sourceInSec)]), "-i", input,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-map", "0:v:0", "-map", info?.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${width}:${height},setsar=1,fps=30,format=yuv420p`,
        "-af", "aresample=48000,apad", "-ac", "2", "-ar", "48000",
        "-t", multipartDurationArgument(duration), "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", out];
      await runFfmpegCommand(args, { totalDurationSec: duration });
      const media = await probeMedia(out);
      const video = Boolean(media.streams?.some(s => s.codec_type === "video"));
      const audio = Boolean(media.streams?.some(s => s.codec_type === "audio"));
      if (plan!.parts[i].frames > 0 && !video)
        throw new Error("結合クリップの表示位置に必要な映像フレームを素材区間から取り出せません。");
      streams.push({ video, audio });
    }
    if (!paths.length) throw new Error("クリップに素材がありません。");
    const filters: string[] = [], videos: string[] = [], audios: string[] = [];
    for (const [i, part] of clip.parts.entries()) {
      const d = multipartDurationArgument(part.sourceOutSec - part.sourceInSec), frames = plan!.parts[i].frames;
      if (frames > 0) {
        // Keep the legacy normalized frame sequence, repeating its valid last
        // frame only when EOF leaves fewer samples than this part owns.
        filters.push(`[${i}:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},settb=1/30,setpts=N[v${i}]`);
        videos.push(`[v${i}]`);
      }
      // Zero decoded audio remains empty. Do not invent source samples or
      // replace the existing per-part resampling/trim with a new audio grid.
      if (streams[i].audio) {
        filters.push(`[${i}:a]atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
        audios.push(`[a${i}]`);
      }
    }
    if (!videos.length) throw new Error("結合クリップに表示できる映像がありません。");
    // Single-frame segments have no inferred concat duration. Re-clock by
    // frame index before encoding so equal concat PTS cannot drop owned frames.
    // Keep the legacy AVTB rounding for already aligned decoded output.
    filters.push(`${videos.join("")}concat=n=${videos.length}:v=1:a=0,settb=AVTB,setpts=round(N*1000000/30)[v]`);
    if (audios.length) filters.push(`${audios.join("")}concat=n=${audios.length}:v=0:a=1[a]`);
    // Concat leaves frame duration unset. Preserve encoded PTS/DTS while
    // giving the final packet its CFR duration, so MP4 does not discard it
    // at a zero-length edit boundary (notably 37-frame clips).
    await runFfmpegCommand(["-y", ...paths.flatMap((p) => ["-i", p]),
      "-filter_complex", filters.join(";"), "-map", "[v]",
      ...(audios.length ? ["-map", "[a]", "-c:a", "aac"] : ["-an"]),
      // Preserve the finite ownership PTS instead of resampling at an
      // inferred encoder rate. Keep the filter's AVTB clock through encoding.
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-fps_mode:v", "passthrough", "-enc_time_base:v", "1:1000000", "-bsf:v", "setts=pts=PTS:dts=DTS:duration=1/(30*TB)", "-t", String(clip.durationSec), "-movflags", "+faststart", outputPath],
    { totalDurationSec: clip.durationSec });
  } finally {
    await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
  }
}
