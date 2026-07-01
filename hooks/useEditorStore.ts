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
import { applyCommand } from "@/lib/editor/commands";
import {
  clipFromAsset,
  computeCompositionDuration,
  createEmptyProject,
  findAsset,
} from "@/lib/editor/project";
import {
  compositionSizeForFirstClip,
  compositionSizeFromAsset,
  fitClipTransformToCanvas,
} from "@/lib/editor/compositor";
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
        const sizePatch = compositionSizeForFirstClip(cur, asset);
        const base = sizePatch ? { ...cur, ...sizePatch } : cur;
        const next = applyCommand(base, { type: "addClip", clip });
        if (!next) return h;
        return { undoStack: [...h.undoStack, next], redoStack: [] };
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
    setError(null);
    setHistory((h) => {
      const result = dispatchCommand(h, { type: "merge", clipIds: cur.selectedClipIds });
      if (!result) {
        setError("結合できませんでした。同一トラック上のクリップを選択してください。");
        return h;
      }
      return result.history;
    });
  }, [history]);

  const deleteSelected = useCallback(() => {
    const cur = getCurrentProject(history);
    if (cur.selectedClipIds.length === 0) return;
    dispatch({ type: "delete", clipIds: cur.selectedClipIds });
  }, [dispatch, history]);

  const duplicateSelected = useCallback(() => {
    const cur = getCurrentProject(history);
    if (cur.selectedClipIds.length === 0) {
      setError("複製するクリップを選択してください。");
      return;
    }
    setError(null);
    setHistory((h) => {
      const result = dispatchCommand(h, { type: "duplicate", clipIds: cur.selectedClipIds });
      if (!result) {
        setError("複製できませんでした。");
        return h;
      }
      return result.history;
    });
  }, [history]);

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

  const fitSelectedClipsToCanvas = useCallback(() => {
    setError(null);
    setHistory((h) => {
      const cur = getCurrentProject(h);
      if (cur.selectedClipIds.length === 0) return h;
      const fit = fitClipTransformToCanvas();
      const ids = new Set(cur.selectedClipIds);
      const next: EditorProject = {
        ...cur,
        clips: cur.clips.map((c) =>
          ids.has(c.id) ? { ...c, transform: { ...fit } } : c,
        ),
      };
      return { undoStack: [...h.undoStack, next], redoStack: [] };
    });
  }, []);

  const setCompositionSize = useCallback((width: number, height: number) => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      if (cur.compositionWidth === width && cur.compositionHeight === height) return h;
      const next: EditorProject = { ...cur, compositionWidth: width, compositionHeight: height };
      return { undoStack: [...h.undoStack, next], redoStack: [] };
    });
  }, []);

  const matchCompositionToSelectedClip = useCallback(() => {
    setError(null);
    setHistory((h) => {
      const cur = getCurrentProject(h);
      const selectedId = cur.selectedClipIds[0];
      if (!selectedId) {
        setError("素材に合わせるクリップを選択してください。");
        return h;
      }
      const clip = cur.clips.find((c) => c.id === selectedId);
      if (!clip) return h;
      const asset = findAsset(cur.assets, clip.parts[0]?.assetId ?? "");
      if (!asset?.width || !asset?.height) {
        setError("選択クリップの素材解像度が不明です。");
        return h;
      }
      const size = compositionSizeFromAsset(asset.width, asset.height);
      if (
        cur.compositionWidth === size.width &&
        cur.compositionHeight === size.height
      ) {
        return h;
      }
      const next: EditorProject = {
        ...cur,
        compositionWidth: size.width,
        compositionHeight: size.height,
      };
      return { undoStack: [...h.undoStack, next], redoStack: [] };
    });
  }, []);

  const exportSelectedClips = useCallback(async () => {
    setError(null);
    const cur = getCurrentProject(history);
    const clipIds = [...cur.selectedClipIds];
    if (clipIds.length === 0) {
      setError("エクスポートするクリップを選択してください。");
      return;
    }

    setBusy(
      clipIds.length > 1
        ? `選択クリップを書き出し中… (0/${clipIds.length})`
        : "書き出し中…",
    );
    try {
      for (let i = 0; i < clipIds.length; i++) {
        const clipId = clipIds[i]!;
        const clip = cur.clips.find((c) => c.id === clipId);
        if (!clip) continue;

        setBusy(`選択クリップを書き出し中… (${i + 1}/${clipIds.length})`);
        setClipExportBusyId(clipId);

        const part = clip.parts[0];
        if (!part) throw new Error("クリップに素材がありません。");
        const asset = cur.assets.find((a) => a.id === part.assetId);
        if (!asset) throw new Error("素材が見つかりません。");

        const res = await fetch("/api/jobs/export-segment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            videoId: part.assetId,
            sourceJobId: asset.sourceJobId,
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClipExportBusyId(null);
      setBusy(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }, [history]);

  const downloadSelectedClip = useCallback(async () => {
    await exportSelectedClips();
  }, [exportSelectedClips]);

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

    const factor = Number(speedFactor);
    const sr = Number(sampleRateHz);
    if (!(factor > 0) || !Number.isFinite(factor)) {
      setError("速度係数が不正です。");
      return;
    }
    if (!(sr > 0) || !Number.isFinite(sr)) {
      setError("サンプルレートが不正です。");
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
          sourceJobId: asset.sourceJobId,
          speedFactor: factor,
          sampleRateHz: sr,
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

      const metaRes = await fetch(`/api/jobs/${json.jobId}/metadata`, { cache: "no-store" });
      const metaJson = (await metaRes.json()) as { durationSec?: number; error?: string };
      if (!metaRes.ok || typeof metaJson.durationSec !== "number") {
        throw new Error(metaJson.error ?? "復元後のメタデータ取得に失敗しました。");
      }

      setHistory((h) => {
        const result = dispatchCommand(h, {
          type: "restoreSpeed",
          assetId: asset.id,
          jobId: json.jobId!,
          speedFactor: factor,
          restoredDurationSec: metaJson.durationSec!,
        });
        return result?.history ?? h;
      });

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
          compositionWidth: cur.compositionWidth,
          compositionHeight: cur.compositionHeight,
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
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        void exportSelectedClips();
        return;
      }
      if (mod && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        void exportComposition();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        mergeSelected();
        return;
      }
      if (mod && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      if (mod && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        addTrack();
        return;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (mod && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redoEdit();
      } else if (mod && e.key === "z") {
        e.preventDefault();
        undoEdit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    addTrack,
    deleteSelected,
    duplicateSelected,
    exportComposition,
    exportSelectedClips,
    mergeSelected,
    redoEdit,
    splitAtPlayhead,
    undoEdit,
  ]);

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
    duplicateSelected,
    moveSelectedClip,
    resizeClipDuration,
    updateClipTransform,
    fitSelectedClipsToCanvas,
    setCompositionSize,
    matchCompositionToSelectedClip,
    downloadSelectedClip,
    exportSelectedClips,
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
