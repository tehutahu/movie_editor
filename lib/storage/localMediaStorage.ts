import {
  atomicWriteTmpThenRename,
  findUploadInputPath,
  readUploadDisplayName,
  saveUploadDisplayName,
  saveUploadedVideo,
  uploadVideoDir,
} from "@/lib/storage/localFs";
import { mkdir, access } from "node:fs/promises";
import path from "node:path";
import type { AssetKind } from "@/lib/editor/types";
import type { MediaStorage } from "@/lib/storage/mediaStorage";

export class LocalMediaStorage implements MediaStorage {
  async saveAsset(input: {
    assetId: string;
    ext: string;
    bytes: Uint8Array;
    displayName: string;
    kind: AssetKind;
  }): Promise<{ inputPath: string }> {
    const result = await saveUploadedVideo({
      videoId: input.assetId,
      ext: input.ext,
      bytes: input.bytes,
    });
    await saveUploadDisplayName(input.assetId, input.displayName);
    return result;
  }

  async findInputPath(assetId: string): Promise<string | null> {
    return findUploadInputPath(assetId);
  }

  async readDisplayName(assetId: string): Promise<string | null> {
    return readUploadDisplayName(assetId);
  }

  async saveThumbnailStrip(assetId: string, bytes: Uint8Array): Promise<string> {
    const dir = uploadVideoDir(assetId);
    await mkdir(dir, { recursive: true });
    const stripPath = path.join(dir, "filmstrip.jpg");
    await atomicWriteTmpThenRename(stripPath, bytes);
    return stripPath;
  }

  async getThumbnailStripPath(assetId: string): Promise<string | null> {
    const stripPath = path.join(uploadVideoDir(assetId), "filmstrip.jpg");
    try {
      await access(stripPath);
      return stripPath;
    } catch {
      return null;
    }
  }

  streamUrl(assetId: string): string {
    return `/api/assets/${assetId}/stream`;
  }

  thumbnailStripUrl(assetId: string): string | undefined {
    return `/api/assets/${assetId}/filmstrip`;
  }
}

export function createLocalMediaStorage(): MediaStorage {
  return new LocalMediaStorage();
}
