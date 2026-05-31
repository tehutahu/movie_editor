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
  buildSegmentsFromMarkers,
  segmentsToRemoveRanges,
  type Segment,
} from "@/lib/segments";

export type PreviewMeta = {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
};

export type AppliedStep = {
  clientId: string;
  kind: "restore" | "merge_kept";
  jobId: string;
  status: "running" | "done" | "error";
};

export type CurrentSource =
  | { type: "upload"; videoId: string }
  | { type: "job"; jobId: string };

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
    const json = (await res.json()) as {
      jobId?: string;
      kind?: string;
      status?: JobPollInfo["status"];
      error?: string;
      downloadName?: string;
      progressPct?: number;
      etaSec?: number;
      currentStep?: string;
    };

    if (!res.ok) {
      throw new Error(json.error ?? "ジョブ取得に失敗しました。");
    }

    const status = json.status ?? "pending";
    const info: JobPollInfo = {
      jobId,
      kind: String(json.kind ?? ""),
      status,
      error: json.error,
      downloadName: json.downloadName,
      progressPct: typeof json.progressPct === "number" ? json.progressPct : undefined,
      etaSec: typeof json.etaSec === "number" ? json.etaSec : undefined,
      currentStep: typeof json.currentStep === "string" ? json.currentStep : undefined,
    };
    opts.onTick?.(info);

    if (status === "done" || status === "error") {
      return info;
    }

    await new Promise((r) => setTimeout(r, 750));
  }
}

