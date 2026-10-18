/* global document, window, CanvasRenderingContext2D, Event */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { visiblePointerPoint, dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('preview-invalidation', 3126);
const { evidence, baseURL, ff } = suite;
let page;
const checks = [], measurements = [], errors = [];
function check(name, value = true) {
  assert(value, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, measurements, errors }, null, 2));
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=red:s=160x120', '-frames:v', '1', `${evidence}/red.png`]);
  ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', `${evidence}/moving.mp4`]);
  await suite.start();
  const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.__preview = { paints: 0, videos: [], imageLoads: 0, videoSeeks: 0 };
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, width, height) {
      if (this.canvas.classList.contains('compositor-canvas') && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height) window.__preview.paints++;
      return fill.call(this, x, y, width, height);
    };
    const create = document.createElement.bind(document);
    document.createElement = function(name, ...args) {
      const element = create(name, ...args);
      if (name === 'video') {
        window.__preview.videos.push(element);
        element.addEventListener('seeked', () => window.__preview.videoSeeks++);
      }
      if (name === 'img') element.addEventListener('load', () => window.__preview.imageLoads++);
      return element;
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator('canvas').waitFor();
  const canvasState = () => page.locator('canvas').evaluate(canvas => ({ pixels: canvas.toDataURL(), width: canvas.width, height: canvas.height }));
  const idle = async name => {
    // Settle readiness events, then measure the same fixed observation window.
    await page.waitForTimeout(250);
    const before = await page.evaluate(() => window.__preview.paints);
    const start = Date.now(); await page.waitForTimeout(500);
    const paints = await page.evaluate(() => window.__preview.paints);
    measurements.push({ name, intervalMs: Date.now() - start, paints: paints - before });
    check(`${name}: stopped idle paints cease`, paints === before);
  };
  await idle('empty');
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/red.png`);
  await page.locator('.asset-card').waitFor();
  await page.waitForFunction(() => !document.querySelector('.asset-library input').disabled);
  // Delay the image's active-preview stream; the later load must invalidate it.
  let releaseImage;
  const imageReady = new Promise(resolve => { releaseImage = resolve; });
  await page.route('**/api/assets/*/stream', async route => { await imageReady; await route.continue(); });
  await dragToVisibleTarget(page, page.locator('.asset-card'), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor();
  releaseImage();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    const p = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return p[0] > 200 && p[1] < 30 && p[2] < 30;
  });
  await page.unroute('**/api/assets/*/stream');
  check('delayed image load redraws while stopped');
  await idle('image');
  const beforeClear = await page.evaluate(() => window.__preview.paints);
  await page.locator('canvas').click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(before => window.__preview.paints > before, beforeClear);
  const beforeSelection = await canvasState();
  await page.locator('.timeline-clip').click({ position: { x: 30, y: 20 } });
  await page.waitForFunction(previous => document.querySelector('canvas').toDataURL() !== previous, beforeSelection.pixels);
  check('selection invalidates transform handles');
  const selected = await canvasState();
  const point = await visiblePointerPoint(page, page.locator('canvas'));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down(); await page.mouse.move(point.x + 50, point.y);
  await page.waitForFunction(previous => document.querySelector('canvas').toDataURL() !== previous, selected.pixels);
  await captureEvidenceScreenshot(page, `${evidence}/transform-drag.png`);
  await page.mouse.up();
  const moved = await canvasState();
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
  await page.waitForFunction(previous => document.querySelector('canvas').toDataURL() !== previous, moved.pixels);
  check('transform preview, release and Undo redraw while stopped');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.compositor-canvas-wrap').evaluate(element => { element.style.flex = 'none'; element.style.height = '120px'; element.style.minHeight = '0px'; });
  await page.waitForFunction(previous => document.querySelector('canvas').width !== previous, selected.width);
  check('container resize redraws canvas dimensions');
  await page.locator('.compositor-canvas-wrap').evaluate(element => { element.style.flex = ''; element.style.height = ''; element.style.minHeight = ''; });
  await page.waitForFunction(previous => document.querySelector('canvas').width === previous, selected.width);
  const paintsBeforeVisibility = await page.evaluate(() => window.__preview.paints);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(previous => window.__preview.paints > previous, paintsBeforeVisibility);
  check('synthetic visibilitychange event invalidates the canvas');
  const beforeFullscreen = await canvasState();
  const fullPaints = await page.evaluate(() => window.__preview.paints);
  await page.getByTitle('プレビューを最大画面', { exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.waitForFunction(before => window.__preview.paints > before, fullPaints);
  await page.waitForFunction(before => document.querySelector('canvas').width !== before.width || document.querySelector('canvas').height !== before.height, beforeFullscreen);
  const enteredFullscreen = await canvasState();
  const exitPaints = await page.evaluate(() => window.__preview.paints);
  // Headless Escape does not exit fullscreen; exercise the browser API exit.
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(before => window.__preview.paints > before, exitPaints);
  await page.waitForFunction(before => document.querySelector('canvas').width !== before.width || document.querySelector('canvas').height !== before.height, enteredFullscreen);
  check('fullscreen button entry and browser API exit redraw canvas dimensions');
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/moving.mp4`);
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2 && !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card').filter({ hasText: 'moving' }), page.locator('.timeline-track-row').first(), { targetPosition: { x: 48, y: 30 } });
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 2 &&
    document.querySelector('.timeline-track-row .timeline-clip')?.textContent === 'moving');
  const savedSetup = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
  const setupResponse = await savedSetup; assert(setupResponse.ok());
  const { document: setup } = await setupResponse.json();
  const movingAsset = setup.project.assets.find(asset => asset.displayName === 'moving');
  const frontTrack = [...setup.project.tracks].sort((a, b) => a.order - b.order)[0];
  assert(movingAsset && setup.project.clips.some(clip => clip.trackId === frontTrack.id && clip.parts.some(part => part.assetId === movingAsset.id)),
    'native drop places the actual moving-video asset on T1');
  fs.writeFileSync(`${evidence}/video-setup-project.json`, JSON.stringify(setup, null, 2));
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  await page.waitForFunction(() => window.__preview.videos.some(video => video.readyState >= 2 && video.videoWidth > 0));
  const seek = async sec => {
    const point = await visiblePointerPoint(page, page.locator('.timeline-scroll'), { x: 48 + sec * 80, y: 8 });
    await page.mouse.click(point.x, point.y);
  };
  const firstVideo = await canvasState();
  const beforeSeek = await page.evaluate(() => window.__preview.videoSeeks);
  await seek(2);
  await page.waitForFunction(before => window.__preview.videoSeeks > before, beforeSeek);
  await page.waitForFunction(previous => document.querySelector('canvas').toDataURL() !== previous, firstVideo.pixels);
  check('asynchronous stopped video seek redraws the decoded target frame');
  await idle('video');
  await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
  await page.waitForFunction(() => window.__preview.videos.some(video => !video.paused));
  await page.locator('.compositor-canvas-wrap').evaluate(element => { element.style.width = '0px'; element.style.height = '0px'; });
  await page.waitForFunction(() => { const wrap = document.querySelector('.compositor-canvas-wrap'); return wrap.clientWidth === 0 || wrap.clientHeight === 0; });
  await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
  await page.waitForFunction(() => window.__preview.videos.every(video => video.paused));
  check('stopping at size zero pauses pooled video and hidden audio');
  const paintsBeforeRestore = await page.evaluate(() => window.__preview.paints);
  await page.locator('.compositor-canvas-wrap').evaluate(element => { element.style.width = ''; element.style.height = ''; });
  await page.waitForFunction(before => window.__preview.paints > before, paintsBeforeRestore);
  check('size-zero recovery redraws');
  await seek(3.85);
  await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
  await page.waitForFunction(() => parseFloat(document.querySelector('.timeline-ruler .timeline-playhead').style.left) > 48 + 4.15 * 80);
  await page.waitForFunction(() => window.__preview.videos.every(video => video.paused));
  check('inactive video and audio pause when playback enters an image-only span');
  await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
  await page.getByTitle('末尾 (Ctrl+→)', { exact: true }).click();
  await page.waitForFunction(() => window.__preview.videos.every(video => video.paused));
  check('stopped end keeps all media paused');
  await captureEvidenceScreenshot(page, `${evidence}/stopped-end.png`);
  await idle('end');
  check('no uncaught browser errors', errors.length === 0);
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Preserve original failure. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
