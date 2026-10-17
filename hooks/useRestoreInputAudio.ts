"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorProject } from "@/lib/editor/types";
import { parseInputAudio, restoreInputTarget, type InputAudio } from "@/lib/editor/restoreInputAudio";

type Current = { project: EditorProject; epoch: number; blocked: boolean };
type Observation = { key: string; serial: number; status: "loading" | "error" | "ready"; audio?: InputAudio };

/** Ephemeral assistance only. Observation never changes manual settings/history. */
export function useRestoreInputAudio(project: EditorProject, epoch: number, blocked: boolean,
  getCurrent: () => Current, copyRate: (rate: string) => void) {
  const target = restoreInputTarget(project, epoch), key = target?.key ?? "";
  const serial = useRef(0);
  const [retry, setRetry] = useState(0);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [copied, setCopied] = useState<{ key: string; rate: number; serial: number } | null>(null);
  useEffect(() => {
    const requestSerial = ++serial.current;
    if (!target || blocked) return;
    const abort = new AbortController(), captured = target;
    const current = () => {
      const state = getCurrent();
      return !abort.signal.aborted && serial.current === requestSerial && !state.blocked &&
        restoreInputTarget(state.project, state.epoch)?.key === captured.key;
    };
    setObservation({ key: captured.key, serial: requestSerial, status: "loading" });
    const query = new URLSearchParams({ videoId: captured.source.storageAssetId });
    if (captured.source.sourceJobId) query.set("sourceJobId", captured.source.sourceJobId);
    void (async () => {
      try {
        const response = await fetch(`/api/jobs/restore/input-metadata?${query}`, { cache: "no-store", signal: abort.signal });
        const value = await response.json();
        if (!response.ok || value.videoId !== captured.source.storageAssetId || value.sourceJobId !== captured.source.sourceJobId)
          throw Error("入力音声の情報を取得できませんでした。");
        const audio = parseInputAudio(value.inputAudio);
        if (current()) setObservation({ key: captured.key, serial: requestSerial, status: "ready", audio });
      } catch {
        if (current()) setObservation({ key: captured.key, serial: requestSerial, status: "error" });
      }
    })();
    return () => abort.abort();
    // The canonical key contains every target identity field; callbacks are stable.
  }, [key, blocked, retry, getCurrent]);
  const visible = !blocked && observation?.key === key && observation.serial === serial.current ? observation : null;
  const copy = useCallback(() => {
    const state = getCurrent(), current = restoreInputTarget(state.project, state.epoch);
    if (state.blocked || !current || current.key !== key || observation?.key !== key ||
      observation.serial !== serial.current || observation.status !== "ready" || observation.audio?.status !== "known") return;
    copyRate(String(observation.audio.sampleRateHz));
    setCopied({ key, rate: observation.audio.sampleRateHz, serial: observation.serial });
  }, [key, observation, getCurrent, copyRate]);
  return { targetName: target?.name ?? "", hasTarget: Boolean(target),
    status: !target ? "unselected" : blocked ? "blocked" : visible?.status ?? "loading",
    audio: visible?.audio, copy, retry: () => {
      const state = getCurrent();
      if (!state.blocked && restoreInputTarget(state.project, state.epoch)?.key === key) setRetry(v => v + 1);
    },
    copiedRate: !blocked && copied?.key === key && copied.serial === serial.current ? copied.rate : null,
    manualEdit: () => setCopied(null),
  };
}
