/* global document, window, PointerEvent, Event, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { visiblePointerPoint, dragToVisibleTarget } from './browser-pointer.mjs';
const suite=verification('group-move',3183),{evidence,baseURL,ff}=suite;
const checks=[],errors=[];let page,template,ids;
const check=(name,ok=true)=>{assert(ok,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors},null,2));};
const clips=()=>page.locator('.timeline-clip'),clip=id=>page.locator(`[data-clip-id="${id}"]`);
const undo=()=>page.getByTitle('Undo (Ctrl+Z)',{exact:true}),redo=()=>page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true});
async function save(){await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const {projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
async function load(doc,name){const file=`${evidence}/${name}.json`;fs.writeFileSync(file,JSON.stringify(doc));const response=page.waitForResponse(r=>r.url().endsWith('/api/projects/load'));await page.locator('.project-persistence input[type=file]').setInputFiles(file);assert((await response).ok());await page.waitForFunction(()=>!document.querySelector('.busy-banner'));assert.deepEqual(await page.locator('.error-banner').allTextContents(),[]);}
async function select(){await clip(ids[2]).click({position:{x:20,y:10}});await clip(ids[0]).click({position:{x:20,y:10}});await page.keyboard.down('Control');await clip(ids[1]).click({position:{x:20,y:10}});await page.keyboard.up('Control');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip--selected').length===2);}
async function seek(sec){const input=page.getByLabel('再生位置',{exact:true});await input.fill(String(sec));await input.press('Enter');await input.blur();}
async function begin(dx,{alt=false}={}){const point=await visiblePointerPoint(page,clip(ids[0]),{x:20,y:10});if(alt)await page.keyboard.down('Alt');await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+dx,point.y,{steps:5});return point;}
async function end(){await page.mouse.up();await page.keyboard.up('Alt');}

async function positions(a,b){await page.waitForFunction(({ids,a,b})=>ids.slice(0,2).every((id,i)=>Math.abs((parseFloat(document.querySelector(`[data-clip-id="${id}"]`).style.left)-48)/80-[a,b][i])<1e-7),{ids,a,b});}
(async()=>{
 ff(['-y','-f','lavfi','-i','color=red:s=160x120:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac',`${evidence}/red.mp4`]);
 ff(['-y','-f','lavfi','-i','color=blue:s=160x120','-frames:v','1',`${evidence}/blue.png`]);
 await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1800,height:1100}});page.on('pageerror',e=>errors.push(e.message));await page.goto(baseURL);
 await page.locator('.asset-library input[type=file]').setInputFiles([`${evidence}/red.mp4`,`${evidence}/blue.png`]);await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===2&&!document.querySelector('.busy-banner'));
 await dragToVisibleTarget(page, page.locator('.asset-card').first(), page.locator('.timeline-track-row').first(),{targetPosition:{x:48,y:30}});await clips().waitFor();template=await save();
 const a=template.project.assets.find(a=>a.displayName==='red'),b=template.project.assets.find(a=>a.displayName==='blue');ids=[randomUUID(),randomUUID(),randomUUID()];
 const make=(id,trackId,start,asset,contain=false)=>({id,trackId,timelineStartSec:start,durationSec:1,parts:[{assetId:asset.id,sourceInSec:0,sourceOutSec:1}],transform:{x:.5,y:.5,scale:2},...(contain?{layoutMode:'contain'}:{})});
 template.version=2;Object.assign(template.project,{compositionWidth:320,compositionHeight:320,compositionDurationSec:30,clips:[make(ids[0],template.project.tracks[0].id,1,a,true),make(ids[1],template.project.tracks[1].id,3,b),make(ids[2],template.project.tracks[0].id,7,a)]});
 await load(template,'initial');await select();check('Ctrl selects two clips and a plain click keeps the group',await page.locator('.timeline-clip--selected').count()===2);await clip(ids[0]).click({position:{x:20,y:10}});assert.equal(await page.locator('.timeline-clip--selected').count(),2);
 await begin(80,{alt:true});await positions(2,4);check('all selected ghosts share one delta and keep their tracks',await page.locator('.timeline-clip--dragging').count()===2);await end();const moved=await save();const expected=structuredClone(template);expected.project.clips[0].timelineStartSec=2;expected.project.clips[1].timelineStartSec=4;assert.deepEqual(moved.project,expected.project);check('one drag preserves IDs, media, parts, geometry, modes and custom duration');
 await undo().click();await positions(1,3);assert.deepEqual((await save()).project,template.project);check('one Undo restores the exact original document');await redo().click();await positions(2,4);check('one Redo restores the whole group');
 await undo().click();await seek(1.05);let start=await begin(40);await page.mouse.move(start.x,start.y,{steps:5});await positions(1,3);await end();check('return-to-origin near the playhead is a no-op preserving pending Redo',await redo().isEnabled());
 await begin(6*80,{alt:true});await page.waitForFunction(()=>document.querySelector('.group-move-status').textContent.includes('重なる'));check('collision marks all ghosts and explains atomic rejection',await page.locator('.timeline-clip--invalid-move').count()===2);await end();await positions(1,3);check('collision keeps every original clip and pending Redo',await redo().isEnabled());
 await page.getByTitle('トラック追加 (Ctrl+T)',{exact:true}).click();await undo().click();check('old collision reason cannot reappear after edit and Undo',!(await page.locator('.group-move-status').innerText()).includes('重なる'));
 await clip(ids[2]).click({position:{x:20,y:10}});check('selection change clears the stale collision reason',!(await page.locator('.group-move-status').innerText()).includes('重なる'));
 await select();await seek(2.05);await begin(80);await positions(2.05,4.05);await page.keyboard.down('Alt');await positions(2,4);check('anchor-only snap updates every ghost and stationary Alt bypasses it');await page.keyboard.up('Alt');await positions(2.05,4.05);await page.keyboard.press('Escape');await end();await positions(1,3);check('Escape cancels the entire gesture without clearing Redo',await redo().isEnabled());
 await begin(-200,{alt:true});await positions(0,2);await end();check('left boundary clamps one common delta without collapsing relative gaps');await undo().click();await positions(1,3);
 // Create a group already at zero; a further left drag near playhead must remain no-op.
 const zero=structuredClone(template);zero.project.clips[0].timelineStartSec=0;zero.project.clips[1].timelineStartSec=2;await load(zero,'zero');await select();await page.getByTitle('トラック追加 (Ctrl+T)',{exact:true}).click();await undo().click();assert(await redo().isEnabled());await seek(.05);await begin(-80);await positions(0,2);await end();check('zero-clamped no-op cannot snap the whole group forward or consume Redo',await redo().isEnabled());
 await load(template,'cancel');await select();await begin(80,{alt:true});await positions(2,4);await page.evaluate(()=>document.querySelector('.timeline-scroll').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1})));await end();await positions(1,3);check('pointercancel cancels every ghost');
 await begin(80,{alt:true});await positions(2,4);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await end();await positions(1,3);check('window blur cancels the whole gesture');
 await begin(80,{alt:true});await page.keyboard.up('Alt');const help=page.getByRole('button',{name:'ヘルプ',exact:true});await help.focus();await help.press('Enter');await page.locator('.help-modal').waitFor();await end();await page.getByRole('button',{name:'閉じる',exact:true}).click();await positions(1,3);check('opening help blocks an active group gesture and closing does not commit it');
 await begin(80,{alt:true});await page.keyboard.up('Alt');const zoom=page.locator('.timeline-toolbar-right input[type=range]');await zoom.focus();await zoom.press('ArrowRight');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip--dragging').length===0);await end();check('zoom changes cancel group move',await zoom.inputValue()!=='1');await zoom.press('ArrowLeft');assert.equal(await zoom.inputValue(),'1');
 await load(moved,'roundtrip');assert.deepEqual((await save()).project,moved.project);check('v2 save/load preserves moved layout and source references');
 const v1=structuredClone(template);v1.version=1;delete v1.project.clips[0].layoutMode;await load(v1,'v1');await select();await begin(80,{alt:true});await positions(2,4);await end();const v1moved=await save();assert.equal(v1moved.version,1);check('legacy v1 remains stretch and supports the same atomic move');
 check('no uncaught browser errors',errors.length===0);await captureEvidenceScreenshot(page,`${evidence}/group-move.png`);
})().catch(async error=>{console.error(error);fs.writeFileSync(`${evidence}/failure.txt`,String(error.stack??error));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Preserve the original failure. */ });process.exitCode=1;}).finally(()=>suite.cleanup());
