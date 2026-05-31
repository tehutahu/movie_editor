const DEFAULT_BASE = "video";
const MAX_BASE_LEN = 180;

/** アップロード元ファイル名から拡張子を除いた表示名を得ます。 */
function basename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** アップロード元ファイル名から拡張子を除いた表示名を得ます。 */
export function displayNameFromOriginalFilename(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return base.slice(0, dot);
  return base || DEFAULT_BASE;
}

/** 出力ファイル名のベースとして安全な文字列に正規化します。 */
export function sanitizeExportBaseName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BASE;
  const cleaned = trimmed
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/[\r\n\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_BASE_LEN);
  return cleaned || DEFAULT_BASE;
}

/** クエリ等で受け取ったダウンロードファイル名を検証します。 */
export function parseDownloadFilenameParam(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = basename(trimmed);
  if (!base || base === "." || base === "..") return null;
  if (/[\r\n\x00-\x1f]/.test(base)) return null;
  if (base.length > 255) return null;
  return base;
}

export function buildDownloadFilename(
  baseName: string,
  suffix: string,
  ext: string,
): string {
  const safe = sanitizeExportBaseName(baseName);
  const part = suffix ? `_${suffix}` : "";
  const safeExt = ext.replace(/^\./, "").toLowerCase() || "mp4";
  return `${safe}${part}.${safeExt}`;
}
