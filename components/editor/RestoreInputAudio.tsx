"use client";
import type { EditorStore } from "@/hooks/useEditorStore";

export function RestoreInputAudio({ editor }: { editor: EditorStore }) {
  const input = editor.restoreInputAudio, audio = input.audio;
  const known = input.status === "ready" && audio?.status === "known";
  const reason = !input.hasTarget ? "速度復元する動画クリップを選択してください。"
    : input.status === "blocked" ? editor.restoreHelpBlocked ? "ヘルプを閉じてから操作してください。" : "処理が終わってから操作してください。"
    : input.status === "loading" ? "入力音声を取得中です。"
    : input.status === "error" ? "入力音声を取得できませんでした。手動の設定で復元できます。"
    : audio?.status === "none" ? "音声なし。Hzの設定は使いません。"
    : audio?.status === "unknown" ? "入力のHzを取得できません。手動の設定で復元できます。" : "";
  return <div className="restore-rate-support" data-restore-input-audio onKeyDown={event => event.stopPropagation()}>
    <p className="muted" aria-live="polite">{input.hasTarget ? `復元対象: ${input.targetName}（選択した先頭クリップの先頭素材）` : reason}</p>
    {input.hasTarget && <>
      <p className="muted" data-input-rate-status>{known ? `取得時の入力音声: ${audio.sampleRateHz} Hz（音声トラック1 / a:0）` : reason}</p>
      <button type="button" onClick={input.copy} disabled={!known} title={reason || "取得した入力のHzを復元基準Hzへコピーします"}>入力に合わせる</button>
      {input.status === "error" && <button type="button" onClick={input.retry}>入力情報を再取得</button>}
      {known && Number(editor.sampleRateHz) !== audio.sampleRateHz && <p className="restore-rate-warning">入力と復元基準Hzが異なるため、音声の速度・音程が映像の係数とずれます。手動の値でも復元できます。</p>}
      {known && input.copiedRate === audio.sampleRateHz && Number(editor.sampleRateHz) === input.copiedRate && <p className="muted" data-input-rate-copied>取得時の入力Hzをコピー済み。実行時の一致を保証するものではありません。</p>}
    </>}
  </div>;
}

export function RestoreInputAudioSummary({ editor }: { editor: EditorStore }) {
  const input = editor.restoreInputAudio, audio = input.audio;
  const known = input.status === "ready" && audio?.status === "known";
  const state = input.status === "unselected" ? "動画未選択" : input.status === "blocked" ? editor.restoreHelpBlocked ? "ヘルプ表示中" : "処理中"
    : input.status === "loading" ? "取得中" : input.status === "error" ? "取得失敗"
    : audio?.status === "none" ? "音声なし" : "入力Hz不明";
  return <summary onKeyDown={event => { if (event.key === " " || event.key === "Enter") event.stopPropagation(); }} data-restore-rate-summary className={known && Number(editor.sampleRateHz) !== audio.sampleRateHz ? "restore-rate-warning" : undefined}>
    {known ? `取得時 ${audio.sampleRateHz} / 基準 ${editor.sampleRateHz} Hz${Number(editor.sampleRateHz) !== audio.sampleRateHz ? "（差あり）" : ""}` : `入力音声: ${state} / 基準 ${editor.sampleRateHz} Hz`}
  </summary>;
}
