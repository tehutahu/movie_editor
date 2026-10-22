import { beforeEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ resolve: vi.fn(), derive: vi.fn() }));
vi.mock("./assetResolve", () => ({ resolveAssetInputPath: mocked.resolve }));
vi.mock("./negativeMkvAudio", () => ({ negativeMkvPreviewAudio: mocked.derive }));
import { POST } from "../app/api/media/audio-preview/route";
const asset = { id: "12345678-1234-4123-8123-123456789abc", kind: "video", ext: "mkv", displayName: "source", streamUrl: "/api/assets/12345678-1234-4123-8123-123456789abc/stream", sourceDurationSec: 2 };
const request = (a: unknown) => new Request("http://localhost/api/media/audio-preview", { method: "POST", body: JSON.stringify({ asset: a }) });
beforeEach(() => { vi.clearAllMocks(); mocked.resolve.mockResolvedValue("/actual/input.mkv"); mocked.derive.mockResolvedValue(Buffer.from("derived")); });
it("only returns a fully resolved candidate, independent of caller URLs", async () => {
  const r = await POST(request({ ...asset, streamUrl: "https://example.invalid/not-used" }));
  expect(r.status).toBe(200); expect(r.headers.get("Content-Type")).toBe("audio/mp4"); expect(r.headers.get("Cache-Control")).toBe("no-store"); expect(await r.text()).toBe("derived");
  expect(mocked.derive).toHaveBeenCalledWith("/actual/input.mkv");
});
it.each([{ ext: "mp4" }, { kind: "image", ext: "png" }, { sourceJobId: "12345678-1234-4123-8123-123456789abc" }])("other media remain on the original path %j", async change => {
  const r = await POST(request({ ...asset, ...change })); expect(r.status).toBe(204); expect(mocked.resolve).not.toHaveBeenCalled(); expect(mocked.derive).not.toHaveBeenCalled();
});
it("unknown diagnostics return no substitute bytes", async () => { mocked.derive.mockResolvedValue(null); const r = await POST(request(asset)); expect(r.status).toBe(204); expect(await r.text()).toBe(""); });
it("invalid input and failed resolution never become a stream path", async () => { const r = await POST(request({ ...asset, id: "../private" })); expect(r.status).toBe(400); expect(mocked.resolve).not.toHaveBeenCalled(); });
