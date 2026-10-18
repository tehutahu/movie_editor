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

const suite = verification('content-duration', 3193), { evidence, baseURL } = suite;
const checks = [], errors = []; let page;
function check(name, value = true) { assert(value, name); checks.push(name); console.log('PASS', name); fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2)); }
const watchdog = setTimeout(() => { fs.writeFileSync(`${evidence}/failure.txt`, 'Content duration verification exceeded90s'); suite.cleanup().finally(() => process.exit(1)); }, 90000); watchdog.unref();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

(async () => {
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message)); await page.goto(baseURL);
  const action = page.locator('[data-fit-content-duration]'), input = page.getByRole('textbox', { name: '再生位置', exact: true });
  const play = page.getByTitle('再生 / 一時停止 (Space)', { exact: true }), undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true }), redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
  async function seek(value) { await input.fill(String(value)); await input.press('Enter'); await page.waitForFunction(value => document.querySelector('.exact-seek input').value === String(value), value); await play.focus(); }
  async function save() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    const { projects } = await (await page.request.get(`${baseURL}/api/projects`)).json(); return (await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();
  }
  check('empty composition is explained', await action.getAttribute('aria-disabled') === 'true');
  await page.locator('.asset-upload-btn input').setInputFiles({ name: 'duration-image.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => document.querySelectorAll('.asset-add-button').length === 1 && !document.querySelector('.busy-banner'));
  await page.locator('.asset-add-button').click(); await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 1);
  const initial = await save(); assert.equal(initial.project.compositionDurationSec, 10); assert.equal(initial.project.clips[0].durationSec, 5);
  await seek(0); await play.click(); await page.waitForFunction(() => document.querySelector('[title="再生 / 一時停止 (Space)"]').textContent.includes('⏸'));
  const point = await visiblePointerPoint(page, action); await assertPointerHit(page, action, point); await page.mouse.click(point.x, point.y);
  check('playing owner explains and rejects duration action without pausing', await action.getAttribute('aria-disabled') === 'true' && await play.textContent() === '⏸');
  await play.click(); await seek(9); const before = await save();
  await action.focus(); const imePrevented = await action.evaluate(button => !button.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })));
  check('IME key is explicitly consumed and no edit is made', imePrevented && await input.inputValue() === '9');
  const clickPoint = await visiblePointerPoint(page, action); await assertPointerHit(page, action, clickPoint); await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForFunction(() => document.querySelector('.exact-seek input').value === '5'); const after = await save();
  assert.equal(after.project.compositionDurationSec, 5); assert.deepEqual({ ...after.project, compositionDurationSec: 10 }, before.project);
  check('one actual native click removes only tail and clamps position to content end');
  check('stopped playback stays stopped', await play.textContent() === '▶');
  await undo.click(); await page.waitForFunction(() => document.querySelector('.exact-seek input').value === '9'); assert.deepEqual(await save(), before); check('one Undo restores original D and P');
  await action.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('.exact-seek input').value === '5'); assert.deepEqual(await save(), after); check('native Enter commits one duration edit without playback', await play.textContent() === '▶');
  await undo.click(); await redo.click(); assert.deepEqual(await save(), after); check('Redo restores exact saved content duration');
  await page.locator('[data-add-track]').click(); await undo.click(); check('same-duration action is a no-op with pending Redo', await action.getAttribute('aria-disabled') === 'true' && await redo.isEnabled());
  await action.focus(); await page.keyboard.press('Space'); check('native invalid Space preserves Redo and does not start playback', await redo.isEnabled() && await play.textContent() === '▶');
  await page.getByRole('button', { name: 'ヘルプ', exact: true }).click(); check('help explains explicit tail removal', (await page.getByRole('dialog').textContent()).includes('意図した余韻も削られ')); await page.keyboard.press('Escape');
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1800, height: 1050 }]) {
    await page.setViewportSize(viewport); await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
    const p = await visiblePointerPoint(page, action); await assertPointerHit(page, action, p); check(`duration action is reachable at ${viewport.width}x${viewport.height}`);
  }
  check('no uncaught browser errors', errors.length === 0);
  fs.writeFileSync(`${evidence}/scope.json`, JSON.stringify({ fixture: 'one native image clip5s, D10 to5, P9 to5', independentQA: 'mixed video/image/fade save-load, pending owner/capture, three viewport and bothgraph4outputs separate', mediaEncodes: 0 }, null, 2));
})().catch(async error => {
  fs.writeFileSync(`${evidence}/failure.txt`, String(error?.stack ?? error));
  if (page) await captureEvidenceScreenshot(page, `${evidence}/failure.png`).catch(() => undefined);
  throw error;
}).finally(async () => { clearTimeout(watchdog); await suite.cleanup(); });
