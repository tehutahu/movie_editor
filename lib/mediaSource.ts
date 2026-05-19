import { getJobRecord } from "@/lib/jobs";
import { assertJobOutputFile, assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { findUploadInputPath } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";

export type ResolvedMediaInput = {
  inputPath: string;
  videoId: string;
  /** 入力がジョブ成果の場合 */
  sourceJobId?: string | undefined;
};

/**
 * ジョブ連鎖用に入力ファイルパスを解決します。
 * - `sourceJobId` あり: 完了済みジョブの `outputPath`
 * - なし: アップロードの `input.*`
 */
export async function resolveInputPath(params: {
  videoId: string;
  sourceJobId?: string | undefined;
}): Promise<ResolvedMediaInput> {
  const videoId = assertStorageId("videoId", params.videoId);

  const rawSid = params.sourceJobId;
  if (typeof rawSid === "string" && rawSid.trim().length > 0) {
    const sourceJobId = assertStorageId("sourceJobId", rawSid.trim());
    const job = getJobRecord(sourceJobId);
    if (!job) {
      throw new Error("参照元ジョブが見つかりません。");
    }
    if (job.status !== "done" || !job.outputPath) {
      throw new Error("参照元ジョブが完了していないか、成果ファイルがありません。");
    }
    assertJobOutputFile(sourceJobId, job.outputPath);
    return { inputPath: job.outputPath, videoId, sourceJobId };
  }

  const inputPath = await findUploadInputPath(videoId);
  if (!inputPath) {
    throw new Error("動画が見つかりません。");
  }
  assertUploadFileBelongsToVideo(videoId, inputPath);
  return { inputPath, videoId };
}
