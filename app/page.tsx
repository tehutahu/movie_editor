"use client";

import { useMemo, useRef, useState } from "react";

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

function parseRemoveRangesText(text: string): { startSec: number; endSec: number }[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const out: { startSec: number; endSec: number }[] = [];
  for (const line of lines) {
    const jsonTry = line.startsWith("{");
    if (jsonTry) {
      const obj = JSON.parse(line) as { startSec?: unknown; endSec?: unknown };
      out.push({
        startSec: Number(obj.startSec),
        endSec: Number(obj.endSec),
      });
      continue;
    }

    const m =
      /^(\d+(?:\.\d+)?)\s*[-~,]\s*(\d+(?:\.\d+)?)$/.exec(line) ??
      /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (!m) {
      throw new Error(`削除区間の行を解析できませんでした: "${line}"`);
    }
    out.push({ startSec: Number(m[1]), endSec: Number(m[2]) });
  }

  return out;
}

async function pollJobUntil(
  jobId: string,
  opts: { onTick?: (s: JobStatus) => void; timeoutMs?: number } = {},
): Promise<JobInfo> {
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
      status?: JobStatus;
      error?: string;
      downloadName?: string;
    };

    if (!res.ok) {
      throw new Error(json.error ?? "ジョブ取得に失敗しました。");
    }

    const status = json.status ?? "pending";
    opts.onTick?.(status);

    if (status === "done") {
      return {
        jobId,
        kind: String(json.kind ?? ""),
        status,
        downloadName: json.downloadName,
      };
    }
    if (status === "error") {
      return {
        jobId,
        kind: String(json.kind ?? ""),
        status,
        error: json.error,
      };
    }

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

  const [lastJob, setLastJob] = useState<JobInfo | null>(null);
  const [jobPhase, setJobPhase] = useState<string | null>(null);

  const streamUrl = useMemo(() => {
    if (!videoId) return null;
    return `/api/videos/${videoId}/stream`;
  }, [videoId]);

  const outputPreviewUrl = useMemo(() => {
    if (!lastJob || lastJob.status !== "done") return null;
    return `/api/jobs/${lastJob.jobId}/stream`;
  }, [lastJob]);

  async function refreshMetadata(nextVideoId: string) {
    const res = await fetch(`/api/videos/${nextVideoId}/metadata`, { cache: "no-store" });
    const json = (await res.json()) as Metadata & { error?: string };
    if (!res.ok) throw new Error(json.error ?? "メタデータ取得に失敗しました。");
    setMeta(json);
    setSegStart("0");
    setSegEnd(String(json.durationSec));
  }

  async function onPickFile(file: File | null) {
    setError(null);
    setLastJob(null);
    setMeta(null);
    setVideoId(null);
    if (!file) return;

    setBusy("アップロード中…");
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/videos", { method: "POST", body: fd });
      const json = (await res.json()) as { videoId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "アップロードに失敗しました。");
      if (!json.videoId) throw new Error("videoId が返りませんでした。");

      setVideoId(json.videoId);
      await refreshMetadata(json.videoId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function applyCurrentTimeToStart() {
    const t = videoRef.current?.currentTime ?? 0;
    setSegStart(String(t));
  }

  function applyCurrentTimeToEnd() {
    const t = videoRef.current?.currentTime ?? 0;
    setSegEnd(String(t));
  }

  async function runRestore() {
    setError(null);
    setLastJob(null);
    if (!videoId) {
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
          videoId,
          speedFactor: Number(speedFactor),
          sampleRateHz: Number(sampleRateHz),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (s) => setJobPhase(`restore:${s}`),
      });
      setLastJob(info);
      if (info.status === "error") throw new Error(info.error ?? "復元に失敗しました。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setJobPhase(null);
    }
  }

  async function runExportSegment() {
    setError(null);
    setLastJob(null);
    if (!videoId) {
      setError("先に動画をアップロードしてください。");
      return;
    }

    setBusy("区間書き出しジョブ作成中…");
    setJobPhase("segment:queued");
    try {
      const res = await fetch("/api/jobs/export-segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId,
          startSec: Number(segStart),
          endSec: Number(segEnd),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (s) => setJobPhase(`segment:${s}`),
      });
      setLastJob(info);
      if (info.status === "error") throw new Error(info.error ?? "区間書き出しに失敗しました。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setJobPhase(null);
    }
  }

  async function runMergeKept() {
    setError(null);
    setLastJob(null);
    if (!videoId) {
      setError("先に動画をアップロードしてください。");
      return;
    }

    setBusy("結合ジョブ作成中…");
    setJobPhase("merge:queued");
    try {
      const removeRanges = parseRemoveRangesText(removeText);
      const res = await fetch("/api/jobs/merge-kept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, removeRanges }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "ジョブ作成に失敗しました。");
      if (!json.jobId) throw new Error("jobId が返りませんでした。");

      const info = await pollJobUntil(json.jobId, {
        onTick: (s) => setJobPhase(`merge:${s}`),
      });
      setLastJob(info);
      if (info.status === "error") throw new Error(info.error ?? "結合に失敗しました。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setJobPhase(null);
    }
  }

  const downloadHref =
    lastJob?.status === "done" ? `/api/download/${lastJob.jobId}` : null;

  return (
    <>
      <h1>
        <span className="badge">local</span>
        動画編集MVP（速度復元 / 分割 / 削除結合）
      </h1>
      <p className="muted">
        アップロードした動画に対して、<code>restore_speed.sh</code> と同じ ffmpeg
        フィルタによる速度・音程の復元、区間書き出し、削除区間指定後の結合ができます。処理は{" "}
        <strong>ローカルの ffmpeg/ffprobe</strong> で行われます。
      </p>

      <section className="panel">
        <h2>1) 動画アップロード</h2>
        <label htmlFor="file">ファイル（mp4/mkv/avi/mov/flv/wmv）</label>
        <input
          id="file"
          type="file"
          accept=".mp4,.mkv,.avi,.mov,.flv,.wmv"
          disabled={Boolean(busy)}
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        <p className="muted" style={{ marginTop: 10 }}>
          大きなファイルは環境側のボディサイズ上限に依存します。問題があれば入力動画を小さめに試してください。
        </p>

        {videoId ? (
          <p className="ok" style={{ marginTop: 10 }}>
            videoId: <code>{videoId}</code>
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>2) プレビュー</h2>
        {!streamUrl ? (
          <p className="muted">アップロード後に表示されます。</p>
        ) : (
          <>
            <video ref={videoRef} controls src={streamUrl} />
            {meta ? (
              <p className="muted" style={{ marginTop: 10 }}>
                長さ: <code>{meta.durationSec.toFixed(3)}</code>s / 音声:{" "}
                <code>{meta.hasAudio ? "あり" : "なし"}</code>
                {meta.width && meta.height ? (
                  <>
                    {" "}
                    / 解像度:{" "}
                    <code>
                      {meta.width}x{meta.height}
                    </code>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>3) 速度・音程の復元（restore_speed と同等）</h2>
        <p className="muted">
          映像は <code>setpts=S*PTS</code>、音声は{" "}
          <code>asetrate=SR/S,aresample=SR</code> で復元します（S=速度係数）。
        </p>
        <div className="row">
          <div>
            <label htmlFor="speed">速度係数（S）</label>
            <input
              id="speed"
              type="number"
              step="0.01"
              min="0.01"
              value={speedFactor}
              disabled={Boolean(busy) || !videoId}
              onChange={(e) => setSpeedFactor(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sr">音声サンプルレート SR（Hz）</label>
            <input
              id="sr"
              type="number"
              step="1"
              min="1"
              value={sampleRateHz}
              disabled={Boolean(busy) || !videoId}
              onChange={(e) => setSampleRateHz(e.target.value)}
            />
          </div>
        </div>
        <button
          type="button"
          disabled={Boolean(busy) || !videoId}
          style={{ marginTop: 12 }}
          onClick={() => void runRestore()}
        >
          復元ジョブを実行
        </button>
      </section>

      <section className="panel">
        <h2>4) 分割（指定区間を別ファイルへ書き出し）</h2>
        <div className="row">
          <div>
            <label htmlFor="segS">開始（秒）</label>
            <input
              id="segS"
              type="number"
              step="0.001"
              min="0"
              value={segStart}
              disabled={Boolean(busy) || !videoId}
              onChange={(e) => setSegStart(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="segE">終了（秒）</label>
            <input
              id="segE"
              type="number"
              step="0.001"
              min="0"
              value={segEnd}
              disabled={Boolean(busy) || !videoId}
              onChange={(e) => setSegEnd(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="secondary"
            disabled={!videoId || !streamUrl || Boolean(busy)}
            onClick={applyCurrentTimeToStart}
          >
            再生位置→開始
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!videoId || !streamUrl || Boolean(busy)}
            onClick={applyCurrentTimeToEnd}
          >
            再生位置→終了
          </button>
        </div>
        <button
          type="button"
          disabled={Boolean(busy) || !videoId}
          style={{ marginTop: 12 }}
          onClick={() => void runExportSegment()}
        >
          区間書き出しジョブを実行
        </button>
      </section>

      <section className="panel">
        <h2>5) 「間」を削除して結合</h2>
        <p className="muted">削除する区間を秒で複数指定し、それ以外をその順で結合します。</p>
        <label htmlFor="remove">
          削除区間（各行: <code>start-end</code> または <code>start end</code>）
        </label>
        <textarea
          id="remove"
          rows={8}
          value={removeText}
          disabled={Boolean(busy) || !videoId}
          onChange={(e) => setRemoveText(e.target.value)}
          spellCheck={false}
        />

        <button
          type="button"
          disabled={Boolean(busy) || !videoId}
          style={{ marginTop: 12 }}
          onClick={() => void runMergeKept()}
        >
          結合ジョブを実行（削除適用）
        </button>
      </section>

      <section className="panel">
        <h2>6) ジョブ状態 / プレビュー / ダウンロード</h2>
        {busy ? <p className="muted">{busy}</p> : null}
        {jobPhase ? (
          <p className="muted">
            phase: <code>{jobPhase}</code>
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}

        {lastJob ? (
          <>
            <p className={lastJob.status === "done" ? "ok" : "error"}>
              jobId: <code>{lastJob.jobId}</code> / status:{" "}
              <code>{lastJob.status}</code>
              {lastJob.downloadName ? (
                <>
                  {" "}
                  / name: <code>{lastJob.downloadName}</code>
                </>
              ) : null}
              {lastJob.error ? (
                <>
                  <br />
                  error: <code>{lastJob.error}</code>
                </>
              ) : null}
            </p>
            {outputPreviewUrl ? (
              <div style={{ marginTop: 14 }}>
                <p className="muted" style={{ marginBottom: 8 }}>
                  成果プレビュー（ブラウザ内再生）
                </p>
                <video key={lastJob.jobId} controls src={outputPreviewUrl} />
              </div>
            ) : null}
            {downloadHref ? (
              <p style={{ marginTop: 10 }}>
                <a href={downloadHref} download>
                  <button type="button">成果物をダウンロード</button>
                </a>
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted">まだ実行結果がありません。</p>
        )}
      </section>
    </>
  );
}
