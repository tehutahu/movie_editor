import { put, head } from "@vercel/blob";
import type { AssetKind } from "@/lib/editor/types";
import type { MediaStorage } from "@/lib/storage/mediaStorage";

/** Vercel Blob backed storage for production deploys. */
export class BlobMediaStorage implements MediaStorage {
  private displayNames = new Map<string, string>();
  private kinds = new Map<string, AssetKind>();
  private stripPaths = new Map<string, string>();

  async saveAsset(input: {
    assetId: string;
    ext: string;
    bytes: Uint8Array;
    displayName: string;
    kind: AssetKind;
  }): Promise<{ inputPath: string }> {
    const pathname = `assets/${input.assetId}/input.${input.ext}`;
    const blob = await put(pathname, Buffer.from(input.bytes), {
      access: "public",
      addRandomSuffix: false,
    });
    this.displayNames.set(input.assetId, input.displayName);
    this.kinds.set(input.assetId, input.kind);
    return { inputPath: blob.url };
  }

  async findInputPath(assetId: string): Promise<string | null> {
    const meta = await head(`assets/${assetId}/input.mp4`).catch(() => null);
    if (meta?.url) return meta.url;
    for (const ext of ["mkv", "avi", "mov", "png", "jpg", "jpeg", "webp", "gif"]) {
      const m = await head(`assets/${assetId}/input.${ext}`).catch(() => null);
      if (m?.url) return m.url;
    }
    return null;
  }

  async readDisplayName(assetId: string): Promise<string | null> {
    return this.displayNames.get(assetId) ?? null;
  }

  async saveThumbnailStrip(assetId: string, bytes: Uint8Array): Promise<string> {
    const pathname = `assets/${assetId}/filmstrip.jpg`;
    const blob = await put(pathname, Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: false,
    });
    this.stripPaths.set(assetId, blob.url);
    return blob.url;
  }

  async getThumbnailStripPath(assetId: string): Promise<string | null> {
    if (this.stripPaths.has(assetId)) return this.stripPaths.get(assetId)!;
    const meta = await head(`assets/${assetId}/filmstrip.jpg`).catch(() => null);
    return meta?.url ?? null;
  }

  streamUrl(assetId: string): string {
    return `/api/assets/${assetId}/stream`;
  }

  thumbnailStripUrl(assetId: string): string | undefined {
    return `/api/assets/${assetId}/filmstrip`;
  }
}

export function createBlobMediaStorage(): MediaStorage {
  return new BlobMediaStorage();
}
