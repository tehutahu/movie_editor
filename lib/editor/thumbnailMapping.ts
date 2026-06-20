/** Map playhead position within a clip to filmstrip background offset (0..100%). */
export function filmstripOffsetPercent(params: {
  clipStartSec: number;
  clipDurationSec: number;
  playheadSec: number;
}): number {
  const { clipStartSec, clipDurationSec, playheadSec } = params;
  if (clipDurationSec <= 0) return 0;
  const rel = playheadSec - clipStartSec;
  const pct = Math.max(0, Math.min(1, rel / clipDurationSec));
  return pct * 100;
}

export function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const frac = Math.floor((s - whole) * 100);
  return `${m}:${String(whole).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
}

export function pixelsPerSec(zoom: number, base = 80): number {
  return base * zoom;
}

export function secToPx(sec: number, pixelsPerSecond: number): number {
  return sec * pixelsPerSecond;
}

export function pxToSec(px: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond <= 0) return 0;
  return px / pixelsPerSecond;
}
