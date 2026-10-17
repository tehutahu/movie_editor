/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('trim-prefix',3157),{evidence,baseURL,ff}=suite;
let page;const checks=[],errors=[],forbidden=[],hitTests=[];
function check(name,condition=true){assert(condition,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors,forbidden,hitTests},null,2));}
async function save(){await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const{projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
async function load(doc,name){const file=`${evidence}/${name}.json`;fs.writeFileSync(file,JSON.stringify(doc));await page.locator('.project-persistence input[type=file]').setInputFiles(file);await page.waitForFunction(()=>!document.querySelector('.busy-banner')||[...document.querySelectorAll('button')].some(b=>b.textContent==='破棄して続ける'));const discard=page.getByRole('button',{name:'破棄して続ける',exact:true});if(await discard.isVisible())await discard.click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));assert.deepEqual(await page.locator('.error-banner').allTextContents(),[]);}
async function exportProject(project,name){
  const response=await page.request.post(`${baseURL}/api/jobs/export-composition`,{data:{...project,assets:project.assets.map(a=>({...a,storageAssetId:a.media.id}))}});
  assert(response.ok(),await response.text());const{jobId}=await response.json();
  for(let i=0;i<160;i++){
    const job=await(await page.request.get(`${baseURL}/api/jobs/${jobId}`)).json();if(job.status==='error')throw Error(job.error);
    if(job.status==='done'){
      const downloaded=await page.request.get(`${baseURL}/api/download/${jobId}`);assert(downloaded.ok());
      const file=`${evidence}/${name}.mp4`;fs.writeFileSync(file,await downloaded.body());ff(['-xerror','-i',file,'-f','null','-']);return file;
    }
    await page.waitForTimeout(250);
  }
  throw Error('trim export timeout');
}
async function seek(t){const b=await page.locator('.timeline-scroll').boundingBox();await page.mouse.click(b.x+48+80*t,b.y+8);}
(async()=>{
  ff(['-y','-f','lavfi','-i','testsrc2=s=320x240:r=30:d=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',`${evidence}/source.mp4`]);
  ff(['-y','-f','lavfi','-i','color=red:s=320x320','-frames:v','1',`${evidence}/image.png`]);
  await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1800,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='DELETE'||r.url().includes('/api/storage/prune')||(r.url().includes('/api/storage/session')&&r.postDataJSON()?.action==='release'))forbidden.push(r.url());});
  await page.goto(baseURL);const trim=page.locator('[data-trim-start]');
  const undo=page.getByTitle('Undo (Ctrl+Z)',{exact:true}),redo=page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true});
  await trim.focus();check('unselected control exposes a focus-visible disabled reason',await trim.getAttribute('aria-disabled')==='true'&&await page.locator('.trim-start-reason').isVisible());
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);await page.locator('.asset-card').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  await page.locator('.asset-card').dragTo(page.locator('.timeline-track-row').first(),{targetPosition:{x:48,y:30}});await page.locator('.timeline-clip').waitFor();
  const template=await save();
  for(const contain of [false,true]){
    const doc=structuredClone(template);doc.version=contain?2:1;const c=doc.project.clips[0];c.timelineStartSec=2;c.durationSec=4;
    c.parts=[{assetId:c.parts[0].assetId,sourceInSec:1,sourceOutSec:2},{assetId:c.parts[0].assetId,sourceInSec:3,sourceOutSec:6}];
    c.transform={x:.4,y:.6,scale:.8};if(contain)c.layoutMode='contain';doc.project.compositionDurationSec=12;doc.project.compositionWidth=320;doc.project.compositionHeight=320;
    await load(doc,`input-${contain}`);await trim.focus();await page.locator('.timeline-clip').click({position:{x:30,y:10}});
    const tip=await page.locator('.trim-start-reason').boundingBox(),ruler=await page.locator('.timeline-ruler').boundingBox(),scroll=await page.locator('.timeline-scroll').boundingBox();
    assert(tip&&ruler&&scroll);const left=Math.max(tip.x,ruler.x),right=Math.min(tip.x+tip.width,ruler.x+ruler.width),top=Math.max(tip.y,ruler.y),bottom=Math.min(tip.y+tip.height,ruler.y+ruler.height);
    assert(right>left&&bottom>top,'focused explanation must actually overlap the ruler');
    const x=(left+right)/2,y=(top+bottom)/2,scrollLeft=await page.locator('.timeline-scroll').evaluate(e=>e.scrollLeft),expectedSec=(x-scroll.x-48+scrollLeft)/80;
    assert(expectedSec>0&&x>=tip.x&&x<=tip.x+tip.width&&y>=tip.y&&y<=tip.y+tip.height);
    hitTests.push({mode:contain?'contain':'stretch',tip,ruler,scroll,click:{x,y},expectedSec});
    await page.mouse.click(x,y);
    await page.waitForFunction(expected=>Math.abs(parseFloat(document.querySelector('.timeline-ruler .timeline-playhead').style.left)-(48+expected*80))<.01,expectedSec);
    check(`${contain?'v2':'v1'} ruler click inside the focused explanation overlap changes the playhead after clip selection`);
    await seek(3.5);
    await trim.focus();await page.keyboard.press(contain?'Enter':'Space');
    await page.waitForFunction(()=>parseFloat(document.querySelector('.timeline-clip').style.left)===328);
    const saved=await save(),n=saved.project.clips[0];
    assert.equal(n.timelineStartSec,3.5);assert.equal(n.durationSec,2.5);assert.deepEqual(n.parts,[{assetId:c.parts[0].assetId,sourceInSec:3.5,sourceOutSec:6}]);
    assert.deepEqual({...saved.project,clips:doc.project.clips},doc.project);
    check(`${contain?'v2 contain':'v1 stretch'} keyboard trim consumes timeline prefix and preserves end, metadata, custom duration and media hashes`);
    check('keyboard trim leaves playhead and playback unchanged',(await page.locator('.timeline-toolbar-center').innerText()).startsWith('0:03.50 /'));
    await undo.click();await page.waitForFunction(()=>parseFloat(document.querySelector('.timeline-clip').style.left)===208);
    const restored=await save();assert.deepEqual(restored.project,doc.project);check('one Undo restores exact complete original project');
    for(const time of [1,2,5.975]){await seek(time);await trim.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space');assert(await redo.isEnabled());}
    check('out-of-range attempts preserve Redo and clean saved DTO',await redo.isEnabled()&&await trim.getAttribute('aria-disabled')==='true');
    assert.deepEqual((await save()).project,doc.project);
    await redo.click();await page.waitForFunction(()=>parseFloat(document.querySelector('.timeline-clip').style.left)===328);check('one Redo reapplies exactly one trim');
    const actualFile=await exportProject(saved.project,`trim-${contain}`);
    const manual=structuredClone(doc.project);manual.clips[0]={...c,timelineStartSec:3.5,durationSec:2.5,parts:[{assetId:c.parts[0].assetId,sourceInSec:3.5,sourceOutSec:6}]};
    const manualFile=await exportProject(manual,`manual-${contain}`);
    const actualFrames=ff(['-i',actualFile,'-map','0:v:0','-f','framemd5','pipe:1']);
    const manualFrames=ff(['-i',manualFile,'-map','0:v:0','-f','framemd5','pipe:1']);
    assert(actualFrames.equals(manualFrames));
    const actualAudio=ff(['-i',actualFile,'-map','0:a:0','-f','s16le','pipe:1']);
    const manualAudio=ff(['-i',manualFile,'-map','0:a:0','-f','s16le','pipe:1']);
    assert(actualAudio.equals(manualAudio));assert(actualAudio.some(byte=>byte!==0));
    check(`${contain?'contain':'stretch'} real decoded video/audio exactly match a manually specified remaining-source export`);
    await load(saved,`roundtrip-${contain}`);assert.deepEqual((await save()).project,saved.project);check(`${contain?'v2':'v1'} trimmed source references roundtrip through immutable save/import`);
  }
  await captureEvidenceScreenshot(page,`${evidence}/trim-prefix.png`);
  await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/image.png`);
  await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===2&&!document.querySelector('.busy-banner'));
  const imageDoc=await save(),image=imageDoc.project.assets.find(a=>a.kind==='image');imageDoc.version=1;
  imageDoc.project.clips=[{...imageDoc.project.clips[0],timelineStartSec:0,durationSec:2,parts:[{assetId:image.id,sourceInSec:0,sourceOutSec:2}]}];delete imageDoc.project.clips[0].layoutMode;
  await load(imageDoc,'image-prefix');await page.locator('.timeline-clip').click({position:{x:20,y:10}});await seek(.5);await trim.click();
  const imageSaved=await save();assert.deepEqual(imageSaved.project.clips[0],{...imageDoc.project.clips[0],timelineStartSec:.5,durationSec:1.5,parts:[{assetId:image.id,sourceInSec:.5,sourceOutSec:2}]});
  assert.deepEqual(imageSaved.project.assets,imageDoc.project.assets);
  check('image prefix trim preserves the media fingerprints and image-duration contract');
  check('trim never releases, prunes or deletes media',forbidden.length===0);check('no uncaught browser errors',errors.length===0);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Preserve original failure. */ });process.exitCode=1;}).finally(()=>suite.cleanup());
