import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { guessVideoMimeType } from "@/lib/mime";

function parseRangeHeader(range: string | null, fileSize: number): {
  start: number;
  end: number;
} | null {
  if (!range) return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const endPart = m[2];
  const end = endPart ? Number(endPart) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

export async function buildFileStreamResponse(absPath: string, req: Request): Promise<Response> {
  const st = await stat(absPath);
  const size = st.size;
  const mime = guessVideoMimeType(absPath);

  const parsed = parseRangeHeader(req.headers.get("range"), size);
  if (!parsed) {
    const nodeStream = createReadStream(absPath);
    const web = Readable.toWeb(nodeStream);
    return new Response(web as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(size),
        AcceptRanges: "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  const { start, end } = parsed;
  const chunkSize = end - start + 1;
  const nodeStream = createReadStream(absPath, { start, end });
  const web = Readable.toWeb(nodeStream);
  return new Response(web as unknown as ReadableStream<Uint8Array>, {
    status: 206,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      AcceptRanges: "bytes",
      "Cache-Control": "no-store",
    },
  });
}
