import { getCurrentProject, updateEditorView, type CommandHistory } from "./commandHistory";

export const SEEK_FORMAT_ERROR = "秒または分:秒で入力してください（小数は6桁まで）。";
export const SEEK_RANGE_ERROR = "0〜現在の長さの範囲で入力してください。";

export function parseExactSeek(text: string, duration: number): { value: number; error?: never } | { error: string; value?: never } {
  const draft = text.trim();
  if (text.length > 24 || !/^(?:\d+(?:\.\d{1,6})?|\d+:[0-5]\d(?:\.\d{1,6})?)$/.test(draft)) {
    return { error: SEEK_FORMAT_ERROR };
  }
  const parts = draft.split(":");
  const value = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(draft);
  if (!Number.isFinite(value) || !Number.isFinite(duration) || value < 0 || value > duration) return { error: SEEK_RANGE_ERROR };
  return { value };
}

// Presentation only: a focus/blur cycle must never write this rounded value back.
export function formatExactSeek(value: number): string {
  return String(Number(value.toFixed(6)));
}
/** Revalidate at React updater adoption, after any queued load/edit/lock. */
export function applyExactSeek(history: CommandHistory, target: number, expectedEpoch: number, currentEpoch: number, blocked: boolean): CommandHistory {
  const project = getCurrentProject(history);
  if (blocked || expectedEpoch !== currentEpoch || !Number.isFinite(target) || !Number.isFinite(project.compositionDurationSec) || target < 0 ||
    target > project.compositionDurationSec || target === project.playheadSec) return history;
  return updateEditorView(history, { playheadSec: target });
}
