import { describe, expect, it } from "vitest";

import { guessVideoMimeType } from "@/lib/mime";

describe("guessVideoMimeType", () => {
  it.each([
    ["/videos/a.mp4", "video/mp4"],
    ["c:\\file.mkv", "video/x-matroska"],
    ["/tmp/x.avi", "video/x-msvideo"],
    ["/MOV.MOV", "video/quicktime"],
    ["/a.flv", "video/x-flv"],
    ["/wmv.WMV", "video/x-ms-wmv"],
    ["/unknown.bin", "application/octet-stream"],
    ["/noext", "application/octet-stream"],
  ])("%s → %s", (filePath, expected) => {
    expect(guessVideoMimeType(filePath)).toBe(expected);
  });
});
