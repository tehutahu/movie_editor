import type { Clip } from "@/lib/editor/types";

type Decimal = { n: bigint; d: bigint };
const ZERO = BigInt(0), ONE = BigInt(1), TEN = BigInt(10);
const precisionError = () => new Error("素材の時刻精度では結合クリップの境界を安全に書き出せません。");

/** Canonical JSON decimal, rather than the binary result of adding boundaries. */
function decimal(value: number): Decimal {
  if (!Number.isFinite(value)) throw precisionError();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) throw precisionError();
  const fraction = match[3] ?? "", scale = fraction.length - Number(match[4] ?? 0);
  const n = BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale >= 0 ? { n, d: TEN ** BigInt(scale) } : { n: n * TEN ** BigInt(-scale), d: ONE };
}
function add(a: Decimal, b: Decimal): Decimal {
  const d = a.d > b.d ? a.d : b.d;
  return { n: a.n * (d / a.d) + b.n * (d / b.d), d };
}
function subtract(a: Decimal, b: Decimal): Decimal { return add(a, { ...b, n: -b.n }); }
function abs(a: Decimal): Decimal { return { ...a, n: a.n < ZERO ? -a.n : a.n }; }
function greater(a: Decimal, b: Decimal): boolean { return a.n * b.d > b.n * a.d; }
function ceilFrame(time: Decimal): number {
  const n = time.n * BigInt(30);
  const result = n >= ZERO ? (n + time.d - ONE) / time.d : n / time.d;
  const value = Number(result);
  if (!Number.isSafeInteger(value)) throw precisionError();
  return value;
}
function ulpBound(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + ONE);
  return view.getFloat64(0) - Math.abs(value);
}

export type MultipartVideoPlan = { firstFrame: number; endFrame: number; parts: { firstFrame: number; endFrame: number; frames: number }[] };
/** Frame ownership only: source normalization, source phase and declared clip end stay unchanged. */
export function planMultipartVideo(clip: Clip): MultipartVideoPlan {
  const start = decimal(clip.timelineStartSec), declared = decimal(clip.durationSec);
  let offset: Decimal = { n: ZERO, d: ONE };
  let legacySum = 0, arithmeticBudget = 2 * ulpBound(clip.durationSec);
  const parts = clip.parts.map(part => {
    const duration = subtract(decimal(part.sourceOutSec), decimal(part.sourceInSec));
    if (duration.n <= ZERO) throw precisionError();
    const firstFrame = ceilFrame(add(start, offset));
    offset = add(offset, duration);
    const endFrame = ceilFrame(add(start, offset));
    const added = legacySum + part.sourceOutSec;
    const next = added - part.sourceInSec;
    arithmeticBudget += 2 * (ulpBound(part.sourceInSec) + ulpBound(part.sourceOutSec) +
      ulpBound(part.sourceOutSec - part.sourceInSec) + ulpBound(added) + ulpBound(next));
    legacySum = next;
    return { firstFrame, endFrame, frames: endFrame - firstFrame };
  });
  // This is the existing duration/parts consistency tolerance plus bounded
  // arithmetic error, not a frame-ownership epsilon or an input range change.
  const tolerance = decimal(1e-6 + Math.min(arithmeticBudget, 1e-9));
  if (greater(abs(subtract(offset, declared)), tolerance)) throw precisionError();
  const firstFrame = ceilFrame(start), endFrame = ceilFrame(add(start, offset));
  if (!parts.length || parts.some(p => p.frames < 0) || endFrame <= firstFrame) throw precisionError();
  return { firstFrame, endFrame, parts };
}

/** ffmpeg's duration parser accepts plain decimals, not JS scientific notation. */
export function multipartDurationArgument(value: number): string {
  const input = String(value);
  if (!/[eE]/.test(input)) return input;
  const valueDecimal = decimal(value), negative = valueDecimal.n < ZERO;
  const digits = (negative ? -valueDecimal.n : valueDecimal.n).toString();
  const places = valueDecimal.d.toString().length - 1;
  const padded = digits.padStart(places + 1, "0");
  return `${negative ? "-" : ""}${places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded}`;
}
