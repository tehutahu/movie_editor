import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reserveStorage, finishStorageJob, pruneAllStorage, type StorageReservation } from "@/lib/storageRetention";
import { JOBS_ROOT } from "@/lib/paths";

export type JobStatus = "pending" | "running" | "done" | "error";

export type JobKind =
  | "restore"
  | "export_segment"
  | "export_clip"
  | "merge_kept"
  | "thumbnails"
  | "export_composition";

export type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAtMs: number;
  outputPath?: string | undefined;
  downloadName?: string | undefined;
  error?: string | undefined;
  progressPct?: number | undefined;
  etaSec?: number | undefined;
  currentStep?: string | undefined;
  assetId?: string | undefined;
};

const jobs = new Map<string, JobRecord>();
const writes = new Map<string, Promise<void>>();
function queuePersist(rec: JobRecord) {
  const next = (writes.get(rec.id) ?? Promise.resolve()).then(() => persistJob(rec));
  writes.set(rec.id, next);
}
export async function createRetainedJobRecord(kind: JobKind, options: {
  sessionId?: string; dependencies: string[]; transient?: boolean; assetId?: string;
}) {
  const id = randomUUID();
  await reserveStorage([{ id, kind: "jobs", active: true, dependencies: options.dependencies,
    transient: options.transient } satisfies StorageReservation], options.sessionId);
  return createJobRecord(kind, { id, assetId: options.assetId });
}


async function persistJob(rec: JobRecord): Promise<void> {
  try {
    const dir = path.join(JOBS_ROOT, rec.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(rec), "utf8");
  } catch {
    // best effort for serverless /tmp fallback
  }
}

async function loadPersistedJob(jobId: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(JOBS_ROOT, jobId, "meta.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export function createJobRecord(kind: JobRecord["kind"], extra?: Partial<JobRecord>): JobRecord {
  const id = extra?.id ?? randomUUID();
  const rec: JobRecord = {
    id,
    kind,
    status: "pending",
    createdAtMs: Date.now(),
    ...extra,
  };
  jobs.set(id, rec);
  queuePersist(rec);
  return rec;
}

export function getJobRecord(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

export async function ensureJobRecord(jobId: string): Promise<JobRecord | undefined> {
  const mem = jobs.get(jobId);
  if (mem) return mem;
  const loaded = await loadPersistedJob(jobId);
  if (loaded) jobs.set(jobId, loaded);
  return loaded ?? undefined;
}

export function patchJobRecord(jobId: string, patch: Partial<JobRecord>): void {
  const cur = jobs.get(jobId);
  if (!cur) return;
  const next = { ...cur, ...patch };
  jobs.set(jobId, next);
  queuePersist(next);
}

/** テストのみ: in-memory のジョブ一覧をクリアします。 */
export function clearJobStoreForTests(): void {
  jobs.clear();
}

/** `pending` / `running` のジョブディレクトリはストレージ整理から除外します。 */
export function listPendingRunningJobIds(): string[] {
  const out: string[] = [];
  for (const [id, rec] of jobs) {
    if (rec.status === "pending" || rec.status === "running") out.push(id);
  }
  return out;
}

export function runDetached(jobId: string, fn: () => Promise<void>): void {
  void (async () => {
    patchJobRecord(jobId, {
      status: "running",
      error: undefined,
      progressPct: undefined,
      etaSec: undefined,
      currentStep: undefined,
    });
    try {
      await fn();
      patchJobRecord(jobId, { status: "done", progressPct: 100, etaSec: 0 });
    } catch (e) {
      patchJobRecord(jobId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Flush metadata before making a directory eligible for collection.
      // A late write must never resurrect a directory after it was collected.
      await writes.get(jobId);
      try { await finishStorageJob(jobId); await pruneAllStorage([]); }
      catch { /* fail closed: durable active state remains protected */ }
    }
  })();
}
