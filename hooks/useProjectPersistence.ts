"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCommandHistory,
  getCurrentProject,
  type CommandHistory,
} from "@/lib/editor/commandHistory";
import {
  parseProjectDocument,
  projectContentKey,
  projectDocumentDraft,
  MAX_PROJECT_JSON_BYTES,
  type ProjectDocument,
} from "@/lib/editor/projectDocument";
import type { EditorProject } from "@/lib/editor/types";

type Revision = { id: string; createdAt: string; name: string };
type Missing = {
  assetId: string;
  displayName: string;
  sha256: string;
  size: number;
};
type Candidate = {
  document: ProjectDocument;
  replacements: Record<string, string>;
  missing: Missing[];
};
export function useProjectPersistence(options: {
  history: CommandHistory;
  setHistory: (h: CommandHistory) => void;
  sessionId: () => string;
  busy: string | null;
  setBusy: (s: string | null) => void;
  setError: (s: string | null) => void;
  onLoaded: () => void;
}) {
  const { history, setHistory, sessionId, busy, setBusy, setError, onLoaded } =
    options;
  const key = projectContentKey(getCurrentProject(history));
  const latestKey = useRef(key);
  latestKey.current = key;
  const [savedKey, setSavedKey] = useState(key);
  const [message, setMessage] = useState("未保存のプロジェクト");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const confirmRef = useRef<
    ((v: "save" | "discard" | "cancel") => void) | null
  >(null);
  const operation = useRef(false);
  const retry = useRef<{
    key: string;
    id: string;
    document: ProjectDocument;
  } | null>(null);
  const dirty = key !== savedKey;
  const refreshProjects = useCallback(async () => {
    const res = await fetch("/api/projects", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    setRevisions(json.projects);
  }, []);
  useEffect(() => {
    void refreshProjects().catch((e) => setError(String(e)));
  }, [refreshProjects, setError]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const saveSnapshot = useCallback(async () => {
    const project = getCurrentProject(history);
    const snapshotKey = projectContentKey(project);
    if (retry.current?.key !== snapshotKey)
      retry.current = {
        key: snapshotKey,
        id: crypto.randomUUID(),
        document: projectDocumentDraft(project),
      };
    const request = retry.current;
    setBusy("プロジェクトを保存中…");
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: request.id, document: request.document }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "保存に失敗しました。");
    setSavedKey(snapshotKey);
    setMessage(`サーバー保存済み (${json.createdAt})`);
    retry.current = null;
    await refreshProjects().catch(() => undefined);
    return latestKey.current === snapshotKey;
  }, [history, setBusy, setError, refreshProjects]);
  const confirmUnsaved = useCallback(async () => {
    if (!dirty) return true;
    setConfirmation(true);
    const choice = await new Promise<"save" | "discard" | "cancel">(
      (resolve) => {
        confirmRef.current = resolve;
      },
    );
    if (choice === "cancel") return false;
    if (choice === "save") return saveSnapshot();
    return true;
  }, [dirty, saveSnapshot]);
  const answerConfirmation = (choice: "save" | "discard" | "cancel") => {
    setConfirmation(false);
    const resolve = confirmRef.current;
    confirmRef.current = null;
    resolve?.(choice);
  };
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      if (operation.current || busy) return;
      operation.current = true;
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessage("操作に失敗しました。編集内容は維持されています。");
      } finally {
        operation.current = false;
        setBusy(null);
      }
    },
    [busy, setError, setBusy],
  );
  const save = () =>
    run(async () => {
      await saveSnapshot();
    });
  const adopt = async (next: Candidate) => {
    setBusy("プロジェクトと素材を検証中…");
    const res = await fetch("/api/projects/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: next.document,
        replacements: next.replacements,
        sessionId: sessionId(),
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      if (json.missing) {
        setCandidate({ ...next, missing: json.missing });
        return;
      }
      throw new Error(json.error);
    }
    const loaded = json.project as EditorProject;
    // Commit once, only after all server checks and durable pinning succeeded.
    onLoaded();
    setHistory(createCommandHistory(loaded));
    setCandidate(null);
    setSavedKey(projectContentKey(loaded));
    setMessage("読み込み済み（停止・位置 0・選択なし）");
    retry.current = null;
  };
  const openDocument = (read: () => Promise<unknown>) =>
    run(async () => {
      setError(null);
      setBusy("プロジェクトを読み込み中…");
      const doc = parseProjectDocument(await read());
      if (!(await confirmUnsaved())) return;
      await adopt({ document: doc, replacements: {}, missing: [] });
    });
  const loadRevision = (id: string) =>
    openDocument(async () => {
      const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      return json;
    });
  const importJson = (file: File) =>
    openDocument(async () => {
      if (file.size > MAX_PROJECT_JSON_BYTES)
        throw new Error("JSON サイズが上限を超えています。");
      return JSON.parse(await file.text());
    });
  const replaceMissing = (assetId: string, file: File) =>
    run(async () => {
      if (!candidate) return;
      setError(null);
      setBusy("再指定素材を検証中…");
      const fd = new FormData();
      fd.append("files", file);
      fd.append("editorSessionId", sessionId());
      const res = await fetch("/api/assets", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await adopt({
        ...candidate,
        replacements: {
          ...candidate.replacements,
          [assetId]: json.assets[0].assetId,
        },
      });
    });
  const removeRevision = (id: string) =>
    run(async () => {
      if (
        !window.confirm(
          "この保存版を削除し、この版による素材保護を解除しますか？ 他の保存版・タブ・ジョブの保護は維持されます。",
        )
      )
        return;
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await refreshProjects();
      setMessage("保存版を削除しました。");
    });
  const download = (id: string) => {
    const a = document.createElement("a");
    a.href = `/api/projects/${id}`;
    a.download = "project.json";
    a.click();
    setMessage(
      "JSON ダウンロードを開始しました（完了はブラウザで確認してください）。",
    );
  };
  return {
    dirty,
    message,
    revisions,
    save,
    loadRevision,
    importJson,
    removeRevision,
    download,
    candidate,
    replaceMissing,
    cancelLoad: () => {
      if (!operation.current) setCandidate(null);
    },
    markDiscarded: (project: EditorProject) =>
      setSavedKey(projectContentKey(project)),
    confirmation,
    answerConfirmation,
    confirmUnsaved,
    locked: confirmation || Boolean(candidate),
  };
}
