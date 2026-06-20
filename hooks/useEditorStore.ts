"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildDownloadFilename,
  displayNameFromOriginalFilename,
  sanitizeExportBaseName,
} from "@/lib/exportName";
import {
  canRedo,
  canUndo,
  createCommandHistory,
  dispatchCommand,
  getCurrentProject,
  redo,
  undo,
  type CommandHistory,
} from "@/lib/editor/commandHistory";
import type { EditorCommand } from "@/lib/editor/commands";
import {
  clipFromAsset,
  computeCompositionDuration,
  createEmptyProject,
} from "@/lib/editor/project";
import type { AppliedJobStep, Asset, ClipTransform, EditorProject } from "@/lib/editor/types";

type JobPollInfo = {
  jobId: string;
  kind: string;
  status: "pending" | "running" | "done" | "error";
  error?: string;
  downloadName?: string;
  progressPct?: number;
  etaSec?: number;
  currentStep?: string;
};

async function pollJobUntil(
  jobId: string,
  opts: { onTick?: (j: JobPollInfo) => void; timeoutMs?: number } = {},
): Promise<JobPollInfo> {
  const timeoutMs = opts.timeoutMs ?? 1000 * 60 * 60;
  const started = Date.now();

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("ジョブの待機がタイムアウトしました。");
    }

    const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    const json = (await res.json()) as JobPollInfo & { error?: string };
    if (!res.ok) throw new Error(json.error ?? "ジョブ取得に失敗しました。");

    opts.onTick?.(json);
    if (json.status === "done" || json.status === "error") return json;
    await new Promise((r) => setTimeout(r, 750));
  }
}

