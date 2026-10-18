/* global document, structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { visiblePointerPoint, dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('asset-addition', 3106);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = [];
let page;
function check(name, ok = true) {
  assert(ok, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/browser-results.json`, JSON.stringify({ checks, errors }, null, 2));
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:rate=30:duration=2', '-c:v', 'libx264', `${evidence}/source.mp4`]);
  ff(['-y', '-f', 'lavfi', '-i', 'color=blue:size=320x240', '-frames:v', '1', `${evidence}/still.png`]);
  await suite.start(); const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator('.asset-upload-btn input').setInputFiles([`${evidence}/source.mp4`, `${evidence}/still.png`]);
  await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2 && !document.querySelector('.asset-upload-btn input').disabled);
  const video = () => page.getByRole('button', { name: /^sourceをT\d+の再生位置へ追加$/ });
  const image = () => page.getByRole('button', { name: /^stillをT\d+の再生位置へ追加$/ });
  const undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true }), redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
  const count = () => page.locator('.timeline-clip').count();
  const waitCount = n => page.waitForFunction(n => document.querySelectorAll('.timeline-clip').length === n, n);
  async function snapshot() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    const list = await (await page.request.get(`${baseURL}/api/projects`)).json();
    return (await page.request.get(`${baseURL}/api/projects/${list.projects.at(-1).id}`)).json();
  }
  check('native button names expose the current T1 target', await video().textContent() === 'T1の再生位置へ追加');
  await video().focus(); await page.keyboard.press('Space'); await waitCount(1);
  await page.waitForTimeout(200);
  check('Space adds exactly one clip without starting playback', await count() === 1 && await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).textContent() === '▶');
  await page.getByRole('status').filter({ hasText: 'T1の0秒へ追加しました。' }).waitFor();
  const first = await snapshot();
  check('first button addition uses video duration, default stretch and auto source aspect', first.project.clips[0].durationSec === 2 && !first.project.clips[0].layoutMode && first.project.compositionWidth === 1920 && first.project.compositionHeight === 1440);
  await undo.click(); await waitCount(0);
  check('one Undo removes the addition and its success status', await page.locator('.asset-add-status').textContent() === '');
  const empty = await snapshot();
  check('one Undo also restores the initial composition dimensions', empty.project.compositionWidth === 1920 && empty.project.compositionHeight === 1080);
  await video().focus(); await page.keyboard.press('Tab');
  check('focus navigation preserves pending Redo and clean document', await redo.isEnabled() && await page.locator('.project-persistence strong').textContent() === '変更なし');
  await redo.click(); await waitCount(1);
  await video().focus(); await page.keyboard.press('Enter'); await waitCount(2);
  check('Enter performs one addition and reports the resolved 2s position', await count() === 2);
  await page.locator('.asset-add-status').filter({ hasText: 'T1の2秒へ追加しました。' }).waitFor();
  await video().click(); await waitCount(3);
  const repeated = await snapshot();
  check('repeated click uses common non-overlap placement without moving earlier clips', JSON.stringify(repeated.project.clips.map(c => c.timelineStartSec)) === '[0,2,4]');

  async function load(doc, name) {
    // Each fixture gets its own page so no confirmation race changes the test.
    await page.close(); page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message)); await page.goto(baseURL);
    const file = `${evidence}/${name}.json`; fs.writeFileSync(file, JSON.stringify(doc));
    await page.locator('.project-persistence input[type=file]').setInputFiles(file);
    await page.locator('.project-persistence p[role=status]').filter({ hasText: '読み込み済み' }).waitFor();
  }
  const tracks = [...first.project.tracks].sort((a, b) => a.order - b.order);
  const t1 = tracks[0].id, t2 = tracks[1].id;
  const block = (start, duration, trackId) => ({ ...structuredClone(first.project.clips[0]), id: randomUUID(), trackId, timelineStartSec: start, durationSec: duration,
    parts: [{ assetId: first.project.assets.find(a => a.kind === 'image').id, sourceInSec: 0, sourceOutSec: duration }] });
  const mixed = structuredClone(first); mixed.project.clips = [block(0, 4, t1), block(4, 2, t1), block(0, 2, t2)];
  await load(mixed, 'two-tracks');
  const seek = async sec => {
    const point = await visiblePointerPoint(page, page.locator('.timeline-scroll'), { x: 48 + sec * 80, y: 8 });
    await page.mouse.click(point.x, point.y);
  };
  await seek(3.95); await video().click(); await waitCount(4);
  await page.locator('.asset-add-status').filter({ hasText: 'T1の6秒へ追加しました。' }).waitFor();
  const collision = await snapshot();
  check('adjacent blockers resolve to 6s with truthful status and unchanged blockers', collision.project.clips.at(-1).timelineStartSec === 6 && collision.project.clips[0].timelineStartSec === 0 && collision.project.clips[1].timelineStartSec === 4);
  await page.locator('.timeline-track-row').nth(1).locator('.timeline-clip').click();
  check('selected T2 clip changes the visible and accessible target', await video().textContent() === 'T2の再生位置へ追加');
  await page.locator('.timeline-track-row').nth(0).locator('.timeline-clip').first().click({ modifiers: ['Control'] });
  check('multiple-track selection keeps the first selected track', await video().textContent() === 'T2の再生位置へ追加');
  await image().focus(); await page.keyboard.press('Space'); await waitCount(5);
  const imageAdded = await snapshot();
  check('keyboard image addition uses selected T2, five seconds, existing composition', imageAdded.project.clips.at(-1).trackId === t2 && imageAdded.project.clips.at(-1).durationSec === 5 && imageAdded.project.compositionWidth === mixed.project.compositionWidth);

  const zero = structuredClone(first); zero.project.tracks = []; zero.project.clips = [];
  await load(zero, 'no-track');
  check('zero tracks disables addition and explains the existing plus action', await page.locator('.asset-add-button').first().isDisabled() && await page.getByText('＋でトラックを追加してください。', { exact: true }).isVisible());
  await page.getByTitle('トラック追加 (Ctrl+T)', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.asset-add-button').disabled);
  check('adding an empty track re-enables the current T1 action', await video().isEnabled());
  // A pointer drag beginning on the button must not become an asset-card drag.
  const point = await visiblePointerPoint(page, video()); const row = await page.locator('.timeline-track-row').first().boundingBox();
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(row.x + 160, row.y + 20, { steps: 12 }); await page.mouse.up();
  check('dragging from the native action button does not create a clip', await count() === 0);
  await dragToVisibleTarget(page, page.locator('.asset-card').filter({ hasText: 'source' }), page.locator('.timeline-track-row').first(), { targetPosition: { x: 48, y: 30 } });
  await waitCount(1); check('existing card drag/drop still adds one clip', await count() === 1);
  // Hold upload in flight: the button follows actual busy state.
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/assets', async route => { await held; await route.continue(); });
  await page.locator('.asset-upload-btn input').setInputFiles(`${evidence}/still.png`);
  await page.waitForFunction(() => document.querySelector('.asset-add-button').disabled);
  check('busy upload disables the action without changing existing clips', await count() === 1);
  release(); await page.waitForFunction(() => !document.querySelector('.asset-upload-btn input').disabled);
  await captureEvidenceScreenshot(page, `${evidence}/after.png`);
  check('no uncaught browser errors', errors.length === 0);
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Preserve the original failure. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
