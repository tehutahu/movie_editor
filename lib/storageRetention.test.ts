import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const roots = vi.hoisted(() => { vi.resetModules(); return { UPLOADS_ROOT: "", JOBS_ROOT: "" }; });
vi.mock("@/lib/paths", () => roots);
import { pruneAllStorage } from "./storageRetention";
import { pruneUploadsAfterSave, pruneJobsAfterComplete } from "./storage/localFs";
import { createJobRecord } from "./jobs";
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it("retains editing/undo media, simultaneous batch uploads and active job sources above limits #16", async () => {
  root = await mkdtemp(path.join(tmpdir(), "retention-"));
  roots.UPLOADS_ROOT = path.join(root, "uploads"); roots.JOBS_ROOT = path.join(root, "jobs");
  vi.stubEnv("MAX_UPLOAD_COUNT", "2"); vi.stubEnv("MAX_JOB_COUNT", "1");
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const id of ids) { await mkdir(path.join(roots.UPLOADS_ROOT, id), { recursive: true }); await writeFile(path.join(roots.UPLOADS_ROOT, id, "input.mp4"), id); }
  const sourceJobId = randomUUID();
  await mkdir(path.join(roots.JOBS_ROOT, sourceJobId), { recursive: true });
  await writeFile(path.join(roots.JOBS_ROOT, sourceJobId, "output.mp4"), "source");
  const running = createJobRecord("export_composition", { assetId: ids[0] });
  await Promise.all(ids.slice(2).map(pruneUploadsAfterSave));
  await pruneJobsAfterComplete(randomUUID());
  const result = await pruneAllStorage([]);
  expect(result.warning).toMatch(/上限/);
  expect(result.uploadsRemoved).toEqual([]);
  expect(result.jobsRemoved).toEqual([]); // Legacy clients may call this without NLE keep IDs.
  for (const id of ids) expect(await readFile(path.join(roots.UPLOADS_ROOT, id, "input.mp4"), "utf8")).toBe(id);
  expect(await readFile(path.join(roots.JOBS_ROOT, sourceJobId, "output.mp4"), "utf8")).toBe("source");
  expect(running.status).toBe("pending");
});
