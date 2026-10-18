/** Bounded OpenType TTC Unicode cmap reader. No host font lookup or font dependency. */
export function fontCoverageRanges(bytes: Uint8Array): [number, number][] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function bound(o: number, n: number, end = bytes.length) {
    if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0 || o + n > end) throw new Error("タイトルfontのcmapが不正です。");
  }
  const u16 = (o: number) => { bound(o, 2); return v.getUint16(o); };
  const u32 = (o: number) => { bound(o, 4); return v.getUint32(o); };
  bound(0, 16);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "ttcf" || ![0x10000, 0x20000].includes(u32(4))) throw new Error("タイトルfontはTTCである必要があります。");
  const count = u32(8); if (!count || count > 64) throw new Error("TTC face数が不正です。");
  bound(12, count * 4);
  const face = u32(12); bound(face, 12);
  const n = u16(face + 4); if (!n || n > 256) throw new Error("font table数が不正です。");
  bound(face + 12, n * 16);
  let cmap = -1, cmapEnd = -1;
  for (let i = 0; i < n; i++) {
    const o = face + 12 + i * 16, offset = u32(o + 8), size = u32(o + 12); bound(offset, size);
    if (String.fromCharCode(...bytes.subarray(o, o + 4)) === "cmap") { if (cmap !== -1) throw new Error("重複cmapです。"); cmap = offset; cmapEnd = offset + size; }
  }
  bound(cmap, 4, cmapEnd); const maps = u16(cmap + 2); if (maps > 256) throw new Error("cmap数が不正です。");
  bound(cmap + 4, maps * 8, cmapEnd);
  let selected: { o: number; format: number; end: number } | undefined;
  for (let i = 0; i < maps; i++) {
    const o = cmap + 4 + i * 8, p = u16(o), enc = u16(o + 2), start = cmap + u32(o + 4); bound(start, 2, cmapEnd);
    if (p !== 0 && !(p === 3 && (enc === 1 || enc === 10))) continue;
    const format = u16(start); if (format !== 4 && format !== 12) continue;
    bound(start, format === 12 ? 16 : 14, cmapEnd);
    const len = format === 12 ? u32(start + 4) : u16(start + 2); bound(start, len, cmapEnd);
    if (!selected || format > selected.format) selected = { o: start, format, end: start + len };
  }
  if (!selected) throw new Error("Unicode cmapがありません。");
  const { o, format, end } = selected, points: [number, number][] = [];
  if (format === 12) {
    const groups = u32(o + 12); if (groups > 0x110000) throw new Error("cmap group数が不正です。"); bound(o + 16, groups * 12, end);
    let previous = -1;
    for (let i = 0; i < groups; i++) {
      const a = o + 16 + i * 12, first = u32(a), last = u32(a + 4), gid = u32(a + 8);
      if (first > last || first <= previous || last > 0x10ffff || gid + last - first > 65535) throw new Error("cmap範囲が不正です。");
      previous = last; if (gid || last > first) points.push([first + (gid ? 0 : 1), last]);
    }
  } else {
    const count2 = u16(o + 6); if (!count2 || count2 % 2) throw new Error("cmap segmentが不正です。");
    const count = count2 / 2, ends = o + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, offsets = deltas + count * 2;
    bound(offsets, count * 2, end); let previous = -1;
    for (let i = 0; i < count; i++) {
      const first = u16(starts + i * 2), last = u16(ends + i * 2), delta = u16(deltas + i * 2), ro = u16(offsets + i * 2);
      if (first > last || first <= previous) throw new Error("cmap segment順が不正です。"); previous = last;
      for (let cp = first; cp <= last && cp !== 65535; cp++) {
        let gid = (cp + delta) & 65535;
        if (ro) { const at = offsets + i * 2 + ro + (cp - first) * 2; bound(at, 2, end); const g = u16(at); gid = g ? (g + delta) & 65535 : 0; }
        if (gid) points.push([cp, cp]);
      }
    }
  }
  const merged: [number, number][] = [];
  for (const range of points) { const last = merged.at(-1); if (last && range[0] === last[1] + 1) last[1] = range[1]; else merged.push([...range]); }
  return merged;
}
