import { fontCoverageRanges } from "./titleFontCmap";
/** Layout bounds use the pinned face's advances plus global ink extents, never host metrics. */
export function titleFontMetrics(bytes:Uint8Array){
 fontCoverageRanges(bytes);
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=(o:number)=>v.getUint16(o),u32=(o:number)=>v.getUint32(o),i16=(o:number)=>v.getInt16(o);
 const face=u32(12),tables=new Map<string,{o:number;n:number}>();
 for(let i=0;i<u16(face+4);i++){const p=face+12+i*16;tables.set(String.fromCharCode(...bytes.subarray(p,p+4)),{o:u32(p+8),n:u32(p+12)});}
 const table=(name:string,min:number)=>{const t=tables.get(name);if(!t||t.n<min)throw new Error("タイトルfont metricsが不正です。");return t;};
 const head=table("head",54).o,hhea=table("hhea",36).o,hmtx=table("hmtx",4),num= u16(hhea+34),glyphs=u16(table("maxp",6).o+4),units=u16(head+18);
 if(!units||!num||num>glyphs||hmtx.n<num*4+(glyphs-num)*2)throw new Error("タイトルfont advance表が不正です。");
 const cmap=table("cmap",4);let sub=-1;
 for(let i=0;i<u16(cmap.o+2);i++){const r=cmap.o+4+i*8,p=u16(r),e=u16(r+2),o=cmap.o+u32(r+4);if((p===0||(p===3&&e===10))&&u16(o)===12){sub=o;break;}}
 if(sub<0)throw new Error("固定タイトルfontのcmap12がありません。");
 function advance(cp:number){let l=0,h=u32(sub+12)-1;while(l<=h){const m=(l+h)>>1,o=sub+16+m*12,a=u32(o),b=u32(o+4);if(cp<a)h=m-1;else if(cp>b)l=m+1;else {const gid=u32(o+8)+cp-a;return u16(hmtx.o+Math.min(gid,num-1)*4)/units;}}throw new Error(`タイトルfontにU+${cp.toString(16)}がありません。`);}
 const horizontalInk=(Math.max(0,-i16(head+36))+Math.max(0,i16(head+40)))/units;
 const verticalInk=(i16(head+42)-i16(head+38))/units,lineHeight=Math.max((i16(hhea+4)-i16(hhea+6)+i16(hhea+8))/units,1);
 if(!Number.isFinite(horizontalInk+verticalInk+lineHeight)||horizontalInk<=0||verticalInk<=0||lineHeight<=0)throw new Error("タイトルfont bboxが不正です。");
 return(text:string,width:number,height:number)=>{
  const lines=text.split("\n"),margin=Math.max(2,Math.min(width,height)*.02),outlineEm=1/24;
  const lineWidths=lines.map(line=>[...line].reduce((s,c)=>s+advance(c.codePointAt(0)!),0));
  const widthEm=Math.max(...lineWidths)+horizontalInk+outlineEm*2,heightEm=verticalInk+(lines.length-1)*lineHeight+outlineEm*2;
  const size=Math.floor(Math.min(height*.08,(width-2*margin)/widthEm,(height-2*margin)/heightEm)*4)/4;
  if(size<12)throw new Error("タイトルの文字が構図に収まりません。本文を短くするか手動改行を調整してください。");
  return{fontSize:size,margin};
 };
}
