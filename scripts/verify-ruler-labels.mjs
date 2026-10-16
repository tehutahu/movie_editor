/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite = verification('ruler-labels', 3103);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = [];
let page;
function check(name, condition = true) {
  assert(condition, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/browser-results.json`, JSON.stringify({ checks, errors }, null, 2));
}
(async () => {
  ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=4', '-c:v', 'libx264', `${evidence}/source.mp4`]);
  await suite.start();
  const browser = await suite.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);
  await page.locator('.asset-card').waitFor();
  await page.waitForFunction(() => !document.querySelector('.asset-library input').disabled);
  await page.locator('.asset-card').dragTo(page.locator('.timeline-track-row').last(), { targetPosition: { x: 48, y: 30 } });
  await page.locator('.timeline-clip').waitFor();
  await page.getByRole('button', { name: '新しい保存版を保存', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.busy-banner'));
  const versions = await (await page.request.get(`${baseURL}/api/projects`)).json();
  const template = await (await page.request.get(`${baseURL}/api/projects/${versions.projects.at(-1).id}`)).json();
  for (const duration of [600, 3600]) {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    const slider = page.locator('.timeline-toolbar-right input[type=range]');
    await slider.focus(); await page.keyboard.press('Home');
    const documentData = structuredClone(template);
    documentData.project.compositionDurationSec = duration;
    const fixture = `${evidence}/project-${duration}.json`;
    fs.writeFileSync(fixture, JSON.stringify(documentData));
    await page.locator('.project-persistence input[type=file]').setInputFiles(fixture);
    await page.waitForFunction(duration => parseFloat(document.querySelector('.timeline-ruler').style.width) === (duration + 2) * 20 + 48, duration);
    const measure = () => page.evaluate(() => {
      const ruler = document.querySelector('.timeline-ruler');
      const scroll = document.querySelector('.timeline-scroll');
      const marks = [...ruler.querySelectorAll('.timeline-ruler-mark')].map(element => {
        const rect = element.getBoundingClientRect();
        return { text: element.textContent, left: rect.left, right: rect.right, coordinate: parseFloat(element.style.left) };
      });
      return { marks, width: parseFloat(ruler.style.width), scrollWidth: scroll.scrollWidth };
    });
    let measured = await measure();
    assert.equal(measured.marks.length, duration / 5 + 1);
    assert.equal(measured.marks[0].text, '0s');
    assert.equal(measured.marks.at(-1).text, `${duration}s`);
    assert(measured.marks.every((mark, index) => mark.coordinate === index * 5 * 20 + 48));
    check(`${duration}s low-zoom labels retain integer seconds and original time coordinates`);
    const noOverlap = data => data.marks.every((mark, index) => index === 0 || mark.left >= data.marks[index - 1].right + 4);
    check(`${duration}s low-zoom labels do not overlap`, noOverlap(measured));
    check(`${duration}s ruler width and scroll extent do not grow`, measured.width === (duration + 2) * 20 + 48 && measured.scrollWidth <= Math.ceil(measured.width) + 2);
    await captureEvidenceScreenshot(page, `${evidence}/${duration}-start.png`);
    await page.locator('.timeline-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    measured = await measure();
    check(`${duration}s scrolled labels remain readable`, noOverlap(measured));
    const scroll = await page.locator('.timeline-scroll').boundingBox();
    const ruler = await page.locator('.timeline-ruler').boundingBox();
    const scrollLeft = await page.locator('.timeline-scroll').evaluate(element => element.scrollLeft);
    const x = scroll.x + 300;
    const expected = Math.min(duration, (x - scroll.x - 48 + scrollLeft) / 20);
    await page.mouse.click(x, ruler.y + 8);
    await page.waitForFunction(expected => Math.abs(parseFloat(document.querySelector('.timeline-ruler .timeline-playhead').style.left) - 48 - expected * 20) < 0.02, expected);
    check(`${duration}s scrolled ruler seek retains the original mapping`);
    await captureEvidenceScreenshot(page, `${evidence}/${duration}-end.png`);
    await page.close();
  }
  check('no uncaught runtime errors', errors.length === 0);
})().catch(async error => {
  console.error(error); fs.writeFileSync(`${evidence}/failure.txt`, String(error.stack ?? error));
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failure.png` }).catch(() => { /* Keep original error. */ });
  process.exitCode = 1;
}).finally(() => suite.cleanup());
