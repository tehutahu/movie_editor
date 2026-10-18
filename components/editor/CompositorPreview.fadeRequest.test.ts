import {expect,it} from 'vitest';
import {fadeRequestAt} from './CompositorPreview';
import {createEmptyProject,clipFromAsset} from '@/lib/editor/project';
it('a small clip move changes the preview phase identity even below source drift thresholds',()=>{
 const project=createEmptyProject();const asset={id:'asset',kind:'video' as const,displayName:'tone',streamUrl:'/tone',sourceDurationSec:4,ext:'mp4'};project.assets=[asset];
 const clip=clipFromAsset({asset,trackId:project.tracks[0].id,timelineStartSec:0});clip.audioFade={inSec:1,outSec:1,anchorDurationSec:4,offsetSec:0};project.clips=[clip];
 const pair={position:1,performanceMs:1000},before=fadeRequestAt(project,pair)!;
 const moved=fadeRequestAt({...project,clips:[{...clip,timelineStartSec:.1}]},pair)!;
 expect(before.u).toBe(1);expect(moved.u).toBe(.9);expect(moved.key).not.toBe(before.key);
 // Duration alone does not reanchor the preserved fade anchor or source phase.
 expect(fadeRequestAt({...project,clips:[{...clip,durationSec:3}]},pair)!.key).toBe(before.key);
});
