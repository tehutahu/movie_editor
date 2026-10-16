import { describe, expect, it, vi } from "vitest";
import { createPreviewFrames } from "./previewFrames";
function harness() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const draw = vi.fn();
  const frames = createPreviewFrames({ draw, request: callback => { callbacks.set(++id, callback); return id; }, cancel: key => { callbacks.delete(key); } });
  const flush = () => { const first = callbacks.entries().next().value; if (!first) throw Error("no frame"); callbacks.delete(first[0]); first[1](0); };
  return { frames, callbacks, draw, flush };
}
describe("preview frame invalidation", () => {
  it("coalesces dirty events into one frame and stays idle afterward", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.frames.invalidate();
    expect(h.callbacks.size).toBe(1); h.flush();
    expect(h.draw).toHaveBeenCalledTimes(1); expect(h.callbacks.size).toBe(0);
  });
  it("keeps playback continuous and leaves one final stopped frame", () => {
    const h = harness(); h.frames.setPlaying(true); h.flush(); h.flush();
    expect(h.draw).toHaveBeenCalledTimes(2); expect(h.callbacks.size).toBe(1);
    h.frames.setPlaying(false); h.flush();
    expect(h.draw).toHaveBeenCalledTimes(3); expect(h.callbacks.size).toBe(0);
  });
  it("retains an asynchronous invalidation emitted during drawing", () => {
    const h = harness(); h.draw.mockImplementationOnce(() => h.frames.invalidate());
    h.frames.invalidate(); h.flush(); expect(h.callbacks.size).toBe(1); h.flush();
    expect(h.draw).toHaveBeenCalledTimes(2); expect(h.callbacks.size).toBe(0);
  });
  it("cancels work and ignores late callbacks after disposal", () => {
    const h = harness(); h.frames.setPlaying(true);
    const late = [...h.callbacks.values()][0]!;
    h.frames.dispose(); h.frames.invalidate(); h.frames.setPlaying(true); late(0);
    expect(h.callbacks.size).toBe(0); expect(h.draw).not.toHaveBeenCalled();
  });
  it("supports an independently mounted scheduler after cleanup", () => {
    const old = harness(); old.frames.invalidate(); old.frames.dispose();
    const next = harness(); next.frames.invalidate(); next.flush();
    expect(next.draw).toHaveBeenCalledTimes(1); expect(old.draw).not.toHaveBeenCalled();
  });
});
