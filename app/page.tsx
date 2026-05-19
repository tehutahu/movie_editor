"use client";

import { useMemo, useRef, useState } from "react";
import { normalizeRanges, type Range } from "@/lib/validation";

type Metadata = {
  videoId: string;
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
};

type JobStatus = "pending" | "running" | "done" | "error";

type JobInfo = {
  jobId: string;
  kind: string;
  status: JobStatus;
  error?: string | undefined;
  downloadName?: string | undefined;
};

function parseRemoveRangesText(text: string): Range[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const out: Range[] = [];
  for (const line of lines) {
    const jsonTry = line.startsWith("{");
    if (jsonTry) {
      const obj = JSON.parse(line) as { startSec?: unknown; endSec?: unknown };
      out.push({ startSec: Number(obj.startSec), endSec: Number(obj.endSec) });
      continue;
    }
    const m = /^(\d+(?:\.\d+)?)\s*[-~,]\s*(\d+(?:\.\d+)?)$/.exec(line) ?? /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (!m) throw new Error(`削除区間の行を解析できませんでした: "${line}"`);
    out.push({ startSec: Number(m[1]), endSec: Number(m[2]) });
  }
  return out;
}

function toRemoveRangesText(ranges: Range[]): string {
  return ranges.map((r) => `${r.startSec}-${r.endSec}`).join("\n");
}

