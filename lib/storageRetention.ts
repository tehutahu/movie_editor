import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { listPendingRunningJobIds } from "@/lib/jobs";
import { JOBS_ROOT, UPLOADS_ROOT } from "@/lib/paths";
import { assertStorageId } from "@/lib/validation";

const STORAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseMaxCount(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export const DEFAULT_MAX_UPLOAD_COUNT = 20;
export const DEFAULT_MAX_JOB_COUNT = 50;

export function maxUploadCount(): number {
  return parseMaxCount("MAX_UPLOAD_COUNT", DEFAULT_MAX_UPLOAD_COUNT);
}

export function maxJobCount(): number {
  return parseMaxCount("MAX_JOB_COUNT", DEFAULT_MAX_JOB_COUNT);
}

function isStorageIdDirName(name: string): boolean {
  return STORAGE_ID_RE.test(name);
}

export async function listStorageDirsSortedByMtimeAsc(rootAbs: string): Promise<
  { id: string; absPath: string; mtimeMs: number }[]
> {
  let names: string[];
  try {
    names = await readdir(rootAbs);
  } catch {
    return [];
  }

  const rows: { id: string; absPath: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!isStorageIdDirName(name)) continue;
    const absPath = path.join(rootAbs, name);
    try {
      const st = await stat(absPath);
      if (!st.isDirectory()) continue;
      rows.push({ id: name, absPath, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }

  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return rows;
}

/** 直下のディレクトリを **mtime が古い順** に削除し、`maxCount` 以下にします（ID はフォルダ名）。 */
export async function pruneDirectoryChildren(params: {
  rootAbs: string;
  maxCount: number;
  protectedIds: ReadonlySet<string>;
}): Promise<{ removedIds: string[] }> {
  const maxCount = Math.max(0, Math.floor(params.maxCount));
  const sorted = await listStorageDirsSortedByMtimeAsc(params.rootAbs);
  const removedIds: string[] = [];

  let remaining = sorted.length;
  for (const row of sorted) {
    if (remaining <= maxCount) break;
    if (params.protectedIds.has(row.id)) continue;
    try {
      await rm(row.absPath, { recursive: true, force: true });
      removedIds.push(row.id);
      remaining -= 1;
    } catch {
      // 競合などは無視して続行
    }
  }

  return { removedIds };
}

function normalizeProtectedIds(extra?: readonly string[]): Set<string> {
  const set = new Set<string>();
  if (!extra) return set;
  for (const raw of extra) {
    if (typeof raw !== "string" || raw === "") continue;
    try {
      set.add(assertStorageId("keepIds[]", raw));
    } catch {
      continue;
    }
  }
  return set;
}

/** アップロード保存ディレクトリの件数上限を適用します。 */
export async function pruneUploadStorage(extraProtectedIds?: readonly string[]): Promise<{
  removedIds: string[];
}> {
  const protectedIds = normalizeProtectedIds(extraProtectedIds);
  return pruneDirectoryChildren({
    rootAbs: UPLOADS_ROOT,
    maxCount: maxUploadCount(),
    protectedIds,
  });
}

/** ジョブ完了後など: 進行中ジョブ + 指定 ID を残し件数上限を適用します。 */
export async function pruneJobsStorage(extraProtectedIds?: readonly string[]): Promise<{
  removedIds: string[];
}> {
  const protectedIds = normalizeProtectedIds(extraProtectedIds);
  for (const id of listPendingRunningJobIds()) {
    protectedIds.add(id);
  }
  return pruneDirectoryChildren({
    rootAbs: JOBS_ROOT,
    maxCount: maxJobCount(),
    protectedIds,
  });
}

/** 手動整理: uploads / jobs の両方をまとめて実行します。 */
export async function pruneAllStorage(keepIds: readonly string[]): Promise<{
  uploadsRemoved: string[];
  jobsRemoved: string[];
}> {
  const protectedSet = normalizeProtectedIds(keepIds);
  const u = await pruneUploadStorage([...protectedSet]);
  const j = await pruneJobsStorage([...protectedSet]);
  return { uploadsRemoved: u.removedIds, jobsRemoved: j.removedIds };
}
