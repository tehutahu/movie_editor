import type { AssetKind } from "@/lib/editor/types";

export type AssetMeta = {
  id: string;
  kind: AssetKind;
  displayName: string;
  ext: string;
  sourceDurationSec?: number;
  width?: number;
  height?: number;
  streamUrl: string;
  thumbnailStripUrl?: string;
};

export type MediaStorage = {
  saveAsset(input: {
    assetId: string;
    ext: string;
    bytes: Uint8Array;
    displayName: string;
    kind: AssetKind;
  }): Promise<{ inputPath: string }>;

  findInputPath(assetId: string): Promise<string | null>;

  readDisplayName(assetId: string): Promise<string | null>;

  saveThumbnailStrip(assetId: string, bytes: Uint8Array): Promise<string>;

  getThumbnailStripPath(assetId: string): Promise<string | null>;

  streamUrl(assetId: string): string;

  thumbnailStripUrl(assetId: string): string | undefined;
};

export function getStorageDriver(): "local" | "blob" {
  const d = process.env.STORAGE_DRIVER?.toLowerCase();
  if (d === "blob") return "blob";
  return "local";
}
