import { inflateSync } from "node:zlib";
/** Fully decode the bounded generated RGBA PNG; never accept transparent failure output. */
export function inspectTitlePng(png: Buffer, width: number, height: number): { alphaPixels: number } {
  if (png.length > 32 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("タイトルPNGが不正です。");
  let at = 8, seenHeader = false, ended = false; const chunks: Buffer[] = [];
  while (at + 12 <= png.length) {
    const n = png.readUInt32BE(at); if (at + 12 + n > png.length) throw new Error("タイトルPNGが切れています。");
    const name = png.toString("ascii", at + 4, at + 8), data = png.subarray(at + 8, at + 8 + n);
    if (name === "IHDR") { if (seenHeader || n !== 13 || data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height || data[8] !== 8 || data[9] !== 6 || data[10] || data[11] || data[12]) throw new Error("タイトルPNGの寸法・RGBA形式が不正です。"); seenHeader = true; }
    if (name === "IDAT") { if (!seenHeader || ended) throw new Error("タイトルPNG順序が不正です。"); chunks.push(data); }
    at += n + 12; if (name === "IEND") { if (n || at !== png.length) throw new Error("タイトルPNG末尾が不正です。"); ended = true; break; }
  }
  if (!seenHeader || !ended || !chunks.length) throw new Error("タイトルPNGが不完全です。");
  const stride = width * 4, expected = (stride + 1) * height, raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error("タイトルPNGの展開長が不正です。");
  let previous = new Uint8Array(stride), alphaPixels = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)], row = new Uint8Array(stride); if (type > 4) throw new Error("タイトルPNG filterが不正です。");
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0, up = previous[x], corner = x >= 4 ? previous[x - 4] : 0;
      let predictor = 0;
      if (type === 1) predictor = left; else if (type === 2) predictor = up; else if (type === 3) predictor = Math.floor((left + up) / 2);
      else if (type === 4) { const p = left + up - corner, a = Math.abs(p-left), b = Math.abs(p-up), c = Math.abs(p-corner); predictor = a <= b && a <= c ? left : b <= c ? up : corner; }
      row[x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
      if (x % 4 === 3 && row[x]) alphaPixels++;
    }
    previous = row;
  }
  if (!alphaPixels) throw new Error("タイトルを描画できませんでした（fontを確認してください）。");
  return { alphaPixels };
}
