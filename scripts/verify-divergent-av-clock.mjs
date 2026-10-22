/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('divergent-av-clock', 3214);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = []; let page;
const check = name => { checks.push(name); console.log('PASS', name); fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2)); };
async function save() {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
  const response = await pending; assert(response.ok()); await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  return (await response.json()).document;
}
async function load(doc, name) {
  fs.writeFileSync(`${evidence}/${name}.json`, JSON.stringify(doc));
  const pending = page.waitForResponse(r => r.url().endsWith('/api/projects/load'));
  await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/${name}.json`);
  assert((await pending).ok()); await page.waitForFunction(() => !document.querySelector('.busy-banner'));
}
async function seek(time, channel) {
  const input = page.getByRole('textbox', { name: '再生位置', exact: true });
  await input.fill(String(time)); await input.press('Enter'); await input.blur();
  await page.waitForFunction(channel => {
    const c = document.querySelector('.compositor-canvas'), p = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return p[channel] > 220 && p[channel === 0 ? 2 : 0] < 25;
  }, channel);
}
function oracle(out, start) {
  ff(['-xerror', '-i', out, '-f', 'null', '-']);
  const pcm = ff(['-i', out, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  const rms = (a, b) => {
    let sum = 0; for (let n = Math.round(a * 48000); n < Math.round(b * 48000); n++) sum += pcm.readInt16LE(n * 2) ** 2;
    return Math.sqrt(sum / Math.round((b - a) * 48000));
  };
  assert(rms(.502 - start, .518 - start) > 4000); assert(rms(.3 - start, .32 - start) < 1500);
  for (const [t, channel] of [[.3 - start, 0], [.5 - start, 2]]) {
    const rgb = ff(['-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=iw/2:ih/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(rgb.length, 3); assert(rgb[channel] > 220 && rgb[channel === 0 ? 2 : 0] < 25);
  }
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=30:d=0.5', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=1.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-bf', '0', `${evidence}/video.mp4`]);
  ff(['-y', '-itsoffset', '2', '-i', `${evidence}/video.mp4`, '-f', 'lavfi', '-i', 'aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=44100:d=1.4', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', `${evidence}/av.mp4`]);
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/av.mp4`);
  await page.locator('.asset-card').waitFor(); await page.waitForFunction(() => !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card'), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor(); const template = await save();
  for (const start of [0, .1]) {
    const doc = structuredClone(template); doc.version = 1;
    Object.assign(doc.project, { compositionWidth: 320, compositionHeight: 320, compositionDurationSec: .7 });
    Object.assign(doc.project.clips[0], { timelineStartSec: 0, durationSec: .7, transform: { x: .5, y: .5, scale: 1 } });
    Object.assign(doc.project.clips[0].parts[0], { sourceInSec: start, sourceOutSec: start + .7 });
    await load(doc, `source-${start}`); await seek(.3 - start, 0); await seek(.5 - start, 2);
    check(`source ${start}: preview uses the same red/blue boundary as contain`);
    // Real UI selected download and whole export, including their payloads.
    await page.locator('.timeline-clip').click();
    for (const selected of [true, false]) {
      const request = page.waitForRequest(r => r.url().endsWith(`/api/jobs/${selected ? 'export-segment' : 'export-composition'}`) && r.method() === 'POST');
      const pending = page.waitForEvent('download', { timeout: 120000 });
      if (selected) await page.getByTitle('選択クリップの素材切り出し。', { exact: false }).click();
      else await page.getByTitle('全体書き出し (Ctrl+E)', { exact: true }).click();
      const payload = (await request).postDataJSON();
      if (selected) { assert.equal(payload.startSec, start); assert.equal(payload.endSec, start + .7); }
      else assert.deepEqual(payload.clips[0].parts, doc.project.clips[0].parts);
      const download = await pending; assert.equal(await download.failure(), null);
      const out = `${evidence}/${selected ? 'selected' : 'stretch'}-${start}.mp4`; await download.saveAs(out); oracle(out, start);
      await page.waitForFunction(() => !document.querySelector('.busy-banner'));
      check(`source ${start}: native ${selected ? 'selected' : 'stretch'} download has fixed frame/pulse oracle`);
    }
    assert.deepEqual((await save()).project, doc.project);
    const count = await page.locator('.timeline-track-row').count(); await page.locator('[data-add-track]').click();
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click(); await seek(.5 - start, 2);
    assert(await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).isEnabled());
    await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).click(); assert.equal(await page.locator('.timeline-track-row').count(), count + 1);
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    check(`source ${start}: runtime clock preserves saved media hashes, source cuts and pending Redo`);
  }
  await captureEvidenceScreenshot(page, `${evidence}/av-clock.png`);
  assert.equal(errors.length, 0); check('no uncaught browser errors');
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Preserve original failure. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
