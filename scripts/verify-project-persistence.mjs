// Optional manual browser verification. See README.md for setup.
/* global document, DataTransfer, DragEvent, fetch */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
const loadOptionalModule = createRequire(import.meta.url);
const { chromium } = loadOptionalModule(
  process.env.MOVIE_EDITOR_PLAYWRIGHT_MODULE || "playwright",
);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(scriptDirectory, ".."),
  evidence = fs.mkdtempSync(
    path.join(os.tmpdir(), "movie-editor-project-e2e-"),
  ),
  root = path.join(evidence, "storage");
console.log("Evidence:", evidence);
execFileSync(
  "/usr/bin/ffmpeg",
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    evidence + "/source.mp4",
  ],
  { stdio: "ignore" },
);
for (const ext of ["png", "jpg"]) {
  execFileSync(
    "/usr/bin/ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=160x120",
      "-frames:v",
      "1",
      `${evidence}/still.${ext}`,
    ],
    { stdio: "ignore" },
  );
}
let server, browser;
const log = [];
function ok(message) {
  log.push(message);
  console.log("PASS", message);
  fs.writeFileSync(
    evidence + "/e2e-results.json",
    JSON.stringify(log, null, 2),
  );
}
async function start() {
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "-H",
      "127.0.0.1",
      "-p",
      "3000",
    ],
    {
      cwd,
      env: {
        ...process.env,
        STORAGE_DRIVER: "local",
        BLOB_READ_WRITE_TOKEN: "",
        MOVIE_EDITOR_STORAGE_ROOT: root,
        FFMPEG_PATH: "/usr/bin/ffmpeg",
        FFPROBE_PATH: "/usr/bin/ffprobe",
      },
      stdio: [
        "ignore",
        fs.openSync(evidence + "/production-server.log", "a"),
        fs.openSync(evidence + "/production-server.log", "a"),
      ],
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3000")).ok) return;
    } catch {
      /* Wait for the server to accept connections. */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("server not ready");
}
async function stop() {
  if (server) {
    const child = server;
    const done = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await done;
    server = null;
  }
}
async function json(url, body, method = "POST") {
  const res = await fetch("http://127.0.0.1:3000" + url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  return { status: res.status, data };
}
async function waitIdle(page) {
  await page.waitForFunction(
    () => !document.querySelector(".busy-banner"),
    {},
    { timeout: 120000 },
  );
  const errors = await page.locator(".error-banner").allTextContents();
  assert.deepEqual(errors, []);
}
(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await start();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", (e) => runtimeErrors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto("http://127.0.0.1:3000");
  await page
    .locator(".asset-upload-btn input")
    .setInputFiles(evidence + "/source.mp4");
  await page.waitForSelector(".asset-card");
  await waitIdle(page);
  await page.evaluate(() => {
    const a = document.querySelector(".asset-card"),
      row = document.querySelector(".timeline-track-row");
    const dt = new DataTransfer();
    a.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }),
    );
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        dataTransfer: dt,
        clientX: rect.left + 48,
        clientY: rect.top + 20,
      }),
    );
  });
  await page.waitForSelector(".timeline-clip");
  await page.locator(".timeline-clip").click({ position: { x: 20, y: 20 } });
  await page.getByTitle("選択中クリップの素材解像度に合わせる").click();
  await page.getByRole("button", { name: "速度復元", exact: true }).click();
  await waitIdle(page);
  assert.match(
    await page.locator(".asset-card video").getAttribute("src"),
    /api\/jobs/,
  );
  ok(
    "UI upload, timeline placement, 1920x1440 composition and real ffmpeg speed restore",
  );
  await page.locator(".timeline-ruler").click({ position: { x: 208, y: 10 } });
  await page.getByTitle("分割 (Ctrl+X)", { exact: true }).click();
  assert.equal(await page.locator(".timeline-clip").count(), 2);
  await page.getByTitle("結合 (Ctrl+M)", { exact: true }).click();
  assert.equal(await page.locator(".timeline-clip").count(), 1);
  ok("UI split and join retain two source parts");
  let loseSaveResult = true;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST" && loseSaveResult) {
      loseSaveResult = false;
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "新しい保存版を保存" }).click();
  await page.waitForSelector(".error-banner");
  await page.waitForFunction(() => !document.querySelector(".busy-banner"));
  assert.equal(
    await page.locator(".project-persistence strong").innerText(),
    "未保存の変更あり",
  );
  assert.equal(await page.locator(".timeline-clip").count(), 1);
  ok(
    "Lost save response reports failure without discarding edits or marking them saved",
  );
  await page
    .getByRole("button", { name: "新しい保存版を保存" })
    .evaluate((el) => {
      el.click();
      el.click();
    });
  await waitIdle(page);
  await page.unroute("**/api/projects");
  let versions = (await json("/api/projects", null, "GET")).data.projects;
  assert.equal(versions.length, 1);
  const v1 = versions[0].id;
  const doc1 = (await json("/api/projects/" + v1, null, "GET")).data;
  assert.equal(doc1.project.clips[0].parts.length, 2);
  assert.equal(doc1.project.assets[0].media.kind, "job");
  assert.equal(doc1.project.compositionWidth, 1920);
  ok(
    "Double save click creates one durable immutable version with restored-output SHA-256",
  );
  await page.getByText("サーバーの保存版 (1)", { exact: true }).click();
  const dlPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON ダウンロード" }).click();
  const dl = await dlPromise;
  await dl.saveAs(evidence + "/project-v1.json");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(evidence + "/project-v1.json", "utf8")),
    doc1,
  );
  ok("Downloaded JSON equals the server saved document");
  await page.locator(".timeline-clip").click({ position: { x: 30, y: 20 } });
  await page.locator(".timeline-ruler").click({ position: { x: 100, y: 10 } });
  assert.equal(
    await page.locator(".project-persistence strong").innerText(),
    "変更なし",
  );
  await page.locator("#export-base-name").fill("version two");
  await page.getByRole("button", { name: "新しい保存版を保存" }).click();
  await waitIdle(page);
  versions = (await json("/api/projects", null, "GET")).data.projects;
  assert.equal(versions.length, 2);
  ok(
    "Selection/playhead remain clean; name change is dirty; new save retains old revision",
  );
  await page
    .getByRole("button", { name: "編集終了・素材解放", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".asset-card").length === 0,
  );
  await page.waitForLoadState("networkidle");
  const physical = doc1.project.assets[0].media.id;
  assert.ok(fs.existsSync(root + "/jobs/" + physical));
  ok("End editing releases tab state while saved media survives");
  await stop();
  await start();
  await page.reload();
  await page.getByText("サーバーの保存版 (2)", { exact: true }).click();
  await page
    .locator(".project-revision")
    .first()
    .getByRole("button", { name: "読み込み", exact: true })
    .click();
  await waitIdle(page);
  await page.waitForSelector(".timeline-clip");
  assert.ok(
    await page.getByTitle("Undo (Ctrl+Z)", { exact: true }).isDisabled(),
  );
  assert.equal(await page.locator(".timeline-clip--selected").count(), 0);
  assert.match(
    await page.locator(".timeline-toolbar-center").innerText(),
    /^0:00.00/,
  );
  assert.equal(
    (await json("/api/jobs/" + physical + "/metadata", null, "GET")).status,
    200,
  );
  ok(
    "Actual server restart loads joined restored media at position zero with no selection and fresh history",
  );
  const exportDownload = page.waitForEvent("download", { timeout: 120000 });
  await page.getByTitle("全体書き出し (Ctrl+E)", { exact: true }).click();
  const exported = await exportDownload;
  await exported.saveAs(evidence + "/roundtrip.mp4");
  await waitIdle(page);
  const probe = JSON.parse(
    execFileSync(
      "/usr/bin/ffprobe",
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        evidence + "/roundtrip.mp4",
      ],
      { encoding: "utf8" },
    ),
  );
  fs.writeFileSync(
    evidence + "/roundtrip-ffprobe.json",
    JSON.stringify(probe, null, 2),
  );
  assert.equal(probe.streams.find((s) => s.codec_type === "video").width, 1920);
  assert.ok(Number(probe.format.duration) >= 4);
  ok(
    "Required save → end editing → restart → load → real ffmpeg export completed and ffprobe verified",
  );
  // Existing edit and Undo history survive malformed JSON and all cancellation paths.
  await page.locator(".timeline-clip").click({ position: { x: 20, y: 20 } });
  await page.getByTitle("複製 (Ctrl+D)", { exact: true }).click();
  assert.equal(await page.locator(".timeline-clip").count(), 2);
  await page.getByLabel("JSON を読み込み", { exact: true }).setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{bad"),
  });
  await page.waitForSelector(".error-banner");
  assert.equal(await page.locator(".timeline-clip").count(), 2);
  assert.ok(
    await page.getByTitle("Undo (Ctrl+Z)", { exact: true }).isEnabled(),
  );
  ok("Malformed JSON preserves the current edit and Undo history");
  await page
    .locator(".project-revision")
    .first()
    .getByRole("button", { name: "読み込み", exact: true })
    .click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.equal(await page.locator(".timeline-clip").count(), 2);
  ok("Unsaved changes cancel preserves existing edit/history");
  // Save branch of unsaved confirmation.
  await page
    .locator(".project-revision")
    .first()
    .getByRole("button", { name: "読み込み", exact: true })
    .click();
  await page
    .getByRole("button", { name: "保存して続ける", exact: true })
    .click();
  await waitIdle(page);
  assert.equal(await page.locator(".timeline-clip").count(), 1);
  assert.equal(
    (await json("/api/projects", null, "GET")).data.projects.length,
    3,
  );
  ok("Unsaved changes save creates another immutable version before adoption");
  // Use restored artifact itself as exact-byte replacement, never the original source.
  const meta = JSON.parse(
    fs.readFileSync(root + "/jobs/" + physical + "/meta.json", "utf8"),
  );
  await fsp.copyFile(meta.outputPath, evidence + "/restored-copy.mp4");
  await fsp.rm(root + "/jobs/" + physical, { recursive: true });
  await page.locator("#export-base-name").fill("keep on cancel");
  await page
    .getByLabel("JSON を読み込み", { exact: true })
    .setInputFiles(evidence + "/project-v1.json");
  await page
    .getByRole("button", { name: "破棄して続ける", exact: true })
    .click();
  await page.getByRole("dialog", { name: "欠損素材の再指定" }).waitFor();
  assert.equal(
    await page.locator("#export-base-name").inputValue(),
    "keep on cancel",
  );
  await page.getByRole("button", { name: "読み込みをキャンセル" }).click();
  assert.equal(
    await page.locator("#export-base-name").inputValue(),
    "keep on cancel",
  );
  ok("Missing-media candidate and cancellation preserve the existing edit");
  await page
    .getByLabel("JSON を読み込み", { exact: true })
    .setInputFiles(evidence + "/project-v1.json");
  await page
    .getByRole("button", { name: "破棄して続ける", exact: true })
    .click();
  await page.getByRole("dialog", { name: "欠損素材の再指定" }).waitFor();
  const replace = page
    .getByRole("dialog", { name: "欠損素材の再指定" })
    .locator("input[type=file]");
  await replace.setInputFiles(evidence + "/source.mp4");
  await page.waitForFunction(() => !document.querySelector(".busy-banner"));
  assert.ok(
    await page.getByRole("dialog", { name: "欠損素材の再指定" }).isVisible(),
  );
  assert.equal(
    await page.locator("#export-base-name").inputValue(),
    "keep on cancel",
  );
  ok("Wrong bytes (original pre-restore movie) are rejected during relink");
  await replace.setInputFiles(evidence + "/restored-copy.mp4");
  await waitIdle(page);
  await page
    .getByRole("dialog", { name: "欠損素材の再指定" })
    .waitFor({ state: "detached" });
  assert.equal(
    await page.locator("#export-base-name").inputValue(),
    doc1.project.exportBaseName,
  );
  assert.match(
    await page.locator(".asset-card video").getAttribute("src"),
    /api\/assets/,
  );
  ok(
    "Exact restored bytes relink successfully while preserving logical clip asset IDs",
  );
  const dl2Promise = page.waitForEvent("download", { timeout: 120000 });
  await page.getByTitle("全体書き出し (Ctrl+E)", { exact: true }).click();
  await (await dl2Promise).saveAs(evidence + "/relinked.mp4");
  await waitIdle(page);
  ok(
    "Relinked logical IDs resolve through physical upload references during real export",
  );
  // Two browser tabs share source; deleting one revision cannot clear the other tab or old version references.
  await page.getByRole("button", { name: "新しい保存版を保存" }).click();
  await waitIdle(page);
  const latest = (await json("/api/projects", null, "GET")).data.projects.at(
    -1,
  );
  const stable = (await json("/api/projects/" + latest.id, null, "GET")).data;
  const sourceId = stable.project.assets[0].media.id;
  const tab2 = await context.newPage();
  tab2.on("dialog", (d) => d.accept());
  await tab2.goto("http://127.0.0.1:3000");
  await tab2.getByText(/サーバーの保存版/).click();
  await tab2
    .locator(".project-revision")
    .last()
    .getByRole("button", { name: "読み込み", exact: true })
    .click();
  await waitIdle(tab2);
  await tab2.waitForSelector(".timeline-clip");
  await json("/api/projects/" + latest.id, null, "DELETE");
  await page
    .getByRole("button", { name: "編集終了・素材解放", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".asset-card").length === 0,
  );
  assert.ok(fs.existsSync(root + "/uploads/" + sourceId + "/input.mp4"));
  ok(
    "Other browser tab keeps relinked media protected after version deletion and first-tab release",
  );
  await page.screenshot({ path: evidence + "/completed.png", fullPage: true });
  await tab2.screenshot({
    path: evidence + "/loaded-relinked.png",
    fullPage: true,
  });
  // Images must not require a video duration. Exercise an uncertain save that
  // another tab deletes before the original tab retries it.
  const images = await context.newPage();
  images.on("dialog", (d) => d.accept());
  images.on("pageerror", (e) => runtimeErrors.push(e.message));
  await images.goto("http://127.0.0.1:3000");
  await images
    .locator(".asset-upload-btn input")
    .setInputFiles([`${evidence}/still.png`, `${evidence}/still.jpg`]);
  await images.waitForFunction(
    () => document.querySelectorAll(".asset-card").length === 2,
  );
  await waitIdle(images);
  let deletedSaveId;
  await images.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST" && !deletedSaveId) {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      deletedSaveId = (await response.json()).id;
      await route.abort("failed");
    } else await route.continue();
  });
  await images.getByRole("button", { name: "新しい保存版を保存" }).click();
  await images.waitForSelector(".error-banner");
  await images.waitForFunction(() => !document.querySelector(".busy-banner"));
  await json(`/api/projects/${deletedSaveId}`, null, "DELETE");
  await images.getByRole("button", { name: "新しい保存版を保存" }).click();
  await images.waitForFunction(() =>
    document.querySelector(".error-banner")?.textContent.includes("削除済み"),
  );
  await images.waitForFunction(() => !document.querySelector(".busy-banner"));
  assert.equal(
    await images.locator(".project-persistence strong").innerText(),
    "未保存の変更あり",
  );
  assert.ok(
    !(await json("/api/projects", null, "GET")).data.projects.some(
      (v) => v.id === deletedSaveId,
    ),
  );
  await images.getByRole("button", { name: "新しい保存版を保存" }).click();
  await waitIdle(images);
  await images.unroute("**/api/projects");
  const imageLibrary = (
    await json("/api/projects", null, "GET")
  ).data.projects.at(-1);
  const libraryDocument = (
    await json(`/api/projects/${imageLibrary.id}`, null, "GET")
  ).data;
  assert.equal(libraryDocument.project.assets.length, 2);
  assert.equal(libraryDocument.project.clips.length, 0);
  assert.ok(
    libraryDocument.project.assets.every(
      (a) => a.kind === "image" && a.width === 160 && a.height === 120,
    ),
  );
  ok(
    "Deleted uncertain save stays deleted; a fresh save ID succeeds without losing image-only edits",
  );
  await images.evaluate(() => {
    const asset = document.querySelector(".asset-card"),
      row = document.querySelector(".timeline-track-row");
    const dataTransfer = new DataTransfer();
    asset.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer }),
    );
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        dataTransfer,
        clientX: rect.left + 48,
        clientY: rect.top + 20,
      }),
    );
  });
  await images.waitForSelector(".timeline-clip");
  await images.getByRole("button", { name: "新しい保存版を保存" }).click();
  await waitIdle(images);
  const imageTimeline = (
    await json("/api/projects", null, "GET")
  ).data.projects.at(-1);
  await images
    .getByRole("button", { name: "編集終了・素材解放", exact: true })
    .click();
  await images.waitForFunction(
    () => document.querySelectorAll(".asset-card").length === 0,
  );
  await images.waitForLoadState("networkidle");
  await stop();
  await start();
  await images.reload();
  await images.getByText(/サーバーの保存版/).click();
  await images
    .locator(".project-revision")
    .last()
    .getByRole("button", { name: "読み込み", exact: true })
    .click();
  await waitIdle(images);
  await images.waitForSelector(".timeline-clip");
  assert.equal(await images.locator(".asset-card img").count(), 2);
  const imageDownload = images.waitForEvent("download", { timeout: 120000 });
  await images.getByTitle("全体書き出し (Ctrl+E)", { exact: true }).click();
  await (await imageDownload).saveAs(`${evidence}/image-roundtrip.mp4`);
  await waitIdle(images);
  const imageProbe = JSON.parse(
    execFileSync(
      "/usr/bin/ffprobe",
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        `${evidence}/image-roundtrip.mp4`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.ok(imageProbe.streams.some((s) => s.codec_type === "video"));
  assert.equal(
    (await json(`/api/projects/${imageTimeline.id}`, null, "GET")).status,
    200,
  );
  await images.screenshot({
    path: `${evidence}/loaded-images.png`,
    fullPage: true,
  });
  ok(
    "Real PNG/JPEG library and image clip survive save, tab release, server restart, reload and ffmpeg export",
  );
  assert.deepEqual(runtimeErrors, []);
  await browser.close();
  browser = null;
  await stop();
  ok("Browser checks completed without page runtime errors");
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  await stop();
  process.exitCode = 1;
});
