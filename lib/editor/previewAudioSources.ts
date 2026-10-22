import type { Asset } from "./types";
import { mediaLayoutKey } from "./mediaLayoutClient";

export const needsPreviewAudio = (asset: Asset) => asset.kind === "video" && asset.ext === "mkv" && !asset.sourceJobId && /^\/api\/assets\/[0-9a-f-]{36}\/stream$/i.test(asset.streamUrl);

/** One preview owner, at most eight 1MiB Blob URLs. Resolve before play, never
 * switch a pending source mid-play. Clear on project replacement/unmount. */
export function createPreviewAudioSources() {
  const entries = new Map<string, string>();
  const controllers = new Set<AbortController>();
  let generation = 0;
  const cancel = () => {
    ++generation;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const clear = () => {
    cancel();
    for (const url of entries.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    entries.clear();
  };
  return {
    clear,
    cancel,
    url: (asset: Asset) => entries.get(mediaLayoutKey(asset)) ?? asset.streamUrl,
    async prepare(assets: Asset[]) {
      cancel();
      const candidates = [...new Map(assets.filter(needsPreviewAudio).map(a => [mediaLayoutKey(a), a])).values()].slice(0, 8);
      const keys = new Set(candidates.map(mediaLayoutKey));
      // Called only while paused. Reclaim assets no longer in this play intent.
      for (const [key, url] of entries) if (!keys.has(key)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        entries.delete(key);
      }
      const token = generation;
      const staged = new Map<string, string>();
      // Sequential, bounded preparation avoids overwhelming the server's two
      // shared slots. Known/failed entries retain a stable URL until clear.
      try { for (const asset of candidates) {
        if (token !== generation) return;
        const key = mediaLayoutKey(asset);
        if (entries.has(key)) continue;
        staged.set(key, asset.streamUrl);
        const controller = new AbortController(); controllers.add(controller);
          try {
            const response = await fetch("/api/media/audio-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
            const size = Number(response.headers.get("Content-Length"));
            if (response.status !== 200 || response.headers.get("Content-Type") !== "audio/mp4" || !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) { await response.body?.cancel(); continue; }
            const blob = await response.blob();
            if (blob.size !== size || token !== generation) continue;
            staged.set(key, URL.createObjectURL(blob));
          } catch { /* Optional diagnostics preserve the original native URL. */ }
          finally { controllers.delete(controller); }
      }
      if (token !== generation) return;
      for (const [key, url] of staged) entries.set(key, url);
      staged.clear();
      } finally { for (const url of staged.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url); }
    },
  };
}
