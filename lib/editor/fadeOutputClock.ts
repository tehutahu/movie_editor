/** Public timeline position and its paired performance.now() coordinate. */
export type FadeTimelineAnchor={u:number;performanceMs:number};
export type FadeOutputTimestamp={contextTime:number;performanceTime:number};
/** W3C outputPerformanceTime mapping; no measured shift or media clock. */
export function outputTimelinePosition(anchor:FadeTimelineAnchor,stamp:FadeOutputTimestamp,renderTime:number):number{
  if(![anchor.u,anchor.performanceMs,stamp.contextTime,stamp.performanceTime,renderTime].every(Number.isFinite)||anchor.u<0||anchor.performanceMs<0||stamp.contextTime<0||stamp.performanceTime<=0||renderTime<stamp.contextTime)throw Error('音声フェードの出力時刻を取得できません。');
  const presentationMs=stamp.performanceTime+1000*(renderTime-stamp.contextTime);
  const u=anchor.u+(presentationMs-anchor.performanceMs)/1000;
  if(!Number.isFinite(u))throw Error("音声フェードの公開時刻が不正です。");
  return Math.max(0,u);
}
export function outputContextTime(anchor:FadeTimelineAnchor,stamp:FadeOutputTimestamp,u:number):number{
  return stamp.contextTime+(anchor.performanceMs+1000*(u-anchor.u)-stamp.performanceTime)/1000;
}
