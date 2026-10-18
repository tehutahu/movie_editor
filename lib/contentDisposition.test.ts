import { it, expect } from "vitest";
import { contentDispositionAttachment } from "./contentDisposition";
it.each(["video_export.mp4","日本語タイトル_export.mp4","été–映画.mp4","O'Reilly (100%)*.mp4","quote\" back\\slash ;.mp4","line\r\nnext\u0000\u007f.mp4"])("constructs a legal ASCII header and preserves UTF-8 extended name %j",name=>{
 const header=contentDispositionAttachment(name);expect([...header].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)<=126)).toBe(true);
 expect(()=>new Headers({"Content-Disposition":header})).not.toThrow();
 const extended=header.split("filename*=UTF-8''")[1];expect(decodeURIComponent(extended)).toBe(name);
 expect(extended).not.toMatch(/['()*]/);expect(header.split('; filename*=')[0]).not.toContain('back\\slash');
});
it("keeps the existing simple ASCII disposition exactly",()=>expect(contentDispositionAttachment("movie_export.mp4")).toBe('attachment; filename="movie_export.mp4"; filename*=UTF-8\'\'movie_export.mp4'));
