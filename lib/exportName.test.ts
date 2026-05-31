import { describe, expect, it } from "vitest";
import {
  buildDownloadFilename,
  displayNameFromOriginalFilename,
  parseDownloadFilenameParam,
  sanitizeExportBaseName,
} from "./exportName";

describe("displayNameFromOriginalFilename", () => {
  it("拡張子を除く", () => {
    expect(displayNameFromOriginalFilename("clip.mp4")).toBe("clip");
    expect(displayNameFromOriginalFilename("/path/to/my video.mkv")).toBe("my video");
  });

  it("拡張子のみの場合はファイル名全体", () => {
    expect(displayNameFromOriginalFilename(".mp4")).toBe(".mp4");
  });
});

describe("sanitizeExportBaseName", () => {
  it("空は video", () => {
    expect(sanitizeExportBaseName("")).toBe("video");
    expect(sanitizeExportBaseName("   ")).toBe("video");
  });

  it("危険文字を置換", () => {
    expect(sanitizeExportBaseName('a/b:c*?')).toBe("a_b_c__");
  });
});

describe("buildDownloadFilename", () => {
  it("サフィックス付き mp4", () => {
    expect(buildDownloadFilename("my clip", "restored_2x_44100hz", "mp4")).toBe(
      "my clip_restored_2x_44100hz.mp4",
    );
  });
});

describe("parseDownloadFilenameParam", () => {
  it("basename のみ許可", () => {
    expect(parseDownloadFilenameParam("foo.mp4")).toBe("foo.mp4");
    expect(parseDownloadFilenameParam("/etc/passwd")).toBe("passwd");
    expect(parseDownloadFilenameParam("")).toBeNull();
  });

  it("指定拡張子以外は拒否", () => {
    expect(parseDownloadFilenameParam("foo.mp4", "mp4")).toBe("foo.mp4");
    expect(parseDownloadFilenameParam("foo.MP4", ".mp4")).toBe("foo.MP4");
    expect(parseDownloadFilenameParam("invoice.bat", "mp4")).toBeNull();
    expect(parseDownloadFilenameParam("foo", "mp4")).toBeNull();
  });
});
