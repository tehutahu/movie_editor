"use client";

import { useId, useRef, useState } from "react";
import { formatExactSeek } from "@/lib/editor/exactSeek";

export function ExactSeekInput({ position, epoch, disabled, onCommit }: {
  position: number;
  epoch: number;
  disabled: boolean;
  onCommit: (draft: string, epoch: number) => string | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const edited = useRef(false);
  const composing = useRef(false);
  const focusEpoch = useRef(epoch);
  function cancel() {
    edited.current = false;
    composing.current = false;
    setDraft(null);
    setError(undefined);
  }
  function commit() {
    if (disabled || composing.current || !edited.current || draft === null) return;
    const result = onCommit(draft, focusEpoch.current);
    if (result) setError(result);
    else cancel();
  }
  return <div className="exact-seek" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) cancel();
  }}>
    <label htmlFor={id}>再生位置</label>
    <input id={id} type="text" inputMode="decimal" maxLength={24} disabled={disabled}
      value={draft ?? formatExactSeek(position)} aria-invalid={Boolean(error)}
      aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
      onFocus={() => { if (draft === null) { focusEpoch.current = epoch; setDraft(formatExactSeek(position)); } }}
      onChange={event => { edited.current = true; setDraft(event.target.value); setError(undefined); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
      }} />
    <button type="button" disabled={disabled} onClick={commit}
      onKeyDown={event => { if (event.key === " " || event.code === "Space") event.stopPropagation(); }}>移動</button>
    <span id={`${id}-hint`} className="exact-seek-hint">秒または分:秒（例90.25 / 1:30.25）。Enterで移動</span>
    {error && <span id={`${id}-error`} className="exact-seek-error" role="alert">{error}</span>}
  </div>;
}
