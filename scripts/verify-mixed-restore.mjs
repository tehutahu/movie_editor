/* global document, structuredClone */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('mixed-restore',3162),{evidence,baseURL,ff}=suite;
const checks=[],errors=[];let page;
function check(name,condition=true){assert(condition,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors},null,2));}
async function save(){const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===`${baseURL}/api/projects`);await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();const r=await response;assert(r.ok(),await r.text());await page.waitForFunction(()=>!document.querySelector('.busy-banner'));return(await r.json()).document;}
async function load(doc,name){const file=`${evidence}/${name}.json`;fs.writeFileSync(file,JSON.stringify(doc));const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/projects/load'));const old=await page.locator('.compositor-preview canvas').elementHandle();await page.locator('.project-persistence input[type=file]').setInputFiles(file);const r=await response;assert(r.ok(),await r.text());await page.waitForFunction(c=>!c.isConnected&&!document.querySelector('.busy-banner'),old);}
async function job(id,name){for(let i=0;i<200;i++){const r=await page.request.get(`${baseURL}/api/jobs/${id}`),j=await r.json();if(j.status==='error')throw Error(j.error);if(j.status==='done'){const d=await page.request.get(`${baseURL}/api/download/${id}`);assert(d.ok());const path=`${evidence}/${name}.mp4`;fs.writeFileSync(path,await d.body());ff(['-xerror','-i',path,'-f','null','-']);return path;}await page.waitForTimeout(200);}throw Error('mixed export timeout');}
function owner(file,n){const rgb=ff(['-i',file,'-vf',`select=eq(n\\,${n}),scale=1:1`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);assert.equal(rgb.length,3);return rgb[0]>rgb[2]?'A':'B';}
async function mediaHash(asset){const r=await page.request.get(`${baseURL}/api/${asset.media.kind==='job'?'jobs':'assets'}/${asset.media.id}/stream`);assert(r.ok());return createHash('sha256').update(await r.body()).digest('hex');}
(async()=>{
  for(const [name,color,freq]of[['a','red',440],['b','blue',880]])ff(['-y','-f','lavfi','-i',`color=${color}:s=160x120:r=30:d=2`,'-f','lavfi','-i',`sine=frequency=${freq}:sample_rate=44100:duration=2`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',`${evidence}/${name}.mp4`]);
  ff(['-y','-f','lavfi','-i','color=blue:s=160x120','-frames:v','1',`${evidence}/still.png`]);
  await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1800,height:1050}});page.on('pageerror',e=>errors.push(e.message));await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles(['a.mp4','b.mp4','still.png'].map(n=>`${evidence}/${n}`));await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===3&&!document.querySelector('.busy-banner'));
  await page.locator('.asset-card').filter({hasText:'a'}).first().getByRole('button').click();await page.locator('.timeline-clip').waitFor();const template=await save();
  const a=template.project.assets.find(a=>a.displayName==='a'),b=template.project.assets.find(a=>a.displayName==='b'),image=template.project.assets.find(a=>a.displayName==='still');assert(a&&b&&image);
  const originalHashes=await Promise.all(template.project.assets.map(mediaHash));
  for(const [factor,second]of[[2,b],[.5,b],[2,image]]){
    const label=`${second.kind}-${factor}`,doc=structuredClone(template),clip=doc.project.clips[0];Object.assign(doc.project,{compositionWidth:320,compositionHeight:320,compositionDurationSec:10});Object.assign(clip,{timelineStartSec:0,durationSec:2,parts:[{assetId:a.id,sourceInSec:.5,sourceOutSec:1.5},{assetId:second.id,sourceInSec:.5,sourceOutSec:1.5}],transform:{x:.5,y:.5,scale:1}});
    await load(doc,`${label}-input`);await page.locator('.timeline-clip').click({position:{x:20,y:12}});await page.locator('#speed-factor').fill(String(factor));await page.locator('#sample-rate').fill('44100');
    const sourceChanged=page.waitForFunction(()=>[...document.querySelectorAll('.asset-card')].some(e=>e.title==='a'&&e.querySelector('video')?.getAttribute('src')?.includes('/api/jobs/'))&&!document.querySelector('.busy-banner'));
    await page.getByRole('button',{name:'速度復元',exact:true}).click();await sourceChanged;const restored=await save(),out=restored.project.clips[0];
    check(`${label}: real restore saves with only the target part length changed`,out.durationSec===1+factor&&out.parts[0].sourceInSec===.5*factor&&out.parts[0].sourceOutSec===1.5*factor&&JSON.stringify(out.parts[1])===JSON.stringify(clip.parts[1]));
    check(`${label}: IDs, start, geometry and non-target asset are preserved`,out.id===clip.id&&out.trackId===clip.trackId&&out.timelineStartSec===0&&JSON.stringify(out.transform)===JSON.stringify(clip.transform)&&JSON.stringify(restored.project.assets.find(x=>x.id===second.id))===JSON.stringify(second));
    const request={...restored.project,assets:restored.project.assets.map(({media,...asset})=>({...asset,...(media.kind==='job'?{sourceJobId:media.id}:{storageAssetId:media.id})}))};
    const response=await page.request.post(`${baseURL}/api/jobs/export-composition`,{data:request});assert(response.ok(),await response.text());const full=await job((await response.json()).jobId,`${label}-composition`);
    check(`${label}: full export decodes and retains the A/B boundary`,owner(full,Math.round(factor*30)-1)==='A'&&owner(full,Math.round(factor*30))==='B');
    const download=page.waitForEvent('download');await page.getByTitle('選択クリップの素材切り出し。位置・拡大率は適用しません。単一動画は原寸、画像・結合クリップは先頭素材の画面内で配置モードを適用します (Shift+Ctrl+E)',{exact:true}).click();const d=await download,selected=`${evidence}/${label}-selected.mp4`;await d.saveAs(selected);ff(['-xerror','-i',selected,'-f','null','-']);
    check(`${label}: selected multipart export preserves its source boundary`,owner(selected,Math.round(factor*30)-1)==='A'&&owner(selected,Math.round(factor*30))==='B');
    await page.getByTitle('Undo (Ctrl+Z)',{exact:true}).click();assert.deepEqual((await save()).project,doc.project);await page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true}).click();assert.deepEqual((await save()).project,restored.project);check(`${label}: one Undo/Redo restores the exact source and mixed project`);
    await load(restored,`${label}-reload`);assert.deepEqual((await save()).project,restored.project);check(`${label}: restored mixed document reloads and saves unchanged`);
    assert.deepEqual(await Promise.all(template.project.assets.map(mediaHash)),originalHashes);check(`${label}: original media bytes remain retained`);
  }
  const tooShort=structuredClone(template);Object.assign(tooShort.project.clips[0],{durationSec:.05,parts:[{assetId:a.id,sourceInSec:0,sourceOutSec:.05}]});
  await load(tooShort,'minimum-input');await page.locator('.timeline-clip').click({position:{x:3,y:12}});await page.locator('#speed-factor').fill('.5');await page.getByRole('button',{name:'速度復元',exact:true}).click();await page.locator('.error-banner').filter({hasText:'短すぎ'}).waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));
  check('below-MIN restore is a visible atomic operation error without crashing',errors.length===0);assert.deepEqual((await save()).project,tooShort.project);check('failed duration validation preserves original project and source references');
  await captureEvidenceScreenshot(page,`${evidence}/mixed-restore.png`);check('no uncaught browser errors',errors.length===0);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Preserve the original failure. */ });process.exitCode=1;}).finally(()=>suite.cleanup());
