import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { titleRasterService, TitleBusyError } from "@/lib/titleRenderer";
import { validateTitleDescriptor } from "@/lib/editor/title";
export const runtime="nodejs";
async function boundedJson(req:Request){
  const reader=req.body?.getReader();if(!reader)throw new Error("タイトル本文が必要です。");const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384){await reader.cancel();throw new Error("タイトル要求が大きすぎます。");}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;}finally{reader.releaseLock();}
}
export async function POST(req:Request){
 try{
  const body=await boundedJson(req);if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["text","fontId","fontRevision","styleRevision","width","height"].includes(k)))throw new Error("タイトルraster要求が不正です。");
  const descriptor=validateTitleDescriptor(body);
  const lease=await titleRasterService().acquire({kind:"title",id:"raster",trackId:"raster",timelineStartSec:0,durationSec:1,transform:{x:.5,y:.5,scale:1},...descriptor},body.width as number,body.height as number,req.signal);
  try{
   const size=(await stat(lease.file)).size;
   const file=createReadStream(lease.file);let finished=false;
   const finish=()=>{if(finished)return;finished=true;req.signal.removeEventListener("abort",abort);lease.release();};
   const abort=()=>file.destroy(new Error("タイトル読み込みを取り消しました。"));
   const stream=new ReadableStream<Uint8Array>({start(controller){file.on("data",chunk=>{controller.enqueue(new Uint8Array(chunk as Buffer));if((controller.desiredSize??0)<=0)file.pause();});file.on("end",()=>{finish();controller.close();});file.on("error",error=>{finish();controller.error(error);});file.on("close",finish);req.signal.addEventListener("abort",abort,{once:true});if(req.signal.aborted)abort();},pull(){file.resume();},cancel(){file.destroy();finish();}});
   return new Response(stream,{headers:{"Content-Type":"image/png","Content-Length":String(size),"Cache-Control":"private, no-store","X-Title-Key":lease.key,"X-Title-SHA256":lease.hash}});
  }catch(e){lease.release();throw e;}
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:e instanceof TitleBusyError?429:400,headers:e instanceof TitleBusyError?{"Retry-After":"1"}:{}});}
}
