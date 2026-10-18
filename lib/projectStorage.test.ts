import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => {
  vi.resetModules();
  return {
    roots: { STORAGE_ROOT: "", UPLOADS_ROOT: "", JOBS_ROOT: "" },
    failJobCommit: false,
    failAfterCommit: false,
    failCommit: false,
  };
});
vi.mock("@/lib/paths", () => state.roots);
vi.mock("@/lib/ffmpeg", () => ({
  probeVideo: vi.fn(async () => ({
    durationSec: 3,
    width: 320,
    height: 240,
    hasVideo: true,
  })),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (a: string, b: string) => {
      if (state.failJobCommit && b.endsWith("meta.json"))
        throw new Error("synthetic job metadata failure");
      if (state.failCommit && b.endsWith("retention.json"))
        throw new Error("synthetic disk failure");
      await actual.rename(a, b);
      if (state.failAfterCommit && b.endsWith("retention.json"))
        throw new Error("synthetic lost result");
    },
  };
});
import {
  saveProject,
  loadProject,
  readProject,
  deleteProject,
  listProjects,
} from "./projectStorage";
import {
  reserveStorage,
  releaseStorageSession,
  protectStorageSession,
  pruneAllStorage,
} from "./storageRetention";
import { projectDocumentDraft } from "./editor/projectDocument";
import { createEmptyProject, clipFromAsset } from "./editor/project";
import { addTitle } from "./editor/title";
import { clearJobStoreForTests, createJobRecord } from "./jobs";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "project-storage-"));
  Object.assign(state.roots, {
    STORAGE_ROOT: root,
    UPLOADS_ROOT: path.join(root, "uploads"),
    JOBS_ROOT: path.join(root, "jobs"),
  });
  state.failJobCommit = false;
  state.failAfterCommit = false;
  state.failCommit = false;
  vi.stubEnv("MAX_UPLOAD_COUNT", "20");
  vi.stubEnv("MAX_JOB_COUNT", "50");
});
afterEach(async () => {
  state.failJobCommit = false;
  state.failAfterCommit = false;
  state.failCommit = false;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function source(bytes = "actual media bytes") {
  const session = randomUUID(),
    id = randomUUID();
  await reserveStorage([{ id, kind: "uploads" }], session);
  const dir = path.join(root, "uploads", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "input.mp4"), bytes);
  const p = createEmptyProject();
  p.assets = [
    {
      id,
      kind: "video",
      ext: "mp4",
      displayName: "sample",
      sourceDurationSec: 3,
      streamUrl: "ignored",
    },
  ];
  p.clips = [
    clipFromAsset({
      asset: p.assets[0],
      trackId: p.tracks[0].id,
      timelineStartSec: 0,
    }),
  ];
  return { session, id, doc: projectDocumentDraft(p) };
}
it("saves and reloads title-only v4 with no media reference or generated-cache dependency", async () => {
  const project = addTitle(createEmptyProject(), randomUUID(), "日本語\n再編集できる本文")!;
  const id = randomUUID(); await saveProject(id, projectDocumentDraft(project));
  const doc = await readProject(id); expect(doc.project.assets).toEqual([]); expect(doc.version).toBe(4);
  const loaded = await loadProject(doc, randomUUID()); expect(loaded.project.clips).toEqual(project.clips);
  expect(loaded.project.assets).toEqual([]); await deleteProject(id);
});
it("saved versions protect bytes after tab release and restart; explicit delete respects other versions/tabs/jobs", async () => {
  const s = await source(),
    v1 = randomUUID(),
    v2 = randomUUID(),
    tab = randomUUID(),
    job = randomUUID();
  await saveProject(v1, s.doc);
  await saveProject(v2, s.doc);
  await protectStorageSession(tab, [s.id]);
  await reserveStorage(
    [{ id: job, kind: "jobs", active: true, dependencies: [s.id] }],
    s.session,
  );
  await releaseStorageSession(s.session);
  clearJobStoreForTests();
  const loaded = await loadProject(await readProject(v1), randomUUID());
  expect(loaded.project.playheadSec).toBe(0);
  expect(loaded.project.selectedClipIds).toEqual([]);
  await deleteProject(v1);
  await deleteProject(v1);
  expect(await listProjects()).toHaveLength(1);
  await pruneAllStorage([]);
  await access(path.join(root, "uploads", s.id));
  await deleteProject(v2);
  await releaseStorageSession(tab);
  await access(path.join(root, "uploads", s.id));
});
it("idempotent concurrent retries create one immutable revision and conflicting reuse is rejected", async () => {
  const s = await source(),
    id = randomUUID();
  const [a, b] = await Promise.all([
    saveProject(id, s.doc),
    saveProject(id, s.doc),
  ]);
  expect(a).toEqual(b);
  expect(await listProjects()).toHaveLength(1);
  s.doc.project.exportBaseName = "different";
  await expect(saveProject(id, s.doc)).rejects.toThrow(/競合/);
});
it("failed atomic commit leaves old manifest and protection intact; retry succeeds", async () => {
  const s = await source(),
    old = randomUUID(),
    next = randomUUID();
  await saveProject(old, s.doc);
  const before = await readFile(path.join(root, "retention.json"), "utf8");
  state.failCommit = true;
  await expect(saveProject(next, s.doc)).rejects.toThrow(/保存できません/);
  expect(await readFile(path.join(root, "retention.json"), "utf8")).toBe(
    before,
  );
  state.failCommit = false;
  await releaseStorageSession(s.session);
  await access(path.join(root, "uploads", s.id));
  await saveProject(next, s.doc);
  expect(await listProjects()).toHaveLength(2);
});
it("validates fingerprints, supports exact-byte relinking with a distinct logical ID, and rejects same-name different bytes", async () => {
  const s = await source(),
    revision = await saveProject(randomUUID(), s.doc);
  await rm(path.join(root, "uploads", s.id), { recursive: true });
  const tab = randomUUID();
  await expect(loadProject(revision.document, tab)).rejects.toThrow(/再指定/);
  const bad = await source("different bytes");
  await expect(
    loadProject(revision.document, tab, { [s.id]: bad.id }),
  ).rejects.toThrow(/再指定/);
  const good = await source();
  const loaded = await loadProject(revision.document, tab, { [s.id]: good.id });
  expect(loaded.project.assets[0].id).toBe(s.id);
  expect(loaded.project.assets[0].storageAssetId).toBe(good.id);
  expect(loaded.project.clips[0].parts![0].assetId).toBe(s.id);
  await releaseStorageSession(good.session);
  await access(path.join(root, "uploads", good.id));
});
it("collection versus load is serialized: either protected adoption succeeds or missing media rejects", async () => {
  const s = await source(),
    revision = await saveProject(randomUUID(), s.doc);
  await deleteProject(revision.id);
  const results = await Promise.allSettled([
    loadProject(revision.document, randomUUID()),
    releaseStorageSession(s.session),
  ]);
  expect(results[0].status).toBe("fulfilled");
  await access(path.join(root, "uploads", s.id));
});
it("load commit failure exposes no successful candidate and preserves the durable registry", async () => {
  const s = await source(),
    revision = await saveProject(randomUUID(), s.doc),
    before = await readFile(path.join(root, "retention.json"), "utf8");
  state.failCommit = true;
  await expect(loadProject(revision.document, randomUUID())).rejects.toThrow(
    /保存できません/,
  );
  expect(await readFile(path.join(root, "retention.json"), "utf8")).toBe(
    before,
  );
});
it("never evicts old versions on project quota or blob rejection", async () => {
  const doc = projectDocumentDraft(createEmptyProject());
  for (let i = 0; i < 50; i++) await saveProject(randomUUID(), doc);
  await expect(saveProject(randomUUID(), doc)).rejects.toThrow(/上限50/);
  expect(await listProjects()).toHaveLength(50);
  vi.stubEnv("STORAGE_DRIVER", "blob");
  await expect(saveProject(randomUUID(), doc)).rejects.toThrow(/ローカル/);
});

it("a lost result after atomic rename is safely retried without duplicate versions or losing old pins", async () => {
  const s = await source(),
    old = randomUUID(),
    next = randomUUID();
  await saveProject(old, s.doc);
  state.failAfterCommit = true;
  await expect(saveProject(next, s.doc)).rejects.toThrow(/保存できません/);
  state.failJobCommit = false;
  state.failAfterCommit = false;
  const retry = await saveProject(next, s.doc);
  expect(retry.id).toBe(next);
  expect(await listProjects()).toHaveLength(2);
  await releaseStorageSession(s.session);
  await access(path.join(root, "uploads", s.id));
});

it("only the explicitly deleted version loses its pin; the last deleted pin permits collection", async () => {
  const s = await source(),
    first = randomUUID(),
    second = randomUUID();
  await saveProject(first, s.doc);
  await saveProject(second, s.doc);
  await releaseStorageSession(s.session);
  await deleteProject(first);
  await pruneAllStorage([]);
  await access(path.join(root, "uploads", s.id));
  await deleteProject(second);
  await pruneAllStorage([]);
  await expect(access(path.join(root, "uploads", s.id))).rejects.toThrow();
});
it("saves empty and library-only states and rejects fabricated real-media metadata", async () => {
  await saveProject(randomUUID(), projectDocumentDraft(createEmptyProject()));
  const s = await source();
  s.doc.project.clips = [];
  await saveProject(randomUUID(), s.doc);
  s.doc.project.assets[0].sourceDurationSec = 100;
  await expect(saveProject(randomUUID(), s.doc)).rejects.toThrow(/メタデータ/);
});

it("late save retries cannot resurrect a deleted revision using durable tombstones", async () => {
  const s = await source(),
    id = randomUUID();
  await saveProject(id, s.doc);
  await deleteProject(id);
  await expect(saveProject(id, s.doc)).rejects.toThrow(/削除済み/);
  await releaseStorageSession(s.session);
  await expect(access(path.join(root, "uploads", s.id))).rejects.toThrow();
  expect(await listProjects()).toHaveLength(0);
  expect(
    JSON.parse(await readFile(path.join(root, "retention.json"), "utf8"))
      .deletedProjects[id],
  ).toBe(true);
  await expect(saveProject(id, s.doc)).rejects.toThrow(/削除済み/);
});
it("a delete that wins the race also rejects a not-yet-committed save with that ID", async () => {
  const s = await source(),
    id = randomUUID();
  const results = await Promise.allSettled([
    deleteProject(id),
    saveProject(id, s.doc),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  expect(await listProjects()).toHaveLength(0);
  await access(path.join(root, "uploads", s.id));
});
it("job metadata persistence failure rejects save without replacing old revisions; retry repairs metadata for restart", async () => {
  const s = await source(),
    old = randomUUID(),
    id = randomUUID(),
    job = randomUUID();
  await saveProject(old, s.doc);
  await reserveStorage([{ id: job, kind: "jobs" }], s.session);
  const dir = path.join(root, "jobs", job);
  await mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, "output_restored.mp4");
  await writeFile(outputPath, "restored bytes");
  createJobRecord("restore", { id: job, status: "done", outputPath });
  await vi.waitFor(async () => {
    await access(path.join(dir, "meta.json"));
  });
  // Simulate an earlier best-effort metadata write that never reached disk.
  await rm(path.join(dir, "meta.json"));
  const draft = structuredClone(s.doc);
  draft.project.assets[0].media = {
    ...draft.project.assets[0].media,
    kind: "job",
    id: job,
  };
  state.failJobCommit = true;
  await expect(saveProject(id, draft)).rejects.toThrow(/ジョブ情報を永続化/);
  expect((await listProjects()).map((p) => p.id)).toEqual([old]);
  await access(outputPath);
  state.failJobCommit = false;
  const saved = await saveProject(id, draft);
  const persisted = JSON.parse(
    await readFile(path.join(dir, "meta.json"), "utf8"),
  );
  expect(persisted.status).toBe("done");
  expect(persisted.outputPath).toBe(outputPath);
  clearJobStoreForTests();
  await releaseStorageSession(s.session);
  const loaded = await loadProject(saved.document, randomUUID());
  expect(loaded.project.assets[0].sourceJobId).toBe(job);
});

it("delete failures keep old pins before commit and an uncertain committed delete is safely retried", async () => {
  const s = await source(),
    first = randomUUID(),
    second = randomUUID();
  await saveProject(first, s.doc);
  await saveProject(second, s.doc);
  state.failCommit = true;
  await expect(deleteProject(first)).rejects.toThrow(/保存できません/);
  state.failCommit = false;
  expect((await listProjects()).map((p) => p.id)).toEqual([first, second]);
  await releaseStorageSession(s.session);
  await access(path.join(root, "uploads", s.id));
  state.failAfterCommit = true;
  await expect(deleteProject(first)).rejects.toThrow(/保存できません/);
  state.failAfterCommit = false;
  await deleteProject(first);
  await pruneAllStorage([]);
  expect((await listProjects()).map((p) => p.id)).toEqual([second]);
  await access(path.join(root, "uploads", s.id));
  await expect(saveProject(first, s.doc)).rejects.toThrow(/削除済み/);
});
