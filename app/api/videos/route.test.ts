import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/validation", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/validation")>();
  return { ...mod, MAX_UPLOAD_BYTES: 100 };
});

vi.mock("@/lib/storage", () => ({
  ensureStorageTrees: vi.fn(async () => undefined),
  newVideoId: vi.fn(() => "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
  pruneUploadsAfterSave: vi.fn(async () => undefined),
  saveUploadedVideo: vi.fn(async () => undefined),
}));

import { POST } from "./route";
import { ensureStorageTrees, newVideoId, saveUploadedVideo } from "@/lib/storage";
import { parseAllowedVideoExtension } from "@/lib/validation";

describe("POST /api/videos", () => {
  beforeEach(() => {
    vi.mocked(saveUploadedVideo).mockClear();
    vi.mocked(newVideoId).mockReturnValue(
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    );
  });
  it("file が無いとき 400", async () => {
    const fd = new FormData();
    const res = await POST(
      new Request("http://test/api/videos", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("未対応拡張子は 400", async () => {
    vi.mocked(ensureStorageTrees).mockResolvedValue(undefined);
    const fd = new FormData();
    fd.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "clip.webm", {
        type: "video/webm",
      }),
    );
    const res = await POST(
      new Request("http://test/api/videos", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
    expect(saveUploadedVideo).not.toHaveBeenCalled();
    expect(parseAllowedVideoExtension("clip.webm")).toBeNull();
  });

  it("許可拡張子で保存し videoId を返す", async () => {
    vi.mocked(newVideoId).mockReturnValue(
      "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
    );
    const fd = new FormData();
    fd.set(
      "file",
      new File([new Uint8Array([1, 2])], "a.mp4", { type: "video/mp4" }),
    );

    const res = await POST(
      new Request("http://test/api/videos", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(200);
    expect(saveUploadedVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
        ext: "mp4",
      }),
    );
    const json = await res.json();
    expect(json.videoId).toBe("b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22");
    expect(json.ext).toBe("mp4");

    vi.mocked(newVideoId).mockReturnValue(
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    );
  });

  it("サイズ上限超過で 413（検証側の上限はテストで 100 に差し替え）", async () => {
    const fd = new FormData();
    fd.set(
      "file",
      new File([new Uint8Array(101)], "a.mp4", { type: "video/mp4" }),
    );
    const res = await POST(
      new Request("http://test/api/videos", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(413);
    expect(saveUploadedVideo).not.toHaveBeenCalled();
  });
});
