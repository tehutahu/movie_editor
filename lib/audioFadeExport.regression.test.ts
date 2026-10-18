import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {exportCompositionToFile} from './exportComposition';
import {createEmptyProject} from './editor/project';
import {resolveFfmpegPath,resolveFfprobePath} from './ffmpeg';
import type {Asset,MediaClip} from './editor/types';
const sources=vi.hoisted(()=>new Map<string,string>());
vi.mock('@/lib/assetResolve',()=>({resolveAssetInputPath:async(a:Asset)=>sources.get(a.id)??null}));
const enabled=process.env.RUN_FFMPEG_TESTS==='1';let dir:string,source:string;
const ff=(args:string[])=>execFileSync(resolveFfmpegPath(),['-v','error','-y',...args],{maxBuffer:16*1024*1024});
beforeAll(async()=>{if(!enabled)return;dir=await mkdtemp(path.join(tmpdir(),'fade-export-'));source=path.join(dir,'source.mp4');ff(['-f','lavfi','-i','color=red:s=160x90:r=30:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-c:a','aac',source]);});
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
it.skipIf(!enabled).each(['stretch','contain'] as const)('actual %s export applies partial fade after gain without changing video frames',async(layoutMode)=>{
 const p=createEmptyProject(),id=randomUUID();sources.set(id,source);p.compositionWidth=160;p.compositionHeight=90;p.compositionDurationSec=1.5;
 p.assets=[{id,kind:'video',displayName:'tone',streamUrl:'/tone',ext:'mp4',sourceDurationSec:2}];
 const clip:MediaClip={id:randomUUID(),trackId:p.tracks[0].id,timelineStartSec:0,durationSec:1.5,layoutMode,transform:{x:.5,y:.5,scale:2},parts:[{assetId:id,sourceInSec:0,sourceOutSec:1.5}],audioGain:.5};p.clips=[clip];
 const outputs:string[]=[];
 for(const active of [false,true]){p.clips=[{...clip,...(active?{audioFade:{inSec:.5,outSec:.5,anchorDurationSec:2,offsetSec:.25}}:{})}];const job=path.join(dir,`${layoutMode}-${active}`);await mkdir(job);const out=path.join(job,'out.mp4');await exportCompositionToFile({project:p,jobDir:job,outputPath:out});outputs.push(out);}
 expect(ff(['-i',outputs[0],'-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])).toEqual(ff(['-i',outputs[1],'-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1']));
 const pcm=outputs.map(file=>ff(['-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']));
 const rms=(buffer:Buffer,at:number)=>{let sum=0,n=0;for(let i=Math.round(at*48000);i<Math.round((at+.02)*48000);i++){sum+=buffer.readFloatLE(i*4)**2;n++;}return Math.sqrt(sum/n);};
 for(const [at,expected] of [[.04,.6],[.6,1],[1.4,.7]])expect(rms(pcm[1],at)/rms(pcm[0],at)).toBeCloseTo(expected,1);
 const probe=JSON.parse(execFileSync(resolveFfprobePath(),['-v','error','-show_streams','-of','json',outputs[1]],{encoding:'utf8'}));expect(probe.streams.find((s:{codec_type:string})=>s.codec_type==='audio').sample_rate).toBe('48000');
},60000);
