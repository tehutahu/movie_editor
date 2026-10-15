import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { UPLOADS_ROOT, JOBS_ROOT } from "./paths";
import { reserveStorage, releaseStorageSession } from "./storageRetention";
import { createRetainedJobRecord, getJobRecord, runDetached } from "./jobs";
it("running and failing jobs protect inputs after tab release and flush metadata before collection", async () => {
 for (const fail of [false,true]) {
  const session=randomUUID(), source=randomUUID();
  await reserveStorage([{id:source,kind:"uploads"}],session);
  const input=path.join(UPLOADS_ROOT,source);await mkdir(input,{recursive:true});await writeFile(path.join(input,"synthetic"),"x");
  const job=await createRetainedJobRecord("export_segment",{sessionId:session,dependencies:[source]});
  let complete!:()=>void; const gate=new Promise<void>(resolve=>complete=resolve);
  runDetached(job.id,async()=>{ await gate;if(fail)throw new Error("synthetic failure"); });
  expect(getJobRecord(job.id)?.status).toBe("running");
  await releaseStorageSession(session);await access(input);
  complete();
  await vi.waitFor(async()=>{
   expect(getJobRecord(job.id)?.status).toBe(fail?"error":"done");
   await expect(access(input)).rejects.toThrow();
   await expect(access(path.join(JOBS_ROOT,job.id))).rejects.toThrow();
  });
 }
});
