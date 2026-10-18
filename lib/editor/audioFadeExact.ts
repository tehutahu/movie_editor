import type { AudioFade } from './types';
type Q = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < BigInt(0) ? -a : a; while (b) [a, b] = [b, a % b]; return a; };
function q(n: bigint, d = BigInt(1)): Q { if (d < BigInt(0)) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; }
const zero = q(BigInt(0)), one = q(BigInt(1));
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const cmp = (a: Q, b: Q) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d;
/** Exact IEEE754 input, including positive subnormal durations. DSP never calls this. */
function rational(value: number): Q {
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> BigInt(52)) & BigInt(2047)), fraction = bits & ((BigInt(1) << BigInt(52)) - BigInt(1));
  const mantissa = (bits >> BigInt(63) ? -BigInt(1) : BigInt(1)) * (exponent ? (BigInt(1) << BigInt(52)) + fraction : fraction);
  const power = exponent ? exponent - 1023 - 52 : -1074;
  return power >= 0 ? q(mantissa << BigInt(power)) : q(mantissa, BigInt(1) << BigInt(-power));
}
type Exact = { I: Q; O: Q; A: Q; offset: Q };
const exact = (fade: AudioFade): Exact => ({ I: rational(fade.inSec), O: rational(fade.outSec), A: rational(fade.anchorDurationSec), offset: rational(fade.offsetSec) });
function factors(f: Exact | undefined, u: Q): [Q, Q][] {
  if (!f) return [[one, zero], [one, zero]];
  const position = add(f.offset, u);
  const incoming: [Q, Q] = !f.I.n || cmp(position, f.I) >= 0 ? [one, zero] : cmp(position, zero) <= 0 ? [zero, zero] : [div(f.offset, f.I), div(one, f.I)];
  const outgoing: [Q, Q] = !f.O.n ? [one, zero] : cmp(position, f.A) >= 0 ? [zero, zero] : cmp(position, sub(f.A, f.O)) <= 0 ? [one, zero] : [div(sub(f.A, f.offset), f.O), div(q(-BigInt(1)), f.O)];
  return [incoming, outgoing];
}
function polynomial(f: Exact | undefined, u: Q): Q[] {
  const [[a,b],[c,d]] = factors(f,u); return [mul(a,c), add(mul(a,d),mul(b,c)), mul(b,d)];
}
function value(f: Exact | undefined, u: Q): Q { const [a,b,c] = polynomial(f,u); return add(a, add(mul(b,u),mul(c,mul(u,u)))); }
/** Compare the complete future envelope; never use a tolerance or rounded midpoint. */
export function exactFadeEquivalent(left: AudioFade | undefined, right: AudioFade | undefined): boolean {
  const a = left && exact(left), b = right && exact(right);
  const points = new Map<string,Q>();
  for (const f of [a,b]) for (const x of f ? [zero,sub(f.I,f.offset),sub(sub(f.A,f.O),f.offset),sub(f.A,f.offset)] : [zero]) if (cmp(x,zero)>=0) points.set(`${x.n}/${x.d}`,x);
  const ordered = [...points.values()].sort(cmp);
  for (let i=0;i<ordered.length;i++) {
    const point=ordered[i]; if (!eq(value(a,point),value(b,point))) return false;
    const sample=i+1<ordered.length?div(add(point,ordered[i+1]),q(BigInt(2))):add(point,one);
    const pa=polynomial(a,sample),pb=polynomial(b,sample); if (!pa.every((v,j)=>eq(v,pb[j]))) return false;
  }
  return true;
}
