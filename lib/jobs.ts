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

export function runDetached(jobId: string, fn: () => Promise<void>): void {
  void (async () => {
    patchJobRecord(jobId, { status: "running", error: undefined });
    try {
      await fn();
      patchJobRecord(jobId, { status: "done" });
    } catch (e) {
      patchJobRecord(jobId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
}
