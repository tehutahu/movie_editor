import type { MediaStorage } from "@/lib/storage/mediaStorage";
import { createLocalMediaStorage } from "@/lib/storage/localMediaStorage";
import { createBlobMediaStorage } from "@/lib/storage/blobMediaStorage";

let cached: MediaStorage | null = null;

export function getMediaStorage(): MediaStorage {
  if (cached) return cached;
  const driver = process.env.STORAGE_DRIVER?.toLowerCase();
  if (driver === "blob" || process.env.BLOB_READ_WRITE_TOKEN) {
    cached = createBlobMediaStorage();
    return cached;
  }
  cached = createLocalMediaStorage();
  return cached;
}
