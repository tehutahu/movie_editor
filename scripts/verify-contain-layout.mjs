/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('contain-layout', 3137);
const { evidence, baseURL, ff } = suite;
const checks = [], errors = [];
let page;
function check(name, condition = true) {
  assert(condition, name); checks.push(name); console.log('PASS', name);
  fs.writeFileSync(`${evidence}/results.json`, JSON.stringify({checks, errors}, null, 2));
}
async function downloadJob(jobId, file, width, height) {
  for(let i=0;i<160;i++) {
    const job=await (await page.request.get(`${baseURL}/api/jobs/${jobId}`)).json();
    if(job.status==='error') throw new Error(job.error);
    if(job.status==='done') {
      const response=await page.request.get(`${baseURL}/api/download/${jobId}`);
      assert(response.ok());fs.writeFileSync(file,await response.body());
      suite.verifyExport(file,{width,height});return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('export did not finish');
}
(async () => {
  ff(['-y','-f','lavfi','-i','color=red:s=160x320:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac',`${evidence}/source.mp4`]);
  await suite.start();
  const browser = await suite.launch();
  page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);
  await page.locator('.asset-card').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.asset-library input').disabled);
  await dragToVisibleTarget(page, page.locator('.asset-card'), page.locator('.timeline-track-row').last(),{targetPosition:{x:48,y:30}});
  await page.locator('.timeline-clip').waitFor();
  await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  const versions = await (await page.request.get(`${baseURL}/api/projects`)).json();
  const doc = await (await page.request.get(`${baseURL}/api/projects/${versions.projects.at(-1).id}`)).json();
  assert.equal(doc.version,1);
  doc.project.compositionWidth=320;doc.project.compositionHeight=320;doc.project.compositionDurationSec=2;
  doc.project.clips[0].timelineStartSec=0;doc.project.clips[0].transform={x:.5,y:.5,scale:2};
  fs.writeFileSync(`${evidence}/legacy.json`,JSON.stringify(doc));
  await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/legacy.json`);
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  await page.locator('.timeline-clip').click({position:{x:20,y:10}});
  const mode = page.getByLabel('クリップの配置',{exact:true});
  await mode.selectOption('contain');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="クリップの配置"]').value==='contain'&&!document.querySelector('select[aria-label="クリップの配置"]').disabled);
  await page.waitForFunction(()=>{
    const c=document.querySelector('canvas'),ctx=c.getContext('2d');
    const center=ctx.getImageData(c.width*.5,c.height*.5,1,1).data,side=ctx.getImageData(c.width*.1,c.height*.5,1,1).data;
    return center[0]>220 && side[0]<30 && side[1]<30;
  });
  check('explicit contain keeps full portrait and transparent side margins on the shared canvas');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="クリップの配置"]').value==='stretch');
  check('one Undo restores legacy stretch');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(()=>document.querySelector('select[aria-label="クリップの配置"]').value==='contain');
  check('one Redo restores contain');
  await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  const saved = await (await page.request.get(`${baseURL}/api/projects`)).json();
  const v2 = await (await page.request.get(`${baseURL}/api/projects/${saved.projects.at(-1).id}`)).json();
  check('new immutable save uses v2 with contain, leaving legacy v1 unchanged',v2.version===2&&v2.project.clips[0].layoutMode==='contain'&&doc.version===1);
  fs.writeFileSync(`${evidence}/contain.json`,JSON.stringify(v2));
  await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/contain.json`);
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  const response = await page.request.post(`${baseURL}/api/jobs/export-composition`,{data:{...v2.project,assets:v2.project.assets.map(a=>({...a,storageAssetId:a.media.id}))}});
  assert(response.ok());
  const {jobId}=await response.json();
  await downloadJob(jobId,`${evidence}/contain.mp4`,320,320);
  check('real production contain API exports decoded mp4 at the requested size');
  const selected = await page.request.post(`${baseURL}/api/jobs/export-segment`,{data:{videoId:v2.project.assets[0].media.id,startSec:0,endSec:1}});
  assert(selected.ok());
  await downloadJob((await selected.json()).jobId,`${evidence}/source-cut.mp4`,160,320);
  check('selected single-video source cut retains native source dimensions');
  await captureEvidenceScreenshot(page,`${evidence}/contain.png`);
  check('no uncaught runtime errors',errors.length===0);
})().catch(async e=>{
  console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));
  if(page&&!page.isClosed()) await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Preserve the original failure. */ });
  process.exitCode=1;
}).finally(()=>suite.cleanup());
