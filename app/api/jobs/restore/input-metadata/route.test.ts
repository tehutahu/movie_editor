import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";
import { resolveInputPath } from "@/lib/mediaSource";
import { probeRestoreInputAudio } from "@/lib/restoreInputAudio";
vi.mock("@/lib/mediaSource", () => ({ resolveInputPath: vi.fn() }));
vi.mock("@/lib/restoreInputAudio", () => ({ probeRestoreInputAudio: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("probes the resolver's actual completed job output, not a client URL or original upload", async () => {
  vi.mocked(resolveInputPath).mockResolvedValue({ videoId: "physical", sourceJobId: "restored", inputPath: "/resolved/job/output.mp4" });
  vi.mocked(probeRestoreInputAudio).mockResolvedValue({ status: "known", streamOrdinal: 0, streamIndex: 2, sampleRateHz: 48000 });
  const response = await GET(new Request("http://localhost/api/jobs/restore/input-metadata?videoId=physical&sourceJobId=restored&streamUrl=https://untrusted/file"));
  expect(resolveInputPath).toHaveBeenCalledWith({ videoId: "physical", sourceJobId: "restored" });
  expect(probeRestoreInputAudio).toHaveBeenCalledWith("/resolved/job/output.mp4");
  expect(await response.json()).toEqual({ videoId: "physical", sourceJobId: "restored", inputAudio: { status: "known", streamOrdinal: 0, streamIndex: 2, sampleRateHz: 48000 } });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("returns none without changing the manual restore contract", async () => {
  vi.mocked(resolveInputPath).mockResolvedValue({ videoId: "id", inputPath: "/resolved/input.mp4" });
  vi.mocked(probeRestoreInputAudio).mockResolvedValue({ status: "none" });
  expect(await (await GET(new Request("http://localhost/api/jobs/restore/input-metadata?videoId=id"))).json()).toEqual({ videoId: "id", inputAudio: { status: "none" } });
});
it.each([["参照元ジョブが見つかりません。", 404], ["参照元ジョブが完了していません。", 400], ["videoId が不正です。", 400]])("preserves resolver failure %s", async (message, status) => {
  vi.mocked(resolveInputPath).mockRejectedValue(Error(message));
  const response = await GET(new Request("http://localhost/api/jobs/restore/input-metadata?videoId=bad"));
  expect(response.status).toBe(status); expect(probeRestoreInputAudio).not.toHaveBeenCalled(); expect(await response.json()).toEqual({ error: message });
});
it("reports probe failure without manufacturing a fallback rate", async () => {
  vi.mocked(resolveInputPath).mockResolvedValue({ videoId: "id", inputPath: "/resolved/input.mp4" });
  vi.mocked(probeRestoreInputAudio).mockRejectedValue(Error("ffprobe failed"));
  const response = await GET(new Request("http://localhost/api/jobs/restore/input-metadata?videoId=id"));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "ffprobe failed" });
});
