/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { visiblePointerPoint, dragToVisibleTarget } from './browser-pointer.mjs';
const suite = verification('empty-tracks', 3147);
const { evidence, baseURL, ff } = suite;
let page;
const checks = [], errors = [], forbiddenMediaRequests = [];
function check(name, condition = true) {
  assert(condition, name); checks.push(name);console.log('PASS',name);
  fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors,forbiddenMediaRequests},null,2));
}
async function waitTracks(count) { await page.waitForFunction(n=>document.querySelectorAll(".track-delete-button").length===n,count); }
async function save() {
  await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  const {projects}=await (await page.request.get(`${baseURL}/api/projects`)).json();
  return (await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();
}
async function importDoc(doc,name) {
  const file=`${evidence}/${name}.json`;fs.writeFileSync(file,JSON.stringify(doc));
  await page.locator('.project-persistence input[type=file]').setInputFiles(file);
  await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  assert.deepEqual(await page.locator('.error-banner').allTextContents(),[]);
}
(async()=>{
  ff(['-y','-f','lavfi','-i','color=red:s=320x240:r=30:d=2','-c:v','libx264',`${evidence}/source.mp4`]);
  await suite.start();const browser=await suite.launch();
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{
    if(r.method()==='DELETE'||r.url().includes('/api/storage/prune')||
       (r.url().includes('/api/storage/session')&&r.postDataJSON()?.action==='release')) forbiddenMediaRequests.push({url:r.url(),method:r.method()});
  });
  await page.goto(baseURL);
  const add=page.getByTitle('トラック追加 (Ctrl+T)',{exact:true});
  const undo=page.getByTitle('Undo (Ctrl+Z)',{exact:true}),redo=page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true});
  const buttons=()=>page.locator('.track-delete-button');
  const initialDoc=await save();
  await add.click();await waitTracks(3);await undo.click();await waitTracks(2);assert(await redo.isEnabled());
  await buttons().first().focus();await page.keyboard.press('Space');await waitTracks(1);
  check('Space deletes exactly one empty track without starting playback or scrubbing',
    await buttons().count()===1&&await page.locator('.timeline-toolbar-center').innerText()==='0:00.00 / 0:30.00');
  check('successful deletion focuses the adjacent remaining track control',await buttons().first().evaluate(b=>document.activeElement===b));
  assert.equal(await buttons().first().getAttribute('aria-disabled'),'true');
  await page.keyboard.press('Enter');await page.keyboard.press('Space');
  check('last-track reason is focus-visible and keyboard deletion is guarded',
    await buttons().count()===1&&await page.locator('.track-delete-reason').innerText()==='最後のトラックは削除できません');
  await undo.click();await waitTracks(2);
  const restoredDoc=await save();
  check('one Undo restores the exact original track IDs and removes the stale success message',
    JSON.stringify(restoredDoc.project.tracks)===JSON.stringify(initialDoc.project.tracks)&&await page.locator('.track-delete-status').innerText()==='');
  await redo.click();await waitTracks(1);
  await add.click();await waitTracks(2);await undo.click();await waitTracks(1);assert(await redo.isEnabled());
  const guardedPoint=await visiblePointerPoint(page,buttons().first());
  await page.mouse.click(guardedPoint.x,guardedPoint.y);
  await page.keyboard.press('Enter');await page.keyboard.press('Space');
  check('invalid last-track attempts preserve pending Redo',await redo.isEnabled()&&await buttons().count()===1);
  await redo.click();await waitTracks(2);
  await buttons().first().focus();await page.keyboard.press('Enter');await waitTracks(1);
  check('Enter deletes once and retains a reachable focus target',await buttons().count()===1&&await buttons().first().evaluate(b=>document.activeElement===b));
  await add.click();await waitTracks(2);
  // A delayed owned upload provides a real busy state; no app test hooks.
  let releaseUpload;
  const gate=new Promise(resolve=>{releaseUpload=resolve;});
  await page.route('**/api/assets',async route=>{await gate;await route.continue();});
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);
  await page.waitForFunction(()=>Boolean(document.querySelector('.busy-banner')));
  await buttons().first().focus();
  check('busy controls expose their reason to keyboard users',await buttons().first().getAttribute('aria-disabled')==='true'&&await page.locator('.track-delete-reason').first().innerText()==='処理中です');
  await page.keyboard.press('Enter');await page.keyboard.press('Space');
  assert.equal(await buttons().count(),2);releaseUpload();
  await page.locator('.asset-card').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  await page.unroute('**/api/assets');
  await dragToVisibleTarget(page, page.locator('.asset-card'), page.locator('.timeline-track-row').first(),{targetPosition:{x:48,y:30}});
  await page.locator('.timeline-clip').waitFor();
  await buttons().first().focus();await page.keyboard.press('Space');
  check('occupied-track deletion stays disabled with a keyboard-readable reason',await buttons().count()===2&&await page.locator('.track-delete-reason').first().innerText()==='クリップがあるトラックは削除できません');
  await add.click();await waitTracks(3);await add.click();await waitTracks(4);
  const template=await save();
  for(const contain of [false,true]) {
    const doc=structuredClone(template);doc.version=contain?2:1;
    doc.project.tracks.forEach((t,i)=>{t.order=[0,2,7,20][i];});
    if(contain)doc.project.clips[0].layoutMode='contain';
    await importDoc(doc,contain?'contain-gaps':'legacy-gaps');
    await page.waitForFunction(()=>{
      const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;
      return p[0]>200&&p[1]<40;
    });
    const pixels=await page.locator('canvas').evaluate(c=>c.toDataURL());
    const xBefore=await page.locator('.timeline-ruler .timeline-playhead').evaluate(e=>parseFloat(e.style.left));
    await buttons().filter({hasText:'削除'}).nth(2).click();await waitTracks(3);
    check(`${contain?'v2':'v1'} deletion rank-compresses gaps and preserves the 48px ruler/clip origin`,
      JSON.stringify(await page.locator('.timeline-track-label > span:first-child').allTextContents())===JSON.stringify(['T1','T2','T3'])&&
      await page.locator('.timeline-track-label').first().evaluate(e=>e.getBoundingClientRect().width)===48&&
      await page.locator('.timeline-ruler .timeline-playhead').evaluate(e=>parseFloat(e.style.left))===xBefore&&
      await page.locator('.timeline-clip').evaluate(e=>parseFloat(e.style.left))===48);
    await page.waitForTimeout(100);
    check(`${contain?'v2':'v1'} existing clip preview pixels remain unchanged`,await page.locator('canvas').evaluate(c=>c.toDataURL())===pixels);
    const saved=await save(),expectedTracks=doc.project.tracks.filter((_,i)=>i!==2).map((t,order)=>({...t,order}));
    assert.deepEqual(saved.project.tracks,expectedTracks);
    assert.deepEqual({...saved.project,tracks:doc.project.tracks},doc.project);
    check(`${contain?'v2':'v1'} save preserves media hashes, clip geometry and composition`);
    await importDoc(saved,contain?'contain-roundtrip':'legacy-roundtrip');
    check(`${contain?'v2':'v1'} immutable saved result imports with the same remaining tracks`,await buttons().count()===3);
  }
  // Addition uses the selected clip's track. Removing a preceding empty track
  // changes that track's visible T-number, so an old T-number notice must expire.
  const integration=structuredClone(template);
  integration.project.tracks.forEach((t,i)=>{t.order=i*2;});
  integration.project.clips[0].trackId=integration.project.tracks[2].id;
  await importDoc(integration,'asset-rank-integration');
  await page.locator('.timeline-clip').click({position:{x:20,y:10}});
  const assetAdd=page.locator('.asset-add-button');
  await page.waitForFunction(()=>document.querySelector('.asset-add-button').textContent.includes('T5'));
  await assetAdd.click();
  await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===2&&document.querySelector('.asset-add-status').textContent.includes('T5'));
  await buttons().first().click();await waitTracks(3);
  await page.waitForFunction(()=>document.querySelector('.asset-add-status').textContent==='');
  check('rank compression updates the asset-add target and expires its obsolete T-number notice',
    (await assetAdd.innerText()).includes('T2'));
  await page.waitForFunction(()=>{
    const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;
    return p[0]>200&&p[1]<40;
  });
  await captureEvidenceScreenshot(page,`${evidence}/empty-track-controls.png`);
  check('track deletion never requests media release, pruning or saved-version deletion',forbiddenMediaRequests.length===0);
  check('no uncaught browser runtime errors',errors.length===0);
})().catch(async e=>{
  console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));
  if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Keep the original failure. */ });
  process.exitCode=1;
}).finally(()=>suite.cleanup());
