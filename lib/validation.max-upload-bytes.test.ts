import { afterEach, describe, expect, it, vi } from "vitest";

describe("MAX_UPLOAD_BYTES (module init)", () => {
  afterEach(() => {
    delete process.env.MAX_UPLOAD_BYTES;
    vi.resetModules();
  });

  it("デフォルトは 8 GiB", async () => {
    const { MAX_UPLOAD_BYTES } = await import("@/lib/validation");
    expect(MAX_UPLOAD_BYTES).toBe(8 * 1024 ** 3);
  });

  it("環境変数で正の数として上書きできる", async () => {
    process.env.MAX_UPLOAD_BYTES = "4096";
    const { MAX_UPLOAD_BYTES } = await import("@/lib/validation");
    expect(MAX_UPLOAD_BYTES).toBe(4096);
  });

  it("無効値だと読み込み時にエラーになる", async () => {
    process.env.MAX_UPLOAD_BYTES = "0";
    await expect(import("@/lib/validation")).rejects.toThrow("正の数");
  });

  it("空文字は未設定としてデフォルト", async () => {
    process.env.MAX_UPLOAD_BYTES = "";
    const { MAX_UPLOAD_BYTES } = await import("@/lib/validation");
    expect(MAX_UPLOAD_BYTES).toBe(8 * 1024 ** 3);
  });
});
