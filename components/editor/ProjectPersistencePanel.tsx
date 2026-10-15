"use client";
import type { EditorStore } from "@/hooks/useEditorStore";
export function ProjectPersistencePanel({ editor }: { editor: EditorStore }) {
  const p = editor.persistence;
  const disabled = Boolean(editor.busy) || p.locked;
  return (
    <section
      aria-label="プロジェクト保存と読み込み"
      className="project-persistence"
    >
      <strong>{p.dirty ? "未保存の変更あり" : "変更なし"}</strong>
      <button disabled={disabled} onClick={() => void p.save()}>
        新しい保存版を保存
      </button>
      <label>
        JSON を読み込み{" "}
        <input
          aria-label="JSON を読み込み"
          type="file"
          accept=".json,application/json"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void p.importJson(f);
          }}
        />
      </label>
      <p role="status">{p.message}</p>
      <details>
        <summary>サーバーの保存版 ({p.revisions.length})</summary>
        {p.revisions.map((r) => (
          <div key={r.id} className="project-revision">
            <span>
              {r.name} — {new Date(r.createdAt).toLocaleString()}
            </span>
            <button
              disabled={disabled}
              onClick={() => void p.loadRevision(r.id)}
            >
              読み込み
            </button>
            <button disabled={disabled} onClick={() => p.download(r.id)}>
              JSON ダウンロード
            </button>
            <button
              disabled={disabled}
              onClick={() => void p.removeRevision(r.id)}
            >
              保存版を削除
            </button>
          </div>
        ))}
      </details>
      {p.confirmation ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="未保存の変更"
          className="project-dialog"
        >
          <p>未保存の変更があります。現在の編集を保存しますか？</p>
          <button onClick={() => p.answerConfirmation("save")}>
            保存して続ける
          </button>
          <button onClick={() => p.answerConfirmation("discard")}>
            破棄して続ける
          </button>
          <button onClick={() => p.answerConfirmation("cancel")}>
            キャンセル
          </button>
        </div>
      ) : null}
      {p.candidate ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="欠損素材の再指定"
          className="project-dialog"
        >
          <p>
            同じバイト列の素材を再指定してください。すべての素材が検証されるまで現在の編集は維持されます。
          </p>
          {p.candidate.missing.map((m) => (
            <label key={m.assetId}>
              {m.displayName} ({m.size} bytes)
              <br />
              <small>SHA-256: {m.sha256}</small>
              <input
                type="file"
                aria-label={`${m.displayName} を再指定`}
                disabled={Boolean(editor.busy)}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void p.replaceMissing(m.assetId, f);
                }}
              />
            </label>
          ))}
          <button disabled={Boolean(editor.busy)} onClick={p.cancelLoad}>
            読み込みをキャンセル
          </button>
        </div>
      ) : null}
    </section>
  );
}
