"use client";

import type { EditorStore } from "@/hooks/useEditorStore";
import type { Asset } from "@/lib/editor/types";

export function AssetLibraryPanel({ editor }: { editor: EditorStore }) {
  const { project, uploadAssets, busy } = editor;

  function onDragStart(e: React.DragEvent, asset: Asset) {
    e.dataTransfer.setData("application/x-asset-id", asset.id);
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <aside className="asset-library panel">
      <h2>素材</h2>
      <label className="asset-upload-btn">
        <input
          type="file"
          multiple
          accept=".mp4,.mkv,.avi,.mov,.flv,.wmv,.png,.jpg,.jpeg,.webp,.gif"
          disabled={Boolean(busy)}
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) void uploadAssets(files);
            e.target.value = "";
          }}
        />
        追加
      </label>
      <div className="asset-grid">
        {project.assets.length === 0 ? (
          <p className="muted">動画・画像をアップロードしてください。</p>
        ) : (
          project.assets.map((asset) => (
            <div
              key={asset.id}
              className="asset-card"
              draggable
              onDragStart={(e) => onDragStart(e, asset)}
              title={asset.displayName}
            >
              <div className="asset-thumb">
                {asset.kind === "image" ? (
                  <img src={asset.streamUrl} alt="" />
                ) : (
                  <video src={asset.streamUrl} muted preload="metadata" />
                )}
              </div>
              <span className="asset-name">{asset.displayName}</span>
              <span className="asset-kind muted">{asset.kind}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
