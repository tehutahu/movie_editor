"use client";

import { forwardRef } from "react";

export type VideoPreviewProps = {
  src: string | null;
  className?: string;
  onTimeUpdate?: (sec: number) => void;
};

export const VideoPreview = forwardRef<HTMLVideoElement, VideoPreviewProps>(
  function VideoPreview({ src, className, onTimeUpdate }, ref) {
    if (!src) {
      return (
        <div className={`editor-preview-placeholder${className ? ` ${className}` : ""}`}>
          <p className="muted" style={{ margin: 0 }}>
            アップロード後にプレビューが表示されます。
          </p>
        </div>
      );
    }

    return (
      <video
        ref={ref}
        key={src}
        controls
        className={className}
        src={src}
        onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
      />
    );
  },
);
