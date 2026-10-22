/**
 * A source cut is relative to the media's start; HTML currentTime need not be.
 * Measure the browser's own earliest time with a completed seek, rather than
 * inferring it from buffered/seekable (which can start at zero for delayed PTS).
 * This belongs to a decoded video instance, never to the saved project.
 */
export function createPreviewVideoClock(media: HTMLVideoElement, invalidate: () => void) {
  let origin: number | null = null;
  let calibrating = false;
  let disposed = false;
  let requestedMicros: number | null = null;
  const metadata = () => {
    if (disposed || origin !== null || calibrating) return;
    calibrating = true;
    media.currentTime = 0;
  };
  const seeked = () => {
    if (disposed) return;
    if (!calibrating) {
      const requested = requestedMicros;
      requestedMicros = null;
      // Chromium can land one microsecond before the requested boundary after
      // translating a positive-origin WebM clock. Correct only an observed
      // underseek, once; a blanket bias would advance genuinely earlier seeks.
      const actual = Math.round(media.currentTime * 1_000_000);
      if (origin !== null && origin > 0 && requested !== null &&
          actual < requested && requested - actual <= 2 && !media.seeking) {
        media.currentTime = Math.min((requested + 1) / 1_000_000, media.duration);
      }
      return;
    }
    calibrating = false;
    if (Number.isFinite(media.currentTime) && media.currentTime >= 0) {
      origin = media.currentTime;
      invalidate();
    }
  };
  media.addEventListener("loadedmetadata", metadata);
  media.addEventListener("seeked", seeked);
  return {
    target(sourceTime: number): number | null {
      if (origin === null || disposed) return null;
      const target = origin + sourceTime;
      return Number.isFinite(media.duration) ? Math.min(target, media.duration) : target;
    },
    seek(target: number) {
      if (disposed || origin === null) return;
      requestedMicros = origin > 0 ? Math.round(target * 1_000_000) : null;
      media.currentTime = target;
    },
    dispose() {
      disposed = true;
      media.removeEventListener("loadedmetadata", metadata);
      media.removeEventListener("seeked", seeked);
    },
  };
}
