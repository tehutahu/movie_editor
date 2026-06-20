import { getMediaStorage } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";

export async function resolveAssetInputPath(assetId: string): Promise<string | null> {
  assertStorageId("assetId", assetId);
  const storage = getMediaStorage();
  return storage.findInputPath(assetId);
}
