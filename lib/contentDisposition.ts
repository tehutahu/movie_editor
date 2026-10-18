/** RFC 6266 fallback + RFC 8187 extended UTF-8 filename (Headers requires ByteString). */
export function contentDispositionAttachment(name:string):string{
 const fallback=[...name].map(c=>{const n=c.codePointAt(0)!;return n>=0x20&&n<=0x7e&&c!=='"'&&c!=="\\"?c:"_";}).join("")||"download";
 const encoded=encodeURIComponent(name).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
 return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
