"use client";
import { assetHasAudioFade, matchesAudioFadeSnapshot, mergedAudioFade, type AudioFadeSnapshot } from "@/lib/editor/clipAudioFade";

import { isMediaClip } from "@/lib/editor/types";
import { validateTitleText, titleDescriptor, matchesTitleEditSnapshot, type TitleEditSnapshot } from "@/lib/editor/title";
import { requestTitleRaster } from "@/lib/editor/titleRasterClient";

import { useRestoreInputAudio } from "@/hooks/useRestoreInputAudio";
import { matchesClipAudioSnapshot, mergedAudioGain, type ClipAudioSnapshot } from "@/lib/editor/clipAudio";
import { matchesGroupMoveSnapshot, type GroupMoveSnapshot } from "@/lib/editor/moveClips";
import { applyExactSeek } from "@/lib/editor/exactSeek";
import { applyClipBoundaryNavigation, clipBoundaryTarget, type ClipBoundaryDirection } from "@/lib/editor/clipBoundaryNavigation";
import { applyMoveSelectionToPlayhead, moveToPlayheadSnapshot } from "@/lib/editor/moveSelectionToPlayhead";
import { applyContentDuration, contentDurationSnapshot } from "@/lib/editor/contentDuration";
import { useMoveToPlayheadCapture } from "@/hooks/useMoveToPlayheadCapture";
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
  updateEditorView,
  type CommandHistory,
} from "@/lib/editor/commandHistory";
import { matchesTrimEndSnapshot, type TrimEndSnapshot } from "@/lib/editor/trimClipEnd";
import { matchesTrimStartSnapshot, type TrimStartSnapshot } from "@/lib/editor/trimClipStart";
import { newId } from "@/lib/newId";
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
import { validateBrowserMediaLayouts } from "@/lib/editor/mediaLayoutClient";
import type { AppliedJobStep, Asset, ClipLayoutMode, ClipTransform, EditorProject } from "@/lib/editor/types";
import { storageReferences } from "@/lib/editor/storageReferences";
import { useProjectPersistence } from "@/hooks/useProjectPersistence";
import { selectedClipExportRequest } from "@/lib/editor/selectedClipExport";
import { matchesRestoreSource, parseRestoreResultMetadata, restoreSource } from "@/lib/editor/restoreResult";

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
  const moveToPlayheadCapture = useMoveToPlayheadCapture();
  const [history, setHistory] = useState<CommandHistory>(() =>
    createCommandHistory(createEmptyProject()),
  );
  const latestHistoryRef = useRef(history);
  latestHistoryRef.current = history;
  const [busy, setBusy] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveJob, setLiveJob] = useState<JobPollInfo | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);
  const [appliedJobSteps, setAppliedJobSteps] = useState<AppliedJobStep[]>([]);
  const [pendingRestores, setPendingRestores] = useState<{
    clientId: string; epoch: number; assetId: string; jobId: string; clipId: string;
  }[]>([]);
  const [speedFactor, setSpeedFactor] = useState("2");
  const [sampleRateHz, setSampleRateHzState] = useState("44100");
  const restoreSubmissionRef = useRef(false);
  const [restoreHelpBlocked, setRestoreHelpBlockedState] = useState(false);
  const restoreHelpBlockedRef = useRef(false);
  const setRestoreHelpBlocked = useCallback((value: boolean) => {
    restoreHelpBlockedRef.current = value;
    setRestoreHelpBlockedState(value);
  }, []);
  const speedFactorRef = useRef(speedFactor);
  speedFactorRef.current = speedFactor;
  const sampleRateRef = useRef(sampleRateHz);
  sampleRateRef.current = sampleRateHz;
  const copySampleRate = useCallback((value: string) => { sampleRateRef.current = value; setSampleRateHzState(value); }, []);
  const [timelineZoom, setTimelineZoomState] = useState(1);
  const timelineZoomRef = useRef(timelineZoom);
  timelineZoomRef.current = timelineZoom;
  const setTimelineZoom = useCallback((next: number | ((previous: number) => number)) => {
    const value = typeof next === "function" ? next(timelineZoomRef.current) : next;
    timelineZoomRef.current = value;
    setTimelineZoomState(value);
  }, []);
  const [clipExportBusyId, setClipExportBusyId] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const sessionId = useCallback(() => sessionRef.current ??= crypto.randomUUID(), []);
  const protectReferences = useCallback(async (keepIds: string[]) => {
    const res = await fetch("/api/storage/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "protect", sessionId: sessionId(), keepIds }),
    });
    if (!res.ok) { const json = await res.json(); throw new Error(json.error ?? "素材の保護に失敗しました。"); }
  }, [sessionId]);
  const referenceKey = JSON.stringify(storageReferences(history).sort());
  useEffect(() => {
    void protectReferences(JSON.parse(referenceKey)).catch(e => setStorageWarning(String(e)));
  }, [referenceKey, protectReferences]);

  const audioVideoRef = useRef<HTMLVideoElement | null>(null);

  const project = useMemo(() => getCurrentProject(history), [history]);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const projectEpochRef = useRef(0);
  const latestProjectRef = useRef(project);
  latestProjectRef.current = project;
  const persistence = useProjectPersistence({ history, setHistory, sessionId, busy, setBusy, setError,
    onLoaded: () => { projectEpochRef.current += 1; audioVideoRef.current?.pause(); setPendingRestores([]); setAppliedJobSteps([]); setLiveJob(null); setJobPhase(null); setProjectEpoch(v => v + 1); },
  });
  const assetAddBlockedRef = useRef(false);
  assetAddBlockedRef.current = Boolean(busy) || persistence.locked;
  const [pendingAssetAddition, setPendingAssetAddition] = useState<{ clipId: string; epoch: number } | null>(null);
  const [assetAdditionNotice, setAssetAdditionNotice] = useState<{ clipId: string; trackId: string; trackOrder: number; startSec: number; epoch: number; text: string } | null>(null);
  useEffect(() => {
    if (!pendingAssetAddition) return;
    if (pendingAssetAddition.epoch === projectEpochRef.current) {
      const clip = project.clips.find((candidate) => candidate.id === pendingAssetAddition.clipId);
      const track = project.tracks.find((candidate) => candidate.id === clip?.trackId);
      if (clip && track) setAssetAdditionNotice({ clipId: clip.id, trackId: track.id, trackOrder: track.order, startSec: clip.timelineStartSec,
        epoch: pendingAssetAddition.epoch, text: `T${track.order + 1}の${Number(clip.timelineStartSec.toFixed(3))}秒へ追加しました。` });
    }
    setPendingAssetAddition(null);
  }, [pendingAssetAddition, project]);
  const addAssetAtPlayhead = useCallback((assetId: string) => {
    if (assetAddBlockedRef.current) return;
    const clipId = newId();
    setAssetAdditionNotice(null);
    setPendingAssetAddition({ clipId, epoch: projectEpochRef.current });
    setHistory((current) => {
      if (assetAddBlockedRef.current) return current;
      return dispatchCommand(current, { type: "addAssetAtPlayhead", assetId, clipId })?.history ?? current;
    });
  }, []);

  const mutationLockedRef = useRef(false);
  mutationLockedRef.current = Boolean(busy) || persistence.locked;
  // Help's existing setter updates its ref in the opening/closing event, so
  // window listeners never wait for a render/effect to adopt the modal scope.
  const areEditorShortcutsBlocked = useCallback(() =>
    mutationLockedRef.current || restoreHelpBlockedRef.current, []);
  const getRestoreInputState = useCallback(() => ({ project: latestProjectRef.current, epoch: projectEpochRef.current, blocked: mutationLockedRef.current || restoreSubmissionRef.current || restoreHelpBlockedRef.current }), []);
  const restoreInputAudio = useRestoreInputAudio(project, projectEpoch, Boolean(busy) || persistence.locked || restoreHelpBlocked, getRestoreInputState, copySampleRate);
  const setSampleRateHz = (value: string) => { if (mutationLockedRef.current || restoreSubmissionRef.current || restoreHelpBlockedRef.current) return; restoreInputAudio.manualEdit(); copySampleRate(value); };
  // Record success only after the history commit adopted this exact result.
  // Updaters stay pure, and a stale result never creates a completed step.
  useEffect(() => {
    if (pendingRestores.length === 0) return;
    const adopted = pendingRestores.filter((pending) =>
      pending.epoch === projectEpochRef.current && project.assets.some((asset) =>
        asset.id === pending.assetId && asset.sourceJobId === pending.jobId &&
        asset.streamUrl === `/api/jobs/${pending.jobId}/stream`));
    if (adopted.length) {
      setAppliedJobSteps((previous) => {
        const seen = new Set(previous.map((step) => step.jobId));
        const next = [...previous];
        for (const pending of adopted) {
          if (seen.has(pending.jobId)) continue;
          seen.add(pending.jobId);
          next.push({ clientId: pending.clientId, kind: "restore", jobId: pending.jobId,
            clipId: pending.clipId, status: "done" });
        }
        return next.length === previous.length ? previous : next;
      });
    }
    if (adopted.length !== pendingRestores.length) {
      setError("速度復元の対象が変更されたため、結果を適用しませんでした。");
    }
    const completed = new Set(pendingRestores.map((pending) => pending.clientId));
    setPendingRestores((current) => current.filter((pending) => !completed.has(pending.clientId)));
  }, [pendingRestores, project]);
  const finishRef = useRef(false);
  const finishEditing = useCallback(async () => {
    if (finishRef.current || busy || persistence.locked) return;
    finishRef.current = true;
    try {
      if (!await persistence.confirmUnsaved()) return;
      if (!window.confirm("現在の編集内容・素材一覧・Undo/Redo履歴を破棄し、このタブの素材保護を解放します。よろしいですか？")) return;
      // Discard references before releasing them. A failed release retains files.
      setBusy("素材の保護を解放中…");
      const empty = createEmptyProject();
      persistence.markDiscarded(empty);
      setHistory(createCommandHistory(empty));
      const res = await fetch("/api/storage/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", sessionId: sessionId() }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "素材解放に失敗しました。");
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      finishRef.current = false;
      setBusy(null);
    }
  }, [sessionId, busy, persistence]);


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
      return updateEditorView(h, { playheadSec: clamped });
    });
  }, []);

  const getPreviewSeekState = useCallback(() => ({
    epoch: projectEpochRef.current,
    duration: latestProjectRef.current.compositionDurationSec,
    blocked: areEditorShortcutsBlocked(),
  }), [areEditorShortcutsBlocked]);

  const setExactPlayheadSec = useCallback((target: number, expectedEpoch: number) => {
    setHistory(current => applyExactSeek(current, target, expectedEpoch,
      projectEpochRef.current, areEditorShortcutsBlocked()));
  }, [areEditorShortcutsBlocked]);

  const getClipBoundaryNavigationState = useCallback((direction: ClipBoundaryDirection) => ({
    epoch: projectEpochRef.current,
    blocked: areEditorShortcutsBlocked(),
    target: clipBoundaryTarget(latestProjectRef.current, direction),
  }), [areEditorShortcutsBlocked]);

  const jumpClipBoundary = useCallback((direction: ClipBoundaryDirection, expectedEpoch: number) => {
    setHistory(current => applyClipBoundaryNavigation(current, direction, expectedEpoch,
      projectEpochRef.current, areEditorShortcutsBlocked()));
  }, [areEditorShortcutsBlocked]);

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
      return updateEditorView(h, { selectedClipIds: selected });
    });
  }, []);

  const clearSelection = useCallback(() => {
    setHistory((h) => {
      const cur = getCurrentProject(h);
      if (cur.selectedClipIds.length === 0) return h;
      return updateEditorView(h, { selectedClipIds: [] });
    });
  }, []);

  const uploadAssets = useCallback(async (files: FileList | File[]) => {
    setError(null);
    setBusy("アップロード中…");
    // The input clears its live FileList as soon as this handler yields.
    const list = Array.from(files);
    try {
      await protectReferences(storageReferences(history));
      const fd = new FormData();
      fd.append("editorSessionId", sessionId());
      for (const f of list) fd.append("files", f);

      const res = await fetch("/api/assets", { method: "POST", body: fd });
      const json = (await res.json()) as {
        warning?: string;
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

      setStorageWarning(json.warning ?? null);
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
  }, [history, protectReferences, sessionId]);

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

  const deleteEmptyTrack = useCallback((trackId: string): EditorProject | null => {
    if (mutationLockedRef.current) return null;
    const snapshot = latestHistoryRef.current;
    const result = dispatchCommand(snapshot, { type: "deleteEmptyTrack", trackId });
    if (!result) return null;
    // Recheck the actual queued history: intervening edits/loads cannot adopt
    // a deletion computed for an obsolete project or reuse a T-number as ID.
    setHistory(h => h === snapshot && !mutationLockedRef.current ? result.history : h);
    return result.project;
  }, []);

  const trimSelectedStartAtPlayhead = useCallback((snapshot: TrimStartSnapshot | null) => {
    if (!snapshot || mutationLockedRef.current) return;
    setHistory(current => {
      const cur = getCurrentProject(current);
      if (mutationLockedRef.current || !matchesTrimStartSnapshot(cur, projectEpochRef.current, snapshot)) return current;
      return dispatchCommand(current, { type: "trimStart", clipId: snapshot.clipId, atSec: cur.playheadSec })?.history ?? current;
    });
  }, []);

  const trimSelectedEndAtPlayhead = useCallback((snapshot: TrimEndSnapshot | null) => {
    if (!snapshot || areEditorShortcutsBlocked()) return;
    setHistory(current => {
      const cur = getCurrentProject(current);
      if (areEditorShortcutsBlocked() || !matchesTrimEndSnapshot(cur, projectEpochRef.current, snapshot)) return current;
      return dispatchCommand(current, { type: "trimEnd", clipId: snapshot.clipId, atSec: cur.playheadSec })?.history ?? current;
    });
  }, [areEditorShortcutsBlocked]);

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
    const selectedClips = cur.clips.filter(c => cur.selectedClipIds.includes(c.id)).sort((a,b)=>a.timelineStartSec-b.timelineStartSec);
    if (mergedAudioGain(cur, selectedClips) === null) {
      setError("動画を含むクリップの音量を揃えてから結合してください。");
      return;
    }
    if (selectedClips.every(isMediaClip) && !mergedAudioFade(selectedClips).allowed) {
      setError("フェードが連続していません。各クリップのフェードを解除してから結合してください。");
      return;
    }
    setError(null);
    setHistory((h) => {
      const result = dispatchCommand(h, { type: "merge", clipIds: cur.selectedClipIds });
      if (!result) {
        setError("結合できませんでした。同一トラック上で配置モードを揃えて選択してください。");
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

  const moveSelectedClips = useCallback((snapshot: GroupMoveSnapshot, deltaSec: number) => {
    if (areEditorShortcutsBlocked()) return;
    setHistory(h => {
      const current = getCurrentProject(h);
      if (areEditorShortcutsBlocked() || !matchesGroupMoveSnapshot(current, projectEpochRef.current, timelineZoomRef.current, snapshot)) return h;
      return dispatchCommand(h, { type: "moveMany", clipIds: snapshot.clipIds, deltaSec })?.history ?? h;
    });
  }, [areEditorShortcutsBlocked]);

  const moveSelectionToPlayhead = useCallback(() => {
    if (areEditorShortcutsBlocked() || moveToPlayheadCapture.isActive()) return;
    const snapshot = moveToPlayheadSnapshot(latestHistoryRef.current, projectEpochRef.current);
    setHistory(current => applyMoveSelectionToPlayhead(current, snapshot, projectEpochRef.current,
      areEditorShortcutsBlocked(), moveToPlayheadCapture.isActive()));
  }, [areEditorShortcutsBlocked, moveToPlayheadCapture.isActive]);

  const fitContentDuration = useCallback((ownerStopped: () => boolean) => {
    if (!ownerStopped() || areEditorShortcutsBlocked() || moveToPlayheadCapture.isActive()) return;
    const snapshot = contentDurationSnapshot(latestHistoryRef.current, projectEpochRef.current);
    setHistory(current => applyContentDuration(current, snapshot, projectEpochRef.current,
      !ownerStopped() || areEditorShortcutsBlocked() || moveToPlayheadCapture.isActive()));
  }, [areEditorShortcutsBlocked, moveToPlayheadCapture.isActive]);

  const setSelectedAudioGain = useCallback((snapshot: ClipAudioSnapshot, gain: number) => {
    if (areEditorShortcutsBlocked()) return;
    setHistory(h => {
      const current = getCurrentProject(h);
      if (current.clips.some(c=>current.selectedClipIds.includes(c.id)&&!isMediaClip(c))) return h;
      if (areEditorShortcutsBlocked() || !matchesClipAudioSnapshot(current, projectEpochRef.current, snapshot)) return h;
      return dispatchCommand(h, { type: "audioGain", clipIds: snapshot.clipIds, gain })?.history ?? h;
    });
  }, [areEditorShortcutsBlocked]);

  const setSelectedAudioFade = useCallback((snapshot: AudioFadeSnapshot, input: {inSec:number;outSec:number} | null) => {
    if (areEditorShortcutsBlocked()) return;
    setHistory(h => {
      const current = getCurrentProject(h);
      if (areEditorShortcutsBlocked() || !matchesAudioFadeSnapshot(current, projectEpochRef.current, snapshot)) return h;
      return dispatchCommand(h, input ? {type:"audioFade",clipId:snapshot.id,...input} : {type:"clearAudioFade",clipId:snapshot.id})?.history ?? h;
    });
  }, [areEditorShortcutsBlocked]);

  const titleRequestRef=useRef<AbortController|null>(null);
  useEffect(()=>()=>{titleRequestRef.current?.abort();},[projectEpoch]);
  const preflightTitle=useCallback(async(text:string,current:EditorProject)=>{
    titleRequestRef.current?.abort();const controller=new AbortController();titleRequestRef.current=controller;
    const response=await requestTitleRaster(titleDescriptor(text),current.compositionWidth,current.compositionHeight,controller.signal);
    if(!response.ok){const json=await response.json();throw new Error(json.error??"タイトル生成に失敗しました。");}
    await response.body?.cancel();
    return controller;
  },[]);
  const addTitleClip=useCallback(async()=>{
    if(areEditorShortcutsBlocked())return;
    const source=latestHistoryRef.current,epoch=projectEpochRef.current,result=dispatchCommand(source,{type:"addTitle",id:newId(),text:"タイトル"});
    if(!result){setError("タイトルを追加できません。前面トラック・上限20トラック/100クリップ・再生位置を確認してください。");return;}
    try{const request=await preflightTitle("タイトル",getCurrentProject(source));
      if(request.signal.aborted)return;
      setError(null);setHistory(h=>h===source&&epoch===projectEpochRef.current&&!areEditorShortcutsBlocked()&&!request.signal.aborted?result.history:h);
    }catch(e){if(epoch===projectEpochRef.current&&latestHistoryRef.current===source)setError(e instanceof Error?e.message:String(e));}
  },[areEditorShortcutsBlocked,preflightTitle]);
  const applyTitleText=useCallback(async(snapshot:TitleEditSnapshot,raw:string)=>{
    if(areEditorShortcutsBlocked())return;
    let text:string;try{text=validateTitleText(raw);}catch(e){setError(e instanceof Error?e.message:String(e));return;}
    const current=latestProjectRef.current;if(!matchesTitleEditSnapshot(current,projectEpochRef.current,snapshot))return;
    const old=current.clips.find(c=>c.id===snapshot.id);if(old?.kind==="title"&&old.text===text)return;
    try{const request=await preflightTitle(text,current);if(request.signal.aborted)return;
      setHistory(h=>{const latest=getCurrentProject(h);if(request.signal.aborted||areEditorShortcutsBlocked()||!matchesTitleEditSnapshot(latest,projectEpochRef.current,snapshot))return h;return dispatchCommand(h,{type:"titleText",clipId:snapshot.id,text})?.history??h;});
    }catch(e){if(matchesTitleEditSnapshot(latestProjectRef.current,projectEpochRef.current,snapshot))setError(e instanceof Error?e.message:String(e));}
  },[areEditorShortcutsBlocked,preflightTitle]);

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

  const [layoutChecking, setLayoutChecking] = useState(false);
  const setSelectedLayoutMode = useCallback(async (layoutMode: ClipLayoutMode) => {
    const snapshot = latestProjectRef.current;
    const snapshotHistory = latestHistoryRef.current;
    const ids = [...snapshot.selectedClipIds];
    if (snapshot.clips.some(c => ids.includes(c.id) && !isMediaClip(c))) return;
    if (!ids.length || !snapshot.clips.some(c => ids.includes(c.id) && (c.layoutMode ?? "stretch") !== layoutMode)) return;
    const epoch = projectEpochRef.current;
    setError(null);
    try {
      if (layoutMode === "contain") {
        setLayoutChecking(true);
        const assetIds = new Set(snapshot.clips.filter(isMediaClip).filter(c => ids.includes(c.id)).flatMap(c => c.parts.map(p => p.assetId)));
        await validateBrowserMediaLayouts(snapshot.assets.filter(a => assetIds.has(a.id)));
      }
      setHistory(h => {
        if (projectEpochRef.current !== epoch || h !== snapshotHistory || getCurrentProject(h) !== snapshot) return h;
        return dispatchCommand(h, { type: "layoutMode", clipIds: ids, layoutMode })?.history ?? h;
      });
    } catch (e) { if (projectEpochRef.current === epoch && latestHistoryRef.current === snapshotHistory && latestProjectRef.current === snapshot) setError(e instanceof Error ? e.message : String(e)); }
    finally { setLayoutChecking(false); }
  }, []);

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
          ids.has(c.id) ? { ...c, transform: c.kind==="title"?{x:.5,y:.5,scale:1}:{ ...fit } } : c,
        ),
      };
      return { undoStack: [...h.undoStack, next], redoStack: [] };
    });
  }, []);

  const setCompositionSize = useCallback(async(width: number, height: number) => {
    const source=latestHistoryRef.current,current=getCurrentProject(source),epoch=projectEpochRef.current;
    if(current.clips.some(c=>c.kind==="title")){
      if(areEditorShortcutsBlocked()||(current.compositionWidth===width&&current.compositionHeight===height))return;
      try{
        let request:AbortController|undefined;
        const texts=[...new Set(current.clips.filter(c=>c.kind==="title").map(c=>c.text))];
        for(const text of texts){
          try{request=await preflightTitle(text,{...current,compositionWidth:width,compositionHeight:height});}
          catch(e){if(e instanceof Error&&e.name==="AbortError")return;throw new Error(`タイトル「${text.split("\n")[0].slice(0,30)}」: ${e instanceof Error?e.message:String(e)}`);}
          if(request.signal.aborted||latestHistoryRef.current!==source||projectEpochRef.current!==epoch||areEditorShortcutsBlocked())return;
        }
        setError(null);setHistory(h=>h===source&&projectEpochRef.current===epoch&&!areEditorShortcutsBlocked()&&!request?.signal.aborted?{undoStack:[...h.undoStack,{...current,compositionWidth:width,compositionHeight:height}],redoStack:[]}:h);
      }catch(e){if(projectEpochRef.current===epoch&&latestHistoryRef.current===source)setError(e instanceof Error?e.message:String(e));}
      return;
    }
    setHistory((h) => {
      const cur = getCurrentProject(h);
      if (cur.compositionWidth === width && cur.compositionHeight === height) return h;
      const next: EditorProject = { ...cur, compositionWidth: width, compositionHeight: height };
      return { undoStack: [...h.undoStack, next], redoStack: [] };
    });
  }, [areEditorShortcutsBlocked,preflightTitle]);

  const matchCompositionToSelectedClip = useCallback(() => {
    setError(null);
    const source=latestProjectRef.current;
    if(source.clips.some(c=>c.kind==="title")){
      const clip=source.clips.find(c=>c.id===source.selectedClipIds[0]);
      if(!clip||!isMediaClip(clip)){setError("解像度を合わせる素材クリップを選択してください。");return;}
      const asset=findAsset(source.assets,clip.parts[0]?.assetId??"");
      if(!asset?.width||!asset.height){setError("選択クリップの素材解像度が不明です。");return;}
      const size=compositionSizeFromAsset(asset.width,asset.height);void setCompositionSize(size.width,size.height);return;
    }
    setHistory((h) => {
      const cur = getCurrentProject(h);
      const selectedId = cur.selectedClipIds[0];
      if (!selectedId) {
        setError("素材に合わせるクリップを選択してください。");
        return h;
      }
      const clip = cur.clips.find((c) => c.id === selectedId);
      if (!clip) return h;
      const asset = findAsset(cur.assets, clip.parts?.[0]?.assetId ?? "");
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
  }, [setCompositionSize]);

  const exportSelectedClips = useCallback(async () => {
    setError(null);
    const cur = getCurrentProject(history);
    const clipIds = [...cur.selectedClipIds];
    if (clipIds.length === 0) {
      setError("エクスポートするクリップを選択してください。");
      return;
    }

    if (cur.clips.some(c => clipIds.includes(c.id) && !isMediaClip(c))) { setError("タイトルを含む選択では素材DLできません。全体書き出しを使用してください。"); return; }
    setBusy(
      clipIds.length > 1
        ? `選択クリップを書き出し中… (0/${clipIds.length})`
        : "書き出し中…",
    );
    try {
      await protectReferences(storageReferences(history));
      for (let i = 0; i < clipIds.length; i++) {
        const clipId = clipIds[i]!;
        const clip = cur.clips.find((c) => c.id === clipId);
        if (!clip) continue;

        setBusy(`選択クリップを書き出し中… (${i + 1}/${clipIds.length})`);
        setClipExportBusyId(clipId);

        const request = selectedClipExportRequest(cur, clip);
        const res = await fetch(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request.body, editorSessionId: sessionId() }),
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
  }, [history, protectReferences, sessionId]);

  const downloadSelectedClip = useCallback(async () => {
    await exportSelectedClips();
  }, [exportSelectedClips]);

  const restoreSpeedForSelected = useCallback(async () => {
    if (mutationLockedRef.current || restoreSubmissionRef.current) return;
    setError(null);
    const snapshotHistory = latestHistoryRef.current;
    const cur = getCurrentProject(snapshotHistory);
    if (cur.clips.some(c => cur.selectedClipIds.includes(c.id) && !isMediaClip(c))) { setError("タイトルは速度復元できません。"); return; }
    const clipId = cur.selectedClipIds[0];
    if (!clipId) {
      setError("速度復元する動画クリップを選択してください。");
      return;
    }
    const clip = cur.clips.find((c) => c.id === clipId);
    const asset = cur.assets.find((a) => a.id === clip?.parts?.[0]?.assetId);
    if (!clip || !asset || asset.kind !== "video") {
      setError("動画クリップを選択してください。");
      return;
    }

    const factor = Number(speedFactorRef.current);
    const sr = Number(sampleRateRef.current);
    if (!(factor > 0) || !Number.isFinite(factor)) {
      setError("速度係数が不正です。");
      return;
    }
    if (!(sr > 0) || !Number.isFinite(sr)) {
      setError("サンプルレートが不正です。");
      return;
    }

    if (assetHasAudioFade(cur, asset.id)) { setError("該当clipのフェードを解除してから復元してください。"); return; }
    const source = restoreSource(asset);
    const epoch = projectEpochRef.current;
    const sourceStillCurrent = (p: EditorProject) =>
      projectEpochRef.current === epoch && matchesRestoreSource(p, source) && !assetHasAudioFade(p, asset.id);

    restoreSubmissionRef.current = true;
    setBusy("速度復元中…");
    setJobPhase("restore:queued");
    try {
      await protectReferences(storageReferences(snapshotHistory));
      const res = await fetch("/api/jobs/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          editorSessionId: sessionId(),
          videoId: asset.storageAssetId ?? asset.id,
          sourceJobId: asset.sourceJobId,
          speedFactor: factor,
          sampleRateHz: sr,
          exportBaseName: sanitizeExportBaseName(cur.exportBaseName),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成失敗");
      if (typeof json.jobId !== "string" || !json.jobId) throw new Error("jobId がありません。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (j) => {
          setLiveJob(j);
          setJobPhase(`restore:${j.status}`);
        },
      });
      if (info.status === "error") throw new Error(info.error ?? "復元失敗");
      if (info.status !== "done" || info.jobId !== json.jobId || info.kind !== "restore") {
        throw new Error("速度復元ジョブの結果が一致しません。");
      }

      const metaRes = await fetch(`/api/jobs/${json.jobId}/metadata`, { cache: "no-store" });
      const metaJson: unknown = await metaRes.json();
      if (!metaRes.ok) {
        const message = metaJson && typeof metaJson === "object" && "error" in metaJson ? metaJson.error : null;
        throw new Error(typeof message === "string" ? message : "復元後のメタデータ取得に失敗しました。");
      }
      const restored = parseRestoreResultMetadata(metaJson, json.jobId);
      if (!sourceStillCurrent(latestProjectRef.current)) {
        throw new Error("速度復元の対象が変更されたため、結果を適用しませんでした。");
      }

      // Calculate in this caught boundary: validation failures must not throw from a React updater.
      const snapshot = latestHistoryRef.current;
      if (!sourceStillCurrent(getCurrentProject(snapshot))) {
        throw new Error("速度復元の対象が変更されたため、結果を適用しませんでした。");
      }
      const result = dispatchCommand(snapshot, {
        type: "restoreSpeed",
        assetId: asset.id,
        jobId: json.jobId!,
        speedFactor: factor,
        ...restored,
      });
      setHistory(h => h === snapshot && sourceStillCurrent(getCurrentProject(h)) ? result?.history ?? h : h);

      const pending = { clientId: crypto.randomUUID(), epoch, assetId: asset.id, jobId: json.jobId, clipId };
      setPendingRestores((previous) => [...previous, pending]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      restoreSubmissionRef.current = false;
      setBusy(null);
      setLiveJob(null);
      setJobPhase(null);
    }
  }, [history, speedFactor, sampleRateHz, protectReferences, sessionId]);

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
      await protectReferences(storageReferences(history));
      const res = await fetch("/api/jobs/export-composition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          editorSessionId: sessionId(),
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
  }, [history, protectReferences, sessionId]);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function onKeyDown(e: KeyboardEvent) {
      if (areEditorShortcutsBlocked()) return;
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
      if (mod && (e.key === "z" || e.key === "Z") && e.shiftKey) {
        e.preventDefault();
        redoEdit();
      } else if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undoEdit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    areEditorShortcutsBlocked,
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
    persistence, projectEpoch, getPreviewSeekState, setExactPlayheadSec, getClipBoundaryNavigationState, jumpClipBoundary, areEditorShortcutsBlocked,
    fitContentDuration, moveSelectionToPlayhead, moveToPlayheadCaptureActive: moveToPlayheadCapture.active,
    project,
    busy,
    error,
    storageWarning,
    finishEditing,
    liveJob,
    jobPhase,
    appliedJobSteps,
    speedFactor,
    setSpeedFactor,
    sampleRateHz,
    setSampleRateHz,
    restoreInputAudio,
    restoreHelpBlocked, setRestoreHelpBlocked,
    timelineZoom,
    setTimelineZoom,
    clipExportBusyId,
    audioVideoRef,
    canUndoEdit: canUndo(history),
    canRedoEdit: canRedo(history),
    uploadAssets,
    addClipFromAsset,
    addAssetAtPlayhead,
    assetAdditionStatus: assetAdditionNotice?.epoch === projectEpoch && project.tracks.some(track =>
      track.id === assetAdditionNotice.trackId && track.order === assetAdditionNotice.trackOrder) && project.clips.some(clip =>
      clip.id === assetAdditionNotice.clipId && clip.trackId === assetAdditionNotice.trackId &&
      clip.timelineStartSec === assetAdditionNotice.startSec) ? assetAdditionNotice.text : "",
    addTrack,
    deleteEmptyTrack,
    trimSelectedStartAtPlayhead,
    trimSelectedEndAtPlayhead,
    splitAtPlayhead,
    mergeSelected,
    deleteSelected,
    duplicateSelected,
    moveSelectedClip,
    moveSelectedClips,
    setSelectedAudioGain, setSelectedAudioFade,
    addTitleClip,applyTitleText,
    resizeClipDuration,
    updateClipTransform,
    fitSelectedClipsToCanvas,
    layoutChecking, setSelectedLayoutMode,
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
