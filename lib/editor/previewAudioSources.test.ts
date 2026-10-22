import { afterEach, expect, it, vi } from "vitest";
import { createPreviewAudioSources } from "./previewAudioSources";
import type { Asset } from "./types";
const asset: Asset = { id: "id", kind: "video", ext: "mkv", displayName: "a", streamUrl: "/api/assets/12345678-1234-4123-8123-123456789abc/stream" };
const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mp4", "Content-Length": "3" } });
afterEach(() => vi.restoreAllMocks());
it("publishes stable Blob URLs only after preparation and reclaims them on clear", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response()), create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready"), revoke = vi.spyOn(URL, "revokeObjectURL");
  const owner = createPreviewAudioSources(), before = structuredClone(asset);
  expect(owner.url(asset)).toBe(asset.streamUrl); await owner.prepare([asset]); expect(owner.url(asset)).toBe("blob:ready");
  await owner.prepare([asset]); expect(fetch).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1); expect(asset).toEqual(before);
  owner.clear(); expect(revoke).toHaveBeenCalledWith("blob:ready"); expect(owner.url(asset)).toBe(asset.streamUrl);
});
it.each([{ ext: "mp4" }, { kind: "image" }, { sourceJobId: "job" }, { streamUrl: "https://external.invalid/file.mkv" }])("does not fetch other media %j", async change => {
  const fetch = vi.spyOn(globalThis, "fetch"), a = { ...asset, ...change } as Asset, owner = createPreviewAudioSources();
  await owner.prepare([a]); expect(fetch).not.toHaveBeenCalled(); expect(owner.url(a)).toBe(a.streamUrl);
});
it("ineligible diagnostics retain the original URL across repeat play", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 })), owner = createPreviewAudioSources();
  await owner.prepare([asset]); await owner.prepare([asset]); expect(fetch).toHaveBeenCalledTimes(1); expect(owner.url(asset)).toBe(asset.streamUrl);
});
it.each([
  { "Content-Type": "application/json", "Content-Length": "3" },
  { "Content-Type": "audio/mp4" },
  { "Content-Type": "audio/mp4", "Content-Length": "1048577" },
  { "Content-Type": "audio/mp4", "Content-Length": "4" },
])("unknown or oversized HTTP metadata cannot publish a URL %j", async headers => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers }));
  const create = vi.spyOn(URL, "createObjectURL"), owner = createPreviewAudioSources();
  await owner.prepare([asset]); expect(create).not.toHaveBeenCalled(); expect(owner.url(asset)).toBe(asset.streamUrl);
});
it("late completion after cancellation cannot publish a new source", async () => {
  let resolve!: (r: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(r => { resolve = r; }));
  const create = vi.spyOn(URL, "createObjectURL"), owner = createPreviewAudioSources(), pending = owner.prepare([asset]);
  owner.cancel(); resolve(response()); await pending; expect(create).not.toHaveBeenCalled(); expect(owner.url(asset)).toBe(asset.streamUrl);
});
it("all referenced sources are prepared before any new URL becomes visible", async () => {
  let resolve!: (r: Response) => void;
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:staged"); const revoke = vi.spyOn(URL, "revokeObjectURL");
  const owner = createPreviewAudioSources(), pending = owner.prepare([asset, { ...asset, id: "second" }]);
  await vi.waitFor(() => expect(resolve).toBeDefined()); expect(owner.url(asset)).toBe(asset.streamUrl);
  owner.clear(); resolve(response()); await pending; expect(revoke).toHaveBeenCalledWith("blob:staged"); expect(owner.url(asset)).toBe(asset.streamUrl);
});
it("bounds resident assets and reclaims media no longer referenced", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bounded"); const revoke = vi.spyOn(URL, "revokeObjectURL");
  const owner = createPreviewAudioSources(), assets = Array.from({ length: 10 }, (_, i) => ({ ...asset, id: String(i) }));
  await owner.prepare(assets); expect(fetch).toHaveBeenCalledTimes(8); expect(owner.url(assets[9])).toBe(asset.streamUrl);
  await owner.prepare([]); expect(revoke).toHaveBeenCalledTimes(8);
});
