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
