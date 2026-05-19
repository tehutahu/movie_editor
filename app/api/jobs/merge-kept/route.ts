import path from "node:path";
import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  assertFfmpegAvailable,
  buildConcatDemuxerListFile,
  concatViaDemuxer,
  extractSegmentTimes,
  probeVideo,
} from "@/lib/ffmpeg";
import {
  createJobRecord,
  patchJobRecord,
  runDetached,
} from "@/lib/jobs";
import { assertJobOutputFile, assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { ensureJobDir, findUploadInputPath } from "@/lib/storage";
import { keptRangesAfterRemovals, normalizeRanges } from "@/lib/validation";

export const runtime = "nodejs";

type Body = {
  videoId?: string;
  /** 動画から「削除」する区間（秒）。残りを結合します。 */
  removeRanges?: unknown;
};

export async function POST(req: Request) {
  try {
    await assertFfmpegAvailable();
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "JSON body が不正です。" }, { status: 400 });
    }

    const videoId = typeof body.videoId === "string" ? body.videoId : "";
    if (!videoId) {
      return NextResponse.json({ error: "videoId が必要です。" }, { status: 400 });
    }

    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const meta = await probeVideo(inputPath);
    const remove = normalizeRanges(meta.durationSec, body.removeRanges);
    const kept = keptRangesAfterRemovals(meta.durationSec, remove);

    const job = createJobRecord("merge_kept");
    patchJobRecord(job.id, { downloadName: "merged_removed_gaps.mp4", currentStep: "segment" });

    runDetached(job.id, async () => {
      const jobDirAbs = await ensureJobDir(job.id);
      const totalKeptSec = kept.reduce((sum, r) => sum + Math.max(0, r.endSec - r.startSec), 0);
      let completedSec = 0;
      const parts: string[] = [];

      for (let i = 0; i < kept.length; i += 1) {
        const r = kept[i]!;
        const partAbs = path.join(
          jobDirAbs,
          `part_${String(i).padStart(3, "0")}.mp4`,
        );

        const partDurationSec = Math.max(0, r.endSec - r.startSec);
        await extractSegmentTimes({
          inputPath,
          outputPath: partAbs,
          startSec: r.startSec,
          endSec: r.endSec,
          onProgress: (p) => {
            const localPct = (p.progressPct ?? 0) / 100;
            const processedSec = completedSec + partDurationSec * localPct;
            const progressPct = totalKeptSec > 0 ? (processedSec / totalKeptSec) * 90 : undefined;
            patchJobRecord(job.id, {
              currentStep: "segment",
              progressPct,
              etaSec: p.etaSec,
            });
          },
        });
        completedSec += partDurationSec;
        assertJobOutputFile(job.id, partAbs);
        parts.push(partAbs);
      }

      const listAbs = path.join(jobDirAbs, "concat.txt");
      await writeFile(listAbs, buildConcatDemuxerListFile(parts), "utf8");

      const outAbs = path.join(jobDirAbs, "output_merged.mp4");
      patchJobRecord(job.id, { currentStep: "merge", progressPct: 90, etaSec: undefined });
      await concatViaDemuxer({
        listTxtAbsolutePath: listAbs,
        outputPath: outAbs,
        outputHasAudio: meta.hasAudio,
        onProgress: (p) => patchJobRecord(job.id, {
          currentStep: "merge",
          progressPct: typeof p.progressPct === "number" ? 90 + p.progressPct * 0.1 : 90,
          etaSec: p.etaSec,
        }),
      });

      assertJobOutputFile(job.id, outAbs);
      patchJobRecord(job.id, { outputPath: outAbs });
    });

    return NextResponse.json({
      jobId: job.id,
      keptSegments: kept,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
