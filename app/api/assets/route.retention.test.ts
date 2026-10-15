import { afterEach, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UPLOADS_ROOT } from "@/lib/paths";
vi.mock("@/lib/ffmpeg", () => ({ assertFfmpegAvailable: async () => undefined, probeVideo: vi.fn(async () => ({ durationSec: 1,width:320,height:320 })), probeImage: vi.fn(async () => ({ width:320,height:320,hasVideo:true })) }));
import { POST } from "./route";
import { releaseStorageSession, pruneAllStorage } from "@/lib/storageRetention";
const sessions: string[]=[];
afterEach(async () => { vi.unstubAllEnvs(); for (const session of sessions.splice(0)) await releaseStorageSession(session); });
function request(session: string, count: number) {
 const form=new FormData(); form.set("editorSessionId",session);
 for(let i=0;i<count;i++) form.append("files",new File([new Uint8Array([1,2,3])],`synthetic${i}.png`,{type:"image/png"}));
 return new Request("http://test/api/assets",{method:"POST",body:form});
}
it("507 rejects an oversized whole batch before saving; capacity remains available",async () => {
 vi.stubEnv("MAX_UPLOAD_COUNT","2"); const session=randomUUID();sessions.push(session);
 const rejected=await POST(request(session,3)); expect(rejected.status).toBe(507);
 expect(await readdir(UPLOADS_ROOT)).toEqual([]);
 const accepted=await POST(request(session,2));expect(accepted.status).toBe(200);
 const json=await accepted.json();expect(json.assets).toHaveLength(2);expect(json.warning).toMatch(/上限/);
 await pruneAllStorage([]);
 for(const a of json.assets) expect(await readFile(path.join(UPLOADS_ROOT,a.assetId,"input.png"))).toEqual(Buffer.from([1,2,3]));
});
it("concurrent uploads in two tabs cannot overbook slots or delete the winning batch",async () => {
 vi.stubEnv("MAX_UPLOAD_COUNT","2");const a=randomUUID(),b=randomUUID();sessions.push(a,b);
 const responses=await Promise.all([POST(request(a,2)),POST(request(b,2))]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,507]);
 const accepted=await responses.find(r=>r.status===200)!.json();
 for(const row of accepted.assets) await readFile(path.join(UPLOADS_ROOT,row.assetId,"input.png"));
});
