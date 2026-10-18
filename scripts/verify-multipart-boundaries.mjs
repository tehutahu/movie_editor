/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
import { visiblePointerPoint, dragToVisibleTarget } from './browser-pointer.mjs';
const suite=verification('multipart-boundaries',3158),{evidence,baseURL,ff}=suite;
const checks=[],errors=[];let page;
function check(name,condition=true){assert(condition,name);checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors},null,2));}
async function save(){await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.busy-banner'));const{projects}=await(await page.request.get(`${baseURL}/api/projects`)).json();return(await page.request.get(`${baseURL}/api/projects/${projects.at(-1).id}`)).json();}
async function job(id,name){for(let i=0;i<160;i++){const j=await(await page.request.get(`${baseURL}/api/jobs/${id}`)).json();if(j.status==='error')throw Error(j.error);if(j.status==='done'){const r=await page.request.get(`${baseURL}/api/download/${id}`);assert(r.ok());const file=`${evidence}/${name}.mp4`;fs.writeFileSync(file,await r.body());ff(['-xerror','-i',file,'-f','null','-']);return file;}await page.waitForTimeout(250);}throw Error('multipart job timeout');}
function owner(file,n){const rgb=ff(['-i',file,'-vf',`select=eq(n\\,${n}),scale=1:1`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);return rgb[0]>rgb[2]?'A':'B';}
(async()=>{
  for(const [name,color,fps]of[['a','red',24],['b','blue',30]])ff(['-y','-f','lavfi','-i',`color=${color}:s=320x320:r=${fps}:d=3`,'-f','lavfi','-i',`sine=frequency=${name==='a'?440:880}:duration=3`,'-c:v','libx264','-c:a','aac',`${evidence}/${name}.mp4`]);
  await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(baseURL);
  await page.locator('.asset-library input[type=file]').setInputFiles([`${evidence}/a.mp4`,`${evidence}/b.mp4`]);await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===2&&!document.querySelector('.busy-banner'));
  await dragToVisibleTarget(page, page.locator('.asset-card').first(), page.locator('.timeline-track-row').first(),{targetPosition:{x:48,y:30}});await page.locator('.timeline-clip').waitFor();
  const doc=await save(),a=doc.project.assets.find(a=>a.displayName==='a'),b=doc.project.assets.find(a=>a.displayName==='b');assert(a&&b);
  Object.assign(doc.project,{compositionWidth:320,compositionHeight:320,compositionDurationSec:4});Object.assign(doc.project.clips[0],{timelineStartSec:1.75,durationSec:1.25,parts:[{assetId:a.id,sourceInSec:1,sourceOutSec:1.25},{assetId:b.id,sourceInSec:.5,sourceOutSec:1.5}],transform:{x:.5,y:.5,scale:2}});
  const file=`${evidence}/input.json`;fs.writeFileSync(file,JSON.stringify(doc));await page.locator('.project-persistence input[type=file]').setInputFiles(file);await page.waitForFunction(()=>!document.querySelector('.busy-banner'));assert.deepEqual(await page.locator('.error-banner').allTextContents(),[]);
  await page.locator('.timeline-clip').click({position:{x:25,y:10}});const point=await visiblePointerPoint(page,page.locator('.timeline-scroll'),{x:48+80*2,y:8});await page.mouse.click(point.x,point.y);
  await page.waitForFunction(()=>{const c=document.querySelector('.compositor-preview canvas');if(!c)return false;const d=c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;return d[2]>d[0];});check('loaded multipart Canvas shows B at the intended 2s boundary');
  const request={...doc.project,assets:doc.project.assets.map(a=>({...a,storageAssetId:a.media.id}))};const response=await page.request.post(`${baseURL}/api/jobs/export-composition`,{data:request});assert(response.ok(),await response.text());const out=await job((await response.json()).jobId,'composition');
  check('full composition uses A immediately before and B at the intended global boundary',owner(out,59)==='A'&&owner(out,60)==='B');
  const download=page.waitForEvent('download');await page.getByTitle('選択クリップの素材切り出し。位置・拡大率は適用しません。単一動画は原寸、画像・結合クリップは先頭素材の画面内で配置モードを適用します (Shift+Ctrl+E)',{exact:true}).click();const d=await download;const selected=`${evidence}/selected.mp4`;await d.saveAs(selected);ff(['-xerror','-i',selected,'-f','null','-']);
  check('selected multipart retains source-export meaning and recalculates its zero-based ownership',owner(selected,7)==='A'&&owner(selected,8)==='B');
  assert.deepEqual((await save()).project,doc.project);check('export and selected download leave exact project and media references unchanged');await captureEvidenceScreenshot(page,`${evidence}/multipart.png`);check('no uncaught browser errors',errors.length===0);
})().catch(async e=>{console.error(e);fs.writeFileSync(`${evidence}/failure.txt`,String(e.stack??e));if(page&&!page.isClosed())await page.screenshot({path:`${evidence}/failure.png`}).catch(()=>{ /* Preserve original failure. */ });process.exitCode=1;}).finally(()=>suite.cleanup());
