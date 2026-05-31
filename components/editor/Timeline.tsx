"use client";

import type { Segment } from "@/lib/segments";

export type TimelineProps = {
  durationSec: number;
  currentTimeSec: number;
  markers: readonly number[];
  segments: readonly Segment[];
  deletedSegmentIds: ReadonlySet<string>;
  disabled?: boolean;
  onSeek: (sec: number) => void;
  onRemoveMarker?: (timeSec: number) => void;
};

export function Timeline({
  durationSec,
  currentTimeSec,
  markers,
  segments,
  deletedSegmentIds,
  disabled,
  onSeek,
  onRemoveMarker,
}: TimelineProps) {
  const safeDur = durationSec > 0 ? durationSec : 1;

  function seekFromClientX(track: HTMLDivElement, clientX: number) {
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, x / rect.width)) : 0;
    onSeek(ratio * durationSec);
  }

  return (
    <div className={`timeline-root${disabled ? " timeline-root--disabled" : ""}`}>
      <div className="timeline-meta row-between">
        <span className="muted">
          head: <code>{currentTimeSec.toFixed(3)}</code>s /{" "}
          <code>{durationSec.toFixed(3)}</code>s
        </span>
        <span className="muted">
          markers: <code>{markers.length}</code> / segments: <code>{segments.length}</code>
        </span>
      </div>

      <div
        className="timeline-track"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={durationSec}
        aria-valuenow={currentTimeSec}
        aria-disabled={disabled ? true : undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(e) => {
          if (disabled) return;
          const track = e.currentTarget;
          seekFromClientX(track, e.clientX);

          function move(ev: PointerEvent) {
            seekFromClientX(track, ev.clientX);
          }
          function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          }

          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = Math.max(0.05, durationSec / 200);
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onSeek(Math.max(0, currentTimeSec - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onSeek(Math.min(durationSec, currentTimeSec + step));
          }
        }}
      >
        <div className="timeline-inner">
          {segments.map((s) => {
            const leftPct = (s.startSec / safeDur) * 100;
            const widthPct = ((s.endSec - s.startSec) / safeDur) * 100;
            const deleted = deletedSegmentIds.has(s.id);
            return (
              <div
                key={s.id}
                className={`timeline-segment${deleted ? " timeline-segment--deleted" : ""}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title={`${s.startSec.toFixed(3)}–${s.endSec.toFixed(3)}s`}
              />
            );
          })}

          {markers.map((m, idx) => (
            <button
              key={`m-${idx}-${m}`}
              type="button"
              className="timeline-marker"
              style={{ left: `${(m / safeDur) * 100}%` }}
              title={`分割点 ${m.toFixed(3)}s — クリックで削除`}
              aria-label={`分割点 ${m.toFixed(3)} 秒を削除`}
              disabled={disabled || !onRemoveMarker}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (disabled || !onRemoveMarker) return;
                onRemoveMarker(m);
              }}
            />
          ))}

          <div
            className="timeline-playhead"
            style={{ left: `${(currentTimeSec / safeDur) * 100}%` }}
          />
        </div>
      </div>

      <p className="muted timeline-hint">
        トラックをクリック／ドラッグでシークできます（キーボード ← → も利用可能）。
        {onRemoveMarker ? " 黄色の分割点をクリックすると削除できます。" : null}
      </p>
    </div>
  );
}
