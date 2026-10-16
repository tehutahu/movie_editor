import { open } from "node:fs/promises";
import { probeMedia } from "@/lib/ffmpeg";
import { videoDisplayDimensions } from "@/lib/videoDimensions";

export class MediaLayoutError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
function fail(code: string): never { throw new MediaLayoutError(code, `縦横比保持に対応しない素材です (${code})。引き伸ばしをご利用ください。`); }
const orientationError = () => fail("UNSUPPORTED_LAYOUT_ORIENTATION");

/** Bounded metadata reads; compressed pixel chunks are skipped, never loaded. */
export async function assertStillImageLayout(file: string, ext: string): Promise<void> {
  const handle = await open(file, "r");
  let size = 0;
  let budget = 1024 * 1024;
  async function read(pos: number, len: number): Promise<Buffer> {
    if (len < 0 || pos < 0 || pos + len > size || len > budget) orientationError();
    budget -= len;
    const b = Buffer.alloc(len);
    if ((await handle.read(b, 0, len, pos)).bytesRead !== len) orientationError();
    return b;
  }
  function tiff(data: Buffer) {
    const b = data.subarray(data.subarray(0, 6).equals(Buffer.from("Exif\0\0")) ? 6 : 0);
    if (b.length < 8) orientationError();
    const le = b.toString("ascii", 0, 2) === "II";
    if (!le && b.toString("ascii", 0, 2) !== "MM") orientationError();
    const u16 = (p: number) => { if (p < 0 || p + 2 > b.length) orientationError(); return le ? b.readUInt16LE(p) : b.readUInt16BE(p); };
    const u32 = (p: number) => { if (p < 0 || p + 4 > b.length) orientationError(); return le ? b.readUInt32LE(p) : b.readUInt32BE(p); };
    if (u16(2) !== 42) orientationError();
    const seen = new Set<number>();
    let p = u32(4);
    while (p) {
      if (seen.has(p) || seen.size > 32) orientationError();
      seen.add(p);
      const count = u16(p);
      if (count > 4096) orientationError();
      for (let i = 0; i < count; i++) {
        const q = p + 2 + 12 * i;
        const tag = u16(q), type = u16(q + 2), n = u32(q + 4);
        if (tag === 0x112 && (type !== 3 || n !== 1 || u16(q + 8) !== 1)) orientationError();
      }
      p = u32(p + 2 + count * 12);
    }
  }
  try {
    size = (await handle.stat()).size;
    if (["jpg", "jpeg"].includes(ext)) {
      if (!(await read(0, 2)).equals(Buffer.from([255, 216]))) orientationError();
      let pos = 2;
      while (pos < size) {
        const marker = await read(pos, 2); pos += 2;
        if (marker[0] !== 255) orientationError();
        if (marker[1] === 0xda || marker[1] === 0xd9) return;
        if (marker[1] === 0xff) { pos--; continue; }
        const len = (await read(pos, 2)).readUInt16BE();
        if (len < 2 || pos + len > size) orientationError();
        if (marker[1] === 0xe1) {
          const data = await read(pos + 2, len - 2);
          if (data.subarray(0, 4).toString() === "Exif") tiff(data);
        }
        pos += len;
      }
      orientationError();
    } else if (ext === "png") {
      if (!(await read(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) orientationError();
      let pos = 8;
      while (pos + 12 <= size) {
        const header = await read(pos, 8), len = header.readUInt32BE(), kind = header.toString("ascii", 4);
        if (pos + len + 12 > size) orientationError();
        if (kind === "eXIf") tiff(await read(pos + 8, len));
        if (kind === "acTL") { if (len !== 8 || (await read(pos + 8, 8)).readUInt32BE() !== 1) fail("UNSUPPORTED_LAYOUT_ANIMATION"); }
        if (kind === "IEND") return;
        pos += len + 12;
      }
      orientationError();
    } else if (ext === "webp") {
      const header = await read(0, 12);
      if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8) !== "WEBP" || header.readUInt32LE(4) + 8 !== size) orientationError();
      let pos = 12;
      while (pos + 8 <= size) {
        const chunk = await read(pos, 8), len = chunk.readUInt32LE(4), kind = chunk.toString("ascii", 0, 4);
        if (pos + 8 + len > size) orientationError();
        if (kind === "EXIF") tiff(await read(pos + 8, len));
        if (kind === "ANIM" || kind === "ANMF") fail("UNSUPPORTED_LAYOUT_ANIMATION");
        if (kind === "VP8X" && (len !== 10 || ((await read(pos + 8, len))[0]! & 2))) fail("UNSUPPORTED_LAYOUT_ANIMATION");
        pos += 8 + len + (len % 2);
      }
      if (pos !== size) orientationError();
    } else if (ext !== "gif") orientationError();
  } finally { await handle.close(); }
}

