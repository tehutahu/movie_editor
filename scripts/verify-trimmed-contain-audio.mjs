/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('trimmed-contain-audio', 3212);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = []; let page;
const check = (name, ok = true) => {
  assert(ok, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2));
};
async function save() {
  const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
  const result = await response; assert(result.ok());
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  return (await result.json()).document;
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=30:d=0.5', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=1.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-bf', '0', `${evidence}/video.mp4`]);
  ff(['-y', '-itsoffset', '2', '-i', `${evidence}/video.mp4`, '-f', 'lavfi', '-i', 'aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=44100:d=1.4', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', `${evidence}/delayed.mp4`]);
  await suite.start(); const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/delayed.mp4`);
  await page.locator('.asset-card').waitFor();
  await page.waitForFunction(() => !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card'), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor();
  const template = await save(), doc = structuredClone(template);
  doc.version = 2;
  Object.assign(doc.project, { compositionWidth: 320, compositionHeight: 320, compositionDurationSec: .6 });
  Object.assign(doc.project.clips[0], { timelineStartSec: 0, durationSec: .6, layoutMode: 'contain', transform: { x: .5, y: .5, scale: 2 } });
  Object.assign(doc.project.clips[0].parts[0], { sourceInSec: .1, sourceOutSec: .7 });
  fs.writeFileSync(`${evidence}/trimmed.json`, JSON.stringify(doc));
  const loaded = page.waitForResponse(r => r.url().endsWith('/api/projects/load'));
  await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/trimmed.json`);
  assert((await loaded).ok()); await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  const request = page.waitForRequest(r => r.url().endsWith('/api/jobs/export-composition') && r.method() === 'POST');
  const downloaded = page.waitForEvent('download', { timeout: 120000 });
  await page.getByTitle('全体書き出し (Ctrl+E)', { exact: true }).click();
  const payload = (await request).postDataJSON(); assert.deepEqual(payload.clips[0].parts, doc.project.clips[0].parts);
  const download = await downloaded; assert.equal(await download.failure(), null);
  const out = `${evidence}/trimmed-export.mp4`; await download.saveAs(out);
  ff(['-xerror', '-i', out, '-f', 'null', '-']);
  const pcm = ff(['-i', out, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  const rms = (start, end) => {
    let energy = 0; for (let n = Math.round(start * 48000); n < Math.round(end * 48000); n++) energy += pcm.readInt16LE(n * 2) ** 2;
    return Math.sqrt(energy / Math.round((end - start) * 48000));
  };
  check('native UI export downloads a fully decodable trimmed contain movie with the source pulse at 0.4s', rms(.402, .418) > 4000 && rms(.3, .32) < 1500 && rms(.5, .52) < 1500);
  for (const [time, channel] of [[.3, 0], [.4, 2]]) {
    const rgb = ff(['-ss', String(time), '-i', out, '-frames:v', '1', '-vf', 'crop=iw/2:ih/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(rgb.length, 3); assert(rgb[channel] > 220 && rgb[channel === 0 ? 2 : 0] < 25);
  }
  check('export retains the original source-relative red/blue video boundary');
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  assert.deepEqual((await save()).project, doc.project);
  check('export preserves exact source ranges, media hashes and saved project values');
  check('no uncaught browser errors', errors.length === 0);
  await captureEvidenceScreenshot(page, `${evidence}/trimmed-export.png`);
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Preserve original failure. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
