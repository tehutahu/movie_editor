export type Segment = {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
};

export type TimeRange = { startSec: number; endSec: number };

const EPS = 1e-9;

function uniqSortedMarkers(markers: readonly number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const m of markers) {
    if (!Number.isFinite(m)) continue;
    const k = String(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * マーカー位置（秒）と全体の長さから論理セグメント列を構築します。
 * 境界は `0`, マーカー（0< t < duration 内のみ）, `duration` です。
 */
export function buildSegmentsFromMarkers(durationSec: number, markers: readonly number[]): Segment[] {
  if (!Number.isFinite(durationSec) || durationSec <= EPS) {
    return [];
  }

  const sorted = uniqSortedMarkers(markers);
  const inner = sorted.filter((t) => t > EPS && t < durationSec - EPS);
  const bounds = [0, ...inner, durationSec];

  const segments: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const startSec = bounds[i]!;
    const endSec = bounds[i + 1]!;
    if (endSec - startSec <= EPS) continue;
    const index = segments.length;
    segments.push({
      id: `seg-${index}`,
      index,
      startSec,
      endSec,
    });
  }
  return segments;
}

/** 削除指定されたセグメントを `removeRanges`（merge_kept 用）へ変換します。 */
export function segmentsToRemoveRanges(
  deletedSegmentIds: ReadonlySet<string>,
  segments: readonly Segment[],
): TimeRange[] {
  const out: TimeRange[] = [];
  for (const s of segments) {
    if (!deletedSegmentIds.has(s.id)) continue;
    out.push({ startSec: s.startSec, endSec: s.endSec });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}
