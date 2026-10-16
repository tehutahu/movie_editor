/** Coalesce invalidations; only playback keeps requesting subsequent frames. */
export function createPreviewFrames({ draw, request, cancel }: {
  draw: () => void;
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}) {
  let pending: number | null = null;
  let playing = false;
  let disposed = false;
  function invalidate() {
    if (disposed || pending !== null) return;
    pending = request(() => {
      pending = null;
      if (disposed) return;
      draw();
      if (playing) invalidate();
    });
  }
  return {
    invalidate,
    setPlaying(value: boolean) {
      playing = value;
      invalidate(); // Include the final stopped frame.
    },
    dispose() {
      disposed = true;
      playing = false;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
