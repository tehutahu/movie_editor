/* global document, window, AudioContext, structuredClone, Blob, setTimeout */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { verification } from './browser-test-utils.mjs';
import { captureEvidenceScreenshot } from './browser-screenshot.mjs';
const suite=verification('negative-mkv-audio',3215),{evidence,baseURL,ff}=suite;
const checks=[],errors=[];let page;
const check=name=>{checks.push(name);console.log('PASS',name);fs.writeFileSync(`${evidence}/results.json`,JSON.stringify({checks,errors},null,2));};
const play=()=>page.getByTitle('再生 / 一時停止 (Space)',{exact:true});
async function save(){const pending=page.waitForResponse(r=>r.url().endsWith('/api/projects')&&r.request().method()==='POST');await page.getByRole('button',{name:'新しい保存版を保存',exact:true}).click();const r=await pending;assert(r.ok());await page.waitForFunction(()=>!document.querySelector('.busy-banner'));return(await r.json()).document;}
async function load(doc,name){fs.writeFileSync(`${evidence}/${name}.json`,JSON.stringify(doc));const pending=page.waitForResponse(r=>r.url().endsWith('/api/projects/load'));await page.locator('.project-persistence input[type=file]').setInputFiles(`${evidence}/${name}.json`);assert((await pending).ok());await page.waitForFunction(()=>!document.querySelector('.busy-banner'));}
async function pulse(probe,url,start){
 return probe.evaluate(async({url,start})=>{
  const el=document.createElement('video');el.preload='auto';document.body.append(el);el.src=url;
  await new Promise((resolve,reject)=>{el.onloadeddata=resolve;el.onerror=reject;});
  el.currentTime=start;await new Promise(resolve=>{el.onseeked=resolve;});
  const sought=el.currentTime;
  const context=new AudioContext({sampleRate:48000});await context.resume();const source=context.createMediaElementSource(el),processor=context.createScriptProcessor(256,1,1),values=[],chunks=[];
  source.connect(processor);processor.connect(context.destination);processor.onaudioprocess=e=>{chunks.push({index:values.length,mediaTime:el.currentTime-256/48000});values.push(...e.inputBuffer.getChannelData(0));};
  await el.play();await new Promise(r=>setTimeout(r,850));el.pause();processor.disconnect();source.disconnect();await context.close();el.remove();
  const rms=[];for(let i=0;i+480<=values.length;i+=480){let sum=0;for(let n=i;n<i+480;n++)sum+=values[n]**2;rms.push(Math.sqrt(sum/480));}
  const onset=rms.findIndex(v=>v>.005),peak=rms.findIndex(v=>v>.12),sample=peak*480,chunk=chunks.findLast(c=>c.index<=sample);
  return{sought,onset,peak,pulseAfterOnset:(peak-onset)*.01,pulseMediaTime:chunk?chunk.mediaTime+(sample-chunk.index)/48000:null,max:Math.max(...rms)};
 },{url,start});
}
(async()=>{
 for(const [name,offset,opus] of [['negative',-.2,false],['fade-negative',-.2,false],['boundary-negative',-.2,false],['healthy',0,false],['opus-negative',-.2,true]]){
  ff(['-y','-f','lavfi','-i','color=red:s=64x64:r=30:d=2','-f','lavfi','-i','aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52):s=48000:d=2','-af',`asetpts=PTS+(${offset})/TB`,'-c:v',opus?'libvpx-vp9':'libx264','-c:a',opus?'libopus':'aac','-bf','0','-fps_mode','passthrough','-avoid_negative_ts','disabled',...(opus?['-f','webm']:[]),`${evidence}/${name}.mkv`]);
 }
 ff(['-y','-i',`${evidence}/negative.mkv`,'-c','copy',`${evidence}/mp4-control.mp4`]);
 await suite.start();const browser=await suite.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__negativeAudio={routed:[],revoked:[]};const Native=window.AudioContext;window.AudioContext=class extends Native{createMediaElementSource(el){window.__negativeAudio.routed.push(el);return super.createMediaElementSource(el);}};const revoke=window.URL.revokeObjectURL.bind(window.URL);window.URL.revokeObjectURL=url=>{window.__negativeAudio.revoked.push(url);revoke(url);};});
 await page.goto(baseURL);await page.locator('.asset-library input[type=file]').setInputFiles(['negative.mkv','fade-negative.mkv','boundary-negative.mkv','healthy.mkv','opus-negative.mkv','mp4-control.mp4'].map(n=>`${evidence}/${n}`));
 await page.waitForFunction(()=>document.querySelectorAll('.asset-card').length===6&&!document.querySelector('.busy-banner'));
 await page.locator('.asset-add-button').first().click();await page.locator('.timeline-clip').waitFor();const template=await save();
 for(const [name,fade] of [['negative',false],['fade-negative',true]]){
  const doc=structuredClone(template);doc.version=fade?5:1;Object.assign(doc.project,{compositionDurationSec:.8,compositionWidth:320,compositionHeight:320});
  const clip=doc.project.clips[0];Object.assign(clip,{timelineStartSec:0,durationSec:.8});Object.assign(clip.parts[0],{assetId:doc.project.assets.find(a=>a.displayName===name).id,sourceInSec:.1,sourceOutSec:.9});
  if(fade)clip.audioFade={inSec:.05,outSec:.05,anchorDurationSec:.8,offsetSec:0};
  await load(doc,`${name}-input`);
  let release;const held=new Promise(r=>{release=r;});let calls=0;
  await page.route('**/api/media/audio-preview',async route=>{calls++;await held;await route.continue();});
  await play().click();await page.waitForFunction(()=>document.querySelector('[title="再生 / 一時停止 (Space)"]')?.textContent==='▶');
  await page.waitForTimeout(200);assert.equal(Number(await page.getByRole('textbox',{name:'再生位置',exact:true}).inputValue()),0);assert(calls>0);
  check(`${name}: cold preparation holds the public clock before play`);release();
  await page.waitForFunction(fade=>{const m=fade?window.__negativeAudio.routed.at(-1):document.querySelector('.compositor-audio-hidden');return m?.src.startsWith('blob:')&&!m.paused&&m.currentTime>.16;},fade);
  check(`${name}: real ${fade?'fade':'native'} owner plays the prepared Blob URL`);await play().click();await page.unroute('**/api/media/audio-preview');
  assert.deepEqual((await save()).project,doc.project);await page.getByTitle('トラック追加 (Ctrl+T)',{exact:true}).click();await page.getByTitle('Undo (Ctrl+Z)',{exact:true}).click();assert(await page.getByTitle('Redo (Shift+Ctrl+Z)',{exact:true}).isEnabled());
  check(`${name}: saved original media/source values and pending Redo survive`);
 }
 for(const fade of [false,true]){
  const doc=structuredClone(template);doc.version=fade?5:1;doc.project.compositionDurationSec=1.2;
  const clip=doc.project.clips[0];clip.durationSec=1.2;clip.parts=['negative','boundary-negative'].map(name=>({assetId:doc.project.assets.find(a=>a.displayName===name).id,sourceInSec:.1,sourceOutSec:.7}));
  if(fade)clip.audioFade={inSec:.05,outSec:.05,anchorDurationSec:1.2,offsetSec:0};
  await load(doc,`multipart-${fade}`);const releases=[];let calls=0;
  await page.route('**/api/media/audio-preview',async route=>{calls++;await new Promise(r=>releases.push(r));await route.continue();});
  await play().click();await page.waitForTimeout(100);assert.equal(calls,1);assert.equal(Number(await page.getByRole('textbox',{name:'再生位置',exact:true}).inputValue()),0);releases[0]();
  await page.waitForTimeout(100);while(calls<2)await page.waitForTimeout(25);assert.equal(Number(await page.getByRole('textbox',{name:'再生位置',exact:true}).inputValue()),0);releases[1]();
  await page.waitForFunction(fade=>{const m=fade?window.__negativeAudio.routed.at(-1):document.querySelector('.compositor-audio-hidden');return m?.src.startsWith('blob:')&&!m.paused&&m.currentTime>.15;},fade);
  const first=await page.evaluate(fade=>(fade?window.__negativeAudio.routed.at(-1):document.querySelector('.compositor-audio-hidden')).src,fade);
  await page.waitForFunction(({fade,first})=>{const m=fade?window.__negativeAudio.routed.at(-1):document.querySelector('.compositor-audio-hidden');return m?.src.startsWith('blob:')&&m.src!==first&&!m.paused&&m.currentTime>.15;},{fade,first});
  assert.equal(calls,2);check(`multipart ${fade?'fade':'native'}: both sources prepare before the clock and boundary uses the second stable URL`);
  await play().click();await page.unroute('**/api/media/audio-preview');assert.deepEqual((await save()).project,doc.project);
 }
 await load(template,'cancel-pending');let releaseCancel;const cancelled=new Promise(r=>{releaseCancel=r;});let waiting=false;
 await page.route('**/api/media/audio-preview',async route=>{waiting=true;await cancelled;try{await route.continue();}catch(error){if(!route.request().failure())throw error;}});
 await play().click();while(!waiting)await page.waitForTimeout(25);
 const seek=page.getByRole('textbox',{name:'再生位置',exact:true});await seek.fill('0.1');await seek.press('Enter');assert.equal(await seek.getAttribute('aria-invalid'),'false');await seek.blur();releaseCancel();await page.waitForTimeout(200);
 assert.equal(Number(await seek.inputValue()),.1);assert.equal((await play().textContent()).trim(),'▶');await page.unroute('**/api/media/audio-preview');check('exact seek cancels pending preparation and late completion cannot restart playback');
 // A separate observation element measures served bytes; the app's native
 // element is never routed through this test's AudioContext.
 const probe=await browser.newPage();await probe.goto(baseURL);await probe.locator('body').click({position:{x:5,y:5}});
 const results=[];
 for(const name of ['negative','healthy','opus-negative','mp4-control']){
  const asset=template.project.assets.find(a=>a.displayName===name);
  assert(asset,`asset ${name}`);
  const original=await page.request.get(`${baseURL}/api/assets/${asset.media.id}/stream`);assert(original.ok());assert((await original.body()).equals(fs.readFileSync(`${evidence}/${name==='mp4-control'?'mp4-control.mp4':name+'.mkv'}`)));
  const resolved=await page.request.post(`${baseURL}/api/media/audio-preview`,{data:{asset:{...asset,id:asset.id,kind:'video',streamUrl:`/api/assets/${asset.media.id}/stream`,storageAssetId:asset.media.id}}});
  let url=`/api/assets/${asset.media.id}/stream`;
  if(name==='negative'){
   assert.equal(resolved.status(),200);const bytes=await resolved.body();fs.writeFileSync(`${evidence}/derived.m4a`,bytes);url=await probe.evaluate(async bytes=>window.URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'audio/mp4'})),[...bytes]);
  }else assert.equal(resolved.status(),204);
  for(const start of name==='negative'?[0,.05,.1,.2,.25,.5]:[.1,.25]){
   const result=await pulse(probe,url,start),expected=name==='opus-negative'?.5:.52;results.push({name,start,...result,expected});fs.writeFileSync(`${evidence}/pulse-results.json`,JSON.stringify(results,null,2));assert(Math.abs(result.sought-start)<.002);assert(result.peak>=0&&Math.abs(result.pulseMediaTime-expected)<.06,JSON.stringify(results.at(-1)));
  }
  if(name==='negative'){
   const end=await probe.evaluate(async url=>{const m=document.createElement('video');m.src=url;await new Promise(r=>{m.onloadeddata=r;});m.currentTime=2;await new Promise(r=>{m.onseeked=r;});await m.play();await new Promise(r=>setTimeout(r,150));const result={ended:m.ended,time:m.currentTime,duration:m.duration};m.pause();m.removeAttribute('src');m.load();return result;},url);
   assert(end.ended&&end.time>=2&&Math.abs(end.duration-97280/48000)<.000002);check('legal source EOF seek stops without replaying the beginning');
  }
  check(`${name}: fixed pulse seek oracle and original byte control`);
 }
 fs.writeFileSync(`${evidence}/pulse-results.json`,JSON.stringify(results,null,2));await probe.close();
 await load(template,'replace-project');assert(await page.evaluate(()=>window.__negativeAudio.revoked.length>=2));check('project replacement revokes derived audio URLs');
 assert.deepEqual(errors,[]);check('no uncaught browser errors');await captureEvidenceScreenshot(page,`${evidence}/negative-mkv.png`);
})().catch(error=>{console.error(error);fs.writeFileSync(`${evidence}/failure.txt`,String(error.stack??error));process.exitCode=1;}).finally(()=>suite.cleanup());
