/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { verification } from './browser-test-utils.mjs';
import { visiblePointerPoint, assertPointerHit } from './browser-pointer.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';

const suite = verification('move-selection-to-playhead', 3192), { evidence, baseURL } = suite;
const checks = [], errors = []; let page;
function check(name, value = true) { assert(value, name); checks.push(name); console.log('PASS', name); fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2)); }
const watchdog = setTimeout(() => { fs.writeFileSync(`${evidence}/failure.txt`, 'Explicit group placement exceeded90s'); suite.cleanup().finally(() => process.exit(1)); }, 90000); watchdog.unref();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

(async () => {
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message)); await page.goto(baseURL);
  const action = page.locator('[data-move-to-playhead]'), input = page.getByRole('textbox', { name: '再生位置', exact: true });
  const play = page.getByTitle('再生 / 一時停止 (Space)', { exact: true }), undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true }), redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
  async function seek(value) { await input.fill(String(value)); await input.press('Enter'); await page.waitForFunction(value => document.querySelector('.exact-seek input').value === String(value), value); await play.focus(); }
  async function save() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    const { projects } = await (await page.request.get(`${baseURL}/api/projects`)).json(); return (await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();
  }
  const starts = doc => doc.project.clips.map(c => c.timelineStartSec);
  check('empty selection explains its disabled action', await action.getAttribute('aria-disabled') === 'true' && await action.getAttribute('aria-describedby'));
  await page.locator('.asset-upload-btn input').setInputFiles(['move-A', 'move-B'].map(name => ({ name: `${name}.png`, mimeType: 'image/png', buffer: image })));
  await page.waitForFunction(() => document.querySelectorAll('.asset-add-button').length === 2 && !document.querySelector('.busy-banner'));
  await seek(0); await page.locator('.asset-card').filter({ hasText: 'move-A' }).getByRole('button').click();
  await seek(5); await page.locator('.asset-card').filter({ hasText: 'move-B' }).getByRole('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 2);
  check('single selection cannot move as a group', await action.getAttribute('aria-disabled') === 'true');
  // Keep B first in the selection; the target must still use A's earliest start.
  await page.locator('.timeline-clip').filter({ hasText: 'move-A' }).click({ modifiers: ['ControlOrMeta'], position: { x: 20, y: 12 } });
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip--selected').length === 2);
  await seek(1); const before = await save(); assert.deepEqual(starts(before), [0, 5]);
  const point = await visiblePointerPoint(page, action); await assertPointerHit(page, action, point); await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('.timeline-clip').style.left === '128px');
  const moved = await save(); assert.deepEqual(starts(moved), [1, 6]);
  check('explicit button translates the entire group from its earliest start', true);
  check('relative gap and composition extension follow existing group movement', moved.project.clips[1].timelineStartSec - moved.project.clips[0].timelineStartSec === 5 && moved.project.compositionDurationSec === 11);
  moved.project.clips.forEach((clip, index) => assert.deepEqual({ ...clip, timelineStartSec: before.project.clips[index].timelineStartSec }, before.project.clips[index]));
  check('source references and all non-time clip fields remain unchanged', JSON.stringify(moved.project.assets) === JSON.stringify(before.project.assets));
  check('playhead and playback stay unchanged', await input.inputValue() === '1' && await play.textContent() === '▶');
  await undo.click(); const undone = await save(); assert.deepEqual(undone, before); check('one Undo restores the entire original saved document');
  await seek(0); check('zero-delta action is explained', await action.getAttribute('aria-disabled') === 'true');
  await action.focus(); await page.keyboard.press('Space'); check('invalid native Space keeps Redo and never starts playback', await redo.isEnabled() && await play.textContent() === '▶');
  await redo.click(); const redone = await save(); assert.deepEqual(redone, moved); check('one Redo restores the full translated document');
  await undo.click(); await seek(2);
  const clip = page.locator('.timeline-clip').filter({ hasText: 'move-A' }), clipPoint = await visiblePointerPoint(page, clip, { x: 20, y: 12 }); await assertPointerHit(page, clip, clipPoint);
  const beforeCaptureHistory = await Promise.all([undo.isEnabled(), redo.isEnabled()]);
  const beforePendingLeft = await page.locator('.timeline-clip').evaluateAll(clips => clips.map(clip => clip.style.left));
  await page.mouse.move(clipPoint.x, clipPoint.y);
  await page.evaluate(() => {
    globalThis.__moveCapture = { down: 0, got: 0, pointerId: null, owner: null };
    document.addEventListener('pointerdown', event => {
      globalThis.__moveCapture.down++;
      globalThis.__moveCapture.pointerId = event.pointerId;
      globalThis.__moveCapture.owner = event.target.closest('.timeline-scroll');
    }, { capture: true, once: true });
    document.addEventListener('gotpointercapture', () => { globalThis.__moveCapture.got++; }, { capture: true, once: true });
  });
  await page.mouse.down();
  const captureObservation = await page.evaluate(() => {
    const { down, got, pointerId, owner } = globalThis.__moveCapture;
    return { down, got, pointerId, ownerClass: owner?.className ?? null,
      ownerConnected: owner?.isConnected ?? false,
      nativeCapture: owner?.hasPointerCapture(pointerId) ?? false };
  });
  const capturePhase = captureObservation.got === 0 ? 'pending-observed' : 'already-delivered-pending-not-observed';
  fs.writeFileSync(`${evidence}/capture-observation.json`, JSON.stringify({ ...captureObservation, phase: capturePhase }, null, 2));
  assert.equal(captureObservation.down, 1);
  assert.equal(captureObservation.nativeCapture, true);
  check(`stationary pointerdown owns native capture (${capturePhase})`);
  await action.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.locator('.timeline-clip').evaluateAll(clips => clips.map(clip => clip.style.left)), beforePendingLeft);
  assert.deepEqual(await Promise.all([undo.isEnabled(), redo.isEnabled()]), beforeCaptureHistory);
  check('stationary pointer capture rejects keyboard placement without another pointer event');
  await page.mouse.up();
  const captureRejected = await save(); assert.deepEqual(captureRejected, before); check('real group pointer capture rejects keyboard placement atomically');
  await page.waitForFunction(() => document.querySelector('[data-move-to-playhead]').getAttribute('aria-disabled') === 'false');
  await action.focus(); await page.keyboard.press('Enter'); const entered = await save(); assert.deepEqual(starts(entered), [2, 7]);
  check('release recovers and native Enter commits one edit without playback', await play.textContent() === '▶');
  await undo.click(); assert.deepEqual(await save(), before); check('native Enter edit needs only one Undo');
  await seek(3); await action.focus(); await page.keyboard.press('Space'); const spaced = await save(); assert.deepEqual(starts(spaced), [3, 8]);
  check('native Space performs one placement and owns playback propagation', await play.textContent() === '▶');
  await undo.click(); assert.deepEqual(await save(), before);
  check('native Space edit needs only one Undo');
  await page.getByRole('button', { name: 'ヘルプ', exact: true }).click();
  check('help blocks placement and explains the explicit action', await action.getAttribute('aria-disabled') === 'true' && (await page.getByRole('dialog').textContent()).includes('2個以上選択 → 再生位置へ'));
  await page.keyboard.press('Escape');
  check('no uncaught browser errors', errors.length === 0);
  await captureEvidenceScreenshot(page, `${evidence}/final.png`);
  fs.writeFileSync(`${evidence}/scope.json`, JSON.stringify({ fixture: 'two5s images at0 and5, reverse selection order', independentQA: 'mixed3track/collision/popup3viewport/bothgraph4exports are separate gates', mediaEncodes: 0 }, null, 2));
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, error.stack ?? String(error));
  if (page) await captureEvidenceScreenshot(page, `${evidence}/failure.png`).catch(() => undefined);
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await suite.cleanup(); });
