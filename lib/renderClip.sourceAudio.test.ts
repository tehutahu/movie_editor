import { beforeEach, expect, it, vi } from "vitest";
import { renderClipToFile } from "./renderClip";
import type { Asset, MediaClip } from "./editor/types";
const state = vi.hoisted(() => ({ identity: vi.fn(), recover: vi.fn(), run: vi.fn(),
  healthy: false, repaired: new Set<string>() }));
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => `/source/${a.id}` }));
vi.mock("@/lib/sourceAvClock", () => ({ extractEditorSegment: vi.fn(), repairSourceAvSegment: vi.fn(async () => false) }));
vi.mock("@/lib/containAudioRepair", () => ({ containAudioInputIdentity: state.identity }));
vi.mock("@/lib/selectedSegmentAudio", () => ({ recoverSelectedSegmentAudio: state.recover }));
vi.mock("node:fs/promises", () => ({ unlink: vi.fn(async () => undefined) }));
vi.mock("@/lib/ffmpeg", () => ({ imageToVideoSegment: vi.fn(), runFfmpegCommand: state.run,
  probeVideo: vi.fn(async () => ({ hasVideo: true, hasAudio: true, durationSec: 300 })),
  probeMedia: async (f: string) => ({ streams: [{ codec_type: "video" },
    ...(state.healthy || state.repaired.has(f) ? [{ codec_type: "audio" }] : [])] }),
}));
const assets: Asset[] = [{ id: "a", kind: "video", ext: "mp4", displayName: "a", streamUrl: "/x" }];
function clip(): MediaClip { return { id: "c", trackId: "t", timelineStartSec: 0, durationSec: .6, audioGain: 0,
  transform: { x: .5, y: .5, scale: 1 }, parts: [
    { assetId: "a", sourceInSec: .1, sourceOutSec: .4 }, { assetId: "a", sourceInSec: .4, sourceOutSec: .7 },
  ] }; }
const render = (c = clip(), budget?: { remaining: number }) => renderClipToFile({ clip: c, assets,
  jobDir: "/job", outputPath: "/job/out.mp4", width: 320, height: 320, sourceAudioRecoveryBudget: budget });
beforeEach(() => {
  vi.clearAllMocks(); state.healthy = false; state.repaired.clear();
  state.identity.mockImplementation(async (file: string) => ({ file, stat: {} }));
  state.recover.mockImplementation(async (p: { output: string }) => { state.repaired.add(p.output); return "repaired"; });
  state.run.mockResolvedValue(undefined);
});
it("captures identity before extraction and recovers source audio before gain, with one attempt", async () => {
  state.run.mockImplementation(async (args: string[]) => {
    if (args.at(-1) === "/job/out_source_0.mp4") expect(state.identity).toHaveBeenCalledWith("/source/a");
  });
  await render();
  expect(state.recover).toHaveBeenCalledTimes(1);
  expect(state.recover).toHaveBeenCalledWith(expect.objectContaining({ input: "/source/a", output: "/job/out_source_0.mp4", start: .1, end: .4,
    inputIdentity: expect.objectContaining({ file: "/source/a" }) }));
  // audioGain=0 is deliberately not applied to source extraction.
  expect(state.run.mock.calls[0][0].join(" ")).not.toContain("volume=");
});
it("shares the single attempt across all clips in a job", async () => {
  const budget = { remaining: 1 }; await render(clip(), budget); await render(clip(), budget);
  expect(budget.remaining).toBe(0); expect(state.recover).toHaveBeenCalledTimes(1);
});
it("healthy normalized audio incurs no recovery subprocess", async () => {
  state.healthy = true; await render(); expect(state.recover).not.toHaveBeenCalled();
});
it.each(["missing", "unchanged"])("keeps existing empty audio on recovery %s, without silence or a new error", async result => {
  state.recover.mockResolvedValue(result); await render();
  const args = state.run.mock.calls.at(-1)![0] as string[];
  expect(args).toContain("-an"); expect(args.join(" ")).not.toContain("anullsrc");
});
it("keeps late windows outside the early recovery without extra identity work", async () => {
  const c = clip(); c.parts = c.parts.map(p => ({ ...p, sourceInSec: p.sourceInSec + 250, sourceOutSec: p.sourceOutSec + 250 }));
  await render(c); expect(state.identity).not.toHaveBeenCalled(); expect(state.recover).not.toHaveBeenCalled();
});
it("does not recover without a pre-extraction identity", async () => {
  state.identity.mockResolvedValue(null); await render(); expect(state.recover).not.toHaveBeenCalled();
});
it("propagates uncertain recovery cleanup rather than publishing a successful concat", async () => {
  state.recover.mockRejectedValue(new Error("uncertain cleanup")); await expect(render()).rejects.toThrow("uncertain cleanup");
  expect(state.run).toHaveBeenCalledTimes(1);
});
