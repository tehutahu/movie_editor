import type { Asset } from "./types";
export type MediaLayout = { width: number; height: number };
export function mediaLayoutKey(a: Asset): string {
  return JSON.stringify([a.id, a.storageAssetId, a.sourceJobId, a.streamUrl, a.kind, a.ext]);
}
async function intrinsic(a: Asset): Promise<MediaLayout> {
  const el = document.createElement(a.kind === "video" ? "video" : "img");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(new Error("素材の読込を確認できませんでした。再試行してください。")); }, 15000);
      const event = el instanceof HTMLVideoElement ? "loadeddata" : "load";
      function clean() { clearTimeout(timer); el.removeEventListener(event, ready); el.removeEventListener("error", error); }
      function ready() { clean(); resolve(el instanceof HTMLVideoElement ? { width: el.videoWidth, height: el.videoHeight } : { width: (el as HTMLImageElement).naturalWidth, height: (el as HTMLImageElement).naturalHeight }); }
      function error() { clean(); reject(new Error("素材の読込に失敗しました。再リンクしてください。")); }
      if (el instanceof HTMLVideoElement) { el.muted = true; el.preload = "auto"; }
      el.addEventListener(event, ready); el.addEventListener("error", error); el.src = a.streamUrl;
    });
  } finally { if (el instanceof HTMLVideoElement) el.pause(); el.removeAttribute("src"); if (el instanceof HTMLVideoElement) el.load(); }
}
export async function validateBrowserMediaLayouts(assets: Asset[]): Promise<Map<string, MediaLayout>> {
  const res = await fetch("/api/media/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assets }) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "素材の配置を検証できませんでした。");
  const map = new Map<string, MediaLayout>();
  for (const a of assets) {
    const info = json.assets.find((v: {id: string}) => v.id === a.id);
    const decoded = await intrinsic(a);
    if (!info || !info.eligible || decoded.width !== info.width || decoded.height !== info.height) throw new Error("ブラウザと書き出しの素材寸法が一致しません。引き伸ばしをご利用ください。");
    map.set(mediaLayoutKey(a), decoded);
  }
  return map;
}
