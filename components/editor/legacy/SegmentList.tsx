"use client";

import type { Segment } from "@/lib/legacy/segments";

export type SegmentListProps = {
  segments: readonly Segment[];
  deletedSegmentIds: ReadonlySet<string>;
  disabled?: boolean;
  /** 複数論理セグメントがあるとき、各区間ファイルのダウンロードボタンを出す */
  showPerSegmentDownloads?: boolean;
  /** 書き出し中のセグメント id */
  exportingSegmentId?: string | null;
  onToggleDeleted: (segmentId: string) => void;
  onDownloadSegment?: (segment: Segment) => void | Promise<void>;
};

export function SegmentList({
  segments,
  deletedSegmentIds,
  disabled,
  showPerSegmentDownloads,
  exportingSegmentId,
  onToggleDeleted,
  onDownloadSegment,
}: SegmentListProps) {
  if (segments.length === 0) {
    return (
      <p className="muted">
        分割点が無い場合、動画全体が1セグメントです。タイムライン上で分割点を追加してください。
      </p>
    );
  }

  return (
    <ul className="segment-list">
      {segments.map((s) => {
        const deleted = deletedSegmentIds.has(s.id);
        return (
          <li key={s.id} className={`segment-row${deleted ? " segment-row--deleted" : ""}`}>
            <div className="segment-row-main">
              <div className="segment-row-title">
                #{s.index + 1}{" "}
                <span className="muted">
                  <code>{s.startSec.toFixed(3)}</code>s → <code>{s.endSec.toFixed(3)}</code>s
                </span>
              </div>
              {deleted ? <span className="segment-badge">削除予定</span> : null}
            </div>
            <div className="segment-row-actions">
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => onToggleDeleted(s.id)}
              >
                {deleted ? "削除取消" : "このセグメントを削除"}
              </button>
              {showPerSegmentDownloads && typeof onDownloadSegment === "function" ? (
                <button
                  type="button"
                  disabled={disabled}
                  title="現在のプレビュー動画からこの時間範囲だけ ffmpeg で書き出します"
                  onClick={() => void onDownloadSegment(s)}
                >
                  {exportingSegmentId === s.id ? "書き出し中…" : "この範囲をダウンロード"}
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
