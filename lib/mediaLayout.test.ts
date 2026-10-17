import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertStillImageLayout, inspectMediaLayout } from "./mediaLayout";
const probe = vi.hoisted(()=>vi.fn());
vi.mock("@/lib/ffmpeg",()=>({probeMedia:probe}));
let dir:string;
beforeAll(async()=>{dir=await mkdtemp(path.join(tmpdir(),"layout-metadata-"));});
afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
const video = (extra:Record<string,unknown>={})=>({streams:[{codec_type:"video",width:320,height:240,start_time:"0.0",...extra}],format:{duration:"1",format_name:"mov,mp4,m4a,3gp,3g2,mj2"}});
it.each(["0:1","2:1","N/A","bad"])("rejects explicit unsupported SAR %s",async sar=>{
 probe.mockResolvedValue(video({sample_aspect_ratio:sar}));await expect(inspectMediaLayout("/x","video","mp4")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_SAR"});
});
it("accepts exact quarter turn matrix and rejects reflection/shear/ambiguous angle",async()=>{
 const d={side_data_type:"Display Matrix",rotation:-90,displaymatrix:"00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824"};
 probe.mockResolvedValue(video({sample_aspect_ratio:"1:1",side_data_list:[d]}));
 expect(await inspectMediaLayout("/x","video","mp4")).toMatchObject({width:240,height:320,origin:0});
 for(const bad of [{...d,rotation:45},{...d,displaymatrix:d.displaymatrix.replace("65536 0 0","-65536 0 0")},{...d,displaymatrix:undefined},{...d,rotation:0,displaymatrix:"00000000: 65536 65536 0\n00000001: 0 65536 0\n00000002: 0 0 1073741824"}]){
  probe.mockResolvedValue(video({side_data_list:[bad]}));await expect(inspectMediaLayout("/x","video","mp4")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_ROTATION"});
 }
 probe.mockResolvedValue(video({start_time:undefined}));await expect(inspectMediaLayout("/x","video","mp4")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_TIMING"});
});
it("reads bounded TIFF Orientation in JPEG APP1, rejects non1 and corrupt metadata",async()=>{
 const file=path.join(dir,"orientation.jpg");
 const tiff=(orientation:number)=>{const b=Buffer.alloc(26);b.write("II");b.writeUInt16LE(42,2);b.writeUInt32LE(8,4);b.writeUInt16LE(1,8);b.writeUInt16LE(0x112,10);b.writeUInt16LE(3,12);b.writeUInt32LE(1,14);b.writeUInt16LE(orientation,18);return b;};
 for(const n of [1,2,6,8]){
  const exif=Buffer.concat([Buffer.from("Exif\0\0"),tiff(n)]), head=Buffer.from([255,216,255,225,0,exif.length+2]);
  await writeFile(file,Buffer.concat([head,exif,Buffer.from([255,218])]));
  if(n===1) await expect(assertStillImageLayout(file,"jpg")).resolves.toBeUndefined();
  else await expect(assertStillImageLayout(file,"jpg")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_ORIENTATION"});
 }
 await writeFile(file,Buffer.from([255,216,255,225,255,255]));await expect(assertStillImageLayout(file,"jpg")).rejects.toThrow();
});
it("detects PNG animation and WebP ANIM without decoding compressed content",async()=>{
 const png=path.join(dir,"anim.png"),webp=path.join(dir,"anim.webp");
 const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8);chunk.write("acTL",4);chunk.writeUInt32BE(2,8);
 await writeFile(png,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk]));
 await expect(assertStillImageLayout(png,"png")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_ANIMATION"});
 const riff=Buffer.alloc(20);riff.write("RIFF");riff.writeUInt32LE(12,4);riff.write("WEBPANIM",8);
 await writeFile(webp,riff);await expect(assertStillImageLayout(webp,"webp")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_ANIMATION"});
});

it("checks physical format before trusting client kind/ext, including disguised animation",async()=>{
 probe.mockResolvedValue({...video(),format:{format_name:"gif",duration:"1"}});
 await expect(inspectMediaLayout("/ignored","video","mp4")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_MEDIA_KIND"});
 probe.mockResolvedValue(video());
 await expect(inspectMediaLayout("/ignored","image","png")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_MEDIA_KIND"});
});

it("rejects WebP animation feature flags even if ANIM payload is absent",async()=>{
 const file=path.join(dir,"flag.webp"),b=Buffer.alloc(30);b.write("RIFF");b.writeUInt32LE(22,4);b.write("WEBPVP8X",8);b.writeUInt32LE(10,16);b[20]=2;await writeFile(file,b);
 await expect(assertStillImageLayout(file,"webp")).rejects.toMatchObject({code:"UNSUPPORTED_LAYOUT_ANIMATION"});
});

it("public layout JSON keys exclude private audio repair metadata even for eligible media",async()=>{
 const raw=video({start_time:"2",start_pts:30720,time_base:"1/15360"});
 Object.assign(raw.format,{start_time:"0"});
 raw.streams.push({codec_type:"audio",start_time:"0",start_pts:0,time_base:"1/44100",duration_ts:61740,duration:"1.4"} as unknown as typeof raw.streams[0]);
 probe.mockResolvedValue(raw);
 expect(Object.keys(await inspectMediaLayout("/current-resolved-input","video","mp4")).sort()).toEqual(["durationSec","hasAudio","height","origin","width"]);
});