export function useEditorStore() {
  const [history, setHistory] = useState<CommandHistory>(() =>
    createCommandHistory(createEmptyProject()),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveJob, setLiveJob] = useState<JobPollInfo | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);
  const [appliedJobSteps, setAppliedJobSteps] = useState<AppliedJobStep[]>([]);
  const [speedFactor, setSpeedFactor] = useState("2");
  const [sampleRateHz, setSampleRateHz] = useState("44100");
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [clipExportBusyId, setClipExportBusyId] = useState<string | null>(null);

  const audioVideoRef = useRef<HTMLVideoElement | null>(null);

  const project = useMemo(() => getCurrentProject(history), [history]);

  const dispatch = useCallback((command: EditorCommand) => {
    setHistory((h) => {
      const result = dispatchCommand(h, command);
      return result?.history ?? h;
    });
  }, []);

  const undoEdit = useCallback(() => {
    setHistory((h) => undo(h) ?? h);
  }, []);

  const redoEdit = useCallback(() => {
    setHistory((h) => redo(h) ?? h);
  }, []);

  const setPlayheadSec = useCallback((sec: number | ((prev: number) => number)) => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      const raw = typeof sec === "function" ? sec(cur.playheadSec) : sec;
      const clamped = Math.max(0, Math.min(raw, cur.compositionDurationSec));
      if (Math.abs(clamped - cur.playheadSec) < 1e-6) return h;
      return {
        ...h,
        undoStack: [
          ...h.undoStack.slice(0, -1),
          { ...cur, playheadSec: clamped },
        ],
        redoStack: [],
      };
    });
  }, []);

  const setExportBaseName = useCallback((name: string) => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      return {
        ...h,
        undoStack: [
          ...h.undoStack.slice(0, -1),
          { ...cur, exportBaseName: name },
        ],
        redoStack: [],
      };
    });
  }, []);

  const selectClip = useCallback((clipId: string, additive: boolean) => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      let selected = cur.selectedClipIds;
      if (additive) {
        selected = selected.includes(clipId)
          ? selected.filter((id) => id !== clipId)
          : [...selected, clipId];
      } else {
        selected = [clipId];
      }
      return {
        ...h,
        undoStack: [...h.undoStack.slice(0, -1), { ...cur, selectedClipIds: selected }],
        redoStack: [],
      };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      if (cur.selectedClipIds.length === 0) return h;
      return {
        ...h,
        undoStack: [...h.undoStack.slice(0, -1), { ...cur, selectedClipIds: [] }],
        redoStack: [],
      };
    });
  }, []);

  const uploadAssets = useCallback(async (files: FileList | File[]) => {
    setError(null);
    setBusy("アップロード中…");
    try {
      const fd = new FormData();
      const list = files instanceof FileList ? [...files] : files;
      for (const f of list) fd.append("files", f);

      const res = await fetch("/api/assets", { method: "POST", body: fd });
      const json = (await res.json()) as {
        assets?: {
          assetId: string;
          kind: "video" | "image";
          ext: string;
          displayName: string;
          streamUrl: string;
          thumbnailStripUrl?: string;
          sourceDurationSec?: number;
          width?: number;
          height?: number;
        }[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "アップロードに失敗しました。");

      const newAssets: Asset[] = (json.assets ?? []).map((a) => ({
        id: a.assetId,
        kind: a.kind,
        streamUrl: a.streamUrl,
        displayName: a.displayName,
        sourceDurationSec: a.sourceDurationSec,
        width: a.width,
        height: a.height,
        thumbnailStripUrl: a.thumbnailStripUrl,
        ext: a.ext,
      }));

      setHistory((h) => {
        const cur = getCurrentProject(h);
        const next: EditorProject = {
          ...cur,
          assets: [...cur.assets, ...newAssets],
          compositionDurationSec: computeCompositionDuration(cur.clips),
        };
        if (cur.assets.length === 0 && newAssets[0]) {
          next.exportBaseName = displayNameFromOriginalFilename(newAssets[0].displayName);
        }
        return { undoStack: [...h.undoStack.slice(0, -1), next], redoStack: [] };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const addClipFromAsset = useCallback(
    (asset: Asset, trackId: string, startSec: number) => {
      setHistory((h) => {
        const cur = getCurrentProject(h);
        const clip = clipFromAsset({
          asset,
          trackId,
          timelineStartSec: startSec,
          tracks: cur.tracks,
        });
        return dispatchCommand(h, { type: "addClip", clip })?.history ?? h;
      });
    },
    [],
  );

  const addTrack = useCallback(() => {
    dispatch({ type: "addTrack" });
  }, [dispatch]);

  const splitAtPlayhead = useCallback(() => {
    const cur = getCurrentProject(history);
    const selected = cur.selectedClipIds[0];
    if (!selected) {
      setError("分割するクリップを選択してください。");
      return;
    }
    dispatch({ type: "split", clipId: selected, atSec: cur.playheadSec });
  }, [dispatch, history]);

  const mergeSelected = useCallback(() => {
    const cur = getCurrentProject(history);
    if (cur.selectedClipIds.length < 2) {
      setError("結合するクリップを2つ以上選択してください（Ctrl+クリック）。");
      return;
    }
    dispatch({ type: "merge", clipIds: cur.selectedClipIds });
  }, [dispatch, history]);

  const deleteSelected = useCallback(() => {
    const cur = getCurrentProject(history);
    if (cur.selectedClipIds.length === 0) return;
    dispatch({ type: "delete", clipIds: cur.selectedClipIds });
  }, [dispatch, history]);

  const moveSelectedClip = useCallback(
    (clipId: string, newStartSec: number, newTrackId?: string) => {
      dispatch({ type: "move", clipId, newStartSec, newTrackId });
    },
    [dispatch],
  );

  const resizeClipDuration = useCallback(
    (clipId: string, newDurationSec: number) => {
      dispatch({ type: "resize", clipId, newDurationSec });
    },
    [dispatch],
  );

  const updateClipTransform = useCallback(
    (clipId: string, transform: ClipTransform) => {
      dispatch({ type: "transform", clipId, transform });
    },
    [dispatch],
  );

  const downloadSelectedClip = useCallback(async () => {
    setError(null);
    const cur = getCurrentProject(history);
    const clipId = cur.selectedClipIds[0];
    if (!clipId) {
      setError("ダウンロードするクリップを選択してください。");
      return;
    }
    const clip = cur.clips.find((c) => c.id === clipId);
    if (!clip) return;

    setClipExportBusyId(clipId);
    try {
      const part = clip.parts[0];
      if (!part) throw new Error("クリップに素材がありません。");

      const res = await fetch("/api/jobs/export-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: part.assetId,
          startSec: part.sourceInSec,
          endSec: part.sourceInSec + clip.durationSec,
          exportBaseName: sanitizeExportBaseName(cur.exportBaseName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "書き出しに失敗しました。");
      if (!json.jobId) throw new Error("jobId がありません。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setLiveJob(j);
          setJobPhase(`export:${j.status}`);
        },
      });
      if (info.status === "error") throw new Error(info.error ?? "書き出し失敗");

      const filename = buildDownloadFilename(
        sanitizeExportBaseName(cur.exportBaseName),
        `clip_${clip.timelineStartSec.toFixed(1)}`,
        "mp4",
      );
      const a = document.createElement("a");
      a.href = `/api/download/${json.jobId}?downloadName=${encodeURIComponent(filename)}`;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClipExportBusyId(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }, [history]);

  const restoreSpeedForSelected = useCallback(async () => {
    setError(null);
    const cur = getCurrentProject(history);
    const clipId = cur.selectedClipIds[0];
    if (!clipId) {
      setError("速度復元する動画クリップを選択してください。");
      return;
    }
    const clip = cur.clips.find((c) => c.id === clipId);
    const asset = cur.assets.find((a) => a.id === clip?.parts[0]?.assetId);
    if (!clip || !asset || asset.kind !== "video") {
      setError("動画クリップを選択してください。");
      return;
    }

    setBusy("速度復元中…");
    setJobPhase("restore:queued");
    try {
      const res = await fetch("/api/jobs/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: asset.id,
          speedFactor: Number(speedFactor),
          sampleRateHz: Number(sampleRateHz),
          exportBaseName: sanitizeExportBaseName(cur.exportBaseName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成失敗");
      if (!json.jobId) throw new Error("jobId がありません。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setLiveJob(j);
          setJobPhase(`restore:${j.status}`);
        },
      });
      if (info.status === "error") throw new Error(info.error ?? "復元失敗");

      setAppliedJobSteps((prev) => [
        ...prev,
        { clientId: crypto.randomUUID(), kind: "restore", jobId: json.jobId!, clipId, status: "done" },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }, [history, speedFactor, sampleRateHz]);

  const exportComposition = useCallback(async () => {
    setError(null);
    const cur = getCurrentProject(history);
    if (cur.clips.length === 0) {
      setError("タイムラインにクリップがありません。");
      return;
    }

    setBusy("書き出し中…");
    setJobPhase("composition:queued");
    try {
      const res = await fetch("/api/jobs/export-composition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assets: cur.assets,
          tracks: cur.tracks,
          clips: cur.clips,
          compositionDurationSec: cur.compositionDurationSec,
          exportBaseName: sanitizeExportBaseName(cur.exportBaseName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "書き出しジョブ作成失敗");
      if (!json.jobId) throw new Error("jobId がありません。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setLiveJob(j);
          setJobPhase(`composition:${j.status}`);
        },
      });
      if (info.status === "error") throw new Error(info.error ?? "書き出し失敗");

      const filename = buildDownloadFilename(
        sanitizeExportBaseName(cur.exportBaseName),
        "composition",
        "mp4",
      );
      const a = document.createElement("a");
      a.href = `/api/download/${json.jobId}?downloadName=${encodeURIComponent(filename)}`;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }, [history]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redoEdit();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undoEdit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoEdit, redoEdit]);

  return {
    project,
    busy,
    error,
    liveJob,
    jobPhase,
    appliedJobSteps,
    speedFactor,
    setSpeedFactor,
    sampleRateHz,
    setSampleRateHz,
    timelineZoom,
    setTimelineZoom,
    clipExportBusyId,
    audioVideoRef,
    canUndoEdit: canUndo(history),
    canRedoEdit: canRedo(history),
    uploadAssets,
    addClipFromAsset,
    addTrack,
    splitAtPlayhead,
    mergeSelected,
    deleteSelected,
    moveSelectedClip,
    resizeClipDuration,
    updateClipTransform,
    downloadSelectedClip,
    restoreSpeedForSelected,
    exportComposition,
    setPlayheadSec,
    setExportBaseName,
    selectClip,
    clearSelection,
    undoEdit,
    redoEdit,
    dispatch,
  };
}

export type EditorStore = ReturnType<typeof useEditorStore>;
