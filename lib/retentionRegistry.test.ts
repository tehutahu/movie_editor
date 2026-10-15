import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const roots = vi.hoisted(() => { vi.resetModules(); return { UPLOADS_ROOT: "", JOBS_ROOT: "" }; });
vi.mock("@/lib/paths", () => roots);
import { reserveStorage, finishStorageJob, releaseStorageSession, protectStorageSession, pruneAllStorage, cancelStorageReservations, StorageRetentionError } from "./storageRetention";
let root: string;
const id = () => randomUUID();
async function file(resource: string, kind = "uploads") { const dir = path.join(root, kind, resource); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "test"), "synthetic"); }
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "retention-v2-")); roots.UPLOADS_ROOT = path.join(root, "uploads"); roots.JOBS_ROOT = path.join(root, "jobs"); vi.stubEnv("MAX_UPLOAD_COUNT", "2"); vi.stubEnv("MAX_JOB_COUNT", "2"); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it("reserves a whole batch atomically and rejects excess without deleting active media", async () => {
 const session = id(), ids = [id(), id()];
 await reserveStorage(ids.map(id => ({ id, kind: "uploads" as const })), session);
 await Promise.all(ids.map(x => file(x)));
 await expect(reserveStorage([{ id: id(), kind: "uploads" }], id())).rejects.toBeInstanceOf(StorageRetentionError);
 for (const x of ids) expect(await readFile(path.join(root, "uploads", x, "test"), "utf8")).toBe("synthetic");
});
it("unreferenced files are reclaimed after explicit end; another tab protects shared history and library assets", async () => {
 const a=id(), b=id(), source=id();
 await reserveStorage([{ id: source, kind: "uploads" }], a); await file(source);
 await protectStorageSession(b, [source]);
 await releaseStorageSession(a); await pruneAllStorage([]); await access(path.join(root,"uploads",source,"test"));
 await releaseStorageSession(b); await expect(access(path.join(root,"uploads",source))).rejects.toThrow();
 await expect(protectStorageSession(a,[source])).rejects.toThrow(/終了/);
});
it("active jobs pin upload and restored-job dependencies after editors end", async () => {
 const session=id(), upload=id(), restored=id(), running=id();
 await reserveStorage([{ id:upload,kind:"uploads" }, { id:restored,kind:"jobs",active:true }],session);
 await file(upload); await file(restored,"jobs"); await finishStorageJob(restored);
 await reserveStorage([{ id:running,kind:"jobs",active:true,dependencies:[upload,restored] }],session); await file(running,"jobs");
 await releaseStorageSession(session);
 await access(path.join(root,"uploads",upload)); await access(path.join(root,"jobs",restored));
 await finishStorageJob(running); await pruneAllStorage([]);
 await expect(access(path.join(root,"uploads",upload))).rejects.toThrow(); await expect(access(path.join(root,"jobs",restored))).rejects.toThrow();
});
it("unknown pre-existing files and interrupted sessions survive restart and block admission", async () => {
 const unknown=id(), held=id(), session=id(); await file(unknown);
 await reserveStorage([{ id:held,kind:"uploads" }],session); await file(held);
 vi.resetModules(); const restarted=await import('./storageRetention');
 await restarted.pruneAllStorage([]); await access(path.join(root,"uploads",unknown)); await access(path.join(root,"uploads",held));
 await expect(restarted.reserveStorage([{id:id(),kind:"uploads"}],id())).rejects.toThrow(/上限/);
});
it("corrupt protection information fails closed without deleting files", async () => {
 const session=id(), resource=id(); await reserveStorage([{id:resource,kind:"uploads"}],session); await file(resource);
 await writeFile(path.join(root,"retention.json"), "{broken");
 await expect(pruneAllStorage([])).rejects.toThrow(/保護情報/);
 await expect(reserveStorage([{id:id(),kind:"uploads"}],id())).rejects.toThrow(/保護情報/);
 await access(path.join(root,"uploads",resource));
});
it("serializes concurrent admissions and retains reservations before files exist", async () => {
 const results=await Promise.allSettled(Array.from({length:3},()=>reserveStorage([{id:id(),kind:"uploads"}],id())));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
});

it("an abandoned filesystem lock blocks cleanup and admission without expiry", async () => {
 const resource=id();await file(resource);
 await mkdir(path.join(root,"retention.json.lock"));
 await expect(pruneAllStorage([])).rejects.toThrow(/ロック/);
 await expect(reserveStorage([{id:id(),kind:"uploads"}],id())).rejects.toThrow(/ロック/);
 await access(path.join(root,"uploads",resource));
});

it("remote originals remain conservatively accounted for after release instead of bypassing the limit", async () => {
 vi.stubEnv("STORAGE_DRIVER","blob");vi.stubEnv("MAX_UPLOAD_COUNT","1");
 const session=id();await reserveStorage([{id:id(),kind:"uploads"}],session);
 await releaseStorageSession(session);
 await expect(reserveStorage([{id:id(),kind:"uploads"}],id())).rejects.toThrow(/上限/);
});

it("a failed remote upload keeps its reservation because the original may already exist", async () => {
 vi.stubEnv("STORAGE_DRIVER","blob");vi.stubEnv("MAX_UPLOAD_COUNT","1");
 const session=id(), resource=id();
 await reserveStorage([{id:resource,kind:"uploads",active:true}],session);
 await cancelStorageReservations([resource]);
 await releaseStorageSession(session);
 await expect(reserveStorage([{id:id(),kind:"uploads"}],id())).rejects.toThrow(/上限/);
});
