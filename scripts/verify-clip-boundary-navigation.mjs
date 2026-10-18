/* global document, window, KeyboardEvent */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';

const suite = verification('clip-boundary-navigation', 3191);
const { evidence, baseURL } = suite;
const checks = [], errors = [];
let page;
const check = (name, value = true) => {
  assert(value, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({ checks, errors }, null, 2));
};
const watchdog = setTimeout(() => {
  fs.writeFileSync(`${evidence}/failure.txt`, 'Boundary navigation exceeded its 90-second budget');
  suite.cleanup().finally(() => process.exit(1));
}, 90000);
watchdog.unref();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

(async () => {
  await suite.start();
  const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(baseURL);
  const input = page.getByRole('textbox', { name: '再生位置', exact: true });
  const play = page.getByTitle('再生 / 一時停止 (Space)', { exact: true });
  const undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true });
  const redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
  const position = () => page.locator('.timeline-playhead').first().evaluate(el => (parseFloat(el.style.left) - 48) / 80);
  const expectPosition = value => page.waitForFunction(value => Math.abs((parseFloat(document.querySelector('.timeline-playhead').style.left) - 48) / 80 - value) < 1e-8, value);
  async function seek(value) { await input.fill(String(value)); await input.press('Enter'); await expectPosition(value); await play.focus(); }
  async function key(value) { await play.focus(); await page.keyboard.press(value); }
  async function save() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    const list = await (await page.request.get(`${baseURL}/api/projects`)).json();
    return (await page.request.get(`${baseURL}/api/projects/${list.projects.at(-1).id}`)).json();
  }
  await play.focus(); await page.keyboard.press('Shift+ArrowRight');
  await expectPosition(0); check('empty project has no fabricated composition-end target');
  await play.click(); await page.waitForTimeout(80);
  const emptyPlaying = await position(); await page.keyboard.press('Shift+ArrowLeft'); await page.waitForTimeout(80);
  check('event with no boundary target preserves ongoing playback', await play.textContent() === '⏸' && await position() > emptyPlaying);
  await page.keyboard.press('Space');
  await page.locator('.asset-upload-btn input').setInputFiles({ name: 'boundary.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => document.querySelector('.asset-add-button') && !document.querySelector('.asset-add-button').disabled);
  // Fixed, legal setup: image duration5; D after the first two additions is10
  // then11. Third start11 is in that current domain. Outer points:0,5,6,11,16.
  for (const start of [0, 6, 11]) {
    await seek(start); await page.locator('.asset-add-button').click();
  }
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 3);
  await seek(4); const before = await save();
  await key('Shift+ArrowRight'); await expectPosition(5);
  await key('Shift+ArrowRight'); await expectPosition(6);
  await key('Shift+ArrowLeft'); await expectPosition(5);
  check('real Shift arrows visit strict outer endpoints across gaps');
  const frameBefore = await page.evaluate(() => ({ left: document.querySelector('.timeline-playhead').style.left, publicPosition: document.querySelector('.exact-seek input').value }));
  await key('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.exact-seek input').value === '5.033333');
  const frameAfter = await page.evaluate(() => ({ left: document.querySelector('.timeline-playhead').style.left, publicPosition: document.querySelector('.exact-seek input').value }));
  fs.writeFileSync(`${evidence}/plain-frame-observation.json`, JSON.stringify({ before: frameBefore, after: frameAfter, pixelsPerSecond: 80, expectedPublicPosition: '5.033333', expectedStateReferenceOnly: 5 + 1 / 30 }, null, 2));
  check('plain frame step matches its fixed public display and advances the coarse ruler', frameAfter.publicPosition === '5.033333' && parseFloat(frameAfter.left) > parseFloat(frameBefore.left));
  await key('ControlOrMeta+ArrowLeft'); await expectPosition(0);
  await key('ControlOrMeta+ArrowRight'); await expectPosition(16);
  check('plain frame step and modifier composition endpoints retain their meanings');
  await seek(4);
  const repeat = await play.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight', shiftKey: true, repeat: true })));
  await expectPosition(4); check('repeat is consumed without moving', repeat === false);
  for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
    await play.evaluate((el, flags) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight', shiftKey: true, ...flags })), flags);
    await expectPosition(4);
  }
  check('synthetic IME and key229 do not fall through to frame stepping');
  await page.evaluate(() => {
    window.__boundaryPreventedEvent = null;
    const preventBoundary = e => {
      if (e.key !== 'ArrowRight' || !e.shiftKey) return;
      e.preventDefault();
      window.__boundaryPreventedEvent = { key: e.key, shiftKey: e.shiftKey, defaultPrevented: e.defaultPrevented, isTrusted: e.isTrusted };
      document.removeEventListener('keydown', preventBoundary, true);
    };
    document.addEventListener('keydown', preventBoundary, true);
  });
  await key('Shift+ArrowRight');
  const prevented = await page.evaluate(() => { const event = window.__boundaryPreventedEvent; delete window.__boundaryPreventedEvent; return event; });
  fs.writeFileSync(`${evidence}/default-prevented-event.json`, JSON.stringify(prevented, null, 2));
  check('target Shift ArrowRight is actually prevented', prevented?.key === 'ArrowRight' && prevented.shiftKey && prevented.defaultPrevented && prevented.isTrusted);
  await expectPosition(4); check('already prevented boundary event does not move');
  await input.fill('4'); await input.press('Home'); await input.press('Shift+ArrowRight');
  check('native text selection remains inside the exact-position input', await input.evaluate(el => el.selectionStart === 0 && el.selectionEnd === 1) && await position() === 4);
  await input.press('Escape'); await seek(4);
  await play.click(); await page.waitForTimeout(100); await page.keyboard.press('Shift+ArrowRight'); await expectPosition(5); await page.waitForTimeout(120);
  check('valid jump synchronously stops playback ticks at its adopted boundary', await play.textContent() === '▶' && await position() === 5);
  await seek(15.2); await play.click(); await page.waitForTimeout(70);
  await page.keyboard.press('Shift+ArrowLeft'); await expectPosition(11);
  check('backward valid jump also stops playback', await play.textContent() === '▶');
  await seek(0); await key('Shift+ArrowLeft'); await expectPosition(0);
  check('no previous boundary at exact zero leaves state unchanged');
  await page.getByRole('button', { name: 'ヘルプ', exact: true }).click();
  await page.keyboard.press('Shift+ArrowRight'); await expectPosition(0);
  check('help owns keyboard and exposes the new shortcut', (await page.getByRole('dialog').textContent()).includes('Shift+← / Shift+→'));
  await page.keyboard.press('Escape');
  await seek(4); await page.getByRole('button', { name: 'プレビューを最大画面', exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.keyboard.press('Shift+ArrowRight'); await expectPosition(5);
  check('fullscreen uses the same boundary shortcut');
  await page.evaluate(() => document.exitFullscreen()); await input.waitFor();
  await page.getByTitle('複製 (Ctrl+D)', { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 4);
  await undo.click(); await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 3);
  await seek(4); await key('Shift+ArrowRight'); await expectPosition(5);
  check('jump preserves pending Redo and document dirty key', await redo.isEnabled() && (await page.locator('.project-persistence strong').textContent()) === '変更なし');
  const after = await save(); check('saved DTO and source references remain exactly unchanged', JSON.stringify(after) === JSON.stringify(before));
  for (const [width, height] of [[1280, 720], [1440, 1000], [1800, 1050]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'ヘルプ', exact: true }).click();
    const item = page.getByRole('dialog').locator('li').filter({ hasText: 'Shift+← / Shift+→' });
    await item.scrollIntoViewIfNeeded(); check(`${width}x${height} new help entry is reachable`, await item.isVisible());
    await page.keyboard.press('Escape');
    check(`${width}x${height} help close returns focus`, await page.getByRole('button', { name: 'ヘルプ', exact: true }).evaluate(el => el === document.activeElement));
  }
  check('no runtime errors', errors.length === 0);
  await captureEvidenceScreenshot(page, `${evidence}/final.png`);
  fs.writeFileSync(`${evidence}/limitations.json`, JSON.stringify({ preciseAdjacentDoubleProof: 'Independent React state harness/pure tests; DOM ruler here proves coarse positions only', syntheticIME: 'Event guards only; physical IME not claimed', noMediaEncode: true }, null, 2));
  const bytes = fs.readdirSync(evidence, { recursive: true }).reduce((sum, name) => { const p = `${evidence}/${name}`; return sum + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  check('new suite raw stays below16MiB', bytes <= 16 * 1024 * 1024);
})().catch(async error => {
  fs.writeFileSync(`${evidence}/failure.txt`, error.stack ?? String(error));
  if (page) await captureEvidenceScreenshot(page, `${evidence}/failure.png`).catch(() => undefined);
  process.exitCode = 1;
}).finally(async () => { clearTimeout(watchdog); await suite.cleanup(); });
