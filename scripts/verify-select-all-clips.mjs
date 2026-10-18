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

const suite = verification('select-all-clips', 3194), { evidence, baseURL } = suite;
const checks = [], errors = []; let page;
function check(name, value = true) { assert(value, name); checks.push(name); console.log('PASS', name); fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2)); }
const watchdog = setTimeout(() => { fs.writeFileSync(`${evidence}/failure.txt`, 'Select all verification exceeded90s'); suite.cleanup().finally(() => process.exit(1)); }, 90000); watchdog.unref();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

(async () => {
  await suite.start(); const browser = await suite.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message)); await page.goto(baseURL);
  const input = page.getByRole('textbox', { name: '再生位置', exact: true });
  const play = page.getByTitle('再生 / 一時停止 (Space)', { exact: true }), undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true }), redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
  async function seek(value) { await input.fill(String(value)); await input.press('Enter'); await page.waitForFunction(value => document.querySelector('.exact-seek input').value === String(value), value); await play.focus(); }
  async function save() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    const { projects } = await (await page.request.get(`${baseURL}/api/projects`)).json(); return (await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();
  }
  const selected = page.locator('.timeline-clip--selected');
  await play.focus(); await page.keyboard.press('Control+a'); check('empty Ctrl+A is harmless', await selected.count() === 0 && !await undo.isEnabled());
  await page.locator('.asset-upload-btn input').setInputFiles(['select-A', 'select-B'].map(name => ({ name: `${name}.png`, mimeType: 'image/png', buffer: image })));
  await page.waitForFunction(() => document.querySelectorAll('.asset-add-button').length === 2 && !document.querySelector('.busy-banner'));
  await seek(0); await page.locator('.asset-card').filter({ hasText: 'select-A' }).getByRole('button').click();
  await seek(5); await page.locator('.asset-card').filter({ hasText: 'select-B' }).getByRole('button').click(); await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 2);
  const a = page.locator('.timeline-clip').filter({ hasText: 'select-A' });
  await a.click({ position: { x: 20, y: 12 } });
  await input.fill('2'); await input.press('Control+a'); check('native exact seek text selection is preserved', await input.evaluate(e => e.selectionStart === 0 && e.selectionEnd === e.value.length) && await selected.count() === 1); await input.press('Escape');
  await play.focus();
  const synthetic = await play.evaluate(button => {
    const cases = [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { altKey: true }];
    return cases.map(patch => { const event = new globalThis.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true, ...patch }); button.dispatchEvent(event); return { prevented: event.defaultPrevented, composing: event.isComposing, keyCode: event.keyCode }; });
  });
  fs.writeFileSync(`${evidence}/excluded-key-events.json`, JSON.stringify(synthetic, null, 2)); assert(synthetic.every(e => !e.prevented)); check('IME/229/Shift/Alt synthetic guards do not steal native events', await selected.count() === 1 && synthetic[1].keyCode === 229);
  const repeatConsumed = await play.evaluate(button => !button.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, repeat: true, bubbles: true, cancelable: true })));
  check('eligible repeat is consumed without selecting missing clips', repeatConsumed && await selected.count() === 1);
  await page.getByRole('button', { name: 'ヘルプ', exact: true }).click(); await page.keyboard.press('Control+a'); check('help scope blocks clip selection and lists the shortcut', await selected.count() === 1 && (await page.getByRole('dialog').textContent()).includes('Ctrl/Cmd+A')); await page.keyboard.press('Escape');
  const ruler = page.locator('.timeline-ruler'), point = await visiblePointerPoint(page, ruler, { x: 100, y: 10 }); await assertPointerHit(page, ruler, point);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => { globalThis.__selectionCapture = null; document.addEventListener('pointerdown', event => { globalThis.__selectionCapture = { id: event.pointerId, owner: event.target.closest('.timeline-scroll') }; }, { once: true, capture: true }); });
  await page.mouse.down();
  const capture = await page.evaluate(() => { const value = globalThis.__selectionCapture; return { pointerId: value?.id, ownerClass: value?.owner?.className, hasCapture: value?.owner?.hasPointerCapture(value.id) ?? false }; });
  fs.writeFileSync(`${evidence}/capture.json`, JSON.stringify(capture, null, 2)); assert.equal(capture.hasCapture, true);
  await play.focus(); await page.keyboard.press('Control+a'); check('stationary native ruler capture rejects selection through focus change', await selected.count() === 1); await page.mouse.up();
  await play.focus(); await page.keyboard.press('Meta+a'); await page.waitForFunction(() => document.querySelectorAll('.timeline-clip--selected').length === 2); check('release recovers and Meta+A selects every clip');
  await seek(1); const before = await save(); await play.focus(); await page.keyboard.press('Control+a'); assert.deepEqual(await save(), before); check('all-selected Ctrl+A leaves saved content unchanged');
  const move = page.locator('[data-move-to-playhead]'), movePoint = await visiblePointerPoint(page, move); await assertPointerHit(page, move, movePoint); await page.mouse.click(movePoint.x, movePoint.y);
  const moved = await save(); assert.deepEqual(moved.project.clips.map(c => c.timelineStartSec), [1, 6]); check('all-selected clips feed the existing group placement action');
  await undo.click(); assert.deepEqual(await save(), before); await play.focus(); await page.keyboard.press('Control+a'); check('view-only select all preserves pending Redo', await redo.isEnabled()); await redo.click(); assert.deepEqual(await save(), moved); check('the original group edit remains redoable');
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1800, height: 1050 }]) {
    await page.setViewportSize(viewport); await a.click({ position: { x: 20, y: 12 } }); await play.focus(); await page.keyboard.press('Control+a'); await page.waitForFunction(() => document.querySelectorAll('.timeline-clip--selected').length === 2); check(`actual Ctrl+A works at ${viewport.width}x${viewport.height}`);
  }
  check('no uncaught browser errors', errors.length === 0);
  fs.writeFileSync(`${evidence}/scope.json`, JSON.stringify({ fixture: 'two native images; sixclip media/title/missing-order model is pure/independent QA', mediaEncodes: 0, newTitleRenders: 0, nativeIMEClaim: false }, null, 2));
})().catch(async error => {
  fs.writeFileSync(`${evidence}/failure.txt`, String(error?.stack ?? error));
  if (page) await captureEvidenceScreenshot(page, `${evidence}/failure.png`).catch(() => undefined);
  throw error;
}).finally(async () => { clearTimeout(watchdog); await suite.cleanup(); });
