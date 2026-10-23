import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { exportCompositionToFile } from "./exportComposition";
import { createEmptyProject } from "./editor/project";
import { runFfmpegCommand } from "./ffmpeg";

vi.mock("@/lib/renderClip", () => ({ renderClipToFile: vi.fn() }));
vi.mock("@/lib/ffmpeg", () => ({
  probeVideo: vi.fn(async () => ({ hasAudio: true })),
  runFfmpegCommand: vi.fn(),
}));

// The 24-hour upper bound is checked without generating a 24-hour video.
it.each([0, 100, 100.001, 180.25, 86399.5])("formats audio delay independently of pixel limits at %ss", async (start) => {
  const project = createEmptyProject();
  const assetId = randomUUID();
  project.assets = [{ id: assetId, kind: "video", ext: "mp4", displayName: "clock", streamUrl: "/x" }];
  project.compositionDurationSec = start + .5;
  project.clips = [{ id: randomUUID(), trackId: project.tracks[0]!.id, timelineStartSec: start, durationSec: .5,
    parts: [{ assetId, sourceInSec: 0, sourceOutSec: .5 }], transform: { x: .5, y: .5, scale: 3 } }];
  await exportCompositionToFile({ project, jobDir: "/unused", outputPath: "/unused/out.mp4" });
  const args = vi.mocked(runFfmpegCommand).mock.lastCall![0];
  const graph = args[args.indexOf("-filter_complex") + 1];
  expect(graph).toContain(`adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}`);
});


it.each(["stretch", "layout"])("shares one source-audio recovery budget across every clip in the %s renderer", async renderer => {
  const project = createEmptyProject(), assetId = randomUUID();
  project.assets = [{ id: assetId, kind: "video", ext: "mp4", displayName: "a", streamUrl: "/x" }];
  project.compositionDurationSec = 2;
  project.clips = [0, 1].map(start => ({ id: randomUUID(), trackId: project.tracks[0].id,
    timelineStartSec: start, durationSec: .6, parts: [
      { assetId, sourceInSec: .1, sourceOutSec: .4 }, { assetId, sourceInSec: .4, sourceOutSec: .7 },
    ], transform: { x: .5, y: .5, scale: 1 } }));
  const { renderClipToFile } = await import("./renderClip"); vi.mocked(renderClipToFile).mockClear();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "source-audio-budget-"));
  try {
    const run = renderer === "stretch" ? exportCompositionToFile : (await import("./exportLayoutComposition")).exportLayoutCompositionToFile;
    await run({ project, jobDir: dir, outputPath: path.join(dir, "out.mp4") });
  } finally { await rm(dir, { recursive: true, force: true }); }
  const calls = vi.mocked(renderClipToFile).mock.calls;
  expect(calls.length).toBe(2);
  expect(calls[0][0].sourceAudioRecoveryBudget).toEqual({ remaining: 1 });
  expect(calls[1][0].sourceAudioRecoveryBudget).toBe(calls[0][0].sourceAudioRecoveryBudget);
});
