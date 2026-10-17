/* global document, KeyboardEvent */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('clip-audio',3186),{evidence,baseURL,ff}=suite;
const checks=[],errors=[];let page,template,ids;
const check=(name,ok=true)=>{assert(ok,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors},null,2));};
const gain=()=>page.getByRole('textbox',{name:'クリップ音量 %',exact:true}),apply=()=>page.getByRole('button',{name:'音量を適用',exact:true}),silent=()=>page.getByRole('button',{name:'消音（0%）',exact:true});
const clip=id=>page.locator(`[data-clip-id="${id}"]`),undo=()=>page.getByTitle('Undo (Ctrl+Z)',{exact:true}),redo=()=>page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true});
async function save(){await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const{projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
async function load(doc,name){const file=`${evidence}/${name}.json`;fs.writeFileSync(file,JSON.stringify(doc));const response=page.waitForResponse(r=>r.url().endsWith('/api/projects/load'));await page.locator('.project-persistence input[type=file]').setInputFiles(file);assert((await response).ok());await page.waitForFunction(()=>!document.querySelector('.busy-banner'));assert.deepEqual(await page.locator('.error-banner').allTextContents(),[]);}
async function select(indices){
 const selected=await page.locator('.timeline-clip--selected').evaluateAll(es=>es.map(e=>e.getAttribute('data-clip-id')));
 for(const id of selected)await clip(id).click({position:{x:20,y:10},modifiers:['Control']});
 await clip(ids[indices[0]]).click({position:{x:20,y:10}});
 for(const i of indices.slice(1))await clip(ids[i]).click({position:{x:20,y:10},modifiers:['Control']});
 await page.waitForFunction(n=>document.querySelectorAll('.timeline-clip--selected').length===n,indices.length);
}
async function seek(sec){const input=page.getByRole('textbox',{name:'再生位置',exact:true});await input.fill(String(sec));await input.press('Enter');await input.blur();}
async function expectVolume(n){await page.waitForFunction(n=>document.querySelector('.compositor-audio-hidden').volume===n,n);}
(async()=>{
 ff(['-y','-f','lavfi','-i','color=red:s=160x120:r=30:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-c:a','aac',`${evidence}/source.mp4`]);ff(['-y','-f','lavfi','-i','color=blue:s=160x120','-frames:v','1',`${evidence}/image.png`]);
 await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1800,height:1100}});page.on('pageerror',e=>errors.push(e.message));await page.goto(baseURL);check('no selection disables volume editing',await gain().isDisabled()&&await silent().isDisabled());
 await page.locator('.asset-library input[type=file]').setInputFiles([`${evidence}/source.mp4`,`${evidence}/image.png`]);await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===2&&!document.querySelector('.busy-banner'));await page.locator('.asset-add-button').first().click();await page.locator('.timeline-clip').waitFor();template=await save();
 const v=template.project.assets.find(a=>a.kind==='video'),image=template.project.assets.find(a=>a.kind==='image'),base=template.project.clips[0];ids=[randomUUID(),randomUUID(),randomUUID()];template.version=1;Object.assign(template.project,{compositionWidth:320,compositionHeight:320,compositionDurationSec:6,clips:ids.map((id,i)=>({...base,id,timelineStartSec:i*2,durationSec:2,parts:[{assetId:(i===1?image:v).id,sourceInSec:0,sourceOutSec:2}]}))});
 await load(template,'initial');await select([0]);check('legacy clip starts at 100 percent',await gain().inputValue()==='100');
 await page.getByTitle('トラック追加 (Ctrl+T)',{exact:true}).click();await undo().click();assert(await redo().isEnabled());await gain().fill('50');check('draft editing leaves document/history unchanged',await redo().isEnabled()&&await page.locator('.project-persistence strong').textContent()==='変更なし');await gain().evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true})));check('IME keyCode229 Enter cannot apply the draft',await redo().isEnabled());await gain().press('Escape');check('Escape cancels draft without consuming Redo',await gain().inputValue()==='100'&&await redo().isEnabled());
 for(const invalid of ['101','-1','0.5','NaN']){await gain().fill(invalid);assert(await apply().isDisabled());await gain().press('Enter');assert(await redo().isEnabled());}check('invalid percent input cannot create edits');
 await gain().fill('50');await apply().click();await expectVolume(.5);const half=await save();assert.equal(half.version,3);assert.equal(half.project.clips[0].audioGain,.5);check('explicit apply stores v3 gain and updates the preview carrier',await redo().isDisabled());await undo().click();await expectVolume(1);check('one Undo restores default and one Redo restores gain',await gain().inputValue()==='100');await redo().click();await expectVolume(.5);
 await gain().fill('51');await gain().fill('50');await apply().click();await undo().click();check('same effective gain is a no-op, not an extra Undo',await gain().inputValue()==='100');await redo().click();
 await select([0,1,2]);check('mixed audio values and pure-image exclusion are explicit',await gain().getAttribute('placeholder')==='混在'&&(await page.locator('[data-clip-audio-status]').innerText()).includes('対象 2件 / 純画像 1件を除外'));await gain().fill('25');await gain().press('Enter');const quarter=await save();assert.deepEqual(quarter.project.clips.map(c=>c.audioGain??1),[.25,1,.25]);check('one apply atomically changes eligible video clips and skips pure images');await undo().click();assert.deepEqual((await save()).project.clips.map(c=>c.audioGain??1),[.5,1,1]);check('batch audio edit is exactly one Undo');await redo().click();
 await silent().click();await seek(.5);await expectVolume(0);const zero=await save();assert.deepEqual(zero.project.clips.map(c=>c.audioGain??1),[0,1,0]);check('0 percent silences without changing clip count or source media',await page.locator('.timeline-clip').count()===3);await undo().click();await expectVolume(.25);
 await select([1]);check('pure image selection disables audio operations',await gain().isDisabled()&&await silent().isDisabled());
 await select([0]);await gain().fill('75');await select([2]);check('selection change discards a stale draft',await gain().inputValue()==='25'&&await apply().isDisabled());
 await gain().fill('75');const help=page.getByRole('button',{name:'ヘルプ',exact:true});await help.click();check('help blocks volume edits at the UI boundary',await gain().isDisabled()&&await silent().isDisabled());await page.getByRole('button',{name:'閉じる',exact:true}).click();check('closing help restores controls without reviving stale draft',await gain().inputValue()==='25'&&await apply().isDisabled());
 await select([0,2]);await gain().fill('100');await apply().click();const restored=await save();assert.equal(restored.version,1);assert(restored.project.clips.every(c=>!Object.hasOwn(c,'audioGain')));check('all-default writer returns to legacy v1 with omitted fields');await seek(4.5);await expectVolume(1);check('switching to a default clip resets the previous low volume');
 await load(quarter,'v3-roundtrip');assert.deepEqual((await save()).project,quarter.project);check('v3 save and load roundtrip preserve gains and exact source references');await select([0]);await gain().fill('99');await load(template,'stale-load');await select([0]);check('loading another epoch cannot apply an old draft',await gain().inputValue()==='100'&&await apply().isDisabled());
 const payload={...template.project,assets:template.project.assets.map(a=>({...a,storageAssetId:a.media.id}))};
 for(const audioGain of [null,'0.5',-1,1.01]){const response=await page.request.post(`${baseURL}/api/jobs/export-composition`,{data:{...payload,clips:payload.clips.map((c,i)=>i===0?{...c,audioGain}:c)}});assert.equal(response.status(),400);assert((await response.json()).error.includes('音量'));}
 check('direct export API rejects null/string/out-of-range gain before registering jobs');
 check('no uncaught browser errors',errors.length===0);await captureEvidenceScreenshot(page,`${evidence}/clip-audio.png`);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{/* Preserve failure. */});process.exitCode=1;}).finally(()=>suite.cleanup());
