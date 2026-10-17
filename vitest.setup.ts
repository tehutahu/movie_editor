import { afterAll, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
const testRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "movie-editor-tests-"));
  process.env.MOVIE_EDITOR_STORAGE_ROOT = root;
  return root;
});
afterAll(async () => { await flushJobWritesForTests(); await rm(testRoot, { recursive: true, force: true }); });
import { clearJobStoreForTests, flushJobWritesForTests } from "@/lib/jobs";

afterEach(async () => {
  delete process.env.MAX_UPLOAD_BYTES;
  await flushJobWritesForTests();
  clearJobStoreForTests();
});
