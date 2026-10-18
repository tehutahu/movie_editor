import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { reserveStorage, finishStorageJob, pruneAllStorage, type StorageReservation } from "@/lib/storageRetention";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";
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

type JobStore = {
  jobs: Map<string, JobRecord>;
  writes: Map<string, Promise<void>>;
};
// Route compilation/HMR may reevaluate this module while a worker still uses
// its old closure. Keep both records and their write queues for this process,
// isolated by the normalized storage root. This is not a durable worker queue.
const globalState = globalThis as typeof globalThis & {
  __movieJobStoresV1?: Map<string, JobStore>;
};
const stores = globalState.__movieJobStoresV1 ??= new Map<string, JobStore>();
const root = path.resolve(JOBS_ROOT);
let store = stores.get(root);
if (!store) {
  store = { jobs: new Map(), writes: new Map() };
  stores.set(root, store);
}
const { jobs, writes } = store;
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

/** テストのみ: 所有ルートの非同期メタデータ書き込みを削除前に完了させます。 */
export async function flushJobWritesForTests(): Promise<void> {
  for (;;) {
    const snapshot = new Map(writes);
    await Promise.all(snapshot.values());
    if (snapshot.size === writes.size && [...snapshot].every(([id, pending]) => writes.get(id) === pending)) return;
  }
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

/** A saved project must not depend on best-effort or still-queued job metadata. */
export async function persistCompletedJobForProject(
  jobId: string,
): Promise<void> {
  assertStorageId("jobId", jobId);
  const pending = (writes.get(jobId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const record = await ensureJobRecord(jobId);
      if (
        !record ||
        record.id !== jobId ||
        record.status !== "done" ||
        !record.outputPath
      ) {
        throw new Error("保存対象のジョブが完了していません。");
      }
      assertJobOutputFile(jobId, record.outputPath);
      const dir = path.join(JOBS_ROOT, jobId);
      const tmp = path.join(dir, `.project-meta-${randomUUID()}.tmp`);
      try {
        const file = await open(tmp, "wx");
        try {
          await file.writeFile(JSON.stringify(record), "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, path.join(dir, "meta.json"));
        const directory = await open(dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw new Error(
          "ジョブ情報を永続化できません。プロジェクトの保存・読み込みを中止しました。",
        );
      }
    });
  // Other job writers may continue after a failed attempt; the caller still gets the failure.
  writes.set(
    jobId,
    pending.catch(() => undefined),
  );
  await pending;
}
