"use client";
import { useId, useMemo, useState } from "react";
import type { EditorStore } from "@/hooks/useEditorStore";
import { clipAudioGain, clipAudioSnapshot, type ClipAudioSnapshot } from "@/lib/editor/clipAudio";

export function ClipAudioControl({ editor }: { editor: EditorStore }) {
  const p = editor.project;
  const snapshot = useMemo(() => clipAudioSnapshot(p, editor.projectEpoch), [p.assets, p.clips, p.selectedClipIds, editor.projectEpoch]);
  const blocked = editor.areEditorShortcutsBlocked();
  return <AudioDraft key={`${snapshot.epoch}:${snapshot.identity}:${JSON.stringify(snapshot.selection)}:${blocked}`} editor={editor} snapshot={snapshot} blocked={blocked} />;
}
function AudioDraft({ editor, snapshot, blocked }: { editor: EditorStore; snapshot: ClipAudioSnapshot; blocked: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const hintId = useId();
  const targets = editor.project.clips.filter(c => snapshot.clipIds.includes(c.id));
  const gains = new Set(targets.map(clipAudioGain)), mixed = gains.size > 1;
  const display = mixed ? "" : String((gains.values().next().value ?? 1) * 100);
  const valid = draft !== null && /^\d{1,3}$/.test(draft) && Number(draft) <= 100;
  const disabled = blocked || targets.length === 0;
  const apply = (gain?: number) => {
    if (editor.areEditorShortcutsBlocked() || disabled || (gain === undefined && !valid)) return;
    editor.setSelectedAudioGain(snapshot, gain ?? Number(draft) / 100);
    setDraft(null);
  };
  return <div className="clip-audio-control" data-clip-audio onKeyDown={e => e.stopPropagation()}>
    <label>音量 % <input aria-label="クリップ音量 %" type="text" inputMode="numeric" maxLength={20}
      value={draft ?? display} placeholder={mixed ? "混在" : undefined} disabled={disabled}
      aria-invalid={draft !== null && !valid} aria-describedby={hintId} onChange={e => { if (!editor.areEditorShortcutsBlocked()) setDraft(e.target.value); }}
      onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") { e.preventDefault(); setDraft(null); } }} />
    </label>
    <button type="button" onClick={() => apply()} disabled={disabled || !valid}>音量を適用</button>
    <button type="button" onClick={() => apply(0)} disabled={disabled}>消音（0%）</button>
    <span id={hintId} className="muted">{draft !== null && !valid ? "0〜100の整数を入力してください。" : "0%=消音"}</span>
    <span className="muted" data-clip-audio-status>{blocked ? editor.restoreHelpBlocked ? "ヘルプを閉じてから操作してください。" : "処理が終わってから操作してください。" : `対象 ${targets.length}件 / 純画像 ${snapshot.selection.length - targets.length}件を除外${mixed ? " / 混在" : ""}`}</span>
    <span className="muted">音量はプレビュー・全体出力に適用。素材DLは元音声。</span>
  </div>;
}