async function pollJobUntil(jobId: string, opts: { onTick?: (s: JobStatus) => void; timeoutMs?: number } = {}): Promise<JobInfo> {
  const timeoutMs = opts.timeoutMs ?? 1000 * 60 * 60;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error("ジョブの待機がタイムアウトしました。");
    const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    const json = (await res.json()) as { kind?: string; status?: JobStatus; error?: string; downloadName?: string };
    if (!res.ok) throw new Error(json.error ?? "ジョブ取得に失敗しました。");
    const status = json.status ?? "pending";
    opts.onTick?.(status);
    if (status === "done") return { jobId, kind: String(json.kind ?? ""), status, downloadName: json.downloadName };
    if (status === "error") return { jobId, kind: String(json.kind ?? ""), status, error: json.error };
    await new Promise((r) => setTimeout(r, 750));
  }
}

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [speedFactor, setSpeedFactor] = useState<string>("2");
  const [sampleRateHz, setSampleRateHz] = useState<string>("44100");
  const [segStart, setSegStart] = useState<string>("0");
  const [segEnd, setSegEnd] = useState<string>("0");
  const [removeText, setRemoveText] = useState<string>("# 例:\n# 10-20\n# 30.5 40.2\n");
  const [removeRanges, setRemoveRanges] = useState<Range[]>([]);
  const [lastJob, setLastJob] = useState<JobInfo | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);

  const streamUrl = useMemo(() => (videoId ? `/api/videos/${videoId}/stream` : null), [videoId]);
  const removeValidationError = useMemo(() => {
    if (!meta) return "メタデータが未取得です。";
    try {
      const normalized = normalizeRanges(meta.durationSec, removeRanges, { allowEmpty: false });
      const removed = normalized.reduce((a, r) => a + (r.endSec - r.startSec), 0);
      if (removed >= meta.durationSec - 1e-6) return "全区間が削除されるため実行できません。";
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [meta, removeRanges]);

  async function refreshMetadata(nextVideoId: string) { const res = await fetch(`/api/videos/${nextVideoId}/metadata`, { cache: "no-store" }); const json = (await res.json()) as Metadata & { error?: string }; if (!res.ok) throw new Error(json.error ?? "メタデータ取得に失敗しました。"); setMeta(json); setSegStart("0"); setSegEnd(String(json.durationSec)); }
  async function onPickFile(file: File | null) { setError(null); setLastJob(null); setMeta(null); setVideoId(null); setRemoveRanges([]); if (!file) return; setBusy("アップロード中…"); try { const fd = new FormData(); fd.set("file", file); const res = await fetch("/api/videos", { method: "POST", body: fd }); const json = (await res.json()) as { videoId?: string; error?: string }; if (!res.ok) throw new Error(json.error ?? "アップロードに失敗しました。"); if (!json.videoId) throw new Error("videoId が返りませんでした。"); setVideoId(json.videoId); await refreshMetadata(json.videoId); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  const applyCurrentTimeToStart = () => setSegStart(String(videoRef.current?.currentTime ?? 0));
  const applyCurrentTimeToEnd = () => setSegEnd(String(videoRef.current?.currentTime ?? 0));
  const addRangeStart = () => { const t = videoRef.current?.currentTime ?? 0; setRemoveRanges((p) => [...p, { startSec: t, endSec: t }]); };
  const addRangeEnd = () => { const t = videoRef.current?.currentTime ?? 0; setRemoveRanges((p) => p.length === 0 ? [{ startSec: 0, endSec: t }] : p.map((r, i) => i === p.length - 1 ? { ...r, endSec: t } : r)); };
  const updateRange = (idx: number, key: "startSec" | "endSec", val: string) => setRemoveRanges((p) => p.map((r, i) => i === idx ? { ...r, [key]: Number(val) } : r));
  const moveRange = (idx: number, dir: -1 | 1) => setRemoveRanges((p) => { const ni = idx + dir; if (ni < 0 || ni >= p.length) return p; const next = [...p]; [next[idx], next[ni]] = [next[ni]!, next[idx]!]; return next; });
  const removeRange = (idx: number) => setRemoveRanges((p) => p.filter((_, i) => i !== idx));

  async function runMergeKept() {
    setError(null); setLastJob(null);
    if (!videoId) return setError("先に動画をアップロードしてください。");
    if (removeValidationError) return setError(removeValidationError);
    setBusy("結合ジョブ作成中…"); setJobPhase("merge:queued");
    try {
      const uiRanges = meta ? normalizeRanges(meta.durationSec, removeRanges, { allowEmpty: false }) : [];
      const fallbackTextRanges = meta ? normalizeRanges(meta.durationSec, parseRemoveRangesText(removeText), { allowEmpty: true }) : [];
      const payloadRanges = uiRanges.length > 0 ? uiRanges : fallbackTextRanges;
      const res = await fetch("/api/jobs/merge-kept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoId, removeRanges: payloadRanges }) });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");
      const info = await pollJobUntil(json.jobId, { onTick: (s) => setJobPhase(`merge:${s}`) });
      setLastJob(info); if (info.status === "error") throw new Error(info.error ?? "結合に失敗しました。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); setJobPhase(null); }
  }

  return <>
    <h1><span className="badge">local</span>動画編集MVP（速度復元 / 分割 / 削除結合）</h1>
    <section className="panel"><h2>1) 動画アップロード</h2><input id="file" type="file" accept=".mp4,.mkv,.avi,.mov,.flv,.wmv" disabled={Boolean(busy)} onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)} /></section>
    <section className="panel"><h2>2) プレビュー</h2>{streamUrl ? <video ref={videoRef} controls src={streamUrl} /> : null}</section>
    <section className="panel"><h2>4) 分割</h2><button type="button" onClick={applyCurrentTimeToStart}>再生位置→開始</button><button type="button" onClick={applyCurrentTimeToEnd}>再生位置→終了</button></section>
    <section className="panel">
      <h2>5) 「間」を削除して結合</h2>
      <textarea rows={6} value={removeText} disabled={Boolean(busy) || !videoId} onChange={(e) => { setRemoveText(e.target.value); try { setRemoveRanges(parseRemoveRangesText(e.target.value)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }} />
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="secondary" disabled={!videoId || !streamUrl || Boolean(busy)} onClick={addRangeStart}>開始点追加</button>
        <button type="button" className="secondary" disabled={!videoId || !streamUrl || Boolean(busy)} onClick={addRangeEnd}>終了点追加</button>
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setRemoveText(toRemoveRangesText(removeRanges))}>区間→テキスト</button>
      </div>
      <table style={{ width: "100%", marginTop: 10 }}><thead><tr><th>開始</th><th>終了</th><th>長さ</th><th>操作</th></tr></thead><tbody>{removeRanges.map((r, i) => <tr key={`${i}-${r.startSec}-${r.endSec}`}><td><input type="number" step="0.001" value={r.startSec} onChange={(e) => updateRange(i, "startSec", e.target.value)} /></td><td><input type="number" step="0.001" value={r.endSec} onChange={(e) => updateRange(i, "endSec", e.target.value)} /></td><td>{(r.endSec - r.startSec).toFixed(3)}</td><td><button type="button" onClick={() => moveRange(i, -1)}>↑</button><button type="button" onClick={() => moveRange(i, 1)}>↓</button><button type="button" onClick={() => removeRange(i)}>削除</button></td></tr>)}</tbody></table>
      {removeValidationError ? <p className="error">{removeValidationError}</p> : null}
      <button type="button" disabled={Boolean(busy) || !videoId || Boolean(removeValidationError)} style={{ marginTop: 12 }} onClick={() => void runMergeKept()}>結合ジョブを実行（削除適用）</button>
    </section>
  </>;
}
