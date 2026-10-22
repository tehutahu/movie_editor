import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { POST } from "./route";
import { GET as download } from "@/app/api/download/[jobId]/route";
import { GET as stream } from "@/app/api/jobs/[jobId]/stream/route";
import { getJobRecord, flushJobWritesForTests } from "@/lib/jobs";
import { JOBS_ROOT, UPLOADS_ROOT } from "@/lib/paths";
import { reserveStorage } from "@/lib/storageRetention";
import { AudioAuxCleanupError } from "@/lib/containAudioRepair";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), guard: vi.fn(), extract: vi.fn(), failUnlink: false }));
vi.mock("@/lib/ffmpeg", async original => ({
  ...await original<typeof import("@/lib/ffmpeg")>(), assertFfmpegAvailable: async () => undefined,
  probeVideo: async () => ({ durationSec: 302, hasVideo: true, hasAudio: true }),
}));
vi.mock("@/lib/mediaSource", () => ({ resolveInputPath: mocks.resolve }));
vi.mock("@/lib/sourceAvClock", () => ({ extractEditorSegment: mocks.extract }));
vi.mock("@/lib/selectedSegmentAudio", () => ({ recoverSelectedSegmentAudio: mocks.guard }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, unlink: async (file: string) => {
    if (mocks.failUnlink && file.endsWith("/output_segment.mp4")) throw new Error("synthetic unlink denied");
    return fs.unlink(file);
  } };
});
beforeEach(() => {
  mocks.failUnlink = false; mocks.resolve.mockReset(); mocks.guard.mockReset(); mocks.extract.mockReset();
  mocks.extract.mockImplementation(async ({ outputPath }: { outputPath: string }) => { await writeFile(outputPath, "legacy bytes"); });
});
async function start(sourceJobId?: string) {
  const videoId = randomUUID(), session = randomUUID();
  await reserveStorage([{ id: videoId, kind: "uploads" }], session);
  const dir = path.join(UPLOADS_ROOT, videoId); await mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, "source.mp4"); await writeFile(inputPath, "source bytes");
  mocks.resolve.mockResolvedValue({ inputPath, videoId });
  const response = await POST(new Request("http://test/api/jobs/export-segment", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, editorSessionId: session, sourceJobId, startSec: .1, endSec: .7 }),
  }));
  expect(response.status).toBe(200);
  const { jobId } = await response.json();
  await vi.waitFor(() => expect(["done", "error"]).toContain(getJobRecord(jobId)?.status));
  await flushJobWritesForTests();
  return { jobId, inputPath, out: path.join(JOBS_ROOT, jobId, "output_segment.mp4") };
}
it("proven missing audio becomes job error, removes only output, and denies publication", async () => {
  mocks.guard.mockResolvedValue("missing");
  const { jobId, inputPath, out } = await start();
  expect(getJobRecord(jobId)).toMatchObject({ status: "error", error: expect.stringContaining("音声が欠落") });
  expect(getJobRecord(jobId)?.outputPath).toBeUndefined();
  await expect(access(out)).rejects.toThrow(); expect(await readFile(inputPath, "utf8")).toBe("source bytes");
  await access(path.join(JOBS_ROOT, jobId, "meta.json"));
  const ctx = { params: Promise.resolve({ jobId }) };
  expect((await download(new Request("http://test/api/download/" + jobId), ctx)).status).toBe(409);
  expect((await stream(new Request("http://test/api/jobs/" + jobId + "/stream"), ctx)).status).toBe(409);
});
it("inconclusive/healthy output retains its exact bytes and existing success contract", async () => {
  mocks.guard.mockResolvedValue("unchanged");
  const { jobId, out } = await start();
  expect(getJobRecord(jobId)).toMatchObject({ status: "done", outputPath: out });
  expect(await readFile(out, "utf8")).toBe("legacy bytes");
});
it("passes the resolved input and pre-extraction identity to diagnosis, including sourceJobId", async () => {
  mocks.guard.mockResolvedValue("unchanged");
  mocks.extract.mockImplementation(async ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
    await writeFile(inputPath, "changed after snapshot"); await writeFile(outputPath, "legacy bytes");
  });
  const sourceJobId = randomUUID(), { inputPath, out } = await start(sourceJobId);
  expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ sourceJobId }));
  expect(mocks.guard).toHaveBeenCalledWith({ input: inputPath, output: out, start: .1, end: .7,
    inputIdentity: expect.objectContaining({ file: inputPath, stat: expect.objectContaining({ size: 12 }) }) });
});
it("unlink failure stays a job error without registering output", async () => {
  mocks.guard.mockResolvedValue("missing"); mocks.failUnlink = true;
  const { jobId, out } = await start();
  expect(getJobRecord(jobId)).toMatchObject({ status: "error", error: "synthetic unlink denied" });
  expect(getJobRecord(jobId)?.outputPath).toBeUndefined(); await access(out);
});
it("process cleanup uncertainty cannot be converted into a published success", async () => {
  mocks.guard.mockRejectedValue(new AudioAuxCleanupError());
  const { jobId, out } = await start();
  expect(getJobRecord(jobId)?.status).toBe("error"); expect(getJobRecord(jobId)?.outputPath).toBeUndefined(); await access(out);
});
it("initial extraction failure is preserved and never invokes optional diagnosis", async () => {
  mocks.extract.mockRejectedValue(new Error("initial extraction failed"));
  const { jobId } = await start();
  expect(getJobRecord(jobId)).toMatchObject({ status: "error", error: "initial extraction failed" });
  expect(mocks.guard).not.toHaveBeenCalled();
});

it("verified recovery publishes the recovered file through the existing job contract", async () => {
  mocks.guard.mockImplementation(async ({ output }: { output: string }) => { await writeFile(output, "recovered bytes"); return "repaired"; });
  const { jobId, out } = await start();
  expect(getJobRecord(jobId)).toMatchObject({ status: "done", outputPath: out });
  expect(await readFile(out, "utf8")).toBe("recovered bytes");
});
