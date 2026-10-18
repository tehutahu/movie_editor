import type { Clip, EditorProject } from "./types";
import { sanitizeExportBaseName } from "@/lib/exportName";
import { fitClipTransformToCanvas, compositionSizeFromAsset } from "./compositor";

/** Selected exports contain source media, without timeline offsets or transforms,
 * matching the existing single-video export. Mixed parts share one output size.
 */
export function selectedClipExportRequest(project: EditorProject, clip: Clip) {
  if (clip.kind === "title" || project.clips.some(c => project.selectedClipIds.includes(c.id) && c.kind === "title")) throw new Error("タイトルを含む選択では素材DLできません。全体書き出しを使用してください。");
  if (!clip.parts.length) throw new Error("クリップに素材がありません。");
  const assets = clip.parts.map((part) => {
    const asset = project.assets.find((a) => a.id === part.assetId);
    if (!asset) throw new Error("素材が見つかりません。");
    return asset;
  });
  const first = assets[0]!;
  const part = clip.parts[0]!;
  const exportBaseName = sanitizeExportBaseName(project.exportBaseName);
  if (clip.parts.length === 1 && first.kind === "video") {
    return { url: "/api/jobs/export-segment", body: {
      videoId: first.storageAssetId ?? first.id, sourceJobId: first.sourceJobId,
      startSec: part.sourceInSec, endSec: part.sourceOutSec, exportBaseName,
    } };
  }
  const { audioGain: _gain, audioFade: _fade, ...sourceClip } = structuredClone(clip);
  const size = compositionSizeFromAsset(first.width ?? project.compositionWidth, first.height ?? project.compositionHeight);
  return { url: "/api/jobs/export-composition", body: {
    assets: [...new Map(assets.map((a) => [a.id, a])).values()],
    tracks: project.tracks.filter((t) => t.id === clip.trackId),
    clips: [{ ...sourceClip, timelineStartSec: 0, transform: fitClipTransformToCanvas() }],
    compositionDurationSec: clip.durationSec,
    compositionWidth: size.width, compositionHeight: size.height, exportBaseName,
  } };
}
