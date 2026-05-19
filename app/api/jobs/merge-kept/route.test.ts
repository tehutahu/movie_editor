import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const ffmpegMocks = vi.hoisted(() => ({
  assertFfmpegAvailable: vi.fn().mockResolvedValue(undefined),
  probeVideo: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
  resolveInputPath: vi.fn(),
}));

vi.mock("@/lib/ffmpeg", () => ({
  assertFfmpegAvailable: ffmpegMocks.assertFfmpegAvailable,
  probeVideo: ffmpegMocks.probeVideo,
  buildConcatDemuxerListFile: vi.fn(),
  concatViaDemuxer: vi.fn(),
  extractSegmentTimes: vi.fn(),
}));

vi.mock("@/lib/mediaSource", () => ({
  resolveInputPath: mediaMocks.resolveInputPath,
}));

vi.mock("@/lib/jobs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/jobs")>();
  return {
    ...mod,
    runDetached: vi.fn(),
  };
});

const VID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

describe("POST /api/jobs/merge-kept", () => {
  beforeEach(() => {
    ffmpegMocks.probeVideo.mockReset();
    mediaMocks.resolveInputPath.mockReset();
    ffmpegMocks.assertFfmpegAvailable.mockClear();
  });

  async function postJson(body: unknown) {
    return POST(
      new Request("http://test/api/jobs/merge-kept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  it("不正な JSON で 400", async () => {
    const res = await postJson("{");
    expect(res.status).toBe(400);
    expect(ffmpegMocks.probeVideo).not.toHaveBeenCalled();
  });

  it("videoId 欠落で 400", async () => {
    const res = await postJson({});
    expect(res.status).toBe(400);
  });

  it("不正 UUID で 400", async () => {
    const res = await postJson({
      videoId: "xxx",
      removeRanges: [{ startSec: 0, endSec: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("入力解決エラーが「見つかりません」を含むなら 404", async () => {
    mediaMocks.resolveInputPath.mockRejectedValueOnce(
      new Error("動画が見つかりません。"),
    );
    const res = await postJson({
      videoId: VID,
      removeRanges: [{ startSec: 0, endSec: 1 }],
    });
    expect(res.status).toBe(404);
  });

  it("不正 removeRanges と probe 成功では 400", async () => {
    mediaMocks.resolveInputPath.mockResolvedValueOnce({
      inputPath: "/fake/in.mp4",
      videoId: VID,
    });
    ffmpegMocks.probeVideo.mockResolvedValueOnce({
      durationSec: 10,
      hasAudio: true,
      hasVideo: true,
    });
    const res = await postJson({
      videoId: VID,
      removeRanges: [],
    });
    expect(res.status).toBe(400);
  });

  it("正常系はジョブ ID と keptSegments を返す（runDetached は未実行モック）", async () => {
    mediaMocks.resolveInputPath.mockResolvedValueOnce({
      inputPath: "/fake/in.mp4",
      videoId: VID,
    });
    ffmpegMocks.probeVideo.mockResolvedValueOnce({
      durationSec: 10,
      hasAudio: true,
      hasVideo: true,
    });
    const res = await postJson({
      videoId: VID,
      removeRanges: [{ startSec: 1, endSec: 2 }],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.jobId).toBe("string");
    expect(json.keptSegments).toEqual([
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 10 },
    ]);
  });
});
