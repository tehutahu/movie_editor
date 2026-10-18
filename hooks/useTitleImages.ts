"use client";
import { useEffect, useRef, useState } from "react";
import { getClipAtPlayhead } from "@/lib/editor/clipOps";
import { isTitleClip, type EditorProject, type TitleClip } from "@/lib/editor/types";
const BUDGET=64*1024*1024;
export const titleImageKey=(clip:TitleClip,width:number,height:number)=>JSON.stringify([clip.text,clip.fontId,clip.fontRevision,clip.styleRevision,width,height]);
/** Only active titles are fetched. PNG remains composition-sized; decode alone is resized. */
export function useTitleImages(project:EditorProject,epoch:number,redraw:()=>void){
 const images=useRef(new Map<string,ImageBitmap>()),[status,setStatus]=useState("");
 const titles=project.clips.filter(isTitleClip).filter(c=>getClipAtPlayhead(c,project.playheadSec));
 const unique=[...new Map(titles.map(c=>[titleImageKey(c,project.compositionWidth,project.compositionHeight),c])).entries()];
 const key=JSON.stringify({epoch,width:project.compositionWidth,height:project.compositionHeight,descriptors:unique.map(([key,c])=>[key,{text:c.text,fontId:c.fontId,fontRevision:c.fontRevision,styleRevision:c.styleRevision}])});
 const redrawRef=useRef(redraw);redrawRef.current=redraw;
 useEffect(()=>{
  const data=JSON.parse(key) as {epoch:number;width:number;height:number;descriptors:[string,Pick<TitleClip,"text"|"fontId"|"fontRevision"|"styleRevision">][]};
  let active=true;const controller=new AbortController();
  for(const bitmap of images.current.values())bitmap.close();images.current.clear();redrawRef.current();
  if(!data.descriptors.length){setStatus("");return()=>controller.abort();}
  setStatus("タイトルを生成中…");
  void(async()=>{
   let decodedBytes=0;
   const pixels=Math.min(1024*1024,Math.floor(BUDGET/(4*data.descriptors.length)));
   const factor=Math.min(1,Math.sqrt(pixels/(data.width*data.height))),width=Math.max(1,Math.floor(data.width*factor)),height=Math.max(1,Math.floor(data.height*factor));
   for(const [identity,descriptor]of data.descriptors){
    if(!active)return;
    let response:Response|undefined;
    for(let attempt=0;attempt<3;attempt++){
     response=await fetch("/api/titles/raster",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...descriptor,width:data.width,height:data.height}),signal:controller.signal});
     if(response.status!==429||attempt===2)break;
     await response.body?.cancel();
     await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error("取り消しました。"));};const timer=setTimeout(()=>{controller.signal.removeEventListener("abort",abort);resolve();},1000);controller.signal.addEventListener("abort",abort,{once:true});if(controller.signal.aborted)abort();});
    }
    if(!response?.ok){const body=await response?.json();throw new Error(body?.error??"タイトル生成に失敗しました。");}
    if(Number(response.headers.get("content-length"))>32*1024*1024)throw new Error("タイトルPNGが大きすぎます。");
    const blob=await response.blob();if(blob.size>32*1024*1024)throw new Error("タイトルPNGが大きすぎます。");
    if(!active)return;
    const bitmap=await createImageBitmap(blob,{resizeWidth:width,resizeHeight:height,resizeQuality:"high"});
    if(!active){bitmap.close();return;}
    const size=bitmap.width*bitmap.height*4;
    if(decodedBytes+size>BUDGET){bitmap.close();throw new Error("タイトルの表示memory上限です。再試行してください。");}
    decodedBytes+=size;images.current.set(identity,bitmap);redrawRef.current();
   }
   if(active)setStatus("");
  })().catch(e=>{if(active&&!controller.signal.aborted)setStatus(e instanceof Error?e.message:String(e));});
  const owned=images.current;
  return()=>{active=false;controller.abort();for(const bitmap of owned.values())bitmap.close();owned.clear();};
 },[key]);
 return{images,status};
}
