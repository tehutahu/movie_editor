/* global document, window, structuredClone, requestAnimationFrame, performance */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { dragToVisibleTarget } from './browser-pointer.mjs';

const suite = verification('preview-source-clock', 3210);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = [];
let page;
const check = (name, ok = true) => {
  assert(ok, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2));
};
const colours = [[255, 0, 0], [0, 127, 0], [0, 0, 255], [255, 255, 0]];
async function seek(sec) {
  const input = page.getByRole('textbox', { name: '再生位置', exact: true });
  await input.fill(String(sec)); await input.press('Enter'); await input.blur();
}
async function colour(expected) {
  await page.waitForFunction(expected => {
    const c = document.querySelector('.compositor-canvas');
    const p = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return expected.every((v, i) => Math.abs(v - p[i]) < 25);
  }, expected);
}
async function save() {
  const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
  const result = await response; assert(result.ok());
  const { document: doc } = await result.json();
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  return doc;
}
async function load(doc, name) {
  const file = `${evidence}/${name}.json`; fs.writeFileSync(file, JSON.stringify(doc));
  const response = page.waitForResponse(r => r.url().endsWith('/api/projects/load'));
  await page.locator('.project-persistence input[type=file]').setInputFiles(file);
  assert((await response).ok());
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
}
async function exported(payload, name, selected = false) {
  const response = await page.request.post(`${baseURL}/api/jobs/${selected ? 'export-segment' : 'export-composition'}`, { data: payload });
  assert(response.ok(), await response.text());
  const { jobId } = await response.json();
  for (let i = 0; i < 100; i++) {
    const job = await (await page.request.get(`${baseURL}/api/jobs/${jobId}`)).json();
    assert.notEqual(job.status, 'error', job.error);
    if (job.status === 'done') {
      const download = await page.request.get(`${baseURL}/api/download/${jobId}`); assert(download.ok());
      const file = `${evidence}/${name}.mp4`; fs.writeFileSync(file, await download.body()); return file;
    }
    await page.waitForTimeout(100);
  }
  throw Error('export timeout');
}
function outputColour(file, time, expected) {
  const pixels = ff(['-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'crop=iw/2:ih/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(pixels.length, 3);
  expected.forEach((v, i) => assert(Math.abs(v - pixels[i]) < 25, `${file} at ${time}: ${[...pixels]} != ${expected}`));
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=red:s=160x120:r=30:d=2', '-vf',
    'drawbox=color=green:t=fill:enable=gte(n\\,15)*lt(n\\,30),drawbox=color=blue:t=fill:enable=gte(n\\,30)*lt(n\\,45),drawbox=color=yellow:t=fill:enable=gte(n\\,45)',
    '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', `${evidence}/base.mp4`]);
  const origins = [0, 0.01, 0.033333, 0.2, 2];
  for (const origin of origins) ff(['-y', '-itsoffset', String(origin), '-i', `${evidence}/base.mp4`, '-c', 'copy', `${evidence}/origin-${origin}.mp4`]);
  ff(['-y', '-itsoffset', '0.033', '-i', `${evidence}/base.mp4`, '-c:v', 'libvpx-vp9', '-fps_mode', 'passthrough', `${evidence}/origin-vp9.mkv`]);
  const cases = [...origins.map(origin => ({ name: `origin-${origin}`, ext: 'mp4' })), { name: 'origin-vp9', ext: 'mkv' }];
  await suite.start(); const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.__clockSeeks = 0;
    window.__clockVideos = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => callback(window.__clockFreezeTime ?? time));
    const create = document.createElement.bind(document);
    document.createElement = function(name, ...args) {
      const el = create(name, ...args);
      if (name === 'video') {
        window.__clockVideos.push(el);
        el.addEventListener('seeked', () => window.__clockSeeks++);
      }
      return el;
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(cases.map(c => `${evidence}/${c.name}.${c.ext}`));
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 6 && !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card').first(), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor();
  const template = await save();
  for (const { name: origin } of cases) {
    const doc = structuredClone(template);
    const asset = doc.project.assets.find(a => a.displayName === origin); assert(asset);
    doc.project.compositionWidth = 320; doc.project.compositionHeight = 320; doc.project.compositionDurationSec = 2;
    doc.project.clips = [{ ...doc.project.clips[0], timelineStartSec: 0, durationSec: 2,
      transform: { x: .5, y: .5, scale: 2 }, parts: [{ assetId: asset.id, sourceInSec: 0, sourceOutSec: 2 }] }];
    await load(doc, `case-${origin}`);
    for (const time of [0, .5, 1, 1.5, 1.99]) {
      await seek(time); await colour(colours[Math.min(3, Math.floor(time * 2))]);
    }
    await page.waitForTimeout(200);
    const seeks = await page.evaluate(() => window.__clockSeeks);
    await page.waitForTimeout(300);
    check(`origin ${origin}: boundary colours, EOF hold, and stopped seek activity settles`, seeks === await page.evaluate(() => window.__clockSeeks));
    assert.deepEqual((await save()).project, doc.project);
    check(`origin ${origin}: save preserves source ranges and project values`);
    const payload = { ...doc.project, assets: doc.project.assets.map(a => ({ ...a, storageAssetId: a.media.id })) };
    const composition = await exported(payload, `stretch-${origin}`);
    const selected = await exported({ videoId: asset.media.id, startSec: 0, endSec: 2 }, `selected-${origin}`, true);
    const contained = await exported({ ...payload, clips: payload.clips.map(c => ({ ...c, layoutMode: 'contain' })) }, `contain-${origin}`);
    for (const file of [composition, selected, contained]) {
      for (const time of [0, .5, 1, 1.5, 1.9]) outputColour(file, time, colours[Math.min(3, Math.floor(time * 2))]);
    }
    check(`origin ${origin}: selected, stretch and contain decoded frames match the fixed preview oracle`);
    if (origin === 'origin-2') {
      await seek(.25); await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
      await colour(colours[1]);
      await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
      check('positive-origin preview plays across a colour boundary');
      await captureEvidenceScreenshot(page, `${evidence}/positive-origin.png`);
      // Keep the presentation clock inside the last clip while native media
      // runs in real time. This exposes play() rewinding an ended pooled video.
      await seek(1.98); await colour(colours[3]);
      await page.evaluate(() => { window.__clockFreezeTime = performance.now(); });
      await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
      const held = await page.evaluate(() => new Promise(resolve => {
        const start = performance.now(), samples = [];
        const sample = () => {
          const c = document.querySelector('.compositor-canvas');
          samples.push([...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]);
          if (performance.now() - start >= 250) resolve(samples); else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }));
      assert(held.length > 2 && held.every(p => p[0] > 220 && p[1] > 220 && p[2] < 30));
      await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
      await page.evaluate(() => { delete window.__clockFreezeTime; });
      check('playing beyond native EOF holds yellow without restarting or flashing red');
    }
    const trimmed = structuredClone(doc);
    trimmed.project.compositionDurationSec = 1.4;
    trimmed.project.clips[0].durationSec = 1.4;
    trimmed.project.clips[0].parts[0].sourceInSec = .5;
    trimmed.project.clips[0].parts[0].sourceOutSec = 1.9;
    await load(trimmed, `trimmed-${origin}`);
    for (const time of [0, .5, 1, 1.39]) {
      await seek(time); await colour(colours[Math.min(3, Math.floor((time + .5) * 2))]);
    }
    assert.deepEqual((await save()).project, trimmed.project);
    check(`${origin}: nonzero sourceIn preview and saved ranges remain relative to source start`);
    const count = await page.locator('.timeline-track-row').count();
    await page.locator('[data-add-track]').click();
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    await seek(.5); await colour(colours[2]);
    assert(await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).isEnabled());
    assert.equal(await page.locator('.project-persistence strong').textContent(), '変更なし');
    await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).click();
    assert.equal(await page.locator('.timeline-track-row').count(), count + 1);
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    check(`${origin}: calibrated seeks preserve pending Redo and clean saved state`);
  }
  check('no uncaught browser errors', errors.length === 0);
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Preserve original failure. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
