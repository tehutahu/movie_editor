import { randomUUID } from "node:crypto";

export type JobStatus = "pending" | "running" | "done" | "error";

export type JobRecord = {
  id: string;
  kind: "restore" | "export_segment" | "merge_kept";
  status: JobStatus;
  createdAtMs: number;
  outputPath?: string | undefined;
  downloadName?: string | undefined;
  error?: string | undefined;
  progressPct?: number | undefined;
  etaSec?: number | undefined;
  currentStep?: string | undefined;
};

const jobs = new Map<string, JobRecord>();

export function createJobRecord(kind: JobRecord["kind"]): JobRecord {
  const id = randomUUID();
  const rec: JobRecord = {
    id,
    kind,
    status: "pending",
    createdAtMs: Date.now(),
  };
  jobs.set(id, rec);
  return rec;
}

export function getJobRecord(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

export function patchJobRecord(jobId: string, patch: Partial<JobRecord>): void {
  const cur = jobs.get(jobId);
  if (!cur) return;
  jobs.set(jobId, { ...cur, ...patch });
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
