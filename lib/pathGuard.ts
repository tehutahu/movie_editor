import path from "node:path";
import { JOBS_ROOT, UPLOADS_ROOT } from "@/lib/paths";
import { assertStorageId } from "@/lib/validation";

export function assertInsideDir(rootAbs: string, fileAbs: string): void {
  const root = path.resolve(rootAbs);
  const file = path.resolve(fileAbs);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("不正なファイルパスです。");
  }
}

export function assertUploadFileBelongsToVideo(
  videoId: string,
  inputPath: string,
): void {
  assertStorageId("videoId", videoId);
  assertInsideDir(UPLOADS_ROOT, inputPath);
  const expectedDir = path.resolve(path.join(UPLOADS_ROOT, videoId));
  assertInsideDir(expectedDir, inputPath);
}

export function assertJobOutputFile(jobId: string, outputPath: string): void {
  assertStorageId("jobId", jobId);
  assertInsideDir(JOBS_ROOT, outputPath);
  const expectedDir = path.resolve(path.join(JOBS_ROOT, jobId));
  assertInsideDir(expectedDir, outputPath);
}
