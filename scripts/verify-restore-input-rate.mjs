/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('restore-input-rate',3160),{evidence,baseURL,ff}=suite;
const checks=[],errors=[],posts=[],probes=[];let page,mode='real',release,held=false;
function check(name,condition=true){assert(condition,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors,posts,probes},null,2));}
async function save(){await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const{projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
async function choose(name){await page.locator('.timeline-clip').filter({hasText:name}).click({position:{x:20,y:12}});}
(async()=>{
  for(const [name,rate] of [['rate48',48000],['rate44',44100],['silent',0]])ff(['-y','-f','lavfi','-i','testsrc2=s=320x240:r=30:d=2',...(rate?['-f','lavfi','-i',`sine=frequency=440:sample_rate=${rate}:duration=2`]:[]),'-c:v','libx264','-pix_fmt','yuv420p',...(rate?['-c:a','aac']:['-an']),`${evidence}/${name}.mp4`]);
  await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1800,height:1050}});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/jobs/restore'))posts.push(r.postDataJSON());if(r.url().includes('/restore/input-metadata?'))probes.push(r.url());});await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(['rate48','rate44','silent'].map(n=>`${evidence}/${n}.mp4`));await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===3&&!document.querySelector('.busy-banner'));
  for(const name of ['rate48','rate44','silent'])await page.locator('.asset-card').filter({hasText:name}).getByRole('button').click();
  await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length===3);const template=await save(),physical=template.project.assets.find(a=>a.displayName==='rate48').media.id;
  const rate=page.locator('#sample-rate'),summary=page.locator('[data-restore-rate-summary]'),panel=page.locator('[data-restore-input-audio]'),copy=panel.getByRole('button',{name:'入力に合わせる',exact:true});
  await page.route('**/api/jobs/restore/input-metadata?**',async route=>{
    if(mode==='real')return route.continue();
    const id=new URL(route.request().url()).searchParams.get('videoId');
    if(id!==physical)return route.continue();
    if(mode==='delay'){held=true;await new Promise(resolve=>{release=resolve;});try{await route.fulfill({json:{videoId:id,inputAudio:{status:'known',streamOrdinal:0,streamIndex:1,sampleRateHz:48000}}});}catch{/* Aborted stale response must not be adopted. */}return;}
    if(mode==='failure')return route.fulfill({status:400,json:{error:'synthetic probe failure'}});
    return route.fulfill({json:{videoId:id,inputAudio:{status:'unknown',streamOrdinal:0,streamIndex:1}}});
  });
  await choose('rate48');await summary.filter({hasText:'48000'}).waitFor();check('real a:0 rate and mismatch remain visible while assistance is closed',(await summary.innerText()).includes('44100')&&(await summary.innerText()).includes('差あり')&&await rate.inputValue()==='44100');
  await page.getByTitle('複製 (Ctrl+D)',{exact:true}).click();await page.getByTitle('Undo (Ctrl+Z)',{exact:true}).click();await choose('rate48');await summary.filter({hasText:'48000'}).waitFor();
  await summary.click();await copy.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#sample-rate').value==='48000');check('explicit native Space copies the input without consuming Redo',await page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true}).isEnabled());
  await panel.locator('[data-input-rate-copied]').waitFor();await rate.fill('32000');check('manual input clears the copied mark',await panel.locator('[data-input-rate-copied]').count()===0);
  assert.deepEqual((await save()).project,template.project);check('probe and copy preserve the saved project, media hashes and edit history');await choose('rate44');await summary.filter({hasText:'44100'}).waitFor();check('changing target preserves manual Hz',await rate.inputValue()==='32000');
  await choose('silent');await summary.filter({hasText:'音声なし'}).waitFor();check('audio-less video is explicit and copying is unavailable',await copy.isDisabled());
  mode='delay';held=false;await choose('rate48');while(!held)await page.waitForTimeout(10);await rate.fill('22050');await choose('rate44');mode='real';release();await summary.filter({hasText:'44100'}).waitFor();check('late source A response cannot replace current source B or overwrite manual input',await rate.inputValue()==='22050');
  await choose('silent');mode='delay';held=false;await choose('rate48');while(!held)await page.waitForTimeout(10);await rate.fill('32000');mode='real';release();await summary.filter({hasText:'48000'}).waitFor();check('a current delayed probe observes rate without overwriting an in-progress manual edit',await rate.inputValue()==='32000');
  for(const state of ['failure','unknown']){
    await choose('silent');mode=state;await choose('rate48');await summary.filter({hasText:state==='failure'?'取得失敗':'入力Hz不明'}).waitFor();check(`${state} disables assistance without changing manual Hz`,await copy.isDisabled()&&await rate.inputValue()==='32000');
    await page.route('**/api/jobs/restore',async route=>{await route.fulfill({status:400,json:{error:'manual request observed'}});});
    await page.getByRole('button',{name:'速度復元',exact:true}).click();await page.getByText('manual request observed',{exact:true}).waitFor();check(`${state} still sends the original explicit manual POST`,posts.at(-1).sampleRateHz===32000&&!('sampleRateMode'in posts.at(-1))&&!('inputAudioExpectation'in posts.at(-1)));await page.unroute('**/api/jobs/restore');
  }
  mode='real';await choose('silent');await choose('rate48');await summary.filter({hasText:'48000'}).waitFor();await copy.click();await page.locator('#speed-factor').fill('2');
  const beforeReal=posts.length;const observed=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/jobs/restore'));await page.getByRole('button',{name:'速度復元',exact:true}).dblclick();const request=await observed;assert.equal(request.postDataJSON().sampleRateHz,48000);
  await page.waitForFunction(()=>!document.querySelector('.busy-banner')&&[...document.querySelectorAll('.asset-card')].some(e=>e.title==='rate48'&&e.querySelector('video')?.getAttribute('src')?.includes('/api/jobs/')));check('copied Hz executes a real restore without adding new POST fields',Object.keys(request.postDataJSON()).sort().join(',')==='editorSessionId,exportBaseName,sampleRateHz,speedFactor,videoId');
  check('rapid double click creates only one restore request',posts.length===beforeReal+1);await summary.filter({hasText:'48000'}).waitFor();const restored=await save();check('restore switches observation to its actual sourceJob output',restored.project.assets.find(a=>a.displayName==='rate48').media.kind==='job'&&probes.some(url=>new URL(url).searchParams.get('sourceJobId')===restored.project.assets.find(a=>a.displayName==='rate48').media.id));await page.getByTitle('Undo (Ctrl+Z)',{exact:true}).click();assert.deepEqual((await save()).project,template.project);check('one Undo restores the exact original source and project after restoration');
  await captureEvidenceScreenshot(page,`${evidence}/rate-assistance.png`);check('no uncaught browser errors',errors.length===0);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{/* Preserve original error. */});process.exitCode=1;}).finally(()=>{if(release)release();return suite.cleanup();});
