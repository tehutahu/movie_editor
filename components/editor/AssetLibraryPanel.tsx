"use client";

import { useRef } from "react";
import type { EditorStore } from "@/hooks/useEditorStore";
import { assetAdditionTrack } from "@/lib/editor/addAssetAtPlayhead";
import type { Asset } from "@/lib/editor/types";

export function AssetLibraryPanel({ editor }: { editor: EditorStore }) {
  const { project, uploadAssets, busy, persistence, addAssetAtPlayhead, assetAdditionStatus } = editor;
  const target = assetAdditionTrack(project);
  const dragFromAction = useRef(false);

  function onDragStart(e: React.DragEvent, asset: Asset) {
    if (dragFromAction.current) { e.preventDefault(); return; }
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
      {!target && <p className="muted">＋でトラックを追加してください。</p>}
      <p className="asset-add-status muted" role="status">{assetAdditionStatus}</p>
      <div className="asset-grid">
        {project.assets.length === 0 ? (
          <p className="muted">動画・画像をアップロードしてください。</p>
        ) : (
          project.assets.map((asset) => (
            <div
              key={asset.id}
              className="asset-card"
              draggable
              onPointerDown={() => { dragFromAction.current = false; }}
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
              <button
                type="button"
                className="asset-add-button"
                disabled={!target || Boolean(busy) || persistence.locked}
                aria-label={`${asset.displayName}を${target ? `T${target.order + 1}の` : ""}再生位置へ追加`}
                onClick={() => addAssetAtPlayhead(asset.id)}
                onKeyDown={(event) => {
                  if (event.key === " ") event.stopPropagation();
                }}
                onPointerDown={(event) => { dragFromAction.current = true; event.stopPropagation(); }}
                onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
                draggable={false}
              >
                {target ? `T${target.order + 1}の再生位置へ追加` : "再生位置へ追加"}
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
