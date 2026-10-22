/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
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
  ff(['-y', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=300', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=300',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '0', '-c:a', 'aac', `${evidence}/normal.mp4`]);
  ff(['-y', '-copyts', '-i', `${evidence}/normal.mp4`, '-itsoffset', '2', '-i', `${evidence}/normal.mp4`,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', `${evidence}/positive.mp4`]);
  ff(['-y', '-i', `${evidence}/normal.mp4`, '-an', '-c:v', 'copy', `${evidence}/noaudio.mp4`]);
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('download', () => downloads++); await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(['positive', 'normal', 'noaudio'].map(name => `${evidence}/${name}.mp4`));
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 3 && !document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card').first(), page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor(); const template = await save();
  for (const name of ['positive', 'normal', 'noaudio']) {
    const doc = structuredClone(template);
    Object.assign(doc.project, { compositionWidth: 320, compositionHeight: 320, compositionDurationSec: .6 });
    Object.assign(doc.project.clips[0], { timelineStartSec: 0, durationSec: .6, transform: { x: .5, y: .5, scale: 1 } });
    Object.assign(doc.project.clips[0].parts[0], { assetId: doc.project.assets.find(a => a.displayName === name).id, sourceInSec: .1, sourceOutSec: .7 });
    await load(doc, name);
    const posted = page.waitForResponse(r => r.url().endsWith('/api/jobs/export-segment') && r.request().method() === 'POST');
    const pendingDownload = name === 'positive' ? null : page.waitForEvent('download', { timeout: 120000 });
    await page.getByTitle('選択クリップの素材切り出し。', { exact: false }).click();
    const response = await posted; assert(response.ok());
    const payload = response.request().postDataJSON(); assert.equal(payload.startSec, .1); assert.equal(payload.endSec, .7);
    const { jobId } = await response.json();
    if (name === 'positive') {
      await page.locator('.error-banner').filter({ hasText: '音声が欠落した書き出しを中止しました' }).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.busy-banner'));
      const job = await (await page.request.get(`${baseURL}/api/jobs/${jobId}`)).json();
      assert.equal(job.status, 'error'); assert.equal(downloads, 0);
      assert.equal((await page.request.get(`${baseURL}/api/download/${jobId}`)).status(), 409);
      assert.equal((await page.request.get(`${baseURL}/api/jobs/${jobId}/stream`)).status(), 409);
      assert(!fs.existsSync(`${suite.root}/jobs/${jobId}/output_segment.mp4`));
      check('long positive-audio selected loss shows a real job error, removes output and denies both publication paths');
      await captureEvidenceScreenshot(page, `${evidence}/missing-audio-error.png`);
    } else {
      const download = await pendingDownload; assert.equal(await download.failure(), null);
      const out = `${evidence}/${name}-selected.mp4`; await download.saveAs(out);
      const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out], { encoding: 'utf8' }));
      assert.deepEqual(probe.streams.map(s => s.codec_type), name === 'normal' ? ['video', 'audio'] : ['video']);
      ff(['-xerror', '-i', out, '-f', 'null', '-']);
      await page.waitForFunction(() => !document.querySelector('.busy-banner'));
      check(`${name} long source still downloads and fully decodes with its original stream contract`);
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
