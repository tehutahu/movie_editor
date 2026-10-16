/** Label positions only; timeline coordinates and extent are independent. */
export function timelineRulerMarks(durationSec: number, pixelsPerSecond: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec < 0 || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return [];
  const minimum = Math.max(1, 80 / pixelsPerSecond);
  if (!Number.isFinite(minimum)) return [];
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  const step = [1, 2, 5, 10].map((multiple) => multiple * magnitude).find((value) => value >= minimum);
  if (step === undefined || !Number.isFinite(step)) return [];
  const count = Math.floor(Math.ceil(durationSec) / step) + 1;
  if (!Number.isSafeInteger(count) || count > 0xffffffff) return [];
  return Array.from({ length: count }, (_, index) => index * step);
}
