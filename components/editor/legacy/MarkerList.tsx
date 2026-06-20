"use client";

export type MarkerListProps = {
  markers: readonly number[];
  disabled?: boolean;
  onRemoveMarker: (timeSec: number) => void;
};

export function MarkerList({ markers, disabled, onRemoveMarker }: MarkerListProps) {
  if (markers.length === 0) {
    return (
      <p className="muted" style={{ marginTop: 10 }}>
        分割点はまだありません。「現在位置に分割点を追加」またはタイムライン上の再生ヘッド位置で追加できます。
      </p>
    );
  }

  return (
    <ul className="marker-list">
      {markers.map((m, idx) => (
        <li key={`marker-${idx}-${m}`} className="marker-row">
          <div className="marker-row-main">
            <span className="marker-row-title">
              #{idx + 1}{" "}
              <span className="muted">
                <code>{m.toFixed(3)}</code>s
              </span>
            </span>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            title="この分割点を削除すると、隣接するセグメントが1つに統合されます"
            onClick={() => onRemoveMarker(m)}
          >
            分割点を削除
          </button>
        </li>
      ))}
    </ul>
  );
}
