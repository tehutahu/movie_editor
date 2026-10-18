import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Jobs = typeof import("./jobs");
const roots: string[] = [];
const modules: Jobs[] = [];
async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "movie-job-reload-"));
  roots.push(value); return path.join(value, "jobs");
}
async function reload(jobsRoot: string) {
  vi.resetModules();
  vi.doMock("@/lib/paths", () => ({ JOBS_ROOT: jobsRoot, UPLOADS_ROOT: path.join(path.dirname(jobsRoot), "uploads") }));
  const jobs = await import("./jobs"); modules.push(jobs); return jobs;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const jobs of modules.splice(0)) { await jobs.flushJobWritesForTests(); jobs.clearJobStoreForTests(); }
  vi.doUnmock("@/lib/paths"); vi.doUnmock("node:fs/promises"); vi.resetModules();
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

it("drains delayed metadata and writes queued during the drain before deleting its owned root", async () => {
  const location = await root(), started = deferred(), release = deferred();
  const patchedStarted = deferred(), patchedRelease = deferred();
  vi.doMock("node:fs/promises", async importOriginal => {
    const original = await importOriginal<typeof import("node:fs/promises")>();
    return { ...original, writeFile: async (...args: Parameters<typeof writeFile>) => {
      if (JSON.parse(String(args[1])).status === "pending") { started.resolve(); await release.promise; }
      else { patchedStarted.resolve(); await patchedRelease.promise; }
      return original.writeFile(...args);
    } };
  });
  const jobs = await reload(location), job = jobs.createJobRecord("export_segment");
  await started.promise;
  let settled = false;
  const drain = jobs.flushJobWritesForTests().then(() => { settled = true; });
  jobs.patchJobRecord(job.id, { status: "done" });
  try {
    await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false);
    release.resolve();
    await patchedStarted.promise;
    await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false);
  } finally { release.resolve(); patchedRelease.resolve(); await drain; }
  expect(JSON.parse(await readFile(path.join(location, job.id, "meta.json"), "utf8")).status).toBe("done");
  jobs.clearJobStoreForTests();
  const ownedRoot = path.dirname(location);
  await rm(ownedRoot, { recursive: true, force: true });
  roots.splice(roots.indexOf(ownedRoot), 1);
  await expect(readFile(path.join(location, job.id, "meta.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("shares records across module evaluation and normalized aliases of the same root", async () => {
  const location = await root(); const first = await reload(location);
  const job = first.createJobRecord("export_segment");
  const second = await reload(`${location}/../jobs`);
  expect(second.getJobRecord(job.id)).toBe(job);
  second.patchJobRecord(job.id, { status: "running", progressPct: 25 });
  expect(first.getJobRecord(job.id)?.progressPct).toBe(25);
  first.patchJobRecord(job.id, { status: "done", progressPct: 100, outputPath: path.join(location, job.id, "output.mp4") });
  expect(second.getJobRecord(job.id)?.status).toBe("done");
  await second.persistCompletedJobForProject(job.id);
  expect(JSON.parse(await readFile(path.join(location, job.id, "meta.json"), "utf8"))).toMatchObject({ status: "done", progressPct: 100 });
});

it("serializes old/new module writes before durable project commit, so a late pending write cannot overwrite done", async () => {
  const location = await root(); const started = deferred(), release = deferred(); const states: string[] = [];
  vi.doMock("node:fs/promises", async importOriginal => {
    const original = await importOriginal<typeof import("node:fs/promises")>();
    return { ...original, writeFile: async (...args: Parameters<typeof writeFile>) => {
      const record = JSON.parse(String(args[1])); states.push(record.status);
      if (record.status === "pending") { started.resolve(); await release.promise; }
      return original.writeFile(...args);
    } };
  });
  const first = await reload(location); const job = first.createJobRecord("export_segment");
  await started.promise;
  // A reset for another root must not discard this live queue or its store.
  const other = await reload(await root()); other.clearJobStoreForTests();
  const second = await reload(location);
  second.patchJobRecord(job.id, { status: "running", progressPct: 30 });
  second.patchJobRecord(job.id, { status: "done", progressPct: 100, outputPath: path.join(location, job.id, "output.mp4") });
  const durable = second.persistCompletedJobForProject(job.id); let settled = false;
  void durable.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false); expect(states).toEqual(["pending"]);
  } finally { release.resolve(); await durable; }
  expect(states).toEqual(["pending", "running", "done"]);
  expect(JSON.parse(await readFile(path.join(location, job.id, "meta.json"), "utf8"))).toMatchObject({ status: "done", progressPct: 100 });
});

it("isolates identical job ids across roots and reset only clears its current root", async () => {
  const a = await root(), b = await root(), id = randomUUID();
  const first = await reload(a); first.createJobRecord("export_segment", { id, status: "done", outputPath: path.join(a, id, "output.mp4") });
  const second = await reload(b); expect(second.getJobRecord(id)).toBeUndefined();
  second.createJobRecord("restore", { id, status: "done", outputPath: path.join(b, id, "output.mp4") });
  await first.persistCompletedJobForProject(id); await second.persistCompletedJobForProject(id);
  second.clearJobStoreForTests();
  expect(second.getJobRecord(id)).toBeUndefined(); expect(first.getJobRecord(id)?.kind).toBe("export_segment");
  const again = await reload(a); expect(again.getJobRecord(id)).toBe(first.getJobRecord(id));
  expect(JSON.parse(await readFile(path.join(a, id, "meta.json"), "utf8"))).toMatchObject({ kind: "export_segment" });
  expect(JSON.parse(await readFile(path.join(b, id, "meta.json"), "utf8"))).toMatchObject({ kind: "restore" });
});

it("preserves durable write failures across reload, then permits the next queued writer", async () => {
  const location = await root(); let fail = true;
  vi.doMock("node:fs/promises", async importOriginal => {
    const original = await importOriginal<typeof import("node:fs/promises")>();
    return { ...original, open: async (...args: Parameters<typeof original.open>) => {
      if (fail && String(args[0]).includes(".project-meta-")) throw Error("injected durable write failure");
      return original.open(...args);
    } };
  });
  const first = await reload(location); const job = first.createJobRecord("export_segment", { status: "done" });
  first.patchJobRecord(job.id, { outputPath: path.join(location, job.id, "output.mp4") });
  const second = await reload(location);
  await expect(second.persistCompletedJobForProject(job.id)).rejects.toThrow("永続化できません");
  fail = false;
  first.patchJobRecord(job.id, { progressPct: 100 });
  await second.persistCompletedJobForProject(job.id);
  expect(JSON.parse(await readFile(path.join(location, job.id, "meta.json"), "utf8"))).toMatchObject({ status: "done", progressPct: 100 });
});
