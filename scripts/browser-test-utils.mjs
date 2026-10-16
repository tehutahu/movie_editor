/* global fetch, AbortSignal */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
export function verification(name, defaultPort) {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const evidence = path.resolve(process.env.BROWSER_RESULTS_DIR ?? path.join(cwd, "test-results"), name);
    fs.mkdirSync(evidence, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `movie-editor-${name}-`));
    const root = path.join(temporary, "storage");
    const port = Number(process.env.BROWSER_PORT ?? defaultPort);
    assert(Number.isInteger(port) && port > 0 && port < 65536, "valid browser test port");
    const baseURL = `http://127.0.0.1:${port}`;
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    let server;
    let browser;
    const watchdog = setTimeout(() => {
        fs.writeFileSync(path.join(evidence, "failure.txt"), "Browser regression exceeded five minutes");
        cleanup().finally(() => process.exit(1));
    }, 300000);
    watchdog.unref();
    const ff = (args) => execFileSync(ffmpeg, ["-v", "error", ...args], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    async function stop() {
        if (!server)
            return;
        const child = server;
        server = undefined;
        if (child.exitCode !== null || child.signalCode !== null)
            return;
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await Promise.race([exited, delay(5000)]);
            assert(child.exitCode !== null || child.signalCode !== null, "server terminated");
        }
    }
    async function start() {
        // Fail if somebody else owns the port; never test an unrelated server.
        await new Promise((resolve, reject) => {
            const reservation = net.createServer();
            reservation.once("error", reject);
            reservation.listen(port, "127.0.0.1", () => reservation.close(resolve));
        });
        const fd = fs.openSync(path.join(evidence, "production-server.log"), "a");
        server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
            cwd, env: { ...process.env, STORAGE_DRIVER: "local", BLOB_READ_WRITE_TOKEN: "", MOVIE_EDITOR_STORAGE_ROOT: root, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
            stdio: ["ignore", fd, fd],
        });
        fs.closeSync(fd);
        let spawnError;
        server.once("error", (error) => { spawnError = error; });
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (spawnError)
                throw spawnError;
            assert(server.exitCode === null && server.signalCode === null, "owned production server remains alive");
            try {
                const response = await fetch(baseURL, { signal: AbortSignal.timeout(1000) });
                if (response.ok) {
                    await delay(100);
                    assert(server.exitCode === null && server.signalCode === null, "owned production server is ready");
                    return;
                }
            }
            catch { /* Wait for this child to become ready. */ }
            await delay(200);
        }
        throw Error("production server did not become ready");
    }
    async function launch() {
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
        return browser;
    }
    async function cleanup() {
        clearTimeout(watchdog);
        try {
            if (browser)
                await browser.close();
        }
        finally {
            try {
                await stop();
            }
            finally {
                fs.rmSync(temporary, { recursive: true, force: true });
            }
        }
    }
    function verifyExport(file, { width, height, duration, audio = true, source, expectedColour, frequency = 440 } = {}) {
        const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8", timeout: 30000 }));
        fs.writeFileSync(file + ".ffprobe.json", JSON.stringify(probe, null, 2));
        const video = probe.streams.find((s) => s.codec_type === "video");
        assert(video, "export has video");
        if (width)
            assert.equal(video.width, width);
        if (height)
            assert.equal(video.height, height);
        if (duration)
            assert(Math.abs(Number(probe.format.duration) - duration) < 0.15, "export duration");
        if (audio)
            assert(probe.streams.some((s) => s.codec_type === "audio"), "export has audio");
        ff(["-xerror", "-i", file, "-f", "null", "-"]); // Decode every video/audio frame.
        {
            const rgb = ff(["-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "crop=iw/2:ih/2:iw/4:ih/4,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
            // Both suites place their synthetic clip at the default centred scale=1.
            assert.equal(rgb.length, 3);
            assert(Math.max(...rgb) > 60, "export contains visible synthetic source");
            if (expectedColour) for (let channel = 0; channel < 3; channel++)
                assert(Math.abs(rgb[channel] - expectedColour[channel]) < 20, "export matches synthetic image colour");
            if (source) {
                const expected = ff(["-ss", "0.5", "-i", source, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
                for (let channel = 0; channel < 3; channel++)
                    assert(Math.abs(rgb[channel] - expected[channel]) < 15, "export image matches synthetic source");
            }
        }
        if (audio) {
            const pcm = ff(["-ss", "0.5", "-i", file, "-t", "0.2", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
            assert(pcm.length > 1000, "export contains sampled audio");
            let energy = 0;
            for (let i = 0; i < pcm.length; i += 2)
                energy += pcm.readInt16LE(i) ** 2;
            assert(Math.sqrt(energy / (pcm.length / 2)) > 500, "export contains synthetic tone");
            let crossings = 0;
            for (let i = 2; i < pcm.length; i += 2) if ((pcm.readInt16LE(i - 2) < 0) !== (pcm.readInt16LE(i) < 0)) crossings++;
            const measuredHz = crossings / (2 * (pcm.length / 2 / 8000));
            assert(Math.abs(measuredHz - frequency) < frequency * 0.15, "export tone has expected frequency");
        }
        return probe;
    }
    return { evidence, root, baseURL, ff, start, stop, launch, cleanup, verifyExport };
}
