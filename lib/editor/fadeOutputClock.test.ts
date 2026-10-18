import {expect,it} from 'vitest';
import {outputTimelinePosition,outputContextTime} from './fadeOutputClock';
it('maps render frames to standard presentation coordinates and inversely maps knots',()=>{
 const anchor={u:.2,performanceMs:1000},stamp={contextTime:4,performanceTime:990};
 expect(outputTimelinePosition(anchor,stamp,4.05)).toBeCloseTo(.24,12);
 expect(outputContextTime(anchor,stamp,.6)).toBeCloseTo(4.41,12);
 for(const u of [.2,.4,1.2,1.6])expect(outputTimelinePosition(anchor,stamp,outputContextTime(anchor,stamp,u))).toBeCloseTo(u,12);
});
it('uses the supplied output coordinates rather than a fixed latency shift',()=>{
 const anchor={u:.2,performanceMs:1000};
 expect(outputTimelinePosition(anchor,{contextTime:4,performanceTime:980},4.05)).toBeCloseTo(.23,12);
 expect(outputTimelinePosition(anchor,{contextTime:4,performanceTime:1020},4.05)).toBeCloseTo(.27,12);
});
it('rejects unavailable timestamps and invalid anchors without media-clock fallback',()=>{
 for(const stamp of [{contextTime:0,performanceTime:0},{contextTime:NaN,performanceTime:1},{contextTime:5,performanceTime:1}])expect(()=>outputTimelinePosition({u:0,performanceMs:1000},stamp,4)).toThrow();
 expect(()=>outputTimelinePosition({u:NaN,performanceMs:1000},{contextTime:3,performanceTime:900},4)).toThrow();
});
