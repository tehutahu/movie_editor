import { resolveInputPath } from "@/lib/mediaSource";
import { getMediaStorage } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";

export type AssetInputRef = {
  id: string;
  sourceJobId?: string | undefined;
};

export async function resolveAssetInputPath(
  ref: string | AssetInputRef,
): Promise<string | null> {
  const assetId = typeof ref === "string" ? ref : ref.id;
  assertStorageId("assetId", assetId);

  const sourceJobId = typeof ref === "string" ? undefined : ref.sourceJobId;
  if (sourceJobId) {
    try {
      const resolved = await resolveInputPath({ videoId: assetId, sourceJobId });
      return resolved.inputPath;
    } catch {
      return null;
    }
  }

  const storage = getMediaStorage();
  return storage.findInputPath(assetId);
}