function uniqSortedMarkers(markers: readonly number[]): number[] {
  const EPS = 1e-4;
  const seen = new Set<string>();
  const out: number[] = [];
  for (const m of markers) {
    if (!Number.isFinite(m)) continue;
    const key = String(Math.round(m * 1000) / 1000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  out.sort((a, b) => a - b);

  const deduped: number[] = [];
  for (const x of out) {
    const last = deduped[deduped.length - 1];
    if (typeof last === "number" && Math.abs(last - x) < EPS) continue;
    deduped.push(x);
  }
  return deduped;
}

async function requestStoragePrune(keepIds: string[]): Promise<void> {
  try {
    await fetch("/api/storage/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepIds }),
      cache: "no-store",
    });
  } catch {
    // ベストエフォート
  }
}

function collectKeepIds(baseVideoId: string | null, steps: AppliedStep[]): string[] {
  const set = new Set<string>();
  if (baseVideoId) set.add(baseVideoId);
  for (const st of steps) {
    if (st.status === "done") set.add(st.jobId);
  }
  return [...set];
}

export function useEditorState() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [baseVideoId, setBaseVideoId] = useState<string | null>(null);
  const [videoDisplayName, setVideoDisplayName] = useState("");
  const [uploadExt, setUploadExt] = useState("mp4");
  const [currentSource, setCurrentSource] = useState<CurrentSource | null>(null);
  const [appliedSteps, setAppliedSteps] = useState<AppliedStep[]>([]);
  const appliedStepsRef = useRef(appliedSteps);
  /** 同一 videoId のメタデータ再取得で表示名を上書きしない */
  const loadedDisplayNameForVideoIdRef = useRef<string | null>(null);

  useEffect(() => {
    appliedStepsRef.current = appliedSteps;
  }, [appliedSteps]);

  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);

  const [speedFactor, setSpeedFactor] = useState<string>("2");
  const [sampleRateHz, setSampleRateHz] = useState<string>("44100");

  const [markers, setMarkers] = useState<number[]>([]);
  const [deletedSegmentIds, setDeletedSegmentIds] = useState<Set<string>>(() => new Set());

  const [liveJob, setLiveJob] = useState<JobPollInfo | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);
  /** セグメント個別書き出し中の論理セグメント id（UI ロック用） */
  const [segmentExportBusySegmentId, setSegmentExportBusySegmentId] = useState<string | null>(
    null,
  );

  const previewSrc = useMemo(() => {
    if (!currentSource) return null;
    if (currentSource.type === "upload") {
      return `/api/videos/${currentSource.videoId}/stream`;
    }
    return `/api/jobs/${currentSource.jobId}/stream`;
  }, [currentSource]);

  const currentDownloadFilename = useMemo(() => {
    const base = sanitizeExportBaseName(videoDisplayName);
    if (!currentSource) return null;

    if (currentSource.type === "upload") {
      return buildDownloadFilename(base, "", uploadExt);
    }

    const last = appliedSteps[appliedSteps.length - 1];
    if (!last) return buildDownloadFilename(base, "", "mp4");
    if (last.kind === "restore") {
      const speed = Number(speedFactor);
      const sr = Number(sampleRateHz);
      if (!Number.isFinite(speed) || !Number.isFinite(sr)) {
        return buildDownloadFilename(base, "restored", "mp4");
      }
      return buildDownloadFilename(base, `restored_${speed}x_${sr}hz`, "mp4");
    }
    if (last.kind === "merge_kept") {
      return buildDownloadFilename(base, "merged", "mp4");
    }
    return buildDownloadFilename(base, "", "mp4");
  }, [
    appliedSteps,
    currentSource,
    speedFactor,
    sampleRateHz,
    uploadExt,
    videoDisplayName,
  ]);

  const exportHref = useMemo(() => {
    if (!currentSource || !currentDownloadFilename) return null;
    const q = `downloadName=${encodeURIComponent(currentDownloadFilename)}`;
    if (currentSource.type === "upload") {
      return `/api/videos/${currentSource.videoId}/download?${q}`;
    }
    return `/api/download/${currentSource.jobId}?${q}`;
  }, [currentDownloadFilename, currentSource]);

  const segments = useMemo((): Segment[] => {
    if (!meta) return [];
    return buildSegmentsFromMarkers(meta.durationSec, markers);
  }, [meta, markers]);

  const refreshMeta = useCallback(async (src: CurrentSource) => {
    if (src.type === "upload") {
      const res = await fetch(`/api/videos/${src.videoId}/metadata`, { cache: "no-store" });
      const json = (await res.json()) as PreviewMeta & {
        error?: string;
        displayName?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "メタデータ取得に失敗しました。");
      setMeta(json);
      if (loadedDisplayNameForVideoIdRef.current !== src.videoId) {
        loadedDisplayNameForVideoIdRef.current = src.videoId;
        if (typeof json.displayName === "string" && json.displayName.trim()) {
          setVideoDisplayName(json.displayName);
        }
      }
      return;
    }

    const res = await fetch(`/api/jobs/${src.jobId}/metadata`, { cache: "no-store" });
    const json = (await res.json()) as PreviewMeta & { error?: string; jobId?: string };
    if (!res.ok) throw new Error(json.error ?? "ジョブメタデータ取得に失敗しました。");
    setMeta({
      durationSec: json.durationSec,
      width: json.width,
      height: json.height,
      hasAudio: json.hasAudio,
      hasVideo: json.hasVideo,
    });
  }, []);

  useEffect(() => {
    if (!currentSource) return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshMeta(currentSource);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSource, refreshMeta]);

  const resetTimelineEditing = useCallback(() => {
    setMarkers([]);
    setDeletedSegmentIds(new Set());
    setCurrentTimeSec(0);
  }, []);

  useEffect(() => {
    resetTimelineEditing();
  }, [
    resetTimelineEditing,
    currentSource?.type,
    currentSource?.type === "upload" ? currentSource.videoId : "",
    currentSource?.type === "job" ? currentSource.jobId : "",
  ]);

  useEffect(() => {
    setDeletedSegmentIds(new Set());
  }, [markers]);

  const sourceJobIdForJobChain = useMemo(() => {
    if (!currentSource || currentSource.type !== "job") return undefined;
    return currentSource.jobId;
  }, [currentSource]);

  async function onPickFile(file: File | null) {
    setError(null);
    setAppliedSteps([]);
    appliedStepsRef.current = [];
    setMeta(null);
    setBaseVideoId(null);
    setVideoDisplayName("");
    setUploadExt("mp4");
    loadedDisplayNameForVideoIdRef.current = null;
    setCurrentSource(null);
    if (!file) return;

    setBusy("アップロード中…");
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/videos", { method: "POST", body: fd });
      const json = (await res.json()) as {
        videoId?: string;
        originalName?: string;
        displayName?: string;
        ext?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "アップロードに失敗しました。");
      if (!json.videoId) throw new Error("videoId が返りませんでした。");

      const name =
        typeof json.displayName === "string" && json.displayName.trim()
          ? json.displayName
          : displayNameFromOriginalFilename(file.name);
      setVideoDisplayName(name);
      setUploadExt(typeof json.ext === "string" && json.ext ? json.ext : "mp4");
      loadedDisplayNameForVideoIdRef.current = json.videoId;

      setBaseVideoId(json.videoId);
      const src: CurrentSource = { type: "upload", videoId: json.videoId };
      setCurrentSource(src);
      await requestStoragePrune([json.videoId]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function finalizeSuccessfulJob(kind: AppliedStep["kind"], jobId: string) {
    if (!baseVideoId) return;

    const step: AppliedStep = {
      clientId: crypto.randomUUID(),
      kind,
      jobId,
      status: "done",
    };

    const prev = appliedStepsRef.current;
    const nextSteps = [...prev, step];

    setAppliedSteps(nextSteps);
    appliedStepsRef.current = nextSteps;

    const nextSource: CurrentSource = { type: "job", jobId };
    setCurrentSource(nextSource);
    await requestStoragePrune(collectKeepIds(baseVideoId, nextSteps));
  }

  async function runRestore() {
    setError(null);
    if (!baseVideoId || !currentSource) {
      setError("先に動画をアップロードしてください。");
      return;
    }

    setBusy("速度復元ジョブ作成中…");
    setJobPhase("restore:queued");
    try {
      const res = await fetch("/api/jobs/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: baseVideoId,
          sourceJobId: sourceJobIdForJobChain,
          speedFactor: Number(speedFactor),
          sampleRateHz: Number(sampleRateHz),
          exportBaseName: sanitizeExportBaseName(videoDisplayName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setJobPhase(`restore:${j.status}`);
          setLiveJob(j);
        },
      });

      if (info.status === "error") throw new Error(info.error ?? "復元に失敗しました。");
      await finalizeSuccessfulJob("restore", json.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setJobPhase(null);
      setLiveJob(null);
    }
  }

  /** 分割点により複数セグメントがある場合、各区間をジョブで書き出してダウンロードします（編集スタックは変えません）。 */
  async function downloadSegmentExport(segment: Segment) {
    setError(null);
    if (!baseVideoId || !currentSource || !meta) {
      setError("先に動画を読み込んでください。");
      return;
    }
    setSegmentExportBusySegmentId(segment.id);
    try {
      const res = await fetch("/api/jobs/export-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: baseVideoId,
          sourceJobId: sourceJobIdForJobChain,
          startSec: segment.startSec,
          endSec: segment.endSec,
          exportBaseName: sanitizeExportBaseName(videoDisplayName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "区間書き出しジョブの作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setLiveJob(j);
          setJobPhase(`segment-download:${j.status}`);
        },
      });

      if (info.status === "error") throw new Error(info.error ?? "区間書き出しに失敗しました。");

      await requestStoragePrune(collectKeepIds(baseVideoId, appliedStepsRef.current));

      const segmentFilename = buildDownloadFilename(
        sanitizeExportBaseName(videoDisplayName),
        `segment_${segment.startSec}-${segment.endSec}`,
        "mp4",
      );
      const a = document.createElement("a");
      a.href = `/api/download/${json.jobId}?downloadName=${encodeURIComponent(segmentFilename)}`;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSegmentExportBusySegmentId(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }

  async function runMergeKept() {
    setError(null);
    if (!baseVideoId || !currentSource || !meta) {
      setError("タイムラインの準備ができていません。");
      return;
    }

    const removeRanges = segmentsToRemoveRanges(deletedSegmentIds, segments);
    if (removeRanges.length === 0) {
      setError("削除するセグメントを1つ以上選んでください。");
      return;
    }

    setBusy("結合ジョブ作成中…");
    setJobPhase("merge:queued");
    try {
      const res = await fetch("/api/jobs/merge-kept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: baseVideoId,
          sourceJobId: sourceJobIdForJobChain,
          removeRanges,
          exportBaseName: sanitizeExportBaseName(videoDisplayName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setJobPhase(`merge:${j.status}`);
          setLiveJob(j);
        },
      });

      if (info.status === "error") throw new Error(info.error ?? "結合に失敗しました。");
      await finalizeSuccessfulJob("merge_kept", json.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setJobPhase(null);
      setLiveJob(null);
    }
  }

  function undoLastStep() {
    setError(null);
    if (!baseVideoId) return;
    if (appliedStepsRef.current.length === 0) return;

    const nextSteps = appliedStepsRef.current.slice(0, -1);
    appliedStepsRef.current = nextSteps;
    setAppliedSteps(nextSteps);

    const last = nextSteps[nextSteps.length - 1];
    const src: CurrentSource = last
      ? { type: "job", jobId: last.jobId }
      : { type: "upload", videoId: baseVideoId };
    setCurrentSource(src);
    void requestStoragePrune(collectKeepIds(baseVideoId, nextSteps));
  }

  function seekPreview(sec: number) {
    const el = videoRef.current;
    if (!el || !meta) return;
    const clamped = Math.max(0, Math.min(sec, meta.durationSec));
    el.currentTime = clamped;
    setCurrentTimeSec(clamped);
  }

  function addSplitAtCurrentTime() {
    if (!meta) return;
    const raw = videoRef.current?.currentTime ?? currentTimeSec;
    const t = Math.max(0, Math.min(raw, meta.durationSec));
    setMarkers((prev) => uniqSortedMarkers([...prev, t]));
  }

  function removeMarkerAtTime(timeSec: number) {
    const EPS = 1e-4;
    setMarkers((prev) => uniqSortedMarkers(prev.filter((m) => Math.abs(m - timeSec) >= EPS)));
  }

  function toggleSegmentDeleted(id: string) {
    setDeletedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return {
    videoRef,
    busy,
    error,
    baseVideoId,
    videoDisplayName,
    setVideoDisplayName,
    currentDownloadFilename,
    currentSource,
    appliedSteps,
    meta,
    currentTimeSec,
    setCurrentTimeSec,
    speedFactor,
    setSpeedFactor,
    sampleRateHz,
    setSampleRateHz,
    markers,
    deletedSegmentIds,
    segments,
    previewSrc,
    exportHref,
    liveJob,
    jobPhase,
    segmentExportBusySegmentId,
    onPickFile,
    runRestore,
    runMergeKept,
    undoLastStep,
    seekPreview,
    addSplitAtCurrentTime,
    removeMarkerAtTime,
    toggleSegmentDeleted,
    downloadSegmentExport,
    canUndo: appliedSteps.length > 0,
    hasUpload: Boolean(baseVideoId),
  };
}

export type EditorController = ReturnType<typeof useEditorState>;
