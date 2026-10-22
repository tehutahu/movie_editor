import { expect, it, vi } from "vitest";
import { createPreviewVideoClock } from "./previewVideoClock";

class Video extends EventTarget {
  currentTime = 0;
  duration = 2;
  seeking = false;
}
function setup() {
  const video = new Video();
  const invalidate = vi.fn();
  const clock = createPreviewVideoClock(video as unknown as HTMLVideoElement, invalidate);
  return { video, invalidate, clock };
}
it("waits for a completed zero seek, rather than sampling transient metadata time", () => {
  const { video, clock, invalidate } = setup();
  video.currentTime = 1.9;
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(0);
  expect(clock.target(0.5)).toBeNull();
  video.currentTime = 2; // native clamp, after metadata's temporary duration
  video.duration = 4;
  video.dispatchEvent(new Event("seeked"));
  expect(clock.target(0.5)).toBe(2.5);
  expect(invalidate).toHaveBeenCalledTimes(1);
  video.currentTime = 3;
  video.dispatchEvent(new Event("seeked"));
  expect(clock.target(0.5)).toBe(2.5); // later editorial seeks cannot recalibrate
});
it("keeps zero-origin times exact and uses live duration for EOF", () => {
  const { video, clock } = setup();
  video.dispatchEvent(new Event("loadedmetadata"));
  video.dispatchEvent(new Event("seeked"));
  expect(clock.target(0.123456789)).toBe(0.123456789);
  expect(clock.target(3)).toBe(2);
  video.duration = 4;
  expect(clock.target(3)).toBe(3);
});
it("disposes the clock before late native events can revive an old media owner", () => {
  const { video, clock, invalidate } = setup();
  video.dispatchEvent(new Event("loadedmetadata"));
  clock.dispose();
  video.currentTime = 2;
  video.dispatchEvent(new Event("seeked"));
  expect(clock.target(0)).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();
});
it("corrects an observed microsecond underseek only once on positive clocks", () => {
  const { video, clock } = setup();
  video.dispatchEvent(new Event("loadedmetadata"));
  video.currentTime = .033;
  video.dispatchEvent(new Event("seeked"));
  clock.seek(clock.target(1)!);
  video.currentTime = 1.032999;
  video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(1.033001);
  video.currentTime = 1.032999;
  video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(1.032999);
  clock.seek(clock.target(.999999)!);
  video.currentTime = 1.032999;
  video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(1.032999); // truly earlier target stays earlier
});
it("never retries normal zero-origin seeks or large native clamps", () => {
  const { video, clock } = setup();
  video.dispatchEvent(new Event("loadedmetadata"));
  video.dispatchEvent(new Event("seeked"));
  clock.seek(1);
  video.currentTime = .999999;
  video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(.999999);
});
it("uses a late verified video origin only when the HTML AV clock calibrated to zero", () => {
  const { video, clock, invalidate } = setup(); video.duration = 4;
  video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  expect(clock.target(.5)).toBe(.5);
  clock.setVerifiedVideoOrigin(2);
  expect(clock.target(.5)).toBe(2.5); expect(invalidate).toHaveBeenCalledTimes(2);
  clock.seek(2.5); video.currentTime = 2.499999; video.dispatchEvent(new Event("seeked"));
  expect(video.currentTime).toBe(2.500001);
  clock.dispose(); clock.setVerifiedVideoOrigin(3); expect(invalidate).toHaveBeenCalledTimes(2);
});
it("never double-adds a video origin already measured by the browser", () => {
  const { video, clock } = setup(); video.duration = 4;
  clock.setVerifiedVideoOrigin(2);
  video.dispatchEvent(new Event("loadedmetadata")); video.currentTime = 2; video.dispatchEvent(new Event("seeked"));
  expect(clock.target(.5)).toBe(2.5);
  for (const unknown of [null, undefined, "2", NaN, Infinity, -1, 0]) clock.setVerifiedVideoOrigin(unknown);
  expect(clock.target(.5)).toBe(2.5);
});
