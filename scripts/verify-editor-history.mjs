/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite = verification('history', 3100);
const { evidence, baseURL, ff, verifyExport } = suite;
let page;
(async () => {
    ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-c:a', 'aac', evidence + '/synthetic.mp4']);
    await suite.start();
    const browser = await suite.launch();
    const checks = [];
    const check = (name, value) => { assert(value, name); checks.push(name); fs.writeFileSync(evidence + '/browser-results.json', JSON.stringify({ checks }, null, 2)); console.log('PASS ' + name); };
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseURL);
    await page.evaluate(() => {
        window.__historyPhysicalKeys = [];
        window.addEventListener('keydown', e => {
            if (e.code === 'KeyZ') window.__historyPhysicalKeys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, trusted: e.isTrusted });
        }, true);
    });
    const physicalZ = async (modifier, { shift = false, uppercase = false } = {}) => {
        await page.keyboard.down(modifier);
        if (shift) await page.keyboard.down('Shift');
        try { await page.keyboard.press(uppercase ? 'Z' : 'KeyZ'); }
        finally { if (shift) await page.keyboard.up('Shift'); await page.keyboard.up(modifier); }
        const keys = await page.evaluate(() => window.__historyPhysicalKeys);
        const event = keys.at(-1);
        assert.deepEqual(event, { key: shift || uppercase ? 'Z' : 'z', code: 'KeyZ', ctrl: modifier === 'Control', meta: modifier === 'Meta', shift, trusted: true });
        fs.writeFileSync(evidence + '/physical-keys.json', JSON.stringify(keys, null, 2));
    };
    await page.getByRole('heading', { name: /マルチトラック動画エディタ/ }).waitFor();
    check('editor header', true);
    check('preview canvas', await page.locator('canvas').count() === 1);
    await page.locator('.asset-library input[type=file]').setInputFiles(evidence + '/synthetic.mp4');
    await page.locator('.asset-card').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.asset-library input').disabled);
    check('synthetic video upload', await page.locator('.asset-card').count() === 1);
    await page.locator('.asset-card').dragTo(page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
    await page.locator('.timeline-clip').waitFor();
    check('drag video to timeline', await page.locator('.timeline-clip').count() === 1);
    const undo = page.getByTitle('Undo (Ctrl+Z)', { exact: true }), redo = page.getByTitle('Redo (Shift+Ctrl+Z)', { exact: true });
    // A resize preview may exceed the source, while the resolved edit is
    // unchanged. Exercise the real pointer → store → command path with Redo.
    await page.locator('.timeline-clip').click({ position: { x: 50, y: 20 } });
    await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.busy-banner'));
    await page.getByTitle('複製 (Ctrl+D)', { exact: true }).click();
    assert.equal(await page.locator('.timeline-clip').count(), 2);
    await undo.click();
    assert.equal(await page.locator('.timeline-clip').count(), 1);
    const initialWidth = await page.locator('.timeline-clip').evaluate(e => parseFloat(e.style.width));
    const persistenceBefore = await page.locator('.project-persistence').innerText();
    const resizeGestures = [];
    const dragEnd = async (delta, returnToStart = false) => {
        const target = page.locator('.timeline-clip-resize');
        await target.scrollIntoViewIfNeeded();
        const handle = await target.boundingBox();
        assert(handle, 'resize handle has layout bounds');
        const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
        const viewport = page.viewportSize();
        assert(x > 0 && x < viewport.width && y > 0 && y < viewport.height, 'resize handle centre is inside viewport');
        assert(await target.evaluate((el, { x, y }) => document.elementFromPoint(x, y) === el, { x, y }), 'real pointer reaches the resize handle');
        const before = { width: await page.locator('.timeline-clip').evaluate(e => e.style.width), redo: await redo.isEnabled() };
        await page.mouse.move(x, y); await page.mouse.down();
        if (delta) await page.mouse.move(x + delta, y, { steps: 5 });
        if (returnToStart) await page.mouse.move(x, y, { steps: 5 });
        await page.mouse.up();
        const after = { width: await page.locator('.timeline-clip').evaluate(e => e.style.width), redo: await redo.isEnabled() };
        resizeGestures.push({ delta, returnToStart, handle, viewport, before, after });
        fs.writeFileSync(evidence + '/resize-gestures.json', JSON.stringify(resizeGestures, null, 2));
    };
    await dragEnd(80);
    check('source-end clamped resize preserves clip length and pending Redo',
        await redo.isEnabled() && await page.locator('.timeline-clip').evaluate(e => parseFloat(e.style.width)) === initialWidth);
    check('source-end clamped resize preserves the saved document clean state',
        await page.locator('.project-persistence').innerText() === persistenceBefore);
    await captureEvidenceScreenshot(page, evidence + '/noop-resize-redo.png');
    await redo.click();
    check('Redo after clamped resize restores the duplicate', await page.locator('.timeline-clip').count() === 2);
    await undo.click();
    await dragEnd(0);
    await dragEnd(60, true);
    check('stationary and returned-to-origin resize retain pending Redo', await redo.isEnabled());
    await dragEnd(-80);
    check('actual resize changes length and invalidates stale Redo',
        await redo.isDisabled() && Math.abs(await page.locator('.timeline-clip').evaluate(e => parseFloat(e.style.width)) - initialWidth + 80) < .01);
    await undo.click();
    check('one Undo restores the actual resize original length',
        await page.locator('.timeline-clip').evaluate(e => parseFloat(e.style.width)) === initialWidth);
    await redo.click();
    check('one Redo reapplies the actual resize',
        Math.abs(await page.locator('.timeline-clip').evaluate(e => parseFloat(e.style.width)) - initialWidth + 80) < .01);
    await undo.click();
    const add = page.getByTitle('トラック追加 (Ctrl+T)');
    const seek = async (sec) => { await page.locator('.timeline-ruler').click({ position: { x: 48 + sec * 80, y: 8 } }); };
    let trackCount;
    const pending = async () => { trackCount = await page.locator('.timeline-track-row').count(); await add.click(); assert.equal(await page.locator('.timeline-track-row').count(), trackCount + 1, 'add track'); await undo.click(); assert.equal(await page.locator('.timeline-track-row').count(), trackCount, 'Undo add track'); assert(await redo.isEnabled(), 'pending redo'); };
    const restore = async () => { await redo.click(); assert.equal(await page.locator('.timeline-track-row').count(), trackCount + 1, 'Redo restores exact track count'); };
    const verify = async (name, action) => { await pending(); await action(); check(name, await redo.isEnabled()); await restore(); check(name + ' restores edit', await page.locator('.timeline-track-row').count() === trackCount + 1); };
    await verify('frame step preserves Redo', async () => page.getByTitle('1フレーム進む (→)', { exact: true }).click());
    await verify('seek preserves Redo', async () => seek(1));
    await verify('clip click preserves Redo', async () => page.locator('.timeline-clip').click({ position: { x: 50, y: 20 } }));
    await verify('additive selection preserves Redo', async () => page.locator('.timeline-clip').click({ position: { x: 50, y: 20 }, modifiers: ['Control'] }));
    await page.locator('.timeline-clip').click({ position: { x: 50, y: 20 } });
    await seek(6);
    await pending();
    await page.locator('canvas').click({ position: { x: 10, y: 10 } });
    check('preview background clears selection', await page.locator('.timeline-clip--selected').count() === 0);
    check('clear selection preserves Redo', await redo.isEnabled());
    await restore();
    await seek(0);
    await pending();
    await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
    await page.waitForFunction(() => { const text = document.querySelector('.timeline-toolbar-center').textContent; return !text.startsWith('0:00.00'); });
    await page.getByTitle('再生 / 一時停止 (Space)', { exact: true }).click();
    check('playback preserves Redo', await redo.isEnabled());
    await restore();
    await page.locator('.timeline-clip').click({ position: { x: 50, y: 20 } });
    await seek(2);
    await page.getByTitle('分割 (Ctrl+X)').click();
    check('split video at 2s', await page.locator('.timeline-clip').count() === 2);
    await undo.click();
    await seek(1);
    await page.locator('.timeline-clip').click({ position: { x: 50, y: 20 } });
    check('split remains redoable after seek/select', await redo.isEnabled());
    await page.keyboard.press('Control+Shift+z');
    check('keyboard Redo restores split', await page.locator('.timeline-clip').count() === 2);
    for (const modifier of ['Control', 'Meta']) {
        await physicalZ(modifier);
        check(`${modifier} physical lowercase Undo restores one clip`, await page.locator('.timeline-clip').count() === 1 && await redo.isEnabled());
        await physicalZ(modifier, { shift: true });
        check(`${modifier}+Shift+KeyZ produces uppercase Z and redoes the split`, await page.locator('.timeline-clip').count() === 2 && await redo.isDisabled());
        await physicalZ(modifier, { uppercase: true });
        check(`${modifier} uppercase Z without Shift still performs Undo`, await page.locator('.timeline-clip').count() === 1 && await redo.isEnabled());
        await page.keyboard.press(`${modifier}+Shift+z`);
        const legacy = await page.evaluate(() => window.__historyPhysicalKeys.at(-1));
        assert.equal(legacy.key, 'z'); assert.equal(legacy.shift, true);
        check(`${modifier} lowercase shifted legacy Redo remains supported`, await page.locator('.timeline-clip').count() === 2 && await redo.isDisabled());
        const before = await page.locator('.timeline-clip').evaluateAll(es => es.map(e => e.getAttribute('style')));
        await physicalZ(modifier, { shift: true });
        assert.deepEqual(await page.locator('.timeline-clip').evaluateAll(es => es.map(e => e.getAttribute('style'))), before);
        check(`${modifier} shifted Redo with an empty Redo stack leaves the project unchanged`, await redo.isDisabled());
    }
    await undo.click();
    await seek(1);
    await page.getByTitle('分割 (Ctrl+X)').click();
    check('new split invalidates old Redo', await redo.isDisabled());
    await undo.click();
    await seek(2);
    await page.getByTitle('分割 (Ctrl+X)').click();
    const payloadPromise = page.waitForRequest(r => r.url().endsWith('/api/jobs/export-composition') && r.method() === 'POST');
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.getByTitle('全体書き出し (Ctrl+E)').click();
    const payload = (await payloadPromise).postDataJSON();
    fs.writeFileSync(evidence + '/export-payload.json', JSON.stringify(payload, null, 2));
    const download = await downloadPromise;
    await download.saveAs(evidence + '/browser-export.mp4');
    verifyExport(evidence + '/browser-export.mp4', { width: 1920, height: 1440, duration: 10, source: evidence + '/synthetic.mp4' });
    check('real ffmpeg composition download, complete decode, source image and tone', true);
    check('export contains split clips', payload.clips.length === 2);
    const [left, right] = payload.clips;
    assert.equal(left.timelineStartSec, 0);
    assert.equal(left.parts[0].sourceInSec, 0);
    assert(Math.abs(left.durationSec - 2) < 1 / 30, 'split occurs at requested frame');
    assert.equal(right.timelineStartSec, left.durationSec);
    assert.equal(right.parts[0].sourceInSec, left.parts[0].sourceOutSec);
    assert.equal(right.parts[0].sourceOutSec, 4);
    assert.equal(left.durationSec + right.durationSec, 4);

    check('export preserves source aspect ratio', payload.compositionWidth / payload.compositionHeight === 320 / 240);
    await seek(1);
    await captureEvidenceScreenshot(page, evidence + '/after.png');
    check('no uncaught browser errors', errors.length === 0);
    fs.writeFileSync(evidence + '/browser-results.json', JSON.stringify({ checks, errors }, null, 2));
    console.log('TOTAL ' + checks.length + ' browser checks passed');
})().catch(async (e) => {
    console.error(e);
    fs.writeFileSync(evidence + '/failure.txt', String(e.stack ?? e));
    if (page && !page.isClosed())
        await page.screenshot({ path: evidence + '/failure.png', fullPage: true }).catch(() => { /* Preserve the original error if screenshot is unavailable. */ });
    process.exitCode = 1;
}).finally(() => suite.cleanup());