export async function inspectMediaLayout(input: string, kind: "image" | "video", ext: string) {
  const raw = await probeMedia(input).catch(() => fail("LAYOUT_MEDIA_UNREADABLE"));
  const formats = raw.format?.format_name?.split(",") ?? [];
  const imageFormats = new Set(["png_pipe", "jpeg_pipe", "webp_pipe", "gif", "apng", "image2", "image2pipe"]);
  const actualImage = formats.some(f => imageFormats.has(f));
  if ((kind === "image") !== actualImage) fail("UNSUPPORTED_LAYOUT_MEDIA_KIND");
  if (kind === "image") {
    const expected = ext === "jpg" || ext === "jpeg" ? ["jpeg_pipe", "image2", "image2pipe"] : ext === "png" ? ["png_pipe", "apng", "image2", "image2pipe"] : ext === "webp" ? ["webp_pipe"] : ["gif"];
    if (!formats.some(f => expected.includes(f))) fail("UNSUPPORTED_LAYOUT_MEDIA_KIND");
    await assertStillImageLayout(input, ext);
  }
  const v = raw.streams?.find(s => s.codec_type === "video");
  if (!v || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width! < 1 || v.height! < 1) fail("UNSUPPORTED_LAYOUT_DIMENSIONS");
  if (v.sample_aspect_ratio !== undefined && v.sample_aspect_ratio !== "1:1") fail("UNSUPPORTED_LAYOUT_SAR");
  if (kind === "image" && ext === "gif" && (!v.nb_frames || Number(v.nb_frames) !== 1)) fail("UNSUPPORTED_LAYOUT_ANIMATION");
  const rotations: number[] = [];
  for (const d of v.side_data_list ?? []) {
    if (d.side_data_type !== "Display Matrix") continue;
    if (typeof d.rotation !== "number" || !Number.isFinite(d.rotation) || d.rotation % 90 !== 0 || !d.displaymatrix) fail("UNSUPPORTED_LAYOUT_ROTATION");
    const rows = d.displaymatrix.trim().split("\n").map(line => line.split(":")[1]?.trim().split(/\s+/).map(Number));
    if (rows.length !== 3 || rows.some(r => !r || r.length !== 3)) fail("UNSUPPORTED_LAYOUT_ROTATION");
    const [a,b,c] = rows as number[][];
    if (a![2] !== 0 || b![2] !== 0 || c![0] !== 0 || c![1] !== 0 || c![2] !== 1073741824 ||
        a![0]! * b![1]! - a![1]! * b![0]! !== 65536 ** 2 ||
        a![0]! ** 2 + a![1]! ** 2 !== 65536 ** 2 ||
        b![0]! ** 2 + b![1]! ** 2 !== 65536 ** 2 ||
        a![0]! * b![0]! + a![1]! * b![1]! !== 0 ||
        ![a![0],a![1],b![0],b![1]].every(n => n === 0 || Math.abs(n!) === 65536)) fail("UNSUPPORTED_LAYOUT_ROTATION");
    rotations.push(((d.rotation % 360) + 360) % 360);
  }
  if (v.tags?.rotate !== undefined) {
    const angle = Number(v.tags.rotate);
    if (!Number.isFinite(angle) || angle % 90 !== 0) fail("UNSUPPORTED_LAYOUT_ROTATION");
    // Legacy rotate tags alone are outside the existing display contract.
    if (angle % 360 !== 0 && rotations.length === 0) fail("UNSUPPORTED_LAYOUT_ROTATION");
    if (rotations.some(r => r !== ((angle % 360) + 360) % 360)) fail("UNSUPPORTED_LAYOUT_ROTATION");
  }
  if (new Set(rotations).size > 1) fail("UNSUPPORTED_LAYOUT_ROTATION");
  const display = videoDisplayDimensions(v);
  const origin = kind === "video" ? Number(v.start_time) : 0;
  if (!Number.isFinite(origin) || (kind === "video" && (typeof v.start_time !== "string" || !v.start_time.trim()))) fail("UNSUPPORTED_LAYOUT_TIMING");
  return { width: display.width!, height: display.height!, origin,
    hasAudio: raw.streams?.some(s => s.codec_type === "audio") ?? false,
    durationSec: Number(raw.format?.duration) };
}
