import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  const id = randomUUID();
  const rec: JobRecord = {
    id,
    kind,
    status: "pending",
    createdAtMs: Date.now(),
    ...extra,
  };
  jobs.set(id, rec);
  void persistJob(rec);
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
  void persistJob(next);
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
    }
  })();
}
