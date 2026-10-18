import type { TitleClip } from "./types";
export async function requestTitleRaster(descriptor:Pick<TitleClip,"text"|"fontId"|"fontRevision"|"styleRevision">,width:number,height:number,signal:AbortSignal):Promise<Response>{
 for(let attempt=0;;attempt++){
  const response=await fetch("/api/titles/raster",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...descriptor,width,height}),signal});
  if(response.status!==429||attempt>=2)return response;
  await response.body?.cancel();
  await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException("取り消しました。","AbortError"));};const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},1000);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
 }
}
