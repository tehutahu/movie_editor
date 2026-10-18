import { spawn } from "node:child_process";
/** Always await close (including abort/overflow/timeout) before releasing staging. */
export async function titleChild(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error("タイトル生成を取り消しました。");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "", reason: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => { if (reason) return; reason = error; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); };
    const abort = () => stop(new Error("タイトル生成を取り消しました。"));
    const timeout = setTimeout(() => stop(new Error("タイトル生成が時間切れになりました。")), options.timeout ?? 30000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (chunk: Buffer) => { if (reason) return; if (Buffer.byteLength(text) + chunk.length > 256 * 1024) stop(new Error("タイトル生成の診断出力が上限を超えました。")); else text += chunk.toString("utf8"); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.on("error", error => { reason ??= error; });
    child.on("close", code => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort); if (reason) reject(reason); else if (code !== 0) reject(new Error(`タイトルrenderer終了 ${code}: ${text.slice(-1000)}`)); else resolve(text); });
  });
}
