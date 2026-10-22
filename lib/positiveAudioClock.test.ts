import { expect, it } from "vitest";
import type { FfProbeJson } from "./ffmpeg";
import { positiveAudioClockFromProbe, verifiedPositiveAudioPacketDuration, verifiedDecodedAudioPrefix } from "./positiveAudioClock";

const raw = (): FfProbeJson => ({ format: { format_name:"mov,mp4,m4a,3gp,3g2,mj2", start_time:"0.000000" }, streams:[
  {codec_type:"video",codec_name:"h264",start_time:"0.000000",start_pts:0,time_base:"1/15360",duration:"2.000000",duration_ts:30720,avg_frame_rate:"30/1",r_frame_rate:"30/1"},
  {codec_type:"audio",codec_name:"aac",profile:"LC",channels:1,sample_rate:"48000",start_time:"1.978000",start_pts:94944,time_base:"1/48000",duration:"2.021333",duration_ts:97024},
] });
it("recognizes only the separate zero-video/positive-AAC clock", () => {
  expect(positiveAudioClockFromProbe(raw())?.audioStartPts).toBe("94944");
  const oldProbe=raw();Object.assign(oldProbe.streams![1],{duration:"4.000000",duration_ts:192000});
  // This metadata alone is never sufficient: later packet/decode gates prove EOF.
  expect(positiveAudioClockFromProbe(oldProbe)?.audioStartPts).toBe("94944");
});
it.each([
  {codec_name:"mp3"},{profile:"HE-AAC"},{profile:undefined},{channels:3},{channels:undefined},
  {sample_rate:"44100"},{time_base:"1/44100"},{start_time:"-0.021000"},{start_time:"0.000000",start_pts:0},
  {start_time:"1.970000"},{start_pts:Number.MAX_SAFE_INTEGER+1},{start_pts:"N/A"},
  {duration:"0"},{duration_ts:0},{side_data_list:[{side_data_type:"unknown"}]},{side_data_list:{}},{side_data_list:null},
])("rejects unverified audio metadata %j", patch => {
  const p=raw();Object.assign(p.streams![1],patch);expect(positiveAudioClockFromProbe(p)).toBeNull();
});
it("keeps other origins, variable rate, containers and stream combinations excluded", () => {
  for(const alter of [(p:FfProbeJson)=>{p.format!.start_time="0.100000";},
    (p:FfProbeJson)=>{p.format!.format_name="matroska,webm";},
    (p:FfProbeJson)=>{p.streams![0].start_time="2.000000";p.streams![0].start_pts=30720;},
    (p:FfProbeJson)=>{p.streams![0].avg_frame_rate="53/2";},
    (p:FfProbeJson)=>{p.streams!.push({...p.streams![1]});}]){
    const p=raw();alter(p);expect(positiveAudioClockFromProbe(p)).toBeNull();
  }
});

const packets = () => ({packets:[{pts:94944,duration:1024},{pts:95968,duration:1024},{pts:96992,duration:768}]});
it("measures AAC EOF relative to its own first packet, not metadata duration", () => {
  expect(verifiedPositiveAudioPacketDuration(packets(),"94944")).toEqual({n:BigInt(2816),d:BigInt(48000)});
});
it.each([
  {},{packets:[]},{packets:[{pts:94944,duration:0}]},{packets:[{pts:94944,duration:2048}]},
  {packets:[{pts:94945,duration:1024}]},{packets:[{pts:"N/A",duration:1024}]},
  {packets:[{pts:94944,duration:512},{pts:95456,duration:1024}]},
  {packets:[{pts:94944,duration:1024},{pts:95969,duration:1024}]},
  {packets:[{pts:94944,duration:1024},{pts:94944,duration:1024}]},
  {packets:[{pts:94944,duration:1024,side_data_list:[{side_data_type:"Skip Samples",skip_samples:1024}]}]},
  {packets:[{pts:94944,duration:1024,side_data_list:{}}]},
])("rejects unknown/edited/incomplete packet grids %j", p => {
  expect(verifiedPositiveAudioPacketDuration(p,"94944")).toBeNull();
});

const prefix = "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.Number_of_samples=1024.000000\nframe:1    pts:1024    pts_time:0.0213333\nlavfi.astats.Overall.Number_of_samples=1600.000000\n";
it("requires actual decoded sample coverage before candidate padding", () => {
  expect(verifiedDecodedAudioPrefix(prefix,1600)).toBe(true);
  expect(verifiedDecodedAudioPrefix(prefix,1601)).toBe(false);
  expect(verifiedDecodedAudioPrefix(prefix,1599)).toBe(false);
});
it.each(["",prefix.replace("1600.000000","1600.500000"),prefix.replace("1600.000000","1000.000000"),
  prefix.replace("frame:1","frame:2"),prefix+"unknown\n",prefix.replace("1024.000000","NaN"),prefix.replace("1024.000000","0.000000")])("rejects malformed/nonmonotonic decoded prefix %j", text => {
  expect(verifiedDecodedAudioPrefix(text,1600)).toBe(false);
});
