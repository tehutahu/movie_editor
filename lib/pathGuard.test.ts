import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertInsideDir,
  assertJobOutputFile,
  assertUploadFileBelongsToVideo,
} from "@/lib/pathGuard";
import { JOBS_ROOT, UPLOADS_ROOT } from "@/lib/paths";

/** `assertStorageId` を通過する検証用文字列（v4 UUID 形式）。 */
const VALID_VIDEO_ID = "11111111-1111-4111-a111-111111111111";

describe("assertInsideDir", () => {
  it("許可ディレクトリ直下のファイルを受け付ける", () => {
    const root = "/app/storage/uploads";
    const file = "/app/storage/uploads/vid/input.mp4";
    expect(() => assertInsideDir(root, file)).not.toThrow();
  });

  it("親ディレクトリへ脱出するパスは拒否する", () => {
    const root = "/app/storage/uploads";
    const file = "/app/storage/uploads/evil/../../../etc/passwd";
    expect(() => assertInsideDir(root, file)).toThrow("不正なファイルパス");
  });

  it("許可ディレクトリ以外の別パスを拒否する", () => {
    const root = "/app/storage/uploads";
    const file = "/other/outside/file.mp4";
    expect(() => assertInsideDir(root, file)).toThrow("不正なファイルパス");
  });
});

describe("assertUploadFileBelongsToVideo", () => {
  it("正しい uploads/<videoId>/ 配下のパスは通過する", () => {
    const dir = path.join(UPLOADS_ROOT, VALID_VIDEO_ID);
    const file = path.join(dir, "input.mp4");
    expect(() =>
      assertUploadFileBelongsToVideo(VALID_VIDEO_ID, file),
    ).not.toThrow();
  });

  it("別の動画ディレクトリのパスは拒否する", () => {
    const otherId = "22222222-2222-4222-a222-222222222222";
    const file = path.join(UPLOADS_ROOT, otherId, "input.mp4");
    expect(() => assertUploadFileBelongsToVideo(VALID_VIDEO_ID, file)).toThrow(
      "不正なファイルパス",
    );
  });
});

describe("assertJobOutputFile", () => {
  it("正しい jobs/<jobId>/ 配下のパスは通過する", () => {
    const jobId = "33333333-3333-4333-a333-333333333333";
    const file = path.join(JOBS_ROOT, jobId, "output.mp4");
    expect(() => assertJobOutputFile(jobId, file)).not.toThrow();
  });

  it("別のジョブディレクトリのパスは拒否する", () => {
    const jobId = "44444444-4444-4444-a444-444444444444";
    const file = path.join(JOBS_ROOT, "55555555-5555-4555-a555-555555555555", "out.mp4");
    expect(() => assertJobOutputFile(jobId, file)).toThrow("不正なファイルパス");
  });
});
