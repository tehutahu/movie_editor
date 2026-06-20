/** `randomUUID()` で発行する storage / job ID（パストラバーサル防止） */
const STORAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertStorageId(label: string, value: string): string {
  if (!STORAGE_ID_RE.test(value)) {
    throw new Error(`${label} の形式が不正です。`);
  }
  return value;
}

/** デフォルト 8 GiB。`MAX_UPLOAD_BYTES` 環境変数で上書き可。 */
export const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (raw === undefined || raw === "") return 8 * 1024 ** 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("MAX_UPLOAD_BYTES は正の数である必要があります。");
  }
  return Math.floor(n);
})();

export const ALLOWED_VIDEO_EXT = new Set([
  "mp4",
  "mkv",
  "avi",
  "mov",
  "flv",
  "wmv",
]);

export const ALLOWED_IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export const ALLOWED_ASSET_EXT = new Set([...ALLOWED_VIDEO_EXT, ...ALLOWED_IMAGE_EXT]);

export function parseAllowedVideoExtension(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_VIDEO_EXT.has(ext)) return null;
  return ext;
}

export function parseAllowedImageExtension(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_IMAGE_EXT.has(ext)) return null;
  return ext;
}

export function parseAllowedAssetExtension(filename: string): {
  ext: string;
  kind: "video" | "image";
} | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (ALLOWED_VIDEO_EXT.has(ext)) return { ext, kind: "video" };
  if (ALLOWED_IMAGE_EXT.has(ext)) return { ext, kind: "image" };
  return null;
}

/** ジョブ出力ファイル名のベース（クライアント指定、任意）。 */
export function parseExportBaseName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error("exportBaseName は文字列である必要があります。");
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed;
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
export function normalizeRanges(durationSec: number, raw: unknown): Range[] {
  if (!Array.isArray(raw) || raw.length === 0) {
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

    if (startSec >= endSec) {
      throw new Error("各区間では start が end より小さい必要があります。");
    }
    if (endSec > durationSec + 1e-6) {
      throw new Error(
        `区間が動画長を超えています（end=${endSec} > duration=${durationSec}）。`,
      );
    }
    if (startSec > durationSec + 1e-6) {
      throw new Error(
        `区間が動画長を超えています（start=${startSec} > duration=${durationSec}）。`,
      );
    }

    out.push({ startSec, endSec: Math.min(endSec, durationSec) });
  }

  out.sort((a, b) => a.startSec - b.startSec);
  return out;
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
