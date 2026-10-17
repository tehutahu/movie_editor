/* global document, KeyboardEvent */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('help-modal',3172),{evidence,baseURL,ff}=suite;
const checks=[],errors=[],posts=[];let page,releaseHeldUpload;
function check(name,condition=true){assert(condition,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors,posts},null,2));}
(async()=>{
  ff(['-y','-f','lavfi','-i','testsrc2=size=160x120:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','4','-c:v','libx264','-c:a','aac',`${evidence}/source.mp4`]);
  await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/jobs\//.test(r.url()))posts.push({url:r.url(),body:r.postDataJSON()});});
  await page.goto(baseURL);await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);
  await page.waitForFunction(()=>document.querySelector('.asset-add-button')&&!document.querySelector('.asset-add-button').disabled);
  await page.locator('.asset-add-button').click();await page.locator('.timeline-clip').waitFor();
  async function save(){const response=page.waitForResponse(r=>r.url().endsWith('/api/projects')&&r.request().method()==='POST');await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();assert.equal((await response).status(),200);await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const{projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
  const template=await save(),original=template.project.clips[0];template.project.clips=[{...original,durationSec:2,parts:[{...original.parts[0],sourceInSec:0,sourceOutSec:2}]},{...original,id:randomUUID(),timelineStartSec:2,durationSec:2,parts:[{...original.parts[0],sourceInSec:2,sourceOutSec:4}]}];template.project.tracks=template.project.tracks.filter(t=>t.id===original.trackId);template.project.compositionDurationSec=4;template.project.compositionWidth=320;template.project.compositionHeight=320;
  fs.writeFileSync(`${evidence}/fixture.json`,JSON.stringify(template));await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/fixture.json`);await page.locator('.project-persistence [role=status]').filter({hasText:'読み込み済み'}).waitFor();
  const undo=page.getByTitle('Undo (Ctrl+Z)',{exact:true}),redo=page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true}),add=page.getByTitle('トラック追加 (Ctrl+T)',{exact:true});
  await add.click();await add.click();await undo.click();
  await page.locator('.timeline-clip').first().click();await page.locator('.timeline-clip').last().click({modifiers:['Control']});
  const input=page.getByRole('textbox',{name:'再生位置',exact:true});await input.fill('1');await input.press('Enter');
  const saved=await save();check('fixture has eligible edits and both Undo and Redo',await undo.isEnabled()&&await redo.isEnabled()&&await page.locator('.timeline-clip--selected').count()===2);
  const help=page.getByRole('button',{name:'ヘルプ',exact:true}),dialog=page.getByRole('dialog',{name:'操作ヘルプ',exact:true}),close=dialog.getByRole('button',{name:'閉じる',exact:true}),play=page.getByTitle('再生 / 一時停止 (Space)',{exact:true});
  const state=()=>page.evaluate(()=>({clips:[...document.querySelectorAll('.timeline-clip')].map(e=>({text:e.textContent,style:e.getAttribute('style'),selected:e.classList.contains('timeline-clip--selected')})),tracks:document.querySelectorAll('.timeline-track-row').length,undo:document.querySelector('[title="Undo (Ctrl+Z)"]').disabled,redo:document.querySelector('[title="Redo (Shift+Ctrl+Z)"]').disabled,dirty:document.querySelector('.project-persistence strong').textContent,playhead:document.querySelector('.timeline-playhead').style.left,playing:document.querySelector('[title="再生 / 一時停止 (Space)"]').textContent}));
  const baseline=await state();
  // A single browser turn targets the opener immediately after the opening
  // event, before any replacement window listener could be relied upon.
  await help.evaluate(button=>{button.focus();button.click();button.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Delete'}));});await dialog.waitFor();
  assert.deepEqual(await state(),baseline);check('opening event synchronously guards an immediate opener-target Delete');
  check('initial focus enters the only modal control',await close.evaluate(e=>document.activeElement===e));
  for(const key of ['Tab','Shift+Tab','Tab']){await page.keyboard.press(key);assert(await close.evaluate(e=>document.activeElement===e));}check('Tab and Shift+Tab cycle within the one-control modal');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});check('Escape closes and restores connected opener focus',await help.evaluate(e=>document.activeElement===e));
  const shortcuts=['Delete','Control+d','Control+x','Control+m','Control+t','Control+e','Control+Shift+e','Control+z','Control+Shift+z','Meta+z'];
  for(const target of ['opener','close']){
    await help.click();await dialog.waitFor();
    if(target==='opener')await help.focus();else await close.focus();
    for(const key of shortcuts){await page.keyboard.press(key);assert.deepEqual(await state(),baseline);check(`${target} focus: ${key} cannot edit or export behind help`);}
    for(const key of ['Space','ArrowRight','Control+ArrowRight']){
      // Native Space on close must close; test transport keys from the opener
      // by dispatching their bubbling keydown without a native button click.
      await help.evaluate((button,key)=>button.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:key==='Space'?' ':'ArrowRight',code:key==='Space'?'Space':'ArrowRight',ctrlKey:key.startsWith('Control+')})),key);
      assert.deepEqual(await state(),baseline);
    }
    check(`${target} modal scope blocks preview transport without touching selection/history`);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  }
  await page.waitForTimeout(150);check('blocked background shortcuts create no jobs',posts.length===0);
  assert.deepEqual((await save()).project,saved.project);check('modal cycles preserve exact saved DTO, media references, Redo and clean state',await redo.isEnabled()&&await page.locator('.project-persistence strong').textContent()==='変更なし');
  await help.click();await close.press('Enter');await dialog.waitFor({state:'detached'});check('native Enter closes without starting playback and returns focus',await play.textContent()==='▶'&&await help.evaluate(e=>document.activeElement===e));
  await help.click();await close.press('Space');await dialog.waitFor({state:'detached'});check('native Space closes exactly once without playing',await play.textContent()==='▶'&&await help.evaluate(e=>document.activeElement===e));
  await help.click();await page.locator('.help-modal-backdrop').click({position:{x:10,y:10}});await dialog.waitFor({state:'detached'});check('backdrop close restores opener and releases the same modal scope',await help.evaluate(e=>document.activeElement===e));
  // Actual actions after close distinguish a released guard from one stuck on.
  await help.focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelectorAll('.timeline-track-row').length===1);check('Undo resumes after close');
  await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>document.querySelectorAll('.timeline-track-row').length===2);check('Redo resumes after close');
  await page.keyboard.press('Control+d');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===4);await undo.click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===2);check('duplicate resumes after close');
  await help.focus();await page.keyboard.press('Control+x');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===3);await undo.click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===2);check('split resumes after close');
  await help.focus();await page.keyboard.press('Control+m');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===1);await undo.click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===2);check('merge resumes after close');
  await help.focus();await page.keyboard.press('Control+t');await page.waitForFunction(()=>document.querySelectorAll('.timeline-track-row').length===3);await undo.click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-track-row').length===2);check('add track resumes after close');
  await help.focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===0);await undo.click();await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===2);check('Delete resumes after close and one Undo restores clips');
  await input.fill('2');await input.press('Control+a');await input.press('Backspace');await input.press('Control+z');check('native text undo does not reach project history',await input.inputValue()==='2'&&await page.locator('.timeline-clip').count()===2);await input.press('Escape');
  await help.focus();await page.keyboard.press('ArrowRight');check('preview frame step resumes after close',await input.inputValue()==='1.033333');
  const fullDownload=page.waitForEvent('download',{timeout:30000});await help.focus();await page.keyboard.press('Control+e');const full=await fullDownload;await full.saveAs(`${evidence}/resumed-composition.mp4`);await page.waitForFunction(()=>!document.querySelector('.busy-banner'));suite.verifyExport(`${evidence}/resumed-composition.mp4`,{width:320,height:320,duration:4});check('whole-composition shortcut resumes after close with a real decoded export',posts.length===1);
  await page.locator('.timeline-clip').first().click();const selectedDownload=page.waitForEvent('download',{timeout:30000});await help.focus();await page.keyboard.press('Control+Shift+e');const selected=await selectedDownload;await selected.saveAs(`${evidence}/resumed-selected.mp4`);await page.waitForFunction(()=>!document.querySelector('.busy-banner'));suite.verifyExport(`${evidence}/resumed-selected.mp4`,{width:160,height:120,duration:2});check('selected-source shortcut resumes after close with a real decoded export',posts.length===2);
  const held=new Promise(resolve=>{releaseHeldUpload=resolve;});await page.route('**/api/assets',async route=>{await held;await route.continue();});await page.locator('.asset-library input[type=file]').setInputFiles(`${evidence}/source.mp4`);await page.waitForFunction(()=>document.querySelector('.asset-library input').disabled);const duringBusy=await state();await help.focus();await page.keyboard.press('Delete');assert.deepEqual(await state(),duringBusy);check('existing busy guard still rejects background Delete');releaseHeldUpload();releaseHeldUpload=undefined;await page.waitForFunction(()=>!document.querySelector('.asset-library input').disabled);await page.unroute('**/api/assets');
  // Preserve current edits by cancelling the existing persistence modal.
  fs.writeFileSync(`${evidence}/reload.json`,JSON.stringify(saved));await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/reload.json`);await page.getByRole('dialog',{name:'未保存の変更',exact:true}).waitFor();const locked=await state();await page.getByRole('button',{name:'キャンセル',exact:true}).focus();await page.keyboard.press('Delete');assert.deepEqual(await state(),locked);check('existing persistence confirmation lock still rejects background Delete');await page.getByRole('button',{name:'キャンセル',exact:true}).click();
  await help.click();await captureEvidenceScreenshot(page,`${evidence}/help-focus.png`);await close.click();
  check('no uncaught browser errors',errors.length===0);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{/* Preserve original failure. */});process.exitCode=1;}).finally(()=>{releaseHeldUpload?.();return suite.cleanup();});
