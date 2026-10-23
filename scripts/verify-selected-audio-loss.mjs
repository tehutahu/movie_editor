/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('selected-audio-loss', 3216);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = []; let page, downloads = 0;
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
  await page.locator('.timeline-clip').click();
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=300', '-f', 'lavfi', '-i', 'aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=48000:d=300',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '0', '-c:a', 'aac', `${evidence}/normal.mp4`]);
  ff(['-y', '-copyts', '-i', `${evidence}/normal.mp4`, '-itsoffset', '2', '-i', `${evidence}/normal.mp4`,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', `${evidence}/positive.mp4`]);
  ff(['-y', '-i', `${evidence}/normal.mp4`, '-an', '-c:v', 'copy', `${evidence}/noaudio.mp4`]);
  // Independent bounded-memory oracle for the fixed 300s test source only.
  fs.mkdirSync(suite.root, { recursive: true });
  const full = `${suite.root}/full.pcm`, raw = `${evidence}/expected.pcm`, expected = `${evidence}/expected.m4a`;
  ff(['-y', '-xerror', '-i', `${evidence}/positive.mp4`, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', full]);
  const fd = fs.openSync(full, 'r'), window = Buffer.alloc(28800 * 8);
  try { assert.equal(fs.readSync(fd, window, 0, window.length, 4800 * 8), window.length); } finally { fs.closeSync(fd); }
  fs.unlinkSync(full); fs.writeFileSync(raw, window);
  ff(['-y', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-i', raw, '-c:a', 'aac', '-movie_timescale', '48000', expected]);
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('download', () => downloads++); await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(['positive', 'normal', 'noaudio'].map(name => `${evidence}/${name}.mp4`));
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 3 && !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card').first(), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor(); const template = await save();
  for (const name of ['positive', 'positive-wide', 'normal', 'noaudio', 'multipart']) {
    const multi = name === 'multipart';
    const missing = name === 'positive-wide', duration = missing ? 1.1 : .6, end = missing ? 1.2 : .7;
    const doc = structuredClone(template);
    Object.assign(doc.project, { compositionWidth: 320, compositionHeight: 320, compositionDurationSec: duration });
    Object.assign(doc.project.clips[0], { timelineStartSec: 0, durationSec: duration, transform: { x: .5, y: .5, scale: 1 } });
    Object.assign(doc.project.clips[0].parts[0], { assetId: doc.project.assets.find(a => a.displayName === (missing || multi ? 'positive' : name)).id, sourceInSec: .1, sourceOutSec: end });
    if (multi) {
      doc.version = 3; // Audio gain belongs to the existing v3 persistence schema.
      const first = doc.project.clips[0].parts[0];
      doc.project.clips[0].parts = [{ ...first, sourceOutSec: .4 },
        { assetId: doc.project.assets.find(a => a.displayName === 'normal').id, sourceInSec: .4, sourceOutSec: .7 }];
      doc.project.clips[0].audioGain = 0; // Selected source DL keeps original audio.
    }
    await load(doc, name);
    const posted = page.waitForResponse(r => r.url().endsWith(multi ? '/api/jobs/export-composition' : '/api/jobs/export-segment') && r.request().method() === 'POST');
    const downloadsBefore = downloads;
    const pendingDownload = missing ? null : page.waitForEvent('download', { timeout: 120000 });
    await page.getByTitle('選択クリップの素材切り出し。', { exact: false }).click();
    const response = await posted; assert(response.ok());
    const payload = response.request().postDataJSON();
    if (multi) { assert.equal(payload.clips[0].parts.length, 2); assert.equal(payload.clips[0].audioGain, undefined); }
    else { assert.equal(payload.startSec, .1); assert.equal(payload.endSec, end); }
    const { jobId } = await response.json();
    if (missing) {
      await page.locator('.error-banner').filter({ hasText: '音声が欠落した書き出しを中止しました' }).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.busy-banner'));
      const job = await (await page.request.get(`${baseURL}/api/jobs/${jobId}`)).json();
      assert.equal(job.status, 'error'); assert.equal(downloads, downloadsBefore);
      assert.equal((await page.request.get(`${baseURL}/api/download/${jobId}`)).status(), 409);
      assert.equal((await page.request.get(`${baseURL}/api/jobs/${jobId}/stream`)).status(), 409);
      assert(!fs.existsSync(`${suite.root}/jobs/${jobId}/output_segment.mp4`));
      check('oversized positive-audio selected loss still shows a real job error, removes output and denies both publication paths');
      await captureEvidenceScreenshot(page, `${evidence}/missing-audio-error.png`);
    } else {
      const download = await pendingDownload; assert.equal(await download.failure(), null);
      const out = `${evidence}/${name}-selected.mp4`; await download.saveAs(out);
      const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out], { encoding: 'utf8' }));
      assert.deepEqual(probe.streams.map(s => s.codec_type), name === 'noaudio' ? ['video'] : ['video', 'audio']);
      ff(['-xerror', '-i', out, '-f', 'null', '-']);
      await page.waitForFunction(() => !document.querySelector('.busy-banner'));
      if (name === 'positive') {
        const decode = file => ff(['-xerror', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1']);
        const actual = decode(out); assert.deepEqual(actual, decode(expected));
        const rms = (a, b) => {
          let sum = 0; for (let n = Math.round(a * 48000); n < Math.round(b * 48000); n++) sum += actual.readInt16LE(n * 4) ** 2;
          return Math.sqrt(sum / Math.round((b - a) * 48000));
        };
        assert(rms(.426, .436) > 4000); assert(rms(.2, .22) < 1500);
        assert.equal(probe.streams[0].width, 64); assert.equal(probe.streams[0].height, 64);
        await captureEvidenceScreenshot(page, `${evidence}/recovered-audio.png`);
        check('bounded positive-audio download matches independent fixed PCM/AAC and keeps native video dimensions');
      } else if (multi) {
        const actual = ff(['-xerror', '-i', out, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1']);
        assert.equal(actual.length / 4, 29696);
        const rms = (first, end) => {
          let sum = 0; for (let n = first; n < end; n++) sum += actual.readInt16LE(n * 4) ** 2;
          return Math.sqrt(sum / (end - first));
        };
        assert(rms(19440, 19920) > 4000); assert(rms(5040, 5520) < 1500);
        const rgb = ff(['-xerror', '-i', out, '-map', '0:v:0', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1',
          '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
        assert.equal(rgb.length, 54);
        for (let n = 0; n < 18; n++) { assert(rgb[n * 3 + 2] > 220); assert(rgb[n * 3] < 25); }
        await captureEvidenceScreenshot(page, `${evidence}/multipart-recovered.png`);
        check('multipart selected download restores actual first-part audio and keeps the normal later pulse at its fixed time');
      } else check(`${name} long source still downloads and fully decodes with its original stream contract`);
    }
    assert.deepEqual((await save()).project, doc.project);
    const count = await page.locator('.timeline-track-row').count(); await page.locator('[data-add-track]').click();
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    assert(await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).isEnabled());
    await page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true }).click(); assert.equal(await page.locator('.timeline-track-row').count(), count + 1);
    await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    check(`${name}: saved source values, hashes and Undo/Redo are preserved`);
  }
  assert.equal(errors.length, 0); check('no uncaught browser errors');
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => undefined);
  process.exitCode = 1;
}).finally(() => suite.cleanup());
