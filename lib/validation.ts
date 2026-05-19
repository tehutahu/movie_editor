export const ALLOWED_VIDEO_EXT = new Set([
  "mp4",
  "mkv",
  "avi",
  "mov",
  "flv",
  "wmv",
]);

export function parseAllowedVideoExtension(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_VIDEO_EXT.has(ext)) return null;
  return ext;
}

export function assertPositiveNumber(label: string, value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} は正の数である必要があります。`);
  }
  return n;
}

export function assertPositiveInt(label: string, value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${label} は正の整数である必要があります。`);
  }
  return n;
}

export type Range = { startSec: number; endSec: number };

function assertFiniteNonNegative(label: string, value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} は0以上の有限の数である必要があります。`);
  }
  return n;
}

/** 入力区間 [{start,end}, ...] を検証して正規化（秒単位）。 */
export function normalizeRanges(
  durationSec: number,
  raw: unknown,
  opts: { allowEmpty?: boolean } = {},
): Range[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    if (opts.allowEmpty) return [];
    throw new Error("区間は配列で1件以上指定してください（例: [{ startSec: 0, endSec: 10 }]）。");
  }

  const out: Range[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("無効な区間エントリです（オブジェクト形式で指定してください）");
    }

    const r = entry as Record<string, unknown>;
    const startSec = assertFiniteNonNegative(
      "startSec",
      "startSec" in r ? r.startSec : r.start ?? r.begin,
    );
    const endSec = assertFiniteNonNegative(
      "endSec",
      "endSec" in r ? r.endSec : r.end ?? r.finish,
    );

    if (startSec >= endSec) throw new Error("各区間では start が end より小さい必要があります。");
    if (startSec > durationSec + 1e-6) continue;
    out.push({ startSec: Math.max(0, startSec), endSec: Math.min(endSec, durationSec) });
  }

  out.sort((a, b) => a.startSec - b.startSec);
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...r });
      continue;
    }
    if (r.startSec <= last.endSec + 1e-9) {
      last.endSec = Math.max(last.endSec, r.endSec);
    } else {
      merged.push({ ...r });
    }
  }
  if (merged.length === 0 && !opts.allowEmpty) throw new Error("有効な区間がありません。");
  return merged;
}

/** 削除対象区間から「残す」区間列を算出（昇順マージ済み remove を前提でも再マージします）。 */
export function keptRangesAfterRemovals(durationSec: number, remove: Range[]): Range[] {
  if (durationSec <= 0 || !Number.isFinite(durationSec)) {
    throw new Error("無効な動画長です。");
  }

  const sorted = [...remove].sort((a, b) => a.startSec - b.startSec);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...r });
      continue;
    }
    if (r.startSec <= last.endSec + 1e-9) {
      last.endSec = Math.max(last.endSec, r.endSec);
    } else {
      merged.push({ ...r });
    }
  }

  const kept: Range[] = [];
  let cursor = 0;
  for (const gap of merged) {
    const s = gap.startSec;
    const e = gap.endSec;
    if (cursor + 1e-9 < s) {
      kept.push({ startSec: cursor, endSec: Math.min(s, durationSec) });
    }
    cursor = Math.max(cursor, e);
    if (cursor >= durationSec - 1e-9) break;
  }
  if (cursor + 1e-9 < durationSec) {
    kept.push({ startSec: cursor, endSec: durationSec });
  }

  const nonempty = kept.filter((k) => k.endSec - k.startSec > 1e-6);
  if (nonempty.length === 0) {
    throw new Error("削除指定の結果として残り区間がありません。");
  }
  return nonempty;
}
