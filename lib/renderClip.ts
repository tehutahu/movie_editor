import type { Asset, Clip } from "@/lib/editor/types";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { extractSegmentTimes, imageToVideoSegment, probeVideo, runFfmpegCommand } from "@/lib/ffmpeg";
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
      const args = ["-y", ...(asset.kind === "image" ? ["-loop", "1"] : ["-ss", String(part.sourceInSec)]), "-i", input,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-map", "0:v:0", "-map", info?.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${width}:${height},setsar=1,fps=30,format=yuv420p`,
        "-af", "aresample=48000,apad", "-ac", "2", "-ar", "48000",
        "-t", String(duration), "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", out];
      await runFfmpegCommand(args, { totalDurationSec: duration });
    }
    if (!paths.length) throw new Error("クリップに素材がありません。");
    const filters = clip.parts.flatMap((part, i) => {
      const d = part.sourceOutSec - part.sourceInSec;
      return [`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`, `[${i}:a]atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`];
    });
    filters.push(`${paths.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${paths.length}:v=1:a=1[v][a]`);
    await runFfmpegCommand(["-y", ...paths.flatMap((p) => ["-i", p]),
      "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-t", String(clip.durationSec), "-movflags", "+faststart", outputPath],
    { totalDurationSec: clip.durationSec });
  } finally {
    await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
  }
}
