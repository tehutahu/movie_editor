import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UPLOADS_ROOT, JOBS_ROOT } from "@/lib/paths";
import { assertInsideDir } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";
import { pruneJobsStorage, pruneUploadStorage } from "@/lib/storageRetention";

export async function ensureStorageTrees(): Promise<void> {
  await mkdir(UPLOADS_ROOT, { recursive: true });
  await mkdir(JOBS_ROOT, { recursive: true });
}

export function newVideoId(): string {
  return randomUUID();
}

export function newJobId(): string {
  return randomUUID();
}

export async function atomicWriteTmpThenRename(absPathFinal: string, data: Uint8Array) {
  const dir = path.dirname(absPathFinal);
  const tmp = path.join(dir, `.tmp.${randomUUID()}`);
  await writeFile(tmp, data);
  await rename(tmp, absPathFinal);
}

export function uploadVideoDir(videoId: string): string {
  assertStorageId("videoId", videoId);
  const dir = path.join(UPLOADS_ROOT, videoId);
  assertInsideDir(UPLOADS_ROOT, dir);
  return dir;
}

/** `storage/uploads/<id>/input.<ext>` へ保存します。 */
export async function saveUploadedVideo(input: {
  videoId: string;
  ext: string;
  bytes: Uint8Array;
}): Promise<{ inputPath: string }> {
  const dir = uploadVideoDir(input.videoId);
  await mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, `input.${input.ext}`);
  await atomicWriteTmpThenRename(inputPath, input.bytes);
  return { inputPath };
}

export async function findUploadInputPath(videoId: string): Promise<string | null> {
  const dir = uploadVideoDir(videoId);
  try {
    const files = await readdir(dir);
    const hit = files.find((f) => /^input\./i.test(f));
    if (!hit) return null;
    return path.join(dir, hit);
  } catch {
    return null;
  }
}

export function jobDir(jobId: string): string {
  assertStorageId("jobId", jobId);
  const dir = path.join(JOBS_ROOT, jobId);
  assertInsideDir(JOBS_ROOT, dir);
  return dir;
}

export async function ensureJobDir(jobId: string): Promise<string> {
  const dir = jobDir(jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** アップロード直後に古い uploads を整理（新規 `videoId` は保護）。 */
export async function pruneUploadsAfterSave(videoId: string): Promise<void> {
  await pruneUploadStorage([videoId]);
}

/** ジョブ完了後に古い jobs を整理（当該 `jobId` と進行中ジョブは保護）。 */
export async function pruneJobsAfterComplete(jobId: string): Promise<void> {
  await pruneJobsStorage([jobId]);
}
