"use client";

import type { EditorController } from "@/hooks/useEditorState";
import { MarkerList } from "@/components/editor/MarkerList";
import { SegmentList } from "@/components/editor/SegmentList";
import { Timeline } from "@/components/editor/Timeline";
import { VideoPreview } from "@/components/editor/VideoPreview";

export function EditorLayout({ editor }: { editor: EditorController }) {
  const disabled =
    Boolean(editor.busy) ||
    Boolean(editor.segmentExportBusySegmentId) ||
    !editor.previewSrc ||
    !editor.meta;

  return (
    <>
      <header className="editor-header">
        <h1>
          <span className="badge">local</span>
          動画編集（タイムライン / ジョブ連鎖）
        </h1>
        <p className="muted">
          中央プレビューとタイムラインで分割・セグメント削除を行い、ffmpeg ジョブへ送信します。Undo
          はプレビュー参照のみ戻します（サーバー上のファイルは残ります）。
        </p>
      </header>

      <div className="editor-shell">
        <section className="editor-main panel">
          <VideoPreview
            ref={editor.videoRef}
            src={editor.previewSrc}
            className="editor-preview-video"
            onTimeUpdate={(t) => editor.setCurrentTimeSec(t)}
          />

          {editor.meta ? (
            <div className="editor-meta muted">
              長さ: <code>{editor.meta.durationSec.toFixed(3)}</code>s / 音声:{" "}
              <code>{editor.meta.hasAudio ? "あり" : "なし"}</code>
              {editor.meta.width && editor.meta.height ? (
                <>
                  {" "}
                  / 解像度:{" "}
                  <code>
                    {editor.meta.width}x{editor.meta.height}
                  </code>
                </>
              ) : null}
            </div>
          ) : (
            <p className="muted">メタデータを読み込み中です…</p>
          )}

          {editor.meta ? (
            <Timeline
              durationSec={editor.meta.durationSec}
              currentTimeSec={editor.currentTimeSec}
              markers={editor.markers}
              segments={editor.segments}
              deletedSegmentIds={editor.deletedSegmentIds}
              disabled={disabled}
              onSeek={(sec) => editor.seekPreview(sec)}
              onRemoveMarker={(t) => editor.removeMarkerAtTime(t)}
            />
          ) : null}
        </section>

        <aside className="editor-sidebar">
          <section className="panel">
            <h2>ソース</h2>
            <label htmlFor="file">ファイル（mp4/mkv/avi/mov/flv/wmv）</label>
            <input
              id="file"
              type="file"
              accept=".mp4,.mkv,.avi,.mov,.flv,.wmv"
              disabled={Boolean(editor.busy)}
              onChange={(e) => void editor.onPickFile(e.target.files?.[0] ?? null)}
            />

            {editor.baseVideoId ? (
              <p className="ok" style={{ marginTop: 10 }}>
                base videoId: <code>{editor.baseVideoId}</code>
              </p>
            ) : null}

            {editor.currentSource?.type === "job" ? (
              <p className="muted" style={{ marginTop: 10 }}>
                現在の入力チェーン先頭: <code>{editor.currentSource.jobId}</code>
              </p>
            ) : null}
          </section>

          <section className="panel">
            <h2>分割</h2>
            <p className="muted">
              再生ヘッド位置に分割点を追加します（論理セグメントのみ作成）。分割点を削除すると隣接セグメントが統合されます。
            </p>
            <button
              type="button"
              className="secondary"
              disabled={disabled || !editor.meta}
              onClick={() => editor.addSplitAtCurrentTime()}
            >
              現在位置に分割点を追加
            </button>
            <MarkerList
              markers={editor.markers}
              disabled={disabled}
              onRemoveMarker={(t) => editor.removeMarkerAtTime(t)}
            />
          </section>

          <section className="panel">
            <h2>セグメント</h2>
            <p className="muted">
              {editor.segments.length > 1
                ? "各分割範囲を別ファイルとして書き出してダウンロードできます（現在のプレビューと同じ映像ソースから切り出し）。"
                : "分割点を追加するとセグメントが複数になり、範囲ごとのダウンロードが使えます。"}
            </p>
            <SegmentList
              segments={editor.segments}
              deletedSegmentIds={editor.deletedSegmentIds}
              disabled={disabled}
              showPerSegmentDownloads={editor.segments.length > 1}
              exportingSegmentId={editor.segmentExportBusySegmentId}
              onToggleDeleted={(id) => editor.toggleSegmentDeleted(id)}
              onDownloadSegment={(seg) => void editor.downloadSegmentExport(seg)}
            />
            <button
              type="button"
              disabled={disabled || !editor.hasUpload}
              style={{ marginTop: 12 }}
              onClick={() => void editor.runMergeKept()}
            >
              削除を適用（結合ジョブ）
            </button>
          </section>

          <section className="panel">
            <h2>速度復元</h2>
            <p className="muted">
              現在プレビュー中のソースを入力として速度・音程を戻します（連鎖時は{" "}
              <code>sourceJobId</code> が自動設定されます）。
            </p>
            <div className="row">
              <div>
                <label htmlFor="speed">速度係数（S）</label>
                <input
                  id="speed"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={editor.speedFactor}
                  disabled={disabled || !editor.hasUpload}
                  onChange={(e) => editor.setSpeedFactor(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="sr">音声 SR（Hz）</label>
                <input
                  id="sr"
                  type="number"
                  step="1"
                  min="1"
                  value={editor.sampleRateHz}
                  disabled={disabled || !editor.hasUpload}
                  onChange={(e) => editor.setSampleRateHz(e.target.value)}
                />
              </div>
            </div>
            <button
              type="button"
              disabled={disabled || !editor.hasUpload}
              style={{ marginTop: 12 }}
              onClick={() => void editor.runRestore()}
            >
              復元ジョブを実行
            </button>
          </section>

          <section className="panel">
            <h2>編集スタック / 出力</h2>
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="secondary" disabled={!editor.canUndo || Boolean(editor.busy)} onClick={() => editor.undoLastStep()}>
                Undo（1つ戻す）
              </button>
              {editor.exportHref ? (
                <a href={editor.exportHref} download>
                  <button type="button" disabled={Boolean(editor.busy)}>
                    現在のプレビューをダウンロード
                  </button>
                </a>
              ) : (
                <button type="button" disabled>
                  ダウンロード不可
                </button>
              )}
            </div>

            <p className="muted" style={{ marginTop: 10 }}>
              適用済みステップ: <code>{editor.appliedSteps.length}</code>
            </p>

            {editor.busy ? <p className="muted">{editor.busy}</p> : null}
            {editor.jobPhase ? (
              <p className="muted">
                phase: <code>{editor.jobPhase}</code>
              </p>
            ) : null}
            {editor.error ? <p className="error">{editor.error}</p> : null}

            {editor.liveJob && typeof editor.liveJob.progressPct === "number" ? (
              <div style={{ marginTop: 8 }}>
                <p className="muted">
                  step: <code>{editor.liveJob.currentStep ?? "processing"}</code> / progress:{" "}
                  <code>{editor.liveJob.progressPct.toFixed(1)}%</code>
                  {typeof editor.liveJob.etaSec === "number" ? (
                    <>
                      {" "}
                      / ETA: <code>{editor.liveJob.etaSec}s</code>
                    </>
                  ) : null}
                </p>
                <progress
                  max={100}
                  value={Math.max(0, Math.min(100, editor.liveJob.progressPct))}
                  style={{ width: "100%" }}
                />
              </div>
            ) : null}

            <ul className="muted stack-list">
              {editor.appliedSteps.map((s) => (
                <li key={s.clientId}>
                  <code>{s.kind}</code> / <code>{s.jobId}</code>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
